// tests/helpers/domains.js — THE INPUT DOMAINS OF THE HISTORY LAYER, WRITTEN DOWN AS DATA.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
//
// Five rounds of adversaries each RELOCATED the same failure rather than closing it, and round 6
// said why in one sentence:
//
//   > The fixes are still being chosen a branch at a time, and the branch is chosen before the
//   > input domain is written down. R6-5a is the sharpest instance: round 5 replaced "is raw
//   > null?" with a careful five-way classifier and wrote out four of the five kinds in a
//   > docblock — and `''` still went to the wrong one, because the enumeration was of BRANCHES
//   > (ok/absent/unparseable/not-a-board/read-failed) rather than of BYTES.
//
// An enumeration of BRANCHES is a description of the code that exists. An enumeration of INPUTS
// is a description of the world, and the world does not shrink when someone adds an `else if`.
// So this file enumerates INPUTS — every distinguishable one — and states, per input, the
// behaviour that is REQUIRED. Not the behaviour that is implemented. Several of the `expect`
// values below are, today, wrong about this build; that is the point, and `openFinding` names
// the round-6 row that predicted each one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTRACT OF AN ENTRY
//
//   { id, value, label, expect, openFinding, note? }
//
//   id            stable, unique across the whole file. Quote it in a fix, in a commit, in a row.
//   value         THE INPUT. Data, never a closure — except where a value is measured in tens of
//                 megabytes, which is built by a memoising getter so that `label` stays cheap.
//   label         one line a human can read in a failure report.
//   expect        THE REQUIRED BEHAVIOUR. Its shape is fixed per domain and documented at the
//                 head of that domain. Never the current behaviour.
//   openFinding   the finding id that predicts this entry FAILS today, or null when the entry is
//                 expected to hold. A null here that fails is NEWS: it is a regression, not a
//                 known gap. `tests/property/domains.test.js` reports the two separately.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ZERO DEPENDENCIES. NO WALL CLOCK IN A VALUE. Every stamp in D2 is expressed as an OFFSET from
// the machine clock, resolved by the reader at probe time — a domain member that hard-coded a
// millisecond would stop meaning "23 h 59 m from now" the moment it was written down.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Freeze a literal all the way down, WITHOUT rewriting it. An entry that carries a getter (the
 * 50 MB board, and the cross products that forward to it) keeps the getter; an object that is
 * already frozen — the shared `OK` / `UNREADABLE(…)` expectations — is left exactly as it is
 * rather than being copied, so two entries that share an expectation still share it and a
 * mutation test that edits one edits both.
 */
const deep = (x) => {
  if (Array.isArray(x)) return Object.freeze(x.map(deep));
  if (!x || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.getOwnPropertyNames(x)) {
    const d = Object.getOwnPropertyDescriptor(x, k);
    if (d && 'value' in d && d.writable) x[k] = deep(d.value);
  }
  return Object.freeze(x);
};

export const S = 1000;
export const MIN = 60 * S;
export const H = 60 * MIN;
export const DAY = 24 * H;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D1 — `board.json` AS BYTES
//
// The gate: `storage.loadBoardFile()` answers one of four STATUSES, `store.classifyBoardFile()`
// turns that plus the parse into one of five KINDS, and `init()` branches on the kind. Exactly
// one kind — `absent` — may hand the board to an op log it cannot tie to that board (ADR 006
// §5.5); three of them must put the session READ-ONLY (§5.6); one of them is the ordinary launch.
//
// Round 6 found two holes here ON OPPOSITE SIDES OF THE SAME GATE — `''` fell off the `absent`
// side (R6-5a) and `{}` fell off the `ok` side (R6-5c) — which is why this domain is enumerated
// over BYTES and over the two places bytes can come from, and not over the five kinds.
//
// THE REQUIRED RULE, IN ONE SENTENCE, WITH NO EXCEPTIONS:
//
//     The BYTES decide. If any byte string reached the reader — from the native store or from
//     the localStorage fallback, of any length INCLUDING ZERO — the file is `ok` when
//     `JSON.parse` succeeds AND the result is a board, `not-a-board` when it succeeds and the
//     result is not, and `unparseable` otherwise. `absent` means NO BYTE STRING EXISTED IN
//     EITHER STORE and nothing threw. `read-failed` means no byte string existed and something
//     threw. There is no fifth way to be absent.
//
// and the second half of it, which is what the rule is FOR:
//
//     `absent` is the only kind that may adopt a log. `ok` and `absent` are the only kinds that
//     may write. A zero-byte file is not absent, and an object with none of a board's
//     collections is not a board.
//
// expect = {
//   status   'ok'|'absent'|'unparseable'|'read-failed'   what `loadBoardFile()` must answer
//   kind     status + 'not-a-board'                       what `classifyBoardFile()` must answer
//   mayWrite boolean    may this session commit anything to board.json?
//   adoptsLog boolean   may an op log lying beside it become the board? (`_recoveredFrom.from`)
//   showsSnapshot boolean  must the newest usable snapshots.json entry stand in on screen?
// }
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** `ok`: readable, writable, never a log recovery. */
const OK = { status: 'ok', kind: 'ok', mayWrite: true, adoptsLog: false, showsSnapshot: false };
/**
 * The three §5.6 kinds: the board EXISTS and this app cannot see it. Read-only, snapshot, no log.
 *
 * `status` AND `kind` ARE TWO ALPHABETS AND THIS IS WHERE THEY MEET. `loadBoardFile()` answers
 * four statuses and has no opinion about whether a parsed object is a board; `classifyBoardFile()`
 * answers five kinds and adds exactly that opinion. So every `not-a-board` row carries
 * `status: 'ok'` — the bytes DID parse — and `kind: 'not-a-board'`. Collapsing the two is the
 * same category error as collapsing branches into bytes, one layer up.
 */
const UNREADABLE = (kind) => ({
  status: kind === 'not-a-board' ? 'ok' : kind,
  kind,
  mayWrite: false, adoptsLog: false, showsSnapshot: true,
});
/** `absent`: no bytes anywhere, nothing threw. The ONE kind that may believe a log. */
const ABSENT = { status: 'absent', kind: 'absent', mayWrite: true, adoptsLog: true, showsSnapshot: false };

/** A valid v1 board, as v1 wrote it. Built here rather than imported so this file stays a leaf. */
export const V1_BOARD_TEXT = JSON.stringify({
  schemaVersion: 1,
  notes: [
    { id: 'n1', date: '2026-03-04', text: 'Zahnarzt', categoryId: 'cat-arbeit', repeatsYearly: false },
    { id: 'n2', date: '2026-04-01', text: 'Steuer', categoryId: 'cat-arbeit', repeatsYearly: false },
  ],
  bars: [],
  categories: [{ id: 'cat-arbeit', name: 'Arbeit', color: '#c00' }],
  scratchpads: {},
  settings: { startMonth: '2026-01', mode: 'pinned', lastCategoryId: 'cat-arbeit' },
}, null, 2);

/** The same board with ADR 006 §4.1's one additive key, carrying a well-formed lineage. */
export const V2_BOARD_TEXT = JSON.stringify({
  ...JSON.parse(V1_BOARD_TEXT),
  _v2: { lineageId: 'lin_ZZZZZZZZZZZZZZZZZZZZZZZZZZ', gen: 7 },
}, null, 2);

/** `_v2` present and carrying NO usable lineage — additive key, no binding. Still a board. */
export const V2_NO_LINEAGE_TEXT = JSON.stringify({
  ...JSON.parse(V1_BOARD_TEXT), _v2: { gen: 3 },
}, null, 2);

/** A write that stopped in the middle: real bytes, not JSON. */
export const TRUNCATED_TEXT = V1_BOARD_TEXT.slice(0, 40);

/**
 * FIFTY MEGABYTES OF VALID BOARD. A pasted year of notes into one Notizzettel gets here, and it
 * is the input on which "just re-read it" and "just keep a copy in memory" stop being free.
 * Memoised: it is built at most once per process, and only if something actually asks for it.
 */
export const BIG_BOARD_BYTES = 50 * 1024 * 1024;
let _big = null;
export function bigBoardText() {
  if (_big === null) {
    const b = JSON.parse(V1_BOARD_TEXT);
    b.scratchpads = { '2026-01': 'x'.repeat(BIG_BOARD_BYTES) };
    _big = JSON.stringify(b);
  }
  return _big;
}

/**
 * THE BYTE AXIS. `value` is the exact string the reader finds, or `null` for "this store held
 * nothing", or a `{read}` marker for a store that did not answer at all.
 */
