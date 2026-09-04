// FLEET · E10 / LZP-1005 — F17 (family content on my board) AND F18 (editing rights).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS NEW HERE AND WHAT IS CITED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// F18 is the best-covered feature in the fleet suite: `e9-attack-*.test.js` put 29 adversarial
// rows against a real invited member and every one of them is an F18 story read as a threat. This
// file does NOT repeat them. Each F18 section below names the row that already proves its story
// and adds only the half that row did not need:
//
//   18.1  owner-only editing        cited: `e9-attack-coedit.test.js` §1a-§1d (a patched client
//                                   cannot write a non-co-editable entry).  ADDED here: the
//                                   HONEST client's own refusal, from `store.applyCoEdit` and
//                                   `sharing.js#canEditEntry`, which is what Mama actually meets.
//   18.2  the per-entry flag        cited: `e9-attack-coedit.test.js`, `e9-attack-diverge.test.js`.
//                                   ADDED: the flag is PER ENTRY — granting one bar does not open
//                                   its neighbour, on the peer's Mac.
//   18.3  admin unshare             cited: `e9-attack-moderation.test.js` §2.  ADDED: the OWNER's
//                                   side — non-destructive, the entry is still on his own board.
//   18.4  my undo is only mine      cited: `e9-attack-moderation.test.js` §3.  ADDED: the plain
//                                   case — a peer's op arriving between my two actions does not
//                                   enter my stack, and ⌘Z still undoes MINE.
//   18.5  per-field LWW + notice    cited: `e9-attack-restore.test.js` §4c, `e9-attack-diverge`.
//                                   Not repeated at all.
//   18.6  deletions propagate       cited: `e9-attack-coedit.test.js` §1i, `e9-attack-restore.js`
//                                   §4a/§4b.  ADDED: the whole-circle round trip — delete lands
//                                   on two other Macs, the author's ⌘Z brings it back on both.
//
// F17 had TWO of its seven stories named by a fleet row before this file — 17.1 in
// `e6-attack-keydelivery.test.js` and 17.6 in `e9-attack-coedit.test.js`. The other five
// (17.2, 17.3, 17.4, 17.5, 17.7) had none.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// TWO STORIES THIS FILE DOES NOT CLAIM
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// **17.4 (density) IS NOT PROVEN BY A FLEET ROW AND MUST NOT BE MARKED SO.** Lanes cap, "+n"
// overflow and truncation are geometry: they are decided in `layout.js#buildBoard` and in
// `src/css/app.css`, and the only honest verification of them is a rendered board —
// `tests/tier2/family-density.dom.js`, `e8-density-*.dom.js`. Those files are a PARALLEL
// workflow's and carry 17 open failures right now. §17.4 below therefore proves the
// PRECONDITION only, and says so in its own name.
//
// **17.7 (Kompakt / Komfort) is half a story here.** The `[Could]` asks for a per-device row
// height and font size. What a fleet can prove is that the pref is DEVICE-LOCAL — that Mama
// enlarging her rows does not enlarge Papa's — and that is §17.7 below. Whether 26 px actually
// renders at 26 px is `tests/tier2/density-808.dom.js`'s.
//
// ⚠ TRANSPORT DEPENDENCY: as in `e10-fleet-circle.test.js`, every scenario runs on the FETCH
// shape of `platform/net.js`. `createBridgeTransport`'s `sync_request` is unimplemented in both
// shells and is being written by a parallel workflow. The assertions here are about properties of
// the family log and of the projection, never about `net.js` internals.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, scratch copy, naming the row that dies
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-B1  `core/materialize.js:foreignCandidate` — `memberColorRef` hard-coded `null`
//                                                            → §17.2 goes RED
//   M-B2  `store.js:_hiddenMembers` — the `v === true` test never matches
//                                                            → §17.3 goes RED
//   M-B3  `core/ops.js:spaceFor` — a `local`-space op is addressed to the FAMILY space
//                                                            → §17.7 goes RED (with §17.3–§17.6
//                                                              as collateral)
//         ⚠ CHANGING `OP_KINDS['pref.set'].space` TO `'family'` ALONE LEAVES THE ROW GREEN:
//         `spaceFor` is the only reader that matters, and a pref op that reaches the family log
//         is still refused downstream. Both mutants were run; the survivor is recorded because
//         "17.7 holds" is a claim about more than one mechanism.
//   M-B4  `family/sharing.js:canEditEntry` — returns `true` for any foreign entry
//                                                            → §18.1 and §18.2 go RED
//   M-B5  `store.js:undo()` — one ⌘Z pops TWO steps          → §18.4 and §18.6 go RED
//   M-B6  `core/materialize.js:isNewOf` — returns `true` when no hook is supplied
//                                                            → §17.5 was OPEN then and this was
//                                                              its expected inversion. §17.5 is
//                                                              CLOSED since 2026-09-04 (F6); the
//                                                              mutant that bites it now is
//                                                              `store.js#_exposureCtx` losing its
//                                                              `seqOf` producer — measured in
//                                                              `e13-relaunch-sweep.test.js` §4.
//
// ⚠ §18.4's ISOLATION HALF HAS NO SURVIVING-CODE MUTANT, AND THAT IS WORTH SAYING. Two mutants
// were run against it and BOTH LEFT THE ROW GREEN:
//   · `core/undo.js:UNDOABLE_KINDS` extended with `fnote`/`fbar`  → nothing died
//   · `core/undo.js:captureImages` — the `op.act !== me` refusal disabled → nothing died
// The reason is that `store.applyRemote` never records an undo step AT ALL: a peer's op cannot
// enter my stack because there is no code path by which it could, not because a check refuses
// it. `captureImages`'s guard is a belt for a second door (`_commit` with a foreign op) that no
// caller opens today. §18.4's value is therefore REGRESSION DETECTION on the day somebody adds
// that path — which is exactly what M-B5 simulates from the other side.
//
// The honest-path control is this file green at `28f2a35` with no mutant applied.

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { materialize } from '../../src/js/core/materialize.js';
import { canEditEntry, attributionLine, planCoEditChange } from '../../src/js/family/sharing.js';
import { readMembers, sortForLegend } from '../../src/js/family/membersui.js';

