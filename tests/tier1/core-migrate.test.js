// tests/tier1/core-migrate.test.js — LZP-403 · story 11.6 · ADR 001 §8
//
// WHAT IS BEING GATED HERE, IN ONE PARAGRAPH.
// Migration runs exactly once on a real person's real board and can never be re-run against the
// original, because the original is gone the moment it succeeds. There is no "try again with the
// fix" for this module. So the tests below are not a smoke test of the happy path: they are the
// three properties that make the migration safe to ship —
//
//   R12  DETERMINISM   two migrations of the same file agree, so pairing two already-migrated
//                      Macs converges instead of silently overwriting the newer edit (§8.1).
//   P8   LOSSLESSNESS  materialize(fold(migrateV1(b).ops)) reproduces v1's own migrate(b),
//                      INCLUDING array order, which is user-visible through the "+n" chip
//                      (`layout.js:209`) and the per-column lane rescue (`layout.js:162-177`).
//   §6   CONVERGENCE   the ops are a SET, not a sequence: reorder, duplicate, interleave and
//                      partition them and the board is the same board.
//
// ─────────────────────────────────────────────────────────────────────────────
// A NOTE ON THE REFERENCE FOLD AND THE REFERENCE MATERIALIZER BELOW.
// `core/registers.js` and `core/materialize.js` are later work packages. P8 cannot be stated
// without them, so this file carries a small reference implementation of ADR 001 §6's fold and
// §5's projection. It is deliberately thin: every part that already exists in `core/entities.js`
// (the sort comparators, the renderability predicate, the entity-key parser) is CALLED, not
// re-written, so what is re-implemented here is only the ~40 lines of LWW and projection that
// have no home yet. When `materialize.js` lands, `materializeSolo` here should be deleted and
// P8 re-pointed at the real one — an equivalence test between the two is WP-3's job, not this
// file's.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  GENESIS,
  GENESIS_MS,
  MAX_GENESIS_INDEX,
  MIGRATION_GID,
  MIGRATION_LABEL,
  MigrationError,
  DEFAULT_PALETTE_REF,
  MigrationLossyError,
  SCHEMA_VERSION_V2,
  V1_DEFAULT_CATEGORIES,
  V1_FIELDS,
  V2_ADDITIONS,
  migrateSnapshots,
  migrateV1,
  shouldMigrate,
  toV1Snapshot,
  v1ShapeViolations,
} from '../../src/js/core/migrate1to2.js';
import { classifyOp, fieldsOf, FIELDS, LOCAL_SPACE, PERSONAL_PLACEHOLDER } from '../../src/js/core/ops.js';
import { nextFreeRef, PALETTE } from '../../src/js/palette.js';
import {
  parseEntityKey,
  renderable,
  sortBars,
  sortCategories,
  sortNotes,
  sortScratchpads,
} from '../../src/js/core/entities.js';
import { cmp, fmt, isStamp, MAX_STAMP_CTR } from '../../src/js/core/stamp.js';
import { ZERO_DEVICE_SHORT } from '../../src/js/core/ids.js';
import { canonicalJSON } from '../../src/js/core/canon.js';
import { fold as realFold } from '../../src/js/core/registers.js';
import { materialize as realMaterialize, stripV2Fields as realStrip } from '../../src/js/core/materialize.js';
import { store, defaultState, migrate as v1MigrateFn } from '../../src/js/store.js';
import { boardState, CAT, note, bar } from '../helpers/fixtures.js';
import { generateBoard } from '../helpers/gen.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures and helpers
// ─────────────────────────────────────────────────────────────────────────────

const ME = 'mem_' + 'A'.repeat(22);
const OTHER_MEMBER = 'mem_' + 'Z'.repeat(22);
const MAC_A = 'dev_' + 'A'.repeat(22);
const MAC_B = 'dev_' + 'B'.repeat(22);
// `acceptLossy: true` is the "I have read the report and I am proceeding" flag ATT-82 added:
// a migration that loses something no longer completes silently, it throws MigrationLossyError
// unless the caller either takes the report (`onLossy`) or says this. Most of the hostile-board
// tests below are ABOUT loss, so the shared ctx accepts it; the gate itself is tested separately,
// with a ctx that does not.
const CTX = Object.freeze({ memberId: ME, deviceId: MAC_A, acceptLossy: true });
const CTX_B = Object.freeze({ memberId: ME, deviceId: MAC_B, acceptLossy: true });
/** A ctx that has NOT acknowledged loss — the shape a store that forgot would pass. */
const CTX_STRICT = Object.freeze({ memberId: ME, deviceId: MAC_A });

const clone = (v) => structuredClone(v);
const j = (v) => JSON.stringify(v);

/** A deterministic PRNG, so a shuffle that finds a bug finds it again on the next run. */
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
function shuffled(list, seed) {
  const out = [...list];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const jj = Math.floor(rnd() * (i + 1));
    [out[i], out[jj]] = [out[jj], out[i]];
  }
  return out;
}

/**
 * THE RICH BOARD. Every v1 feature the definition of done names for LZP-403: multi-month bars,
 * a Feb-29 repeat series, an ordinary repeat, hidden categories, scratchpads, a chosen
 * Bundesland, non-ASCII text, an empty bar label, a note whose text is exactly 80 characters,
 * and — deliberately — content whose ARRAY ORDER is not its sort order, so a migration that
 * dropped the index out of the stamp would be caught rather than accidentally right.
 */
function richBoard() {
  return {
    schemaVersion: 1,
    categories: [
      { id: 'cat-work', name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true },
      { id: 'cat-hidden', name: 'Privat', nameEn: 'Personal', paletteRef: 'gruen', visible: false },
      { id: 'cat-reise', name: 'Reisen', nameEn: 'Travel', paletteRef: 'orange', visible: true },
      // A category that was renamed in German. `legend.js:116` does `delete x.nameEn`, so a real
      // v1 board.json has NO nameEn key here — it never writes null. ADR 001 §3.2 row 19's
      // `{nameEn: null}` is the OP-LOG SPELLING of that delete (a register log has no delete),
      // and §5 step 1's "skip null registers" is what turns it back into an absent key. The two
      // rules are two halves of one mechanism; this fixture pins the v1 half.
      { id: 'cat-de-renamed', name: 'Ümlaute & Ähnliches', paletteRef: 'magenta', visible: true },
    ],
    notes: [
      { id: 'n-zahn', date: '2026-03-04', text: 'Zahnarzt 14:30', categoryId: 'cat-work', repeatsYearly: false },
      // deliberately EARLIER in date than the note before it — array order ≠ date order
      { id: 'n-gebu', date: '2024-02-29', text: 'Schaltjahr-Geburtstag', categoryId: 'cat-hidden', repeatsYearly: true },
      { id: 'n-uml', date: '2026-12-24', text: 'Weihnachten — Größe: 42 · „Anführungszeichen"', categoryId: 'cat-reise', repeatsYearly: true },
      { id: 'n-80', date: '2027-01-01', text: 'x'.repeat(80), categoryId: 'cat-work', repeatsYearly: false },
      { id: 'n-empty-text', date: '2026-06-01', text: '', categoryId: 'cat-de-renamed', repeatsYearly: false },
    ],
    bars: [
      // starts LAST, listed FIRST — the bar sort must reorder these and the note sort must not.
      { id: 'b-late', startDate: '2027-06-01', endDate: '2027-06-02', label: 'Kurz', categoryId: 'cat-work' },
      { id: 'b-long', startDate: '2026-01-05', endDate: '2026-11-20', label: 'Projekt Nordstern', categoryId: 'cat-work' },
      { id: 'b-year', startDate: '2025-12-20', endDate: '2026-01-06', label: '', categoryId: 'cat-reise' },
      { id: 'b-40', startDate: '2026-02-01', endDate: '2026-02-28', label: 'y'.repeat(40), categoryId: 'cat-hidden' },
    ],
    scratchpads: {
      '2026-04': 'Urlaub buchen\nZahnarzt anrufen',
      '2026-01': '  Zeilen mit Leerzeichen  ',
      '2027-12': 'Ende',
    },
    settings: {
      bundesland: 'HH',
      layers: { feiertage: true, schulferien: true, otherStates: false, ferienPattern: true },
      mode: 'pinned',
      startMonth: '2026-01',
      pageYears: 2,
      language: 'en',
      launchAtLogin: true,
      menuBarIcon: false,
      rowHeight: 26,
      colWidth: 140,
      paper: 'letter',
      lastCategoryId: 'cat-reise',
      seenFirstRun: true,
    },
  };
}

/**
 * v1's OWN migrate() — the function itself, now that `store.js` exports it.
 *
 * This used to reach it through `store.replaceAll()`, which was v1's only door onto it
 * (`store.js:194` did `this.state = migrate(next)`). After LZP-402 `replaceAll()` is a diff
 * transaction over the op log, so that door leads somewhere else and going through it would make
 * these assertions measure the RETROFIT rather than v1 — which is the opposite of what a
 * characterization test is for. `migrate()` itself is unchanged from the v1 baseline commit, so
 * calling it directly is the same measurement this helper always made, minus the detour.
 */
function v1Migrate(raw) {
  return clone(v1MigrateFn(clone(raw)));   // migrate() mutates its argument; never hand it ours
}

// ── the reference fold (ADR 001 §6) ──────────────────────────────────────────

/**
 * Field-wise LWW. Greatest stamp wins; on an EQUAL stamp the greater canonical value wins.
 *
 * That tiebreak exists for exactly one reason and it is worth stating: GENESIS stamps are the
 * only place in the whole system where two ops can legitimately carry the SAME stamp and
 * DIFFERENT values, because the stamp encodes an array index rather than a device event. Two
 * migrations of the same file never hit it (identical indices carry identical values); two
 * migrations of two DIFFERENT files by the same member can — see the test that pins this.
 * Without a total tiebreak the fold would not be commutative there.
 */
function fold(ops, into) {
  const regs = into || new Map();
  for (const op of ops) {
    let ent = regs.get(op.e);
    if (!ent) { ent = new Map(); regs.set(op.e, ent); }
    for (const name of Object.keys(op.f)) {
      const next = { value: op.f[name], stamp: op.ts, author: op.act };
      const cur = ent.get(name);
      if (!cur) { ent.set(name, next); continue; }
      const c = cmp(next.stamp, cur.stamp)
        || cmp(canonicalJSON(next.value), canonicalJSON(cur.value));
      if (c > 0) ent.set(name, next);
    }
  }
  return regs;
}

const regsToPlain = (regs) => {
  const out = {};
  for (const [e, fields] of [...regs].sort((a, b) => cmp(a[0], b[0]))) {
    out[e] = {};
    for (const name of [...fields.keys()].sort()) {
      const r = fields.get(name);
      out[e][name] = [r.value, r.stamp, r.author];
    }
  }
  return out;
};

// ── the reference materializer (ADR 001 §5, solo mode) ───────────────────────

/** `{'layers.feiertage': true}` → `{layers:{feiertage:true}}` — the inverse of `flattenPref`. */
function unflatten(flat) {
  const out = {};
  for (const key of Object.keys(flat)) {
    const parts = key.split('.');
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = flat[key];
  }
  return out;
}

function materializeSolo(regs) {
  const buckets = { note: [], bar: [], cat: [], pad: [] };
  let prefs = {};

  // step 1 — project each entity, SKIPPING null registers (null means cleared, never a value)
  for (const [key, fields] of regs) {
    const p = parseEntityKey(key);
    assert.ok(p, `materializeSolo: unparsable entity key ${j(key)}`);
    const obj = { id: p.id };
    for (const [name, reg] of fields) {
      if (reg.value === null) continue;
      obj[name] = reg.value;
    }
    if (p.kind === 'pref') { prefs = obj; continue; }
    // step 3 — filter: tombstones, then renderability
    if (obj._alive === false) continue;
    if ((p.kind === 'note' || p.kind === 'bar') && !renderable(p.kind, obj)) continue;
    buckets[p.kind].push(obj);
  }

  // step 5 — the mandatory deterministic sorts
  const categories = sortCategories(buckets.cat);
  let notes = sortNotes(buckets.note);
  let bars = sortBars(buckets.bar);

  const pads = {};
  for (const p of buckets.pad) pads[p.id] = p.text;
  const scratchpads = sortScratchpads(pads);

  // step 6 — settings: the local pref registers over defaultState().settings, with store.js's
  // own defensive nested spread (`store.js:76-80`).
  const d = defaultState().settings;
  const nested = unflatten(Object.fromEntries(Object.entries(prefs).filter(([k]) => k !== 'id')));
  const settings = { ...d, ...nested, layers: { ...d.layers, ...(nested.layers || {}) } };

  // step 7 — reference repair as a PROJECTION INVARIANT, never a mutation of the log
  // (v1's `store.js:82-88`, lifted so it is idempotent and survives a category deleted
  // concurrently with an entry created in it).
  if (categories.length) {
    const ids = new Set(categories.map((c) => c.id));
    const fallback = categories[0].id;
    notes = notes.map((n) => (ids.has(n.categoryId) ? n : { ...n, categoryId: fallback }));
    bars = bars.map((b) => (ids.has(b.categoryId) ? b : { ...b, categoryId: fallback }));
    if (!ids.has(settings.lastCategoryId)) settings.lastCategoryId = fallback;
  }

  return { schemaVersion: SCHEMA_VERSION_V2, notes, bars, categories, scratchpads, settings };
}

/** Everything v2 adds on top of a v1 entry. The AC compares the v1 fields, not the machinery. */
const V2_ENTRY_FIELDS = ['_alive', '_born', 'visibility', 'coEdit', 'defaultVisibility'];
function stripV2Fields(state) {
  const strip = (e) => {
    const o = { ...e };
    for (const f of V2_ENTRY_FIELDS) delete o[f];
    return o;
  };
  return {
    notes: state.notes.map(strip),
    bars: state.bars.map(strip),
    categories: state.categories.map(strip),
    scratchpads: state.scratchpads,
    settings: state.settings,
  };
}

/** migrate → fold → materialize → strip, in one call. */
function roundTrip(raw, ctx = CTX) {
  const { ops, warnings, lossy } = migrateV1(clone(raw), ctx);
  return { state: stripV2Fields(materializeSolo(fold(ops))), ops, warnings, lossy };
}

