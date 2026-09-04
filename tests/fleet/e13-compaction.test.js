// FLEET · E13 — THE ONE MOVE 5,612 GREEN ROWS NEVER MADE: A QUIT AND OPEN.
// Stories 18.2, 20.2, 16.6, 17.5 · ADR 001 §4.0/§4.1/§4.3/§7.2 · ADR 004 §5/§6/§7.2 ·
// ADR 006 §6/§9.2 · addendum principles 8, 9, 10 · residual R-1b.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS AT ALL
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Every family rig in `tests/fleet/` builds its circle with `e6-attack-circle.js#bootMac`, which
// is a FIRST INSTALL — clear the disk, seed `board.json`, `init()` once — and then never quits.
// Measured with `grep -c relaunch`, TWELVE of the 33 fleet files were 0, and they are every
// co-editor rig and every removal rig this product has. The shipped-app acceptance battery
// (`scripts/shell-family-e2e.mjs`, 27 launches) relaunches and has no co-edit phase at all.
//
// So the product had 5,612 green rows and not one of them ever asked what a fold reads AFTER a
// checkpoint. The answer, measured in §0 below: a converged three-Mac circle holds 8 ops as
// LINES before the first quit-and-open and 0 after it, with not one register lost. Four things
// the fold reads from ops die there, and three of the four are terminal — the refusal is in
// neither `CURABLE_REFUSALS` nor `RETROACTIVE_REFUSALS`, so it is never re-judged.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE GENERAL STATEMENT THIS FILE PINS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ADR 006: board.json is the truth, the op log is history. So for every fact a fold reads from
// an op, ask which of the two it is.
//
//   A QUESTION ABOUT THE PRESENT — "did the owner grant co-edit?", "is she still a member?",
//   "what has the relay acknowledged?" — the REGISTER answers. And it answers EXACTLY: a cell is
//   `{value, stamp, author, op}`, which is `f`, `ts`, `act` and `id`, and `devOf(stamp)` matched
//   against the author's own `dev.*` record is `dev`. `store.js#_absorbedGovernanceOps` is that
//   sentence, table-driven, and `_absorbedOps` joins it to the two repairs that already existed
//   (`_absorbedAttestOps`, `_absorbedChainOps`) at all three fold sites.
//
//   A QUESTION ABOUT HISTORY — the admin CHAIN, a causal sequence of `space.set{admin,adminPrev}`
//   links — a register CANNOT answer, because LWW keeps only the winner. There the other clause
//   applies: the op belongs outside compaction. `store.js#isAdminLink` + `_persistOps` ①/④.
//   `tests/fleet/e12-unshare.test.js` §8 pins that the reconstruction refuses to GUESS a
//   transfer, and it still does; this is why it no longer has to.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, in a scratch copy of the tree, baseline restored between
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   Every kill below is MEASURED, per file, in a scratch copy of the tree with the baseline
//   restored between runs. Baseline: E13 26/26, E9-A 11/11.
//
//   M-E13-1  `store.js#_absorbedGovernanceOps` → `return []`      (the whole general repair off)
//            dies  E13 §1b §1c §2b §2c §6b §6c §6d  ·  E9-A §2a
//   M-E13-2  the `pub.*` row of `ABSORBED_ROWS` matches no entity  (F2's half only)
//            dies  E13 §1b §1c §6b §6c §6d  ·  E9-A §2a       — §2b/§2c survive: those are F3
//   M-E13-3  the `_alive` row of `ABSORBED_ROWS` matches no entity (F3's half only)
//            dies  E13 §2b §2c                                — §1 survives: that is F2
//   M-E13-4  `store.js#isAdminLink` → `() => false`               (retention off, R-1b re-opens)
//            dies  E13 §0b §3b §3c                            — §3a's GENESIS control survives,
//            which is the whole point: the genesis half was already closed by a reconstruction
//   M-E13-5  `_exposureCtx`'s acked floor is replaced by an empty map      (F4)
//            dies  E13 §4b §4c                                — §4a, the pre-quit row, survives
//   M-E13-6  `seqOf` is not returned from `_exposureCtx`                   (F6)
//            dies  E13 §5a §5b §5e   (§5b dies on its own non-vacuity, honestly: with no seq
//            hook nothing dots, so "it dotted before the downgrade" is false)
//   M-E13-7  `levelDecreased` → `() => false`                              (principle 9)
//            dies  E13 §5b ONLY                               — §5a survives, so the dot is not
//            merely off; it is on, and suppressed for the one reason ADR 004 §7 names
//   M-E13-8  `_absorbedGovernanceOps` groups by `${cell.op}|${name}` instead of `cell.op`
//            — one rebuilt op PER CELL, i.e. three bodies under one opId
//            dies  E13 §1b §1c §6c  ·  E9-A §2a.  NOT a cosmetic kill: `foldAuthorized` Pass A
//            reads three bodies under one opId as ENVELOPE SPLICING (ADR 002 §5.1), resolves it
//            by canonical max, and TWO of the three governing fields are discarded — so the
//            grant is lost exactly as it was before the repair.
//
//   HONEST-PATH CONTROLS, green under every mutant above and under the fix:
//     §1a  a co-edit with nobody relaunched
//     §2a  a removed member refused with nobody relaunched
//     §3a  a GENESIS admin's unshare across two relaunches
//     §5c  my own entry never dots, whatever the seq says
//
// ⚠ EVERY ROW IN THIS FILE RELAUNCHES, except the four controls that exist to prove the
//   relaunch is the whole difference. A row that does not reboot cannot see any of this.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { unsharePatch } from '../../src/js/core/authz.js';
import { brandFamilyPatch } from '../../src/js/crypto/envelope.js';