export const D1_BYTES = deep([
  // ── zero and near-zero length: the shapes an interrupted write leaves ───────────────────────
  { id: 'D1-b01', value: '', label: 'ZERO BYTES — the most likely outcome of an interrupted write',
    expect: UNREADABLE('unparseable'), openFinding: null,
    note: 'CLOSED 2026-08-27 (was R6-5a). An empty file is a FILE. `loadBoardFile` tested '
      + '`txt === \'\'` and reported `absent`, so R7 adopted whatever log was beside it and the '
      + 'session then COMMITTED it — A3-C1\'s outcome behind zero bytes instead of one bad byte. '
      + '`loadBoardFile` now decides on the BYTES: any string a store answers with, of any length '
      + 'including zero, is the file\'s bytes; `absent` means NO STORE ANSWERED WITH A STRING. '
      + '→ round6-recovery.test.js R6-5a / R6-5a2.' },
  { id: 'D1-b02', value: ' ', label: 'one space', expect: UNREADABLE('unparseable'), openFinding: null },
  { id: 'D1-b03', value: '\n', label: 'one newline', expect: UNREADABLE('unparseable'), openFinding: null },
  { id: 'D1-b04', value: '\t', label: 'one tab', expect: UNREADABLE('unparseable'), openFinding: null },
  { id: 'D1-b05', value: '﻿' + '{}', label: 'a BOM in front of otherwise valid JSON',
    expect: UNREADABLE('unparseable'), openFinding: null },

  // ── bytes that are not JSON ────────────────────────────────────────────────────────────────
  { id: 'D1-b06', value: TRUNCATED_TEXT, label: 'a TRUNCATED object — the write stopped mid-file',
    expect: UNREADABLE('unparseable'), openFinding: null },
  { id: 'D1-b07', value: '{"notes":[', label: 'a truncated object that ends inside an array',
    expect: UNREADABLE('unparseable'), openFinding: null },
  { id: 'D1-b08', value: V1_BOARD_TEXT + V1_BOARD_TEXT, label: 'two boards concatenated — a doubled write',
    expect: UNREADABLE('unparseable'), openFinding: null },

  // ── valid JSON that is not an object ───────────────────────────────────────────────────────
  { id: 'D1-b09', value: 'null', label: '`null`', expect: UNREADABLE('not-a-board'), openFinding: null },
  { id: 'D1-b10', value: '[]', label: 'an empty array', expect: UNREADABLE('not-a-board'), openFinding: null },
  { id: 'D1-b11', value: '7', label: 'a number', expect: UNREADABLE('not-a-board'), openFinding: null },
  { id: 'D1-b12', value: '"hallo"', label: 'a string', expect: UNREADABLE('not-a-board'), openFinding: null },
  { id: 'D1-b13', value: 'true', label: 'a boolean', expect: UNREADABLE('not-a-board'), openFinding: null },

  // ── valid JSON OBJECTS that are not this app's board ────────────────────────────────────────
  // The line between catastrophe and business-as-usual WAS `Array.isArray`. It is now "does this
  // object carry a board's collections, in a board's shape" (`store.boardKeysOf`) — because with
  // the old rule `{}` meant "the board is authoritatively empty": the user's calendar erased on
  // screen, the session writable, and the log that IS this board's quarantined
  // `board-carries-no-lineage` AND MOVED ASIDE on the same launch. Closed 2026-08-27.
  { id: 'D1-b14', value: '{}', label: 'the empty object — was `ok`, i.e. "the board is authoritatively empty"',
    expect: UNREADABLE('not-a-board'), openFinding: null,
    note: 'CLOSED 2026-08-27 (was R6-5c) by `store.boardKeysOf()`. → round6-recovery R6-5c.' },
  { id: 'D1-b15', value: '{"schemaVersion":1}', label: 'a version and nothing else',
    expect: UNREADABLE('not-a-board'), openFinding: null,
    note: 'CLOSED 2026-08-27 (was R6-5d). A version number is a claim any file can make, so '
      + '`schemaVersion` is deliberately NOT one of `BOARD_SHAPE`\'s keys.' },
  { id: 'D1-b16', value: '{"hello":"welt"}', label: 'some other application\'s JSON',
    expect: UNREADABLE('not-a-board'), openFinding: null,
    note: 'CLOSED 2026-08-27 (was R6-5d). → round6-recovery R6-5d.' },
  { id: 'D1-b17', value: '{"notes":"nicht ein array"}', label: '`notes` present and not an array',
    expect: UNREADABLE('not-a-board'), openFinding: null,
    note: 'CLOSED 2026-08-27 (was R6-5d). THE ROW THAT MAKES THE RULE SHAPE-AWARE: a key that is '
      + 'PRESENT is not evidence, a key that is present AND well-typed is. A rule counting bare '
      + 'key names passes this input and the mutation table would not notice.' },
  { id: 'D1-b18', value: '{"_v2":{"lineageId":"lin_ZZZZZZZZZZZZZZZZZZZZZZZZZZ","gen":1}}',
    label: 'a LINEAGE and nothing else — an object that is only ADR 006\'s envelope',
    expect: UNREADABLE('not-a-board'), openFinding: null,
    note: 'CLOSED 2026-08-27 (was R6-5c; filed against no register row of its own — it needs one). '
      + 'THE SHARPEST MEMBER OF THE `{}` CLASS, AND IT COSTS CONTENT. Measured 2026-08-27 with '
      + 'the victim\'s own lineageId in the envelope: kind `ok`, `quarantine === null`, the log '
      + 'ADOPTED, and the reconciler then mints NINE `{_alive:false}` retractions — because '
      + '"the log has a live entry the board lacks" is an honoured deletion (ADR 006 §5.4) and '
      + 'this "board" lacks all of them. The empty board is committed, the tombstones are '
      + 'committed, and the next launch agrees. Every other row in this domain costs history; '
      + 'this one costs the calendar, and at WP-8 it costs it on every paired device, because '
      + 'what propagates is not a corrupt file but nine well-formed deletes this app minted '
      + 'itself. `Array.isArray` was the whole of the guard standing in front of it; the guard is '
      + 'now `boardKeysOf()`, and `_v2` is deliberately not one of its keys — it is an ADDITIVE '
      + 'key (§4.1) saying which log is bound to a board, not a board. '
      + '→ round6-recovery.test.js R6-5g, which pins the tombstones as well as the classification.' },

  // ── boards ─────────────────────────────────────────────────────────────────────────────────
  { id: 'D1-b19', value: V1_BOARD_TEXT, label: 'a valid v1 board (no `_v2`)', expect: OK, openFinding: null },
  { id: 'D1-b20', value: V2_BOARD_TEXT, label: 'a valid v2 board with a lineage', expect: OK, openFinding: null },
  { id: 'D1-b21', value: V2_NO_LINEAGE_TEXT, label: '`_v2` present but carrying no lineage',
    expect: OK, openFinding: null },
  { id: 'D1-b22', get value() { return bigBoardText(); },
    label: `a valid board of ${BIG_BOARD_BYTES / 1024 / 1024} MB`, expect: OK, openFinding: null },

  // ── the store did not answer ───────────────────────────────────────────────────────────────
  { id: 'D1-b23', value: { read: 'throws' }, label: 'the read THREW (locked file, EIO, dismissed prompt)',
    expect: UNREADABLE('read-failed'), openFinding: null },
  { id: 'D1-b24', value: { read: 'null' }, label: 'the read returned null — the store holds nothing',
    expect: ABSENT, openFinding: null },
  { id: 'D1-b25', value: { read: 'no-record' }, label: 'the storage layer returned no record object at all',
    expect: UNREADABLE('read-failed'), openFinding: null,
    note: '`classifyBoardFile(undefined)` — a caller bug, and the honest answer is "nothing is '
      + 'known", never "there is no board file".' },
]);

/**
 * THE SOURCE AXIS — where the bytes came from, which is the OTHER half of R5-3c's lesson.
 *
 * `saveBoardText` writes to localStorage when the native write throws, so a native read that
 * misses or throws MUST still look there. The required invariant is that this changes nothing:
 * the same bytes classify the same way from either store. `fallback` says whether the
 * localStorage copy is the one that answered.
 */
export const D1_SOURCES = deep([
  { id: 'browser', label: 'a plain browser: localStorage is the only store', tauri: false, native: 'bytes', fallbackHolds: 'nothing' },
  { id: 'tauri-native', label: 'Tauri: the native read answers, and no localStorage copy exists', tauri: true, native: 'bytes', fallbackHolds: 'nothing' },
  { id: 'tauri-fallback-present', label: 'Tauri: the native read THROWS and a localStorage fallback copy holds the bytes', tauri: true, native: 'throws', fallbackHolds: 'bytes' },
  { id: 'tauri-miss-fallback-present', label: 'Tauri: the native read returns nothing and a localStorage fallback copy holds the bytes', tauri: true, native: 'missing', fallbackHolds: 'bytes' },
]);

