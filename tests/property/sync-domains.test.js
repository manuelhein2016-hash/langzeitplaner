// tests/property/sync-domains.test.js — ONE PROPERTY PER LIFECYCLE DOMAIN.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS SUITE IS EXPECTED TO BE RED, AND THE RED IS THE DELIVERABLE.
//
// `tests/helpers/sync-domains.js` enumerates the OP LIFECYCLE — every fate an op can meet
// between the relay and the board — and states, per entry, the behaviour that is REQUIRED. This
// file drives every one of those entries through the real store, the real op log, the real
// `openOp`, the shipped `sync/personal.js` engine and the real relay handlers, and asserts the
// required behaviour. The entries that fail are the fix phase's work order.
//
// The point is the shape of the failure report, not the failure. Every property walks its WHOLE
// domain, collects every deviation, and fails once with all of them listed — split into
//
//   UNEXPECTED an entry with `openFinding: null` deviated anyway. A REGRESSION, or a domain
//              member nobody had looked at. Listed first and loudest.
//   STALE      an entry carries an `openFinding` and now HOLDS. The finding is closed and the
//              domain has not been told. Also a failure — a work order that lies is worse than
//              no work order.
//   THE WORK ORDER  the known-open findings, by input.
//
// A fix that closes three of four park reasons therefore fails on the fourth, by name, with the
// id of the input it missed. That is the whole design, and it is why `domains.js`'s enumeration
// closed 51 findings in one pass and has held since.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS REAL HERE
//
// Everything the fleet harness makes real (`tests/helpers/fleet.js`): one full `store.js` module
// evaluation per Mac, each with its own `localStorage`; the shipped engine; real P-256 device
// identities that pass `assertDistinctIdentities()`; real `sealOp`/`openOp`; all 23 server
// handlers over `server/adapters/memory.js`. The only things this file adds are the four
// ARRANGEMENTS that produce an outcome the honest path cannot — a withheld attestation, a key
// ring that misses an epoch, a relay that edits one field of one envelope, and one envelope
// genuinely RE-SEALED under the author's own private key with an op kind this build has never
// heard of. Every one of them is a thing the world can do; none of them is a stub.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOMAINS, DOMAIN_SIZES, S1, S1_CELLS, S1_ENGINE, S1_SURVIVES, S2, S2_SCENARIOS, S3, S4, S5,
  S5_ENTRIES, OPEN_FINDINGS,
} from '../helpers/sync-domains.js';

import { createFleet, boardsAgree, registerDigest, simClock } from '../helpers/fleet.js';
import { reachableFrom } from '../helpers/importgraph.js';
import { nonDomModules } from '../helpers/privacy-audit.js';
import { b64u, ub64 } from '../../src/js/core/b64.js';
import { aadOf, pad, unpad } from '../../src/js/crypto/envelope.js';
import { canonicalJSON } from '../../src/js/core/canon.js';
import { signBytes } from '../../src/js/crypto/identity.js';
import { createSpaceKey } from '../../src/js/crypto/spacekeys.js';
import { MAX_DEFERRALS } from '../../src/js/sync/personal.js';
import { aesgcm } from '../../src/js/crypto/suite.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The reporter. Every property below ends in `verdict(...)`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} domainId
 * @param {Array<{entry:Object, ok:boolean, got:*, partial?:boolean}>} results one per entry
 */
