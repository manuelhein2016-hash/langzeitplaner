// FLEET · E14 — R-1b'S SECOND ROUTE: THE COMPACTION THAT ATE THE RETAINED ADMIN LINK.
// Story 18.3 · ADR 001 §4.1 (the admin chain), §7.2 (compaction is lossless for STATE) ·
// `core/oplog.js#compact` · `store.js#_persistOps` ② and ④ · `store.js#_retainedTailLines`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS BESIDE `e12-unshare.test.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// E12 §8 pins the FIRST route into R-1b — a transferred seat cannot be REBUILT out of a register
// cell — and the fix cycle answered it by never absorbing the link in the first place:
// `_persistOps` ① exempts `isAdminLink` lines from the horizon and ④ re-appends them after each
// truncate. That retention is real and it is measured on the shipped binary.
//
// It was blind to `_persistOps` STEP ②. Between ① and ④ the store calls `_log.compact()`, and
// compaction drops every line at or below the horizon — the retained links included. By the time
// ④ asks `_retainedTailLines()` what to put back, `_log.lines()` no longer holds them, so it puts
// back nothing; and `compact()` has already called `rememberBody` on each, so `bodiesObject()`
// publishes their fingerprints and `load()` would answer a re-appended copy `duplicate`. The
// retention could not even be repaired by writing the bytes again.
//
// THE TRIGGER IS NOT EXOTIC. ② fires at `TAIL_COMPACT_AT` — `min(5000, floor(LS_OPS_CAP × 0.75))`
// — or on the one-shot byte trigger. Five thousand lines is a number a family crosses; it is not
// a threshold anybody has to attack. **A circle that reaches it loses a transferred seat again**,
// by a second route, after the first was closed.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// MEASURED, BEFORE THE FIX, on the rig below (a real converged three-Mac circle, a real
// `transferAdmin` through the shipped mutation and the shipped seal):
//
//     retained lines before ②     2   (genesis + the transfer link)
//     lines dropped by ②          2
//     retained lines after ②      0
//     checkpoint().bodies          1 fingerprint for EACH of the two link opIds
//     `ops.jsonl` on disk          0 lines
//
// AFTER: retained after ② = 2, `bodies` carries 0 for both, `ops.jsonl` holds exactly the two
// `space.set` lines, and the non-link lines are still dropped — compaction did not become a
// no-op.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION
//
//   §1  NON-VACUITY  the rig really transfers the seat, and retention really holds the links
//                    BEFORE any compaction. Without this row §2 could pass on a circle that
//                    never transferred anything.
//   §2  ✅ CLOSED    the real route — `_persistOps` with ② armed — keeps the links, publishes no
//                    fingerprint for them, and writes them to `ops.jsonl`.
//   §3  MUTANT M-1   `retain` stripped from the `compact()` call, i.e. the build before this
//                    fix. Every claim in §2 dies. This is the row that says §2 is not vacuous.
//   §4  ✅ CLOSED    END TO END, the F9 victim: a BYSTANDER OWNER whose log has compacted still
//                    obeys the NEW admin's retraction after a relaunch.
//   §5  CONTROL      compaction is still compaction: the ordinary lines are gone, the file did
//                    not grow, and the horizon advanced.
//   §6  DECIDED      the SECOND residual — a log an OLDER build already compacted. Measured, not
//                    argued: repair A (the sitting admin re-claims) is DECLINED and should be;
//                    repair B (forget the fingerprints, re-pull the space from genesis) restores
//                    both links off the relay; the already-refused retraction stays refused
//                    (`notOwner` is final), so the admin has to moderate ONCE MORE, and then it
//                    lands. Two parts, and the second is a person — a RUNBOOK entry, not a
//                    migration. Why no migration ships: `SYNC_ORIGIN_BUILTIN` is `""` in both
//                    shells, so the affected population is empty by construction.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// MUTANTS — one run each, MEASURED at source in `src/`, then reverted
//
//   M-1  `store.js` step ②: `this._log.compact({ retain })` → `this._log.compact()`, i.e. the
//        build before this fix, byte for byte. **MEASURED: §2 and §4 die, §1 §3 §5 stand.**
//          §2 `step ② dropped 2 admin-chain line(s) — R-1b, second route · 0 !== 2`
//          §4 `after a compaction AND a relaunch the chain is 0 line(s)`
//        §3 is the same mutant applied in-file to one store, so §3 passing under M-1 is right:
//        it is the same measurement twice.
//   M-2  `store.js` step ②: the predicate widened to `(op) => true`. **MEASURED: §5 dies alone,
//        §1–§4 stand** — `compaction became a no-op: 13 lines survived, only 2 of them links`.
//        That is the bound `compact`'s `retain` note puts on the caller, held by a row.
//   M-3, TRIED AND REJECTED AS A MUTANT — `oplog.js#compact`, `rememberBody(id, canonOf(...))`
//        called for a RETAINED line before the `continue`. **MEASURED: nothing dies, 5 of 5
//        green.** It is not a defect this file can catch and it is not a defect at all:
//        `bodiesObject()` skips every live id, so a fingerprint remembered beside a line it
//        still holds is never serialized and is gone at the next `load()`. The `no rememberBody`
//        comment in `compact` is therefore a redundancy stated for the reader, not a load-bearing
//        line — and saying so is cheaper than a row that cannot die.

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { adminUnshareOp } from '../../src/js/core/project.js';
import * as storage from '../../src/js/storage.js';

