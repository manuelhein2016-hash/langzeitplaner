// ─────────────────────────────────────────────────────────────────────────────
// ROUND 5 — ADVERSARY, ATTACK 1: THE AUTHORITY RULE ITSELF, THIRD ATTEMPT
//
// `board.json` vs. the op log has now survived two fix attempts and been rewritten a third time
// as ADR 006 ("`board.json` is the truth, the log is history"). This file is the third audit.
//
//   attempt 1  `shouldMigrate(board, {opsLogExists})`                        killed by R3-31
//   attempt 2  a provenance envelope + an entity CENSUS, zero-overlap gate   killed by R4-1a/R4-2a
//   attempt 3  ADR 006 — one equality on `lineageId`, adoption is a DIFF     ← under attack here
//
// §1 re-runs the four attacks that killed the first two rules. ALL FOUR NOW FAIL — the rule
//    holds, and it holds structurally rather than by a threshold. Those rows are the control.
//
// §2 attacks the INVERSE, which is the failure mode a "trust nothing" rule actually has: can the
//    new rule refuse a log that is genuinely this board's, and lose real work? Every legitimate
//    path is walked. Content is never lost — R3/R4 do their job — and of the two legitimate paths
//    that threw the whole history away, the wall-clock skew (R5-2e) is now a DEFERRAL that names
//    the clock and renames nothing. R5-2g, the pre-lineage Time-Machine restore, is still open.
//
// §3 aims at the rule's new single point of failure, which the ADR names in §8.2 and then does
//    not defend: `board.json` must be READABLE. R7 (`_recoverFromLog`) is the one asymmetric
//    branch, it performs NO lineage check of any kind, and it is entered by a `board.json` that
//    merely fails to PARSE. A3-C1's original attack — a planted log becomes the board — is
//    therefore reachable again behind one corrupted byte, and `persistNow()` then commits it.
//
// §4 audited the honesty of the WP-8 deferral, which is the question ADR 006 §9 answers with
//    "the outbox lives in `ops.jsonl`". It did not: `_persistOps` never called `appendOps`, and
//    `oplog.checkpoint()` folds only to the horizon it was LOADED with — so once a log had been
//    read back once, NOTHING the user did was ever written to the log again. A3-M5 was filed as
//    "latent today"; it was not latent, it was load-bearing already, and it made ADR 006's happy
//    path indistinguishable from its crash path on every launch, forever. CLOSED — `_persistOps`
//    is now the four steps of §6 and the rows are inverted, R5-4e added for the bound.
//
// §5 was R3's blind spot: `_born` — which ADR 001 §5 step 5 calls "MANDATORY, NOT COSMETIC"
//    because array order is user-visible — is contributed entirely by the adopted log, is not in
//    `COLLECTION[].fields` so the reconciler cannot mint it (it is write-once and never can be),
//    and was not in `v1ContentOf` so the post-condition could not see it either. HALF CLOSED: the
//    post-condition compares order now (R5-5a inverted), and R5-5b — a field `board.json` cannot
//    express at all — is bounded rather than closed, in ADR 006 §8.4's corrected residual list.
//
// Rows tagged `SUCCEEDED (defect)` are green BECAUSE the defect is there. Invert one when its
// defect closes; never delete it. Rows tagged `FAILED (held)` are attacks the rule survived and
// are the controls that stop "refuse everything" and "believe everything" passing as fixes.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { LS, LS_BOARD, LS_SNAP, LS_OPS, LS_CHECKPOINT, v2store, bootV2, v1board, note, bar } from './_upgrade-harness.js';
import * as storage from '../../src/js/storage.js';
import { minter, DEV, ME, PSP } from './_kit.js';

const op = minter(DEV.meDesk, { act: ME });
const J = (v) => JSON.stringify(v);
const jsonl = (ops) => ops.map((o) => JSON.stringify(o)).join('\n');

/** A real user's board: five appointments, two bars, two categories, one month of scratchpad. */
const VICTIM = () => v1board({
  notes: [
    note('n1', '2026-03-04', 'Zahnarzt'), note('n2', '2026-04-01', 'Steuer'),
    note('n3', '2026-05-09', 'Geburtstag Mama'), note('n4', '2026-06-10', 'Urlaub'),
    note('n5', '2026-07-11', 'Konzert'),
  ],
  bars: [bar('b1', '2026-03-01', '2026-03-20', 'Projekt A'), bar('b2', '2026-03-05', '2026-03-25', 'Projekt B')],
  scratchpads: { '2026-03': 'Einkaufen: Milch, Brot' },
});

const slots = () => ({
  board: LS.getItem(LS_BOARD), ops: LS.getItem(LS_OPS),
  checkpoint: LS.getItem(LS_CHECKPOINT), snapshots: LS.getItem(LS_SNAP),
});
const texts = (s) => s.state.notes.map((n) => n.text).sort();
const cpOf = () => JSON.parse(LS.getItem(LS_CHECKPOINT));
const cpKeys = () => Object.keys(cpOf().regs.regs).sort();

/**
 * One full session over whatever is in storage: boot, arm the WP-8 flag (the only way to make the
 * shipping store write the two files solo mode does not write), do `fn`, persist.
 */
async function session(fn) {
  await bootV2();
  v2store._opsPersisted = true;
  if (fn) await fn(v2store);
  await v2store.persistNow();
  return v2store;
}

/** A board plus the LEGITIMATE lineage-bearing pair this build writes over it. */
async function bound(board) {
  LS.clear();
  LS.setItem(LS_BOARD, J(board));
  await session();
  return slots();
}

/** Boot over exactly these slots. */
async function bootWith({ board, ops, checkpoint, snapshots }) {
  LS.clear();
  if (board !== undefined) LS.setItem(LS_BOARD, typeof board === 'string' ? board : J(board));
  if (ops !== undefined && ops !== null) LS.setItem(LS_OPS, typeof ops === 'string' ? ops : jsonl(ops));
  if (checkpoint !== undefined && checkpoint !== null) LS.setItem(LS_CHECKPOINT, typeof checkpoint === 'string' ? checkpoint : J(checkpoint));
  if (snapshots !== undefined && snapshots !== null) LS.setItem(LS_SNAP, typeof snapshots === 'string' ? snapshots : J(snapshots));
  await bootV2();
  return v2store;
}

/** `snapshots.json` with one restorable day on it — 11.5's safety net, seeded deliberately. */
const SNAP_DAY = '2026-08-01';
const SNAPSHOT = () => [{
  day: SNAP_DAY,
  at: '2026-08-01T00:00:00Z',
  state: v1board({ notes: [note('sn1', '2026-01-01', 'AUS DEM SCHNAPPSCHUSS')] }),
}];

