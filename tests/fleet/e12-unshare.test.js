// FLEET · E12 — THE ADMIN UNSHARE ACROSS A RELAUNCH.  F-SHELL-3 / residual R-1.
// Story 18.3 · ADR 001 §4.1 (the admin chain), §4.3 stage 3a · ADR 004 §5, §5.1 · ADR 006 (the
// spine) · `core/authz.js:foldAuthorized` stage 1 + stage 3a · `core/project.js:adminUnshareOp` /
// `adminUnshareFollowUp` · `store.js#_absorbedAttestOps`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS BESIDE `e9-attack-moderation.test.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// E9-C §3a already asserts the whole of 18.3's promise — "it reverts to owner-private, it is
// never deleted" — on a real circle, over the real ops, and it is GREEN. And the shipped app
// fails that exact promise in every measured run (`unshare-owner (B)`, 10 of 10 before this
// pass, 1 of 1 re-measured at HEAD `78016e8`). One line separates the two:
//
//     **E9-C never quits and reopens the owner's Mac. The shipped app is nothing BUT that** —
//     `scripts/shell-family-e2e.mjs` is 26 launches, and the owner relaunches between the share
//     and the moderation because a person closes their laptop.
//
// So this file is E9-C §3a with `relaunch()` in the middle, and that one line is the whole of
// the difference between a green suite and a residual the release notes call data loss.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MECHANISM, NAMED — and it is not in the unshare path at all
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `core/authz.js:1404` (stage 3a) will admit an admin's `pub.set` on an entity the admin does
// not own only if `adminAtKey(spaceKey(op.space), op.ts)` names him. `adminAtKey` reads the
// chain `resolveChain` built at stage 1 — and stage 1 builds it **from `space.set{admin,
// adminPrev}` OPS in the fold's input, never from registers** (`authz.js:1234-1255`).
//
// A checkpoint absorbs ops. On the owner's FIRST relaunch her `_log.ops()` is EMPTY — measured
// below, §3 — while `space:<id>` still carries `admin` in her register map, and
// `store.familyAdmin()` (a register read, `store.js#familyAdmin`) answers correctly. The chain the FOLD
// can see is therefore empty, `adminAtKey` returns `null`, and the retraction is REJECTED
// `notOwner` at `authz.js:1405`. A rejection is FINAL — the op never becomes a line, so L-1
// re-refuses it on every later launch, which is the single `notOwner` in the acceptance run's
// refusal ledger and the whole of the "2" in four of five runs.
//
// This is `F-SHELL-1(b)` one register over. `store.js#_absorbedAttestOps` rebuilds the absorbed
// `member.set{dev.*}` ops from their register cells for exactly this reason; **nothing rebuilds
// the absorbed `space.set{admin}` link**, and §4 below proves that is the whole of it by handing
// the fold one reconstructed link and watching the same retraction be admitted.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION — READ BEFORE TRUSTING A GREEN RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   §1  NON-VACUITY  no relaunch → it reverts. The rig can do this.
//   §2  ✅ CLOSED     relaunch → the retraction lands, the entry reverts to Privat, her text and
//                    her ownership survive. Inverted this pass by `store.js#_absorbedChainOps`.
//   §3  ✅ CLOSED     the mechanism, both halves: the log is STILL emptied of `space.set` lines by
//                    the checkpoint (non-vacuity), and the reconstruction refills the FOLD with
//                    exactly one genesis link, so `adminAtKey` answers the admin, not `null`.
//   §4  the constructive proof: ONE reconstructed link op admits the same retraction, an EMPTY
//                    chain refuses everybody — including a non-admin — and the store's own
//                    `_absorbedChainOps()` is that op field for field. Dies under M-1.
//   §5  ✅ CLOSED     what reaches the person: it was NEVER a delete (her entry, text and `_alive`
//                    were always intact); the reversion now lands too.
//   §6  ✅ CLOSED     F-SHELL-3(b): a relaunch no longer re-imports a FOREIGN entry as one of the
//                    viewer's own Privat notes. `store.js#withoutForeignEntries` + `_buildSpine`.
//                    Three launches, one entry, still foreign.
//   §7  NON-VACUITY  a Mac that has NOT relaunched still moderates. §2 is not "it never works".
//
// THE REPAIR, AND WHERE IT WENT (landed this pass). `store.js` has an `_absorbedChainOps()`
// beside `_absorbedAttestOps()` — same shape, same discipline, spread into the same three fold
// inputs (`_refoldAuthorized`, `applyRemote`, `unparkAttested`) — rebuilding ONE `space.set{admin,
// adminPrev:null}` op per family space out of the `space:<id>` → `admin` cell, with `dev` read
// back out of `devOf(cell.stamp)` and the author's own member record (§4 builds exactly it and
// then asserts the store's copy equals it). The second defect, §6, is closed in the same file by
// `withoutForeignEntries()`, which keeps another member's entry out of the spine `migrateV1`
// authors as mine.
//
// RESIDUAL, NOT CLOSED: only a GENESIS-shaped link is rebuilt (`cell.author === cell.value`). A
// circle whose admin seat has been TRANSFERRED still breaks after compaction — the head link
// names a predecessor that may be gone. The general repair is to keep `space.set` links (and
// `member.set{dev.*}`) out of compaction in `_persistOps`. No shipped circle transfers the seat.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// MUTANTS — one run each, scratch copy of `src/`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-1  `authz.js:1405` — `const who = adminAtKey(spaceKey(op.space), op.ts) ?? op.act;`
//        i.e. let a missing chain mean "whoever asked". MEASURED, in a scratch copy:
//        **§2, §4 and §5 die and §1, §3, §6, §7 stand** — the moderation now lands across the
//        relaunch, and §4's last clause dies BECAUSE A NON-ADMIN'S RETRACTION LANDS TOO, which
//        is why the shortcut is a mutant and not a fix. `e9-attack-moderation.test.js` is
//        UNMOVED at 10/10 under it: its rig never reboots, so the link is still a line, the
//        chain resolves, and the `??` never fires — which is exactly the gap this file fills.
//   M-2  §4's reconstruction with `dev: <the reader's own device>` instead of the device the
//        stamp names. MEASURED, in a scratch copy: **§4 dies ALONE, 6 of 7 still green.** Stage
//        0b (`authz.js:1223`) refuses the rebuilt LINK `unattestedDevice` — Mama's device is not
//        in Papa's attested set — so the chain stays empty and §4 dies with the very `notOwner`
//        it set out to remove. That is why the repair has to read `devOf(cell.stamp)` back out of
//        the author's own member record instead of stamping the reader's device on it.
//   CONTROL, with `src/` untouched and both mutants reverted: every row here is green, and so
//   are `npm test` (2228/0), `test:property` (101/0), `test:attack` (970/0), `test:server`
//   (1003, 0 fail) and the rest of `test:fleet` (434/0, this file's 7 included).

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { devOf } from '../../src/js/core/stamp.js';
import { adminUnshareOp } from '../../src/js/core/project.js';
import {
  foldAuthorized, REJECT_REASONS, parseAttestationBlob,
} from '../../src/js/core/authz.js';

