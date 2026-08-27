// tests/property/domains.test.js — ONE PROPERTY PER INPUT DOMAIN.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS SUITE IS EXPECTED TO BE RED, AND THE RED IS THE DELIVERABLE.
//
// `tests/helpers/domains.js` enumerates every input the history layer accepts and states, per
// input, the behaviour that is REQUIRED. This file drives every one of those inputs through the
// real store, the real op log, the real authz fold and the real v1 renderer, and asserts the
// required behaviour. The entries that fail are the fix phase's work order.
//
// The point is the shape of the failure report, not the failure. Round 6's verdict was that
// fixes get chosen a branch at a time and that a fix which handles four of five kinds passes.
// So no property here stops at its first failing entry: each one walks its WHOLE domain,
// collects every deviation, and fails once with all of them listed — split into
//
//   EXPECTED   the entry carries an `openFinding`, and it deviated. Known work.
//   UNEXPECTED the entry carries `openFinding: null`, and it deviated anyway. A REGRESSION, or
//              a domain member nobody had looked at. These are listed first and loudest.
//   STALE      the entry carries an `openFinding` and now HOLDS. The finding is closed and the
//              domain has not been told. Also a failure — a work order that lies is worse than
//              no work order.
//
// A fix that closes four of five kinds therefore fails on the fifth, by name, with the id of the
// input it missed. That is the whole design.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOMAINS, D1, D1_SOURCES, D1_RECOVERY, D2, D3, D4_INDEXES, D4_GROWTH, D5, D5_PROBES, D6,
  D6_VALUES, TAIL_COMPACT_AT, V1_BOARD_TEXT,
} from '../helpers/domains.js';

import {
  LS, LS_BOARD, LS_OPS, LS_CHECKPOINT, LS_SNAP, v2store, bootV2, v1board, note,
  J, session, bound, bootWith, slots, texts, cpOf, bornOf, SNAPSHOT, addNote, delNote,
} from '../attack/_round6-kit.js';
import { minter, DEV, PSP } from '../attack/_kit.js';

import * as storage from '../../src/js/storage.js';
import { oracle } from '../attack/_regression-harness.js';
import { buildBoard } from '../../src/js/layout.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The reporter. Every property below ends in `verdict(...)`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} domainId
 * @param {Array<{entry:Object, ok:boolean, got:*}>} results one per enumerated entry
 */