const addNote = (id, text, date = '2026-09-09') => (s) => s.mutate('add', (st) => {
  st.notes.push({ id, date, text, categoryId: st.categories[0].id, repeatsYearly: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE FOUR ATTACKS THAT KILLED THE PREVIOUS TWO RULES — ALL FOUR FAIL NOW
//
// These are controls. If any of them ever goes red the rule has regressed to attempt 1 or 2.
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-1 · the killers, re-run against ADR 006', () => {
  test('R5-1a FAILED (held) · R4-1a: a stranger sharing ONE pad:<YYYY-MM> key changes nothing', async () => {
    // `pad:2026-03` is a MONTH. Under attempt 2's census, recognising one key handed the board
    // over. There is no census; a bare `ops.jsonl` has no header and therefore no lineage.
    const s = await bootWith({ board: VICTIM(), ops: [op('pad.set', 'pad:2026-03', { text: 'fremd' }, { space: PSP })] });
    assert.equal(s.quarantine?.reason, 'no-checkpoint');
    assert.deepEqual(s.state.scratchpads, { '2026-03': 'Einkaufen: Milch, Brot' });
    assert.equal(s.state.notes.length, 5);

    // The same op, this time carried by a checkpoint that names a lineage the board never had.
    const s2 = await bootWith({
      board: VICTIM(),
      checkpoint: { horizon: null, regs: { v: 1, regs: {} }, lzp: { v: 2, lineageId: 'lin_STRANGER', gen: 9 } },
    });
    assert.equal(s2.quarantine?.reason, 'board-carries-no-lineage', 'and a solo board has no lineage to match');
    assert.equal(s2.state.notes.length, 5);
  });

  test('R5-1b FAILED (held) · R4-2a: board A + board B\'s LEGITIMATE checkpoint', async () => {
    const B = await bound(v1board({ notes: [note('x1', '2026-02-02', 'B-BOARD')] }));
    const A = await bound(VICTIM());

    const s = await bootWith({ board: A.board, checkpoint: B.checkpoint });
    assert.equal(s.quarantine?.reason, 'foreign-lineage', 'one comparison, no shared-key arithmetic');
    assert.deepEqual(texts(s), ['Geburtstag Mama', 'Konzert', 'Steuer', 'Urlaub', 'Zahnarzt']);
    assert.equal(s.state.notes.some((n) => n.text === 'B-BOARD'), false, "not one of B's entries reaches A");

    // And the ADR's promise 4: the same board loads identically with and without those files.
    const alone = await bootWith({ board: A.board });
    assert.deepEqual(texts(alone), texts(s), 'INV-15 — the quarantine path cannot touch content');
  });

  test('R5-1c FAILED (held) · R4-4a: the crash between board.json and checkpoint.json', async () => {
    const A = await bound(VICTIM());
    const b = JSON.parse(A.board);
    b.notes.push({ id: 'nX', date: '2026-11-11', text: 'NACH DEM CRASH', categoryId: 'cat-arbeit', repeatsYearly: false });

    const s = await bootWith({ board: J(b), checkpoint: A.checkpoint });
    assert.equal(s.quarantine, null, 'being ahead is the EXPECTED state under R5, not an exception');
    assert.ok(texts(s).includes('NACH DEM CRASH'), 'the note the user made survives');
    assert.equal(s.diagnostics().lineage.reconciled, 1, 'and it is minted, not adopted');
    // INV-3: minted ABOVE the log's horizon, so it also wins against a peer.
    const born = s.registers().get('note:nX').get('_born').stamp;
    assert.ok(born > cpOf().horizon, `${born} must be above the checkpoint horizon ${cpOf().horizon}`);
  });

  test('R5-1d FAILED (held) · R4-3a: a log from a NEWER build, after a downgrade', async () => {
    const A = await bound(VICTIM());
    const cp = JSON.parse(A.checkpoint);
    cp.lzp.v = 99;
    cp.lzp.somethingThisBuildHasNeverHeardOf = { nested: true };
    cp.aTopLevelKeyFromTheFuture = [1, 2, 3];

    const s = await bootWith({ board: A.board, checkpoint: J(cp) });
    assert.equal(s.quarantine, null, '`lzp.v` is never consulted and never a refusal');
    assert.equal(s.diagnostics().lineage.adopted, true);
    assert.deepEqual(texts(s), ['Geburtstag Mama', 'Konzert', 'Steuer', 'Urlaub', 'Zahnarzt']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE INVERSE FAILURE — CAN THE RULE REFUSE A LOG THAT IS GENUINELY THIS BOARD'S?
//
// A rule that is safe because it trusts nothing is not a fix. Every legitimate path.
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-2 · the legitimate paths', () => {
  test('R5-2a FAILED (held) · three ordinary sessions in a row lose nothing and quarantine nothing', async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(VICTIM()));
    await session();
    await session(addNote('nA', 'Termin A'));
    assert.equal(v2store.quarantine, null);
    await session(addNote('nB', 'Termin B'));
    assert.equal(v2store.quarantine, null);
    await bootV2();
    assert.deepEqual(texts(v2store),
      ['Geburtstag Mama', 'Konzert', 'Steuer', 'Termin A', 'Termin B', 'Urlaub', 'Zahnarzt']);
    assert.equal(v2store.quarantine, null, 'no legitimate session is ever refused');
  });

  test('R5-2b FAILED (held) · a restart mid-gesture: the un-persisted op is simply not there', async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(VICTIM()));
    await session();
    await bootV2();
    v2store._opsPersisted = true;
    addNote('nHalb', 'HALB GETIPPT')(v2store);        // 700 ms debounce armed, never fires
    clearTimeout(v2store._saveTimer);                  // the process dies here
    const s = await bootWith(slots());
    assert.equal(s.quarantine, null, 'a killed process does not produce a refusal');
    assert.equal(s.state.notes.some((n) => n.id === 'nHalb'), false, 'and the un-committed gesture is not half-there');
    assert.equal(s.state.notes.length, 5);
  });

  test('R5-2c FAILED (held) · a snapshot restore survives the relaunch', async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(VICTIM()));
    await session();
    await bootV2();
    v2store._opsPersisted = true;
    v2store.snapshots.unshift({
      day: '2026-08-01', at: '2026-08-01T00:00:00Z',
      state: v1board({ notes: [note('old', '2026-01-01', 'GESTERN')] }),
    });
    assert.equal(v2store.restoreSnapshot('2026-08-01'), true);
    await v2store.persistNow();
    await bootV2();
    assert.deepEqual(texts(v2store), ['GESTERN'], '11.5 survives ADR 006');
    assert.equal(v2store.quarantine, null);
  });

  test('R5-2d FAILED (held) · an import survives the relaunch', async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(VICTIM()));
    await session();
    await bootV2();
    v2store._opsPersisted = true;
    assert.equal(v2store.replaceAll(v1board({ notes: [note('m1', '2026-05-05', 'IMPORTIERT')] })), true);
    await v2store.persistNow();
    await bootV2();
    assert.deepEqual(texts(v2store), ['IMPORTIERT']);
    assert.equal(v2store.quarantine, null);
  });

  test('R5-2e INVERTED · a clock skew of more than 24 hours DEFERS the history, names the clock, and destroys nothing', async () => {
    // ADR 006 §12 rule 6 was normative: "The clock is advanced past every stamp in the loaded log
    // before any op is minted." ADR 001 §1.3/§7.4 is equally normative in the other direction: a
    // stamp more than MAX_FUTURE_DRIFT_MS (24 h) ahead is not adopted by the clock
    // (`stamp.js:observe` returns without absorbing it — "a peer with a broken clock must not be
    // able to drag ours forward") and an op stamped that far ahead is PARKED by the log
    // (`isTooFarFuture`), and a parked op changes no register by definition.
    //
    // THE TWO RULES CANNOT BOTH BE OBEYED, so §12.6 is now a PRECONDITION FOR ADOPTION rather
    // than an instruction to try: `store._clockSkew` asks the question before `_observeEveryStamp`
    // is attempted, and the answer is its own quarantine reason. Three things change and each one
    // is a row below: the reason NAMES THE CLOCK, the files are LEFT UNDER THEIR OWN NAMES so the
    // next launch reconsiders them, and the machine's date is what the user is asked to fix.
    const A = await bound(VICTIM());
    const skew = (days) => A.checkpoint.replace(/"0{13}\./g, `"${String(Date.now() + days * 86400000).padStart(13, '0')}.`);
    const b = JSON.parse(A.board);
    b.notes[0].text = 'Zahnarzt VERSCHOBEN';

    // NON-VACUITY FIRST, and round 5 pinned this as the control: half a day of skew is inside the
    // drift window and must keep reconciling perfectly.
    const ok = await bootWith({ board: J(b), checkpoint: skew(0.5) });
    assert.equal(ok.quarantine, null, 'a 12-hour skew is absorbed exactly as the ADR describes');
    assert.equal(ok.diagnostics().lineage.reconciled, 1);
    assert.ok(texts(ok).includes('Zahnarzt VERSCHOBEN'));

    // …and two days is beyond it. Nothing about the log changed except the leading digits.
    // Frozen once: `skew` reads the wall clock, so two calls are two different files.
    const far = skew(2);
    const s = await bootWith({ board: J(b), checkpoint: far });
    assert.equal(s.quarantine?.reason, 'clock-skew',
      'the refusal names the CAUSE, not the post-condition it happened to trip');
    assert.ok(texts(s).includes('Zahnarzt VERSCHOBEN'), 'content is kept whole — R4 still does its job');
    assert.match(s.quarantine.detail, /CLOCK/,
      'and the detail says which machine fact is wrong, so a human can act on it');
    assert.match(s.quarantine.detail, /24 hours/);
    assert.match(s.quarantine.detail, /NOT being discarded/);

    // THE HISTORY IS DEFERRED, NOT GONE: the files keep their own names, so the launch after the
    // clock is fixed finds them where it looks. The browser rename would have made the refusal
    // permanent one launch after it happened.
    assert.equal(LS.getItem(LS_CHECKPOINT), far, 'the checkpoint is still there, byte for byte');
    assert.equal(LS._keys().some((k) => /quarantined-/.test(k)), false, 'and nothing was renamed');
    assert.equal(s.quarantine.movedAside, null);
    assert.equal(s.quarantine.deferred, true);

    // Same launch again, twice: still refused, still there, still nothing lost.
    const again = await bootWith({ board: J(b), checkpoint: far });
    assert.equal(again.quarantine?.reason, 'clock-skew');
    assert.equal(LS.getItem(LS_CHECKPOINT), far);

    // And the moment the log is inside the window again — the clock fixed, or the date simply
    // passed — the SAME log is adopted with its history intact and nothing to re-mint.
    const fixed = await bootWith({ board: A.board, checkpoint: skew(0.5) });
    assert.equal(fixed.quarantine, null);
    assert.equal(fixed.diagnostics().lineage.adopted, true);
    assert.equal(fixed.diagnostics().lineage.reconciled, 0);
  });

  test('R5-2f FAILED (held) · R3-35c, the anti-churn control: an exact match re-mints NOTHING', async () => {
    const A = await bound(VICTIM());
    const before = JSON.parse(A.checkpoint).regs;
    const s = await bootWith({ board: A.board, checkpoint: A.checkpoint });
    assert.equal(s.quarantine, null);
    assert.equal(s.diagnostics().lineage.adopted, true);
    assert.equal(s.diagnostics().lineage.reconciled, 0, 'INV-4 — the diff over a matching pair is empty');
    assert.equal(s.diagnostics().lineage.exact, true);
    // every stamp survives byte-identically
    await s.persistNow();
    assert.deepEqual(cpOf().regs, before, 'INV-6 — no stamp regresses, nothing is re-stamped');
  });

  test('R5-2g SUCCEEDED (defect) · a Time-Machine restore of a PRE-lineage board.json destroys the log', async () => {
    // ADR 006 §5.4 blesses this path by name: "A Time-Machine restore of an older `board.json` is
    // therefore honoured too — which is what the user asked for by restoring it." That is true
    // only while the restored file still carries `_v2`. Restore from a backup taken before the
    // lineage existed — i.e. before the family space, which is the WHOLE of the backup history on
    // upgrade day — and the verdict is `board-carries-no-lineage`: the log is refused and then
    // RENAMED OUT OF THE WAY, so the very next launch cannot reconsider.
    const pre = J(VICTIM());
    LS.clear();
    LS.setItem(LS_BOARD, pre);
    await session();
    const A = slots();

    const s = await bootWith({ board: pre, checkpoint: A.checkpoint });
    assert.equal(s.quarantine?.reason, 'board-carries-no-lineage');
    assert.equal(s.quarantine.movedAside?.checkpoint !== undefined, true, 'and it is moved aside on the spot');
    assert.equal(LS.getItem(LS_CHECKPOINT), null);
    assert.deepEqual(texts(s), ['Geburtstag Mama', 'Konzert', 'Steuer', 'Urlaub', 'Zahnarzt'],
      'content is right — the cost is every stamp and every tombstone');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE SINGLE POINT OF FAILURE — `board.json` MUST BE READABLE  (CLOSED)
//
// ADR 006 §8.2 names it ("a poisoned `board.json` [is] a single point of failure") and answers
// with `snapshots.json` and the quarantined log. Round 5 found neither answer wired to the
// branch that actually fires: R7 (`_recoverFromLog`) was entered when `board.json` merely failed
// to PARSE, compared no lineage, consulted no snapshot, set no `bootFailure`, and the next
// `persistNow()` committed whatever the log said.
//
// THE FIX, and what these three rows now measure:
//
//   · `storage.loadBoardFile()` reports FOUR statuses — `ok` / `absent` / `unparseable` /
//     `read-failed` — and a thrown native read is never again reported as "there is no board".
//   · `store.classifyBoardFile` adds `not-a-board` for JSON that parses to something that is not
//     a board (`[]`, `"a string"`, `null`).
//   · R7 — the ONE branch that adopts a log it cannot tie to a board — is entered ONLY when the
//     file is genuinely ABSENT, which is the precondition §5.5 actually argues for.
//   · Everything else is `_bootUnreadableBoard`: read-only for the session, content from
//     `snapshots.json` (11.5) or nothing, the log quarantined as `board-unreadable` and NOT
//     moved aside, and the user told in as many words that the file is still on disk.
//
// The mutant that must redden all three: revert `init()`'s branch to `if (!board0 && hasLog)`.
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-3 · R7, the recovery branch', () => {
  test('R5-3a INVERTED · an UNPARSEABLE board.json is a READ-ONLY boot over snapshots.json — nothing is reverted and nothing is committed', async () => {
    // The board file is truncated — a partial write, a bad sector, a sync client's conflicted
    // copy, a `Ctrl-C` in a text editor. There is nothing wrong with the DATA: the bytes that
    // were there are still there, `snapshots.json` is right beside it, and the log is one
    // persist behind. What must NOT happen is the store quietly presenting the log's older board
    // and then writing it over the file, which is what turned a recoverable morning into a
    // permanent one.
    LS.clear();
    LS.setItem(LS_BOARD, J(VICTIM()));
    await session();                                   // lineage minted, checkpoint written
    await session(addNote('nNEU', 'DIE NEUE NOTIZ'));  // …and a note added afterwards
    const good = slots();
    assert.ok(JSON.parse(good.board).notes.some((n) => n.text === 'DIE NEUE NOTIZ'));

    const torn = good.board.slice(0, 40);
    const s = await bootWith({ board: torn, checkpoint: good.checkpoint, snapshots: SNAPSHOT() });

    // 1. the app says what happened, and it is READ-ONLY.
    assert.equal(s.ready, true, 'the app still boots — never a white screen');
    assert.equal(s.bootFailure?.reason, 'board-unparseable',
      'a board.json that exists and cannot be read is a FAILED boot, not a recovery from a log');
    assert.match(s.bootFailure.detail, /not valid JSON/);

    // 2. the log is refused, by name, and is NOT renamed away.
    assert.equal(s.quarantine?.reason, 'board-unreadable',
      'no _v2.lineageId can be read, so nothing ties this log to this board');
    assert.equal(LS.getItem(LS_CHECKPOINT), good.checkpoint, 'the checkpoint is still under its own name …');
    assert.equal(s.quarantine.movedAside, null, '… and was not moved aside on a failed boot');
    assert.equal(texts(s).includes('DIE NEUE NOTIZ'), false, 'the log did not put its board on screen …');
    assert.equal(s.diagnostics().recoveredFrom.from, 'snapshot', '… snapshots.json did');

    // 3. §8.2's stated answer is used AND named on the warnings channel.
    assert.deepEqual(texts(s), ['AUS DEM SCHNAPPSCHUSS']);
    assert.equal(s.diagnostics().recoveredFrom.day, SNAP_DAY);
    assert.ok(s.warnings.some((w) => new RegExp(`snapshot from ${SNAP_DAY}`).test(w)),
      `the snapshot is named, not merely used: ${JSON.stringify(s.warnings)}`);
    assert.ok(s.warnings.some((w) => /has NOT been deleted/.test(w)),
      'and the one thing the user needs to know is said first');

    // 4. NOTHING IS COMMITTED. This is the half that made the old behaviour permanent.
    await s.persistNow();
    s.flushSync();
    assert.equal(LS.getItem(LS_BOARD), torn, 'board.json is byte-identical — the bytes are there for a rescue');
    assert.equal(LS.getItem(LS_CHECKPOINT), good.checkpoint, 'and so is the log');

    // NON-VACUITY: with no snapshot beside it the boot is still read-only, just empty.
    const bare = await bootWith({ board: torn, checkpoint: good.checkpoint });
    assert.equal(bare.bootFailure?.reason, 'board-unparseable');
    assert.equal(bare.diagnostics().recoveredFrom.from, 'none');
    assert.deepEqual(texts(bare), [], 'an empty stand-in, never a stranger\'s board');
    assert.ok(bare.warnings.some((w) => /no snapshot to fall back on/.test(w)));
    await bare.persistNow();
    assert.equal(LS.getItem(LS_BOARD), torn, 'and still nothing is written');
  });

  test('R5-3b INVERTED · A3-C1 STAYS CLOSED: a stranger\'s log cannot reach the screen behind a corrupted byte', async () => {
    // R7 was the one branch in ADR 006 that did not compare `lineageId`. It cannot — §5.5's
    // argument is "there is no truth for a log to overrule" — but the conclusion to draw from
    // that is NOT "believe the log". The stranger's checkpoint here is a LEGITIMATE one this
    // build wrote over the stranger's own board, so every structural gate the ADR added passes
    // it: it has an `lzp`, a well-formed `lineageId`, a real horizon, real registers. The only
    // thing that ever separated it from the victim's log was the equality against
    // `board._v2.lineageId` — and a board that cannot be read cannot supply one.
    //
    // A log is therefore refused on the ABSENCE of the tie, never adopted on it.
    const stranger = await bound(v1board({
      notes: [note('s1', '2026-02-02', 'FREMD 1'), note('s2', '2026-02-09', 'FREMD 2')],
      scratchpads: { '2026-02': 'die Notizen eines Fremden' },
    }));
    const victim = await bound(VICTIM());
    const victimSnapshots = victim.snapshots;
    const torn = victim.board.slice(0, 200);

    const s = await bootWith({ board: torn, checkpoint: stranger.checkpoint, snapshots: victimSnapshots });

    assert.equal(s.bootFailure?.reason, 'board-unparseable');
    assert.equal(s.quarantine?.reason, 'board-unreadable', 'the stranger\'s log is refused, not compared');
    assert.equal(s.state.notes.some((n) => /FREMD/.test(n.text)), false, "not one of the stranger's entries reaches the screen");
    assert.deepEqual(s.state.scratchpads, { '2026-03': 'Einkaufen: Milch, Brot' },
      "and the victim's own scratchpad comes back out of her own snapshots.json");
    assert.deepEqual(texts(s), ['Geburtstag Mama', 'Konzert', 'Steuer', 'Urlaub', 'Zahnarzt']);

    // Nothing is written, so nothing about the victim's disk changes — including the evidence.
    await s.persistNow();
    s.flushSync();
    assert.equal(LS.getItem(LS_BOARD), torn, "the victim's bytes are still the victim's bytes");
    assert.equal(LS.getItem(LS_CHECKPOINT), stranger.checkpoint,
      'and the stranger\'s checkpoint is still there under its own name, as evidence');
    assert.equal(LS._keys().some((k) => /quarantined-/.test(k)), false,
      'R5-3b\'s second half: the evidence is NOT renamed away one launch after the board');

    // And the launch after that is the same launch again — a failed boot is idempotent.
    const next = await bootWith({ board: LS.getItem(LS_BOARD), checkpoint: LS.getItem(LS_CHECKPOINT), snapshots: victimSnapshots });
    assert.equal(next.bootFailure?.reason, 'board-unparseable');
    assert.equal(next.state.notes.some((n) => /FREMD/.test(n.text)), false);
  });

  test('R5-3c INVERTED · storage reports FOUR statuses and init() acts on all four', async () => {
    // `loadBoardFile` is the read that keeps the distinction; `loadBoardText` survives as the
    // two-key wrapper its v1-era callers destructure.
    LS.clear();
    assert.equal((await storage.loadBoardFile()).status, 'absent');
    LS.setItem(LS_BOARD, '{ this is not json');
    const torn = await storage.loadBoardFile();
    assert.equal(torn.status, 'unparseable');
    assert.equal(typeof torn.text, 'string', 'and the bytes are carried, for a rescue pass');
    assert.deepEqual(await storage.loadBoardText(), { text: torn.text, raw: null },
      'the old two-key shape is unchanged for the callers that only ever needed it');
    LS.setItem(LS_BOARD, J(VICTIM()));
    assert.equal((await storage.loadBoardFile()).status, 'ok');

    // Four byte-shapes, four verdicts — and `absent` is the ONLY one that is a fresh install.
    const cp = (await bound(VICTIM())).checkpoint;
    const cases = [
      ['{ this is not json', 'board-unparseable'],
      ['[]', 'board-not-a-board'],
      ['"a string"', 'board-not-a-board'],
      ['null', 'board-not-a-board'],
    ];
    for (const [bytes, reason] of cases) {
      const s = await bootWith({ board: bytes, checkpoint: cp });
      assert.equal(s.bootFailure?.reason, reason, `${bytes}: refused, and the reason names which one it is`);
      assert.equal(s.quarantine?.reason, 'board-unreadable', `${bytes}: and the log beside it is never adopted`);
      await s.persistNow();
      assert.equal(LS.getItem(LS_BOARD), bytes, `${bytes}: byte-identical after a persist`);
    }

    // THE NATIVE HALF. A THROWN `load_board` — a locked file, a permission prompt the user
    // dismissed, an EIO — used to become `txt = null`, i.e. "there is no board file", and a
    // transient error was therefore a recovery. It is now `read-failed`.
    const priorWindow = globalThis.window.__TAURI__;
    try {
      globalThis.window.__TAURI__ = { core: { invoke: () => { throw new Error('EIO: the volume went away'); } } };
      LS.clear();
      const failed = await storage.loadBoardFile();
      assert.equal(failed.status, 'read-failed', 'not `absent` — nothing is known about the file');
      assert.match(failed.error, /EIO/);

      const s = await bootWith({ checkpoint: cp });
      assert.equal(s.bootFailure?.reason, 'board-read-failed');
      assert.equal(s.quarantine?.reason, 'board-unreadable', 'a failed read is not a licence to believe a log');

      // NON-VACUITY: the fallback `saveBoardText` writes to is still consulted, so the one board
      // a failed native SAVE left behind is not made unreachable by this.
      LS.setItem(LS_BOARD, J(VICTIM()));
      const viaFallback = await storage.loadBoardFile();
      assert.equal(viaFallback.status, 'ok');
      assert.equal(viaFallback.fallback, true, 'and it says it took the fallback');
    } finally {
      if (priorWindow === undefined) delete globalThis.window.__TAURI__;
      else globalThis.window.__TAURI__ = priorWindow;
    }
  });

  test('R5-3d FAILED (held) · a fresh install is still a fresh install (INV-12)', async () => {
    LS.clear();
    await bootV2();
    assert.equal(v2store.diagnostics().source, 'board.json');
    assert.equal(v2store._recovered, false);
    assert.equal(v2store.state.settings.seenFirstRun, false, 'story 15.1 untouched');
  });

  // ── R5-3e / R5-3f — the two seams the parallel fix passes could not reach ───────────────────
  // Both were reported as "left for another agent" and both were UNPROVEN when the integration
  // began: reverting each one killed no row in any of the four suites, which is the same thing
  // as not having a fix. These are the rows that die.

  test('R5-3e INVERTED · the FIRST reason wins: a stand-in that also refuses to draw does not erase why the board could not be READ', async () => {
    // `_bootUnreadableBoard` runs first and sets `bootFailure.reason = board-*`. `_projectSafe`
    // runs two statements later, and its step 4 ASSIGNED `bootFailure` outright. So the compound
    // case — board.json unreadable AND the snapshot standing in for it unprojectable — reported
    // `unprojectable`, which is a claim about a file nothing has successfully parsed. Everything
    // keyed off the reason went with it: `shownInstead` (the „Angezeigt wird der Schnappschuss
    // vom <Tag>" half of the copy), `logPresent`, and the DE/EN strings themselves.
    //
    // The user-visible cost is the whole point: `unprojectable` tells someone their board is
    // BROKEN. `board-read-failed` tells them the app could not OPEN it and to try again. On a
    // dismissed permission prompt or a volume that went away, the first is false and the second
    // is the difference between relaunching and giving up.
    LS.clear();
    LS.setItem(LS_BOARD, '{ this is not json');
    LS.setItem(LS_SNAP, J(SNAPSHOT()));

    const proto = Object.getPrototypeOf(v2store);
    const real = proto._project;
    proto._project = function refuse() { const e = new Error('refused'); e.name = 'MaterializeError'; throw e; };
    let err = null;
    try { await bootV2(); } catch (e) { err = e; }
    proto._project = real;

    assert.equal(err, null, 'init() still does not throw — I-2 step 4 is unchanged');
    assert.equal(v2store.ready, true, 'and the app still opens');
    assert.equal(v2store.bootFailure?.reason, 'board-unparseable',
      'the reason is the one that is TRUE: board.json was never read, so nothing is known about drawing it');
    assert.match(v2store.bootFailure.detail, /not valid JSON/, 'and the detail is still the read failure');
    assert.equal(typeof v2store.bootFailure.projectionFailure, 'string',
      'the projection failure is recorded BESIDE it, so no diagnostic is lost');
    assert.match(v2store.bootFailure.projectionFailure, /MaterializeError/);
    assert.ok(v2store.bootFailure.shownInstead, 'and the settings pane still knows what it put on screen');

    // Read-only-ness never depended on the reason and still does not — that is what makes
    // preserving the reason safe rather than a trade.
    const bytes = LS.getItem(LS_BOARD);
    await v2store.persistNow();
    v2store.flushSync();
    assert.equal(LS.getItem(LS_BOARD), bytes, 'board.json is byte-identical: the session is read-only');
    assert.equal(LS.getItem(LS_SNAP), J(SNAPSHOT()), 'and so is the snapshot it tried to stand in with');
  });

  test('R5-3f INVERTED · and the read-only warning says which of the four things happened, instead of asserting the file is broken', async () => {
    // `persistNow`'s skip message was written for the one reason that existed when it was
    // written and told all four: "this session is read-only because the board on disk could not
    // be DRAWN." On `board-read-failed` that sentence is simply false — nothing has read the
    // file, so nothing has tried to draw it — and it is false in the direction that costs the
    // user a board: it reads as a verdict on their data rather than on this launch.
    const cp = (await bound(VICTIM())).checkpoint;

    // (a) the file could not be ACCESSED — transient, and the copy says so.
    const priorWindow = globalThis.window.__TAURI__;
    try {
      globalThis.window.__TAURI__ = { core: { invoke: () => { throw new Error('EIO: the volume went away'); } } };
      const s = await bootWith({ checkpoint: cp });
      assert.equal(s.bootFailure?.reason, 'board-read-failed');
      s._toldAboutReadOnly = false;
      s.warnings.length = 0;
      await s.persistNow();
      const w = s.warnings.find((x) => /a save was skipped/.test(x));
      assert.ok(w, 'the skip is still reported');
      assert.match(w, /could not be accessed/, 'and it names ACCESS, not drawing');
      assert.match(w, /quit and reopen/, 'and it says the thing that actually helps');
      assert.equal(/could not be drawn/.test(w), false, 'the false claim is gone');
      assert.match(w, /exactly as it was/, 'and it still promises the files are untouched');
    } finally {
      if (priorWindow === undefined) delete globalThis.window.__TAURI__;
      else globalThis.window.__TAURI__ = priorWindow;
    }

    // (b) the file could not be READ — a stand-in is on screen, and the copy says THAT.
    const s2 = await bootWith({ board: '{ this is not json', checkpoint: cp, snapshots: SNAPSHOT() });
    assert.equal(s2.bootFailure?.reason, 'board-unparseable');
    s2._toldAboutReadOnly = false;
    s2.warnings.length = 0;
    await s2.persistNow();
    const w2 = s2.warnings.find((x) => /a save was skipped/.test(x));
    assert.match(w2, /could not be read/);
    assert.match(w2, /stand-in/, 'it says the board on screen is not the board on disk');
    assert.equal(/could not be drawn/.test(w2), false);

    // (c) NON-VACUITY — the original sentence is still what `unprojectable` gets, because there
    // it is TRUE. A fix that simply deleted the claim would pass (a) and (b) and be wrong here.
    LS.clear();
    LS.setItem(LS_BOARD, J(VICTIM()));
    const proto = Object.getPrototypeOf(v2store);
    const real = proto._project;
    proto._project = function refuse() { const e = new Error('refused'); e.name = 'MaterializeError'; throw e; };
    try { await bootV2(); } finally { proto._project = real; }
    assert.equal(v2store.bootFailure?.reason, 'unprojectable');
    v2store._toldAboutReadOnly = false;
    v2store.warnings.length = 0;
    await v2store.persistNow();
    const w3 = v2store.warnings.find((x) => /a save was skipped/.test(x));
    assert.match(w3, /could not be drawn/,
      'where the board really was read and really would not draw, the original sentence stands');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. IS THE WP-8 DEFERRAL HONEST?   ← CLOSED. These rows are inverted.
//
// ADR 006 §9.2: "The outbox — local ops awaiting push. They live in `ops.jsonl`, which is written
// only after the `board.json` that already contains them (R5)."
//
// It measured false in round 5, in both halves at once. `_persistOps` was
// `saveCheckpoint(this._log.checkpoint())` + `truncateOps(0)`: nothing ever called `appendOps`,
// and `oplog.checkpoint()` folds to `resolveHorizon(opts,'read')` = `horizon ?? maxLiveStamp()`
// with `horizon` NON-NULL for any log that was `load()`ed — so from the second launch onward the
// persisted checkpoint was frozen at the horizon it was read with and every op the user made was
// dropped at persist time.
//
// `_persistOps` is now the four steps ADR 006 §6 asks for — append what the coming checkpoint
// will not carry, compact when the tail has grown (ADR 001 §7.2), checkpoint, then truncate ONLY
// what that checkpoint folds — and these rows measure each of them. Two of round 5's mutants
// die here: putting the tail back in the checkpoint's fold (`checkpoint({horizon: peek()})`,
// which empties the outbox WP-8 has to push) reddens R5-4a, and dropping the `appendOps` call
// reddens R5-4a, R5-4b, R5-4c and R5-4d together.
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-4 INVERTED · the log records, on every launch', () => {
  test('R5-4a INVERTED · EVERY OP AFTER THE FIRST PERSIST IS ON DISK, AS A LINE OF ops.jsonl', async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(VICTIM()));
    await session();
    const h0 = cpOf().horizon;
    const k0 = cpKeys();
    assert.ok(k0.includes('note:n1'), 'the first checkpoint is complete');
    assert.equal(LS.getItem(LS_OPS), null,
      'and it needs no tail: a log that has never been loaded folds EVERYTHING it holds');

    // The second launch is the one that used to lose everything. The checkpoint is frozen at the
    // horizon it was read with — that is `oplog`'s contract and it is correct — so the op belongs
    // in the TAIL, which is what `ops.jsonl` is for (ADR 006 §9.2). It is there.
    await session(addNote('nA', 'Termin A'));
    assert.equal(cpOf().horizon, h0, 'the checkpoint is a PREFIX fold and its horizon is honest');
    assert.deepEqual(cpKeys(), k0, 'so `note:nA` is not in it …');
    const tail = LS.getItem(LS_OPS).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(tail.length, 1, '… it is the one line of the tail beside it …');
    assert.equal(tail[0].op.e, 'note:nA');
    assert.ok(tail[0].op.ts > h0, '… stamped above the horizon, which is why the pair is complete');

    // The pair is what `load()` reads, and it is complete: the op is in the fold on the way back.
    await session(addNote('nB', 'Termin B'));
    assert.equal(LS.getItem(LS_OPS).split('\n').filter(Boolean).length, 2, 'the tail accumulates');
    await bootV2();
    assert.ok(v2store.registers().get('note:nA'), '`note:nA` came back off the disk …');
    assert.ok(v2store.registers().get('note:nB'), '… and so did `note:nB`');

    assert.deepEqual(JSON.parse(LS.getItem(LS_BOARD)).notes.map((n) => n.text).sort(),
      ['Geburtstag Mama', 'Konzert', 'Steuer', 'Termin A', 'Termin B', 'Urlaub', 'Zahnarzt']);
  });

  test('R5-4b INVERTED · so an ordinary launch reconciles ZERO changes and says nothing', async () => {
    // This is the row that gives the diagnostic its meaning back: it fired on EVERY launch with a
    // count that grew, so ADR 006's happy path and its crash path were indistinguishable forever
    // and the warning that is supposed to reveal a real crash was permanently crying wolf.
    LS.clear();
    LS.setItem(LS_BOARD, J(VICTIM()));
    await session();
    await session(addNote('nA', 'Termin A'));
    await session(addNote('nB', 'Termin B'));

    await bootV2();
    assert.deepEqual(v2store.warnings.filter((x) => /reconciled \d+ change/.test(x)), [],
      'nothing crashed, so nothing is reported');
    assert.equal(v2store.diagnostics().lineage.reconciled, 0);
    assert.equal(v2store.quarantine, null);

    // NON-VACUITY: a real crash between the two writes still reports exactly one change, so the
    // count is news again rather than noise. `flushSync` writes board.json and no log file — the
    // browser's pagehide path, and the crash-shaped one by construction.
    await bootV2();
    v2store._opsPersisted = true;
    addNote('nC', 'Termin C')(v2store);
    v2store.flushSync();
    await bootV2();
    assert.equal(v2store.diagnostics().lineage.reconciled, 1, 'ONE change, and it is a real one');
    assert.ok(texts(v2store).includes('Termin C'), 'and R4-4a still holds: the note survives');
  });

  test('R5-4c INVERTED · `_born` — and therefore array order — is stable across launches', async () => {
    // ADR 001 §5 step 5: array order is MANDATORY, NOT COSMETIC. While the checkpoint was frozen,
    // every entry created after the first persist was re-minted `born: true` at a fresh stamp on
    // EVERY launch, so its position in `sortBars`/`sortNotes` was a function of when the app was
    // last opened. INV-6 missed it because it is asserted over ONE reconcile.
    LS.clear();
    LS.setItem(LS_BOARD, J(VICTIM()));
    await session();
    await session(addNote('nA', 'Termin A'));

    await bootV2();
    const first = v2store.registers().get('note:nA').get('_born').stamp;
    const order1 = v2store.state.notes.map((n) => n.id);
    await bootV2();
    const second = v2store.registers().get('note:nA').get('_born').stamp;
    assert.equal(second, first, "the note's `_born` does not move when the app is opened");
    assert.deepEqual(v2store.state.notes.map((n) => n.id), order1, 'and neither does the board');
    await bootV2();
    assert.equal(v2store.registers().get('note:nA').get('_born').stamp, first, 'three launches, one stamp');

    // The upgrade-day entry still keeps GENESIS — that contrast is what made this invisible to a
    // test that only ever boots over an upgrade-day board.
    assert.match(v2store.registers().get('note:n1').get('_born').stamp, /^0{13}\./);
  });

  test('R5-4d INVERTED · `appendOps` has a call site, so §9.2\'s outbox exists', async () => {
    assert.equal(typeof storage.appendOps, 'function', 'the outbox primitive is built …');
    const src = (await import('node:fs')).readFileSync(
      new URL('../../src/js/store.js', import.meta.url), 'utf8',
    );
    assert.match(src, /await storage\.appendOps\(/, '… and `store.js` CALLS it (A3-M5 closed)');
    assert.equal(/storage\.truncateOps\(0\)/.test(src), false,
      'and the truncate is no longer the no-op `truncateOps(0)`, which keeps every line');
    assert.match(src, /truncateOps\(this\._tailLines\)/,
      'it is given a line count, and only where the checkpoint just written folds every one of them');
  });

  test('R5-4e · the tail is BOUNDED: it compacts and truncates, and loses nothing (A3-M5, the other half)', async () => {
    // A3-M5 was filed as "latent — nothing appends, so nothing grows". Something appends now, so
    // this is the row that keeps it from growing: ADR 001 §7.2's compaction, wired to the one
    // `truncateOps` call, with the browser fallback's `LS_OPS_CAP` as the binding constraint.
    LS.clear();
    LS.setItem(LS_BOARD, J(VICTIM()));
    await session();

    await bootV2();
    v2store._opsPersisted = true;
    const cat = v2store.state.categories[0].id;
    for (let i = 0; i < 1700; i++) {
      v2store.state.notes.push({ id: `x${i}`, date: '2026-10-10', text: `T${i}`, categoryId: cat, repeatsYearly: false });
    }
    await v2store.persistNow();                 // `_adopt()` diffs 1 700 new entries into ops

    assert.equal(LS.getItem(LS_OPS), null, 'the tail crossed the threshold, compacted and was dropped');
    assert.ok(cpKeys().includes('note:x1699'), 'and every one of them is in the checkpoint instead');

    await bootV2();
    assert.equal(v2store.state.notes.length, 1705, 'nothing was lost across the compaction');
    assert.equal(v2store.quarantine, null);
    assert.equal(v2store.diagnostics().lineage.reconciled, 0, 'and it is still an ordinary launch');
  });

  test('R5-4f · THE HEADLINE: boot · edit · restart · edit · restart — every launch reconciles zero, every op is durable', async () => {
    // The integrator's acceptance check for the whole of R5-4, written as one narrative rather
    // than as five properties, because the defect was only ever visible as a SEQUENCE: each
    // individual launch looked fine and the damage was that the number grew.
    //
    // Two things are asserted at once and they are not the same claim:
    //   (a) an ORDINARY launch reconciles 0 — the diagnostic is quiet when nothing happened;
    //   (b) an op minted in session N is on DISK, in `checkpoint.json` ∪ `ops.jsonl`, and is
    //       projected back in session N+1 — the diagnostic is quiet because the log is complete,
    //       not because the reconciler stopped looking.
    // Without (b), `reconciled: 0` is satisfiable by a store that adopts nothing and diffs
    // nothing, which is the failure mode this row exists to exclude.
    LS.clear();
    LS.setItem(LS_BOARD, J(VICTIM()));

    // S1 — the first launch over a v1 board. There is NO log to adopt, so there is nothing to
    // reconcile and `reconciled` is null BY CONTRACT, not 0. Pinned so that a future change which
    // makes every launch report null cannot pass this row by looking like the first one.
    await bootV2();
    v2store._opsPersisted = true;
    assert.equal(v2store.diagnostics().lineage.reconciled, null,
      'the first launch has no log: nothing to reconcile is not the same as reconciled nothing');
    addNote('nA', 'Termin A')(v2store);
    await v2store.persistNow();

    // S2 — restart. This is the launch that used to start the rot.
    await bootV2();
    v2store._opsPersisted = true;
    assert.equal(v2store.diagnostics().lineage.reconciled, 0, 'S2: an ORDINARY launch reconciles zero');
    assert.equal(v2store.quarantine, null);
    assert.deepEqual(v2store.warnings.filter((w) => /reconciled \d+ change/.test(w)), []);
    assert.ok(v2store.registers().get('note:nA'), 'S2: session 1\'s op came back off the disk');
    const bornA = v2store.registers().get('note:nA').get('_born').stamp;
    addNote('nB', 'Termin B')(v2store);
    v2store.mutate('edit', (s) => { s.scratchpads['2026-03'] = 'Einkaufen: Milch, Brot, Butter'; });
    await v2store.persistNow();

    // S3 — restart again. Under the defect this launch reconciled a GROWING number.
    await bootV2();
    assert.equal(v2store.diagnostics().lineage.reconciled, 0, 'S3: still zero, and that is the point');
    assert.equal(v2store.quarantine, null);
    assert.deepEqual(v2store.warnings.filter((w) => /reconciled \d+ change/.test(w)), []);

    // (b) — durability, per entity, naming which file holds it. `note:nA` is folded into the
    // checkpoint; `note:nB` is above its horizon and lives in the tail. BOTH are on disk, and
    // that union is what `load()` reads. Asserting the union rather than the checkpoint alone is
    // deliberate: a prefix fold with an honest horizon is the CORRECT shape (R5-4a), and a row
    // demanding everything be in the checkpoint would push a future pass to lie about it.
    const onDisk = (e) => Object.keys(cpOf().regs.regs).includes(e)
      || LS.getItem(LS_OPS).split('\n').filter(Boolean).map((l) => JSON.parse(l)).some((l) => l.op.e === e);
    for (const e of ['note:nA', 'note:nB', 'pad:2026-03']) {
      assert.ok(onDisk(e), `${e} is durable in checkpoint.json ∪ ops.jsonl`);
      assert.ok(v2store.registers().get(e), `${e} is projected back on the next launch`);
    }
    assert.equal(v2store.registers().get('note:nA').get('_born').stamp, bornA,
      'and array order does not move when the app is opened');
    assert.deepEqual(texts(v2store).filter((t) => t.startsWith('Termin')), ['Termin A', 'Termin B']);
    assert.equal(v2store.state.scratchpads['2026-03'], 'Einkaufen: Milch, Brot, Butter');

    // NON-VACUITY. `reconciled === 0` above must be news, not a constant. A genuine crash —
    // board.json written, the log files not — still reports exactly one change.
    await bootV2();
    v2store._opsPersisted = true;
    addNote('nC', 'Termin C')(v2store);
    v2store.flushSync();
    await bootV2();
    assert.equal(v2store.diagnostics().lineage.reconciled, 1,
      'a REAL crash still reports exactly one, so the quiet launches above mean something');
    assert.ok(texts(v2store).includes('Termin C'), 'and R4-4a holds: the note survives the crash');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. R3'S BLIND SPOT — WHAT THE LOG CONTRIBUTES THAT THE BOARD CANNOT CONTRADICT
//
// R3: "It may never contribute, remove, or alter one entity or one field value that `board.json`
// asserts." The reconciler is `diffCollection`, which walks `COLLECTION[].fields`; the
// post-condition was `sameV1Content` → `v1ContentOf`, which walked the SAME list. Any field
// outside it was invisible to both — it could not be minted and it could not be checked.
//
// `_born` is outside that list. ADR 001 §5 step 5: "MANDATORY, NOT COSMETIC … v1's capacity slice
// and its per-column lane rescue are order-sensitive, so array order is user-visible."
//
// THE TWO HALVES PART COMPANY HERE. `_born` is write-once, so R3 cannot be satisfied by minting
// the difference — but the order it decides IS asserted by `board.json`, in its array order, so
// R4 can refuse a log that disagrees. R5-5a is that, inverted. R5-5b is the OTHER half: a field
// `board.json` cannot express at all, which no post-condition over `board.json` can ever see.
// That one is F-5's residual, it is bounded in ADR 006 §8.4 and owed at WP-8, and the row below
// stays green because the defect is still there.
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-5 · what the log contributes that board.json cannot contradict', () => {
  test('R5-5a INVERTED · swapping two `_born` values in the checkpoint is REFUSED, and board.json\'s order is what is drawn', async () => {
    const A = await bound(VICTIM());
    const before = await bootWith({ board: A.board, checkpoint: A.checkpoint });
    assert.deepEqual(before.state.bars.map((b) => b.label), ['Projekt A', 'Projekt B']);
    assert.equal(before.quarantine, null, 'the untampered pair is the control and it is adopted');

    const cp = JSON.parse(A.checkpoint);
    const b1 = cp.regs.regs['bar:b1']._born.value;
    const b2 = cp.regs.regs['bar:b2']._born.value;
    cp.regs.regs['bar:b1']._born.value = b2;
    cp.regs.regs['bar:b2']._born.value = b1;

    const s = await bootWith({ board: A.board, checkpoint: J(cp) });
    assert.equal(s.quarantine?.reason, 'reconcile-failed',
      'the post-condition can see order now, so the log is refused rather than believed');
    assert.deepEqual(s.state.bars.map((b) => b.label), ['Projekt A', 'Projekt B'],
      'and the board is drawn in the order BOARD.JSON carries — R3, for a field R3 could not reach');
    assert.equal(s.state.notes.length, 5, 'promise 4: a quarantine cannot cost content');

    // THE REASON IS TRUE (promise 5), and for the half that actually failed. `_born` is
    // `writeOnce`, so this is the one disagreement the reconciler cannot mint the difference for,
    // and the detail says exactly that instead of naming the post-condition it happened to trip.
    assert.match(s.quarantine.detail, /DIFFERENT ORDER/);
    assert.match(s.quarantine.detail, /write-once/);

    // The two blind spots were the SAME list, and the guard no longer walks it. `_born` is still
    // not a diffable field — it cannot be, it is write-once — which is why R4 and not R3 is what
    // closes this.
    const src = (await import('node:fs')).readFileSync(
      new URL('../../src/js/store.js', import.meta.url), 'utf8',
    );
    const spec = src.slice(src.indexOf('const COLLECTION = ['), src.indexOf('/**', src.indexOf('const COLLECTION = [')));
    assert.equal(/_born/.test(spec), false, '`_born` is still not a diffable field …');
    const v1c = src.slice(src.indexOf('function v1ContentOf'), src.indexOf('/** Key-order-independent JSON'));
    assert.match(v1c, /out\.order\[spec\.key\] = seq/, '… but the post-condition now compares ORDER as well as values');
  });

  test('R5-5b SUCCEEDED (defect) · and the same hole swallows a field `board.json` cannot express at all', async () => {
    // F-5's residual, restated as a measurement rather than an argument. `visibility` and
    // `coEdit` live on the register and are stripped out of `board.json` by `stripV2Fields`, so
    // `board.json` cannot assert them, `diffCollection` cannot mint them and `v1ContentOf`
    // cannot compare them. An adopted checkpoint therefore installs them unopposed.
    const A = await bound(VICTIM());
    const cp = JSON.parse(A.checkpoint);
    cp.regs.regs['note:n1'].visibility = { ...cp.regs.regs['note:n1']._alive, value: 'geteilt' };
    cp.regs.regs['note:n1'].coEdit = { ...cp.regs.regs['note:n1']._alive, value: true };

    const s = await bootWith({ board: A.board, checkpoint: J(cp) });
    assert.equal(s.quarantine, null, 'the post-condition sees nothing to object to');
    const cell = s.registers().get('note:n1');
    assert.equal(cell.get('visibility').value, 'geteilt', "and the checkpoint's value is what the register holds");
    assert.equal(cell.get('coEdit').value, true);
  });
});