import {
  circle, converge, on, pushOp, regsOf, engineFor,
} from './e9-attack-kit.js';

// ─────────────────────────────────────────────────────────────────────────────
// The rig
// ─────────────────────────────────────────────────────────────────────────────

/** Quit and reopen one Mac on its own disk — `e12-unshare.test.js#relaunch`, verbatim shape. */
async function relaunch(C, mac) {
  await on(mac, async () => {
    clearTimeout(mac.store._saveTimer);
    await mac.store.persistNow();
    mac.store.listeners.clear();
    mac.store.warnings.length = 0;
    mac.store.ready = false;
    await mac.store.init();
    clearTimeout(mac.store._saveTimer);
    mac.engine = engineFor(C, mac);
  });
}

/**
 * FIRE `_persistOps` STEP ② THE WAY A REAL LOG FIRES IT.
 *
 * ② has two triggers and they are a disjunction: `_tailLines >= TAIL_COMPACT_AT` (5 000 lines)
 * or `_tailOverBytes` (`TAIL_COMPACT_BYTES`, measured once at launch). They enter the same
 * branch and call the same `compact()`, so arming the byte trigger reaches the identical code
 * path for the price of one persist instead of five thousand appends. Nothing else is shaped:
 * the horizon, the cap, the checkpoint and the truncate are the shipped ones.
 */
async function compactOnDisk(mac) {
  await on(mac, async () => {
    mac.store._tailOverBytes = true;
    await mac.store.persistNow();
  });
}

/** One member's own note, created and shared through the shipped mutations (E12's `shareOwn`). */
async function shareOwn(C, mac, { uuid, date, text }) {
  await on(mac, async () => {
    assert.equal(mac.store.apply('createNoteInline', {
      id: uuid, date, text, categoryId: 'c1',
    }), true, 'the note was not created');
    mac.store.txn('share', (tx) => { tx.note(uuid).set({ visibility: 'geteilt' }); });
    await mac.engine.syncNow();
    clearTimeout(mac.store._saveTimer);
    await mac.store.persistNow();
  });
}

/** The shipped moderation op, sealed by whoever currently holds the seat. */
async function moderate(C, admin, owner, uuid) {
  await on(admin, async () => {
    const op = adminUnshareOp(admin.store._ctx(), { kind: 'fnote', owner, uuid });
    await pushOp(C, admin, op, {
      levelOf: () => null,
      adminOf: () => admin.forStore.memberId,
      assertFamilyPatch: () => {},
    });
    await admin.engine.syncNow();
  });
}

/** One Mac's own projection of one of its own notes. */
async function noteOn(mac, uuid) {
  let out = null;
  await on(mac, () => {
    const n = (mac.store.state.notes || []).find((x) => x && x.id === uuid) || null;
    out = n ? { text: n.text, visibility: n.visibility, level: n.level, isForeign: n.isForeign } : null;
  });
  return out;
}

