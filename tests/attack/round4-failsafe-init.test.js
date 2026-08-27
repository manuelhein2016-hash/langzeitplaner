// ─────────────────────────────────────────────────────────────────────────────
// ROUND 4 — ADVERSARY, ATTACK 2: A3-H1's FAIL-SAFE `init()`
//
// INVERTED 2026-08-27 · Finding 2 and I-2 are closed; ADR 006 is implemented.
//
// A3-H1's closure claimed "anything thrown on the way in becomes a quarantine and `ready` is
// always `true`". It was not. The catch was around `_log.load()` and around the consistency
// check, and NOT around `this._project({settings:true})` two statements later — so a checkpoint
// that loaded cleanly and then refused to project threw `MaterializeError` out of `init()`:
// `ready === false`, `quarantine === null`, a white screen, with an intact `board.json` sitting
// right there. I-2 is the SAME THROW SITE with the poison in `board.json` instead.
//
// Refusing is right: `materialize` refuses a `settings` that would make `layout.js:25` produce a
// NaN year and `holidays.js:51` loop forever (`pinnedMonthsRenderable`, entities.js §2b). What was
// wrong was where the refusal landed. One policy closes both halves:
//
//     THE APP ALWAYS BOOTS TO SOMETHING, AND IT ALWAYS SAYS WHAT IT REFUSED.
//
//   1. project as it stands;
//   2. failing that, reset `mode` / `startMonth` / `pageYears` — the three the projection can
//      actually refuse — at a fresh stamp, and say so;
//   3. failing that, reset every setting to the v1 defaults, and say so;
//   4. failing that, open on an empty board AND REFUSE TO WRITE FOR THE REST OF THE SESSION.
//
// Steps 2 and 3 touch SETTINGS ONLY. No note, bar, category or scratchpad is ever discarded to
// make a board renderable, and step 4 changes no file at all.
//
// ADR 006 also moved the checkpoint rows underneath: a log with no lineage is quarantined before
// it can be projected, so §1 now measures the quarantine and §4 measures the projection guard on
// the two paths where a log's registers really do reach the screen — a RECOVERY (R7), and a
// poisoned `board.json`.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { LS, LS_BOARD, LS_OPS, LS_CHECKPOINT, v2store, bootV2, v1board, note } from './_upgrade-harness.js';
import { minter, DEV, ME, PSP } from './_kit.js';
import { createOpLog } from '../../src/js/core/oplog.js';

const op = minter(DEV.meDesk, { act: ME });
const J = (v) => JSON.stringify(v);
const jsonl = (ops) => ops.map((o) => JSON.stringify(o)).join('\n');

/** The board on disk. `note:n1` is the one entity the census needs to see to accept a log. */
const BOARD = () => v1board({ notes: [note('n1', '2026-03-04', 'Zahnarzt')], scratchpads: { '2026-03': 'Einkaufen' } });

/** A checkpoint carrying `ops`, stamped with a provenance envelope layer 1 accepts. */
function checkpointOf(ops) {
  const log = createOpLog({ now: () => 0 });
  for (const o of ops) log.append(o);
  const cp = log.checkpoint();
  return { ...cp, lzp: { v: 1, boardFp: 'deadbeef', boardN: 3, horizon: cp.horizon, at: 0 } };
}

/** The ops that carry a legal note plus one poisoned `pref:app` patch. */
const POISONED = (patch) => ([
  op('note.set', 'note:n1', { text: 'Zahnarzt', date: '2026-03-04' }, { space: PSP }),
  op('pref.set', 'pref:app', patch, { space: PSP, ctr: 1 }),
]);

/**
 * The four settings shapes `materialize` refuses. They are `upgrade-day-restore.test.js`'s
 * POISONS, moved from `board.json` (I-2) to the log (this file).
 */
const POISONS = {
  'startMonth "nope"': { mode: 'pinned', startMonth: 'nope' },
  'startMonth "999999-01"': { mode: 'pinned', startMonth: '999999-01' },
  'pageYears 1e9': { mode: 'pinned', startMonth: '2026-01', pageYears: 1e9 },
  'pageYears "x"': { mode: 'pinned', startMonth: '2026-01', pageYears: 'x' },
};