/** Degenerate rows: no bytes exist in EITHER store, so there is nothing to cross. */
export const D1_NO_BYTES = deep([
  { id: 'D1-n01', value: { tauri: true, native: 'throws', fallbackHolds: 'nothing' },
    label: 'Tauri: the native read threw and the localStorage fallback is EMPTY',
    expect: UNREADABLE('read-failed'), openFinding: null,
    note: 'R5-3c. An EIO is not a fresh install; treating it as one is how a transient error '
      + 'became a recovery.' },
  { id: 'D1-n02', value: { tauri: true, native: 'missing', fallbackHolds: 'nothing' },
    label: 'Tauri: the native read returned nothing and the localStorage fallback is EMPTY',
    expect: ABSENT, openFinding: null },
  { id: 'D1-n03', value: { tauri: false, native: 'missing', fallbackHolds: 'nothing' },
    label: 'a plain browser with no board key at all — a fresh install',
    expect: ABSENT, openFinding: null },
]);

/**
 * THE CROSS. Every byte string, from every place bytes can come from.
 *
 * The `{read}` markers in `D1_BYTES` are themselves statements about the source, so they are not
 * crossed — they appear once, in `D1_NO_BYTES` terms, and are carried through unchanged.
 */
export const D1 = deep((() => {
  const out = [];
  for (const b of D1_BYTES) {
    if (b.value !== null && typeof b.value === 'object') {          // a `{read}` marker
      out.push({ id: b.id, label: b.label, source: null, bytes: null, read: b.value.read,
        expect: b.expect, openFinding: b.openFinding, note: b.note ?? null });
      continue;
    }
    for (const s of D1_SOURCES) {
      out.push({
        id: `${b.id}/${s.id}`,
        label: `${b.label} — ${s.label}`,
        source: s.id, byteId: b.id, read: null,
        get bytes() { return b.value; },
        expect: b.expect, openFinding: b.openFinding, note: b.note ?? null,
      });
    }
  }
  for (const n of D1_NO_BYTES) {
    out.push({ id: n.id, label: n.label, source: 'explicit', bytes: null, read: null,
      native: n.value, expect: n.expect, openFinding: n.openFinding, note: n.note ?? null });
  }
  return out;
})());

/**
 * D1's SECOND AXIS — WHAT IS LYING BESIDE THE BOARD FILE.
 *
 * `adoptsLog` and `showsSnapshot` in the expectations above are only meaningful against a log,
 * and the branch `init()` takes is a function of BOTH files. This is not crossed with all 94
 * byte-rows — it changes the answer only where the kind is `absent` or `ok` — so it is
 * enumerated on its own, at the four log states that exist.
 *
 * R6-6 is the half of this axis nobody wrote down: the INVERSE of R5-3's caution. §5.6 spends
 * three paragraphs on "the one situation in which the app has genuinely lost sight of the user's
 * data and has to say so", and §5.5 reaches the same morning with none of that machinery — an
 * empty, WRITABLE board with `snapshots.json` loaded, sitting in `store.snapshots`, unread.
 *
 * expect = { shows, mayWrite, recoveredFrom, quarantine }
 *   shows  'board' | 'log' | 'snapshot' | 'nothing' — what is on screen and what it is labelled
 */