function verdict(domainId, results) {
  const d = DOMAINS[domainId];
  assert.equal(results.length, d.entries.length,
    `${domainId}: ${results.length} entries probed but the domain has ${d.entries.length} — `
    + 'a property that skips a domain member is exactly the failure this file exists to prevent');

  const unexpected = [];
  const expected = [];
  const stale = [];
  for (const r of results) {
    // A row this property does not own is counted for completeness and judged by the property
    // that does own it. Judging it here would report every finding as `stale` three times over.
    if (r.carried) continue;
    const known = r.entry.openFinding !== null && r.entry.openFinding !== undefined;
    if (!r.ok && !known) unexpected.push(r);
    else if (!r.ok && known) expected.push(r);
    // `partial` means this property checked a SUBSET of the entry's `expect` — a pass here is not
    // evidence that the finding is closed, only that the finding is not about this facet.
    else if (r.ok && known && !r.partial) stale.push(r);
  }
  if (!unexpected.length && !expected.length && !stale.length) return;

  const show = (r) => `    ${r.entry.id}  [${r.entry.openFinding ?? 'no finding'}]  ${r.entry.label}\n`
    + `        required: ${JSON.stringify(r.entry.expect)}\n`
    + `        measured: ${JSON.stringify(r.got)}`;

  const parts = [`${domainId} — ${d.title} (${d.subject})`,
    `  ${results.length} inputs enumerated · ${results.filter((r) => r.carried).length} owned elsewhere · `
    + `${results.filter((r) => r.ok && !r.carried).length} hold · `
    + `${expected.length} known-open · ${unexpected.length} UNEXPECTED · ${stale.length} stale`];
  if (unexpected.length) {
    parts.push('', '  UNEXPECTED — an input nobody had a finding for is behaving wrongly:',
      unexpected.map(show).join('\n'));
  }
  if (stale.length) {
    parts.push('', '  STALE — these now hold; close the finding and clear `openFinding`:',
      stale.map((r) => `    ${r.entry.id}  [${r.entry.openFinding}]  ${r.entry.label}`).join('\n'));
  }
  if (expected.length) {
    parts.push('', '  THE WORK ORDER — known-open findings, by input:',
      expected.map(show).join('\n'));
  }
  assert.fail(parts.join('\n'));
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D1 — `board.json` AS BYTES
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** A stub for the Tauri fs bridge. `loadBoardFile` reaches for `window.__TAURI__.core.invoke`. */
function withTauri(native, bytes, fn) {
  const w = globalThis.window;
  const had = Object.prototype.hasOwnProperty.call(w, '__TAURI__');
  const prev = w.__TAURI__;
  w.__TAURI__ = {
    core: {
      invoke: async (cmd) => {
        if (cmd !== 'load_board') throw new Error(`unexpected tauri command ${cmd}`);
        if (native === 'throws') throw new Error('EIO: the file is locked');
        if (native === 'missing') return null;
        return bytes;
      },
    },
  };
  try { return fn(); } finally { if (had) w.__TAURI__ = prev; else delete w.__TAURI__; }
}

/** The board's own legitimate lineage-bearing pair — so the log axis is held constant. */
let PAIR = null;
const VICTIM = () => v1board({
  notes: [note('n1', '2026-03-04', 'Zahnarzt'), note('n2', '2026-04-01', 'Steuer')],
});

describe('D1 · board.json as bytes', () => {
  before(async () => { PAIR = await bound(VICTIM()); });

  test('D1a — the BYTES decide the status, from either store', async () => {
    // The required rule, in its narrowest testable form: `loadBoardFile().status` is a function
    // of the bytes alone. Which of the two stores answered may change `fallback`; it may never
    // change `status`. R5-3c is the half of this that holds; R6-5a is the half that does not.
    const results = [];
    for (const e of D1) {
      if (!D1_SOURCES.some((s) => s.id === e.source) && e.source !== 'explicit' && e.source !== null) {
        continue;                                    // unreachable; the shape check below catches it
      }
      let got;
      LS.clear();
      if (e.source === null) {
        // a `{read}` marker: no bytes anywhere, expressed at the storage layer
        if (e.read === 'throws') {
          got = await withTauri('throws', null, () => storage.loadBoardFile());
        } else if (e.read === 'null') {
          got = await storage.loadBoardFile();       // plain browser, no key
        } else {
          got = { status: 'read-failed' };           // `no-record` is classifyBoardFile's own guard
        }
        got = { status: (await got).status ?? got.status };
      } else if (e.source === 'explicit') {
        const n = e.native;
        got = n.tauri
          ? { status: (await withTauri(n.native, null, () => storage.loadBoardFile())).status }
          : { status: (await storage.loadBoardFile()).status };
      } else {
        const src = D1_SOURCES.find((s) => s.id === e.source);
        const bytes = e.bytes;
        if (src.tauri) {
          if (src.fallbackHolds === 'bytes') LS.setItem(LS_BOARD, bytes);
          got = { status: (await withTauri(src.native, bytes, () => storage.loadBoardFile())).status };
        } else {
          LS.setItem(LS_BOARD, bytes);
          got = { status: (await storage.loadBoardFile()).status };
        }
      }
      // `partial`: D1a judges the STATUS facet only. The kind, the writability and the log are
      // D1b's and D1c's, and a `{}` that reports `ok` at the storage layer is CORRECT there —
      // its finding (R6-5c) lives one layer up.
      results.push({ entry: e, ok: got.status === e.expect.status, partial: true, got });
    }
    for (const e of D1_RECOVERY) results.push({ entry: e, ok: true, carried: true, got: 'covered by D1c' });
    verdict('D1', results);
  });

  test('D1b — the STATUS decides the kind, the writability and the log', async () => {
    // Probed on the browser source alone: D1a has already pinned that the source cannot change
    // the status, so crossing the boot with all four sources would measure the same thing 94
    // times. `mayWrite` is `bootFailure === null`, which is `persistNow`'s own read-only gate.
    const seen = new Set();
    const results = [];
    for (const e of D1) {
      if (e.source !== 'browser' && e.source !== null && e.source !== 'explicit') continue;
      if (seen.has(e.byteId ?? e.id)) continue;
      seen.add(e.byteId ?? e.id);

      let s;
      if (e.read === 'throws' || e.read === 'no-record') {
        LS.clear();
        LS.setItem(LS_BOARD, PAIR.board);
        if (PAIR.ops) LS.setItem(LS_OPS, PAIR.ops);
        LS.setItem(LS_CHECKPOINT, PAIR.checkpoint);
        LS.setItem(LS_SNAP, J(SNAPSHOT()));
        const proto = Object.getPrototypeOf(LS);
        const real = proto.getItem;
        proto.getItem = function (k) {
          if (String(k) === LS_BOARD) throw new Error('EIO: the file is locked');
          return real.call(this, k);
        };
        try { s = await bootV2(); } finally { proto.getItem = real; }
      } else if (e.read === 'null') {
        s = await bootWith({ ops: PAIR.ops, checkpoint: PAIR.checkpoint, snapshots: SNAPSHOT() });
      } else if (e.source === 'explicit') {
        results.push({ entry: e, ok: true, carried: true, got: 'storage-level only; covered by D1a' });
        continue;
      } else {
        s = await bootWith({ board: e.bytes, ops: PAIR.ops, checkpoint: PAIR.checkpoint, snapshots: SNAPSHOT() });
      }

      const reason = s.bootFailure?.reason ?? null;
      const kind = reason && reason.startsWith('board-') ? reason.slice('board-'.length)
        : s._recoveredFrom?.from === 'op-log' ? 'absent'
          : 'ok';
      const got = {
        status: e.expect.status,                     // pinned by D1a; not re-derived here
        kind,
        mayWrite: s.bootFailure === null,
        adoptsLog: s._recoveredFrom?.from === 'op-log',
        showsSnapshot: s._recoveredFrom?.from === 'snapshot',
      };
      const ok = got.kind === e.expect.kind && got.mayWrite === e.expect.mayWrite
        && got.adoptsLog === e.expect.adoptsLog && got.showsSnapshot === e.expect.showsSnapshot;
      results.push({ entry: e, ok, got });
    }
    // The rows this property does not own, carried through so the count still matches the domain.
    const owned = new Set(results.map((r) => r.entry.id));
    for (const e of [...D1, ...D1_RECOVERY]) {
      if (!owned.has(e.id)) results.push({ entry: e, ok: true, carried: true, got: 'covered by D1a / D1c' });
    }
    verdict('D1', results);
  });

  test('D1c — what is lying BESIDE the board file (the R6-6 axis)', async () => {
    const results = [];
    /** A checkpoint whose bytes are a header the loader will refuse. */
    const UNLOADABLE = '{"horizon":"NICHT EIN STAMP"}';
    /** A checkpoint that loads cleanly and projects to nothing at all. */
    const EMPTY_LOG = {
      horizon: null, regs: { v: 1, regs: {} },
      lzp: { v: 2, lineageId: 'lin_ZZZZZZZZZZZZZZZZZZZZZZZZZZ', gen: 1 },
    };
    for (const e of D1_RECOVERY) {
      const v = e.value;
      const snap = v.snapshot ? SNAPSHOT() : undefined;
      let s;
      if (v.board === 'ok') {
        const board = PAIR.board;
        if (v.log === 'none') s = await bootWith({ board, snapshots: snap });
        else if (v.log === 'this-board') s = await bootWith({ board, ops: PAIR.ops, checkpoint: PAIR.checkpoint, snapshots: snap });
        else {
          const theirs = await bound(v1board({ notes: [note('x1', '2026-02-02', 'FREMD')] }));
          const mine = await bound(VICTIM());
          s = await bootWith({ board: mine.board, ops: theirs.ops, checkpoint: theirs.checkpoint, snapshots: snap });
        }
      } else if (v.log === 'none') {
        s = await bootWith({ snapshots: snap });
      } else if (v.log === 'this-board') {
        s = await bootWith({ ops: PAIR.ops, checkpoint: PAIR.checkpoint, snapshots: snap });
      } else if (v.log === 'will-not-load') {
        s = await bootWith({ checkpoint: UNLOADABLE, snapshots: snap });
      } else {
        s = await bootWith({ checkpoint: EMPTY_LOG, snapshots: snap });
      }
      const from = s._recoveredFrom?.from ?? null;
      const shows = from === 'op-log' ? 'log'
        : from === 'snapshot' ? 'snapshot'
          : texts(s).length ? 'board' : 'nothing';
      const got = {
        shows, mayWrite: s.bootFailure === null,
        recoveredFrom: from === 'none' ? null : from,
        quarantine: s.quarantine?.reason ?? null,
        ...(e.expect.reconciled !== undefined ? { reconciled: s._adopted?.reconciled ?? null } : {}),
      };
      const ok = Object.keys(e.expect).every((k) => eq(got[k], e.expect[k]));
      results.push({ entry: e, ok, got });
    }
    for (const e of D1) results.push({ entry: e, ok: true, carried: true, got: 'covered by D1a / D1b' });
    verdict('D1', results);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D2 — A STAMP × AUTHORSHIP,  and  D3 — A LINE'S PROVENANCE
// ═════════════════════════════════════════════════════════════════════════════════════════════

const START = () => v1board({ notes: [note('n0', '2026-03-01', 'DER ANFANG')] });

async function seeded() {
  LS.clear();
  LS.setItem(LS_BOARD, J(START()));
  return session();
}

/** Mint the op this domain member describes, at the stamp it describes. */
function mintFor(value, foreign, marker) {
  // The DEVICE and the AUTHOR are independent, which is the whole point of D2-s22: `dev` decides
  // the stamp's 16-character short and the op's `dev` field, `act` decides who is claiming to
  // have written it, and only `act` may decide admission.
  const dev = value.deviceShort
    ? { id: DEV.mama.id, short: value.deviceShort, member: DEV.mama.member }
    : value.device === 'ours'
      ? { id: v2store._device, short: v2store._short, member: v2store._me }
      : (foreign ? DEV.mama : DEV.meDesk);
  const act = foreign ? DEV.mama.member : v2store._me;
  const mk = minter(dev, { act });
  const ms = value.rawTs !== undefined ? Date.now()
    : value.absMs !== undefined ? value.absMs
      : Date.now() + value.offsetMs;
  const op = mk('note.set', 'note:n0', { text: marker },
    { ms, space: PSP, ...(foreign ? {} : { actAs: v2store._me }) });
  return value.rawTs !== undefined ? { ...op, ts: value.rawTs } : op;
}

/** One full round: propose the op, persist, relaunch. */
async function probeStamp(value, foreign) {
  const marker = 'AUS DER DOMAENE';
  await seeded();
  await bootV2();
  v2store._opsPersisted = true;
  v2store.warnings.length = 0;
  const op = mintFor(value, foreign, marker);
  v2store.applyRemote([op]);
  const lines = v2store._log.lines();
  const mine = lines.find((l) => l.op && l.op.id === op.id) ?? null;
  const lineKept = mine !== null;
  const applied = v2store.state.notes[0].text === marker;
  const folded = lineKept && mine.park === null;
  v2store.mutate('edit', (st) => { st.notes[0].text = 'MEINE ECHTE AENDERUNG'; });
  await v2store.persistNow();
  const ridesInCheckpoint = (cpOf().parked ?? []).some((p) => p.op && p.op.id === op.id);
  const s = await bootV2();
  return {
    lineKept,
    folded,
    applied,
    park: mine ? mine.park : null,
    ridesInCheckpoint,
    quarantineNextLaunch: s.quarantine?.reason ?? null,
    historyAdoptedNextLaunch: s._adopted !== null,
    contentWhole: s.state.notes[0].text === 'MEINE ECHTE AENDERUNG',
  };
}

describe('D2 · a stamp, relative to this machine\'s clock, crossed with authorship', () => {
  test('D2 — every stamp × every author gets its required outcome', async () => {
    const results = [];
    for (const e of D2) {
      const got = await probeStamp(e.value, e.authorId === 'foreign');
      const ok = ['lineKept', 'folded', 'quarantineNextLaunch', 'historyAdoptedNextLaunch']
        .every((k) => eq(got[k], e.expect[k]));
      results.push({ entry: e, ok, got: { ...got, contentWhole: undefined } });
      if (e.stampId === 'D2-s06' && e.authorId === 'own') {
        // R6-4d, by name. Twelve hours ahead is INSIDE the window: it is applied, not parked, and
        // its value is on screen. If this ever stops being true, every "live" row in D2 is
        // vacuous — `folded` would be measuring a domain in which nothing is ever admitted.
        assert.equal(got.applied, true,
          'D2-s06/own: a stamp twelve hours ahead must be APPLIED (R6-4d) — the non-vacuity control');
      }
      // ADR 006 promise 4 is not part of any entry's `expect` because it is not negotiable:
      // whatever else goes wrong, the content of board.json survives. Asserted here, per input,
      // so that a "fix" that buys D2 with content is caught on the spot.
      assert.equal(got.contentWhole, true,
        `${e.id}: board.json's own edit did NOT survive — ADR 006 promise 4 is broken by this input`);
    }
    verdict('D2', results);
  });
});

describe('D3 · a log line\'s provenance', () => {
  test('D3 — five provenances, and the one that must not exist', async () => {
    const results = [];
    for (const e of D3) {
      if (e.expect.reachableToday === false) {
        // Enumerated and honestly unprobeable in WP-3. The assertion is that it is still
        // unprobeable — if a family space ever becomes constructible here, this row has to be
        // measured rather than declared.
        const ok = e.value.author === 'foreign' && e.expect.mustExist === true;
        results.push({ entry: e, ok, got: 'not constructible in WP-3: no family space can exist (A3-H4, F-5, F-6)' });
        continue;
      }
      const foreign = e.value.author === 'foreign';
      const value = e.value.park === 'future' ? { offsetMs: 48 * 60 * 60 * 1000 } : { offsetMs: 0 };
      const got = await probeStamp(value, foreign);
      const ok = got.lineKept === e.expect.keptAsLine
        && got.folded === e.expect.appliedToRegisters
        && got.ridesInCheckpoint === e.expect.ridesInCheckpoint;
      results.push({
        entry: e,
        ok,
        got: { keptAsLine: got.lineKept, appliedToRegisters: got.folded, ridesInCheckpoint: got.ridesInCheckpoint },
      });
    }
    verdict('D3', results);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D4 — CHECKPOINT GROWTH
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('D4 · checkpoint growth', () => {
  /** One run of the growth curve, sampled at every mark the domain names. */
  let curve = null;
  before(async () => {
    LS.clear();
    LS.setItem(LS_BOARD, J(v1board({ notes: [note('n0', '2026-03-01', 'A')] })));
    await session();
    await bootV2();
    v2store._opsPersisted = true;
    curve = new Map();
    let done = 0;
    for (const g of D4_GROWTH) {
      const target = g.value.opsEverWritten;
      while (done < target) {
        v2store.mutate('edit', (st) => { st.notes[0].text = `T${done}`; });
        done++;
        if (done % 50 === 0) await v2store.persistNow();
      }
      await v2store.persistNow();
      const c = cpOf();
      curve.set(target, {
        bodies: Object.keys(c.bodies ?? {}).length,
        seqs: Object.keys(c.seqs ?? {}).length,
        regs: Object.keys(c.regs?.regs ?? {}).length,
        parked: (c.parked ?? []).length,
        spliced: (c.spliced ?? []).length,
        cursors: Object.keys(c.cursors ?? {}).length,
        cpBytes: JSON.stringify(c).length,
        boardBytes: (LS.getItem(LS_BOARD) ?? '').length,
      });
    }
  });

  test('D4a — every index the checkpoint carries is bounded by the LIVE log, never by ops-ever', () => {
    const first = D4_GROWTH.find((g) => g.expect.baseline).value.opsEverWritten;
    const last = D4_GROWTH[D4_GROWTH.length - 1].value.opsEverWritten;
    const results = [];
    for (const e of D4_INDEXES) {
      const key = e.value === 'regs' ? 'regs' : e.value === 'seqs' ? 'seqs' : e.value;
      const a = curve.get(first)?.[key];
      const b = curve.get(last)?.[key];
      // `tsById` and `legacySeqByStamp` are internal to the log and ride inside `seqs` on disk;
      // measuring `seqs` measures the pruner that owns all three (`pruneSeqIndex`).
      const measured = a === undefined ? curve.get(last).seqs : b;
      const base = a === undefined ? curve.get(first).seqs : a;
      const grows = measured > Math.max(base, 8) * 1.5;
      results.push({
        entry: e,
        ok: grows === e.expect.growsWithOpsEver,
        got: { at: { [first]: base, [last]: measured }, growsWithOpsEver: grows },
      });
    }
    verdict('D4', [...results, ...D4_GROWTH.map((e) => ({ entry: e, ok: true, carried: true, got: 'covered by D4b' }))]);
  });

  test('D4b — `bodies` and the file itself, against ops-ever-written on a board that never grows', () => {
    const baseline = curve.get(D4_GROWTH.find((g) => g.expect.baseline).value.opsEverWritten);
    const results = [];
    for (const e of D4_GROWTH) {
      const m = curve.get(e.value.opsEverWritten);
      const ratio = baseline.cpBytes ? m.cpBytes / baseline.cpBytes : null;
      const ok = m.bodies <= e.expect.bodiesMax
        && (e.expect.cpBytesRatioMax === null || ratio <= e.expect.cpBytesRatioMax);
      results.push({
        entry: e, ok,
        got: { bodies: m.bodies, cpBytes: m.cpBytes, boardBytes: m.boardBytes, cpBytesRatio: ratio },
      });
    }
    // Non-vacuity: the board really did stay one note and four registers throughout.
    const marks = [...curve.values()];
    assert.deepEqual([...new Set(marks.map((m) => m.regs))], [4],
      'the BOARD must not grow across this curve, or the whole domain measures nothing');
    assert.ok(marks[marks.length - 1].bodies > 0 || TAIL_COMPACT_AT > 1e9,
      'no compaction ran at all — D4 is vacuous');
    verdict('D4', [...D4_INDEXES.map((e) => ({ entry: e, ok: true, carried: true, got: 'covered by D4a' })), ...results]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D5 — ARRAY ORDER AND `_born`
// ═════════════════════════════════════════════════════════════════════════════════════════════

const THREE = () => v1board({
  notes: [note('n1', '2026-03-01', 'EINS'), note('n2', '2026-03-02', 'ZWEI'), note('n3', '2026-03-03', 'DREI')],
});

describe('D5 · array order and `_born`', () => {
  let mint = null;
  let mintTail = null;
  let see = null;

  before(async () => {
    // PROBE `mint` — a Time-Machine restore of a board from before a delete in the MIDDLE.
    {
      const yesterday = await bound(THREE());
      await session(delNote('n2'));
      const today = slots();
      const s = await bootWith({ board: yesterday.board, ops: today.ops, checkpoint: today.checkpoint });
      mint = {
        quarantine: s.quarantine?.reason ?? null,
        orderFromBoard: eq(texts(s), ['EINS', 'ZWEI', 'DREI']),
      };
    }
    // PROBE `mint` again, without a Time Machine: the tail loses its OLDEST lines, which is what
    // the browser fallback's `slice(-LS_OPS_CAP)` does.
    {
      LS.clear();
      LS.setItem(LS_BOARD, J(v1board({ notes: [note('n1', '2026-03-01', 'EINS')] })));
      await session();
      await session(addNote('n2', 'ZWEI'));
      await session(addNote('n3', 'DREI'));
      const disk = slots();
      const kept = (disk.ops ?? '').split('\n').filter(Boolean).slice(1).join('\n');
      const s = await bootWith({ board: disk.board, ops: kept, checkpoint: disk.checkpoint });
      mintTail = {
        quarantine: s.quarantine?.reason ?? null,
        orderFromBoard: eq(texts(s), ['EINS', 'ZWEI', 'DREI']),
      };
    }
    // PROBE `see` — swap two `_born` stamps inside an adopted checkpoint. The store must notice.
    {
      const mineSlots = await bound(THREE());
      const cp = JSON.parse(mineSlots.checkpoint);
      const regs = cp.regs.regs;
      const a = regs['note:n1'];
      const b = regs['note:n3'];
      if (a && b && a._born && b._born) {
        const tmp = a._born.stamp ?? a._born.s;
        if (a._born.stamp !== undefined) { a._born.stamp = b._born.stamp; b._born.stamp = tmp; }
        else { a._born.s = b._born.s; b._born.s = tmp; }
      }
      const s = await bootWith({ board: mineSlots.board, ops: mineSlots.ops, checkpoint: J(cp) });
      see = {
        detected: s.quarantine !== null || !eq(texts(s), ['DREI', 'ZWEI', 'EINS']),
        quarantine: s.quarantine?.reason ?? null,
        order: texts(s),
      };
    }
  });

  test('D5a — the two capabilities, probed separately', () => {
    const got = { 'D5-probe-see': see, 'D5-probe-mint': mint, 'D5-probe-mint-tail': mintTail };
    const results = D5_PROBES.map((e) => ({
      entry: e,
      ok: Object.keys(e.expect).every((k) => eq(got[e.id][k], e.expect[k])),
      got: got[e.id],
    }));
    // Reported against D5's own four cells below; here the probes stand alone.
    const bad = results.filter((r) => !r.ok);
    assert.ok(bad.length === 0 || bad.every((r) => r.entry.openFinding),
      `D5: a probe with no finding deviated:\n${bad.map((r) => `  ${r.entry.id}: ${JSON.stringify(r.got)}`).join('\n')}`);
  });

  test('D5b — the build must be in cell (d): the reconciler can mint AND the post-condition can see', () => {
    const canSee = see.detected === true;
    const canMint = mint.quarantine === null && mint.orderFromBoard === true;
    const results = D5.map((e) => {
      const isThisCell = e.value.mint === canMint && e.value.see === canSee;
      // An entry holds when "is the build in this cell?" agrees with "is this cell required?".
      return { entry: e, ok: isThisCell === e.expect.required, got: { buildIsInThisCell: isThisCell, canMint, canSee } };
    });
    verdict('D5', results);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// D6 — BAR-EDGE AND DATE STRINGS, BY SORT POSITION
// ═════════════════════════════════════════════════════════════════════════════════════════════

const D6_TODAY = '2026-06-15';

function segs(state) {
  const b = buildBoard(state, { today: D6_TODAY });
  const out = [];
  for (const col of b.cols) {
    for (const s of col.segs ?? []) {
      out.push(`${col.key ?? col.month}:${s.startDay}-${s.endDay}${s.contTop ? '^' : ''}${s.contBot ? 'v' : ''}`);
    }
  }
  return out;
}
const cols = (list) => list.map((x) => x.split(':')[0]);
const B = (extra) => ({ id: 'b', label: 'Projekt', categoryId: 'cat-1', ...extra });

describe('D6 · bar-edge and date strings, by sort position', () => {
  test('D6a — the recorded oracle still describes `buildBoard()`', async () => {
    // The `v1` column of the domain was MEASURED. This is what stops it from quietly ceasing to
    // describe the renderer: every recorded paint is re-taken from `src/js/layout.js` and
    // compared. A failure here is not a defect in the store — it is the domain file gone stale,
    // and it must be fixed there before any row below means anything.
    const wrong = [];
    for (const v of D6_VALUES) {
      for (const field of ['startDate', 'endDate']) {
        const o = await oracle(v1board({ bars: [B({ [field]: v.value })] }));
        const now = segs(o.v1);
        if (!eq(now, v.v1[field])) {
          wrong.push(`  ${v.id} ${JSON.stringify(v.value)} ${field}\n    recorded: ${JSON.stringify(v.v1[field])}\n    measured: ${JSON.stringify(now)}`);
        }
      }
    }
    assert.equal(wrong.length, 0,
      `tests/helpers/domains.js's measured v1 oracle has ROTTED:\n${wrong.join('\n')}`);
  });

  test('D6b — v2 must paint what v1 painted, for every string in the alphabet', async () => {
    const results = [];
    for (const e of D6) {
      let got;
      let ok;
      if (e.field === 'note.date') {
        const o = await oracle(v1board({
          notes: [{ id: 'n', date: e.value, text: 'X', categoryId: 'cat-1', repeatsYearly: false }],
        }));
        got = { v1Kept: o.v1.notes.length, v2Kept: o.core.notes.length };
        ok = got.v2Kept === e.expect.v1Kept && got.v1Kept === e.expect.v1Kept;
      } else {
        const o = await oracle(v1board({ bars: [B({ [e.field]: e.value })] }));
        const v1 = segs(o.v1);
        const v2 = segs(o.core);
        const wrote = o.core.bars[0] ? o.core.bars[0][e.field] : undefined;
        got = { v1: v1.length, v2: v2.length, wrote, v1cols: cols(v1).join(','), v2cols: cols(v2).join(',') };
        ok = e.expect.paints === 'same-columns' ? eq(cols(v1), cols(v2)) : eq(v1, v2);
        if (ok && e.expect.kept !== null && e.expect.kept !== undefined) ok = wrote === e.expect.kept;
      }
      results.push({ entry: e, ok, got });
    }
    verdict('D6', results);
  });
});