/** What one Mac's log says about the admin chain, as plain data. */
async function chainOn(mac) {
  let out = null;
  await on(mac, () => {
    const log = mac.store._log;
    const cp = log.checkpoint();
    const links = log.lines().filter((l) => l.park === null && l.op.k === 'space.set');
    out = {
      retained: mac.store._retainedTailLines().length,
      linkLines: links.length,
      linkIds: links.map((l) => l.op.id).sort(),
      fingerprints: links.reduce((n, l) => n + (Array.isArray(cp.bodies[l.op.id]) ? cp.bodies[l.op.id].length : 0), 0),
      // every fingerprint the checkpoint publishes, so §3 can show the pre-fix build listing them
      publishedIds: Object.keys(cp.bodies).sort(),
      horizon: cp.horizon,
      totalLines: log.lines().length,
    };
  });
  return out;
}

/** `ops.jsonl` as it actually sits on one Mac's disk. */
async function diskOps(mac) {
  let out = null;
  await on(mac, async () => {
    const raw = await storage.loadOps();
    out = (raw || []).map((l) => (l.op || l).k);
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('E14 · a compaction may not eat the admin-chain link the retention just kept', () => {
  let C; let MAMA; let OMA;
  const uuid = newUuid();

  before(async () => {
    C = await circle(['papa', 'mama', 'oma']);
    MAMA = C.mama.forStore.memberId;
    OMA = C.oma.forStore.memberId;

    // Mama owns a shared entry. She is the BYSTANDER: she takes no part in the transfer below,
    // and F9's whole point is that she is the one who loses the moderation.
    await shareOwn(C, C.mama, { uuid, date: '2026-10-14', text: 'Mamas Eintrag' });
    await converge(C, [C.papa, C.oma, C.mama]);

    // Papa hands the seat to Oma, through the shipped mutation and the shipped seal.
    let head = null;
    await on(C.papa, () => { head = C.papa.store.familyAdmin().headOpId; });
    assert.ok(head, 'the admin chain has no head on the founder\'s own Mac');
    await on(C.papa, async () => {
      C.papa.store.apply('transferAdmin', { admin: OMA, adminPrev: head });
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama, C.oma, C.papa]);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  test('§1 · NON-VACUITY · the seat really moved, and retention really holds the links first', async () => {
    let seat = null;
    await on(C.mama, () => { seat = C.mama.store.familyAdmin(); });
    assert.equal(seat.admin, OMA, 'the transfer did not land — nothing below is about a transfer');

    const before = await chainOn(C.mama);
    assert.ok(before.retained >= 2,
      `retention does not hold the chain even BEFORE a compaction (retained=${before.retained}) — `
      + 'then this file is measuring the wrong thing and `_persistOps` ①/④ is what is broken');
    assert.equal(before.retained, before.linkLines,
      '`_retainedTailLines()` and the log disagree about how many links are lines');
    assert.equal(before.fingerprints, 0,
      'a link that is still a LINE already has a published fingerprint — `bodiesObject()` is the bug');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  test('§2 · ✅ the real persist route fires ② and the links survive it, in memory and on disk', async () => {
    const before = await chainOn(C.mama);
    await compactOnDisk(C.mama);
    const after = await chainOn(C.mama);

    assert.equal(after.linkLines, before.linkLines,
      `step ② dropped ${before.linkLines - after.linkLines} admin-chain line(s) — R-1b, second route`);
    assert.deepEqual(after.linkIds, before.linkIds, 'the surviving links are not the same links');
    assert.equal(after.fingerprints, 0,
      'a retained link\'s fingerprint is published in `checkpoint().bodies`, so `load()` would '
      + 'answer the very bytes ④ wrote `duplicate` — the retention cannot come back');
    for (const id of before.linkIds) {
      assert.ok(!after.publishedIds.includes(id),
        `checkpoint().bodies still lists the retained link ${id}`);
    }

    const disk = await diskOps(C.mama);
    assert.equal(disk.filter((k) => k === 'space.set').length, before.linkLines,
      `ops.jsonl holds ${disk.filter((k) => k === 'space.set').length} space.set lines, not ${before.linkLines}: ${JSON.stringify(disk)}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §3 · THE MUTANT, IN FILE. `compact()` called WITHOUT `retain` is precisely the build before
  //      this fix — one keyword's difference, applied to the same store, on the same disk.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  test('§3 · MUTANT M-1 · without `retain` the links die at ② and their fingerprints are published', async () => {
    // A fresh Mac so the mutant cannot inherit §2's already-compacted state.
    await relaunch(C, C.oma);
    const before = await chainOn(C.oma);
    assert.ok(before.linkLines >= 1, 'the mutant arm has no link to lose — the rig is wrong, not the code');

    let after = null; let disk = null;
    await on(C.oma, async () => {
      const log = C.oma.store._log;
      const real = log.compact.bind(log);
      log.compact = (o = {}) => { const { retain, ...rest } = o; return real(rest); };
      try {
        C.oma.store._tailOverBytes = true;
        await C.oma.store.persistNow();
      } finally { log.compact = real; }
    });
    after = await chainOn(C.oma);
    disk = await diskOps(C.oma);

    assert.equal(after.linkLines, 0,
      'the mutant did NOT lose the links — then `retain` is not what keeps them and §2 proves nothing');
    for (const id of before.linkIds) {
      assert.ok(after.publishedIds.includes(id),
        `the mutant did not publish ${id}'s fingerprint — then the "duplicate on re-append" half `
        + 'of the finding is not reproduced here');
    }
    assert.equal(disk.filter((k) => k === 'space.set').length, 0,
      `the mutant left space.set lines on disk: ${JSON.stringify(disk)}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  test('§4 · ✅ END TO END · a bystander owner whose log compacted still obeys the NEW admin', async () => {
    // Mama has compacted (§2) and now quits and reopens: the fold she rebuilds is the one that
    // used to refuse `notOwner`, terminally, because the chain was empty.
    await relaunch(C, C.mama);
    const chain = await chainOn(C.mama);
    assert.ok(chain.linkLines >= 2,
      `after a compaction AND a relaunch the chain is ${chain.linkLines} line(s) — the links did `
      + 'not come back off disk');

    let seat = null;
    await on(C.mama, () => { seat = C.mama.store.familyAdmin(); });
    assert.equal(seat.admin, OMA, 'Mama lost the seat across the relaunch');

    // NON-VACUITY for the retraction itself: it is at `geteilt` before Oma acts.
    assert.equal((await regsOf(C.mama, `fnote:${MAMA}/${uuid}`))['pub.level'], 'geteilt',
      'the entry was not shared to begin with');

    await moderate(C, C.oma, MAMA, uuid);
    await converge(C, [C.mama, C.papa]);
    await converge(C, [C.mama]);

    assert.equal((await regsOf(C.mama, `fnote:${MAMA}/${uuid}`))['pub.level'], 'privat',
      'the new admin\'s retraction was refused on the owner\'s own Mac — R-1b is still open by '
      + 'the compaction route');
    assert.deepEqual(await noteOn(C.mama, uuid),
      { text: 'Mamas Eintrag', visibility: 'privat', level: 'privat', isForeign: false },
      '18.3 promises it reverts to owner-private and is never deleted');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  test('§5 · CONTROL · compaction is still compaction — the ordinary lines went, the horizon rose', async () => {
    // Papa has not compacted yet in this file. Give him ordinary lines to lose.
    await shareOwn(C, C.papa, { uuid: newUuid(), date: '2026-11-03', text: 'Papas Eintrag' });
    await converge(C, [C.papa]);

    const before = await chainOn(C.papa);
    assert.ok(before.totalLines > before.linkLines,
      'Papa has nothing but links to compact — this control cannot say anything');

    await compactOnDisk(C.papa);
    const after = await chainOn(C.papa);

    assert.equal(after.totalLines, after.linkLines,
      `compaction became a no-op: ${after.totalLines} lines survived, only ${after.linkLines} of `
      + 'them links. `retain` is retaining more than the admin chain');
    assert.ok(after.totalLines < before.totalLines, 'nothing was dropped at all');
    assert.ok(after.horizon >= before.horizon, 'the horizon receded');

    const disk = await diskOps(C.papa);
    assert.equal(disk.length, after.linkLines,
      `ops.jsonl kept ${disk.length} lines for ${after.linkLines} links: ${JSON.stringify(disk)}`);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §6 · THE SECOND RESIDUAL, DECIDED — a log an OLDER build already compacted
  //
  // Retention prevents the loss. It cannot undo one, and this row is the measurement of what an
  // affected circle can and cannot do. It is the evidence behind the RECOVERY paragraph in
  // `store.js#_absorbedChainOps`, and it is deliberately a ROW rather than a migration: the
  // trigger would be a full re-pull armed on every launch for a population that is empty by
  // construction (`SYNC_ORIGIN_BUILTIN` is `""` in both shells — no shipped build has ever
  // synced a family, so no shipped Mac has ever compacted a family log past a transfer).
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  test('§6 · RECOVERY · a log damaged by the old build: A declines, B restores the chain, the admin retries', async () => {
    // A fourth Mac would be cleaner; Papa is used because he has not been damaged and §5 leaves
    // him compacted-but-intact. Damage him the way the pre-fix build damaged everybody.
    let lost = [];
    await on(C.papa, async () => {
      const log = C.papa.store._log;
      lost = log.lines().filter((l) => l.park === null && l.op.k === 'space.set').map((l) => l.op.id);
      const real = log.compact.bind(log);
      log.compact = (o = {}) => { const { retain, ...rest } = o; return real(rest); };
      try { C.papa.store._tailOverBytes = true; await C.papa.store.persistNow(); }
      finally { log.compact = real; }
    });
    assert.ok(lost.length >= 2, 'Papa had no transferred chain to lose');
    await relaunch(C, C.papa);

    const damaged = await chainOn(C.papa);
    assert.equal(damaged.linkLines, 0, 'the damage did not take — §6 has nothing to recover');
    for (const id of lost) {
      assert.ok(damaged.publishedIds.includes(id),
        `${id}'s fingerprint is not published, so a re-appended copy would not be answered `
        + '`duplicate` and the recovery question does not arise');
    }

    // REPAIR A — the sitting admin re-claims the seat. It is REFUSED, and rightly: a second
    // genesis link is a rival root, not a correction (`core/ops.js#claimAdmin`).
    let claimed = null;
    await on(C.oma, () => { claimed = C.oma.store.apply('claimAdmin', {}); });
    assert.equal(claimed, false,
      'claimAdmin was ACCEPTED on a seated circle — that is a rival root and a worse bug than '
      + 'the one it would be repairing');

    // REPAIR B — drop those two fingerprints and re-pull this space from genesis. The relay
    // never prunes ops (ADR 003 §6.3: there is deliberately no redaction endpoint), so the
    // bytes are still there to fetch.
    await on(C.papa, () => {
      const log = C.papa.store._log;
      const cp = log.checkpoint();
      const tail = log.lines();
      const bodies = { ...cp.bodies };
      for (const id of lost) delete bodies[id];
      log.load({ checkpoint: { ...cp, bodies, cursors: { ...cp.cursors, [C.spaceId]: '0' } }, tail });
    });
    await converge(C, [C.papa]);
    await converge(C, [C.papa]);

    const repaired = await chainOn(C.papa);
    assert.equal(repaired.linkLines, lost.length,
      `the re-pull restored ${repaired.linkLines} of ${lost.length} chain links — then repair B `
      + 'is not available and the RECOVERY paragraph in `store.js#_absorbedChainOps` is wrong');
    assert.deepEqual(repaired.linkIds, [...lost].sort(), 'different links came back');

    // AND THEN A PERSON. The retraction Papa already refused stays refused — `notOwner` is final
    // and is in neither `CURABLE_REFUSALS` nor `RETROACTIVE_REFUSALS` — so the admin has to
    // moderate again. A fresh op, a fresh opId, and it lands.
    const second = newUuid();
    await shareOwn(C, C.mama, { uuid: second, date: '2026-12-01', text: 'Zweiter Eintrag' });
    await converge(C, [C.papa, C.oma, C.mama]);
    await moderate(C, C.oma, MAMA, second);
    await converge(C, [C.papa]);
    await converge(C, [C.papa]);
    assert.equal((await regsOf(C.papa, `fnote:${MAMA}/${second}`))['pub.level'], 'privat',
      'after repair B the new admin\'s retraction STILL does not land — then the chain came back '
      + 'as lines but the fold does not read them, and repair B repairs nothing');
  });
});
