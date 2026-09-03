// tests/audit/compaction-sweep.test.js — THE SYSTEMATIC SWEEP: every fact a fold reads from the
// OP STREAM rather than from a REGISTER, and whether `store.js#_persistOps` can absorb it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE PATTERN, RESTATED AS A PREDICATE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A fold reads a fact from OPS; a persist keeps only REGISTERS; the fact becomes unreachable;
// the resulting verdict is terminal, so it is permanent. `_absorbedAttestOps`, `_absorbedChainOps`
// and R-1b are three instances. This file enumerates the rest.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 — THE MEASUREMENT THAT MAKES THE WHOLE SWEEP NECESSARY
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Absorption is not an edge case, a large log, or a `TAIL_COMPACT_AT` threshold. It is TOTAL, and
// it happens on the FIRST quit-and-open of every install:
//
//   `_persistOps` ① skips every line at or below `_comingHorizon()`, which is `_log.horizon()`
//   ?? the max live stamp — i.e. EVERY line the log holds. So `ops.jsonl` is written empty, the
//   checkpoint carries the registers, and `oplog.load()` brings back registers and no lines.
//
// MEASURED below (§0a): a converged three-Mac Familienkreis holds 8 ops as lines before the quit
// and **0** after it. `TAIL_COMPACT_AT` (5000) is never reached and is irrelevant; the byte
// trigger is never reached either.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ENUMERATION — every ops-read in `foldAuthorized` and in `store.js`'s projection
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//  #  fact                                    read at                     absorbable?  repaired?
//  1  `member.set{dev.*}` attestation blobs   authz stage 0a/0b           yes          YES  `_absorbedAttestOps`
//  2  write-once floor for a `dev.*` register authz stage 0a              yes          yes, via #1
//  3  `space.set{admin,adminPrev}` links      authz stage 1               yes          PARTLY — genesis only
//  4  `space.set{name}`/`{epoch}` admission   authz stage 1 (adminAtKey)  yes          partly, via #3
//  5  member records incl. `_alive`           authz stage 2 currentMembers yes         **NO**  → §2
//  6  memberSpaces (which space a member is in) authz stage 2/3a          yes          yes, via #1
//  7  governing `pub.*` registers             authz stage 3a → 3b, 3c     yes          **NO**  → §1
//  8  last ACKED `pub.level`; pending pub op  store `_exposureCtx`        yes          **NO**  → §4
//  9  splice bodies under one opId            authz Pass A                yes          yes (`rememberBody`)
// 10  the withdrawal subtraction set          store `_repairWithdrawn`    yes          documented residual
//
// Rows §1–§4 are the four that are neither repaired nor documented. They are ordered by what
// they cost a person, not by how clever they are.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY 5,000+ GREEN ROWS DO NOT SEE ANY OF THIS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Measured with `grep -c relaunch`: `e6-removal`, `e6-gate-removal`, `e6-attack-removed`,
// `e6-gate-privat`, `e9-attack-coedit`, `e9-attack-moderation`, `e9-attack-restore`, `round9-e6`,
// `e10-fleet-board`, `e10-backup-restore`, `disorder` and `fleet-harness` — **0 each**. Every
// family rig builds its circle with `bootMac`, which is a FIRST INSTALL, and then never quits.
// The one move that turns an op into a register-only fact is the one move none of them makes.
//
// ⚠ A ROW THAT ASSERTS THE CORRECT BEHAVIOUR IS RED ON ARRIVAL. That is deliberate: an auditor's
// demonstration is worth more when a fix turns it green than when it enshrines the defect. Every
// red row below carries the MEASURED value in its message. The GREEN rows are the controls and
// the non-vacuity checks, and they must stay green or the red ones prove nothing.

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  circle, on, converge, regsOf, mkPubSet, patchedOp, pushOp,
} from '../fleet/e9-attack-kit.js';
import { quitAndOpen, shape } from './_relaunch.js';
import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { unsharePatch } from '../../src/js/core/authz.js';
import { brandFamilyPatch } from '../../src/js/crypto/envelope.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// helpers — each one is the shipped path plus the minimum scaffolding the kit does not carry
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One owner-published `pub.set`, sealed the way `publishSharedEntry` seals. */
async function share(C, mac, fields, level = 'geteilt') {
  const key = familyKey('fnote', mac.forStore.memberId, newUuid());
  await on(mac, async () => {
    await patchedOp(C, mac, mkPubSet(C, mac, key, {
      'pub.level': level, 'pub.alive': true, 'pub.date': '2026-10-14', ...fields,
    }, level), { levelOf: () => level });
    await mac.engine.syncNow();
  });
  await converge(C, C.macs.filter((m) => m !== mac));
  return key;
}