import {
  circle, converge, on, pushOp, regsOf, engineFor,
} from './e9-attack-kit.js';

// ─────────────────────────────────────────────────────────────────────────────
// The rig
// ─────────────────────────────────────────────────────────────────────────────

/**
 * QUIT AND REOPEN ONE MAC ON ITS OWN DISK — the move `scripts/shell-family-e2e.mjs` makes 26
 * times and `e9-attack-kit.js` never makes at all.
 *
 * `persistNow()` then `init()` is exactly what the shell does between two phases: `board.json`
 * is re-migrated into the ADR 006 spine, `checkpoint.json` is read back, and `ops.jsonl` is the
 * only history that survives. The engine is rebuilt because a real quit drops it.
 */
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

/** One member's own note, created and shared through the shipped mutations. */
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

/** The shipped moderation op, sealed the way `sync/family.js:sealLevelFor` seals a retraction. */
async function moderate(C, owner, uuid) {
  let op = null;
  await on(C.papa, async () => {
    op = adminUnshareOp(C.papa.store._ctx(), { kind: 'fnote', owner, uuid });
    await pushOp(C, C.papa, op, {
      levelOf: () => null,                                   // barrier 4's retraction clause
      adminOf: () => C.papa.forStore.memberId,
      assertFamilyPatch: () => {},
    });
    // `family/unshare.js#run` settles on the admin's own Mac through the ordinary sync — there is
    // no local-append shortcut — so the rig does the same.
    await C.papa.engine.syncNow();
  });
  return op;
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

/** Every note on one Mac's board, as `[id, text, visibility, isForeign]`. */
async function boardRows(mac) {
  let out = [];
  await on(mac, () => {
    out = (mac.store.state.notes || []).map((n) => [n.id, n.text, n.visibility ?? null, !!n.isForeign]);
  });
  return out;
}

/** The refusals this Mac recorded — `sync/family.js:terminal`'s `{oid, seq, reason, at}`. */
async function refusalsOn(mac) {
  let out = [];
  await on(mac, () => { out = (mac.store.syncRefusals || []).map((r) => ({ ...r })); });
  return out;
}

/**
 * EXACTLY WHAT `store.applyRemote` HANDS `foldAuthorized` on this Mac: the reconstructed
 * attestation ops FIRST, then the lines (parked included) — see `store.js#applyRemote`.
 *
 * `_absorbedAttestOps()` is in here because leaving it out would make every row below fail at
 * stage 0b (`unattestedDevice`) for a reason that has nothing to do with the admin chain, and
 * the point of this file is that F-SHELL-1(b)'s repair EXISTS for the device registers and has
 * no sibling for the chain.
 */
/**
 * The fold input as it stood BEFORE `_absorbedChainOps` landed — the log plus the attestation
 * reconstruction and nothing else. §4 needs it to keep both arms of its contrast: with the repair
 * in `src/` the ordinary input already carries the link, and a comparison of a set against itself
 * proves nothing.
 */
async function foldInputWithoutChainOn(mac) {
  let out = [];
  await on(mac, () => {
    out = [...mac.store._absorbedAttestOps(), ...mac.store._log.ops({ includeParked: true })];
  });
  return out;
}

async function foldInputOn(mac) {
  let out = [];
  await on(mac, () => {
    out = [...mac.store._absorbedAttestOps(), ...mac.store._absorbedChainOps(),
      ...mac.store._log.ops({ includeParked: true })];
  });
  return out;
}

describe('E12 · the admin unshare, across the owner\'s relaunch', () => {
  let C = null;
  let PAPA = null;
  let MAMA = null;

  before(async () => {
    C = await circle(['papa', 'mama', 'oma']);
    PAPA = C.papa.forStore.memberId;
    MAMA = C.mama.forStore.memberId;
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §1 · NON-VACUITY — the rig can moderate, and 18.3 holds when nobody quits the app
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test('§1 · NON-VACUITY · with no relaunch it reverts, and her entry and text survive', async () => {
    const uuid = newUuid();
    const key = familyKey('fnote', MAMA, uuid);
    await shareOwn(C, C.mama, { uuid, date: '2026-12-24', text: 'Bescherung 18:00' });
    await converge(C, [C.papa, C.oma]);
    assert.equal((await regsOf(C.oma, key))['pub.text'], 'Bescherung 18:00', 'precondition: it crossed');

    await moderate(C, MAMA, uuid);
    await on(C.mama, () => C.mama.engine.syncNow());

    assert.equal((await regsOf(C.mama, key))['pub.level'], 'privat', 'the retraction did not fold');
    assert.deepEqual(await noteOn(C.mama, uuid),
      { text: 'Bescherung 18:00', visibility: 'privat', level: 'privat', isForeign: false },
      'IT REVERTS AND IT IS NEVER DELETED — 18.3, on a Mac that has not been quit');
    assert.deepEqual(await refusalsOn(C.mama), [], 'something was refused on the owner\'s Mac');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §2 · ⛔ F-SHELL-3(a), OPEN — one relaunch, and the same moderation is refused
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test('§2 · CLOSED · after a relaunch of the owner\'s Mac the retraction still lands, and reverts', async () => {
    const uuid = newUuid();
    const key = familyKey('fnote', MAMA, uuid);
    await shareOwn(C, C.mama, { uuid, date: '2026-12-25', text: 'Elternabend' });
    await converge(C, [C.papa, C.oma]);
    assert.equal((await regsOf(C.oma, key))['pub.text'], 'Elternabend', 'precondition: it crossed');

    // The one line that separates this file from E9-C §3a.
    await relaunch(C, C.mama);

    const op = await moderate(C, MAMA, uuid);
    await on(C.mama, () => C.mama.engine.syncNow());

    // `sync/family.js:terminal` files the refusal under the ENVELOPE's oid with the store's own
    // sentence as the reason — `refused: <REJECT_REASONS entry>`.
    // INVERTED (`store.js#_absorbedChainOps`, this pass). It used to read `refused.length === 1`
    // with `reason === REJECT_REASONS.NOT_OWNER`, and that single refusal was the whole of the
    // shipped app's residual ledger.
    const refused = (await refusalsOn(C.mama)).filter((r) => r.oid === op.id);
    assert.deepEqual(refused, [],
      `the admin's retraction is still refused on the owner's Mac: ${JSON.stringify(refused)}`);

    assert.equal((await regsOf(C.mama, key))['pub.level'], 'privat',
      'the entry did not revert to Privat on the owner\'s Mac');
    assert.deepEqual(await noteOn(C.mama, uuid),
      { text: 'Elternabend', visibility: 'privat', level: 'privat', isForeign: false },
      'her entry, her text and her ownership must all survive the retraction — only the level moves');

    // AND ON EVERY OTHER MAC TOO. The circle is no longer split on the record.
    assert.equal((await regsOf(C.papa, key))['pub.level'], 'privat', 'the admin\'s own Mac folded it');
    await on(C.oma, () => C.oma.engine.syncNow());
    assert.equal((await regsOf(C.oma, key))['pub.level'], 'privat', 'the third Mac folded it');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §3 · ⛔ THE MECHANISM — the chain the FOLD sees, against the chain the STORE reports
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test('§3 · CLOSED · the relaunch still empties the LOG, and the reconstruction refills the FOLD', async () => {
    await relaunch(C, C.mama);            // this row owns its own precondition, not §2's

    // NON-VACUITY FIRST: the absorption itself is unchanged and still total. If this ever goes
    // green for the other reason — the link surviving compaction — the rest of the row is inert.
    let lines = [];
    await on(C.mama, () => { lines = C.mama.store._log.ops({ includeParked: true }); });
    assert.deepEqual(lines.filter((o) => o.k === 'space.set'), [],
      'the owner\'s log still holds a `space.set` line — the absorption this row is about did not happen, '
      + 'so the reconstruction below is not being tested');

    const ops = await foldInputOn(C.mama);
    const links = ops.filter((o) => o.k === 'space.set');
    assert.ok(ops.some((o) => o.k === 'member.set' && /^dev\./.test(Object.keys(o.f)[0] || '')),
      'the attestation reconstruction did not fire — then stage 0b, not the chain, is what refuses');
    // INVERTED: `store.js#_absorbedChainOps` puts exactly ONE link back, per family space.
    assert.equal(links.length, 1, `the fold's input carries ${links.length} chain links, not one`);
    assert.equal(links[0].act, PAPA, 'the rebuilt link is not authored by the admin');
    assert.deepEqual(links[0].f, { admin: PAPA, adminPrev: null },
      'the rebuilt link is not the genesis-shaped one §4.1 roots the chain at');

    // The register map, which the checkpoint DID keep, still knows the answer.
    const space = await regsOf(C.mama, `space:${C.spaceId}`);
    assert.equal(space.admin, PAPA,
      'the checkpoint lost the admin register too — then this is a different defect');
    let reported = null;
    await on(C.mama, () => { reported = C.mama.store.familyAdmin(); });
    assert.equal(reported.admin, PAPA, '`store.familyAdmin()` disagrees with the register it reads');

    // And the fold, over the very same log, cannot see it.
    let verdict = null;
    await on(C.mama, () => { verdict = foldAuthorized(ops, C.mama.store._authzCtx()); });
    // INVERTED: the chain the fold resolves is exactly the one reconstructed link, and
    // `adminAtKey` — which is what stage 3a asks — now answers the admin instead of `null`.
    assert.deepEqual(verdict.adminChainOf(C.spaceId).map((o) => o.id), [links[0].id],
      'the fold did not resolve the reconstructed link as the chain');
    assert.equal(verdict.adminOfSpace(C.spaceId), PAPA,
      'the fold still names no admin, so `adminAtKey` still answers null and §2 cannot pass');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §4 · THE CONSTRUCTIVE PROOF — one rebuilt link, and the SAME op is admitted
  //
  // Nothing in `src/` is changed here. The reconstruction is built in this file out of the
  // register cell the checkpoint kept — `{value, stamp, author, op}` — and handed to
  // `foldAuthorized` as an ordinary op, which pays every barrier again. If the retraction is
  // admitted with it and rejected without it, then the absorbed link IS the defect and the
  // repair is a store-side sibling of `_absorbedAttestOps`. That is the whole argument.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test('§4 · handing the fold ONE reconstructed `space.set` link admits the same retraction', async () => {
    const uuid = newUuid();
    const key = familyKey('fnote', MAMA, uuid);
    await shareOwn(C, C.mama, { uuid, date: '2026-12-26', text: 'Zahnarzt 9 Uhr' });
    await converge(C, [C.papa, C.oma]);
    await relaunch(C, C.mama);
    const op = await moderate(C, MAMA, uuid);
    await on(C.mama, () => C.mama.engine.syncNow());

    const ops = await foldInputWithoutChainOn(C.mama);
    // The refused op never became a line. It is re-minted here from the SAME producer with the
    // same arguments so the fold has something to judge — `adminUnshareOp` is a pure function of
    // `(ctx, {kind, owner, uuid})`, so this is the op that was refused in every field that
    // matters to stage 3a.
    let mine = null;
    await on(C.papa, () => {
      mine = adminUnshareOp(C.papa.store._ctx(), { kind: 'fnote', owner: MAMA, uuid });
    });

    let without = null;
    let withLink = null;
    let rebuilt = null;
    await on(C.mama, () => {
      const ctx = C.mama.store._authzCtx();
      const regs = C.mama.store._log.registers();
      const cell = regs.get(`space:${C.spaceId}`).get('admin');
      // The device the link was authored on is the last sixteen characters of its stamp
      // (`stamp.js`), and the author's own member record maps that short to a deviceId. Nothing
      // is invented: an unmatched short would leave `dev` null and the reconstruction would be
      // refused `unattestedDevice` by stage 0b — see mutant M-2.
      const short = devOf(cell.stamp);
      let dev = null;
      for (const [name, c] of regs.get(`member:${cell.author}`) || []) {
        if (!/^dev\./.test(name) || !c || typeof c.value !== 'string') continue;
        const att = parseAttestationBlob(c.value);
        if (att && att.deviceShort === short) { dev = att.deviceId; break; }
      }
      rebuilt = Object.freeze({
        v: 1,
        id: cell.op,
        ts: cell.stamp,
        space: C.spaceId,
        act: cell.author,
        dev,
        gid: cell.op,
        k: 'space.set',
        e: `space:${C.spaceId}`,
        f: Object.freeze({ admin: cell.value, adminPrev: null }),
      });
      without = foldAuthorized([...ops, mine], ctx);
      withLink = foldAuthorized([rebuilt, ...ops, mine], ctx);
    });

    assert.ok(rebuilt.dev, 'the authoring device could not be resolved out of the author\'s record');
    assert.equal(rebuilt.act, PAPA);

    // AND THE SHIPPED RECONSTRUCTION IS THIS ONE, FIELD FOR FIELD. This row built its link by
    // hand to prove the mechanism; `store.js#_absorbedChainOps` now builds it in `src/`, and the
    // two must be the same op or the proof is about something the product does not do.
    let shipped = null;
    await on(C.mama, () => { shipped = C.mama.store._absorbedChainOps(); });
    assert.equal(shipped.length, 1, `the store rebuilt ${shipped.length} chain links, not one`);
    assert.deepEqual({ ...shipped[0] }, { ...rebuilt },
      'the store\'s reconstruction is not the one this row proves admissible');

    // WITHOUT the link: rejected, `notOwner`, and the register does not move.
    const before = without.rejectionOf(mine.id);
    assert.ok(before, 'the retraction was not rejected without the link — §2 must be stale');
    assert.equal(before.reason, REJECT_REASONS.NOT_OWNER);

    // WITH it: admitted, and `pub.level` is `privat` in the fold's own register map.
    assert.equal(withLink.rejectionOf(mine.id), null,
      `one reconstructed link did not admit it: ${JSON.stringify(withLink.rejectionOf(mine.id))}`);
    assert.deepEqual(withLink.adminChainOf(C.spaceId).map((o) => o.id), [rebuilt.id],
      'the reconstructed link is not the accepted chain');
    assert.equal(withLink.regs.get(key).get('pub.level').value, 'privat',
      'the retraction was admitted and still did not set the level');

    // AND IT IS NOT A SKELETON KEY. The same reconstruction does not let a NON-admin retract.
    let byOma = null;
    let hostile = null;
    let hostileNoLink = null;
    await on(C.oma, () => {
      byOma = adminUnshareOp(C.oma.store._ctx(), { kind: 'fnote', owner: MAMA, uuid });
    });
    await on(C.mama, () => {
      const ctx2 = C.mama.store._authzCtx();
      hostile = foldAuthorized([rebuilt, ...ops, byOma], ctx2);
      hostileNoLink = foldAuthorized([...ops, byOma], ctx2);
    });
    const no = hostile.rejectionOf(byOma.id);
    assert.ok(no && no.reason === REJECT_REASONS.NOT_OWNER,
      `a non-admin's retraction was admitted alongside the rebuilt link: ${JSON.stringify(no)}`);

    // AND AN EMPTY CHAIN REFUSES EVERYONE — which is the whole reason the repair has to REBUILD
    // the link rather than let a missing chain mean "whoever asked" (mutant M-1). With no link
    // in the fold, ANY member's identical patch is refused, and that is a security property, not
    // an inconvenience.
    const noneNoLink = hostileNoLink.rejectionOf(byOma.id);
    assert.ok(noneNoLink && noneNoLink.reason === REJECT_REASONS.NOT_OWNER,
      'with an EMPTY chain a non-admin\'s retraction was admitted — `adminAtKey`\'s null is being '
      + `read as "anyone": ${JSON.stringify(noneNoLink)}`);
    assert.equal(hostileNoLink.regs.get(key).get('pub.level').value, 'geteilt',
      'a non-admin moved the level on a Mac whose chain the checkpoint had absorbed');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §5 · ⛔ WHAT ACTUALLY REACHES THE PERSON — and the finding's own wording, corrected
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test('§5 · CLOSED · it was never a delete — and now the reversion lands too', async () => {
    // `docs/v2/V2-FINAL.md` R-1 and `FINDINGS.md` §21d both say the retraction "arrives as a
    // DELETION". Measured on this rig it does not: her `note:` truth registers are untouched,
    // her text is intact, and `_alive` is still true. What is lost is the REVERSION — she keeps
    // publishing an entry the admin withdrew. The board-emptying half of the shell symptom is
    // §6, and it is a different defect in a different file.
    const uuid = newUuid();
    await shareOwn(C, C.mama, { uuid, date: '2026-12-27', text: 'Impftermin' });
    await converge(C, [C.papa, C.oma]);
    await relaunch(C, C.mama);
    await moderate(C, MAMA, uuid);
    await on(C.mama, () => C.mama.engine.syncNow());

    const truth = await regsOf(C.mama, `note:${uuid}`);
    assert.equal(truth.text, 'Impftermin', 'her text is gone — then it IS a delete and R-1 is right');
    assert.equal(truth._alive, true, 'her entry was tombstoned');
    // INVERTED: `visibility` follows the retraction now that it is admitted.
    assert.equal(truth.visibility, 'privat',
      'the retraction did not reach her own truth register — the level moved and the entry did not');
    assert.ok(await noteOn(C.mama, uuid), 'the entry left her board');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §6 · ⛔ F-SHELL-3(b) — A SECOND DEFECT, AND IT IS THE ONE THAT EMPTIES A BOARD
  //
  // ADR 006 R1: `board.json` is the truth and is migrated into the spine on EVERY launch
  // (`store.js#_buildSpine`). `store.persist()` writes `store.state`, and `store.state.notes`
  // contains FOREIGN entries — another member's `fnote:` projection, id and all. `migrateV1` has
  // no notion of a foreign entry: it reads the array as v1 notes, cannot use `fnote:<mem>/<uuid>`
  // as an entity id, MINTS one (`migrate1to2.js#mintedId`), and writes the result as one of MY
  // OWN `note.set` ops at `visibility: 'privat'`.
  //
  // So every launch converts the viewer's redacted, revocable view of somebody else's entry into
  // a PERMANENT PRIVATE COPY on their own board — and because last launch's copy is now itself
  // in `board.json` with a usable id, `mintedId`'s occurrence counter hands the next launch a
  // fresh one. Measured in the shipped app: SEVEN copies of Papa's „Omas Geburtstag" on Mama's
  // board after seven launches (`scratch-B/board.json`, run at HEAD `78016e8`).
  //
  // It is not this pass's file and it is not the unshare. It is recorded here because it is the
  // other half of what a person sees, and because a fix for §2 alone does not make
  // `unshare-owner (B)` green — measured, both.
  // Owner: `src/js/core/migrate1to2.js` + `src/js/store.js:_buildSpine`.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test('§6 · CLOSED · a relaunch leaves a FOREIGN entry foreign, and mints no copy of it', async () => {
    const puuid = newUuid();
    await shareOwn(C, C.papa, { uuid: puuid, date: '2026-09-12', text: 'Omas Geburtstag' });
    await converge(C, [C.mama, C.oma]);

    const before = (await boardRows(C.mama)).filter((r) => r[1] === 'Omas Geburtstag');
    assert.equal(before.length, 1, 'precondition: exactly one copy, and it is the foreign one');
    assert.equal(before[0][3], true, 'precondition: it is foreign');

    await relaunch(C, C.mama);

    const after = (await boardRows(C.mama)).filter((r) => r[1] === 'Omas Geburtstag');
    const mineNow = after.filter((r) => r[3] === false);
    // INVERTED (`store.js#withoutForeignEntries` + `_buildSpine`, this pass): a foreign entry may
    // never be re-authored as mine. It used to read `mineNow.length === 1`, one more per launch.
    assert.deepEqual(mineNow, [],
      `the spine minted an own copy of another member's entry: ${JSON.stringify(mineNow)}`);
    assert.equal(after.filter((r) => r[3] === true).length, 1,
      'the foreign entry itself is gone — dropping it from the spine must not drop it from the board, '
      + 'because the circle\'s own registers are what carry it');

    // AND IT STILL DOES NOT GROW. Two more launches, and the count is the same one it started at.
    await relaunch(C, C.mama);
    await relaunch(C, C.mama);
    const grown = (await boardRows(C.mama)).filter((r) => r[1] === 'Omas Geburtstag');
    assert.equal(grown.length, 1, `three launches left ${grown.length} copies of one entry`);
    assert.equal(grown[0][3], true, 'the surviving copy is not the foreign one');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §7 · NON-VACUITY — a Mac that has NOT relaunched still moderates
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  test('§7 · NON-VACUITY · the third member, who never quit, folds a fresh moderation', async () => {
    const uuid = newUuid();
    const key = familyKey('fnote', C.oma.forStore.memberId, uuid);
    await shareOwn(C, C.oma, { uuid, date: '2026-12-28', text: 'Chorprobe' });
    await converge(C, [C.papa, C.mama]);

    await moderate(C, C.oma.forStore.memberId, uuid);
    await on(C.oma, () => C.oma.engine.syncNow());

    assert.equal((await regsOf(C.oma, key))['pub.level'], 'privat',
      'the moderation verb is broken outright — then §2 is not about the relaunch');
    assert.deepEqual(await noteOn(C.oma, uuid),
      { text: 'Chorprobe', visibility: 'privat', level: 'privat', isForeign: false },
      'and 18.3 still holds for a Mac that has not been quit');
  });
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §8 · ⛔ THE RESIDUAL, PINNED — a TRANSFERRED seat is NOT rebuilt, and must not be
  //
  // `_absorbedChainOps` rebuilds only a GENESIS-shaped link: `cell.author === cell.value`, ADR
  // 001 §4.1's own root test. That is not a simplification, it is the limit of what one register
  // cell contains. After `transferAdmin` (shipped — `family/adminpanel.js:654`, reached from
  // `leavedelete.js:1433` when a founder hands the seat over before leaving) the head link
  // carries `adminPrev: <opId>` and `act !== admin`, and `resolveChain` needs the PREDECESSOR
  // links to accept it. A register cell does not retain them, so they cannot be rebuilt from it.
  //
  // The wrong repair is to rebuild it anyway with `adminPrev: null`, which would present a
  // transferred seat as a genesis root — a rootless admin assertion that `core/ops.js`
  // #transferAdmin refuses to MINT for exactly this reason. This row is what stops that: it
  // asserts the reconstruction stays SILENT rather than guessing.
  //
  // SO THE RESIDUAL IS REAL AND IT IS NAMED: a circle whose admin seat has moved still loses the
  // admin's retraction after the owner's Mac has compacted. The general repair is to keep
  // `space.set` chain links out of compaction in `store.js#_persistOps` — one op per transfer,
  // bounded — and it is not made here.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  // ⚠ THIS ROW IS LAST ON PURPOSE: it moves the admin seat on the shared circle, and every
  //   row above it is written for a circle whose seat is still Papa's.
  test('§8 · ⛔ RESIDUAL · after a TRANSFER the reconstruction refuses to guess, and says nothing', async () => {
    // NON-VACUITY: before the transfer, this Mac rebuilds exactly one link.
    await relaunch(C, C.mama);
    let before = null;
    await on(C.mama, () => { before = C.mama.store._absorbedChainOps(); });
    assert.equal(before.length, 1, 'the genesis case is not being rebuilt — §2 would be failing too');

    // Papa hands the seat to Mama, through the shipped mutation and the shipped seal.
    let head = null;
    await on(C.papa, () => { head = C.papa.store.familyAdmin().headOpId; });
    assert.ok(head, 'the admin chain has no head on the admin\'s own Mac');
    await on(C.papa, async () => {
      C.papa.store.apply('transferAdmin', { admin: MAMA, adminPrev: head });
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama, C.oma]);
    let seat = null;
    await on(C.mama, () => { seat = C.mama.store.familyAdmin(); });
    assert.equal(seat.admin, MAMA, 'the transfer did not land — this row is not about a transfer');

    // ── ABSORPTION, IMPOSED RATHER THAN WAITED FOR, AND WHY THAT IS HONEST HERE ───────────
    //
    // §2 and §3 get their absorption for free: the founder's genesis link is above the horizon
    // Mama's FIRST launch fixes, so `_persistOps` step ① never writes it and it is simply not a
    // line afterwards. A TRANSFER is a fresh op in a settled circle, and the other absorption
    // route — `_persistOps` step ②'s compaction — needs `TAIL_COMPACT_AT` (≈5 000) lines, which
    // no test rig reaches. So the transfer itself is REAL — the shipped `transferAdmin`
    // mutation, the shipped seal, converged onto her Mac — and only the LAST step is imposed:
    // `_log.ops()` is asked to answer without the `space.set` lines, which is precisely and only
    // what a checkpoint that has absorbed them returns.
    //
    // Nothing about the register cell is shaped. It is the cell the real transfer wrote.
    let lines = null;
    let cell = null;
    let rebuiltWhileLive = null;
    let rebuiltWhenAbsorbed = null;
    await on(C.mama, () => {
      const log = C.mama.store._log;
      lines = log.ops({ includeParked: true }).filter((o) => o.k === 'space.set');
      cell = log.registers().get(`space:${C.spaceId}`).get('admin');
      rebuiltWhileLive = C.mama.store._absorbedChainOps();
      const realOps = log.ops.bind(log);
      log.ops = (opts) => realOps(opts).filter((o) => o.k !== 'space.set');
      try { rebuiltWhenAbsorbed = C.mama.store._absorbedChainOps(); } finally { log.ops = realOps; }
    });

    assert.ok(lines.length >= 1, 'the transfer link is not a line at all — then the rig lost the transfer');
    assert.equal(cell.value, MAMA, 'the register lost the transfer');
    assert.notEqual(cell.author, cell.value,
      'the cell the transfer wrote IS genesis-shaped — then the transfer was authored by its own '
      + 'beneficiary and this row is not testing the case it names');
    assert.deepEqual(rebuiltWhileLive, [],
      'a link that is still a LINE was rebuilt beside itself — that is the envelope-splice defect '
      + '`_absorbedAttestOps` records, one register over');
    assert.deepEqual(rebuiltWhenAbsorbed, [],
      `a transferred seat was rebuilt as a genesis root: ${JSON.stringify(rebuiltWhenAbsorbed)}`);
  });
});