import { circle, converge, on } from './e9-attack-kit.js';

const notesOn = (mac) => mac.store.state.notes;
const barsOn = (mac) => mac.store.state.bars;
const seen = (mac, fk) => notesOn(mac).find((n) => n.entityKey === fk) ?? null;
const seenBar = (mac, fk) => barsOn(mac).find((n) => n.entityKey === fk) ?? null;

async function setProfile(C, mac, patch) {
  await on(mac, async () => {
    assert.equal(mac.store.apply('setMyProfile', patch), true);
    await mac.engine.syncNow();
  });
}

async function makeNote(C, mac, { text, visibility = 'geteilt', date = '2026-10-14', categoryId = 'c1' }) {
  const id = newUuid();
  await on(mac, async () => {
    assert.equal(mac.store.apply('createNoteInline', { id, date, text, categoryId, visibility }), true);
    await mac.engine.syncNow();
  });
  return { id, fk: familyKey('fnote', mac.forStore.memberId, id) };
}

async function makeBar(C, mac, { label, startDate, endDate, visibility = 'geteilt', coEdit = false }) {
  const id = newUuid();
  await on(mac, async () => {
    assert.equal(mac.store.apply('createBar', {
      id, startDate, endDate, categoryId: 'c1', visibility,
    }), true);
    mac.store.txn('label', (tx) => { tx.bar(id).set({ label, coEdit }); });
    await mac.engine.syncNow();
  });
  return { id, fk: familyKey('fbar', mac.forStore.memberId, id) };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// F17 — FAMILY CONTENT ON MY BOARD
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('F17 · others\' entries arrive quietly and render as people', () => {
  let C;

  before(async () => {
    C = await circle(['papa', 'mama', 'oma']);
    await setProfile(C, C.papa, { displayName: 'Papa', colorRef: 'gruen' });
    await setProfile(C, C.mama, { displayName: 'Mama', colorRef: 'blau' });
    await setProfile(C, C.oma, { displayName: 'Oma', colorRef: 'magenta' });
    await converge(C, [C.papa, C.mama, C.oma]);
    await converge(C, [C.papa, C.mama, C.oma]);
  });

  // 17.1 ────────────────────────────────────────────────────────────────────
  // Also proven, from the key-delivery side, by `e6-attack-keydelivery.test.js`.
  test('§17.1 · two members\' entries land in MY date rows, with no act of mine', async () => {
    const m = await makeNote(C, C.mama, { text: 'Elternabend', date: '2026-10-20' });
    const o = await makeNote(C, C.oma, { text: 'Kaffee', date: '2026-10-21' });
    const b = await makeBar(C, C.mama, { label: 'Ostsee', startDate: '2027-07-01', endDate: '2027-07-14' });
    await converge(C, [C.papa]);

    await on(C.papa, () => {
      // "family plans live exactly where my plans live" — the SAME collection `layout.js` reads.
      assert.equal(seen(C.papa, m.fk).date, '2026-10-20');
      assert.equal(seen(C.papa, o.fk).date, '2026-10-21');
      assert.equal(seenBar(C.papa, b.fk).startDate, '2027-07-01');
      assert.equal(seenBar(C.papa, b.fk).endDate, '2027-07-14');
      // and my own entry is still there, in the same array.
      assert.ok(notesOn(C.papa).some((n) => n.id === 'n-own'));
    });
  });

  // 17.2 ────────────────────────────────────────────────────────────────────
  test('§17.2 · my board stays mine — my colours for me, the member\'s colour for them', async () => {
    const mine = await makeNote(C, C.papa, { text: 'Mein Termin', date: '2026-10-22' });
    const hers = await makeNote(C, C.mama, { text: 'Ihr Termin', date: '2026-10-22' });
    await converge(C, [C.papa, C.mama]);

    await on(C.papa, () => {
      // MY OWN entry keeps its `note:<id>` key — the `fnote:` key is what OTHERS index it by.
      const own = notesOn(C.papa).find((n) => n.id === mine.id);
      assert.equal(own.isForeign, false);
      assert.equal(own.entityKey, `note:${mine.id}`);
      assert.equal(own.categoryId, 'c1', 'my entry renders in MY category colour');
      assert.equal(own.memberColorRef, null, 'and carries no member tone');
      assert.equal(own.initial, null, 'and no chip');

      const foreign = seen(C.papa, hers.fk);
      assert.equal(foreign.isForeign, true);
      assert.equal(foreign.memberColorRef, 'blau', 'hers renders in HER personal colour');
      assert.equal(foreign.initial, 'M', 'with her initial chip');
      assert.equal(Object.hasOwn(foreign, 'categoryId'), false,
        'A3 — a foreign entry never carries a category, because categories are not synced');
    });

    // The mirror: on MAMA's Mac the same two entries swap roles.
    await on(C.mama, () => {
      assert.equal(notesOn(C.mama).find((n) => n.id === hers.id).memberColorRef, null);
      assert.equal(seen(C.mama, mine.fk).memberColorRef, 'gruen');
      assert.equal(seen(C.mama, mine.fk).initial, 'P');
    });
  });

  // 17.3 ────────────────────────────────────────────────────────────────────
  test('§17.3 · hiding a member is a legend toggle, and it is MINE alone', async () => {
    const p = await makeNote(C, C.papa, { text: 'Papas Sache', date: '2026-10-25' });
    const o = await makeNote(C, C.oma, { text: 'Omas Sache', date: '2026-10-25' });
    await converge(C, [C.mama, C.oma, C.papa]);

    await on(C.mama, () => {
      assert.ok(seen(C.mama, p.fk), 'both are on Mama\'s board to begin with');
      assert.ok(seen(C.mama, o.fk));
      // The legend's member section — the thing 17.3 puts the toggle in.
      const rows = sortForLegend(readMembers(C.mama.store.registers(), {
        me: C.mama.forStore.memberId,
      }));
      assert.deepEqual(rows.map((r) => r.displayName).sort(), ['Oma', 'Papa']);
      assert.equal(rows.every((r) => r.hidden === false), true);
    });

    // Mama hides Papa, the same way she would hide a category (4.3).
    await on(C.mama, async () => {
      C.mama.store.setSettings({ hiddenMembers: { [C.papa.forStore.memberId]: true } });
      assert.equal(seen(C.mama, p.fk), null, 'Papa\'s entries leave Mama\'s board');
      assert.ok(seen(C.mama, o.fk), 'Oma\'s stay');
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma, C.mama]);

    // …and nobody else's board moved. The pref is device-local (rule U6) and never synced.
    await on(C.oma, () => {
      assert.ok(seen(C.oma, p.fk), 'Oma still sees Papa');
      assert.equal(C.oma.store._hiddenMembers().size, 0);
    });
    await on(C.papa, () => assert.equal(C.papa.store._hiddenMembers().size, 0));
    // Nothing left the Mac: no `hiddenMembers` string anywhere in the relay's op store.
    const wire = JSON.stringify(C.relay.store, (k, v) => (v instanceof Uint8Array ? '<bytes>' : v));
    assert.equal(wire.includes('hiddenMembers'), false,
      'a member toggle is not a fact the family is told about (Principle 9)');

    // Un-hide is an ABSOLUTE write, not a toggle, so two Macs converge instead of cancelling.
    await on(C.mama, () => {
      C.mama.store.setSettings({ hiddenMembers: { [C.papa.forStore.memberId]: false } });
      assert.ok(seen(C.mama, p.fk), 'and Papa comes back');
    });
  });

  // 17.4 ────────────────────────────────────────────────────────────────────
  // NOT A DENSITY PROOF. See the header. This proves the precondition the density rules operate
  // on: a foreign entry is indistinguishable from a local one to everything downstream of the
  // projection except in the fields that are supposed to differ.
  test('§17.4 · PRECONDITION ONLY — family entries enter the SAME projection my own do', async () => {
    const foreigners = [];
    for (let i = 0; i < 6; i++) {
      foreigners.push(await makeNote(C, i % 2 ? C.mama : C.oma, {
        text: `Eintrag ${i}`, date: '2026-11-14',
      }));
    }
    await on(C.papa, async () => {
      for (let i = 0; i < 3; i++) {
        assert.equal(C.papa.store.apply('createNoteInline', {
          id: newUuid(), date: '2026-11-14', text: `Meins ${i}`, categoryId: 'c1',
        }), true);
      }
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.papa]);

    await on(C.papa, () => {
      const day = notesOn(C.papa).filter((n) => n.date === '2026-11-14');
      assert.equal(day.length, 9, 'nine entries share one day row');
      assert.equal(day.filter((n) => n.isForeign).length, 6);
      // Every field `layout.js` keys a lane on is present on both kinds.
      for (const n of day) {
        assert.equal(typeof n.id, 'string');
        assert.equal(typeof n.date, 'string');
        assert.equal(typeof n.uuid, 'string');
        assert.equal(typeof n.entityKey, 'string');
      }
      // Ids are unique across the two populations — the thing a lane assigner would break on.
      assert.equal(new Set(day.map((n) => n.id)).size, 9);
    });
    // WHAT THIS DOES NOT PROVE: the lanes cap (3.8), the "+n" overflow (2.4) and truncation
    // (2.5) are geometry and live in `layout.js` + `src/css/app.css`. `tests/tier2/
    // family-density.dom.js` and `e8-density-*.dom.js` are the only honest verification of them,
    // they are a parallel workflow's files, and they carry open failures today.
  });

  // 17.5 ────────────────────────────────────────────────────────────────────
  // ✅ CLOSED · E10-1, INVERTED 2026-09-04 · F6.
  //
  // This row used to be green BECAUSE the story was not wired, and its own comment said so and
  // asked to be inverted rather than repaired. It is now inverted, on that instruction.
  //
  // What was missing was never the RULE: `core/materialize.js:isNewOf` implements ADR 004 §7.2
  // exactly, and `tests/tier1/core-materialize.test.js` proved it against injected hooks. What
  // was missing was the PRODUCER — `store.js:_project` passed `me`, `familySpaceId`,
  // `_memberCtx`, `_exposureCtx` and `defaultSettings`, and none of `seqOf`, `isNew`,
  // `lastSeenSeq`, `levelDecreased`. `store.js#_exposureCtx` now supplies `seqOf` and
  // `levelDecreased`, `store.js#_lastSeenSeqCtx` supplies the baseline, and
  // `main.js#armFamilySeen` calls `store.markFamilySeen()` on the first deliberate look, which
  // is §7.2's "the dot fades once seen".
  //
  // The two arms below are kept exactly as they were and now read as controls: the rule still
  // answers the same way under injected hooks, so a regression in the PRODUCER is distinguishable
  // from a regression in the RULE.
  test('§17.5 · CLOSED — a peer\'s brand-new entry carries the „neu" dot on a real Mac', async () => {
    const fresh = await makeNote(C, C.mama, { text: 'Ganz neu', date: '2026-12-24' });
    await converge(C, [C.papa]);

    await on(C.papa, () => {
      const e = seen(C.papa, fresh.fk);
      assert.ok(e, 'the entry arrived');
      assert.equal(e.isNew, true,
        'E10-1 — a peer\'s brand-new entry does not carry the dot on a real Mac; `_project` has '
        + 'stopped supplying the seq hook and 17.5 is unwired again');

      // CONTROL, unchanged: given the hooks injected by hand the rule answers the same way. If
      // this arm ever disagrees with the arm above, the defect is in `materialize.js`, not in the
      // wiring.
      const regs = C.papa.store.registers();
      const withHook = materialize(regs, {
        me: C.papa.forStore.memberId,
        familySpaceId: C.spaceId,
        ...C.papa.store._memberCtx(regs),
        isNew: (k) => k === fresh.fk,
        defaultSettings: C.papa.store.state.settings,
      });
      assert.equal(withHook.notes.find((n) => n.entityKey === fresh.fk).isNew, true,
        'materialize.js no longer implements 17.5 — the RULE regressed, not the wiring');

      // And the suppression clauses hold, so wiring it will not make a downgrade blink.
      const suppressed = materialize(regs, {
        me: C.papa.forStore.memberId,
        familySpaceId: C.spaceId,
        ...C.papa.store._memberCtx(regs),
        isNew: () => true,
        levelDecreased: (k) => k === fresh.fk,
        defaultSettings: C.papa.store.state.settings,
      });
      assert.equal(suppressed.notes.find((n) => n.entityKey === fresh.fk).isNew, false,
        'ADR 004 §7 — a downgrade never dots');
    });

    // My OWN entry never dots on my own board, whatever the hooks say. That half IS wired.
    await on(C.mama, () => {
      assert.equal(notesOn(C.mama).find((n) => n.id === fresh.id).isNew, false);
    });
  });

  // 17.6 ────────────────────────────────────────────────────────────────────
  test('§17.6 · attribution — „von Mama · geteilt · geändert <Wd>." off a real remote stamp', async () => {
    const hers = await makeNote(C, C.mama, { text: 'Zahnarzt', date: '2027-01-08' });
    await converge(C, [C.papa]);

    await on(C.papa, () => {
      const e = seen(C.papa, hers.fk);
      const nameOf = (id) => {
        const rows = readMembers(C.papa.store.registers(), { me: C.papa.forStore.memberId });
        return rows.find((r) => r.memberId === id)?.displayName ?? null;
      };
      const line = attributionLine(e, { nameOf, lang: 'de' });
      assert.match(line, /^von Mama · geteilt · geändert (Mo|Di|Mi|Do|Fr|Sa|So)\.$/,
        'German-first, and the level word is lower-cased in running text');
      const en = attributionLine(e, { nameOf, lang: 'en' });
      assert.match(en, /^by Mama · shared · edited (Su|Mo|Tu|We|Th|Fr|Sa)\.$/);

      // "never printed on the board" — the projection carries the ingredients, not the sentence.
      assert.equal(Object.hasOwn(e, 'attribution'), false);
      assert.equal(typeof e.updatedAt, 'string');
      assert.equal(e.updatedBy, C.mama.forStore.memberId);

      // My own entry, mine alone: no line at all. „von mir" is noise.
      const own = notesOn(C.papa).find((n) => n.id === 'n-own');
      assert.equal(attributionLine(own, { nameOf, lang: 'de' }), null);
    });
  });

  // 17.7 ────────────────────────────────────────────────────────────────────
  test('§17.7 · `[Could]` — a density pref is one Mac\'s, and does not travel', async () => {
    let before = null;
    await on(C.papa, () => { before = C.papa.store.state.settings.rowHeight; });

    await on(C.mama, async () => {
      C.mama.store.setSettings({ rowHeight: 30 });
      assert.equal(C.mama.store.state.settings.rowHeight, 30, 'Mom\'s eyes are not mine');
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma, C.mama]);

    await on(C.papa, () => {
      assert.equal(C.papa.store.state.settings.rowHeight, before,
        'Papa\'s rows did not move');
    });
    await on(C.oma, () => assert.notEqual(C.oma.store.state.settings.rowHeight, 30));
    await on(C.mama, () => assert.equal(C.mama.store.state.settings.rowHeight, 30,
      'and Mama kept hers across the sync'));
    // WHAT THIS DOES NOT PROVE: that 30 px renders as 30 px, or that the horizontal-scroll trade
    // is acceptable. `tests/tier2/density-808.dom.js` owns that, in a browser.
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// F18 — EDITING RIGHTS  (the adversarial half is E9's; see the header)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('F18 · your entries are yours; co-editing is opt-in per entry', () => {
  let C;

  before(async () => {
    C = await circle(['papa', 'mama', 'oma']);
    await setProfile(C, C.papa, { displayName: 'Papa', colorRef: 'gruen' });
    await setProfile(C, C.mama, { displayName: 'Mama', colorRef: 'blau' });
    await setProfile(C, C.oma, { displayName: 'Oma', colorRef: 'magenta' });
    await converge(C, [C.papa, C.mama, C.oma]);
    await converge(C, [C.papa, C.mama, C.oma]);
  });

  // 18.1 ────────────────────────────────────────────────────────────────────
  test('§18.1 · the honest client refuses to edit somebody else\'s entry', async () => {
    const his = await makeBar(C, C.papa, {
      label: 'Dienstreise', startDate: '2027-03-02', endDate: '2027-03-06', coEdit: false,
    });
    await converge(C, [C.mama]);

    await on(C.mama, async () => {
      const e = seenBar(C.mama, his.fk);
      assert.ok(e);
      assert.equal(e.coEdit, false);
      assert.equal(canEditEntry(e), false, 'the popover offers no edit affordance');
      // And the write path itself declines — a caller that missed the disabled control still
      // cannot write. `applyCoEdit` is the ONLY door onto a foreign entity.
      // The field names are the CO-EDITABLE ones (`pub.*`), so the refusal below is about
      // OWNERSHIP and not about a mistyped field.
      assert.equal(C.mama.store.familyCoEditLevelOf(his.fk), null, 'no grant on this entry');
      assert.equal(C.mama.store.applyCoEdit(his.fk, { 'pub.startDate': '2027-03-09' }, 'drag'), false);
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa]);

    await on(C.papa, () => {
      assert.equal(barsOn(C.papa).find((b) => b.id === his.id).startDate, '2027-03-02',
        'nobody\'s plans were rewritten behind their back');
    });
    // A foreign entry is never mine to grant, either (ADR 004 §8).
    await on(C.mama, () => {
      assert.equal(planCoEditChange(seenBar(C.mama, his.fk), true), null);
    });
  });

  // 18.2 ────────────────────────────────────────────────────────────────────
  test('§18.2 · the flag is PER ENTRY — one open bar does not open its neighbour', async () => {
    const open = await makeBar(C, C.papa, {
      label: 'Familienurlaub', startDate: '2027-08-01', endDate: '2027-08-14', coEdit: true,
    });
    const shut = await makeBar(C, C.papa, {
      label: 'Konferenz', startDate: '2027-08-20', endDate: '2027-08-22', coEdit: false,
    });
    await converge(C, [C.mama, C.oma]);

    await on(C.mama, async () => {
      assert.equal(canEditEntry(seenBar(C.mama, open.fk)), true);
      assert.equal(canEditEntry(seenBar(C.mama, shut.fk)), false);
      assert.equal(C.mama.store.applyCoEdit(open.fk, { 'pub.endDate': '2027-08-16' }, 'ziehen'), true,
        'collaboration exists exactly where invited');
      assert.equal(C.mama.store.applyCoEdit(shut.fk, { 'pub.endDate': '2027-08-25' }, 'ziehen'), false,
        'and nowhere else');
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma]);

    for (const m of [C.papa, C.oma]) {
      await on(m, () => {
        const o = m === C.papa
          ? barsOn(C.papa).find((b) => b.id === open.id) : seenBar(C.oma, open.fk);
        const s = m === C.papa
          ? barsOn(C.papa).find((b) => b.id === shut.id) : seenBar(C.oma, shut.fk);
        assert.equal(o.endDate, '2027-08-16', `${m.tag} sees Mama's drag`);
        assert.equal(s.endDate, '2027-08-22', `${m.tag} sees the neighbour untouched`);
      });
    }
  });

  // 18.3 ────────────────────────────────────────────────────────────────────
  // Cited: `e9-attack-moderation.test.js` proves the admin's power and its limits under attack.
  // ADDED here: the OWNER's side of "it is never deleted".
  test('§18.3 · an admin unshare is non-destructive — the owner still has his entry', async () => {
    const hers = await makeNote(C, C.mama, { text: 'Kommt weg', date: '2027-04-01' });
    await converge(C, [C.papa, C.oma]);
    await on(C.papa, () => assert.ok(seen(C.papa, hers.fk)));

    // The admin's own board is where the moderation act happens; `family/unshare.js` plans it and
    // `e9-attack-moderation.test.js` §2 drives the whole flow. Here we only need the CONSEQUENCE
    // on the owner, so the level is taken back through the owner-visible path the ADR defines:
    // an unshare is a retraction, and the entry reverts to owner-private.
    await on(C.mama, async () => {
      const mine = notesOn(C.mama).find((n) => n.id === hers.id);
      assert.equal(mine.visibility, 'geteilt');
      C.mama.store.txn('unshare', (tx) => { tx.note(hers.id).set({ visibility: 'privat' }); });
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma]);

    for (const m of [C.papa, C.oma]) {
      await on(m, () => assert.equal(seen(m, hers.fk), null, `gone from ${m.tag}'s board`));
    }
    await on(C.mama, () => {
      const mine = notesOn(C.mama).find((n) => n.id === hers.id);
      assert.ok(mine, 'and still on the owner\'s — it reverted, it was not deleted');
      assert.equal(mine.text, 'Kommt weg');
      assert.equal(mine.visibility, 'privat');
    });
  });

  // 18.4 ────────────────────────────────────────────────────────────────────
  test('§18.4 · ⌘Z undoes only MY actions, with a peer\'s op sitting in between', async () => {
    const id = newUuid();
    await on(C.papa, async () => {
      assert.equal(C.papa.store.apply('createNoteInline', {
        id, date: '2027-05-05', text: 'Mein erster Schritt', categoryId: 'c1', visibility: 'geteilt',
      }), true);
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama]);

    // Mama does something of her own, and Papa pulls it in.
    const hers = await makeNote(C, C.mama, { text: 'Mamas Sache', date: '2027-05-06' });
    await converge(C, [C.papa]);

    // Papa's second action.
    await on(C.papa, () => {
      C.papa.store.apply('editNoteInline', { id, text: 'Mein zweiter Schritt' });
    });

    await on(C.papa, () => {
      assert.ok(seen(C.papa, hers.fk), 'Mama\'s entry is on the board');
      assert.equal(C.papa.store.canUndo(), true);
      C.papa.store.undo();
      // One ⌘Z: my own last action, and nothing of hers.
      assert.equal(notesOn(C.papa).find((n) => n.id === id).text, 'Mein erster Schritt');
      assert.ok(seen(C.papa, hers.fk), 'her entry never entered my stack');

      C.papa.store.undo();
      assert.equal(notesOn(C.papa).some((n) => n.id === id), false, 'my creation, undone');
      assert.ok(seen(C.papa, hers.fk), 'and hers is STILL there');
    });
  });

  // 18.6 ────────────────────────────────────────────────────────────────────
  test('§18.6 · a delete reaches every board, and the author\'s ⌘Z brings it back to every board', async () => {
    const his = await makeNote(C, C.papa, { text: 'Kegelabend', date: '2027-06-06' });
    await converge(C, [C.mama, C.oma]);
    for (const m of [C.mama, C.oma]) {
      await on(m, () => assert.equal(seen(m, his.fk).text, 'Kegelabend'));
    }

    await on(C.papa, async () => {
      assert.equal(C.papa.store.apply('deleteNotePopover', { id: his.id }), true);
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama, C.oma]);
    for (const m of [C.mama, C.oma]) {
      await on(m, () => assert.equal(seen(m, his.fk), null, `the delete reached ${m.tag}`));
    }

    // "my undo of my own deletion restores the entry as a NEW SHARED OPERATION".
    await on(C.papa, async () => {
      assert.equal(C.papa.store.canUndo(), true);
      C.papa.store.undo();
      assert.equal(notesOn(C.papa).find((n) => n.id === his.id).text, 'Kegelabend');
      await C.papa.engine.syncNow();
    });
    await converge(C, [C.mama, C.oma]);
    for (const m of [C.mama, C.oma]) {
      await on(m, () => assert.equal(seen(m, his.fk).text, 'Kegelabend',
        `even destructive acts stay reversible for their author — on ${m.tag}'s board too`));
    }
  });
});