import {
  circle, converge, on, mkPubSet, patchedOp, regsOf,
} from './e9-attack-kit.js';
import { engineFor, pushOp } from './e6-attack-circle.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE MOVE
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * QUIT AND OPEN AGAIN ON THE SAME DISK — `persistNow()` then `init()` over the same storage,
 * exactly what `tests/helpers/fleet.js#relaunch` does for the PERSONAL fleet, with the family
 * engine rebuilt afterwards because a real quit drops it.
 *
 * It is deliberately thin. Everything this file measures is a consequence of `_persistOps`
 * writing a checkpoint and `oplog.load()` reading one; nothing here shapes what is written.
 */
async function quitAndOpen(C, mac) {
  await on(mac, async () => {
    clearTimeout(mac.store._saveTimer);
    await mac.store.persistNow();
    mac.store.ready = false;
    mac.store.listeners.clear();
    await mac.store.init();
    mac.engine = engineFor(C, mac);
  });
}

/** Lines vs registers, the two numbers the whole file is about. */
function shape(mac) {
  return {
    ops: mac.store._log.ops({ includeParked: true }).length,
    registers: [...mac.store._log.registers().keys()].length,
    horizon: mac.store._log.horizon(),
  };
}

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

/** The admin's §4.3 unshare, built exactly as `core/project.js#adminUnshareOp` builds it. */
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

/** `member.set{_alive}` from the admin — story 20.2's removal op, and its inverse. */
const setAlive = (C, subject, alive) => on(C.papa, async () => {
  const ctx = C.papa.store._ctx();
  await pushOp(C, C.papa, Object.freeze({
    v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: C.spaceId,
    act: C.papa.forStore.memberId, dev: C.papa.forStore.deviceId, gid: ctx.gid,
    k: 'member.set', e: `member:${subject.forStore.memberId}`, f: { _alive: alive },
  }));
  await C.papa.engine.syncNow();
});

/** The shipped `transferAdmin` mutation, through the shipped seal. */
async function transferSeat(C, from, to) {
  let head = null;
  await on(from, () => { head = from.store.familyAdmin().headOpId; });
  assert.ok(head, 'the admin chain has no head on the admin\'s own Mac');
  await on(from, async () => {
    const ctx = from.store._ctx();
    await pushOp(C, from, Object.freeze({
      v: 1, id: ctx.newOpId(), ts: ctx.mint(), space: C.spaceId,
      act: from.forStore.memberId, dev: from.forStore.deviceId, gid: ctx.gid,
      k: 'space.set', e: `space:${C.spaceId}`,
      f: { admin: to.forStore.memberId, adminPrev: head },
    }));
    await from.engine.syncNow();
  });
  await converge(C, C.macs.filter((m) => m !== from));
}