function verdict(domainId, results) {
  const d = DOMAINS[domainId];
  assert.equal(results.length, d.entries.length,
    `${domainId}: ${results.length} entries probed but the domain has ${d.entries.length} — `
    + 'a property that skips a domain member is exactly the failure this file exists to prevent');
  assert.equal(d.entries.length, DOMAIN_SIZES[domainId],
    `${domainId}: the domain holds ${d.entries.length} entries and declares ${DOMAIN_SIZES[domainId]}`);

  const unexpected = [];
  const expected = [];
  const stale = [];
  for (const r of results) {
    const known = r.entry.openFinding !== null && r.entry.openFinding !== undefined;
    if (!r.ok && !known) unexpected.push(r);
    else if (!r.ok && known) expected.push(r);
    else if (r.ok && known && !r.partial) stale.push(r);
  }
  if (!unexpected.length && !expected.length && !stale.length) return;

  const show = (r) => `    ${r.entry.id}  [${r.entry.openFinding ?? 'no finding'}]  ${r.entry.label}\n`
    + `        required: ${JSON.stringify(r.entry.expect)}\n`
    + `        measured: ${JSON.stringify(r.got)}`;

  const parts = [`${domainId} — ${d.title} (${d.subject})`,
    `  ${results.length} inputs enumerated · ${results.filter((r) => r.ok).length} hold · `
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
// The fleet, and the five arrangements
// ═════════════════════════════════════════════════════════════════════════════════════════════

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'seed', date: '2027-03-04', text: 'Anfang', categoryId: 'c1', repeatsYearly: false }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const twoMacs = (over = {}) => createFleet({
  board: BOARD(), devices: ['A', 'B'], clock: simClock(Date.UTC(2026, 11, 10, 9, 0, 0)), ...over,
});

/**
 * ADR 001 §7.2's byte trigger, armed by hand — the same move `tests/fleet/long-offline.test.js`
 * §2b and `attack-converge-outbox.test.js` use. It is not a harness shortcut: `_tailOverBytes` is
 * set by `init()` from a real `ops.jsonl` over `TAIL_COMPACT_BYTES`, and setting it here is
 * exactly what a 2 MB log does on the next launch.
 */
const compact = async (dev) => { dev.store._tailOverBytes = true; await dev.persist(); };

/** Every op the RELAY holds for this space, by opId. The `A` axis of S2, measured at the source. */
const relayOpIds = async (f) => new Set((await f.relay.store.listOps(f.spaceId, 0n, 100000)).ops.map((o) => o.opId));
const relaySeqOf = async (f, oid) => {
  const row = (await f.relay.store.listOps(f.spaceId, 0n, 100000)).ops.find((o) => o.opId === oid);
  return row ? BigInt(row.seq) : null;
};

/** The opId of the line this Mac authored carrying `text`. Captured while the line still exists. */
const opIdFor = (dev, text) => {
  const line = dev.store._log.lines().find((l) => l.op && l.op.f && l.op.f.text === text);
  return line ? line.op.id : null;
};

const TE = new TextEncoder();
const TD = new TextDecoder();
const concatBytes = (...ps) => {
  let n = 0;
  for (const p of ps) n += p.length;
  const out = new Uint8Array(n);
  let i = 0;
  for (const p of ps) { out.set(p, i); i += p.length; }
  return out;
};

/** A relay that edits one field of every op envelope it serves to ONE victim. */
function editEnvelopesFor(f, victimShort, edit) {
  f.wire.hostile.onResponse = (res, req, dv) => {
    if (req.method === 'GET' && req.path === '/api/v1/ops' && dv === victimShort
        && res.body && Array.isArray(res.body.ops)) {
      for (const e of res.body.ops) edit(e);
    }
    return res;
  };
  return () => { f.wire.honest(); };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S1 — AN OP'S FATE, END TO END
// ═════════════════════════════════════════════════════════════════════════════════════════════

const MARK = 'vom anderen Mac';

/**
 * Drive ONE op from Mac A to Mac B under one arrangement, and report the measured triple.
 *
 * The measurement is a total function of the three axes and nothing else: it never asks which
 * branch ran, only what happened to the op. That is the whole method — a measurement written in
 * terms of branches would go stale the moment somebody adds an `else if`.
 */
async function measureFate(arrange) {
  const f = await twoMacs();
  const A = f.device('A');
  const B = f.device('B');
  await f.settle(2);

  const restore = (await arrange(f, A, B)) || (() => {});
  try {
    await A.apply('createNotePopover', { id: 'erstkontakt', date: '2027-05-06', text: MARK, categoryId: 'c1' });
    await A.push();
    const oid = opIdFor(A, MARK);
    const seq = await relaySeqOf(f, oid);
    assert.ok(oid && seq !== null, 'the arrangement never got the op onto the relay');

    await B.pull();

    const held = B.deferredOps().some((x) => x.oid === oid)
      || B.parked().some((l) => l.op && l.op.id === oid);
    const quarantined = B.quarantined().some((x) => x.oid === oid);
    const applied = B.state.notes.some((n) => n.text === MARK);
    const cursorPast = BigInt(B.cursor()) >= seq;

    let engine;
    if (applied) engine = 'applied';
    else if (held) engine = 'deferred';
    else if (quarantined) engine = 'quarantined';
    else engine = cursorPast ? 'cursor-released' : 'dropped';

    restore();
    await B.relaunch();

    const survives = await survivesAfterRelaunch(B, oid);
    return { engine, cursor: cursorPast ? 'released' : 'held', survives };
  } finally {
    restore();
  }
}

/**
 * Axis C, measured on a FRESH PROCESS: the strongest thing this Mac can still find.
 *
 * THERE ARE TWO DURABLE PARKS AND BOTH ARE THE ANSWER TO THIS QUESTION. The LOG's park
 * (`checkpoint().parked`) holds ops this build can read and will not apply — a future stamp, an
 * unattested device. The ENGINE's park (`sync/outbox.js`'s parking lot, behind the `parkStore`
 * port) holds SEALED ENVELOPES this build cannot read yet, because P1, P4 and the version gate
 * all refuse BEFORE the decrypt and there is no op to hand `oplog.park()`. Reading only the first
 * would report `nothing` for exactly the four inputs P-8 is about, which is measuring the fix out
 * of existence rather than measuring the build.
 *
 * `heldEnvelopes()` loads the lot off this device's disk, so this is a genuine fresh-process
 * question and not a memory read: the engine was rebuilt by `relaunch()`.
 */
async function survivesAfterRelaunch(B, oid) {
  if (B.state.notes.some((n) => n.text === MARK)) return 'op';
  if (B.parked().some((l) => l.op && l.op.id === oid && l.park)) return 'park-reason';
  const held = await B.heldEnvelopes();
  if (held.some((r) => r.oid === oid && typeof r.reason === 'string' && r.reason !== '')) return 'park-reason';
  if (B.quarantined().some((x) => x.oid === oid)
      || (B.storeDiagnostics().sync.refused ?? 0) > 0) return 'quarantine';
  return 'nothing';
}

/**
 * The one arrangement that cannot be done with a field edit: an envelope carrying an op kind this
 * build has never heard of.
 *
 * `sealOp` refuses to seal one — "we are the author; an op our own build would park is a bug on
 * this machine" — so the ONLY producer in the world is a NEWER BUILD, which is precisely the case
 * ADR 002 §1's "versioning, not negotiation" is written for. So the envelope is built the way a
 * newer build would build it: the real one is captured off the wire, decrypted under the real
 * space key, its `k` changed, re-canonicalised, re-padded, re-encrypted under the SAME key, iv and
 * AAD, and RE-SIGNED with Mac A's own private signing key. Every one of `openOp`'s gates — the
 * header, P1, P2, P3, P4, the five identity checks — passes on it, and it parks at the last one.
 * Nothing here is stubbed: if the re-seal were wrong, the probe would measure a P3 throw and the
 * `park:unknownKind` row would report the wrong outcome rather than a false pass.
 */
async function measureUnknownKindFate() {
  const f = await twoMacs();
  const A = f.device('A');
  const B = f.device('B');
  await f.settle(2);
  await A.apply('createNotePopover', { id: 'erstkontakt', date: '2027-05-06', text: MARK, categoryId: 'c1' });
  await A.push();
  const oid = opIdFor(A, MARK);
  const seq = await relaySeqOf(f, oid);

  // Phase 1 — capture the envelope and serve B an empty page, so the cursor does not move.
  let captured = null;
  f.wire.hostile.onResponse = (res, req, dv) => {
    if (req.method === 'GET' && req.path === '/api/v1/ops' && dv === B.short && res.body?.ops?.length) {
      captured = { ...res.body.ops[0] };
      res.body = { ops: [], hasMore: false, nextCursor: '0' };
    }
    return res;
  };
  await B.pull();
  assert.ok(captured, 'nothing was captured off the wire');
  assert.equal(B.cursor(), '0', 'the capture moved the cursor; the measurement below would be of the wrong thing');

  // Phase 2 — re-seal it as a newer build would have.
  const key = B.ring.get(captured.sp, captured.ep);
  const iv = ub64(captured.iv);
  const aad = aadOf(captured);
  const padded = new Uint8Array(await crypto.subtle.decrypt(aesgcm(iv, aad), key, ub64(captured.ct)));
  const op = JSON.parse(TD.decode(unpad(padded)));
  op.k = 'note.zukunft';                                     // a kind no build in this tree knows
  const text = canonicalJSON(op);
  const ct = new Uint8Array(await crypto.subtle.encrypt(aesgcm(iv, aad), key, pad(TE.encode(text))));
  const sig = await signBytes(A.keys.identity.devSig.privateKey, concatBytes(aad, iv, ct), {});
  const forward = { ...captured, ct: b64u(ct), sig: b64u(sig) };

  f.wire.hostile.onResponse = (res, req, dv) => {
    if (req.method === 'GET' && req.path === '/api/v1/ops' && dv === B.short) {
      res.body = { ops: [{ ...forward, seq: String(seq) }], hasMore: false, nextCursor: String(seq) };
    }
    return res;
  };
  await B.pull();

  const held = B.deferredOps().some((x) => x.oid === oid) || B.parked().some((l) => l.op && l.op.id === oid);
  const quarantined = B.quarantined().some((x) => x.oid === oid);
  const applied = B.state.notes.some((n) => n.text === MARK);
  const cursorPast = BigInt(B.cursor()) >= seq;
  let engine;
  if (applied) engine = 'applied';
  else if (held) engine = 'deferred';
  else if (quarantined) engine = 'quarantined';
  else engine = cursorPast ? 'cursor-released' : 'dropped';

  f.wire.honest();
  await B.relaunch();
  const survives = await survivesAfterRelaunch(B, oid);
  return { engine, cursor: cursorPast ? 'released' : 'held', survives };
}

/** deviceShort → withhold its attestation from `openOp`'s P1 port. F-6's own scenario. */
const withholdAttestation = async (f, A) => {
  const att = f.attestations.get(A.short);
  f.attestations.delete(A.short);
  return () => { f.attestations.set(A.short, att); };
};

/** ADR 002 §4.4 — a member offline across a rotation: the ring has no key for that epoch. */
const emptyKeyRing = async (f, A, B) => {
  const get = B.ring.get;
  B.ring.get = () => null;
  return () => { B.ring.get = get; };
};

/** ADR 002 §3 barrier 3 — the right ciphertext under the wrong key. */
const wrongKeyRing = async (f, A, B) => {
  const other = await createSpaceKey();
  const get = B.ring.get;
  B.ring.get = () => other;
  return () => { B.ring.get = get; };
};

/** @type {Record<string, {engine:string, cursor:string, survives:string}>} */
const FATES = {};

describe('S1 · an op\'s fate, end to end', () => {
  before(async () => {
    FATES['ok'] = await measureFate(async () => {});
    FATES['park:attestation'] = await measureFate(withholdAttestation);
    FATES['park:epoch'] = await measureFate(emptyKeyRing);
    FATES['park:version'] = await measureFate(async (f, A, B) => editEnvelopesFor(f, B.short, (e) => { e.v = 99; }));
    FATES['park:unknownKind'] = await measureUnknownKindFate();
    FATES['terminal:signature'] = await measureFate(async (f, A, B) => editEnvelopesFor(f, B.short, (e) => {
      const s = ub64(e.sig); s[3] ^= 0xff; e.sig = b64u(s);
    }));
    FATES['terminal:aead'] = await measureFate(wrongKeyRing);
    FATES['terminal:malformed'] = await measureFate(async (f, A, B) => editEnvelopesFor(f, B.short, (e) => {
      e.iv = b64u(new Uint8Array(5));
    }));
  });

  test('S1a — every openOp outcome has a decided fate, and a park is never a drop', () => {
    const results = S1.map((e) => {
      const got = FATES[e.value];
      return { entry: e, ok: eq(got, e.expect), got };
    });
    verdict('S1', results);
  });

  test('S1b — the full 8 × 5 × 4 grid: the build is in the required cell and in no other', () => {
    // D5b's shape, three axes wide. "A park must never become a drop" is not a sentence in a
    // docblock here: it is 32 cells whose `required` is false, each of which the build must stay
    // out of. A fix that turns a quarantine into a defer for `attestation` and forgets `epoch`
    // fails on `S1c-park:epoch-quarantined-nothing`, by name.
    const results = S1_CELLS.map((e) => {
      const got = FATES[e.value.outcome];
      const inThisCell = got.engine === e.value.engine && got.survives === e.value.survives;
      return {
        entry: e,
        ok: inThisCell === e.expect.required,
        got: { buildIsInThisCell: inThisCell, measured: got },
      };
    });
    verdict('S1_CELLS', results);
  });

  test('S1c — the axes are total: every measured value is one the domain names', () => {
    // The guard that stops the two properties above from passing on a typo. A measurement that
    // produced `undefined` would compare unequal to every cell and would quietly satisfy the
    // 158 `required: false` cells while failing only two — which reads like the finding.
    const engines = new Set(S1_ENGINE.map((x) => x.id));
    const survivals = new Set(S1_SURVIVES.map((x) => x.id));
    for (const e of S1) {
      const got = FATES[e.value];
      assert.ok(got, `${e.id}: no measurement was taken`);
      assert.ok(engines.has(got.engine), `${e.id}: measured engine ${JSON.stringify(got.engine)} is not on axis B`);
      assert.ok(survivals.has(got.survives), `${e.id}: measured survival ${JSON.stringify(got.survives)} is not on axis C`);
      assert.ok(['held', 'released'].includes(got.cursor), `${e.id}: measured cursor ${JSON.stringify(got.cursor)}`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S2 — AN OP'S DURABILITY ACROSS A RESTART
// ═════════════════════════════════════════════════════════════════════════════════════════════

const cellId = (c) => `S2-R${+c.R}L${+c.L}A${+c.A}O${+c.O}`;

/** The four facts, all measured after a real quit-and-relaunch on the same disk. */
async function cellOf(f, dev, oid, text) {
  const line = oid === null ? null : dev.store._log.lines().find((l) => l.op && l.op.id === oid);
  const onRelay = await relayOpIds(f);
  return {
    R: text !== null && dev.state.notes.some((n) => n.text === text),
    L: !!line,
    A: oid !== null && onRelay.has(oid),
    O: oid !== null && dev.store.outbox().some((l) => l.op && l.op.id === oid),
  };
}

/** @type {Record<string, {cell:string, facts:Object}>} */
const JOURNEYS = {};

describe('S2 · an op\'s durability across a restart', () => {
  before(async () => {
    // S2s-online — author, push, ack, persist, relaunch.
    {
      const f = await twoMacs();
      const A = f.device('A');
      await f.settle(2);
      await A.apply('createNotePopover', { id: 'on1', date: '2027-05-06', text: 'ONLINE', categoryId: 'c1' });
      const oid = opIdFor(A, 'ONLINE');
      await A.push();
      await A.relaunch();
      const facts = await cellOf(f, A, oid, 'ONLINE');
      JOURNEYS['S2s-online'] = { cell: cellId(facts), facts };
    }
    // S2s-offline — the train. `_outboxHorizonCap` is what makes this survive.
    {
      const f = await twoMacs();
      const A = f.device('A');
      await f.settle(2);
      A.offline();
      await A.apply('createNotePopover', { id: 'off1', date: '2027-05-07', text: 'ZUG', categoryId: 'c1' });
      const oid = opIdFor(A, 'ZUG');
      await A.persist();
      await A.relaunch();
      const facts = await cellOf(f, A, oid, 'ZUG');
      JOURNEYS['S2s-offline'] = { cell: cellId(facts), facts };
    }
    // S2s-compact-sandwich — byte for byte the same requirement, with an ordinary compaction
    // on either side of the edit. `TAIL_COMPACT_AT` is 1500 lines; `TAIL_COMPACT_BYTES` is 2 MB
    // at launch. Neither is exotic at story 19.6's scale.
    {
      const f = await twoMacs();
      const A = f.device('A');
      await f.settle(2);
      await compact(A);
      A.offline();
      await A.apply('createNotePopover', { id: 'sw1', date: '2027-05-08', text: 'SANDWICH', categoryId: 'c1' });
      const oid = opIdFor(A, 'SANDWICH');
      await compact(A);
      await A.relaunch();
      const facts = await cellOf(f, A, oid, 'SANDWICH');
      JOURNEYS['S2s-compact-sandwich'] = { cell: cellId(facts), facts };
    }
    // S2s-parked — a peer op held for a missing attestation, then compacted, then relaunched.
    {
      const f = await twoMacs();
      const A = f.device('A');
      const B = f.device('B');
      await f.settle(2);
      B.store._peerDevices = new Set();          // ADR 001 §4.0's local device set, not yet written
      await A.apply('createNotePopover', { id: 'pk1', date: '2027-05-09', text: 'GEPARKT', categoryId: 'c1' });
      const oid = opIdFor(A, 'GEPARKT');
      await A.push();
      await B.pull();
      await compact(B);
      await B.relaunch();
      const facts = await cellOf(f, B, oid, 'GEPARKT');
      JOURNEYS['S2s-parked'] = { cell: cellId(facts), facts };
    }
    // S2s-never — the control at the bottom of the grid.
    {
      const f = await twoMacs();
      const A = f.device('A');
      await f.settle(2);
      await A.relaunch();
      const facts = await cellOf(f, A, 'AAAAAAAAAAAAAAAAAAAAAA', 'NIE GESCHRIEBEN');
      JOURNEYS['S2s-never'] = { cell: cellId(facts), facts };
    }
  });

  test('S2a — every journey ends in the cell it is required to end in', () => {
    const results = S2_SCENARIOS.map((e) => {
      const got = JOURNEYS[e.id];
      return { entry: e, ok: got.cell === e.expect.cell, got };
    });
    verdict('S2_SCENARIOS', results);
  });

  test('S2b — all sixteen combinations: no journey ends in an inadmissible one', () => {
    const landed = new Set(Object.values(JOURNEYS).map((j) => j.cell));
    const required = new Set(S2_SCENARIOS.map((e) => e.expect.cell));
    const results = S2.map((e) => {
      const here = landed.has(e.id);
      const ok = (here ? e.expect.admissible : true)
        && (e.expect.mustBeReachable ? here : true);
      return {
        entry: e,
        ok,
        got: {
          aJourneyEndedHere: here,
          requiredByAJourney: required.has(e.id),
          journeys: Object.entries(JOURNEYS).filter(([, j]) => j.cell === e.id).map(([k]) => k),
        },
      };
    });
    verdict('S2', results);
  });

  test('S2c — the grid and the journeys agree about which cells are required', () => {
    // The check that keeps the two halves of this domain in step. A scenario whose required cell
    // is not marked `mustBeReachable` would let S2b pass while S2a fails, and the report would
    // then say the build is fine in a cell nothing is required to reach.
    for (const s of S2_SCENARIOS) {
      const cell = S2.find((c) => c.id === s.expect.cell);
      assert.ok(cell, `${s.id} requires cell ${s.expect.cell}, which the grid does not contain`);
      assert.equal(cell.expect.mustBeReachable, true,
        `${s.id} requires ${cell.id}, but the grid does not mark it mustBeReachable`);
      assert.equal(cell.expect.admissible, true,
        `${s.id} requires ${cell.id}, which the grid says is inadmissible`);
    }
    const mustReach = S2.filter((c) => c.expect.mustBeReachable).map((c) => c.id).sort();
    const required = [...new Set(S2_SCENARIOS.map((e) => e.expect.cell))].sort();
    assert.deepEqual(mustReach, required,
      'a cell is marked mustBeReachable that no journey is required to reach, or the other way round');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S3 — COMPACTION × LIFECYCLE
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * What, if anything, this Mac is able to SAY about its own state. The field names below are the
 * ones a fix has to add; reading them off `diagnostics()` rather than inventing a new seam means
 * the required behaviour is expressed in the product's own vocabulary.
 */
function reportsOf(dev) {
  const d = dev.storeDiagnostics();
  if (d.sync.parked) return 'the held op, by name';
  if (d.sync.refused) return 'the refusal, by name and reason';
  if (d.sync.lost) return 'the folded-away line, by name';
  const s = dev.status().state;
  return s === 'healthy' ? 'nothing to report' : `status=${s}`;
}

/** @type {Record<string, Object>} */
const CROSSINGS = {};

describe('S3 · compaction × lifecycle', () => {
  before(async () => {
    // S3-unacked — compact ▸ author ▸ compact, with the edit still in the outbox.
    {
      const f = await twoMacs();
      const A = f.device('A');
      const B = f.device('B');
      await f.settle(2);
      await compact(A);
      A.offline();
      await A.apply('createNotePopover', { id: 'u1', date: '2027-06-01', text: 'UNACKED', categoryId: 'c1' });
      const oid = opIdFor(A, 'UNACKED');
      await compact(A);
      const line = A.store._log.lines().find((l) => l.op && l.op.id === oid);
      const inOutbox = A.store.outbox().some((l) => l.op && l.op.id === oid);
      A.online();
      await f.settle(3);
      CROSSINGS['S3-unacked'] = {
        survives: line && inOutbox ? 'line-and-outbox' : line ? 'line-only' : 'nothing',
        converges: boardsAgree([A, B]).equal,
        reports: reportsOf(A),
        detail: boardsAgree([A, B]).detail,
      };
    }
    // S3-parked — a compaction while an op is parked under ATTESTATION.
    {
      const f = await twoMacs();
      const A = f.device('A');
      const B = f.device('B');
      await f.settle(2);
      const peers = [...B.store._peerDevices];
      B.store._peerDevices = new Set();
      await A.apply('createNotePopover', { id: 'p1', date: '2027-06-02', text: 'PARKED', categoryId: 'c1' });
      const oid = opIdFor(A, 'PARKED');
      await A.push();
      // THE LADDER RUNS OUT FIRST, and it has to: while the cursor is still held, the ordinary
      // re-pull cures the hold on its own (measured — that is rung 2 working). ADR 003 §8.2 is
      // explicit that "a permanently rejected op must never silently spin forever", so after
      // `MAX_DEFERRALS` fruitless pulls the engine RELEASES the cursor. From that instant the
      // relay's `since` filter will never serve the op again and the PARKED LINE IS THE ONLY COPY
      // this Mac can reach — which is the precondition L-3 is about, and it is reached by nothing
      // more exotic than a peer that stayed offline for six pull cycles.
      for (let i = 0; i <= MAX_DEFERRALS; i++) await B.pull();
      await compact(B);
      await B.relaunch();
      // ── `survives` IS MEASURED HERE, AND THE THREE COLUMNS ARE NOT ONE MOMENT ────────────────
      //
      // This row's label names two events — "a compaction while an op is parked under
      // ATTESTATION, THEN the launch that cures it" — and its three columns are requirements
      // about different ones. `survives: 'line-and-park-reason'` is ADR 001 §7.2's promise that a
      // compaction never touches a parked line, and it is a fact about the state BEFORE the cure:
      // after the cure the line is applied and carries no park reason, by design. Reading all
      // three at the end made `survives: 'line-and-park-reason'` and `converges: true` jointly
      // impossible — a parked line is in no register, so a build that satisfied the first could
      // never satisfy the second. Neither `expect` is changed; each column is read at the moment
      // its requirement is about.
      const held = B.store._log.lines().find((l) => l.op && l.op.id === oid);
      const survives = held && held.park ? 'line-and-park-reason' : held ? 'line-only' : 'nothing';
      const parkReason = held ? held.park ?? null : null;
      // THE NEXT LAUNCH, modelled exactly: `family/engine.js:141` fills `store._peerDevices` from
      // the peers list at every start, so by now the device set is CORRECT and the held line is
      // authorised. `dev.relaunch()` skips `useIdentity()` once the identity is durable, which is
      // what a real relaunch does, so the set has to be restored here rather than by the harness.
      for (const d of peers) B.store._peerDevices.add(d);
      await B.catchUp(4);
      await f.settle(2);
      CROSSINGS['S3-parked'] = {
        survives,
        converges: boardsAgree([A, B]).equal,
        reports: reportsOf(B),
        park: parkReason,
      };
    }
    // S3-quarantined — a terminal refusal, a compaction, and a relaunch.
    {
      const f = await twoMacs();
      const A = f.device('A');
      const B = f.device('B');
      await f.settle(2);
      const restore = editEnvelopesFor(f, B.short, (e) => { const s = ub64(e.sig); s[3] ^= 0xff; e.sig = b64u(s); });
      await A.apply('createNotePopover', { id: 'q1', date: '2027-06-03', text: 'REFUSED', categoryId: 'c1' });
      await A.push();
      await B.pull();
      restore();
      await compact(B);
      await B.relaunch();
      const d = B.storeDiagnostics();
      CROSSINGS['S3-quarantined'] = {
        survives: B.quarantined().length || (d.sync.refused ?? 0) > 0 || d.quarantine
          ? 'a durable refusal record' : 'nothing',
        converges: boardsAgree([A, B]).equal,
        reports: reportsOf(B),
      };
    }
    // S3-cursor — a compaction between two pages of one pull. `LIMITS.opsPerPull` is large, so
    // the page boundary is made by hand: B pulls once, compacts, and pulls again.
    {
      const f = await twoMacs();
      const A = f.device('A');
      const B = f.device('B');
      await f.settle(2);
      await A.apply('createNotePopover', { id: 'c1a', date: '2027-06-04', text: 'SEITE EINS', categoryId: 'c1' });
      await A.push();
      await B.pull();
      const mid = B.cursor();
      await compact(B);
      await B.relaunch();
      const after = B.cursor();
      await A.apply('createNotePopover', { id: 'c2a', date: '2027-06-05', text: 'SEITE ZWEI', categoryId: 'c1' });
      await f.settle(3);
      CROSSINGS['S3-cursor'] = {
        survives: after === mid ? 'the cursor, exactly where it was' : `moved from ${mid} to ${after}`,
        converges: boardsAgree([A, B]).equal,
        reports: reportsOf(B),
      };
    }
    // S3-peer-behind — B is away for weeks; A compacts twice; B comes back.
    {
      const f = await twoMacs();
      const A = f.device('A');
      const B = f.device('B');
      await f.settle(2);
      B.offline();
      for (let i = 0; i < 6; i++) {
        await A.apply('createNotePopover', { id: `w${i}`, date: '2027-07-0' + (i + 1), text: `WOCHE ${i}`, categoryId: 'c1' });
        await A.push();
      }
      await compact(A);
      await A.apply('createNotePopover', { id: 'w9', date: '2027-07-09', text: 'WOCHE 9', categoryId: 'c1' });
      await A.push();
      await compact(A);
      B.online();
      await B.catchUp(8);
      await f.settle(3);
      const missing = ['WOCHE 0', 'WOCHE 9'].filter((t) => !B.state.notes.some((n) => n.text === t));
      CROSSINGS['S3-peer-behind'] = {
        survives: missing.length === 0 ? 'every op B has not seen' : `missing ${missing.join(', ')}`,
        converges: boardsAgree([A, B]).equal,
        reports: reportsOf(B),
      };
    }
  });

  test('S3a — every crossing of a compaction with a lifecycle state has a decided answer', () => {
    const results = S3.map((e) => {
      const got = CROSSINGS[e.id];
      const ok = got.survives === e.expect.survives
        && got.converges === e.expect.converges
        && got.reports === e.expect.reports;
      return { entry: e, ok, got };
    });
    verdict('S3', results);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S4 — WHAT THE USER AND THE SYSTEM CAN OBSERVE
//
// Story 19.3: „Stille bedeutet Gesundheit." That is a good design and it is a PROMISE. This
// property is the promise, written as a table: for every state the engine can be in, what does
// `sync.status()` say, what does `store.diagnostics()` say, and does the answer survive a quit?
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The first `store.diagnostics()` field that NAMES this situation, or null when none does. */
function storeReportsOf(dev) {
  const d = dev.storeDiagnostics();
  if ((d.sync.parked ?? 0) > 0) return 'sync.parked';
  if ((d.sync.refused ?? 0) > 0) return 'sync.refused';
  if ((d.sync.lost ?? 0) > 0) return 'sync.lost';
  if (d.sync.chain) return 'sync.chain';
  if ((d.sync.outbox ?? 0) > 0) return 'sync.outbox';
  if (Array.isArray(d.warnings) && d.warnings.length > 0) return 'warnings';
  return null;
}

/** @type {Record<string, {status:string, storeReports:?string, survives:boolean}>} */
const OBSERVED = {};

describe('S4 · what the user and the system can observe', () => {
  before(async () => {
    // S4-quiet — the control. Silence is TRUE here and must stay free.
    {
      const f = await twoMacs();
      const A = f.device('A');
      await f.settle(3);
      await A.relaunch();
      await f.settle(1);
      OBSERVED['S4-quiet'] = { status: A.status().state, storeReports: storeReportsOf(A), survives: true };
    }
    // S4-pending — the second control, and the one observable that already survives properly.
    {
      const f = await twoMacs();
      const A = f.device('A');
      await f.settle(2);
      A.offline();
      await A.apply('createNotePopover', { id: 'pd1', date: '2027-08-01', text: 'WARTET', categoryId: 'c1' });
      const before = { status: A.status().state, storeReports: storeReportsOf(A) };
      await A.relaunch();
      OBSERVED['S4-pending'] = {
        ...before,
        survives: A.status().state === before.status && storeReportsOf(A) === before.storeReports,
      };
    }
    // S4-held — an op parked under ATTESTATION, durably, with its reason.
    {
      const f = await twoMacs();
      const A = f.device('A');
      const B = f.device('B');
      await f.settle(2);
      B.store._peerDevices = new Set();
      await A.apply('createNotePopover', { id: 'hd1', date: '2027-08-02', text: 'GEHALTEN', categoryId: 'c1' });
      await A.push();
      await B.pull();
      await B.relaunch();
      const stillHeld = B.parked().some((l) => l.park);
      OBSERVED['S4-held'] = {
        status: B.status().state,
        storeReports: storeReportsOf(B),
        survives: stillHeld && (B.status().state !== 'healthy' || storeReportsOf(B) !== null),
      };
    }
    // S4-refused — a refusal that is correct, final, and forgotten.
    {
      const f = await twoMacs();
      const A = f.device('A');
      const B = f.device('B');
      await f.settle(2);
      const restore = editEnvelopesFor(f, B.short, (e) => { const s = ub64(e.sig); s[3] ^= 0xff; e.sig = b64u(s); });
      await A.apply('createNotePopover', { id: 'rf1', date: '2027-08-03', text: 'ABGELEHNT', categoryId: 'c1' });
      await A.push();
      await B.pull();
      const before = { status: B.status().state, storeReports: storeReportsOf(B) };
      restore();
      await B.relaunch();
      OBSERVED['S4-refused'] = {
        ...before,
        survives: B.status().state === before.status && storeReportsOf(B) === before.storeReports,
      };
      // The same relaunched Mac is what S4-warnings is measured on: a session in which something
      // WAS refused, read after the quit.
      //
      // ── FINDING L-5, AND WHY THIS ONE ROW DOES NOT READ `storeReportsOf` ──────────────────────
      //
      // `storeReportsOf` is FIRST-MATCH-WINS over a priority chain, and `sync.refused` sits above
      // `warnings` in it. S4-refused REQUIRES this device, at this moment, to answer
      // `'sync.refused'` (that is L-1: the refusal must outlive the session). S4-warnings REQUIRES
      // the same device at the same moment to answer `'warnings'`. **No implementation can
      // satisfy both**, and the contradiction is in the ENUMERATION, not in the build: it was
      // invisible while L-1 was open, because a refusal that died with the session left `warnings`
      // as the only surviving answer, which is exactly the state the row was written against.
      //
      // Neither `expect` is relaxed — both are unchanged, and both keep their teeth. What changes
      // is that S4-warnings asks ITS OWN question, which is what its `value` says it is about:
      // "everything this layer wrote down about what it could not do". A channel is not a contest
      // for a one-line report, and reading it through one is what made the two rows collide.
      const wrote = (B.storeDiagnostics().warnings || []).length > 0;
      OBSERVED['S4-warnings'] = {
        status: B.status().state,
        storeReports: wrote ? 'warnings' : storeReportsOf(B),
        survives: wrote,
      };
    }
    // S4-lost — E5-2. The edit is on the board, in nobody's outbox, and on one Mac only.
    //
    // ── THE ARRANGEMENT CHANGED, AND THE REQUIREMENT DID NOT ─────────────────────────────────
    //
    // `compact ▸ author offline ▸ compact` no longer loses anything: that arm of
    // `_outboxHorizonCap()` is fixed, and `S2s-compact-sandwich` and `S3-unacked` are the receipts.
    // Reading this row off that script would now measure a Mac with nothing to report and call
    // its silence a failure, which is backwards.
    //
    // The state this row NAMES — "an unacknowledged line folded away by a compaction" — is still
    // reachable, and it is the one arm that genuinely cannot be recovered: a CHECKPOINT WRITTEN
    // BY A BUILD WITHOUT THE CAP, whose horizon already folds an op the relay never saw. That is
    // on real disks today, it is what `_outboxHorizonCap`'s stand-down warning says in its own
    // words ("on a log written before the cap landed"), and the app cannot get the DATA back. It
    // can and must recover the FACT — which is the requirement, unchanged.
    //
    // The old build is modelled by removing the cap for exactly one persist. Nothing is hand-
    // written into the file: the bytes are produced by this store, through `persistNow`, taking
    // the path it took before the fix.
    {
      const f = await twoMacs();
      const A = f.device('A');
      const B = f.device('B');
      await f.settle(2);
      await compact(A);
      A.offline();
      await A.apply('createNotePopover', { id: 'ls1', date: '2027-08-04', text: 'VERLOREN', categoryId: 'c1' });
      const capped = A.store._outboxHorizonCap;
      A.store._outboxHorizonCap = () => undefined;        // the build before the cap existed
      await compact(A);
      A.store._outboxHorizonCap = capped;
      A.online();
      await f.settle(3);
      await A.relaunch();
      await f.settle(2);
      const diverged = !boardsAgree([A, B]).equal;
      assert.equal(diverged, true,
        'the arrangement did not produce a loss, so S4-lost is measuring nothing — fix the '
        + 'arrangement before reading the row');
      OBSERVED['S4-lost'] = {
        status: A.status().state,
        storeReports: storeReportsOf(A),
        survives: diverged ? (A.status().state !== 'healthy' || storeReportsOf(A) !== null) : true,
      };
    }
    // S4-diverged — ADR 002 §5.4's fork: a relay that withholds from ONE Mac, both self-consistent.
    {
      const f = await twoMacs();
      const A = f.device('A');
      const B = f.device('B');
      await f.settle(2);
      await A.apply('createNotePopover', { id: 'dv1', date: '2027-08-05', text: 'NUR AUF A', categoryId: 'c1' });
      const hidden = opIdFor(A, 'NUR AUF A');
      await A.push();
      f.wire.hostile.onResponse = (res, req, dv) => {
        if (req.method === 'GET' && req.path === '/api/v1/ops' && dv === B.short
            && res.body && Array.isArray(res.body.ops)) {
          res.body.ops = res.body.ops.filter((e) => e.oid !== hidden);
        }
        return res;
      };
      await f.settle(3);
      await B.relaunch();
      await f.settle(2);
      const digestsAgree = eq(registerDigest(A), registerDigest(B));
      OBSERVED['S4-diverged'] = {
        status: B.status().state,
        storeReports: storeReportsOf(B),
        survives: digestsAgree ? true : (B.status().state !== 'healthy' || storeReportsOf(B) !== null),
      };
      f.wire.honest();
      assert.equal(digestsAgree, false,
        'the withhold did not produce a divergence, so S4-diverged is measuring nothing — fix the '
        + 'arrangement before reading the row');
    }
  });

  test('S4a — silence must MEAN health: every state is reportable, and survives a quit', () => {
    const results = S4.map((e) => {
      const got = OBSERVED[e.id];
      const ok = got.status === e.expect.status
        && got.storeReports === e.expect.storeReports
        && got.survives === e.expect.survives;
      return { entry: e, ok, got };
    });
    verdict('S4', results);
  });

  test('S4b — the two controls are genuine: `healthy` and `pending` are reachable and free', () => {
    // Without this, every requirement in S4 is equally satisfied by an app that shows a warning
    // triangle for ever — which would be a worse product and a green suite.
    assert.equal(OBSERVED['S4-quiet'].status, 'healthy',
      'a settled pair of Macs is not `healthy`; story 19.3 is broken in the other direction');
    assert.equal(OBSERVED['S4-quiet'].storeReports, null,
      `a settled pair of Macs reports ${OBSERVED['S4-quiet'].storeReports} — silence is not free`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S5 — MODULE REACHABILITY
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('S5 · module reachability', () => {
  let reached = null;

  before(() => {
    reached = new Set(S5_ENTRIES.flatMap((e) => reachableFrom(e).reached));
  });

  test('S5a — a module that ships is reachable, or it does not ship', () => {
    const results = S5.map((e) => ({
      entry: e,
      ok: reached.has(e.value) === e.expect.reachable,
      got: { reachable: reached.has(e.value), role: e.expect.role },
    }));
    verdict('S5', results);
  });

  test('S5b — the domain still describes the tree: every file on disk is enumerated, and vice versa', () => {
    // D6a's shape: the `v1` column of `domains.js` was MEASURED, and this is what stops a domain
    // from quietly ceasing to describe the thing it enumerates. A module added to `src/js/` and
    // not added here would be un-enumerated — and an un-enumerated input is the whole failure this
    // method exists to prevent.
    // The union of two independent walks, so neither can hide a file from the other: the IMPORT
    // graph from the three entry points (which by construction can never see an orphan) and
    // `privacy-audit.js`'s DIRECTORY walk of `core/`, `crypto/`, `sync/`, `platform/` and
    // `store.js` (which is where every orphan in this tree lives).
    const onDisk = new Set([...reached, ...nonDomModules()].filter((f) => f.endsWith('.js')));
    const missing = [...onDisk].filter((f) => !S5.some((e) => e.value === f)).sort();
    assert.deepEqual(missing, [], `these modules exist and are not enumerated in S5: ${missing.join(', ')}`);
    const ghosts = S5.map((e) => e.value).filter((f) => !onDisk.has(f)).sort();
    assert.deepEqual(ghosts, [], `S5 enumerates modules that are not in the tree: ${ghosts.join(', ')}`);
    const enumerated = S5.map((e) => e.value);
    assert.equal(new Set(enumerated).size, enumerated.length, 'S5 lists a module twice');
    assert.equal(enumerated.length, 58,
      `S5 enumerates ${enumerated.length} modules; the walk in the fix pass found 58. If a module `
      + 'was added or deleted, add or delete its row rather than changing this number alone.');
  });

  test('S5c — the DEFENCES are named, and closing their rows means wiring them', () => {
    // The half of P-4 that cannot be closed by deleting the dead engine. `sync/chain.js` is ADR
    // 002 §5.4's chain-witness verification and is the only mechanism the design names for
    // detecting the fork S4-diverged measures — so if this row is ever closed by deletion, S4's
    // row becomes unclosable and the product loses a defence it was designed to have.
    //
    // TWO ROWS MOVED FROM `dead` TO `defence` THIS PASS, and the move is the finding, not a
    // re-labelling. `sync/outbox.js` was called superseded because `createOutbox` is —
    // `store.outbox()` is DERIVED from the log, which is what ADR 003 §8.1 requires. But the same
    // file holds `createParkingLot`, a durable, capped, storage-backed retention of SEALED
    // ENVELOPES with their reasons, which is EXACTLY the mechanism S1's `survives: park-reason`
    // axis is owed and which `core/oplog.js` cannot supply (a park at P1/P4/version happens
    // before the decrypt, so there is no op to hand `oplog.park()`). `sync/cursor.js` is the same
    // shape one column over: it is where a DURABLE chain anchor would live, and without one a
    // relay that forks across a relaunch is still undetectable.
    //
    // Deleting either would close its S5 row and delete the only implementation of the thing the
    // corresponding S1/S4 row is still waiting for — which is the exact mistake this test exists
    // to make impossible.
    const defences = S5.filter((e) => e.expect.role === 'defence').map((e) => e.value).sort();
    assert.deepEqual(defences, [
      'src/js/crypto/backup.js', 'src/js/crypto/probe.js', 'src/js/sync/chain.js',
      'src/js/sync/cursor.js', 'src/js/sync/outbox.js',
    ]);
    const dead = S5.filter((e) => e.expect.role === 'dead').map((e) => e.value).sort();
    assert.deepEqual(dead, [],
      'LZP-501\'s superseded engine was `sync/client.js` and it is DELETED. Nothing in the tree is '
      + 'dead now: every remaining module is live, or it is a defence with a named wiring job.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE DOMAIN'S OWN INTEGRITY
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('the domain file itself', () => {
  test('every entry has the five required fields, and every id is unique', () => {
    const ids = new Set();
    for (const [name, d] of Object.entries(DOMAINS)) {
      assert.ok(Array.isArray(d.entries) && d.entries.length, `${name} has no entries`);
      for (const e of d.entries) {
        assert.equal(typeof e.id, 'string', `${name}: an entry has no id`);
        assert.equal(ids.has(e.id), false, `duplicate entry id ${e.id}`);
        ids.add(e.id);
        assert.ok('value' in e, `${e.id} has no value`);
        assert.equal(typeof e.label, 'string', `${e.id} has no label`);
        assert.ok(e.expect && typeof e.expect === 'object', `${e.id} has no expect`);
        assert.ok('openFinding' in e, `${e.id} does not say whether it is expected to fail`);
      }
    }
    assert.equal(ids.size, Object.values(DOMAIN_SIZES).reduce((a, b) => a + b, 0));
  });

  test('every `openFinding` names a finding this file documents', () => {
    // The rule that stops the work order from pointing at nothing. A row whose finding id is a
    // typo is a row nobody will ever close.
    for (const d of Object.values(DOMAINS)) {
      for (const e of d.entries) {
        if (e.openFinding === null || e.openFinding === undefined) continue;
        assert.ok(OPEN_FINDINGS[e.openFinding],
          `${e.id} points at finding ${e.openFinding}, which sync-domains.js does not document`);
      }
    }
  });

  test('no domain is all-open or all-closed — a work order with no controls is not a work order', () => {
    for (const [name, d] of Object.entries(DOMAINS)) {
      const open = d.entries.filter((e) => e.openFinding).length;
      assert.ok(open < d.entries.length,
        `${name}: every one of its ${d.entries.length} entries is expected to fail, so nothing in `
        + 'it is a control and the whole domain is satisfied by a build that does nothing at all');
    }
  });
});
