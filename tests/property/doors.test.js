// tests/property/doors.test.js — the properties that hold when a v1 board CANNOT be carried
// intact. LZP-406 · ADR 001 §8.2, §8.5 · ADR 005 §4.2 · REG-20…REG-23, REG-32, RECHECK-82-*
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THERE ARE TWO CORPORA
//
// `migration.test.js`'s P8 asserts EXACT losslessness — `materialize(fold(migrateV1(b)))`
// deep-equals `b` — over `generateBoard`, and that is the right assertion over a board v2 can
// represent. It is false by construction over a board v2 cannot: a truncated note is not the note
// that went in.
//
// REG-32 recorded what that cost: `generateBoard` is sanitised of every shape the fix pass
// repaired — no duplicate id, no empty category list, no null setting, no non-string text,
// nothing over 80 characters, no unknown key — so the entire property suite ran over inputs that
// could not reach one line of the repaired code. Widening `generateBoard` would have turned P8
// red, and the reflex fix (relaxing P8) would have destroyed the one property that says migration
// loses nothing.
//
// So the corpus is widened HERE, in a second generator, under properties that are true of an
// unrepresentable board: every loss is REPORTED, no entry disappears in SILENCE, and the two
// doors — which in v1 are one function (`store.replaceAll` is `this.state = migrate(next)`,
// `store.js:194`) — produce the SAME BOARD.
//
// P14 asserts the corpus really does generate each ugly shape. Without it every property in this
// file could pass vacuously the day somebody sanitises the generator.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import { SEEDS, seeds, forEachSeed } from './harness.js';
import { generateBoard, generateUglyBoard, uglyShapesIn } from '../helpers/gen.js';
import { defaultState } from '../../src/js/store.js';

import { migrateV1, MigrationLossyError } from '../../src/js/core/migrate1to2.js';
import { planReplaceAll, ReplaceLossyError, replaceAllOps } from '../../src/js/core/replace.js';
import { fold } from '../../src/js/core/registers.js';
import { materialize, stripV2Fields, MaterializeError } from '../../src/js/core/materialize.js';
import { fmt } from '../../src/js/core/stamp.js';

const pad22 = (s) => (s + 'A'.repeat(22)).slice(0, 22);
const ME = `mem_${pad22('ME')}`;
const DEV = `dev_${pad22('MACA')}`;
const SHORT = '0123456789ABCDEF';
const BASE = 1787836800000;
const D = defaultState();

const MCTX = {
  me: ME, familySpaceId: null, members: new Map(), currentMembers: new Set([ME]),
  hiddenMembers: new Set(), prefs: {}, lastSeenSeq: {}, defaultSettings: D.settings,
};

const ugly = (seed) => generateUglyBoard(seed, { defaults: D });

/** The ctx a retrofitted store supplies to the import door — see `replace.js:checkCtx`. */
function replaceCtx(seed) {
  let n = 0;
  return {
    me: ME, deviceId: DEV, gid: pad22('gR'),
    mint: () => fmt(BASE + (++n), n % 1000, SHORT),
    newOpId: () => pad22(`o${seed}x${++n}`),
    defaultSettings: D.settings,
    acceptLossy: true,
  };
}