export const D1_RECOVERY = deep([
  { id: 'D1-r1', value: { board: 'absent', log: 'none', snapshot: false },
    label: 'no board and no log — a fresh install (story 15.1, INV-12)',
    expect: { shows: 'nothing', mayWrite: true, recoveredFrom: null, quarantine: null },
    openFinding: null },
  { id: 'D1-r2', value: { board: 'absent', log: 'this-board', snapshot: true },
    label: 'no board, a log that LOADS — R7\'s recovery, said out loud',
    expect: { shows: 'log', mayWrite: true, recoveredFrom: 'op-log', quarantine: null },
    openFinding: null,
    note: 'The warning must say that NOTHING verified the tie, and name snapshots.json as the '
      + 'thing to check it against (ADR 006 §5.5).' },
  { id: 'D1-r3', value: { board: 'absent', log: 'will-not-load', snapshot: true },
    label: 'no board, a log that will NOT load, and a snapshot right there',
    expect: { shows: 'snapshot', mayWrite: false, recoveredFrom: 'snapshot', quarantine: 'unreadable-log' },
    openFinding: null,
    note: 'CLOSED 2026-08-27 (was R6-6a). Was: an EMPTY, WRITABLE board, `_recoveredFrom === null`, '
      + 'and the first autosave wrote the empty board to disk — while `store.snapshots` held the '
      + 'answer §5.6 argues for. The board file being gone does not make an unloadable log a fresh '
      + 'install. `_recoverFromLog` now enumerates its OUTCOME (R-a load throws / R-b loads and '
      + 'asserts nothing / R-c a real recovery) and R-a and R-b go to `_bootRecoveryFailed`, which '
      + 'is §5.6\'s machinery reached from §5.5. → round6-recovery.test.js R6-6a.' },
  { id: 'D1-r4', value: { board: 'absent', log: 'projects-to-nothing', snapshot: true },
    label: 'no board, a log that loads and projects to NOTHING, and a snapshot right there',
    expect: { shows: 'snapshot', mayWrite: false, recoveredFrom: 'snapshot', quarantine: null },
    openFinding: null,
    note: 'CLOSED 2026-08-27 (was R6-6b). Was: reported as a recovery `from: op-log` — of nothing '
      + 'at all — and committable. A recovery that recovers no entry is indistinguishable from no '
      + 'recovery, and the file that could tell them apart was loaded and not consulted. NOTE THE '
      + 'QUARANTINE IS NULL AND MUST STAY NULL: nothing is wrong with this log, it is empty. '
      + '→ round6-recovery.test.js R6-6b, and R6-6e is the control that a log which merely will '
      + 'not PROJECT is still recovered.' },
  { id: 'D1-r5', value: { board: 'absent', log: 'will-not-load', snapshot: false },
    label: 'no board, a log that will not load, and NO snapshot',
    expect: { shows: 'nothing', mayWrite: false, recoveredFrom: null, quarantine: 'unreadable-log' },
    openFinding: null,
    note: 'CLOSED 2026-08-27 (was R6-6a). The genuinely unrecoverable morning. It is allowed to be '
      + 'empty; it is not allowed to be SILENT, and it is not allowed to commit the emptiness. '
      + '`_recoveredFrom.from === \'none\'` — the stand-in says there was no stand-in, rather than '
      + 'saying nothing. → round6-recovery.test.js R6-6f.' },
  { id: 'D1-r6', value: { board: 'ok', log: 'none', snapshot: false },
    label: 'a board and no log — solo mode, nothing to adopt and nothing to refuse',
    expect: { shows: 'board', mayWrite: true, recoveredFrom: null, quarantine: null },
    openFinding: null },
  { id: 'D1-r7', value: { board: 'ok', log: 'this-board', snapshot: false },
    label: 'a board and ITS OWN log — the happy path (R6-8a, INV-4)',
    expect: { shows: 'board', mayWrite: true, recoveredFrom: null, quarantine: null, reconciled: 0 },
    openFinding: null,
    note: 'The plan must be EMPTY on an exact match. A non-zero `reconciled` here is news.' },
  { id: 'D1-r8', value: { board: 'ok', log: 'another-board', snapshot: false },
    label: 'a board and ANOTHER board\'s legitimate log — `foreign-lineage` (R6-8b)',
    expect: { shows: 'board', mayWrite: true, recoveredFrom: null, quarantine: 'foreign-lineage' },
    openFinding: null },
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D2 — A STAMP, RELATIVE TO THIS MACHINE'S CLOCK, CROSSED WITH AUTHORSHIP
//
// ADR 001 §1.3 / §7.4: an op stamped more than MAX_FUTURE_DRIFT_MS (24 h) ahead of local wall
// time is PARKED — retained, applied to no register, re-evaluated when wall time catches up.
// Parking is the SHOCK ABSORBER for a peer with a bad clock. Round 6 measured it wired to the
// fire alarm instead: `_clockSkew` walked `ops({includeParked:true})`, found the parked stamp and
// quarantined THE ENTIRE HISTORY on every launch until the date passed (R6-4a/b).
//
// The crossing with AUTHORSHIP is the attack. `foldAuthorized` decided the park BEFORE it decided
// authorisation, so a foreign author whose write the store refuses outright when stamped NOW was
// KEPT when stamped 48 h ahead — kept, persisted into the victim's own checkpoint, and read back
// by `_clockSkew` next launch (R6-4c). One date from a stranger, and the history was gone.
//
// ROUND 7 CLOSED BOTH, AND THE TWO FIXES ARE INDEPENDENT ON PURPOSE — one is the ORDERING and one
// is the BLAST RADIUS, and either alone leaves the other's cell wrong:
//   · `store.applyRemote` withholds `nowMs` from `foldAuthorized`. The clamp is `nowMs`'s only
//     consumer anywhere in the fold, so withholding it is exactly "stop letting the clock
//     pre-empt authorisation" and nothing else. → the `foreign` column.
//   · `store._clockSkew` walks `ops({liveOnly:true})`. A parked op is in no register, so no mint
//     has to be above it. → the `own` column, and the whole `quarantineNextLaunch` axis.
// Every entry below now carries `openFinding: null`, so any deviation is reported UNEXPECTED.
//
// expect (on a stamp)  = { shape: 'valid'|'invalid', park: 'live'|'future'|null }
//   `park: null` means the stamp is not admissible as a stamp at all, so nothing parks it.
// expect (on a cross)  = { lineKept, folded, quarantineNextLaunch, historyAdoptedNextLaunch }
//   `folded` is `classifyOp`'s own word: was the op ADMITTED into the register fold? It is
//   deliberately NOT "did its value end up on screen" — that is LWW's business (ADR 001 §6) and
//   a function of what the register already held, not of this domain. The non-vacuity control
//   that the window really is a window (R6-4d, D2-s06) asserts the value separately and by name.
//
// THE REQUIRED RULES:
//   1. AUTHORISATION IS DECIDED FIRST. A line whose author the store refuses is never kept, at
//      any stamp. (`foreign` ⇒ lineKept === false, for every stamp in the domain.)
//   2. A PARK COSTS THE PARKED OP AND NOTHING ELSE. A parked line may never quarantine the log
//      that carries it. (`quarantineNextLaunch === null` everywhere in this domain.)
//   3. The window is a WINDOW, not a ban: everything at or inside +24 h is applied (R6-4d is the
//      non-vacuity control and it must keep passing).
// ═════════════════════════════════════════════════════════════════════════════════════════════

const live = { shape: 'valid', park: 'live' };
const future = { shape: 'valid', park: 'future' };

export const D2_STAMPS = deep([
  { id: 'D2-s01', value: { offsetMs: 0 }, label: 'now', expect: live, openFinding: null },
  { id: 'D2-s02', value: { offsetMs: +S }, label: 'one second ahead', expect: live, openFinding: null },
  { id: 'D2-s03', value: { offsetMs: -S }, label: 'one second behind', expect: live, openFinding: null },
  { id: 'D2-s04', value: { offsetMs: +H }, label: 'one hour ahead', expect: live, openFinding: null },
  { id: 'D2-s05', value: { offsetMs: -H }, label: 'one hour behind', expect: live, openFinding: null },
  { id: 'D2-s06', value: { offsetMs: +12 * H }, label: 'TWELVE HOURS AHEAD — the non-vacuity control (R6-4d)',
    expect: live, openFinding: null,
    note: 'This must reconcile perfectly. If it does not, every other row in D2 is vacuous.' },
  { id: 'D2-s07', value: { offsetMs: -12 * H }, label: 'twelve hours behind', expect: live, openFinding: null },
  { id: 'D2-s08', value: { offsetMs: +(23 * H + 59 * MIN) }, label: '23 h 59 m ahead — inside the window',
    expect: live, openFinding: null },
  { id: 'D2-s09', value: { offsetMs: -(23 * H + 59 * MIN) }, label: '23 h 59 m behind', expect: live, openFinding: null },
  { id: 'D2-s10', value: { offsetMs: +24 * H }, label: 'EXACTLY 24 h ahead — the boundary, still inside (`>` not `>=`)',
    expect: live, openFinding: null },
  { id: 'D2-s11', value: { offsetMs: -24 * H }, label: 'exactly 24 h behind — the past is never parked',
    expect: live, openFinding: null },
  { id: 'D2-s12', value: { offsetMs: +(24 * H + S) }, label: '24 h and ONE SECOND ahead — the first parked stamp',
    expect: future, openFinding: null },
  { id: 'D2-s13', value: { offsetMs: -(24 * H + S) }, label: '24 h and one second behind', expect: live, openFinding: null },
  { id: 'D2-s14', value: { offsetMs: +48 * H }, label: 'FORTY-EIGHT HOURS AHEAD — R6-4\'s stamp',
    expect: future, openFinding: null },
  { id: 'D2-s15', value: { offsetMs: -48 * H }, label: '48 h behind', expect: live, openFinding: null },
  { id: 'D2-s16', value: { offsetMs: +90 * DAY }, label: 'ninety days ahead — R6-4b\'s "no way to make it stop"',
    expect: future, openFinding: null },
  { id: 'D2-s17', value: { offsetMs: -90 * DAY }, label: 'ninety days behind', expect: live, openFinding: null },
  { id: 'D2-s18', value: { offsetMs: +3652 * DAY }, label: 'ten years ahead', expect: future, openFinding: null },
  { id: 'D2-s19', value: { absMs: 0, deviceShort: '0000000000000000' },
    label: 'a GENESIS stamp (`ms = 0`, the all-zeros device short) — a v1 migration\'s own stamp',
    expect: live, openFinding: null,
    note: 'GENESIS sorts below every real stamp by construction (ADR 001 §8.1), so it is ADMITTED '
      + 'and then LOSES every contest it enters. Admitted and losing is not the same event as '
      + 'parked, and this row exists so the two are never confused: the first is the design '
      + 'working, the second stops the whole history.' },
  { id: 'D2-s20', value: { rawTs: 'NICHT EIN STAMP' }, label: 'a MALFORMED stamp',
    expect: { shape: 'invalid', park: null }, openFinding: null,
    note: 'Refused by `validateOp` as a protocol violation, and the refusal must be REPORTED — '
      + 'never parked, never appended, never fatal (A3-H3).' },
  { id: 'D2-s21', value: { rawTs: '1787836800123.000003.!!!!!!!!!!!!!!!!' },
    label: 'a stamp of the right length whose device short is outside the alphabet',
    expect: { shape: 'invalid', park: null }, openFinding: null },
  { id: 'D2-s22', value: { offsetMs: 0, device: 'ours' },
    label: 'a stamp at NOW carrying THIS Mac\'s own device short, arriving as a remote op',
    expect: live, openFinding: null,
    note: 'The complement of "a stamp from a device that is not ours" — every other row here '
      + 'carries a foreign device short, and this one FORGES OURS. AUTHORSHIP, NOT THE SHORT, '
      + 'DECIDES ADMISSION: crossed with `foreign` this is an outsider writing under this Mac\'s '
      + 'own device name, and it must still be refused.' },
]);

export const D2_AUTHORS = deep([
  { id: 'own', label: 'the op is authored by this member (`act === store._me`)', foreign: false },
  { id: 'foreign', label: 'the op is authored by someone this store\'s authz refuses', foreign: true },
]);

/** live vs PARKED × own vs foreign — R6-4's crossing, as the four cells plus the shape refusals. */
export const D2 = deep((() => {
  const out = [];
  for (const s of D2_STAMPS) {
    for (const a of D2_AUTHORS) {
      let expect; let openFinding = null;
      if (s.expect.shape === 'invalid') {
        expect = { lineKept: false, folded: false, quarantineNextLaunch: null, historyAdoptedNextLaunch: true };
      } else if (a.foreign) {
        // RULE 1 — authorisation is decided before the park. A refused author never gets a line.
        //
        // CLOSED IN ROUND 7 (R6-4c → R7). `store.applyRemote` withholds `nowMs` from
        // `foldAuthorized`, so the 24 h clamp — the only thing `nowMs` feeds — can no longer
        // pre-empt the three authorisation stages. The park stays where it belongs, in
        // `_log.append`, which classifies against its own `now()`. `openFinding` is null for
        // every stamp now: this rule holds across the whole axis, and a regression here is
        // reported as UNEXPECTED rather than as known work.
        expect = { lineKept: false, folded: false, quarantineNextLaunch: null, historyAdoptedNextLaunch: true };
      } else if (s.expect.park === 'future') {
        // RULE 2 — a park costs the parked op and nothing else.
        //
        // CLOSED IN ROUND 7 (R6-4a/R6-4b → R7). `store._clockSkew` walks `ops({liveOnly:true})`:
        // a parked op is in no register, so there is nothing for a mint to be "above" and §12.6's
        // precondition never applied to it.
        expect = { lineKept: true, folded: false, quarantineNextLaunch: null, historyAdoptedNextLaunch: true };
      } else {
        expect = { lineKept: true, folded: true, quarantineNextLaunch: null, historyAdoptedNextLaunch: true };
      }
      out.push({
        id: `${s.id}/${a.id}`, label: `${s.label} — ${a.label}`,
        stampId: s.id, authorId: a.id, value: s.value, park: s.expect.park, shape: s.expect.shape,
        expect, openFinding, note: s.note ?? null,
      });
    }
  }
  return out;
})());

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D3 — A LOG LINE'S PROVENANCE
//
// Five kinds of line can be proposed to the log. FOUR of them exist by design. The fifth exists
// only because two decisions are made in the wrong order, and it is R6-4c: the park is decided
// BEFORE the authorisation gate, so an outsider whose write authz rejects still gets a line kept,
// PERSISTED into the victim's checkpoint, and read back on the next launch.
//
// expect = { keptAsLine, appliedToRegisters, ridesInCheckpoint, reachableToday, mustExist }
//   `mustExist: false` is the whole finding: a class of line that the design does not have a
//   place for, which the implementation nevertheless produces.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const D3 = deep([
  { id: 'D3-p1', value: { author: 'own', park: null },
    label: 'OURS, ADMITTED — the ordinary line',
    expect: { keptAsLine: true, appliedToRegisters: true, ridesInCheckpoint: false, reachableToday: true, mustExist: true },
    openFinding: null,
    note: 'It rides in `regs`, not in `parked`.' },
  { id: 'D3-p2', value: { author: 'own', park: 'future' },
    label: 'OURS, PARKED — a stamp beyond the drift window from one of my own devices',
    expect: { keptAsLine: true, appliedToRegisters: false, ridesInCheckpoint: true, reachableToday: true, mustExist: true },
    openFinding: null,
    note: 'A2 round 2: the parked line and its REASON ride in `checkpoint().parked`. That is '
      + 'correct and must stay. What must NOT follow is a quarantine — see D2.' },
  { id: 'D3-p3', value: { author: 'foreign', park: null, authorized: true },
    label: 'FOREIGN, ADMITTED — a family member writing in a shared space',
    expect: { keptAsLine: true, appliedToRegisters: true, ridesInCheckpoint: false, reachableToday: false, mustExist: true },
    openFinding: null,
    note: 'UNREACHABLE IN WP-3 AND SAID SO. No family space can exist yet (A3-H4, F-5, F-6), so '
      + 'nothing in this build can produce this line. It is enumerated because leaving it out is '
      + 'how a domain becomes a description of the code: at WP-8 this is the COMMON case, and the '
      + 'rules D3-p5 is judged against have to be written before then, not after.' },
  { id: 'D3-p4', value: { author: 'foreign', park: null, authorized: false },
    label: 'FOREIGN, REJECTED BY AUTHZ — refused, reported, never a line',
    expect: { keptAsLine: false, appliedToRegisters: false, ridesInCheckpoint: false, reachableToday: true, mustExist: true },
    openFinding: null,
    note: 'The control. `applyRemote` warns `notMyAct` and appends nothing.' },
  { id: 'D3-p5', value: { author: 'foreign', park: 'future', authorized: false },
    label: 'FOREIGN, PARKED BEFORE AUTHZ RAN — the class that must not exist',
    expect: { keptAsLine: false, appliedToRegisters: false, ridesInCheckpoint: false, reachableToday: true, mustExist: false },
    openFinding: null,
    note: 'THE SAME AUTHOR AND THE SAME OP AS D3-p4, one date later. `classifyOp` returned '
      + '`{status:\'park\'}` on the future stamp before any authorisation question was asked, so the '
      + 'op was not in `verdict.rejected`, `applyRemote` did not skip it, `_log.append` parked it, '
      + 'and `persistNow` wrote it into the victim\'s own `checkpoint().parked`. The required '
      + 'behaviour is that the park classification is applied to ops that have already been '
      + 'AUTHORISED, so this cell is empty. CLOSED IN ROUND 7 (R6-4c → R7): `store.applyRemote` '
      + 'withholds `nowMs` from `foldAuthorized`, whose only consumer of it is that clamp, so the '
      + 'authorisation stages run first and this line is refused at every stamp. The row stays — '
      + 'with `mustExist: false` and no finding — because it is the one that goes UNEXPECTED if '
      + 'the ordering is ever reversed again.' },
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D4 — CHECKPOINT GROWTH: WHAT `bodies` RETAINS, AND WHAT PRUNES IT
//
// R5-4 bounded `ops.jsonl` at TAIL_COMPACT_AT = 1500 lines, and bought that bound with an
// UNBOUNDED `checkpoint.json`. `compact()` calls `rememberBody` for every line it drops — right,
// and load-bearing: it is what tells a splice from a re-delivery after the line is gone (A1
// round 2). `pruneSeqIndex` pruned `seqById`, `tsById` and `legacySeqByStamp` on the same call
// and stepped over `bodies`. Nothing else ever forgot one.
//
// So the file the app rewrites ATOMICALLY AND WHOLE on every debounced save grew with the number
// of ops the user had EVER WRITTEN, on a board that never grows at all.
//
// ROUND 7 CLOSED IT AT THE ONE FUNCTION THAT REMEMBERS. `pruneSeqIndex` ends in `boundBodies()`,
// which evicts oldest-first down to `BODY_FINGERPRINT_CAP` and never evicts an id that still
// holds a line. The fix is NOT "prune `bodies` by `keepIds` like its three siblings" — round 6's
// own mutant F1 — because `bodies` holds precisely the ids `keepIds` excludes; that would empty
// it and put A1 back. The bound is a CAP, and what an evicted fingerprint costs is enumerated per
// opId-state at `src/js/core/oplog.js:BODY_FINGERPRINT_CAP`.
//
// TWO SUB-DOMAINS. The first is the INDEX domain — every map the checkpoint serialises, with what
// bounds it. The second is the GROWTH domain — ops-ever-written against board size, measured.
//
// THE REQUIRED RULE: every index the checkpoint carries is bounded by a function of the LIVE log
// — the registers that survive, plus the lines still retained — and never by the number of ops
// that have passed through it. `TAIL_COMPACT_AT` is the design's own name for "the most lines
// this log ever holds at once", so it is the bound, and it is not a number picked here.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** `store.js:519` — `Math.min(5000, floor(LS_OPS_CAP * 0.75))`. Restated, not imported, so that a
 *  change to it shows up here as a disagreement rather than silently moving the bound. */
export const TAIL_COMPACT_AT = 1500;
export const LS_OPS_CAP = 2000;

export const D4_INDEXES = deep([
  { id: 'D4-i1', value: 'regs', label: 'the folded registers',
    expect: { boundedBy: 'live entities × fields', prunedBy: 'entity purge', growsWithOpsEver: false },
    openFinding: null },
  { id: 'D4-i2', value: 'seqs', label: '`seqById` — opId → line sequence',
    expect: { boundedBy: 'live entities × fields + retained lines', prunedBy: 'pruneSeqIndex', growsWithOpsEver: false },
    openFinding: null },
  { id: 'D4-i3', value: 'tsById', label: 'opId → stamp',
    expect: { boundedBy: 'live entities × fields + retained lines', prunedBy: 'pruneSeqIndex', growsWithOpsEver: false },
    openFinding: null },
  { id: 'D4-i4', value: 'legacySeqByStamp', label: 'stamp → line sequence, for logs written before opIds carried one',
    expect: { boundedBy: 'live entities × fields + retained lines', prunedBy: 'pruneSeqIndex', growsWithOpsEver: false },
    openFinding: null },
  { id: 'D4-i5', value: 'bodies', label: '`bodies` — the ADR 002 §5.1 splice guard, one fingerprint per absorbed opId',
    expect: { boundedBy: `retained lines (≤ ${TAIL_COMPACT_AT})`, prunedBy: 'pruneSeqIndex', growsWithOpsEver: false },
    openFinding: null,
    note: 'It WAS the one index `pruneSeqIndex` stepped over: `purge()` deleted a purged entity\'s '
      + 'fingerprints and was the only thing that removed any, so on a board nobody deletes from, '
      + 'nothing forgot anything, ever. CLOSED IN ROUND 7 (R6-3b → R7): `pruneSeqIndex` now ends '
      + 'in `boundBodies()`, which evicts oldest-first down to `BODY_FINGERPRINT_CAP` (= this '
      + 'domain\'s TAIL_COMPACT_AT) and never evicts an id that still holds a line. It is NOT '
      + 'pruned by `keepIds` like its three siblings, and that distinction is the finding: '
      + '`bodies` holds exactly the ids `keepIds` excludes, so pruning it that way (round 6\'s own '
      + 'mutant F1) keeps the WINNER of each field and drops every absorbed op no register points '
      + 'at. Measured, that costs the ADR 002 §5.1 tamper evidence — a splice against a SUPERSEDED '
      + 'opId comes back `appended` with `splicedIds()` empty — and the cross-restart dedupe '
      + 'index; it does NOT change state, because `append` re-folds an unfingerprinted id and a '
      + 're-fold is idempotent. What a forgotten fingerprint costs is enumerated per opId-state at '
      + '`src/js/core/oplog.js:BODY_FINGERPRINT_CAP`.' },
  { id: 'D4-i6', value: 'parked', label: 'the parked LINES and their reasons',
    expect: { boundedBy: 'parked ops, which unpark when wall time passes them', prunedBy: 'unpark', growsWithOpsEver: false },
    openFinding: null },
  { id: 'D4-i7', value: 'spliced', label: 'the opIds seen under two or more different bodies',
    expect: { boundedBy: 'actual splices, which are an attack and are rare', prunedBy: 'nothing', growsWithOpsEver: false },
    openFinding: null },
  { id: 'D4-i8', value: 'cursors', label: 'the per-peer delivery cursors',
    expect: { boundedBy: 'peers', prunedBy: 'nothing', growsWithOpsEver: false }, openFinding: null },
]);

/**
 * THE GROWTH DOMAIN. One note, four registers, edited over and over — the board never grows.
 * `expect.bodiesMax` is `TAIL_COMPACT_AT`; `expect.cpBytesRatioMax` is measured against the
 * checkpoint at the FIRST compaction, after which the live set is in steady state.
 */
export const D4_GROWTH = deep([
  { id: 'D4-g1', value: { opsEverWritten: 0 }, label: 'a fresh board, nothing written',
    expect: { bodiesMax: TAIL_COMPACT_AT, cpBytesRatioMax: null }, openFinding: null },
  { id: 'D4-g2', value: { opsEverWritten: 100 }, label: '100 edits — below the first compaction',
    expect: { bodiesMax: TAIL_COMPACT_AT, cpBytesRatioMax: null }, openFinding: null },
  { id: 'D4-g3', value: { opsEverWritten: 800 }, label: '800 edits — still below the first compaction',
    expect: { bodiesMax: TAIL_COMPACT_AT, cpBytesRatioMax: null }, openFinding: null },
  { id: 'D4-g4', value: { opsEverWritten: 1600 }, label: '1 600 edits — one compaction has run; this is the BASELINE',
    expect: { bodiesMax: TAIL_COMPACT_AT, cpBytesRatioMax: 1, baseline: true }, openFinding: null },
  { id: 'D4-g5', value: { opsEverWritten: 3200 }, label: '3 200 edits on the same one-note board',
    expect: { bodiesMax: TAIL_COMPACT_AT, cpBytesRatioMax: 1.5 }, openFinding: null,
    note: 'Measured at round 6: 3 000 fingerprints and 144 KB of checkpoint for a 1 KB board. '
      + 'CLOSED IN ROUND 7 (R6-3a → R7) by `boundBodies()` — see D4-i5.' },
  { id: 'D4-g6', value: { opsEverWritten: 6400 }, label: '6 400 edits on the same one-note board',
    expect: { bodiesMax: TAIL_COMPACT_AT, cpBytesRatioMax: 1.5 }, openFinding: null,
    note: 'Measured at round 6: 6 000 fingerprints and 282 KB, rewritten whole on every debounced '
      + 'save. The curve was LINEAR IN OPS-EVER and flat in board size; it is now flat in both. '
      + 'This is the row that catches an unbounding that D4-g5 is too early to see, so the two '
      + 'marks stay separate.' },
]);

export const D4 = deep([...D4_INDEXES, ...D4_GROWTH]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D5 — ARRAY ORDER AND `_born`
//
// ADR 001 §5 step 5: the comparators are MANDATORY, NOT COSMETIC — v1's capacity slice and its
// per-column lane rescue are order-sensitive, so two devices that fold the same ops into
// different array orders draw DIFFERENT BOARDS from identical data. Order is therefore content,
// and order is decided entirely by `_born`, which is write-once.
//
// Two independent capabilities decide what the store can do about a disagreement:
//
//   MINT   can the reconciler (ADR 006 R3, `_diff`) make the log's order agree with board.json's?
//          `_born` is not in any `COLLECTION[].fields`, so today it cannot.
//   SEE    can the post-condition (ADR 006 R4, `v1ContentOf`) notice that they disagree?
//          R5-5a put the id SEQUENCE into the comparison, so today it can.
//
// FOUR CELLS. The build is in exactly one of them, and R6-7 is the name of the one it is in.
//
//        │ SEE = false                       │ SEE = true
//  ──────┼───────────────────────────────────┼──────────────────────────────────────────────
//  MINT  │ (c) unsound: the reconciler moves │ (d) REQUIRED: a disagreement is repaired, and
//   true │     order and nothing checks it   │     the repair is checked
//  ──────┼───────────────────────────────────┼──────────────────────────────────────────────
//  MINT  │ (a) R5-5a, before the fix: two    │ (b) R6-7, CLOSED: the post-condition refused in
//  false │     devices silently disagree     │     a case the reconciler could not fix
//
// THE BUILD IS NOW IN CELL (d). `store.js:diffCollection` chooses the `_born` of every row it
// mints — the log's own value for a RESTORE (a tombstone clears `_alive`, never `_born`), an
// interpolated one for a row the log never heard of that `board.json` puts in the middle, and a
// fresh mint for an append, which is the ordinary path unchanged. Cell (b)'s cost is kept below
// as the reason the cell is not a resting place, and `D5-probe-see` is the control that stops the
// repair from becoming cell (c).
//
// Cell (b) was not a safe resting place. It costs the user their entire history — every stamp,
// tombstone, parked op and cursor — on paths ADR 006 §5.4 itself calls ordinary: a Time-Machine
// restore of a board from before a delete in the MIDDLE (R6-7a), and any loss of `ops.jsonl`,
// whose browser fallback drops the OLDEST lines, i.e. exactly the entries that are not last
// (R6-7d). Cell (a) is worse and is closed. Cell (c) is what "just relax the post-condition"
// produces, and it is the reason relaxing it is not the fix.
//
// expect = { required: boolean, mint: boolean, see: boolean, outcome }
// The property probes the two capabilities separately and asserts the build is in cell (d).
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const D5 = deep([
  { id: 'D5-a', value: { mint: false, see: false }, label: '(a) cannot mint, cannot see',
    expect: { required: false, outcome: 'two devices draw different boards from identical data, silently (R5-5a, closed)' },
    openFinding: null },
  { id: 'D5-b', value: { mint: false, see: true }, label: '(b) cannot mint, CAN see — where the build was until R6-7 was closed',
    expect: { required: false, outcome: 'the whole history is quarantined `reconcile-failed` on an ordinary Time-Machine restore' },
    openFinding: null },
  { id: 'D5-c', value: { mint: true, see: false }, label: '(c) CAN mint, cannot see',
    expect: { required: false, outcome: 'the reconciler moves user-visible order and nothing guards it — unsound' },
    openFinding: null },
  { id: 'D5-d', value: { mint: true, see: true }, label: '(d) CAN mint, CAN see — THE REQUIRED CELL, and where the build now is',
    expect: { required: true, outcome: 'board.json\'s order wins, the log is adopted, and the post-condition still guards the result' },
    openFinding: null },
]);

/**
 * The two probes that locate the build in the table above. Both are measurable now.
 *
 *   `see`  — swap two `_born` stamps inside an adopted checkpoint. The store must REFUSE.
 *            (R5-5a's own row; it passes today, and if it ever stops, D5 is vacuous.)
 *   `mint` — restore a `board.json` from before a delete in the middle, over this board's own
 *            log. The log must be ADOPTED and board.json's order honoured. (R6-7a; closed by the fix
 *            pass — `store.js:diffCollection` mints the position.)
 */
export const D5_PROBES = deep([
  { id: 'D5-probe-see', value: 'swapped _born stamps in an adopted checkpoint',
    expect: { detected: true }, openFinding: null },
  { id: 'D5-probe-mint', value: 'a Time-Machine restore over this board\'s own log, deleting a MIDDLE entry',
    expect: { quarantine: null, orderFromBoard: true }, openFinding: null },
  { id: 'D5-probe-mint-tail', value: 'ops.jsonl loses its OLDEST lines (the browser `slice(-LS_OPS_CAP)`)',
    expect: { quarantine: null, orderFromBoard: true }, openFinding: null },
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D6 — BAR-EDGE AND DATE STRINGS, BY SORT POSITION
//
// R5-11's rule, which this domain does not dispute:
//
//   > v1 does not PARSE a bar edge, it COMPARES it (`layout.js:133`). So the faithful v2 value is
//   > not "the day this text means" (it means none) but "a date that sorts where this text
//   > sorted".
//
// `coerceToV1BarEdge` implements that for the two classes where the answer is a CONSTANT — text
// below `'0000-01-01'` keeps `EARLIEST_DATE`, text above `'9999-12-31'` keeps `LATEST_DATE`. The
// class it answers `null` for is everything in between, and the value then falls through to
// `coerceToV1Date`, which asks the one question v1 never asks about a bar edge: what DAY does
// this name? R6-10 measured the cost. This domain measures the whole alphabet instead.
//
// THE THREE CLASSES ARE NOT TWO. `DATE_RE`'s alphabet has a below, an ABOVE, and an INSIDE, and
// the two-sided guard has no case for inside. Every value in `sortsAs: 'inside'` below is a value
// v2 paints somewhere v1 did not.
//
// AND THE INSIDE CLASS HAS A FAITHFUL VALUE TOO — §4.6's premise is too pessimistic. Because day
// strings are themselves ISO, any inside-range text `t` has a nearest ISO neighbour on each side
// and NO DAY STRING LIES STRICTLY BETWEEN THEM, so a member of the alphabet can be chosen that
// compares as `t` compared, and the rule that covers below and above covers inside as well.
//
// ─── CORRECTED 2026-08-27 BY THE FIX PASS, BY MEASUREMENT — read this before trusting the above.
//
// The paragraph this replaces said the rule was `startDate ⟶ smallest ISO ≥ t`,
// `endDate ⟶ largest ISO ≤ t`, and that either "compares identically against every day v1 could
// test it against". THE SECOND HALF IS FALSE, and it is false in the way this file exists to
// catch: the claim was checked against the comparison that decides WHICH COLUMNS a bar occupies
// and not against the other two v1 makes. Written out, v1 makes FOUR (`layout.js:133-135,148,151`):
//
//     skip     endDate   <  mFirst          skip     startDate >  mLast
//     contBot  endDate   >  mLast           contTop  startDate <  mFirst
//
// `floor(t)` reproduces every `<` exactly and `ceil(t)` reproduces every `>` exactly; NEITHER
// reproduces both, and no member can, because reproducing both would mean `d = a ⟺ t = a` for
// every member `a` and `t` is not a member. What they have to reproduce is only what v1 asks:
//
//   · `floor(t)` breaks `>` only against `floor(t)` itself ⇒ exact unless it is a LAST-of-month;
//   · `ceil(t)`  breaks `<` only against `ceil(t)`  itself ⇒ exact unless it is a FIRST-of-month.
//
// So the rule is neither of the two the old paragraph named: TAKE THE FLOOR UNLESS IT IS A
// LAST-OF-MONTH, THEN THE CEILING UNLESS IT IS A FIRST-OF-MONTH. Both worked examples above were
// also wrong in their VALUES: `'2026-03'` as an `endDate` is `'2026-02-31'` (a member — `DATE_RE`
// does not check the calendar), not `'2026-02-28'`, which loses v1's continuation chevron on
// February; and as a `startDate` it is `'2026-02-31'` too, not `'2026-03-01'`, which loses v1's
// chevron on March. `'4.3.2026'` as a startDate really is `'4000-01-01'`.
//
// AND ONE CLASS HAS NO MEMBER AT ALL, which is why `D6_NO_MEMBER` exists below: a text sorting
// strictly between `YYYY-MM-31` of a 31-day month and the next month's `01` — `'2026-3-1'`,
// `'2026'`, `'2026/03/04'`, `'20260304'`, `'2026-13-01'`. There v1 wants a value that is at once
// after December's last day and before January's first, and `DATE_RE` has nothing between them.
// One continuation chevron, on the outermost column the bar already occupies, is what moves.
//
// THE ORACLE IS `buildBoard()` — `src/js/layout.js`, the real v1 renderer, pure, unchanged since
// the v1 baseline `66126e9`. `v1` below is what it PAINTED, measured on 2026-08-27 against
// `today: '2026-06-15'` and a twelve-column pinned year starting `2026-01`; it is not asserted
// from a reading of the code. The property re-measures it and fails if the recorded paint has
// rotted, so this data can never quietly stop describing the renderer.
//
// expect = { paints, kept }
//   paints  'as-v1'        every segment, every column, every chevron identical
//           'same-columns' a PROVABLY unreachable `as-v1`, for one of exactly two reasons, both
//                          named per entry in `D6_SAME_COLUMNS` and neither of them a licence to
//                          stop checking: (i) v1 itself rendered a day as `NaN`, because the text
//                          fell strictly inside a rendered month and `layout.js:136` parsed it —
//                          no value v2 can hold reproduces `NaN` (R5-12d's accepted ruling);
//                          (ii) `D6_NO_MEMBER` — the alphabet has no member where v1's two tests
//                          both want one. The COLUMN SET is still required to be identical, and
//                          that is the invariant the whole domain is really about.
//           'kept'         a NOTE, not a bar edge: v1 places a note by MAP EQUALITY, so a
//                          non-ISO date lands on no day in v1 either. §4.2 ruled COERCE and
//                          R6-10d is the class contrast — the entry must survive in the array,
//                          and where it paints is the accepted divergence, not a defect.
//   kept    the value board.json must end up holding: an ISO date string, or `null` for "any
//           value that sorts where the input sorted", or `undefined` for "the field is dropped".
//           Stated as `null` wherever more than one value satisfies `paints`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const EARLIEST_DATE = '0000-01-01';
export const LATEST_DATE = '9999-12-31';
export const D6_TODAY = '2026-06-15';
export const D6_START_MONTH = '2026-01';

/**
 * [value, sortsAs, group, v1 startDate paint, v1 endDate paint, v1 keeps the note?]
 * Paints are `'|'`-joined `COL:startDay-endDay[^][v]` — `^` continues before the year, `v` past it.
 */
const D6_MEASURED = [
  ["", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  [" ", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["\t", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["\n", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["-", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  [".", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["!", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["/", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["(offen)", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["0", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["00", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["000", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["0000-01-00", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["0000-00-00", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  [" 2026-03-04", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["/9999-12-31", "below", "below",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["0000-01-01", "iso", "boundary",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["9999-12-31", "iso", "boundary",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["0000-01-02", "iso", "boundary",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["9999-12-30", "iso", "boundary",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["2026-3-1", "inside", "inside-coerced",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["4.3.2026", "inside", "inside-coerced",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["2026/03/04", "inside", "inside-coerced",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["20260304", "inside", "inside-coerced",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["1.1.2026", "inside", "inside-coerced",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["9.9.2026", "inside", "inside-coerced",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["2", "inside", "inside-dropped",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["2026", "inside", "inside-dropped",
    "2026-01:1-31^|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "", 1],
  ["2026-03", "inside", "inside-dropped",
    "2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "2026-01:1-31v|2026-02:1-28v", 1],
  ["2026-03-04 bis 2026-03-09", "inside", "inside-dropped",
    "2026-03:NaN-31|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-NaN", 1],
  ["2026-13-01", "inside", "inside-dropped",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["2026-04-01T23:00:00-05:00", "inside", "inside-dropped",
    "2026-04:NaN-30|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-NaN", 1],
  ["2026-03-04T09:00", "inside", "inside-iso-tail",
    "2026-03:NaN-31|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-NaN", 1],
  ["2026-03-04", "iso", "iso",
    "2026-03:4-31|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-4", 1],
  ["2026-01-01", "iso", "iso",
    "2026-01:1-31|2026-02:1-28^|2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "2026-01:1-1", 1],
  ["2026-12-31", "iso", "iso",
    "2026-12:31-31",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31", 1],
  ["2026-02-30", "iso", "iso",
    "2026-03:1-31^|2026-04:1-30^|2026-05:1-31^|2026-06:1-30^|2026-07:1-31^|2026-08:1-31^|2026-09:1-30^|2026-10:1-31^|2026-11:1-30^|2026-12:1-31^",
    "2026-01:1-31v|2026-02:1-28v", 1],
  [":", "above", "above",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  [";", "above", "above",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["A", "above", "above",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["a", "above", "above",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["ä", "above", "above",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["zzz", "above", "above",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["irgendwann", "above", "above",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["unbekannt", "above", "above",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["9999-12-32", "above", "above",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
  ["99999-01-01", "above", "above",
    "",
    "2026-01:1-31v|2026-02:1-28v|2026-03:1-31v|2026-04:1-30v|2026-05:1-31v|2026-06:1-30v|2026-07:1-31v|2026-08:1-31v|2026-09:1-30v|2026-10:1-31v|2026-11:1-30v|2026-12:1-31v", 1],
];

/** Which of the three `paints` rules a group is judged by, and why. */
const D6_RULE = {
  below: { paints: 'as-v1', kept: EARLIEST_DATE, finding: null },
  above: { paints: 'as-v1', kept: LATEST_DATE, finding: null },
  boundary: { paints: 'as-v1', kept: null, finding: null },
  iso: { paints: 'as-v1', kept: null, finding: null },
  // R6-10 and R6-11 are CLOSED — `coerceToV1BarEdge` answers over the whole alphabet now, and the
  // rule that closed them is in its docblock. What is left of both groups is `D6_SAME_COLUMNS`.
  'inside-coerced': { paints: 'as-v1', kept: null, finding: null },
  'inside-dropped': { paints: 'as-v1', kept: null, finding: null },
  'inside-iso-tail': { paints: 'same-columns', kept: null, finding: null },
};

/**
 * THE ONE CLASS WHERE `DATE_RE` HAS NO MEMBER TO OFFER — the header's corrected paragraph, as data.
 *
 * A text sorting strictly between `YYYY-MM-31` of a 31-day month and the next month's `01`. v1's
 * skip test wants a value on one side of that gap and v1's chevron test wants one on the other,
 * and the alphabet is empty in between: after `'2026-12-31'` the next member IS `'2027-01-01'`.
 * The COLUMN SET is still reproduced exactly; one continuation chevron, on the outermost column
 * the bar already occupies, is not. Listed by VALUE rather than by entry id so it survives a
 * reordering of `D6_MEASURED`.
 */
export const D6_NO_MEMBER = deep(['2026-3-1', '2026/03/04', '20260304', '2026-13-01', '2026']);

/**
 * `${JSON.stringify(value)}/${field}` ⟶ why `as-v1` is PROVABLY unreachable for that pair.
 *
 * Two reasons and no others; a third one appearing here would be a fix quietly lowering its own
 * bar, which is what the property's STALE/UNEXPECTED split exists to stop. Note that a value in
 * `D6_NO_MEMBER` is only listed for the ONE field whose chevron test loses — the other field's
 * skip test is the `>`/`<` that the chosen member reproduces exactly, so it stays `as-v1`.
 */
const D6_SAME_COLUMNS = new Map([
  ['"2026-3-1"/endDate', 'no member between "2026-12-31" and "2027-01-01" (D6_NO_MEMBER)'],
  ['"2026/03/04"/endDate', 'no member between "2026-12-31" and "2027-01-01" (D6_NO_MEMBER)'],
  ['"20260304"/endDate', 'no member between "2026-12-31" and "2027-01-01" (D6_NO_MEMBER)'],
  ['"2026-13-01"/endDate', 'no member between "2026-12-31" and "2027-01-01" (D6_NO_MEMBER)'],
  ['"2026"/startDate', 'no member between "2025-12-31" and "2026-01-01" (D6_NO_MEMBER)'],
  ['"2026-03-04 bis 2026-03-09"/startDate', 'v1 itself rendered the day as NaN (layout.js:136)'],
  ['"2026-03-04 bis 2026-03-09"/endDate', 'v1 itself rendered the day as NaN (layout.js:136)'],
  ['"2026-04-01T23:00:00-05:00"/startDate', 'v1 itself rendered the day as NaN (layout.js:136)'],
  ['"2026-04-01T23:00:00-05:00"/endDate', 'v1 itself rendered the day as NaN (layout.js:136)'],
]);

/** The value axis, with its measured oracle attached. */
export const D6_VALUES = deep(D6_MEASURED.map(([value, sortsAs, group, sPaint, ePaint, noteKept], i) => ({
  id: `D6-v${String(i + 1).padStart(2, '0')}`,
  value,
  sortsAs,
  group,
  label: `${JSON.stringify(value)} — sorts ${sortsAs.toUpperCase()} ${sortsAs === 'iso' ? '(it IS a date)' : 'the alphabet of DATE_RE'}`,
  v1: { startDate: sPaint === '' ? [] : sPaint.split('|'), endDate: ePaint === '' ? [] : ePaint.split('|') },
  v1NoteKept: noteKept,
})));

export const D6_FIELDS = deep([
  { id: 'startDate', label: 'a bar\'s startDate — v1 COMPARES it (layout.js:133)', kind: 'bar' },
  { id: 'endDate', label: 'a bar\'s endDate — v1 COMPARES it (layout.js:133)', kind: 'bar' },
  { id: 'note.date', label: 'a note\'s date — v1 places it by MAP EQUALITY (layout.js:61-79)', kind: 'note' },
]);

export const D6 = deep((() => {
  const out = [];
  for (const v of D6_VALUES) {
    const rule = D6_RULE[v.group];
    for (const f of D6_FIELDS) {
      if (f.kind === 'note') {
        out.push({
          id: `${v.id}/note.date`, valueId: v.id, field: 'note.date', value: v.value,
          sortsAs: v.sortsAs, group: v.group,
          label: `${JSON.stringify(v.value)} as a NOTE date — the class contrast (R6-10d)`,
          expect: { paints: 'kept', kept: null, v1Kept: v.v1NoteKept },
          openFinding: null,
        });
        continue;
      }
      const proof = D6_SAME_COLUMNS.get(`${JSON.stringify(v.value)}/${f.id}`) ?? null;
      out.push({
        id: `${v.id}/${f.id}`, valueId: v.id, field: f.id, value: v.value,
        sortsAs: v.sortsAs, group: v.group,
        label: `${JSON.stringify(v.value)} as a bar ${f.id} — ${v.sortsAs}`
          + (proof ? ` · as-v1 is unreachable: ${proof}` : ''),
        v1: v.v1[f.id],
        expect: proof ? { paints: 'same-columns', kept: rule.kept, why: proof }
          : { paints: rule.paints, kept: rule.kept },
        openFinding: rule.finding,
      });
    }
  }
  return out;
})());

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE INDEX
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const DOMAINS = deep({
  D1: { id: 'D1', title: '`board.json` as bytes', entries: [...D1, ...D1_RECOVERY],
    subject: 'storage.loadBoardFile → store.classifyBoardFile → init()\'s branch' },
  D2: { id: 'D2', title: 'a stamp, relative to this machine\'s clock, crossed with authorship', entries: D2,
    subject: 'ops.classifyOp → authz.foldAuthorized → oplog.append → store._clockSkew' },
  D3: { id: 'D3', title: 'a log line\'s provenance', entries: D3,
    subject: 'store.applyRemote → oplog.append → checkpoint().parked' },
  D4: { id: 'D4', title: 'checkpoint growth', entries: D4,
    subject: 'oplog.compact → rememberBody / pruneSeqIndex → checkpoint()' },
  D5: { id: 'D5', title: 'array order and `_born`', entries: D5,
    subject: 'store._reconcileOntoBoard (mint) vs store.v1ContentOf (see)' },
  D6: { id: 'D6', title: 'bar-edge and date strings, by sort position', entries: D6,
    subject: 'migrate1to2.coerceToV1BarEdge / coerceToV1Date, against layout.buildBoard' },
});

export const DOMAIN_IDS = deep(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']);

/** Every entry across every domain, tagged with the domain it came from. */
export const ALL = deep(DOMAIN_IDS.flatMap((d) => DOMAINS[d].entries.map((e) => ({ domain: d, ...e }))));

/** The entries a finding id predicts will fail — the work order, per row. */
export function byFinding(finding) {
  return ALL.filter((e) => e.openFinding !== null && String(e.openFinding).startsWith(finding));
}

/** Every finding id named anywhere in this file, sorted. */
export const OPEN_FINDINGS = deep([...new Set(ALL.map((e) => e.openFinding).filter(Boolean))].sort());