async function bootAndCatch({ board, ops, checkpoint }) {
  LS.clear();
  LS.setItem(LS_BOARD, typeof board === 'string' ? board : J(board));
  if (ops !== undefined) LS.setItem(LS_OPS, jsonl(ops));
  if (checkpoint !== undefined) LS.setItem(LS_CHECKPOINT, J(checkpoint));
  let err = null;
  try { await bootV2(); } catch (e) { err = e; }
  return err;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE LOG STILL BRICKS THE BOOT — through the projection, not through the load
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-5 · a checkpoint that loads cleanly and then refuses to project', () => {
  for (const [what, patch] of Object.entries(POISONS)) {
    test(`R4-5 INVERTED · checkpoint.json with ${what} boots, with the user's board on screen`, async () => {
      const bytes = J(BOARD());
      const err = await bootAndCatch({ board: bytes, checkpoint: checkpointOf(POISONED(patch)) });

      assert.equal(err, null, 'init() does not throw');
      assert.equal(v2store.ready, true, '"ready is always true" is true now');
      assert.equal(v2store.quarantine?.reason, 'board-carries-no-lineage',
        'the quarantine that exists for exactly this runs BEFORE the projection can be poisoned');
      assert.equal(v2store.state.notes.length, 1, "and the board is the user's");
      assert.equal(v2store.state.settings.startMonth, BOARD().settings.startMonth,
        "with the user's own settings, not the log's");
    });
  }

  test('R4-5e INVERTED · the same through a TAIL-ONLY ops.jsonl, which carries no lineage at all', async () => {
    const bytes = J(BOARD());
    const err = await bootAndCatch({ board: bytes, ops: POISONED(POISONS['startMonth "nope"']) });
    assert.equal(err, null);
    assert.equal(v2store.ready, true);
    assert.equal(v2store.quarantine?.reason, 'no-checkpoint');
    assert.equal(v2store.state.notes.length, 1);
    assert.equal(LS.getItem(LS_BOARD), bytes, 'and init() wrote nothing over it');
  });

  test('R4-5f · the CONTROL: a log with the same note and a legal pref patch boots', async () => {
    const err = await bootAndCatch({
      board: J(BOARD()),
      checkpoint: checkpointOf(POISONED({ mode: 'pinned', startMonth: '2026-01', pageYears: 0 })),
    });
    assert.equal(err, null);
    assert.equal(v2store.ready, true, 'so the rows above are about the VALUE, not about the shape of the fixture');
  });

  test('R4-5g · an ADOPTED log whose registers refuse to project degrades to "history lost, content kept"', async () => {
    // The post-condition (ADR 006 R4) is the reason this is not a white screen either: the
    // reconciliation cannot even project the log, so the log is quarantined and `board.json` — the
    // truth about content — is used alone. Every conceivable failure of the reconciler lands here.
    LS.clear();
    LS.setItem(LS_BOARD, J(BOARD()));
    await bootV2();
    v2store._opsPersisted = true;
    await v2store.persistNow();                       // a REAL, lineage-bound checkpoint
    const board = LS.getItem(LS_BOARD);
    const cp = JSON.parse(LS.getItem(LS_CHECKPOINT));
    // Poison the adopted log's own pref register, keeping the lineage intact.
    // A real stamp above the log's horizon — a FAR-future one would simply be parked (ADR 001
    // §7.4) and a parked op changes no register, which is not what this row is measuring.
    const poisonedTail = [op('pref.set', 'pref:app', POISONS['startMonth "nope"'], { space: PSP, ms: Date.now() })];

    LS.clear();
    LS.setItem(LS_BOARD, board);
    LS.setItem(LS_CHECKPOINT, J(cp));
    LS.setItem(LS_OPS, jsonl(poisonedTail));
    let err = null;
    try { await bootV2(); } catch (e) { err = e; }

    assert.equal(err, null, 'init() does not throw');
    assert.equal(v2store.ready, true);
    assert.equal(v2store.state.notes.length, 1, "board.json's content is on screen");
    assert.equal(v2store.quarantine?.reason, 'reconcile-failed',
      'the post-condition (ADR 006 R4) caught it, and the log is quarantined rather than applied');
    assert.equal(v2store.state.settings.startMonth, '2026-01', "and the settings on screen are board.json's");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. WHAT A3-H1 DID CLOSE — the rope, so a regression here is visible
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-6 · the shapes A3-H1 genuinely made safe', () => {
  const BROKEN = {
    'no version': { registers: [], horizon: null },
    'v: 99': { v: 99 },
    'registers is a string': { v: 1, registers: 'nope' },
    'null': null,
    'an array': [1, 2, 3],
    'a number': 42,
    'a bare truthy object': { nonsense: true },
  };
  for (const [what, cp] of Object.entries(BROKEN)) {
    test(`R4-6 HELD · a checkpoint that is ${what} boots with the board intact`, async () => {
      const bytes = J(BOARD());
      const err = await bootAndCatch({ board: bytes, checkpoint: cp });
      assert.equal(err, null, 'no throw');
      assert.equal(v2store.ready, true);
      assert.equal(v2store.state.notes.length, 1, 'the board is the user\'s');
      assert.equal(LS.getItem(LS_BOARD), bytes, 'and the file is untouched');
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. DOES QUARANTINING THE CHECKPOINT LOSE OPS THAT WERE ONLY IN IT?
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-7 · what a quarantine costs', () => {
  test('R4-7a HELD · no CONTENT can be checkpoint-only, because persistNow writes board.json first', async () => {
    // The ordering is the whole argument, so it is pinned rather than assumed: if `_persistOps`
    // ever moves above `saveBoard`, a quarantine starts losing entries and this row goes red.
    LS.clear();
    LS.setItem(LS_BOARD, J(BOARD()));
    await bootV2();
    v2store._opsPersisted = true;
    v2store.apply('createNoteInline', { id: 'n2', date: '2026-04-04', text: 'neu', categoryId: v2store.state.categories[0].id });

    let boardHadItWhenTheCheckpointWasWritten = null;
    const orig = v2store._persistOps.bind(v2store);
    v2store._persistOps = async (...a) => {
      const b = JSON.parse(LS.getItem(LS_BOARD) ?? '{"notes":[]}');
      boardHadItWhenTheCheckpointWasWritten = b.notes.some((n) => n.id === 'n2');
      return orig(...a);
    };
    await v2store.persistNow();
    v2store._persistOps = orig;

    assert.equal(boardHadItWhenTheCheckpointWasWritten, true,
      'board.json already carried the new entry when checkpoint.json was written');
    assert.ok(LS.getItem(LS_CHECKPOINT), 'and the checkpoint really was written');
  });

  test('R4-7b INVERTED (INV-6) · a quarantine no longer sends every stamp back to GENESIS', async () => {
    // The re-migration used to re-stamp every field at `GENESIS(i)` (ADR 001 §8.1) — the lowest
    // stamp in the order. In solo mode nothing reads it; on the day a second device exists, every
    // field of this board would lose every contest against any op the peer ever wrote.
    //
    // ADR 006 §9.4: a board that has NEVER had a log is a MIGRATION and keeps GENESIS, because
    // GENESIS(i) is a pure function of the file and that is what makes two Macs agree. A board
    // that HAS a lineage and whose log was refused is a RE-DERIVATION — its values are the newest
    // thing this device knows — and gets fresh stamps.
    LS.clear();
    LS.setItem(LS_BOARD, J(BOARD()));
    await bootV2();
    v2store._opsPersisted = true;
    v2store.apply('createNoteInline', { id: 'n2', date: '2026-04-04', text: 'neu', categoryId: v2store.state.categories[0].id });
    await v2store.persistNow();
    const liveStamp = v2store.registers().get('note:n2')?.get('text')?.stamp;
    assert.ok(liveStamp && !liveStamp.startsWith('0000000000000'), 'a real edit carries a real stamp');

    const cp = JSON.parse(LS.getItem(LS_CHECKPOINT));
    delete cp.lzp;                                     // quarantine it
    const board = LS.getItem(LS_BOARD);
    assert.ok(JSON.parse(board)._v2?.lineageId, 'the board carries a lineage, so this is a RE-DERIVATION');
    LS.clear(); LS.setItem(LS_BOARD, board); LS.setItem(LS_CHECKPOINT, J(cp));
    await bootV2();

    assert.equal(v2store.quarantine?.reason, 'log-carries-no-lineage');
    assert.equal(v2store.state.notes.length, 2, 'the CONTENT is all there');
    const after = v2store.registers().get('note:n2')?.get('text')?.stamp;
    assert.ok(!after.startsWith('0000000000000'),
      `the re-derived stamp is fresh, not GENESIS (${after})`);
    assert.ok(after > liveStamp, 'and above the stamps the refused log carried, so it wins on the day a peer exists');
  });

  test('R4-7c · INV-9 / §9.4 control: a board that never had a log is still migrated at GENESIS', async () => {
    // The other half. If this row ever goes red, two Macs opening the same untouched board.json
    // stop agreeing byte for byte, which is ADR 001 §8.1's whole point.
    LS.clear();
    LS.setItem(LS_BOARD, J(BOARD()));
    await bootV2();
    const stamp = v2store.registers().get('note:n1')?.get('text')?.stamp;
    assert.ok(stamp.startsWith('0000000000000'), `a migrated field carries GENESIS (${stamp})`);
    await v2store.persistNow();
    assert.equal(JSON.parse(LS.getItem(LS_BOARD))._v2, undefined, 'and solo mode writes no _v2 at all');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE PROJECTION GUARD, ON THE PATHS WHERE THE LOG REALLY DOES REACH THE SCREEN
//
// ADR 006 keeps a log's registers off the screen unless the log is bound to this board, so §1's
// rows are now about the quarantine. There are exactly two paths left on which a projection the
// store cannot draw is the one it has to show, and both are here.
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-8 · always boot to something, always say what was refused', () => {
  test('R4-8a · R7 recovery: no board.json, and the log that has to be the truth cannot be drawn', async () => {
    // `board.json` is gone, so there is nothing for the log to overrule and the log IS loaded.
    // This is the one path on which a poisoned register reaches `_project` with no board to fall
    // back on — and it is the row that goes red the moment the guard around `_project` is removed.
    LS.clear();
    LS.setItem(LS_OPS, jsonl([
      op('note.set', 'note:r1', { text: 'gerettet', date: '2026-03-04', _alive: true }, { space: PSP }),
      op('pref.set', 'pref:app', POISONS['startMonth "nope"'], { space: PSP, ctr: 1 }),
    ]));
    let err = null;
    try { await bootV2(); } catch (e) { err = e; }

    assert.equal(err, null, 'init() does not throw');
    assert.equal(v2store.ready, true, 'the app boots');
    assert.equal(v2store.diagnostics().source, 'recovery', 'and reports the boot as a recovery');
    assert.deepEqual(v2store.state.notes.map((n) => n.id), ['r1'], "the log's note was recovered");
    assert.ok(v2store.warnings.some((w) => /RECOVERED from the log/.test(w)));
    assert.ok(v2store.warnings.some((w) => /could not be drawn with the settings it was loaded with/.test(w)),
      `and the repair is named: ${JSON.stringify(v2store.warnings)}`);
    assert.equal(v2store.bootFailure, null);
  });

  test('R4-8b · R7 / INV-12: no board.json and no log is still a FRESH INSTALL (story 15.1)', async () => {
    LS.clear();
    await bootV2();
    assert.equal(v2store.ready, true);
    assert.equal(v2store.diagnostics().source, 'board.json', 'not a recovery — there was nothing to recover');
    assert.equal(v2store.state.settings.seenFirstRun, false, 'story 15.1 is untouched');
    assert.equal(v2store.state.categories.length, 4, 'and the four default categories are there');
  });

  test('R4-8c · the escalation is settings-only: no entry is ever dropped to make a board drawable', async () => {
    LS.clear();
    LS.setItem(LS_OPS, jsonl([
      op('note.set', 'note:r1', { text: 'eins', date: '2026-03-04', _alive: true }, { space: PSP }),
      op('note.set', 'note:r2', { text: 'zwei', date: '2026-04-04', _alive: true }, { space: PSP, ctr: 1 }),
      op('pad.set', 'pad:2026-03', { text: 'Zettel', _alive: true }, { space: PSP, ctr: 2 }),
      op('pref.set', 'pref:app', POISONS['pageYears 1e9'], { space: PSP, ctr: 3 }),
    ]));
    await bootV2();
    assert.equal(v2store.ready, true);
    assert.deepEqual(v2store.state.notes.map((n) => n.id).sort(), ['r1', 'r2']);
    assert.deepEqual(v2store.state.scratchpads, { '2026-03': 'Zettel' });
  });
});