/** Both doors over the same bytes, each folded and projected. `null` where the board cannot open. */
function bothDoors(b) {
  const project = (ops) => {
    try {
      return stripV2Fields(materialize(fold(ops), MCTX));
    } catch (e) {
      if (e instanceof MaterializeError) return null;   // REG-9: refused, not hung
      throw e;
    }
  };
  const m = migrateV1(structuredClone(b), { memberId: ME, deviceId: DEV, acceptLossy: true });
  const r = planReplaceAll(new Map(), structuredClone(b), replaceCtx(0));
  return { m, r, mState: project(m.ops), rState: project(r.ops) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P13 — the two doors are one door
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P13 — migrate and replaceAll produce the SAME BOARD for the same bytes, over ${SEEDS} ugly seeds`, () => {
  // The property REG-20…REG-23 exist to establish, stated once over everything the generator can
  // build instead of four times over four hand-written boards. A fifth divergence introduced by a
  // later edit fails here without anybody having had to think of it.
  //
  // Both doors are given the SAME configuration — `defaultSettings` and `acceptLossy` — because
  // the comparison is between the two conversions, not between two callers.
  forEachSeed(seeds(), 'P13 two doors, one board', (seed) => {
    const { mState, rState } = bothDoors(ugly(seed));

    // A board that cannot be opened must be un-openable through BOTH doors, for the same reason.
    // (`startMonth: null` — REG-9. `materialize` refuses it rather than letting `holidays.js:51`
    // spin forever.) One door refusing and the other projecting would be the same divergence
    // class, arriving through the renderability guard instead of through a field rule.
    assert.equal(rState === null, mState === null,
      'one door opened the board and the other refused it');
    if (mState === null) return;

    for (const k of ['notes', 'bars', 'categories', 'scratchpads', 'settings']) {
      assert.deepEqual(rState[k], mState[k], `${k} differs between the two doors`);
    }
    assert.equal(JSON.stringify(rState), JSON.stringify(mState), 'the boards differ byte for byte');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P14 — the corpus really is ugly
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('P14 — every ugly shape the fix pass repaired is actually generated, and none is rare', () => {
  // THE FALSIFIABILITY GATE for everything else in this file. A generator quietly sanitised back
  // into `generateBoard` would keep every property here green and prove nothing — which is the
  // exact defect REG-32 named. So the observed frequency of each shape is asserted, not assumed.
  const counts = {};
  let n = 0;
  for (const seed of seeds()) {
    n += 1;
    for (const [shape, present] of Object.entries(uglyShapesIn(ugly(seed)))) {
      counts[shape] = (counts[shape] ?? 0) + (present ? 1 : 0);
    }
  }
  const table = Object.entries(counts)
    .map(([k, v]) => `${String(v).padStart(4)}/${n}  ${((v / n) * 100).toFixed(1).padStart(5)}%  ${k}`)
    .join('\n');

  for (const [shape, hits] of Object.entries(counts)) {
    // 1% of 500 seeds is five boards — enough that a failure is reproducible from a printed seed,
    // and low enough that the rare-on-purpose shapes (`startMonth: null`, an empty category list)
    // are not forced up to a rate that would make most of the corpus unopenable.
    assert.ok(hits >= n * 0.01,
      `the corpus reaches "${shape}" in only ${hits}/${n} boards — it is being sanitised\n${table}`);
  }

  // …and the counterweight: the corpus must not be ALL damage either. A board of nothing but
  // broken fields never exercises a broken field next to a good one, which is where the
  // interesting failures live.
  const clean = seeds().filter((s) => !Object.values(uglyShapesIn(ugly(s))).some(Boolean)).length;
  assert.ok(clean <= n * 0.5, 'more than half the corpus is clean');
  const allBroken = seeds().filter((s) => {
    const b = ugly(s);
    return b.notes.length > 0 && b.notes.every((x) => typeof x.text !== 'string');
  }).length;
  assert.ok(allBroken <= n * 0.1, `${allBroken}/${n} boards have no usable note at all`);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P15 — nothing is lost in silence, on either door
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P15 — every entry either lands on the board or is named in the warnings, over ${SEEDS} seeds`, () => {
  // Principle 6 („nichts geht verloren") as a checkable statement. The failure this catches is the
  // one ATT-82 was: an entry that is neither on the board nor in any report — the user had it
  // before the restore and afterwards it is nowhere, with nothing anywhere saying so.
  forEachSeed(seeds(), 'P15 no silent loss', (seed) => {
    const b = ugly(seed);
    const { m, r, mState } = bothDoors(b);
    if (mState === null) return;                         // an unopenable board has no board to check

    const prose = `${m.warnings.join('\n')}\n${r.warnings.join('\n')}`;
    const onBoard = new Set(mState.notes.map((x) => x.id).concat(mState.bars.map((x) => x.id)));
    const rekeyed = /RE-KEYED/.test(prose);

    for (const e of [...b.notes, ...b.bars]) {
      if (onBoard.has(e.id)) continue;
      // Not on the board: then it must be ACCOUNTED FOR. A re-key gives the entry a derived id, so
      // the original id is legitimately absent from the projection — the warning is the record.
      assert.ok(rekeyed || prose.includes(JSON.stringify(e.id)),
        `entry ${JSON.stringify(e.id)} is neither on the board nor in any warning`);
    }

    // Whatever DID survive kept its content: nothing was silently blanked on the way through.
    for (const n of mState.notes) {
      const src = b.notes.find((x) => x.id === n.id);
      if (!src || typeof src.text !== 'string') continue;
      assert.ok(src.text.startsWith(n.text) || n.text === src.text,
        `note ${n.id}: the text on the board is not a prefix of the text in the file`);
      if (n.text !== src.text) {
        assert.match(prose, /TRUNCATED, not dropped/, 'a shortened note with no truncation warning');
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P16 — a lossy board cannot be converted silently, through EITHER entry point
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P16 — both doors refuse to complete silently on a lossy board, over ${SEEDS} seeds`, () => {
  // "A boolean nobody is obliged to read is not a safety mechanism" (`migrate1to2.js`). This is
  // that sentence as a property, over both doors: whenever a conversion loses something, the
  // caller that did not ask for the diagnostics gets an exception carrying them, and the caller
  // that DID ask gets the same information without one.
  let lossySeen = 0;
  forEachSeed(seeds(), 'P16 no silent completion', (seed) => {
    const b = ugly(seed);
    const plan = planReplaceAll(new Map(), structuredClone(b), replaceCtx(seed));

    // THE TWO DOORS AGREE ON WHETHER THIS BOARD LOSES ANYTHING — not just on the board they
    // build. A store is expected to refuse a lossy import and ask the user first, so a `lossy`
    // that differs by door means the SAME FILE is refused at launch and accepted on restore.
    //
    // This assertion is not decoration: it is what found the seventh divergence. `migrateV1`
    // reported an entry that will not be renderable (ADR 001 §5 step 3) as a loss and
    // `planReplaceAll` did not check renderability at all, so seed 335 was lossy through one
    // door and clean through the other.
    const mig = migrateV1(structuredClone(b), { memberId: ME, deviceId: DEV, acceptLossy: true });
    assert.equal(plan.lossy, mig.lossy,
      `the two doors disagree about whether this board is lossy\n  migrate: ${mig.warnings.join(' | ')}\n  import:  ${plan.warnings.join(' | ')}`);

    if (!plan.lossy) {
      // Non-vacuity in the other direction: a representable board must not be refused.
      assert.doesNotThrow(() => replaceAllOps(new Map(), structuredClone(b),
        { ...replaceCtx(seed), acceptLossy: false }));
      assert.doesNotThrow(() => migrateV1(structuredClone(b), { memberId: ME, deviceId: DEV }));
      return;
    }
    lossySeen += 1;

    assert.throws(
      () => replaceAllOps(new Map(), structuredClone(b), { ...replaceCtx(seed), acceptLossy: false }),
      ReplaceLossyError,
      'replaceAllOps completed silently on a lossy board',
    );
    assert.throws(
      () => migrateV1(structuredClone(b), { memberId: ME, deviceId: DEV }),
      MigrationLossyError,
      'migrateV1 completed silently on a lossy board',
    );
    assert.ok(plan.warnings.length > 0, 'lossy with nothing to tell the user');
  });
  // The gate REG-32 asked for: the corpus must actually REACH the lossy path.
  assert.ok(lossySeen > SEEDS * 0.5,
    `only ${lossySeen}/${SEEDS} corpus boards are lossy — the corpus is being sanitised`);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P17 — the representable corpus is still representable
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P17 — CONTROL: the CLEAN corpus loses nothing through either door, over ${SEEDS} seeds`, () => {
  // The control that keeps P13/P15/P16 honest: every assertion above is also satisfied by a
  // conversion that mangles everything and reports it. This one says the doors are not doing that
  // — over `generateBoard`, nothing is lossy, nothing is truncated, nothing is re-keyed, and the
  // two doors still agree.
  forEachSeed(seeds(), 'P17 clean corpus', (seed) => {
    const b = generateBoard(seed, { defaults: D });
    const { m, r, mState, rState } = bothDoors(b);
    assert.equal(m.lossy, false, `migration reported a loss on a clean board: ${m.warnings.join(' | ')}`);
    assert.equal(r.lossy, false, `import reported a loss on a clean board: ${r.warnings.join(' | ')}`);
    assert.ok(mState !== null && rState !== null, 'a clean board must open');
    assert.equal(JSON.stringify(rState), JSON.stringify(mState));
    assert.deepEqual(mState.notes.map((x) => x.id), b.notes.map((x) => x.id), 'a clean board was re-keyed');
  });
});