const textOn = async (mac, key) => (await regsOf(mac, key))?.['pub.text'] ?? null;
const levelOn = async (mac, key) => (await regsOf(mac, key))?.['pub.level'] ?? null;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · THE MECHANISM — what a quit-and-open does, and what it is now made to keep
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E13 §0 · absorption is total, and it happens on the FIRST quit-and-open', () => {
  test('§0a · a converged circle holds its ops as LINES; one relaunch turns every one into a register', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.mama, { 'pub.text': 'Mamas Eintrag' });

    let before = null;
    await on(C.oma, () => { before = shape(C.oma); });
    assert.ok(before.ops >= 8,
      `non-vacuity: the circle must actually hold ops as lines, got ${before.ops}`);
    assert.equal(before.horizon, null, 'before the first persist there is no horizon');

    await quitAndOpen(C, C.oma);
    let after = null;
    await on(C.oma, () => { after = shape(C.oma); });

    // `TAIL_COMPACT_AT` (5 000) is never reached and is irrelevant. `_persistOps` ① skips every
    // line at or below `_comingHorizon()`, which is `horizon ?? maxLiveStamp` — i.e. EVERY line.
    assert.ok(after.ops <= 1,
      `one ordinary quit-and-open absorbed the log. before=${before.ops} after=${after.ops}`);
    assert.equal(after.registers, before.registers,
      'and not one register was lost — which is exactly why nothing downstream noticed');
    assert.notEqual(after.horizon, null, 'the checkpoint horizon now covers everything');
  });

  test('§0b · the ONE line kept back is the admin chain, and it is kept because a register cannot express it', async () => {
    const C = await circle(['papa', 'mama']);
    await share(C, C.papa, { 'pub.text': 'Herbstferien' });
    await quitAndOpen(C, C.papa);

    let kept = null;
    await on(C.papa, () => {
      kept = C.papa.store._log.ops({ includeParked: true });
    });
    assert.equal(kept.length, 1, `exactly one line survives the absorption, got ${kept.length}`);
    assert.equal(kept[0].k, 'space.set', 'and it is an admin-chain link');
    assert.ok(Object.prototype.hasOwnProperty.call(kept[0].f, 'adminPrev'),
      'a `space.set` without `adminPrev` is not a chain link — `core/authz.js#linkOf` says so');

    // It is on DISK, not merely in memory: `_persistOps` ④ truncates and puts it back.
    const tail = String(C.papa.disk['langzeitplaner.ops'] ?? '');
    assert.match(tail, /"k":"space\.set"/,
      'the retained link must be in ops.jsonl or the NEXT launch loses it');
    assert.equal(tail.trim().split('\n').filter(Boolean).length, 1,
      `the bound is one line per transfer plus genesis — got ${tail.trim().split('\n').filter(Boolean).length}`);
  });

  test('§0c · a SOLO board writes no such line — the retention is inert outside a circle', async () => {
    // `space.set` is a family-space op kind (`core/ops.js#spaceFor`), so a board with no circle
    // has none, and every step of `_persistOps` takes the path it took before this landed.
    const C = await circle(['papa', 'mama']);
    let retained = null;
    await on(C.papa, () => {
      const real = C.papa.store._familySpaceId;
      C.papa.store._familySpaceId = null;
      try { retained = C.papa.store._retainedTailLines(); } finally { C.papa.store._familySpaceId = real; }
    });
    assert.deepEqual(retained, [], 'a store with no family space retains nothing');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · F2 · STORY 18.2 — „FAMILIE DARF BEARBEITEN", ACROSS A QUIT AND OPEN
//
// `authz.js` stage 3a built `govRegs` from `emptyRegs()` and folded ONLY the `pub.set` ops IN
// THIS FOLD. After a relaunch the owner's granting op is a register and not an op, `govRegs` is
// empty for that entity, and stage 3b refuses every co-editor write `noCoEdit` — which is in
// neither `CURABLE_REFUSALS` nor `RETROACTIVE_REFUSALS`, so the line is dropped, the relay's
// `since` cursor has moved past it, and no later pull can serve it again. TERMINAL.
//
// The door stayed open the whole time: `store.familyCoEditLevelOf` reads `store.registers()`,
// which DOES retain the grant, so the checkbox and the editable field were still offered. The
// co-editor typed, saw her own text, and was told nothing.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E13 §1 · F2 · a co-edit survives the relaunch that used to kill it for ever', () => {
  test('§1a · CONTROL · with nobody relaunched, the co-edit lands on all three Macs', async () => {
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

  test('§1b · one Mac quits and opens; it still folds the co-edit, and refuses nothing', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    const key = await share(C, C.papa, { 'pub.coEdit': true, 'pub.text': 'Herbstferien' });
    assert.equal(await textOn(C.oma, key), 'Herbstferien');

    await quitAndOpen(C, C.oma);          // ← the whole difference from §1a

    await on(C.mama, async () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(key), 'geteilt',
        'the door opens — and now the receiving side agrees with it');
      assert.equal(C.mama.store.applyCoEdit(key, { 'pub.text': 'Nordsee' }), true);
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma]);

    assert.equal(await textOn(C.papa, key), 'Nordsee', 'the Mac that did not relaunch is fine');
    assert.equal(await textOn(C.oma, key), 'Nordsee',
      'and so is the one that did — this is the row story 18.2 lived or died on');

    let refusals = [];
    await on(C.oma, () => {
      refusals = C.oma.store.warnings.filter((w) => /noCoEdit/.test(w));
    });
    assert.deepEqual(refusals, [],
      `the relaunched Mac refused a co-edit: ${JSON.stringify(refusals)}`);
  });

  test('§1c · the steady state of day two — every Mac has relaunched, and the circle still converges', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    const key = await share(C, C.papa, { 'pub.coEdit': true, 'pub.text': 'Herbstferien' });
    for (const m of [C.papa, C.mama, C.oma]) await quitAndOpen(C, m);

    await on(C.mama, async () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(key), 'geteilt');
      assert.equal(C.mama.store.applyCoEdit(key, { 'pub.text': 'Nordsee' }), true);
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma]);

    const seen = {
      papa: await textOn(C.papa, key), mama: await textOn(C.mama, key), oma: await textOn(C.oma, key),
    };
    assert.deepEqual(seen, { papa: 'Nordsee', mama: 'Nordsee', oma: 'Nordsee' },
      `three Macs, one board. Measured: ${JSON.stringify(seen)}`);
  });

  test('§1d · and the grant is still a GRANT — an entry with no flag is refused after a relaunch too', async () => {
    // The repair rebuilds the governing registers; it must not INVENT them. 18.1's default is
    // that nobody may edit, and a rebuilt `govRegs` that answered "co-edit" for an ungranted
    // entity would be a far worse defect than the one it closes.
    const C = await circle(['papa', 'mama', 'oma']);
    const key = await share(C, C.papa, { 'pub.text': 'Zahnarzt' });
    for (const m of [C.papa, C.mama, C.oma]) await quitAndOpen(C, m);

    await on(C.mama, async () => {
      assert.equal(C.mama.store.familyCoEditLevelOf(key), null,
        'the owner granted nothing, and a relaunch does not grant it');
      assert.equal(C.mama.store.applyCoEdit(key, { 'pub.text': 'gekapert' }), false);
    });
    // And by the other door: an op minted anyway is refused by every peer.
    await on(C.mama, () => patchedOp(C, C.mama, mkPubSet(C, C.mama, key, { 'pub.text': 'gekapert' })));
    await converge(C, [C.papa, C.oma]);
    for (const m of [C.papa, C.oma]) {
      assert.equal(await textOn(m, key), 'Zahnarzt',
        `${m.tag} folded a co-edit on an entry the owner never opened`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · F3 · STORY 20.2 — A REMOVAL THAT STAYS REMOVED
//
// Stage 2 derives `currentMembers` from a FRESH fold of the ops in this fold: `member:<id>`
// exists ∧ `_alive !== false`. `_absorbedAttestOps` rebuilds every `dev.*` cell — so every
// member's record exists again — and rebuilt NO `_alive` cell. A removed member was therefore
// alive again inside the fold, and her post-removal write was admitted, folded and persisted.
//
// The inverse shape of §1: not a terminal refusal but a terminal ADMISSION. `materialize`'s
// render-time `currentMembers` filter still hid it, so the board was right until the re-join —
// and `store.js#_withdrawalsOf`'s docblock names that exact hazard as owed: *"the two mechanisms
// must be designed together or a re-join will resurrect what the other one hid."*
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E13 §2 · F3 · the removal gate survives the fold that used to lose it', () => {
  test('§2a · CONTROL · with nobody relaunched, a removed member\'s write is refused notMember', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.mama, { 'pub.text': 'Vor der Entfernung' });
    await setAlive(C, C.mama, false);
    await converge(C, [C.oma]);

    const key = await share(C, C.mama, { 'pub.text': 'NACH DER ENTFERNUNG' });
    assert.equal(await textOn(C.oma, key), null, 'the gate holds while the ops are still lines');
    let why = [];
    await on(C.oma, () => { why = C.oma.store.warnings.filter((w) => /refused: notMember/.test(w)); });
    assert.ok(why.length >= 1, `and the reason is notMember — got ${JSON.stringify(why)}`);
  });

  test('§2b · after a quit-and-open the removed member\'s write is STILL refused', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.mama, { 'pub.text': 'Vor der Entfernung' });
    await setAlive(C, C.mama, false);
    await converge(C, [C.oma]);
    await quitAndOpen(C, C.oma);

    const key = await share(C, C.mama, { 'pub.text': 'NACH RELAUNCH' });
    let held = null;
    await on(C.oma, () => { held = C.oma.store.registers().get(key) ? 'yes' : 'no'; });
    assert.equal(held, 'no',
      `a removed member's post-removal entry entered a relaunched Mac's register map `
      + `(pub.text = ${JSON.stringify(await textOn(C.oma, key))}). Two layers of defence, not one.`);
  });

  test('§2c · and a re-join resurrects nothing she wrote while removed (20.5)', async () => {
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
      `the re-join resurrected what the removal hid. Oma's board reads ${JSON.stringify(texts)}.`);
    assert.deepEqual(texts, ['Mein eigener Eintrag', 'Vor der Entfernung'],
      'and it reads exactly what the no-relaunch control reads');
  });

  test('§2d · a member who was never removed is not removed by the rebuild either', async () => {
    // The mirror of §1d: rebuilding `_alive` must not invent a `false`. A rebuild that dropped
    // an honest member out of `currentMembers` would refuse the whole family `notMember`.
    const C = await circle(['papa', 'mama', 'oma']);
    for (const m of [C.papa, C.mama, C.oma]) await quitAndOpen(C, m);
    const key = await share(C, C.mama, { 'pub.text': 'Nach dem Neustart' });
    for (const m of [C.papa, C.oma]) {
      assert.equal(await textOn(m, key), 'Nach dem Neustart',
        `${m.tag} refused an ordinary member's ordinary entry after a relaunch`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · R-1b · THE MODERATION PATH AFTER THE SEAT HAS MOVED
//
// `_absorbedChainOps` rebuilds a link only when `cell.author === cell.value` — §4.1's own root
// test, and the LIMIT of what one register cell contains. A transfer's cell has
// `author = the outgoing admin`, `value = the incoming one`, so no chain is rebuilt,
// `adminAtKey` answers `null`, and stage 3a refuses the seated admin's unshare `notOwner` —
// terminal. And `store.familyAdmin()` reads the REGISTER map, so the victim's UI names the right
// admin throughout: the app looks entirely healthy while the moderation silently does not apply.
//
// The victim is not a participant in the transfer. It is the entry's OWNER, a bystander.
//
// This is the half of the general statement that is NOT a reconstruction: a chain is history, a
// register keeps only its head, so the LINK STAYS OUT OF COMPACTION. `store.js#isAdminLink`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E13 §3 · R-1b · a transferred seat still moderates after the owner relaunches', () => {
  test('§3a · CONTROL · a GENESIS admin\'s unshare survives two relaunches (this was already true)', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    const key = await share(C, C.mama, { 'pub.text': 'Mamas Eintrag' });
    await quitAndOpen(C, C.oma);
    await quitAndOpen(C, C.papa);
    await adminUnshare(C, C.papa, key);
    await converge(C, [C.mama, C.oma]);
    for (const m of [C.papa, C.mama, C.oma]) {
      assert.equal(await levelOn(m, key), 'privat',
        `${m.tag} did not apply the genesis admin's unshare`);
    }
  });

  test('§3b · a TRANSFERRED admin\'s unshare reaches the relaunched BYSTANDER who owns the entry', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    const key = await share(C, C.mama, { 'pub.text': 'Mamas Eintrag' });
    await transferSeat(C, C.papa, C.oma);

    // MAMA — the OWNER of the entry, a bystander to the transfer — quits and opens again.
    await quitAndOpen(C, C.mama);
    let named = null;
    await on(C.mama, () => { named = C.mama.store.familyAdmin()?.admin; });
    assert.equal(named, C.oma.forStore.memberId,
      'her UI names the right admin — which is what used to make the failure invisible');

    await adminUnshare(C, C.oma, key);
    await converge(C, [C.papa, C.mama]);

    assert.equal(await levelOn(C.papa, key), 'privat', 'the Mac that did not relaunch applied it');
    let why = [];
    await on(C.mama, () => { why = C.mama.store.warnings.filter((w) => /notOwner/.test(w)); });
    assert.equal(await levelOn(C.mama, key), 'privat',
      `the family unshared Mama's entry and Mama's own Mac still shows it at `
      + `${JSON.stringify(await levelOn(C.mama, key))} with text ${JSON.stringify(await textOn(C.mama, key))}. `
      + `Refusals: ${JSON.stringify(why)}`);
    assert.deepEqual(why, [], 'and it did not refuse it and then agree by accident');
  });

  test('§3c · the retained links come back as LINES on the next launch, not as a second copy', async () => {
    // The reconstruction must stay silent about anything the log still holds: a second copy of a
    // live op under one opId is what `foldAuthorized` Pass A reads as ENVELOPE SPLICING.
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.mama, { 'pub.text': 'Mamas Eintrag' });
    await transferSeat(C, C.papa, C.oma);
    await quitAndOpen(C, C.mama);
    await quitAndOpen(C, C.mama);           // twice: the truncate/re-append cycle runs again

    let links = null;
    let rebuilt = null;
    let spliced = null;
    await on(C.mama, () => {
      links = C.mama.store._log.ops({ includeParked: true }).filter((o) => o.k === 'space.set');
      rebuilt = C.mama.store._absorbedChainOps();
      spliced = C.mama.store._log.splicedIds ? C.mama.store._log.splicedIds() : [];
    });
    assert.equal(links.length, 2, `both chain links survived two relaunches, got ${links.length}`);
    assert.deepEqual(rebuilt, [],
      'a link that is still a LINE must not be rebuilt beside itself');
    assert.deepEqual(spliced, [], 'and no opId was ever seen under two bodies');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · F4 · STORY 16.6 — THE EXPOSURE BADGE, ADR 004 §6's FORBIDDEN DIRECTION
//
// `_exposureCtx()` walked `this._log.lines()` to answer `lastAckedPubLevel(fkey)`, and lines are
// exactly what a persist absorbs. `materialize.js#exposureOf` reads
// `ctx.lastAckedPubLevel(fkey) || 'privat'`. So a Geteilt entry's badge read PRIVAT on every
// launch after the first, and not even flagged pending, because the same empty walk made
// `pendingPub` false.
//
// ADR 004 §6, quoted in the code directly above that function: *"the badge never UNDER-reports
// what others can see."* Addendum principle 8: *"the user can always see at a glance exactly what
// others can see of them."* A person deciding what to write trusts this badge.
//
// THE REPAIR IS NOT "ASK THE MAP". The map keeps only the WINNER, and the winner of a pending
// downgrade is the op that has not reached the server — asking it would make a pending
// Geteilt→Belegt render as Privat, which is the same forbidden direction by another route. The
// seed is narrower and provable: `_outboxHorizonCap` forbids a persist from folding past the
// oldest unacknowledged line, so a cell whose op is no longer a line IS acknowledged.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E13 §4 · F4 · the exposure badge after a relaunch', () => {
  test('§4a · NON-VACUITY · the badge is correct in the launch that authored the publication', async () => {
    const C = await circle(['papa', 'mama']);
    let before = null;
    await on(C.papa, async () => {
      const id = C.papa.store.state.notes[0].id;
      C.papa.store.txn('set-visibility', (tx) => { tx.note(id).set({ visibility: 'geteilt' }); });
      await C.papa.store.persistNow();
      await C.papa.engine.syncNow();
      before = C.papa.store.state.notes.find((n) => n.id === id).exposure;
    });
    assert.deepEqual(before, { level: 'geteilt', pending: false });
  });

  test('§4b · a Geteilt entry still reads Geteilt on the second launch', async () => {
    const C = await circle(['papa', 'mama']);
    let id = null;
    await on(C.papa, async () => {
      id = C.papa.store.state.notes[0].id;
      C.papa.store.txn('set-visibility', (tx) => { tx.note(id).set({ visibility: 'geteilt' }); });
      await C.papa.store.persistNow();
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama]);
    await quitAndOpen(C, C.papa);

    let after = null;
    let visibility = null;
    await on(C.papa, () => {
      const n = C.papa.store.state.notes.find((x) => x.id === id);
      after = n.exposure; visibility = n.visibility;
    });
    assert.equal(visibility, 'geteilt', 'the entry really is still shared — the family still sees it');
    assert.deepEqual(after, { level: 'geteilt', pending: false },
      `the badge read ${JSON.stringify(after)} for an entry whose visibility is still `
      + `"${visibility}" — ADR 004 §6's forbidden direction, on every shared entry, on every launch`);
  });

  test('§4c · a PENDING downgrade still over-reports rather than under-reports', async () => {
    // The seed must not displace the walk. An unacked `pub.level` is still a LINE, so the walk
    // owns that entity and the badge keeps showing the OLD, HIGHER level with `pending: true` —
    // ADR 004 §6's permitted error direction. Measured after a relaunch, which is the launch the
    // seed exists for.
    const C = await circle(['papa', 'mama']);
    let id = null;
    await on(C.papa, async () => {
      id = C.papa.store.state.notes[0].id;
      C.papa.store.txn('set-visibility', (tx) => { tx.note(id).set({ visibility: 'geteilt' }); });
      await C.papa.store.persistNow();
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama]);
    await quitAndOpen(C, C.papa);

    // Downgrade with no sync: the op is a line with no seq — the outbox.
    await on(C.papa, () => {
      C.papa.store.txn('set-visibility', (tx) => { tx.note(id).set({ visibility: 'belegt' }); });
    });
    let after = null;
    await on(C.papa, () => { after = C.papa.store.state.notes.find((x) => x.id === id).exposure; });
    assert.equal(after.level, 'geteilt',
      `a downgrade the server has not seen must keep reading Geteilt, got ${JSON.stringify(after)}`);
    assert.equal(after.pending, true, 'and it must say so');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · F6 · STORY 17.5 — THE QUIET „NEU" DOT, AND PRINCIPLE 9's ONE PROHIBITION
//
// `materialize.js#isNewOf` needs one of `ctx.seqOf` / `ctx.isNew`; with neither its only
// reachable exit is `return false`. `store.js#_project()` supplied `me`, `familySpaceId`,
// `_memberCtx()`, `_exposureCtx()` and `defaultSettings` — and NONE of `seqOf`, `isNew`,
// `lastSeenSeq`, `levelDecreased`. Everything downstream was wired and blameless: `board.js`
// appends the dot, `layout.js` gates it on `foreign`, `app.css` styles it,
// `settings.lastSeenSeq.<spaceId>` exists as a pref. One call site was short of joining them.
//
// PRINCIPLE 9 CONSTRAINS THE FIX. A „neu" dot must NEVER appear on a DOWNGRADE — that would tell
// a member somebody made something private, which is the surveillance mechanic ADR 004 §7
// forbids. §5b is that row and it is not optional.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E13 §5 · F6 · the „neu" dot lights on a real board, and never on a retraction', () => {
  test('§5a · a peer\'s brand-new shared entry carries the dot', async () => {
    const C = await circle(['papa', 'mama']);
    const key = await share(C, C.papa, { 'pub.text': 'Herbstferien' });
    let row = null;
    await on(C.mama, () => {
      row = C.mama.store.state.notes.find((n) => n.entityKey === key) ?? null;
    });
    assert.ok(row, 'non-vacuity: Papa\'s entry really is on Mama\'s board');
    assert.equal(row.isNew, true,
      `an entry that arrived seconds ago reads isNew = ${JSON.stringify(row.isNew)}`);
  });

  test('§5b · PRINCIPLE 9 · a DOWNGRADE never dots, however new its seq is', async () => {
    const C = await circle(['papa', 'mama']);
    const key = await share(C, C.papa, { 'pub.text': 'Herbstferien' });
    await on(C.mama, () => {
      const row = C.mama.store.state.notes.find((n) => n.entityKey === key);
      assert.equal(row.isNew, true, 'non-vacuity: it dotted before the downgrade');
    });

    // Papa takes it back to Belegt. That is a FRESHER seq than the publication, so a rule that
    // read the seq alone would blink — and would tell Mama that Papa hid something.
    await on(C.papa, async () => {
      await patchedOp(C, C.papa, mkPubSet(C, C.papa, key, {
        'pub.level': 'belegt', 'pub.text': null,
      }, 'belegt'), { levelOf: () => 'belegt' });
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama]);

    let row = null;
    await on(C.mama, () => { row = C.mama.store.state.notes.find((n) => n.entityKey === key); });
    assert.ok(row, 'the entry is still on her board at Belegt');
    assert.equal(row.level, 'belegt', 'non-vacuity: the downgrade really landed');
    assert.equal(row.isNew, false,
      'a dot on a retraction tells a member that somebody made something private — ADR 004 §7');
  });

  test('§5c · CONTROL · my OWN entry never dots, whatever the seq says', async () => {
    // Through the shipped path, so the author holds a TRUTH register and the entry is on his own
    // board as an own entry — `materialize.js#ownCandidate` hard-codes `isNew: false` there and
    // this row is what keeps that true once the hooks are actually supplied.
    const C = await circle(['papa', 'mama']);
    let row = null;
    await on(C.papa, async () => {
      const id = C.papa.store.state.notes[0].id;
      C.papa.store.txn('set-visibility', (tx) => { tx.note(id).set({ visibility: 'geteilt' }); });
      await C.papa.store.persistNow();
      await C.papa.engine.syncNow();
      row = C.papa.store.state.notes.find((n) => n.id === id);
    });
    assert.ok(row, 'the entry is on its own author\'s board');
    assert.equal(row.level, 'geteilt', 'non-vacuity: it really is published');
    assert.equal(row.isNew, false, '17.5 dots a PEER\'s change, never my own');
  });

  test('§5d · what this device already held when it opened is not new', async () => {
    // Without a caller for `markFamilySeen()`, `materialize.js#isNewOf` reads an ABSENT
    // `lastSeenSeq` as "everything is new" — which on a second launch would dot every entry the
    // family has ever shared. `_lastSeenSeqCtx` takes a session floor for exactly that, and
    // `core/replace.js#PRESERVED_PREF_PREFIXES` carries the pref across an import for the same
    // stated reason.
    const C = await circle(['papa', 'mama']);
    const key = await share(C, C.papa, { 'pub.text': 'Herbstferien' });
    await quitAndOpen(C, C.mama);
    let row = null;
    await on(C.mama, () => { row = C.mama.store.state.notes.find((n) => n.entityKey === key); });
    assert.ok(row, 'the entry survived her relaunch');
    assert.equal(row.isNew, false,
      'an entry this Mac already held before it opened must not dot on every launch, for ever');
  });

  test('§5e · markFamilySeen() records the baseline and the dot goes out', async () => {
    const C = await circle(['papa', 'mama']);
    const key = await share(C, C.papa, { 'pub.text': 'Herbstferien' });
    let before = null;
    let moved = null;
    let after = null;
    await on(C.mama, () => {
      before = C.mama.store.state.notes.find((n) => n.entityKey === key).isNew;
      moved = C.mama.store.markFamilySeen();
      after = C.mama.store.state.notes.find((n) => n.entityKey === key).isNew;
    });
    assert.equal(before, true, 'non-vacuity: it was dotted');
    assert.equal(moved, true, 'the baseline moved');
    assert.equal(after, false, '"the dot fades once seen" — ADR 004 §7.2');
    // Device-local (rule U6): the pref is a `local`-space `pref.set` and never reaches the relay.
    let synced = null;
    await on(C.mama, () => {
      synced = C.mama.store._log.ops({ includeParked: true })
        .filter((o) => o.k === 'pref.set' && JSON.stringify(o.f).includes('lastSeenSeq'))
        .map((o) => o.space);
    });
    assert.ok(synced.length >= 1, 'the pref was written');
    assert.deepEqual([...new Set(synced)], ['local'],
      'and it was written into the `local` space, never the family one');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE GUARDS ON THE RECONSTRUCTION ITSELF
//
// A rebuild that invented anything would be a worse defect than the four it closes. These rows
// are the discipline `_absorbedAttestOps` and `_absorbedChainOps` already carry, restated for
// the general form: inert outside a circle, silent about anything the fold already has, and
// unable to name a device its author never attested.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E13 §6 · the reconstruction is bounded, silent and unable to invent', () => {
  test('§6a · INERT outside a family circle — the v1 characterization suite cannot see it', async () => {
    const C = await circle(['papa', 'mama']);
    let out = null;
    await on(C.papa, () => {
      const real = C.papa.store._familySpaceId;
      C.papa.store._familySpaceId = null;
      try { out = C.papa.store._absorbedOps(); } finally { C.papa.store._familySpaceId = real; }
    });
    assert.deepEqual(out, [], 'a store with no family space rebuilds nothing at all');
  });

  test('§6b · SILENT about anything that is still a line, and about an ARRIVING batch', async () => {
    const C = await circle(['papa', 'mama']);
    const key = await share(C, C.papa, { 'pub.coEdit': true, 'pub.text': 'Herbstferien' });
    let live = null;
    await on(C.papa, () => { live = C.papa.store._absorbedGovernanceOps(); });
    assert.deepEqual(live, [],
      'the owner\'s own Mac still holds the granting op as a LINE — rebuilding it beside itself '
      + 'is the envelope-splice defect `_absorbedAttestOps` records');

    await quitAndOpen(C, C.papa);
    let absorbed = null;
    let withArriving = null;
    await on(C.papa, () => {
      absorbed = C.papa.store._absorbedGovernanceOps();
      // The relay re-serves an op whenever a cursor is reset. A cell whose op is in THIS fold's
      // input must not be rebuilt beside it.
      withArriving = C.papa.store._absorbedGovernanceOps(absorbed);
    });
    assert.ok(absorbed.length >= 1, `non-vacuity: something was absorbed, got ${absorbed.length}`);
    assert.ok(absorbed.some((o) => o.e === key && o.f['pub.coEdit'] === true),
      'and the co-edit grant is among what came back');
    assert.deepEqual(withArriving, [],
      'an arriving batch counts as LIVE — not counting it manufactured 2 spliced ids on ops '
      + 'nobody had tampered with (LZP-1008, second pass)');
  });

  test('§6c · one OP, not one op per CELL — a publication rebuilds as a single op', async () => {
    const C = await circle(['papa', 'mama']);
    const key = await share(C, C.papa, { 'pub.coEdit': true, 'pub.text': 'Herbstferien' });
    await quitAndOpen(C, C.papa);
    let mine = null;
    await on(C.papa, () => {
      mine = C.papa.store._absorbedGovernanceOps().filter((o) => o.e === key);
    });
    assert.equal(mine.length, 1,
      `\`publishSharedEntry\` writes pub.level, pub.coEdit and pub.alive in ONE op; rebuilding `
      + `one op per cell is ${mine.length} bodies under ${new Set(mine.map((o) => o.id)).size} `
      + `opId(s), which foldAuthorized Pass A reads as envelope splicing (ADR 002 §5.1)`);
    assert.deepEqual(Object.keys(mine[0].f).sort(), ['pub.alive', 'pub.coEdit', 'pub.level'],
      'and it carries the governing fields — and only those, because content is not an '
      + 'admissibility input and stage 3b reads exactly these three');
  });

  test('§6d · a rebuild cannot name a device its author never attested', async () => {
    // Stage 0b asks `attested.get(op.act).has(op.dev)`. The deviceId is read out of the STAMP's
    // last sixteen characters and matched against the author's own `member:` record; no match,
    // no reconstruction. An invented device would be the one field here nothing backs.
    const C = await circle(['papa', 'mama']);
    await share(C, C.papa, { 'pub.coEdit': true, 'pub.text': 'Herbstferien' });
    await quitAndOpen(C, C.papa);

    let withProof = null;
    let withoutProof = null;
    await on(C.papa, () => {
      withProof = C.papa.store._absorbedGovernanceOps().length;
      const log = C.papa.store._log;
      const realRegs = log.registers.bind(log);
      // Strip every `dev.*` cell: the attestation records the proof is matched against.
      log.registers = () => {
        const out = new Map();
        for (const [e, cells] of realRegs()) {
          const kept = new Map();
          for (const [n, c] of cells) if (!/^dev\./.test(n)) kept.set(n, c);
          out.set(e, kept);
        }
        return out;
      };
      try { withoutProof = C.papa.store._absorbedGovernanceOps().length; } finally { log.registers = realRegs; }
    });
    assert.ok(withProof >= 1, `non-vacuity: with the records present it rebuilds, got ${withProof}`);
    assert.equal(withoutProof, 0,
      'with no attestation to match the stamp against, the rebuild says nothing rather than guessing');
  });
});