/** The admin's §4.3 unshare, built exactly as `project.js#adminUnshareOp` builds it. */
async function adminUnshare(C, admin, key) {
  await on(admin, async () => {
    const ctx = admin.store._ctx();
    await pushOp(C, admin, Object.freeze({
      v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: C.spaceId,
      act: admin.forStore.memberId, dev: admin.forStore.deviceId, gid: ctx.gid,
      k: 'pub.set', e: key,
      f: brandFamilyPatch({ ...unsharePatch('fnote') }, { kind: 'fnote', level: 'privat' }),
    }), {
      levelOf: () => 'privat', adminOf: () => admin.forStore.memberId, assertFamilyPatch: () => {},
    });
    await admin.engine.syncNow();
  });
}

/** `member.set{_alive}` from the admin — story 20.2's removal op and its inverse, the re-add. */
const setAlive = (C, subject, alive) => on(C.papa, async () => {
  const ctx = C.papa.store._ctx();
  await pushOp(C, C.papa, Object.freeze({
    v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: C.spaceId,
    act: C.papa.forStore.memberId, dev: C.papa.forStore.deviceId, gid: ctx.gid,
    k: 'member.set', e: `member:${subject.forStore.memberId}`, f: { _alive: alive },
  }));
  await C.papa.engine.syncNow();
});