/**
 * The P8 comparison. v1's own migrate() is the reference; the v2 side is compared AFTER the
 * deterministic sort, which is what ADR 001 §8.3 says ("including array order after the
 * deterministic sort"). All THREE arrays are compared in EXACT v1 array order, because
 * `_born = GENESIS(index)` is supposed to reproduce it.
 *
 * ATT-50 / ATT-52, cross-file: bars used to be compared against `sortBars(v1.bars)`, on the
 * reading that ADR 001 §5 step 5's `(startDate asc, endDate desc, id asc)` was a deliberate v2
 * reordering. It was not — §8.3's "deep-equals for every field INCLUDING array order" is the
 * binding criterion, and a date sort throws the v1 index away. `cmpBars` is now `(_born asc,
 * id asc)` like notes and categories, so the expectation is simply v1's own array.
 */
function assertLossless(raw, ctx = CTX) {
  const before = stripV2Fields({ ...v1Migrate(raw), schemaVersion: undefined });
  const { state, lossy, warnings } = roundTrip(raw, ctx);
  assert.equal(lossy, false, `migration reported itself lossy: ${warnings.join(' | ')}`);
  assert.deepEqual(state.categories, before.categories, 'categories (v1 array order)');
  assert.deepEqual(state.notes, before.notes, 'notes (v1 array order)');
  assert.deepEqual(state.bars, before.bars, 'bars (v1 array order — ATT-50/ATT-52)');
  assert.deepEqual(state.scratchpads, sortScratchpads(before.scratchpads), 'scratchpads');
  assert.deepEqual(state.settings, before.settings, 'settings');
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('GENESIS(i) — the single most important detail in LZP-403 (ADR 001 §8.1)', () => {
  test('is a well-formed 37-char stamp at ms 0 with the all-zeros device short', () => {
    const g = GENESIS(0);
    assert.ok(isStamp(g));
    assert.equal(g.length, 37);
    assert.equal(g, '0000000000000.000000.0000000000000000');
    assert.equal(GENESIS_MS, 0);
    assert.equal(g.slice(21), ZERO_DEVICE_SHORT);
  });

  test('encodes the index, zero-padded to six digits', () => {
    assert.equal(GENESIS(7), '0000000000000.000007.0000000000000000');
    assert.equal(GENESIS(123456), '0000000000000.123456.0000000000000000');
    assert.equal(GENESIS(MAX_GENESIS_INDEX), '0000000000000.999999.0000000000000000');
    assert.equal(MAX_GENESIS_INDEX, MAX_STAMP_CTR);
  });

  test('is strictly increasing in the index — this is what preserves v1 insertion order', () => {
    // A CONSTANT genesis stamp would make every `_born` comparison fall through to
    // uuid-lexicographic order, silently reshuffling which note hides behind "+n".
    let prev = GENESIS(0);
    for (let i = 1; i <= 2000; i++) {
      const g = GENESIS(i);
      assert.equal(cmp(prev, g), -1, `GENESIS(${i - 1}) must sort below GENESIS(${i})`);
      prev = g;
    }
  });

  test('loses to every real stamp on every device, including the all-zeros device at ms 1', () => {
    const highest = GENESIS(MAX_GENESIS_INDEX);
    // the very first millisecond after the epoch, on the smallest possible device short
    assert.equal(cmp(highest, fmt(1, 0, ZERO_DEVICE_SHORT)), -1);
    // a real 2026 stamp on a device short made only of the smallest Crockford character
    assert.equal(cmp(highest, fmt(1787836800123, 0, ZERO_DEVICE_SHORT)), -1);
    // and the whole point: NO index reaches a real stamp
    for (const i of [0, 1, 999, 500000, MAX_GENESIS_INDEX]) {
      assert.equal(cmp(GENESIS(i), fmt(1, 0, '0'.repeat(15) + '1')), -1);
    }
  });

  test('refuses an index that would break the fixed-width total order', () => {
    // 1_000_000 would produce a 38-character stamp, and every `<` comparison in the product
    // assumes fixed width. Loud is the only acceptable behaviour.
    assert.throws(() => GENESIS(MAX_GENESIS_INDEX + 1), RangeError);
    assert.throws(() => GENESIS(-1), RangeError);
    assert.throws(() => GENESIS(1.5), RangeError);
    assert.throws(() => GENESIS('3'), RangeError);
    assert.throws(() => GENESIS(NaN), RangeError);
    assert.throws(() => GENESIS(undefined), RangeError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the emitted ops (ADR 001 §8.2)', () => {
  test('every op is admissible by the real validator', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    assert.ok(ops.length > 0);
    for (const op of ops) {
      // nowMs is armed: a GENESIS stamp is 1970, so the 24 h future clamp must not fire, and
      // there is deliberately NO lower bound anywhere (ADR 001 §1.3).
      assert.deepEqual(classifyOp(op, { nowMs: Date.now() }), { status: 'admit' }, `${op.k} ${op.e}`);
    }
  });

  test('emits exactly the kinds ADR 001 §8.2 names, and no family op at all', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    const kinds = [...new Set(ops.map((o) => o.k))].sort();
    assert.deepEqual(kinds, ['bar.set', 'cat.set', 'note.set', 'pad.set', 'pref.set']);
    // Solo migration must not mint a family space, a member record or a publication. 16.1:
    // joining a family later changes nothing about entries that already exist.
    for (const op of ops) {
      assert.notEqual(op.k, 'pub.set');
      assert.notEqual(op.k, 'member.set');
      assert.notEqual(op.k, 'space.set');
      assert.ok(!/^f(note|bar):/.test(op.e), `${op.e} is a family key`);
    }
  });

  test('content ops carry the personal space placeholder; the pref op carries `local`', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    for (const op of ops) {
      const want = op.k === 'pref.set' ? LOCAL_SPACE : PERSONAL_PLACEHOLDER;
      assert.equal(op.space, want, `${op.k} ${op.e}`);
    }
    assert.equal(PERSONAL_PLACEHOLDER, 'personal');
  });

  test('a real personal space id is used when one already exists', () => {
    const psp = 'psp_' + 'Q'.repeat(22);
    const { ops } = migrateV1(richBoard(), { ...CTX, personalSpaceId: psp });
    for (const op of ops) {
      assert.equal(op.space, op.k === 'pref.set' ? LOCAL_SPACE : psp);
    }
  });

  test('one gid for the whole migration, and pref.set carries none (rule U6)', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    const content = ops.filter((o) => o.k !== 'pref.set');
    assert.ok(content.length > 1);
    for (const op of content) assert.equal(op.gid, MIGRATION_GID, `${op.e}`);
    for (const op of ops.filter((o) => o.k === 'pref.set')) assert.equal(op.gid, null);
    // The gid is a GroupId, not the label. The label is the label.
    assert.equal(MIGRATION_LABEL, 'migrate:v1');
    assert.match(MIGRATION_GID, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(MIGRATION_GID, MIGRATION_LABEL);
  });

  test('act and dev come from ctx and nowhere else', () => {
    const { ops } = migrateV1(richBoard(), CTX_B);
    for (const op of ops) {
      assert.equal(op.act, ME);
      assert.equal(op.dev, MAC_B);
    }
  });

  test('op ids are unique and 22 base64url characters', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    const ids = ops.map((o) => o.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate opId — the server would dedupe a real op away');
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  });

  test('op ids do not leak the payload to the relay', () => {
    // `opId` is server-visible (it is the idempotency key). If it were a hash of the field
    // values, the relay could confirm a guessed note text against it — defeating the point of
    // encrypting the body. Same board, same positions, different text ⇒ SAME ids.
    const a = richBoard();
    const b = richBoard();
    b.notes[0].text = 'etwas ganz anderes';
    b.categories[0].name = 'Anders';
    b.scratchpads['2026-04'] = 'anderer Text';
    const opsA = migrateV1(a, CTX).ops;
    const opsB = migrateV1(b, CTX).ops;
    assert.deepEqual(opsA.map((o) => o.id), opsB.map((o) => o.id));
    assert.notDeepEqual(opsA.map((o) => o.f), opsB.map((o) => o.f));
  });

  test('M2 — the op id is a function of the FILE: two DIFFERENT members derive the same ids', () => {
    // INVERTED (M2). This used to assert the opposite — that the acting member is mixed into the
    // derivation "so two members migrating the same shared export do not collide". That reading
    // broke ADR 001 §8.1 property 2 for the configuration the product ships in: solo mode has no
    // minted MemberId (§11), so my two Macs hold different placeholders until they pair, and
    // "byte-identical" was therefore false for the same file on the same person's two machines.
    // A collision is not a hazard — migration ops only ever go to a PERSONAL space, so two
    // different people's migrations never meet — and between my own two Macs it is the POINT:
    // `opId` is the server's idempotency key.
    const board = richBoard();
    const mine = migrateV1(board, CTX).ops;
    const theirs = migrateV1(board, { memberId: OTHER_MEMBER, deviceId: MAC_B, acceptLossy: true }).ops;
    assert.equal(mine.length, theirs.length);
    for (let i = 0; i < mine.length; i++) {
      assert.equal(theirs[i].id, mine[i].id, `op ${i} (${mine[i].e}) derived a different id`);
      assert.equal(theirs[i].ts, mine[i].ts);
      assert.equal(theirs[i].e, mine[i].e);
      assert.deepEqual(theirs[i].f, mine[i].f);
    }
    // `act` and `dev` are provenance, and they are the ONLY two fields allowed to differ.
    for (let i = 0; i < mine.length; i++) {
      const { act: a1, dev: d1, ...restMine } = mine[i];
      const { act: a2, dev: d2, ...restTheirs } = theirs[i];
      assert.equal(a1, ME); assert.equal(a2, OTHER_MEMBER);
      assert.equal(d1, MAC_A); assert.equal(d2, MAC_B);
      assert.deepEqual(restTheirs, restMine, `op ${i} differs beyond act/dev`);
    }
  });

  test('M2 — the derivation reads neither ctx.memberId nor ctx.deviceId at all', () => {
    // A structural check rather than a sampled one: the id is derived from (index, kind, key),
    // so a change to either ctx field cannot move a single character of a single op id.
    const board = richBoard();
    const ids = (ctx) => migrateV1(board, { ...ctx, acceptLossy: true }).ops.map((o) => o.id);
    const base = ids(CTX);
    for (const ctx of [
      { memberId: OTHER_MEMBER, deviceId: MAC_A },
      { memberId: ME, deviceId: MAC_B },
      { memberId: OTHER_MEMBER, deviceId: MAC_B },
      { memberId: ME, deviceId: MAC_A, personalSpaceId: 'psp_' + 'Q'.repeat(22) },
    ]) assert.deepEqual(ids(ctx), base, j(ctx));
  });

  test('the index runs categories → notes → bars → scratchpads → prefs, contiguously from 0', () => {
    const board = richBoard();
    const { ops, index } = migrateV1(board, CTX);
    assert.equal(index, ops.length);
    ops.forEach((op, i) => {
      assert.equal(op.ts, GENESIS(i), `op ${i} (${op.e}) has the wrong stamp`);
    });
    const kindOrder = ops.map((o) => o.k);
    const expected = [
      ...board.categories.map(() => 'cat.set'),
      ...board.notes.map(() => 'note.set'),
      ...board.bars.map(() => 'bar.set'),
      ...Object.values(board.scratchpads).filter((t) => t !== '').map(() => 'pad.set'),
      'pref.set',
    ];
    assert.deepEqual(kindOrder, expected);
  });

  test('categories are emitted FIRST, so the dangling-reference fallback is the same one v1 chose', () => {
    // `store.js:84` uses `categories[0]`. §5 step 7 resolves that by `(_born asc, id asc)`, so
    // whichever category came first in the v1 array must get the lowest index.
    const board = richBoard();
    const { ops } = migrateV1(board, CTX);
    const cats = ops.filter((o) => o.k === 'cat.set');
    assert.equal(cats[0].e, `cat:${board.categories[0].id}`);
    assert.equal(cats[0].ts, GENESIS(0));
  });

  test('_born is the op’s own stamp on every content entity, and pref has none', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    for (const op of ops) {
      if (op.k === 'pref.set') {
        assert.equal(op.f._born, undefined);
        continue;
      }
      assert.equal(op.f._born, op.ts, `${op.e}`);
    }
  });

  test('every note and bar is migrated privat, coEdit false, alive — story 16.1 as a constant', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    for (const op of ops.filter((o) => o.k === 'note.set' || o.k === 'bar.set')) {
      assert.equal(op.f.visibility, 'privat', `${op.e}`);
      assert.equal(op.f.coEdit, false, `${op.e}`);
      assert.equal(op.f._alive, true, `${op.e}`);
    }
    for (const op of ops.filter((o) => o.k === 'cat.set')) {
      assert.equal(op.f.defaultVisibility, 'privat', `${op.e}`);
      assert.equal(op.f._alive, true, `${op.e}`);
    }
  });

  test('no migrated op carries a relative or delta-shaped field', () => {
    // ADR 001 §3.2: "There is not one relative op in the system." A migration that emitted one
    // would be non-commutative and would double-apply under at-least-once delivery.
    const { ops } = migrateV1(richBoard(), CTX);
    for (const op of ops) {
      for (const name of Object.keys(op.f)) {
        assert.doesNotMatch(name, /delta|offset|shift|^by$|increment|adjust/i, `${op.e}.${name}`);
      }
    }
  });

  test('categoryId is never published — A3 holds through migration', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    for (const op of ops) {
      for (const name of Object.keys(op.f)) {
        if (name.startsWith('pub.')) assert.doesNotMatch(name, /categor/i);
      }
    }
  });

  test('a German-renamed category migrates with no nameEn register at all', () => {
    // v1's DE-rename does `delete x.nameEn` (`legend.js:116`), so the key is absent in the file.
    // Migration must not invent `nameEn: null` here: an absent register and a null register
    // project identically (§5 step 1), but only one of them is what the file said.
    const { ops } = migrateV1(richBoard(), CTX);
    const c = ops.find((o) => o.e === 'cat:cat-de-renamed');
    assert.equal(Object.prototype.hasOwnProperty.call(c.f, 'nameEn'), false);
    assert.equal(c.f.name, 'Ümlaute & Ähnliches');
  });

  test('an explicit null in the FILE is carried as a null register — null is a value', () => {
    // Only reachable from a hand-edited or imported board: v1 deletes, it never writes null.
    // ADR 001 §2: "`null` means the register is cleared and is a first-class value."
    const b = { schemaVersion: 1, categories: [{ id: 'c1', name: 'A', nameEn: null, paletteRef: 'blau', visible: true }], notes: [], bars: [], scratchpads: {}, settings: { mode: 'rolling' } };
    const { ops, lossy } = migrateV1(b, CTX);
    const c = ops.find((o) => o.k === 'cat.set');
    assert.ok(Object.prototype.hasOwnProperty.call(c.f, 'nameEn'), 'the null must reach the log…');
    assert.equal(c.f.nameEn, null);
    assert.equal(lossy, false, 'a null is representable; nothing was dropped');
    // …and §5 step 1 skips null registers, so the projection has no nameEn key — which is
    // exactly what v1's own `delete` produces. The one place the two sides differ is a v1 state
    // that literally holds `nameEn: null`, and the app cannot produce one.
    const state = materializeSolo(fold(ops));
    assert.equal(Object.prototype.hasOwnProperty.call(state.categories[0], 'nameEn'), false);
    assert.equal(v1Migrate(b).categories[0].nameEn, null, 'v1 keeps the hand-edited null verbatim');
  });

  test('a v1 field that is absent stays absent — undefined is not representable', () => {
    const board = { schemaVersion: 1, categories: [{ id: 'c1', name: 'A', paletteRef: 'blau' }], notes: [], bars: [], scratchpads: {}, settings: {} };
    const { ops } = migrateV1(board, CTX);
    const c = ops.find((o) => o.k === 'cat.set');
    assert.equal(Object.prototype.hasOwnProperty.call(c.f, 'nameEn'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(c.f, 'visible'), false);
    assert.deepEqual(Object.keys(c.f), ['name', 'paletteRef', 'defaultVisibility', '_alive', '_born']);
  });

  test('ops are frozen — the log is append-only and immutable (ADR 001 §2)', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    assert.ok(Object.isFrozen(ops[0]));
    assert.ok(Object.isFrozen(ops[0].f));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the field map is pinned to the vocabulary', () => {
  test('every field of every migrated kind is accounted for exactly once', () => {
    // If a later work package adds a field to FIELDS.note, migration must be TOLD what a
    // migrated v1 board puts in it. This is the same assertion the module makes at import time.
    for (const kind of Object.keys(V1_FIELDS)) {
      const declared = fieldsOf(kind).slice().sort();
      const covered = [...V1_FIELDS[kind], ...Object.keys(V2_ADDITIONS[kind]), '_born'].sort();
      assert.deepEqual(covered, declared, `FIELDS.${kind}`);
      // and the two halves never overlap
      for (const f of V1_FIELDS[kind]) {
        assert.equal(Object.prototype.hasOwnProperty.call(V2_ADDITIONS[kind], f), false, f);
      }
    }
  });

  test('the carried v1 fields are exactly v1’s own entry shape', () => {
    assert.deepEqual([...V1_FIELDS.note], ['date', 'text', 'categoryId', 'repeatsYearly']);
    assert.deepEqual([...V1_FIELDS.bar], ['startDate', 'endDate', 'label', 'categoryId']);
    assert.deepEqual([...V1_FIELDS.cat], ['name', 'nameEn', 'paletteRef', 'visible']);
    assert.deepEqual([...V1_FIELDS.pad], ['text']);
    // `id` is the ENTITY KEY in v2, never a field.
    for (const kind of Object.keys(V1_FIELDS)) {
      assert.equal(V1_FIELDS[kind].includes('id'), false);
      assert.equal(FIELDS[kind].id, undefined);
    }
  });

  test('field order inside `f` follows the FIELDS declaration, not a hand-written literal', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    for (const op of ops.filter((o) => o.k !== 'pref.set')) {
      const kind = parseEntityKey(op.e).kind;
      const declared = fieldsOf(kind).filter((f) => f !== '_born');
      const present = Object.keys(op.f).filter((f) => f !== '_born');
      assert.deepEqual(present, declared.filter((f) => present.includes(f)), `${op.e}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('R12 — determinism (ADR 001 §8.1)', () => {
  test('migrating the same board twice produces byte-identical ops', () => {
    const board = richBoard();
    const a = migrateV1(clone(board), CTX);
    const b = migrateV1(clone(board), CTX);
    assert.equal(j(a.ops), j(b.ops));
    assert.deepEqual(a.warnings, b.warnings);
  });

  test('…and does so over 25 consecutive runs', () => {
    const board = richBoard();
    const first = j(migrateV1(clone(board), CTX).ops);
    for (let i = 0; i < 25; i++) {
      assert.equal(j(migrateV1(clone(board), CTX).ops), first, `run ${i}`);
    }
  });

  test('two Macs migrating the same export differ in `dev` and in NOTHING else', () => {
    // This is the property that makes pairing two already-migrated Macs converge. If any other
    // byte differed — a stamp, an op id, a field — the two logs would look like two different
    // histories of the same board and LWW would pick one arbitrarily.
    const board = richBoard();
    const a = migrateV1(clone(board), CTX).ops;
    const b = migrateV1(clone(board), CTX_B).ops;
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) {
      assert.equal(a[i].dev, MAC_A);
      assert.equal(b[i].dev, MAC_B);
      assert.equal(j({ ...a[i], dev: null }), j({ ...b[i], dev: null }), `op ${i} (${a[i].e})`);
    }
  });

  test('two Macs’ migrations fold to IDENTICAL registers — `dev` is not a register', () => {
    const board = richBoard();
    const a = fold(migrateV1(clone(board), CTX).ops);
    const b = fold(migrateV1(clone(board), CTX_B).ops);
    assert.deepEqual(regsToPlain(a), regsToPlain(b));
  });

  test('the op ids collide by design, so the relay stores each migrated op once', () => {
    const board = richBoard();
    const a = migrateV1(clone(board), CTX).ops.map((o) => o.id);
    const b = migrateV1(clone(board), CTX_B).ops.map((o) => o.id);
    assert.deepEqual(a, b, 'the server idempotency key must match, or the second Mac doubles the log');
  });

  test('key order in the input JSON does not change the output', () => {
    const board = richBoard();
    // reserialize every entry with its keys reversed
    const flip = (o) => Object.fromEntries(Object.entries(o).reverse());
    const scrambled = {
      ...board,
      categories: board.categories.map(flip),
      notes: board.notes.map(flip),
      bars: board.bars.map(flip),
      settings: flip(board.settings),
    };
    assert.equal(j(migrateV1(scrambled, CTX).ops), j(migrateV1(board, CTX).ops));
  });

  test('a JSON round-trip of the board does not change the output', () => {
    const board = richBoard();
    const viaFile = JSON.parse(JSON.stringify(board));
    assert.equal(j(migrateV1(viaFile, CTX).ops), j(migrateV1(board, CTX).ops));
  });

  test('migration reads no wall clock and no randomness — enforced by denying them', () => {
    // The static half of this is `core-purity.test.js`. This is the dynamic half: if any code
    // path in the import graph reached for Date.now(), Math.random(), crypto.getRandomValues()
    // or crypto.randomUUID(), the migration would throw instead of returning.
    const realNow = Date.now;
    const realRandom = Math.random;
    const realGRV = globalThis.crypto.getRandomValues;
    const realUUID = globalThis.crypto.randomUUID;
    const boom = (what) => () => { throw new Error(`migration reached for ${what}`); };
    let ops;
    try {
      Date.now = boom('Date.now');
      Math.random = boom('Math.random');
      globalThis.crypto.getRandomValues = boom('crypto.getRandomValues');
      globalThis.crypto.randomUUID = boom('crypto.randomUUID');
      ops = migrateV1(richBoard(), CTX).ops;
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
      globalThis.crypto.getRandomValues = realGRV;
      globalThis.crypto.randomUUID = realUUID;
    }
    assert.ok(ops.length > 0);
    // and the traps really were armed
    assert.throws(boom('x'), /reached for/);
  });

  test('the stamps carry no device identity at all', () => {
    const { ops } = migrateV1(richBoard(), CTX_B);
    for (const op of ops) assert.equal(op.ts.slice(21), ZERO_DEVICE_SHORT, op.e);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('P8 — losslessness (ADR 001 §8.3)', () => {
  beforeEach(() => { store.undoStack.length = 0; store.redoStack.length = 0; });

  test('the rich board survives migrate → fold → materialize', () => {
    const state = assertLossless(richBoard());
    assert.equal(state.notes.length, 5);
    assert.equal(state.bars.length, 4);
    assert.equal(state.categories.length, 4);
    assert.equal(Object.keys(state.scratchpads).length, 3);
  });

  test('the v1 array order of notes and categories is reproduced exactly', () => {
    const board = richBoard();
    const { state } = roundTrip(board);
    assert.deepEqual(state.notes.map((n) => n.id), board.notes.map((n) => n.id));
    assert.deepEqual(state.categories.map((c) => c.id), board.categories.map((c) => c.id));
  });

  test('array order survives even when v1 order is adversarial to every other sort key', () => {
    // 60 notes whose ids, dates and texts all sort DIFFERENTLY from their array order. Only the
    // index inside the GENESIS stamp can reproduce the array order here.
    const notes = [];
    for (let i = 0; i < 60; i++) {
      const k = 59 - i;                                    // ids descend as the array ascends
      notes.push({
        id: `n-${String(k).padStart(3, '0')}`,
        date: `2026-${String((k % 12) + 1).padStart(2, '0')}-15`,
        text: String.fromCharCode(122 - (i % 26)) + i,
        categoryId: CAT[0],
        repeatsYearly: false,
      });
    }
    const board = boardState({ notes });
    const { state } = roundTrip(board);
    assert.deepEqual(state.notes.map((n) => n.id), notes.map((n) => n.id));
    assert.notDeepEqual(state.notes.map((n) => n.id), [...notes.map((n) => n.id)].sort());
  });

  test('a Feb-29 repeat anchor is carried verbatim, not normalised', () => {
    const { state } = roundTrip(richBoard());
    const n = state.notes.find((x) => x.id === 'n-gebu');
    assert.equal(n.date, '2024-02-29');
    assert.equal(n.repeatsYearly, true);
  });

  test('multi-month bars keep their exact range', () => {
    const { state } = roundTrip(richBoard());
    const b = state.bars.find((x) => x.id === 'b-long');
    assert.equal(b.startDate, '2026-01-05');
    assert.equal(b.endDate, '2026-11-20');
    const y = state.bars.find((x) => x.id === 'b-year');
    assert.equal(y.startDate, '2025-12-20');           // crosses the year boundary
    assert.equal(y.endDate, '2026-01-06');
    assert.equal(y.label, '', 'an empty bar label is a value, not an absence');
  });

  test('a hidden category stays hidden', () => {
    const { state } = roundTrip(richBoard());
    assert.equal(state.categories.find((c) => c.id === 'cat-hidden').visible, false);
    assert.equal(state.categories.find((c) => c.id === 'cat-work').visible, true);
  });

  test('scratchpad text survives byte for byte, including leading and trailing spaces', () => {
    const { state } = roundTrip(richBoard());
    assert.equal(state.scratchpads['2026-01'], '  Zeilen mit Leerzeichen  ');
    assert.equal(state.scratchpads['2026-04'], 'Urlaub buchen\nZahnarzt anrufen');
  });

  test('scratchpad keys come out sorted, so board.json byte comparisons are stable', () => {
    const { state } = roundTrip(richBoard());
    assert.deepEqual(Object.keys(state.scratchpads), ['2026-01', '2026-04', '2027-12']);
  });

  test('every setting survives, including the nested layer object', () => {
    const board = richBoard();
    const { state } = roundTrip(board);
    assert.deepEqual(state.settings, v1Migrate(board).settings);
    assert.deepEqual(state.settings.layers, board.settings.layers);
    assert.equal(state.settings.bundesland, 'HH');
    assert.equal(state.settings.paper, 'letter');
    assert.equal(state.settings.rowHeight, 26);
    assert.equal(state.settings.seenFirstRun, true);
  });

  test('a setting v1 did not know about is carried too (store-persistence.test.js:395)', () => {
    const board = richBoard();
    board.settings.somethingFromV2 = 'kept';
    board.settings.density = 'kompakt';
    const { state } = roundTrip(board);
    assert.equal(state.settings.somethingFromV2, 'kept');
    assert.equal(state.settings.density, 'kompakt');
  });

  test('unicode text survives NFC-sensitive round-tripping', () => {
    const { state } = roundTrip(richBoard());
    const n = state.notes.find((x) => x.id === 'n-uml');
    assert.equal(n.text, 'Weihnachten — Größe: 42 · „Anführungszeichen"');
    assert.equal(state.categories.find((c) => c.id === 'cat-de-renamed').name, 'Ümlaute & Ähnliches');
  });

  test('a text of exactly 80 characters and a label of exactly 40 survive', () => {
    const { state } = roundTrip(richBoard());
    assert.equal(state.notes.find((x) => x.id === 'n-80').text.length, 80);
    assert.equal(state.bars.find((x) => x.id === 'b-40').label.length, 40);
  });

  test('the fixtures board (tests/helpers/fixtures.js) round-trips', () => {
    const board = boardState({
      notes: [
        note('n1', '2026-02-03', 'Erste'),
        note('n2', '2026-02-03', 'Zweite', { categoryId: CAT[1], repeatsYearly: true }),
        note('n3', '2026-07-14', 'Dritte', { categoryId: CAT[3] }),
      ],
      bars: [
        bar('b1', '2026-03-01', '2026-05-31', 'Frühjahr'),
        bar('b2', '2026-01-01', '2026-12-31', 'Ganzjahr', { categoryId: CAT[2] }),
      ],
      scratchpads: { '2026-02': 'Notiz' },
      settings: { bundesland: 'BY' },
    });
    const state = assertLossless(board);
    assert.equal(state.notes.length, 3);
    assert.equal(state.bars.length, 2);
  });

  test('an empty board round-trips to an empty board', () => {
    const board = boardState();
    const state = assertLossless(board);
    assert.deepEqual(state.notes, []);
    assert.deepEqual(state.bars, []);
    assert.deepEqual(state.scratchpads, {});
    assert.equal(state.categories.length, 4);
  });

  test('a 400-entry board round-trips (the index counter under load)', () => {
    const notes = [];
    const bars = [];
    for (let i = 0; i < 300; i++) {
      notes.push(note(`n${i}`, `2026-${String((i % 12) + 1).padStart(2, '0')}-0${(i % 9) + 1}`, `Text ${i}`, {
        categoryId: CAT[i % 4],
        repeatsYearly: i % 7 === 0,
      }));
    }
    for (let i = 0; i < 100; i++) {
      bars.push(bar(`b${i}`, `2026-0${(i % 9) + 1}-01`, `2026-1${i % 2}-01`, `Bar ${i}`, { categoryId: CAT[i % 4] }));
    }
    const board = boardState({ notes, bars });
    const { ops } = migrateV1(board, CTX);
    assert.equal(ops.length, 4 + 300 + 100 + 1);
    assert.equal(ops[ops.length - 1].ts, GENESIS(404));
    assertLossless(board);
  });

  test('the dangling-category rule is a projection invariant, not a rewrite of the log', () => {
    // v1 repairs this in migrate() (`store.js:82-88`). v2 must reach the SAME rendered answer
    // without ever writing the repaired value into an op — otherwise "create note in category X"
    // concurrent with "delete category X" would rewrite history on one device and not the other.
    const board = boardState({ notes: [note('n1', '2026-05-05', 'Waise', { categoryId: 'cat-does-not-exist' })] });
    board.settings.lastCategoryId = 'also-gone';
    const { ops, state } = roundTrip(board);
    const op = ops.find((o) => o.e === 'note:n1');
    assert.equal(op.f.categoryId, 'cat-does-not-exist', 'the LOG keeps the dangling value verbatim');
    assert.equal(state.notes[0].categoryId, CAT[0], 'the PROJECTION repairs it');
    assert.equal(state.settings.lastCategoryId, CAT[0]);
    assert.deepEqual(state.notes[0].categoryId, v1Migrate(board).notes[0].categoryId);
  });

  test('repair is idempotent — projecting twice changes nothing', () => {
    const board = boardState({ notes: [note('n1', '2026-05-05', 'Waise', { categoryId: 'nope' })] });
    const regs = fold(migrateV1(board, CTX).ops);
    assert.deepEqual(materializeSolo(regs), materializeSolo(regs));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('§6 convergence — the ops are a SET, not a sequence', () => {
  const board = richBoard();

  test('REORDER: 200 seeded permutations fold to the same registers', () => {
    const { ops } = migrateV1(board, CTX);
    const gold = regsToPlain(fold(ops));
    for (let seed = 1; seed <= 200; seed++) {
      assert.deepEqual(regsToPlain(fold(shuffled(ops, seed))), gold, `seed ${seed}`);
    }
  });

  test('DUPLICATE: at-least-once delivery changes nothing', () => {
    const { ops } = migrateV1(board, CTX);
    const gold = regsToPlain(fold(ops));
    assert.deepEqual(regsToPlain(fold([...ops, ...ops])), gold);
    assert.deepEqual(regsToPlain(fold([...ops, ...ops, ...ops].sort(() => 0))), gold);
    assert.deepEqual(regsToPlain(fold(shuffled([...ops, ...ops], 7))), gold);
  });

  test('PARTITION: fold half, then the other half, in either order', () => {
    const { ops } = migrateV1(board, CTX);
    const gold = regsToPlain(fold(ops));
    for (let cut = 0; cut <= ops.length; cut++) {
      const a = ops.slice(0, cut);
      const b = ops.slice(cut);
      assert.deepEqual(regsToPlain(fold(b, fold(a))), gold, `cut ${cut}`);
      assert.deepEqual(regsToPlain(fold(a, fold(b))), gold, `cut ${cut} reversed`);
    }
  });

  test('INTERLEAVE: two Macs’ migrations of the same export, arbitrarily mixed', () => {
    // The R12 scenario as a fold: both Macs migrated the same file, both pushed, and the ops
    // arrive interleaved. The board must be the board.
    const a = migrateV1(clone(board), CTX).ops;
    const b = migrateV1(clone(board), CTX_B).ops;
    const gold = regsToPlain(fold(a));
    assert.deepEqual(regsToPlain(fold(b)), gold);
    for (let seed = 1; seed <= 50; seed++) {
      assert.deepEqual(regsToPlain(fold(shuffled([...a, ...b], seed))), gold, `seed ${seed}`);
    }
    assert.deepEqual(materializeSolo(fold(shuffled([...a, ...b], 3))), materializeSolo(fold(a)));
  });

  test('a partial group is still a consistent board — `gid` has no effect on merge', () => {
    const { ops } = migrateV1(board, CTX);
    const half = ops.filter((_, i) => i % 2 === 0);
    const state = materializeSolo(fold(half));
    assert.ok(state.notes.length <= board.notes.length);
    // and adding the rest, in any order, reaches the full board
    assert.deepEqual(
      materializeSolo(fold(shuffled(ops.filter((_, i) => i % 2 === 1), 11), fold(half))),
      materializeSolo(fold(ops)),
    );
  });

  test('materialization is order-independent all the way to the rendered arrays', () => {
    const { ops } = migrateV1(board, CTX);
    const gold = j(materializeSolo(fold(ops)));
    for (let seed = 300; seed < 340; seed++) {
      assert.equal(j(materializeSolo(fold(shuffled(ops, seed)))), gold, `seed ${seed}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the silent-overwrite scenario R12 exists to prevent (ADR 001 §8.1)', () => {
  /** A later, real edit: a fresh stamp on a real device. */
  const laterEdit = (entityKey, f, ms = 1787836800123, dev = 'ABCDEFGHJKMNPQRS') => ({
    v: 1,
    id: 'ZZZZZZZZZZZZZZZZZZZZZZ',
    ts: fmt(ms, 0, dev),
    space: PERSONAL_PLACEHOLDER,
    act: ME,
    dev: MAC_A,
    gid: 'YYYYYYYYYYYYYYYYYYYYYY',
    k: 'note.set',
    e: entityKey,
    f,
  });

  test('Mac B’s migration of an old export CANNOT overwrite Mac A’s later edit', () => {
    // Mac A migrates at T0 and I edit the note at T1.
    // Mac B migrates the SAME exported file at T2 > T1 and pushes.
    // If B's ops carried B's wall clock, the OLD text would win and the edit would vanish.
    const board = richBoard();
    const a = migrateV1(clone(board), CTX).ops;
    const edit = laterEdit('note:n-zahn', { text: 'Zahnarzt VERSCHOBEN auf 16:00' });
    const b = migrateV1(clone(board), CTX_B).ops;

    for (const order of [[...a, edit, ...b], [...b, ...a, edit], [...a, ...b, edit], shuffled([...a, ...b, edit], 42)]) {
      const state = materializeSolo(fold(order));
      const n = state.notes.find((x) => x.id === 'n-zahn');
      assert.equal(n.text, 'Zahnarzt VERSCHOBEN auf 16:00', 'the later edit must survive every order');
    }
  });

  test('a migrated tombstone cannot resurrect, and a real delete beats migration', () => {
    const board = richBoard();
    const ops = migrateV1(clone(board), CTX).ops;
    const del = { ...laterEdit('note:n-zahn', { _alive: false }) };
    const state = materializeSolo(fold(shuffled([...ops, del], 5)));
    assert.equal(state.notes.find((x) => x.id === 'n-zahn'), undefined, 'the delete must win');
    // and re-delivering the whole migration afterwards must not bring it back
    const again = materializeSolo(fold([...ops, del, ...ops]));
    assert.equal(again.notes.find((x) => x.id === 'n-zahn'), undefined);
  });

  test('even an edit at wall-millisecond 1 beats the highest possible GENESIS index', () => {
    const board = boardState({ notes: [note('n1', '2026-01-01', 'alt')] });
    const ops = migrateV1(board, CTX).ops;
    const edit = laterEdit('note:n1', { text: 'neu' }, 1, ZERO_DEVICE_SHORT);
    const state = materializeSolo(fold([edit, ...ops]));
    assert.equal(state.notes[0].text, 'neu');
  });

  test('KNOWN HAZARD, pinned: two DIFFERENT boards migrated by one member share stamps', () => {
    // GENESIS encodes an array index, not a device event, so it is the one place in the system
    // where two ops can carry the same stamp and different values. Migrating the same FILE twice
    // never hits it. Migrating two DIVERGED files into one space does — which is why import and
    // snapshot restore are a diff transaction at FRESH stamps (§8.5) and NOT a second migration.
    const a = richBoard();
    const b = richBoard();
    b.categories[0].name = 'Umbenannt';
    const opsA = migrateV1(a, CTX).ops;
    const opsB = migrateV1(b, CTX).ops;
    const catA = opsA.find((o) => o.e === 'cat:cat-work');
    const catB = opsB.find((o) => o.e === 'cat:cat-work');
    assert.equal(catA.ts, catB.ts, 'same index ⇒ same stamp');
    assert.notEqual(catA.f.name, catB.f.name, 'different value at the same stamp');
    // The reference fold breaks that tie totally (greater canonical value wins), so it still
    // converges. `core/registers.js` MUST do the same when it lands, or this is a divergence.
    assert.deepEqual(
      regsToPlain(fold([...opsA, ...opsB])),
      regsToPlain(fold([...opsB, ...opsA])),
      'an equal-stamp tie must be broken deterministically, not by arrival order',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('snapshots.json (ADR 001 §8.4 · story 11.5)', () => {
  const snaps = () => [
    { day: '2026-08-24', at: '2026-08-24T07:01:02.003Z', state: { schemaVersion: 1, notes: [{ id: 'n1', date: '2026-01-01', text: 'gestern', categoryId: 'c1' }], bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau', visible: true }], scratchpads: {}, settings: { mode: 'rolling' } } },
    { day: '2026-08-23', at: '2026-08-23T07:00:00.000Z', state: { schemaVersion: 1, notes: [], bars: [], categories: [], scratchpads: {}, settings: {} } },
  ];

  test('snapshots stay BYTE-IDENTICAL in the v1 shape', () => {
    const input = snaps();
    const before = JSON.stringify(input);
    const out = migrateSnapshots(input);
    assert.equal(JSON.stringify(out.snapshots), before);
    assert.equal(out.snapshots, input, 'returned by reference — migration does not touch the file');
    assert.deepEqual(out.warnings, []);
  });

  test('snapshots produce NO ops — a whole board is not a register', () => {
    // A `board.reset{state}` op was considered and rejected (§8.5): it has no fold rule, no
    // defined behaviour under reordering, and none under two concurrent resets.
    assert.deepEqual(migrateSnapshots(snaps()).ops, []);
    const { ops } = migrateV1({ ...richBoard(), snapshots: snaps() }, CTX);
    for (const op of ops) {
      assert.doesNotMatch(op.k, /reset|snapshot|restore/i);
      assert.doesNotMatch(op.e, /snapshot/i);
    }
  });

  test('a board object carrying a snapshots key does not leak it into the ops', () => {
    const withSnaps = { ...richBoard(), snapshots: snaps() };
    assert.equal(j(migrateV1(withSnaps, CTX).ops), j(migrateV1(richBoard(), CTX).ops));
  });

  test('all seven daily snapshots survive — the safety net is not stripped', () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ day: `2026-08-2${i}`, at: `2026-08-2${i}T00:00:00.000Z`, state: { schemaVersion: 1, notes: [], bars: [], categories: [], scratchpads: {}, settings: {} } }));
    const out = migrateSnapshots(seven);
    assert.equal(out.snapshots.length, 7);
    assert.deepEqual(out.snapshots.map((s) => s.day), seven.map((s) => s.day));
  });

  test('a missing or malformed snapshots file degrades instead of throwing', () => {
    assert.deepEqual(migrateSnapshots(undefined), { snapshots: [], warnings: [], ops: [] });
    assert.deepEqual(migrateSnapshots(null), { snapshots: [], warnings: [], ops: [] });
    const bad = migrateSnapshots({ nope: true });
    assert.deepEqual(bad.snapshots, []);
    assert.equal(bad.warnings.length, 1);
    const partly = migrateSnapshots([{ day: '2026-01-01' }, snaps()[0]]);
    assert.equal(partly.snapshots.length, 2, 'a malformed entry is still KEPT — nothing is ever lost');
    assert.equal(partly.warnings.length, 1);
  });

  test('a snapshot’s own board can itself be migrated, and losslessly', () => {
    // 11.5's restore path is a diff transaction (§8.5) and not this module's job — but the
    // snapshot payload is a v1 board, so it must be migratable if anything ever needs to.
    const s = snaps()[0].state;
    const { lossy, ops } = migrateV1(s, CTX);
    assert.equal(lossy, false);
    assert.equal(ops.length, 1 + 1 + 1, 'one category, one note, one pref');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a v0 board (the pre-schemaVersion shape store.js:migrate handles)', () => {
  /** The earliest internal shape: no schemaVersion, no scratchpads map, no layer object. */
  const v0 = () => ({
    notes: [{ id: 'n1', date: '2026-03-04', text: 'Alt', categoryId: 'c1' }],
    bars: [{ id: 'b1', startDate: '2026-01-01', endDate: '2026-02-01', label: 'Alt', categoryId: 'c1' }],
    categories: [{ id: 'c1', name: 'Arbeit', paletteRef: 'blau' }],
    settings: { mode: 'rolling', bundesland: 'HH' },
  });

  test('migrates without crashing, straight from the v0 shape', () => {
    const { ops, warnings } = migrateV1(v0(), CTX);
    assert.equal(ops.length, 1 + 1 + 1 + 1);
    assert.deepEqual(warnings, []);
    assert.equal(ops[0].e, 'cat:c1');
  });

  test('…and is still deterministic', () => {
    assert.equal(j(migrateV1(v0(), CTX).ops), j(migrateV1(v0(), CTX).ops));
  });

  test('the intended path — v1 migrate() first, then migrateV1 — is lossless', () => {
    // ADR 001 §8: migration "runs once, inside the existing migrate() at store.js:67, AFTER the
    // v0→v1 branch". That branch needs defaultState(), which mints random uuids, so it cannot
    // live in a deterministic pure function. This test pins the composition.
    const state = assertLossless(v0());
    assert.equal(state.notes.length, 1);
    assert.equal(state.categories.length, 1);
  });

  test('the missing scratchpads map and layer object are supplied by v1, not invented here', () => {
    const before = v1Migrate(v0());
    const { state } = roundTrip(v0());
    assert.deepEqual(state.scratchpads, {});
    assert.deepEqual(state.settings.layers, before.settings.layers);
    assert.equal(state.settings.layers.schulferien, false, '7.5 — no Bundesland normalisation ran in v1');
  });

  test('ATT-15 — a board with NO categories gets v1’s four defaults, at DERIVED ids', () => {
    // INVERTED (ATT-15 / ATT-41). This used to assert that migration emits no category at all,
    // on the reasoning that inventing the four defaults needs `crypto.randomUUID()` and two
    // migrations would then disagree (R12). The premise was right and the conclusion was wrong:
    // the answer is to DERIVE the four ids, not to skip a repair v1 performs on every single
    // load (`store.js:73`). Skipping it produced a board v1 cannot produce and the v1 UI cannot
    // survive — `store.category(x)` returns undefined, `legend.js`/`popover.js` read
    // `.paletteRef` off it, and §5 step 7 has nothing to repair the dangling ids TO.
    const board = { notes: [{ id: 'n1', date: '2026-03-01', text: 'a', categoryId: 'ghost' }], bars: [], categories: [], scratchpads: {}, settings: { mode: 'rolling', lastCategoryId: 'ghost' } };
    const { ops, warnings, lossy } = migrateV1(board, CTX);
    const cats = ops.filter((o) => o.k === 'cat.set');
    assert.equal(cats.length, 4, 'the four v1 defaults');
    assert.equal(lossy, false, 'a repair is not a loss');
    assert.match(warnings.join('\n'), /four default categories were substituted/);

    // the four are v1's four, field for field, minus the id
    assert.deepEqual(cats.map((o) => o.f.name), ['Arbeit', 'Familie', 'Reisen', 'Deadlines']);
    assert.deepEqual(cats.map((o) => o.f.paletteRef), ['blau', 'gruen', 'orange', 'magenta']);
    assert.deepEqual(cats.map((o) => o.f.nameEn), ['Work', 'Family', 'Travel', 'Deadlines']);
    assert.ok(cats.every((o) => o.f.visible === true));

    // …and the whole point: the board is usable. The dangling note and the dead lastCategoryId
    // both resolve to the first category, exactly as v1's own migrate() resolves them.
    const state = materializeSolo(fold(ops));
    assert.equal(state.categories.length, 4);
    assert.equal(state.notes[0].categoryId, state.categories[0].id);
    assert.equal(state.settings.lastCategoryId, state.categories[0].id);
    assert.equal(v1Migrate(board).categories.length, 4, 'and v1 does the same thing');
  });

  test('ATT-15 — the invented ids are DERIVED, so two Macs invent the same four (R12)', () => {
    const empty = () => ({ notes: [], bars: [], categories: [], scratchpads: {}, settings: { mode: 'rolling' } });
    const a = migrateV1(empty(), CTX).ops;
    const b = migrateV1(empty(), CTX_B).ops;
    assert.deepEqual(b.map((o) => o.e), a.map((o) => o.e), 'the two Macs invented different ids');
    assert.deepEqual(b.map((o) => o.id), a.map((o) => o.id));
    for (const op of a.filter((o) => o.k === 'cat.set')) {
      assert.match(op.e, /^cat:[A-Za-z0-9_-]{22}$/, 'a derived id must still be a legal entity uuid');
    }
    // and it is a pure function of the NAME, so re-ordering the constant would be a visible change
    assert.notEqual(a[0].e, a[1].e);
  });

  test('ATT-14 — a category with no paletteRef is back-filled exactly as v1 back-fills it', () => {
    // INVERTED (ATT-14). `nextFreeRef([])` (`palette.js:33`) over an empty used-set is always
    // `PALETTE[0].ref`, so v1's `store.js:88` writes one fixed string and so does this.
    const board = { schemaVersion: 1, notes: [], bars: [], categories: [{ id: 'c1', name: 'Alt' }], scratchpads: {}, settings: { mode: 'rolling' } };
    const { ops, lossy, warnings } = migrateV1(clone(board), CTX);
    const cat = ops.find((o) => o.k === 'cat.set');
    assert.equal(cat.f.paletteRef, DEFAULT_PALETTE_REF);
    assert.equal(lossy, false);
    assert.match(warnings.join('\n'), /back-filled/);
    // the constant is pinned to v1's own computation, so palette.js and this file cannot drift
    assert.equal(DEFAULT_PALETTE_REF, nextFreeRef([]));
    assert.equal(v1Migrate(clone(board)).categories[0].paletteRef, DEFAULT_PALETTE_REF);
  });

  test('ATT-14 — an EMPTY-STRING paletteRef is back-filled too (v1 tests falsiness)', () => {
    const board = { schemaVersion: 1, notes: [], bars: [], categories: [{ id: 'c1', name: 'Alt', paletteRef: '' }], scratchpads: {}, settings: {} };
    assert.equal(migrateV1(board, CTX).ops[0].f.paletteRef, DEFAULT_PALETTE_REF);
  });

  test('ATT-41 — the four v1 migrate() repairs all survive the v2 round trip', () => {
    // v1 runs migrate() over every board it loads AND every board that comes in through
    // replaceAll() — an import (11.3) or a snapshot restore (11.5). A board that has been through
    // it satisfies four invariants the rest of v1 never re-checks. This is all four, in one
    // board, compared against v1's own answer.
    const dirty = () => ({
      schemaVersion: 1,
      notes: [{ id: 'n1', date: '2026-03-01', text: 'a', categoryId: 'ghost', repeatsYearly: false }],
      bars: [{ id: 'b1', startDate: '2026-03-01', endDate: '2026-03-05', label: 'x', categoryId: 'ghost' }],
      categories: [{ id: 'c9', name: 'Alt', nameEn: 'Old', visible: true }],   // no paletteRef
      scratchpads: {},
      settings: { mode: 'rolling', bundesland: '', lastCategoryId: 'ghost', layers: { schulferien: true } },
    });
    const before = v1Migrate(dirty());
    const { state } = roundTrip(dirty());
    assert.equal(state.categories[0].paletteRef, before.categories[0].paletteRef, '2 — paletteRef');
    assert.equal(state.notes[0].categoryId, 'c9', '3 — dangling note categoryId');
    assert.equal(state.bars[0].categoryId, 'c9', '3 — dangling bar categoryId');
    assert.equal(state.settings.lastCategoryId, 'c9', '4 — lastCategoryId');
    assert.equal(state.settings.layers.schulferien, false, '7.5 — Ferien without a Bundesland');
    assert.equal(before.settings.layers.schulferien, false, 'and that is v1’s own answer');
    assert.deepEqual(state.categories, before.categories);
    assert.deepEqual(state.notes, before.notes);
    assert.deepEqual(state.settings, before.settings);
  });

  test('ATT-41 — lastCategoryId is repaired in the LOG, not only in the projection', () => {
    // §5 step 7 repairs it on the way out, and that stays. But a `pref` register is device-local
    // and is never re-derived from anything, so the value the next „neue Notiz" reads is the one
    // in the log — which is why v1 repairs it in `migrate()` rather than at render.
    const b = { schemaVersion: 1, notes: [], bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau' }], scratchpads: {}, settings: { lastCategoryId: 'ghost' } };
    const pref = migrateV1(b, CTX).ops.find((o) => o.k === 'pref.set');
    assert.equal(pref.f.lastCategoryId, 'c1');
  });

  test('ATT-41 — a LIVE lastCategoryId and a live categoryId are left completely alone', () => {
    const b = { schemaVersion: 1, notes: [{ id: 'n1', date: '2026-01-01', text: 'x', categoryId: 'c2' }], bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau' }, { id: 'c2', name: 'B', paletteRef: 'gruen' }], scratchpads: {}, settings: { lastCategoryId: 'c2', bundesland: 'HH', layers: { schulferien: true } } };
    const { ops, warnings } = migrateV1(b, CTX);
    const pref = ops.find((o) => o.k === 'pref.set');
    assert.equal(pref.f.lastCategoryId, 'c2');
    assert.equal(pref.f['layers.schulferien'], true, 'a Bundesland is set — the layer means something');
    assert.equal(ops.find((o) => o.e === 'note:n1').f.categoryId, 'c2');
    assert.deepEqual(warnings, [], 'nothing to repair, nothing to say');
  });

  test('ATT-12 — a DANGLING categoryId is repaired in the projection and NOT rewritten in the log', () => {
    // Deliberately not lifted into migrate1to2 even though the other three repairs were. ADR 001
    // §5 step 7 puts this one in the PROJECTION, which is strictly stronger than v1's
    // rewrite-on-load: it is idempotent, and it still holds when one Mac deletes a category
    // concurrently with the other creating an entry in it — a case v1's load-time rewrite cannot
    // see at all. Rewriting the log as well would make the two mechanisms disagree about which
    // one is the truth.
    const b = { schemaVersion: 1, notes: [{ id: 'n1', date: '2026-01-01', text: 'x', categoryId: 'ghost' }], bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau' }], scratchpads: {}, settings: {} };
    const { ops } = migrateV1(b, CTX);
    assert.equal(ops.find((o) => o.e === 'note:n1').f.categoryId, 'ghost', 'the log records what the FILE said');
    assert.equal(materializeSolo(fold(ops)).notes[0].categoryId, 'c1', 'and the projection repairs it');
  });

  test('an entirely empty object migrates to a USABLE empty board', () => {
    // INVERTED (ATT-15). `{}` is what `store.js:migrate()` is handed when the file is missing or
    // unreadable, and v1 answers it with `defaultState()` — four categories and nothing else.
    // Answering it with a board that has no legend at all was a v1 regression on the emptiest
    // possible input.
    const { ops, warnings, lossy } = migrateV1({}, CTX);
    assert.deepEqual(ops.map((o) => o.k), ['cat.set', 'cat.set', 'cat.set', 'cat.set']);
    assert.equal(lossy, false, 'an empty board loses nothing');
    assert.ok(warnings.length >= 2, warnings.join(' | '));
    assert.deepEqual(
      materializeSolo(fold(ops)).categories.map((c) => c.name),
      v1Migrate({}).categories.map((c) => c.name),
      'the same four legend rows v1 would have shown',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('hostile and hand-edited boards', () => {
  const base = () => ({ schemaVersion: 1, notes: [], bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau', visible: true }], scratchpads: {}, settings: { mode: 'rolling' } });

  test('a non-object board is refused loudly', () => {
    for (const bad of [null, undefined, 'board', 42, [], true]) {
      assert.throws(() => migrateV1(bad, CTX), MigrationError, j(bad));
    }
  });

  test('a bad ctx is refused loudly, before a single op is built', () => {
    assert.throws(() => migrateV1(base(), undefined), MigrationError);
    assert.throws(() => migrateV1(base(), { memberId: 'nope', deviceId: MAC_A }), MigrationError);
    assert.throws(() => migrateV1(base(), { memberId: ME }), MigrationError);
    assert.throws(() => migrateV1(base(), { memberId: ME, deviceId: 'mem_' + 'A'.repeat(22) }), MigrationError);
    assert.throws(() => migrateV1(base(), { ...CTX, deviceShort: 'lowercase123456' }), MigrationError);
    assert.throws(() => migrateV1(base(), { ...CTX, personalSpaceId: 'fsp_' + 'A'.repeat(22) }), MigrationError);
  });

  test('a valid deviceShort is accepted and then ignored — stamps stay all-zeros', () => {
    const withShort = migrateV1(base(), { ...CTX, deviceShort: '7QAR2MZ9XKPNC0GV' }).ops;
    assert.equal(j(withShort), j(migrateV1(base(), CTX).ops));
    assert.equal(withShort[0].ts.slice(21), ZERO_DEVICE_SHORT);
  });

  test('notes/bars/categories that are not arrays degrade with a warning', () => {
    const b = { ...base(), notes: 'nope', bars: { a: 1 }, scratchpads: null };
    const { ops, warnings, lossy } = migrateV1(b, CTX);
    assert.equal(ops.filter((o) => o.k === 'note.set').length, 0);
    assert.equal(ops.filter((o) => o.k === 'bar.set').length, 0);
    assert.equal(lossy, true);
    assert.match(warnings.join('\n'), /notes is not an array/);
    assert.match(warnings.join('\n'), /bars is not an array/);
  });

  test('an entry with an unusable id is dropped, never given a fresh one', () => {
    // A minted id would break byte-identical double migration; a content-derived id would make
    // two entries with the same text collide. Dropping it, loudly, is the only honest option.
    const b = base();
    b.notes = [{ id: 'note:with:colons', date: '2026-01-01', text: 'x', categoryId: 'c1' }, { date: '2026-01-02', text: 'no id', categoryId: 'c1' }, { id: 'ok', date: '2026-01-03', text: 'y', categoryId: 'c1' }];
    const { ops, warnings, lossy } = migrateV1(b, CTX);
    assert.deepEqual(ops.filter((o) => o.k === 'note.set').map((o) => o.e), ['note:ok']);
    assert.equal(lossy, true);
    assert.equal(warnings.filter((w) => /unusable id/.test(w)).length, 2);
  });

  test('ATT-90 — a duplicate id is RE-KEYED, not discarded: two registers cannot share a key', () => {
    // INVERTED (ATT-90). Two registers genuinely cannot share an entity key — the second would
    // LWW over the first — but "keep the first, drop the second" is data loss on an entry v1
    // renders. A v1 entity id is opaque: nothing outside the entry refers to a note or bar id, so
    // the second copy can simply be given a fresh one. Derived, not minted, or two migrations of
    // the same file would disagree (R12).
    const b = base();
    b.notes = [
      { id: 'dup', date: '2026-01-01', text: 'first', categoryId: 'c1' },
      { id: 'dup', date: '2026-02-02', text: 'second', categoryId: 'c1' },
      { id: 'dup', date: '2026-03-03', text: 'third', categoryId: 'c1' },
    ];
    const { ops, warnings, lossy } = migrateV1(clone(b), CTX);
    const notes = ops.filter((o) => o.k === 'note.set');
    assert.equal(notes.length, 3, 'all three of the user’s notes survive');
    assert.deepEqual(notes.map((o) => o.f.text), ['first', 'second', 'third']);
    assert.equal(notes[0].e, 'note:dup', 'the FIRST occurrence keeps the id it had');
    assert.equal(new Set(notes.map((o) => o.e)).size, 3, 'three distinct entity keys');
    assert.equal(lossy, false, 'nothing was lost, so this is a repair and not a loss');
    assert.match(warnings.join('\n'), /RE-KEYED/);

    // the board a user actually sees: three notes, in v1's array order
    const state = materializeSolo(fold(ops));
    assert.deepEqual(state.notes.map((n) => n.text), ['first', 'second', 'third']);
    assert.equal(v1Migrate(clone(b)).notes.length, 3, 'which is what v1 renders too');
  });

  test('ATT-90 — the re-key is deterministic: two Macs agree on the new id (R12)', () => {
    const b = () => {
      const x = base();
      x.notes = [
        { id: 'dup', date: '2026-01-01', text: 'first', categoryId: 'c1' },
        { id: 'dup', date: '2026-02-02', text: 'second', categoryId: 'c1' },
      ];
      x.bars = [
        { id: 'dupb', startDate: '2026-01-01', endDate: '2026-01-02', label: 'a', categoryId: 'c1' },
        { id: 'dupb', startDate: '2026-02-01', endDate: '2026-02-02', label: 'b', categoryId: 'c1' },
      ];
      x.categories.push({ id: 'c1', name: 'Zweimal', paletteRef: 'rot', visible: true });
      return x;
    };
    const a = migrateV1(b(), CTX).ops;
    const c = migrateV1(b(), CTX_B).ops;
    assert.deepEqual(c.map((o) => o.e), a.map((o) => o.e));
    assert.deepEqual(c.map((o) => o.id), a.map((o) => o.id));
    assert.equal(a.filter((o) => o.k === 'cat.set').length, 2, 'the duplicate CATEGORY survives too');
    assert.equal(a.filter((o) => o.k === 'note.set').length, 2);
    assert.equal(a.filter((o) => o.k === 'bar.set').length, 2);
    assert.equal(new Set(a.map((o) => o.e)).size, a.length, 'every entity key is distinct');
    // a re-keyed id is a legal entity uuid, or the op would not have validated
    for (const op of a) assert.deepEqual(classifyOp(op, { nowMs: Date.now() }), { status: 'admit' });
  });

  test('ATT-90 — a THIRD copy of the same id gets a third distinct key', () => {
    const b = base();
    b.notes = [1, 2, 3, 4].map((n) => ({ id: 'dup', date: `2026-0${n}-01`, text: `t${n}`, categoryId: 'c1' }));
    const ops = migrateV1(b, CTX).ops.filter((o) => o.k === 'note.set');
    assert.equal(new Set(ops.map((o) => o.e)).size, 4);
    assert.deepEqual(ops.map((o) => o.f.text), ['t1', 't2', 't3', 't4']);
  });

  test('ATT-82 — a value v2 cannot represent is dropped, but a TOO-LONG STRING is truncated', () => {
    // INVERTED (ATT-82). `repeatsYearly: 'yes'` and `visible: 'true'` are still dropped — there is
    // no honest coercion for either. A 300-character `text` is different in kind: v1's 80 is a DOM
    // `maxLength` (`interact.js:466`, `popover.js:146`) that never applied to a FILE, so a real
    // board can hold one, v1 renders it, and dropping the register took the note off the board
    // entirely — `text` is half of a note's renderability (§5 step 3).
    const b = base();
    b.notes = [{ id: 'n1', date: '2026-01-01', text: 'x'.repeat(300), categoryId: 'c1', repeatsYearly: 'yes' }];
    b.categories[0].visible = 'true';
    const { ops, warnings, lossy } = migrateV1(b, CTX);
    const n = ops.find((o) => o.k === 'note.set');
    assert.equal(n.f.text, 'x'.repeat(80), 'truncated to the str80 limit, not dropped');
    assert.equal(n.f.repeatsYearly, undefined, 'a non-boolean has no honest truncation');
    assert.equal(n.f.date, '2026-01-01', 'the rest of the entity still migrates');
    assert.equal(ops.find((o) => o.k === 'cat.set').f.visible, undefined);
    assert.equal(lossy, true, 'a truncation IS a loss and says so');
    assert.equal(warnings.filter((w) => /not representable/.test(w)).length, 2);
    assert.equal(warnings.filter((w) => /TRUNCATED/.test(w)).length, 1);

    // and the note is still on the board, which is the whole point
    const state = materializeSolo(fold(ops));
    assert.equal(state.notes.length, 1);
    assert.equal(state.notes[0].date, '2026-01-01');
  });

  test('an unknown v1 field on an entry is reported, never silently discarded', () => {
    const b = base();
    b.notes = [{ id: 'n1', date: '2026-01-01', text: 'x', categoryId: 'c1', colour: '#f00', legacyFlag: 1 }];
    const { warnings, lossy } = migrateV1(b, CTX);
    assert.equal(lossy, true);
    assert.match(warnings.join('\n'), /unknown v1 field "colour"/);
    assert.match(warnings.join('\n'), /unknown v1 field "legacyFlag"/);
  });

  test('an entry that would not be renderable after migration is reported', () => {
    // v1 renders a text-less note as "…" (`popover.js:193`); ADR 001 §5 step 3 drops it, because
    // renderability is checked against explicit fields and never inferred. That is a real,
    // intended divergence and the user is entitled to be told.
    const b = base();
    b.notes = [{ id: 'n1', text: 'kein Datum', categoryId: 'c1' }];
    b.bars = [{ id: 'b1', startDate: '2026-01-01', label: 'kein Ende', categoryId: 'c1' }];
    const { warnings, ops, lossy } = migrateV1(b, CTX);
    assert.equal(ops.filter((o) => o.k === 'note.set' || o.k === 'bar.set').length, 2, 'the ops are still emitted');
    assert.equal(lossy, true);
    assert.equal(warnings.filter((w) => /not be renderable/.test(w)).length, 2);
    const state = materializeSolo(fold(ops));
    assert.deepEqual(state.notes, []);
    assert.deepEqual(state.bars, []);
  });

  test('an empty-string note text is a VALUE and stays renderable', () => {
    const { state } = roundTrip(richBoard());
    const n = state.notes.find((x) => x.id === 'n-empty-text');
    assert.ok(n, 'an empty note is something v1 can create; it must survive');
    assert.equal(n.text, '');
  });

  test('a scratchpad key that is not YYYY-MM is dropped with a warning', () => {
    const b = { ...base(), scratchpads: { 'not-a-month': 'x', '2026-13': 'y', '2026-04': 'ok', 42: 'z' } };
    const { ops, warnings, lossy } = migrateV1(b, CTX);
    assert.deepEqual(ops.filter((o) => o.k === 'pad.set').map((o) => o.e), ['pad:2026-04']);
    assert.equal(lossy, true);
    assert.equal(warnings.filter((w) => /is not YYYY-MM/.test(w)).length, 3);
  });

  test('an empty scratchpad value emits no op — §8.2 says non-empty keys only', () => {
    const b = { ...base(), scratchpads: { '2026-01': '', '2026-02': ' ', '2026-03': 'x' } };
    const { ops, lossy } = migrateV1(b, CTX);
    assert.deepEqual(ops.filter((o) => o.k === 'pad.set').map((o) => o.e), ['pad:2026-02', 'pad:2026-03']);
    assert.equal(lossy, false, 'v1 deletes a blank pad key; skipping one is not data loss');
  });

  test('a non-string scratchpad value is dropped with a warning', () => {
    const b = { ...base(), scratchpads: { '2026-01': 42, '2026-02': null, '2026-03': 'ok' } };
    const { ops, warnings, lossy } = migrateV1(b, CTX);
    assert.deepEqual(ops.filter((o) => o.k === 'pad.set').map((o) => o.e), ['pad:2026-03']);
    assert.equal(lossy, true);
    assert.equal(warnings.filter((w) => /is not a string/.test(w)).length, 2);
  });

  test('an array in settings is dropped per key, not silently smuggled through', () => {
    // `f` is scalars-only by contract. v2 carries set membership as `hiddenMembers.<id>: true`.
    const b = { ...base(), settings: { mode: 'rolling', hiddenMembers: ['mem_x'], colWidth: 118 } };
    const { ops, warnings, lossy } = migrateV1(b, CTX);
    const pref = ops.find((o) => o.k === 'pref.set');
    assert.equal(pref.f.hiddenMembers, undefined);
    assert.equal(pref.f.mode, 'rolling');
    assert.equal(pref.f.colWidth, 118, 'one bad key must not cost the whole settings object');
    assert.equal(lossy, true);
    assert.match(warnings.join('\n'), /hiddenMembers/);
  });

  test('a prototype-polluting settings key is refused', () => {
    const b = { ...base(), settings: JSON.parse('{"mode":"rolling","__proto__":{"x":1}}') };
    const { ops, warnings } = migrateV1(b, CTX);
    const pref = ops.find((o) => o.k === 'pref.set');
    assert.equal(pref.f.__proto__, Object.prototype.__proto__ === undefined ? undefined : pref.f.__proto__);
    assert.equal(Object.prototype.hasOwnProperty.call(pref.f, '__proto__'), false);
    assert.equal(({}).x, undefined, 'nothing was written to Object.prototype');
    assert.ok(Array.isArray(warnings));
  });

  test('a board with no settings emits no pref op', () => {
    const { ops, warnings } = migrateV1({ ...base(), settings: {} }, CTX);
    assert.equal(ops.filter((o) => o.k === 'pref.set').length, 0);
    assert.match(warnings.join('\n'), /no settings/);
    // an op that writes nothing is malformed (`validateOp`), so emitting one would throw
    assert.ok(ops.every((o) => Object.keys(o.f).length > 0));
  });

  test('a nested-array entry inside notes is skipped, not crashed on', () => {
    const b = { ...base(), notes: ['string', 42, null, ['x'], { id: 'ok', date: '2026-01-01', text: 'y', categoryId: 'c1' }] };
    const { ops, lossy } = migrateV1(b, CTX);
    assert.deepEqual(ops.filter((o) => o.k === 'note.set').map((o) => o.e), ['note:ok']);
    assert.equal(lossy, true);
  });

  test('every hostile board still produces ops the real validator admits', () => {
    const boards = [
      { ...base(), notes: 'nope' },
      { ...base(), notes: [{ id: 'n1', date: '2026-01-01', text: 'x'.repeat(300), categoryId: 'c1' }] },
      { ...base(), scratchpads: { bad: 'x' } },
      { ...base(), settings: { a: [1, 2], b: 'ok' } },
      {},
      v1Migrate({}),
    ];
    for (const b of boards) {
      for (const op of migrateV1(b, CTX).ops) {
        assert.deepEqual(classifyOp(op, { nowMs: Date.now() }), { status: 'admit' }, `${op.k} ${op.e} in ${j(b).slice(0, 60)}`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('idempotence (ADR 001 §8.4)', () => {
  test('a board already at schemaVersion 2 is refused, loudly', () => {
    // Re-running migration would re-stamp every field at GENESIS — i.e. at a stamp BELOW every
    // edit made since — so the ops would apply and change nothing, except for fields the user
    // has since deleted. Silence here would be the worst possible behaviour.
    assert.throws(() => migrateV1({ ...richBoard(), schemaVersion: 2 }, CTX), MigrationError);
    assert.throws(() => migrateV1({ ...richBoard(), schemaVersion: 7 }, CTX), MigrationError);
    assert.throws(() => migrateV1({ ...richBoard(), schemaVersion: '1' }, CTX), MigrationError);
    assert.equal(SCHEMA_VERSION_V2, 2);
  });

  test('schemaVersion 0, 1 and absent all migrate', () => {
    for (const sv of [0, 1, undefined, null]) {
      const b = richBoard();
      if (sv === undefined) delete b.schemaVersion; else b.schemaVersion = sv;
      assert.ok(migrateV1(b, CTX).ops.length > 0, j(sv));
    }
  });

  test('shouldMigrate keys off BOTH halves of the predicate', () => {
    const b = richBoard();
    assert.deepEqual(shouldMigrate(b, { opsLogExists: false }).migrate, true);
    assert.deepEqual(shouldMigrate(b, { opsLogExists: true }).migrate, false);
    assert.match(shouldMigrate(b, { opsLogExists: true }).reason, /op log already exists/);
    assert.deepEqual(shouldMigrate({ ...b, schemaVersion: 2 }, { opsLogExists: false }).migrate, false);
    assert.deepEqual(shouldMigrate({}, { opsLogExists: false }).migrate, true);
    assert.deepEqual(shouldMigrate(null, { opsLogExists: false }).migrate, false);
  });

  test('shouldMigrate refuses to answer without the op-log half', () => {
    // The version half alone is the bug: a board whose schemaVersion write failed after the ops
    // were appended would migrate a second time and lose everything written since.
    assert.throws(() => shouldMigrate(richBoard(), {}), MigrationError);
    assert.throws(() => shouldMigrate(richBoard(), undefined), MigrationError);
    assert.throws(() => shouldMigrate(richBoard(), { opsLogExists: 'no' }), MigrationError);
  });

  test('folding the migration twice is a no-op — the ops themselves are idempotent', () => {
    const ops = migrateV1(richBoard(), CTX).ops;
    const once = fold(ops);
    const twice = fold(ops, fold(ops));
    assert.deepEqual(regsToPlain(once), regsToPlain(twice));
    assert.deepEqual(materializeSolo(once), materializeSolo(twice));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the reference fold used above is itself a CRDT', () => {
  // If the reference fold were order-dependent, every convergence test above would be vacuous.
  const ops = migrateV1(richBoard(), CTX).ops;

  test('commutative over 100 permutations', () => {
    const gold = regsToPlain(fold(ops));
    for (let seed = 500; seed < 600; seed++) {
      assert.deepEqual(regsToPlain(fold(shuffled(ops, seed))), gold, `seed ${seed}`);
    }
  });

  test('idempotent and associative', () => {
    const gold = regsToPlain(fold(ops));
    assert.deepEqual(regsToPlain(fold(ops, fold(ops))), gold);
    const [a, b, c] = [ops.slice(0, 2), ops.slice(2, 5), ops.slice(5)];
    assert.deepEqual(regsToPlain(fold(c, fold(b, fold(a)))), gold);
    assert.deepEqual(regsToPlain(fold(a, fold(c, fold(b)))), gold);
  });

  test('greatest stamp wins, and a null register is a cleared register', () => {
    const mk = (ts, f) => ({ v: 1, id: 'x'.repeat(22), ts, space: PERSONAL_PLACEHOLDER, act: ME, dev: MAC_A, gid: 'y'.repeat(22), k: 'note.set', e: 'note:n1', f });
    const regs = fold([mk(GENESIS(0), { text: 'alt' }), mk(GENESIS(1), { text: 'neu' })]);
    assert.equal(regs.get('note:n1').get('text').value, 'neu');
    const cleared = fold([mk(GENESIS(0), { text: 'alt' }), mk(GENESIS(1), { text: null })]);
    assert.equal(cleared.get('note:n1').get('text').value, null);
    const projected = materializeSolo(fold([mk(GENESIS(0), { date: '2026-01-01', text: 'alt', _alive: true }), mk(GENESIS(1), { text: null })]));
    assert.deepEqual(projected.notes, [], 'a cleared text is absent, so the note is not renderable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('P8 against the REAL registers.js and materialize.js', () => {
  // The reference fold and reference materializer above pin ADR 001 §5 and §6 independently of
  // whatever the production modules currently do — which is the point of having them. These four
  // tests point the same property at the production path, so that the day `registers.js` or
  // `materialize.js` changes a rule, LZP-403 finds out here rather than on a user's board.
  //
  // If this block ever goes red while the reference block above stays green, the disagreement is
  // real and one of the two is wrong. Do not delete this block to make it quiet.

  const realRoundTrip = (raw, ctx = CTX) => {
    const { ops } = migrateV1(clone(raw), ctx);
    return { ops, state: realStrip(realMaterialize(realFold(ops), { me: ctx.memberId })) };
  };
  /** materialize() decorates (§5 step 4); strip those too before comparing to a v1 entry. */
  const DECORATIONS = ['ownerId', 'isForeign', 'level', 'memberColorRef', 'initial', 'redacted',
    'createdAt', 'updatedAt', 'updatedBy', 'isNew', 'exposure'];
  const bare = (e) => {
    const o = { ...e };
    for (const f of [...V2_ENTRY_FIELDS, ...DECORATIONS]) delete o[f];
    return o;
  };

  test('the rich board is lossless through the production path too', () => {
    const board = richBoard();
    const before = v1Migrate(board);
    const { state } = realRoundTrip(board);
    assert.deepEqual(state.categories.map(bare), before.categories, 'categories');
    assert.deepEqual(state.notes.map(bare), before.notes, 'notes');
    assert.deepEqual(state.bars.map(bare), before.bars, 'bars — v1 array order (ATT-50/ATT-52)');
    assert.deepEqual(state.scratchpads, sortScratchpads(before.scratchpads), 'scratchpads');
    assert.deepEqual(state.settings, before.settings, 'settings');
  });

  test('the production fold agrees with the reference fold on the same ops', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    const mine = materializeSolo(fold(ops));
    const theirs = realStrip(realMaterialize(realFold(ops), { me: ME }));
    assert.deepEqual(theirs.notes.map(bare), mine.notes.map(bare));
    assert.deepEqual(theirs.bars.map(bare), mine.bars.map(bare));
    assert.deepEqual(theirs.categories.map(bare), mine.categories.map(bare));
    assert.deepEqual(theirs.scratchpads, mine.scratchpads);
  });

  test('the production fold is order-independent on migration ops', () => {
    const { ops } = migrateV1(richBoard(), CTX);
    const gold = j(realMaterialize(realFold(ops), { me: ME }));
    for (let seed = 900; seed < 930; seed++) {
      assert.equal(j(realMaterialize(realFold(shuffled(ops, seed)), { me: ME })), gold, `seed ${seed}`);
    }
  });

  test('an equal-stamp collision is broken by value, not by arrival order', () => {
    // GENESIS encodes an array index, so two migrations of two DIVERGED boards by the same
    // member can produce the same stamp AND the same derived opId with different values. That
    // makes `cmpWrites`'s third key — the value — load-bearing, not decorative.
    const a = richBoard();
    const b = richBoard();
    b.categories[0].name = 'Umbenannt';
    const opsA = migrateV1(a, CTX).ops;
    const opsB = migrateV1(b, CTX).ops;
    const catA = opsA.find((o) => o.e === 'cat:cat-work');
    const catB = opsB.find((o) => o.e === 'cat:cat-work');
    assert.equal(catA.ts, catB.ts);
    assert.equal(catA.id, catB.id, 'stamp AND opId collide — only the value can break this tie');
    assert.equal(
      j(realMaterialize(realFold([...opsA, ...opsB]), { me: ME })),
      j(realMaterialize(realFold([...opsB, ...opsA]), { me: ME })),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE UPGRADE-DAY DEFECTS — ATT-82, ATT-83, ATT-53, and the gate that makes a
// lossy migration impossible to complete in silence.
//
// Every test in this block would FAIL against the code as it was before the fix
// pass; the comment on each says what the old behaviour was.
// ─────────────────────────────────────────────────────────────────────────────
describe('ATT-82 / ATT-83 — a long field must never take the entry with it', () => {
  const withNote = (text) => ({
    schemaVersion: 1,
    notes: [{ id: 'n1', date: '2026-03-04', text, categoryId: 'c1', repeatsYearly: false }],
    bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau', visible: true }],
    scratchpads: {}, settings: { mode: 'rolling' },
  });

  test('ATT-82 — a 140-character note is TRUNCATED and stays on the board (was: it vanished)', () => {
    // OLD BEHAVIOUR: `fieldAccepted` said no, the `text` register was omitted, §5 step 3 found a
    // note with no text, and the note was not in `state.notes` at all. One of the user's entries
    // disappeared from the board on upgrade day, with the original file already replaced.
    const long = 'x'.repeat(140);
    const { ops, lossy, report } = migrateV1(withNote(long), CTX);
    const state = materializeSolo(fold(ops));

    assert.equal(state.notes.length, 1, 'THE NOTE IS STILL THERE');
    assert.equal(state.notes[0].text, 'x'.repeat(80));
    assert.equal(state.notes[0].date, '2026-03-04', 'on its day, in its category');
    assert.equal(state.notes[0].categoryId, 'c1');
    assert.equal(lossy, true, 'the 60 lost characters are still a loss');

    // and the loss is recoverable from the report, not merely announced
    const cut = report.losses.find((l) => l.reason === 'truncated');
    assert.ok(cut, j(report.losses));
    assert.equal(cut.field, 'text');
    assert.equal(cut.kept + cut.dropped, long, 'the report reconstructs the original exactly');
    assert.equal(cut.dropped.length, 60);
  });

  test('ATT-82 — the note v1 shows and the note v2 shows differ only in the tail', () => {
    const long = 'Zahnarzt ' + 'sehr '.repeat(30) + 'spät';
    const before = v1Migrate(clone(withNote(long)));
    const { state } = roundTrip(withNote(long), { ...CTX, acceptLossy: true });
    assert.equal(before.notes[0].text, long, 'v1 loads and renders the whole thing');
    assert.equal(state.notes.length, 1);
    assert.ok(long.startsWith(state.notes[0].text));
    assert.equal(state.notes[0].text.length, 80);
    assert.deepEqual({ ...state.notes[0], text: long }, before.notes[0], 'every other field is identical');
  });

  test('ATT-82 — the cut is at the limit ops.js declares, discovered and not written down here', () => {
    for (const n of [80, 81, 120, 500, 5000]) {
      const { ops } = migrateV1(withNote('y'.repeat(n)), CTX);
      const text = ops.find((o) => o.k === 'note.set').f.text;
      assert.equal(text.length, Math.min(n, 80), `${n} characters`);
      assert.equal(FIELDS.note.text.t, 'str80', 'the limit is the declared one');
    }
  });

  test('ATT-82 — an emoji is never cut in half', () => {
    // 'a'*79 + '😀' is 81 UTF-16 units; slicing at 80 would leave a lone high surrogate, which is
    // not a character but a rendering artefact the user would have to delete by hand.
    const text = 'a'.repeat(79) + '\u{1F600}';
    assert.equal(text.length, 81);
    const out = migrateV1(withNote(text), CTX).ops.find((o) => o.k === 'note.set').f.text;
    assert.equal(out, 'a'.repeat(79), 'the whole emoji went, not half of it');
    assert.equal([...out].length, out.length, 'no lone surrogate survived');
  });

  test('ATT-82 — truncation is deterministic, so two Macs truncate identically (R12)', () => {
    const b = () => withNote('ü'.repeat(200));
    assert.equal(j(migrateV1(b(), CTX).ops), j(migrateV1(b(), CTX).ops));
    const { dev: _a, act: _b, ...one } = migrateV1(b(), CTX).ops[1];
    const { dev: _c, act: _d, ...two } = migrateV1(b(), CTX_B).ops[1];
    assert.deepEqual(two, one);
  });

  test('ATT-83 — a 90-character bar label is truncated to 40; the bar keeps its name', () => {
    // OLD BEHAVIOUR: the label register was dropped and the bar survived UNNAMED — a silent
    // partial loss, and the one field that tells the user what the bar is.
    const b = {
      schemaVersion: 1, notes: [],
      bars: [{ id: 'b1', startDate: '2026-03-01', endDate: '2026-03-10', label: 'y'.repeat(90), categoryId: 'c1' }],
      categories: [{ id: 'c1', name: 'A', paletteRef: 'blau', visible: true }],
      scratchpads: {}, settings: { mode: 'rolling' },
    };
    const { ops, lossy, report } = migrateV1(b, CTX);
    const state = materializeSolo(fold(ops));
    assert.equal(state.bars.length, 1);
    assert.equal(state.bars[0].label, 'y'.repeat(40), 'named, not blank');
    assert.equal(lossy, true);
    const cut = report.losses.find((l) => l.field === 'label');
    assert.equal(cut.kept.length + cut.dropped.length, 90);
  });

  test('ATT-82/83 — a TEXT value that is not a string is kept as v1 paints it, never dropped', () => {
    const b = {
      schemaVersion: 1,
      notes: [{ id: 'n1', date: '2026-03-04', text: 42, categoryId: 'c1' }],
      bars: [{ id: 'b1', startDate: '2026-03-01', endDate: '2026-03-10', label: { s: 1 }, categoryId: 'c1' }],
      categories: [{ id: 'c1', name: 'A', paletteRef: 'blau', visible: true }],
      scratchpads: {}, settings: {},
    };
    // INVERTED (REG-5). This asserted that `text: 42` was DROPPED — and dropping `text` makes the
    // note unrenderable (ADR 001 §5 step 3), so the note left the board and the next export
    // entirely. That is verbatim the disaster ATT-82's own comment says it exists to prevent:
    // "the user's note did not get shorter on upgrade day, it disappeared." v1 keeps and paints
    // all of these through one expression, `popover.js:193`'s `n.text || '…'`, and
    // `coerceToV1Text` is that expression and nothing more.
    const { ops, report } = migrateV1(b, CTX);
    assert.equal(ops.find((o) => o.k === 'note.set').f.text, '42', 'what v1 paints in the cell');
    assert.equal(ops.find((o) => o.k === 'bar.set').f.label, '[object Object]',
      'faithful rather than tidy — it is what v1 puts on the bar');
    assert.deepEqual(report.losses.filter((l) => l.field).map((l) => [l.field, l.reason]),
      [['text', 'coerced'], ['label', 'coerced']], j(report.losses));
    // Still a LOSS, and the original is recoverable: the report carries the value that was in the
    // file, so „nichts geht verloren" survives the one case the register cannot hold.
    assert.equal(report.losses.find((l) => l.field === 'text').value, 42);
    assert.deepEqual(report.losses.find((l) => l.field === 'label').value, { s: 1 });

    // The entry is on the board — the whole point.
    const st = materializeSolo(fold(ops));
    assert.equal(st.notes.length, 1);
    assert.equal(st.notes[0].date, '2026-03-04');
    assert.equal(st.bars.length, 1);
  });

  test('ATT-82/83 — but a NULL is still a value, except where it would cost the entry', () => {
    // The line between this and the test above, asserted so neither half can drift.
    //
    // `null` is a first-class register value (ADR 001 §2) and a hand-edited one is carried to the
    // log verbatim — asserted at length by "an explicit null in the FILE is carried as a null
    // register" above, and that decision stands. The exception is the field where carrying it
    // costs the whole entry: `materialize` skips a cleared register, so a null `note.text` fails
    // renderability and the note leaves the board (REG-6). Which fields those are is PROBED from
    // the real `renderable()`, not listed, so §5 step 3 cannot change out from under it.
    const b = {
      schemaVersion: 1,
      notes: [{ id: 'n1', date: '2026-03-04', text: null, categoryId: 'c1' }],
      bars: [{ id: 'b1', startDate: '2026-03-01', endDate: '2026-03-10', label: null, categoryId: 'c1' }],
      categories: [{ id: 'c1', name: 'A', nameEn: null, paletteRef: 'blau', visible: true }],
      scratchpads: {}, settings: {},
    };
    const { ops } = migrateV1(b, CTX);
    assert.equal(ops.find((o) => o.k === 'note.set').f.text, '',
      'the ONE field whose null costs the entry — and `\'\'` is what ATT-53 already gives an ABSENT text');
    assert.equal(ops.find((o) => o.k === 'bar.set').f.label, null,
      'a bar renders without a label, so its null is carried like any other value');
    assert.equal(ops.find((o) => o.k === 'cat.set').f.nameEn, null, 'and so is a category\'s');

    const st = materializeSolo(fold(ops));
    assert.equal(st.notes.length, 1, 'the note is on the board, where v1 draws it as „…"');
    assert.equal(st.notes[0].text, '');
    assert.equal(st.bars.length, 1);
  });

  test('ATT-82 — a malformed DATE is NOT "truncated" into a plausible one', () => {
    // The longest accepted prefix of '2026-01-01T09:00' is '2026-01-01'. Inventing a date the
    // user never wrote is worse than dropping a value: only str40/str80 fields are truncatable.
    const b = {
      schemaVersion: 1,
      notes: [{ id: 'n1', date: '2026-01-01T09:00', text: 'x', categoryId: 'c1' }],
      bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau', visible: true }],
      scratchpads: {}, settings: {},
    };
    const { ops, report } = migrateV1(b, CTX);
    assert.equal(ops.find((o) => o.k === 'note.set').f.date, undefined);
    assert.equal(report.losses[0].reason, 'dropped');
  });

  test('ATT-53 — a note with NO text key migrates as \'\', so v1’s rendering is preserved', () => {
    // OLD BEHAVIOUR: absent stayed absent, §5 step 3 called the note unrenderable and dropped it.
    // v1 renders it — `popover.js:193` is `n.text || '…'`, which is also what it renders for '',
    // so '' is not an invention: it is the value that makes the two builds draw the same row.
    const b = {
      schemaVersion: 1,
      notes: [{ id: 'n1', date: '2026-03-04', categoryId: 'c1', repeatsYearly: false }],
      bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau', visible: true }],
      scratchpads: {}, settings: { mode: 'rolling' },
    };
    const { ops, lossy } = migrateV1(clone(b), CTX);
    assert.equal(ops.find((o) => o.k === 'note.set').f.text, '');
    assert.equal(lossy, false, 'nothing was lost — an absent text is not a loss');
    const state = materializeSolo(fold(ops));
    assert.equal(state.notes.length, 1, 'the note is on the board, as it is in v1');
    assert.equal(state.notes[0].text, '');
    assert.equal(v1Migrate(clone(b)).notes.length, 1);
  });

  test('ATT-53 — every OTHER absent field still stays absent', () => {
    const b = {
      schemaVersion: 1,
      notes: [{ id: 'n1', date: '2026-03-04', text: 'x' }],       // no categoryId, no repeatsYearly
      bars: [{ id: 'b1', startDate: '2026-03-01', endDate: '2026-03-02' }],   // no label
      categories: [{ id: 'c1', name: 'A', paletteRef: 'blau' }],  // no nameEn, no visible
      scratchpads: {}, settings: {},
    };
    const { ops } = migrateV1(b, CTX);
    const has = (k, name) => Object.prototype.hasOwnProperty.call(ops.find((o) => o.k === k).f, name);
    assert.equal(has('note.set', 'categoryId'), false);
    assert.equal(has('note.set', 'repeatsYearly'), false);
    assert.equal(has('bar.set', 'label'), false, 'a bar with no label is renderable — leave it absent');
    assert.equal(has('cat.set', 'nameEn'), false);
    assert.equal(has('cat.set', 'visible'), false);
  });
});

describe('ATT-82 — a lossy migration may not complete in silence', () => {
  const lossyBoard = () => ({
    schemaVersion: 1,
    notes: [{ id: 'n1', date: '2026-03-04', text: 'x'.repeat(140), categoryId: 'c1' }],
    bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau', visible: true }],
    scratchpads: {}, settings: { mode: 'rolling' },
  });

  test('a store that ignores `lossy` gets a THROW, not a quietly shortened board', () => {
    // `const { ops } = migrateV1(board, ctx)` is the shortest thing a store can write and the
    // thing a store WILL write. A boolean nobody is obliged to read is not a safety mechanism.
    assert.throws(() => migrateV1(lossyBoard(), CTX_STRICT), MigrationLossyError);
    assert.throws(() => migrateV1(lossyBoard(), CTX_STRICT), MigrationError, 'and it is a MigrationError');
  });

  test('…and the throw discards NOTHING — the whole result is on error.result', () => {
    // Refusing to open the user's board would be worse than opening it with a warning. This
    // refuses to open it QUIETLY: a caller that catches still has every op.
    let err = null;
    try { migrateV1(lossyBoard(), CTX_STRICT); } catch (e) { err = e; }
    assert.ok(err instanceof MigrationLossyError);
    assert.equal(err.result.ops.length, migrateV1(lossyBoard(), CTX).ops.length);
    assert.equal(j(err.result.ops), j(migrateV1(lossyBoard(), CTX).ops), 'byte-identical to the accepted run');
    assert.equal(err.result.lossy, true);
    assert.ok(err.report.losses.length >= 1);
    assert.match(err.message, /error\.result/);
    assert.equal(materializeSolo(fold(err.result.ops)).notes.length, 1, 'the board opens from the error');
  });

  test('ctx.onLossy receives the report and the call returns normally', () => {
    const seen = [];
    const r = migrateV1(lossyBoard(), { memberId: ME, deviceId: MAC_A, onLossy: (rep) => seen.push(rep) });
    assert.equal(seen.length, 1, 'called exactly once');
    assert.equal(seen[0], r.report);
    assert.equal(seen[0].losses[0].reason, 'truncated');
    assert.equal(seen[0].warnings, r.warnings);
  });

  test('onLossy is NOT called when nothing was lost', () => {
    let calls = 0;
    const clean = { schemaVersion: 1, notes: [], bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau', visible: true }], scratchpads: {}, settings: { mode: 'rolling' } };
    const r = migrateV1(clean, { memberId: ME, deviceId: MAC_A, onLossy: () => { calls += 1; } });
    assert.equal(calls, 0);
    assert.equal(r.lossy, false);
    assert.equal(r.report.losses.length, 0);
  });

  test('a REPAIR is not a loss: a repaired board returns normally to an unacknowledged caller', () => {
    // The gate is about the user losing something, not about the migration doing work. A
    // re-keyed duplicate, a back-filled paletteRef and the four substituted defaults all leave
    // the user with everything they had, so they must not make the migration refuse to complete.
    const repaired = {
      schemaVersion: 1,
      notes: [{ id: 'dup', date: '2026-01-01', text: 'a', categoryId: 'c1' }, { id: 'dup', date: '2026-02-01', text: 'b', categoryId: 'c1' }],
      bars: [], categories: [{ id: 'c1', name: 'A' }], scratchpads: {},
      settings: { lastCategoryId: 'ghost', bundesland: '', layers: { schulferien: true } },
    };
    const r = migrateV1(repaired, CTX_STRICT);
    assert.equal(r.lossy, false);
    assert.ok(r.report.repairs.length >= 4, j(r.report.repairs.map((x) => x.what)));
    assert.deepEqual(
      [...new Set(r.report.repairs.map((x) => x.what))].sort(),
      ['lastCategoryId', 'paletteRef', 'rekeyed', 'schulferien'],
    );
  });

  test('ctx.onLossy and ctx.acceptLossy are validated like every other ctx field', () => {
    assert.throws(() => migrateV1(lossyBoard(), { ...CTX_STRICT, onLossy: 'yes' }), MigrationError);
    assert.throws(() => migrateV1(lossyBoard(), { ...CTX_STRICT, acceptLossy: 'yes' }), MigrationError);
  });

  test('`lossy` and `report.losses` can never disagree — every lossy path records one', () => {
    // The error message counts `report.losses`, and a store showing the user a list reads it. A
    // path that set the flag without recording the loss would produce "0 losses" on a board that
    // lost something, which is worse than either half alone.
    const boards = [
      { notes: 'nope', bars: [], categories: [], scratchpads: {}, settings: {} },
      { notes: [{ id: 'n1', date: '2026-01-01', text: 'x'.repeat(99), categoryId: 'c1' }], bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau' }], scratchpads: {}, settings: {} },
      { notes: [{ date: '2026-01-01', text: 'no id' }], bars: [], categories: [], scratchpads: {}, settings: {} },
      { notes: [], bars: [], categories: [], scratchpads: { nope: 'x', '2026-01': 42 }, settings: {} },
      { notes: [], bars: [], categories: [], scratchpads: {}, settings: { a: [1, 2] } },
      { notes: [{ id: 'n1', text: 'kein Datum', categoryId: 'c1' }], bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau' }], scratchpads: {}, settings: {} },
      { notes: [{ id: 'n1', date: '2026-01-01', text: 'x', categoryId: 'c1', colour: '#f00' }], bars: [], categories: [{ id: 'c1', name: 'A', paletteRef: 'blau' }], scratchpads: {}, settings: {} },
      { notes: ['not an object'], bars: [], categories: [], scratchpads: {}, settings: {} },
    ];
    for (const b of boards) {
      const r = migrateV1(b, CTX);
      assert.equal(r.lossy, r.report.losses.length > 0, j(b).slice(0, 70));
      assert.ok(r.report.losses.every((l) => typeof l.reason === 'string' && typeof l.where === 'string'), j(r.report.losses));
    }
  });

  test('the report is deterministic — it is part of what two Macs must agree on', () => {
    const a = migrateV1(lossyBoard(), CTX).report;
    const b = migrateV1(lossyBoard(), CTX_B).report;
    assert.equal(j(a), j(b));
  });
});

describe('M1 — the scratchpad key order may not reach the ops', () => {
  const padBoard = (pads) => ({
    schemaVersion: 1, notes: [], bars: [],
    categories: [{ id: 'c1', name: 'A', paletteRef: 'blau', visible: true }],
    scratchpads: pads, settings: { mode: 'rolling' },
  });

  test('reordering the scratchpads object changes NOTHING (was: different stamps and op ids)', () => {
    // OLD BEHAVIOUR: `Object.keys(pads)` is the parsed file's own order and it fed the global
    // index counter, so the same three pads written in a different order produced different
    // `_born` stamps AND different derived op ids — ADR 001 §8.1 property 2 broken by an editor
    // round-trip, a re-export, or any whole-file rewrite.
    const a = migrateV1(padBoard({ '2026-03': 'Milch', '2026-04': 'Brot', '2026-05': 'Käse' }), CTX);
    const b = migrateV1(padBoard({ '2026-05': 'Käse', '2026-03': 'Milch', '2026-04': 'Brot' }), CTX);
    assert.equal(j(a.ops), j(b.ops), 'byte-identical');
    assert.deepEqual(a.ops.filter((o) => o.k === 'pad.set').map((o) => o.e),
      ['pad:2026-03', 'pad:2026-04', 'pad:2026-05'], 'and the counter walks them in key order');
  });

  test('every permutation of the same pads migrates to the same bytes', () => {
    const keys = ['2026-01', '2026-02', '2026-03', '2026-12'];
    const gold = j(migrateV1(padBoard(Object.fromEntries(keys.map((k) => [k, `t${k}`]))), CTX).ops);
    for (let seed = 1; seed <= 40; seed++) {
      const order = shuffled(keys, seed);
      const pads = Object.fromEntries(order.map((k) => [k, `t${k}`]));
      assert.equal(j(migrateV1(padBoard(pads), CTX).ops), gold, `order ${order.join(',')}`);
    }
  });

  test('a JSON round trip of a board whose pads are out of order changes nothing', () => {
    const b = padBoard({ '2026-12': 'z', '2026-01': 'a' });
    assert.equal(j(migrateV1(b, CTX).ops), j(migrateV1(JSON.parse(JSON.stringify(b)), CTX).ops));
  });
});

describe('ATT-101 — snapshots.json stays in the v1 shape (ADR 001 §8.4)', () => {
  /** What `store.js:229` will hold once the board is register-backed: a MATERIALIZED v2 state. */
  const v2State = () => realMaterialize(realFold(migrateV1({
    schemaVersion: 1,
    notes: [{ id: 'n1', date: '2026-03-04', text: 'a', categoryId: 'c1', repeatsYearly: false }],
    bars: [{ id: 'b1', startDate: '2026-03-01', endDate: '2026-03-05', label: 'x', categoryId: 'c1' }],
    categories: [{ id: 'c1', name: 'A', paletteRef: 'blau', visible: true }],
    scratchpads: { '2026-03': 'Milch' }, settings: { mode: 'rolling' },
  }, CTX).ops), { me: ME, defaultSettings: defaultState().settings });

  test('toV1Snapshot gives the shape 11.5’s restore UI and a v1 build both read', () => {
    // §8.4 promises snapshots.json "stays BYTE-IDENTICAL in the v1 shape". Nothing enforced it:
    // `rollSnapshot` clones the state, and from the first v2 launch that state carries `_born`,
    // `ownerId`, `visibility`, `updatedBy`, `entityKey` and `schemaVersion: 2` on every entry.
    const snap = toV1Snapshot(v2State());
    assert.equal(snap.schemaVersion, 1);
    assert.deepEqual(v1ShapeViolations(snap), [], 'v1-shaped by its own predicate');
    for (const entry of [...snap.notes, ...snap.bars, ...snap.categories]) {
      for (const leak of ['_born', 'entityKey', 'ownerId', 'createdAt', 'updatedAt', 'updatedBy', 'visibility', 'coEdit', 'isForeign', 'defaultVisibility']) {
        assert.equal(leak in entry, false, `${leak} leaked into a snapshot`);
      }
    }
    assert.deepEqual(Object.keys(snap.notes[0]).sort(), ['categoryId', 'date', 'id', 'repeatsYearly', 'text']);
    assert.deepEqual(Object.keys(snap).sort(), ['bars', 'categories', 'notes', 'scratchpads', 'schemaVersion', 'settings'].sort());
  });

  test('a v1 snapshot restores through migrateV1 unchanged — the safety net still works', () => {
    const snap = toV1Snapshot(v2State());
    const { ops, lossy } = migrateV1(clone(snap), CTX);
    assert.equal(lossy, false, 'a snapshot this app wrote must migrate without loss');
    assert.deepEqual(materializeSolo(fold(ops)).notes.map((n) => n.text), ['a']);
  });

  test('v1ShapeViolations NAMES a v2-shaped snapshot instead of letting it through', () => {
    const bad = v1ShapeViolations(v2State());
    assert.ok(bad.length >= 2, j(bad));
    assert.match(bad[0], /schemaVersion is 2, not 1/);
    assert.match(bad.join('\n'), /_born/);
  });

  test('migrateSnapshots reports a snapshots.json already written in the v2 shape', () => {
    const out = migrateSnapshots([{ day: '2026-08-25', at: 'x', state: v2State() }]);
    assert.equal(out.snapshots[0].state.notes[0]._born !== undefined, true, 'still returned untouched');
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /not in the v1 shape/);
    assert.match(out.warnings[0], /toV1Snapshot/);
  });

  test('a v1-shaped snapshots.json is still silent — no new noise for the common case', () => {
    const out = migrateSnapshots([{ day: '2026-08-25', at: 'x', state: toV1Snapshot(v2State()) }]);
    assert.deepEqual(out.warnings, []);
  });

  test('toV1Snapshot refuses anything that is not a board', () => {
    for (const bad of [null, 42, 'x', {}, { notes: [], bars: [] }]) {
      assert.throws(() => toV1Snapshot(bad), MigrationError, j(bad));
    }
  });
});

describe('R12 over the generated corpus — the property, with two DIFFERENT members (M2)', () => {
  // The property suite runs this with ONE member id on both Macs, which is the case that was
  // already true. M2 is about the case the product actually ships: solo mode has no minted
  // MemberId, so my two Macs hold different placeholders until they pair.
  const CORPUS = 300;

  test(`two Macs with different memberIds AND deviceIds migrate byte-identically, ${CORPUS} boards`, () => {
    for (let seed = 1; seed <= CORPUS; seed++) {
      const b = generateBoard(seed, { defaults: defaultState() });
      const a = migrateV1(clone(b), { memberId: ME, deviceId: MAC_A, acceptLossy: true }).ops;
      const c = migrateV1(clone(b), { memberId: OTHER_MEMBER, deviceId: MAC_B, acceptLossy: true }).ops;
      assert.equal(a.length, c.length, `seed ${seed}`);
      for (let i = 0; i < a.length; i++) {
        const { act: _a1, dev: _d1, ...restA } = a[i];
        const { act: _a2, dev: _d2, ...restC } = c[i];
        assert.deepEqual(restC, restA, `seed ${seed}, op ${i} (${a[i].e})`);
      }
      // …so pairing the two migrated Macs converges to the one board, with no doubling.
      const merged = realFold([...a, ...c]);
      assert.equal(merged.size, realFold(a).size, `seed ${seed}: the join doubled an entity`);
    }
  });

  test(`the generated corpus migrates without loss, ${CORPUS} boards`, () => {
    // If a board out of the corpus were lossy, the byte-identity assertion above would be
    // passing on the wrong thing (two identically DAMAGED migrations).
    for (let seed = 1; seed <= CORPUS; seed++) {
      const r = migrateV1(generateBoard(seed, { defaults: defaultState() }), CTX_STRICT);
      assert.equal(r.lossy, false, `seed ${seed}: ${r.warnings.join(' | ')}`);
    }
  });
});