const textOn = async (mac, key) => (await regsOf(mac, key))?.['pub.text'] ?? null;
const levelOn = async (mac, key) => (await regsOf(mac, key))?.['pub.level'] ?? null;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · THE MECHANISM
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§0 · absorption is total, and it happens on the first quit-and-open', () => {
  test('§0a · GREEN · a converged circle holds 8 ops as lines; after one relaunch it holds 0', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.mama, { 'pub.text': 'Mamas Eintrag' });

    let before = null;
    await on(C.oma, () => { before = shape(C.oma); });
    assert.ok(before.ops >= 8, `non-vacuity: the circle must actually hold ops as lines, got ${before.ops}`);
    assert.equal(before.horizon, null, 'before the first persist there is no horizon');

    await quitAndOpen(C, C.oma);
    let after = null;
    await on(C.oma, () => { after = shape(C.oma); });

    assert.equal(after.ops, 0,
      `THE MECHANISM: one ordinary quit-and-open absorbed every line. before=${before.ops} after=${after.ops}`);
    assert.equal(after.registers, before.registers,
      'and not one register was lost — which is exactly why nothing downstream notices');
    assert.notEqual(after.horizon, null, 'the checkpoint horizon now covers everything');
  });

  test('§0b · GREEN · ops.jsonl on disk is empty after the persist that absorbed them', async () => {
    const C = await circle(['papa', 'mama']);
    await share(C, C.papa, { 'pub.text': 'Herbstferien' });
    await quitAndOpen(C, C.papa);
    const tail = C.papa.disk['langzeitplaner.ops'];
    assert.ok(tail === undefined || tail === null || String(tail).trim() === '',
      `the tail file must be empty — this is not a rig artefact, it is what the Mac wrote. got ${JSON.stringify(String(tail).slice(0, 200))}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · FINDING A — THE GOVERNING `pub.*` REGISTERS (enumeration row 7)
//
// `authz.js` stage 3a builds `govRegs` with `emptyRegs()` and folds ONLY the `pub.set` ops IN
// THIS FOLD. Stage 3b then refuses a co-editor's write unless `govRegs` says `pub.coEdit === true`
// AND `pub.level === 'geteilt'` AND `pub.alive !== false`. After a relaunch the owner's granting
// op is a register and not an op, `govRegs` is empty for that entity, and every co-editor write
// is refused `noCoEdit`.
//
// `noCoEdit` is NOT in `store.js#CURABLE_REFUSALS`, so `applyRemote` does not park it — the line
// is dropped, the relay's `since` cursor has moved past it, and no later pull can serve it again.
// TERMINAL. `sync/family.js#terminal` then quarantines the envelope.
//
// COST: story 18.2 ("Familie darf bearbeiten") stops working on the second day of the family's
// life, silently, while the door still offers the gesture (`familyCoEditLevelOf` reads
// `store.registers()`, which DOES retain the grant, so the checkbox and the editable field are
// still there). The co-editor sees her own text; nobody else ever does.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · FINDING A · the co-edit grant is absorbed, and every co-edit is then refused', () => {
  test('§1a · GREEN · CONTROL — with nobody relaunched, the co-edit lands on all three Macs', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    const key = await share(C, C.papa, { 'pub.coEdit': true, 'pub.text': 'Herbstferien' });
    await on(C.mama, async () => {
      assert.equal(C.mama.store.applyCoEdit(key, { 'pub.text': 'Nordsee' }), true);
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma]);
    assert.equal(await textOn(C.papa, key), 'Nordsee');
    assert.equal(await textOn(C.oma, key), 'Nordsee',
      'if this is not Nordsee the rig is broken and every row below is meaningless');
  });

  test('§1b · RED · one Mac quits and opens; it never folds another co-edit, for ever', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    const key = await share(C, C.papa, { 'pub.coEdit': true, 'pub.text': 'Herbstferien' });
    assert.equal(await textOn(C.oma, key), 'Herbstferien');

    await quitAndOpen(C, C.oma);          // ← the whole difference from §1a

    await on(C.mama, async () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(key), 'geteilt',
        'the DOOR still opens — the grant is in the register map, which survives compaction');
      assert.equal(C.mama.store.applyCoEdit(key, { 'pub.text': 'Nordsee' }), true);
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma]);
    assert.equal(await textOn(C.papa, key), 'Nordsee', 'the Mac that did not relaunch is fine');

    // Three more syncs: is the refusal terminal?
    await converge(C, [C.oma]);
    await converge(C, [C.oma]);
    await converge(C, [C.oma]);
    let parked = [];
    let refusals = [];
    await on(C.oma, () => {
      parked = C.oma.store._log.parkedOps().map((p) => p.reason);
      refusals = C.oma.store.warnings.filter((w) => /refused/.test(w));
    });
    assert.deepEqual(parked, [],
      'and it is not even parked — `noCoEdit` is absent from CURABLE_REFUSALS, so the line is dropped');
    assert.equal(await textOn(C.oma, key), 'Nordsee',
      `FINDING A: after one quit-and-open Oma refuses every co-edit. `
      + `She reads "${await textOn(C.oma, key)}" while Papa reads "Nordsee", after 4 syncs. `
      + `Refusals seen: ${JSON.stringify(refusals)}`);
  });

  test('§1c · RED · once every Mac has relaunched, a co-edit reaches nobody at all', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    const key = await share(C, C.papa, { 'pub.coEdit': true, 'pub.text': 'Herbstferien' });
    for (const m of [C.papa, C.mama, C.oma]) await quitAndOpen(C, m);

    await on(C.mama, async () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(key), 'geteilt');
      assert.equal(C.mama.store.applyCoEdit(key, { 'pub.text': 'Nordsee' }), true);
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma]);
    await converge(C, [C.papa, C.oma]);

    const seen = {
      papa: await textOn(C.papa, key), mama: await textOn(C.mama, key), oma: await textOn(C.oma, key),
    };
    assert.deepEqual(seen, { papa: 'Nordsee', mama: 'Nordsee', oma: 'Nordsee' },
      `FINDING A, in its steady state: story 18.2 is dead from the second launch onward. `
      + `The co-editor is the only person who can see her own edit. Measured: ${JSON.stringify(seen)}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · FINDING B — MEMBERSHIP AND `_alive` (enumeration row 5)
//
// `authz.js` stage 2 folds `admittedMemberOps` into a FRESH `regs` and derives `currentMembers`
// from it: `member:<id>` exists ∧ `_alive !== false`. `_absorbedAttestOps` rebuilds every
// `dev.*` cell as an op — so after a relaunch every member's record EXISTS in the fold — but it
// rebuilds no `_alive` cell at all. A removed member is therefore ALIVE again inside the fold,
// `membersIn(space)` contains her, and stage 3a's `NOT_MEMBER` gate stops firing.
//
// This is the inverse shape: not a terminal refusal but a terminal ADMISSION. The op the fold
// refused yesterday is stored on disk today.
//
// COST: `materialize`'s `currentMembers` filter still hides her entries, so the board is right —
// TODAY. The removed member's post-removal writes are nonetheless admitted, folded and persisted
// into every remaining Mac's register map, and the moment she is re-added (story 20.5's re-join)
// they all appear. `store.js#_withdrawalsOf`'s docblock names this exact hazard as owed: *"the two
// mechanisms must be designed together or a re-join will resurrect what the other one hid."*
// §2c measures the resurrection, and §2d is the control that proves the relaunch caused it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · FINDING B · the removal gate is a fold over ops, and the fold loses it', () => {
  test('§2a · GREEN · CONTROL — with nobody relaunched, a removed member\'s write is refused', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.mama, { 'pub.text': 'Vor der Entfernung' });
    await setAlive(C, C.mama, false);
    await converge(C, [C.oma]);

    const key = await share(C, C.mama, { 'pub.text': 'NACH DER ENTFERNUNG' });
    assert.equal(await textOn(C.oma, key), null,
      'the gate holds while the ops are still lines');
    let why = [];
    await on(C.oma, () => { why = C.oma.store.warnings.filter((w) => /refused: notMember/.test(w)); });
    assert.ok(why.length >= 1, `and the reason is notMember — got ${JSON.stringify(why)}`);
  });

  test('§2b · RED · after one quit-and-open the removed member\'s write is ADMITTED', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.mama, { 'pub.text': 'Vor der Entfernung' });
    await setAlive(C, C.mama, false);
    await converge(C, [C.oma]);
    await quitAndOpen(C, C.oma);

    const key = await share(C, C.mama, { 'pub.text': 'NACH RELAUNCH' });
    let held = null;
    await on(C.oma, () => { held = C.oma.store.registers().get(key) ? 'yes' : 'no'; });
    assert.equal(held, 'no',
      `FINDING B: stage 3a's NOT_MEMBER gate is gone after a relaunch. Oma's register map now `
      + `holds a removed member's post-removal entry (pub.text = ${JSON.stringify(await textOn(C.oma, key))}). `
      + `Only materialize()'s render-time currentMembers filter still hides it — two layers became one.`);
  });

  test('§2c · RED · and a re-join publishes everything she wrote while removed', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.mama, { 'pub.text': 'Vor der Entfernung' });
    await setAlive(C, C.mama, false);
    await converge(C, [C.oma]);
    await quitAndOpen(C, C.oma);
    await share(C, C.mama, { 'pub.text': 'WAEHREND DER ENTFERNUNG' });
    await setAlive(C, C.mama, true);
    await converge(C, [C.oma]);

    let texts = [];
    await on(C.oma, () => { texts = C.oma.store.state.notes.map((n) => n.text).sort(); });
    assert.ok(!texts.includes('WAEHREND DER ENTFERNUNG'),
      `FINDING B, the cost: a re-join resurrects what the removal hid. Oma's board reads `
      + `${JSON.stringify(texts)}. The control §2d shows that without the relaunch it reads `
      + `["Mein eigener Eintrag","Vor der Entfernung"].`);
  });

  test('§2d · GREEN · CONTROL — no relaunch, and the re-join resurrects nothing', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.mama, { 'pub.text': 'Vor der Entfernung' });
    await setAlive(C, C.mama, false);
    await converge(C, [C.oma]);
    await share(C, C.mama, { 'pub.text': 'WAEHREND DER ENTFERNUNG' });
    await setAlive(C, C.mama, true);
    await converge(C, [C.oma]);

    let texts = [];
    await on(C.oma, () => { texts = C.oma.store.state.notes.map((n) => n.text).sort(); });
    assert.deepEqual(texts, ['Mein eigener Eintrag', 'Vor der Entfernung'],
      'the relaunch is the whole difference between this row and §2c');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · FINDING C — THE ADMIN CHAIN AFTER A SEAT TRANSFER (enumeration row 3; R-1b)
//
// `_absorbedChainOps` rebuilds the admin link ONLY when `cell.author === cell.value` — §4.1's
// genesis test. A TRANSFER's cell has `author = the outgoing admin` and `value = the incoming
// one`, so the guard returns `[]`, no chain is rebuilt at all, `adminAtKey` answers `null`, and
// stage 3a refuses the seated admin's unshare `notOwner`.
//
// `notOwner` is in neither `CURABLE_REFUSALS` nor `RETROACTIVE_REFUSALS`: it is not parked, not
// re-offered and not re-judged. TERMINAL.
//
// The residual is DOCUMENTED in `store.js` ("No shipped circle transfers the seat yet"), but the
// cost is not: §3c measures it and it is not the admin's own Mac that pays, it is the entry's
// OWNER. `store.familyAdmin()` reads the REGISTER map, so her UI names the correct admin the
// whole time — the app looks entirely healthy while the moderation silently does not apply.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · FINDING C · the admin chain repair covers genesis only', () => {
  test('§3a · GREEN · CONTROL — a GENESIS admin\'s unshare survives two relaunches', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    const key = await share(C, C.mama, { 'pub.text': 'Mamas Eintrag' });
    await quitAndOpen(C, C.oma);
    await quitAndOpen(C, C.papa);
    await adminUnshare(C, C.papa, key);
    await converge(C, [C.mama, C.oma]);
    for (const m of [C.papa, C.mama, C.oma]) {
      assert.equal(await levelOn(m, key), 'privat', `${m.tag} did not apply the genesis admin's unshare`);
    }
  });

  test('§3b · GREEN · NON-VACUITY — the transfer really seats the new admin on every Mac', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await on(C.papa, async () => {
      const head = C.papa.store.familyAdmin().headOpId;
      const ctx = C.papa.store._ctx();
      await pushOp(C, C.papa, Object.freeze({
        v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: C.spaceId,
        act: C.papa.forStore.memberId, dev: C.papa.forStore.deviceId, gid: ctx.gid,
        k: 'space.set', e: `space:${C.spaceId}`,
        f: { admin: C.oma.forStore.memberId, adminPrev: head },
      }));
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama, C.oma]);
    for (const m of [C.papa, C.mama, C.oma]) {
      let who = null;
      await on(m, () => { who = m.store.familyAdmin()?.admin; });
      assert.equal(who, C.oma.forStore.memberId, `${m.tag} does not name Oma as admin`);
    }
  });

  test('§3c · RED · R-1b · a TRANSFERRED admin\'s unshare is refused by every relaunched Mac', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    const key = await share(C, C.mama, { 'pub.text': 'Mamas Eintrag' });
    await on(C.papa, async () => {
      const head = C.papa.store.familyAdmin().headOpId;
      const ctx = C.papa.store._ctx();
      await pushOp(C, C.papa, Object.freeze({
        v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: C.spaceId,
        act: C.papa.forStore.memberId, dev: C.papa.forStore.deviceId, gid: ctx.gid,
        k: 'space.set', e: `space:${C.spaceId}`,
        f: { admin: C.oma.forStore.memberId, adminPrev: head },
      }));
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama, C.oma]);

    // MAMA — the OWNER of the entry, a bystander to the transfer — quits and opens again.
    await quitAndOpen(C, C.mama);
    let named = null;
    await on(C.mama, () => { named = C.mama.store.familyAdmin()?.admin; });
    assert.equal(named, C.oma.forStore.memberId,
      'her UI still names the right admin — which is what makes the failure invisible');

    await adminUnshare(C, C.oma, key);
    await converge(C, [C.papa, C.mama]);
    await converge(C, [C.papa, C.mama]);

    assert.equal(await levelOn(C.papa, key), 'privat', 'the Mac that did not relaunch applied it');
    let why = [];
    await on(C.mama, () => { why = C.mama.store.warnings.filter((w) => /refused/.test(w)); });
    assert.equal(await levelOn(C.mama, key), 'privat',
      `FINDING C (R-1b): the family unshared Mama's entry; Mama's own Mac refused the moderation `
      + `and still shows it at ${JSON.stringify(await levelOn(C.mama, key))} with text `
      + `${JSON.stringify(await textOn(C.mama, key))}. Refusals: ${JSON.stringify(why)}. `
      + `Two syncs, terminal — notOwner is in neither CURABLE_REFUSALS nor RETROACTIVE_REFUSALS.`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · FINDING D — THE EXPOSURE BADGE (enumeration row 8)
//
// `store.js#_exposureCtx()` walks `this._log.lines()` to answer `lastAckedPubLevel(fkey)`: "the
// NEWEST `pub.level` among ops that carry a server seq". Lines are exactly what a persist absorbs.
// After a relaunch the walk sees nothing, `lastAckedPubLevel` returns `null` for every entity, and
// `materialize.js#exposureOf` reads `ctx.lastAckedPubLevel(fkey) || 'privat'`.
//
// So `entry.exposure.level` is `'privat'` for every shared entry on every launch after the first,
// while the family really does still see it at Geteilt.
//
// ADR 004 §6, quoted in the code above the function itself: *"The badge must never promise a
// privacy state that has not yet reached the server"*, and the docblock's own account of the two
// error directions ends "the badge never UNDER-reports what others can see". This under-reports
// it, on every entry, on every launch. There is no `pending` flag to soften it either — the same
// empty walk makes `pendingPub` false.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · FINDING D · the exposure badge reads Privat for everything after a relaunch', () => {
  test('§4a · RED · a Geteilt entry\'s badge says Privat on the second launch', async () => {
    const C = await circle(['papa', 'mama']);
    let id = null;
    await on(C.papa, async () => {
      id = C.papa.store.state.notes[0].id;
      C.papa.store.txn('set-visibility', (tx) => { tx.note(id).set({ visibility: 'geteilt' }); });
      await C.papa.store.persistNow();
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama]);

    let before = null;
    await on(C.papa, () => { before = C.papa.store.state.notes.find((n) => n.id === id).exposure; });
    assert.deepEqual(before, { level: 'geteilt', pending: false },
      'non-vacuity: the badge is correct in the launch that authored the publication');

    await quitAndOpen(C, C.papa);
    let after = null;
    let visibility = null;
    await on(C.papa, () => {
      const n = C.papa.store.state.notes.find((x) => x.id === id);
      after = n.exposure; visibility = n.visibility;
    });
    assert.equal(visibility, 'geteilt', 'the entry really is still shared — the family still sees it');
    assert.deepEqual(after, { level: 'geteilt', pending: false },
      `FINDING D: after one quit-and-open the badge reads ${JSON.stringify(after)} for an entry `
      + `whose visibility is still "${visibility}". ADR 004 §6's forbidden direction: the badge `
      + `under-reports what others can see, on every shared entry, on every launch after the first.`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · NOT A COMPACTION FINDING — a claimed-built story with no wiring at all
//
// Found while enumerating what `_project()` hands `materialize()`. Story 17.5 (the quiet „neu"
// dot) is marked **built** in `docs/v2/V2-FINAL.md` under LZP-804 and LZP-1005. Its function,
// `materialize.js#isNewOf`, needs one of `ctx.seqOf` / `ctx.isNew` and returns `false` with
// neither. `store.js#_project()` supplies `me`, `familySpaceId`, `_memberCtx()`, `_exposureCtx()`
// and `defaultSettings` — and NONE of `seqOf`, `isNew`, `levelDecreased` or `lastSeenSeq`.
// `grep -rn "seqOf:\|isNew:\|levelDecreased:" src/js` finds no producer anywhere in the app.
//
// `tests/tier1/core-materialize.test.js` proves the FUNCTION works when fed. Nothing feeds it, and
// nothing tests the seam, so a unit-green story renders nothing on a real board.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · 17.5 · the „neu" dot is unreachable in the shipped projection', () => {
  test('§5a · RED · a peer\'s brand-new shared entry never carries isNew', async () => {
    const C = await circle(['papa', 'mama']);
    await share(C, C.papa, { 'pub.text': 'Herbstferien' });
    let row = null;
    await on(C.mama, () => {
      row = C.mama.store.state.notes.find((n) => n.text === 'Herbstferien') ?? null;
    });
    assert.ok(row, 'non-vacuity: Papa\'s entry really is on Mama\'s board');
    assert.equal(row.isNew, true,
      `17.5 is marked "built" in V2-FINAL.md, but store._project() supplies neither ctx.seqOf nor `
      + `ctx.isNew nor ctx.lastSeenSeq, so materialize.js#isNewOf returns false unconditionally. `
      + `Measured: isNew = ${JSON.stringify(row.isNew)} on an entry that arrived seconds ago.`);
  });
});
