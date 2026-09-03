// ═════════════════════════════════════════════════════════════════════════════════════════════
// F-SHELL-2 · WHO MAY CO-SIGN — the count, and the two lists it is taken from
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `V2-FINAL.md` §8 R-4 says a founder-less circle offers a REMOVED member as a co-signer, states
// the cause as "`eligibleCosigners` reads the folded member list", and prescribes "intersect the
// log's member list with the roster's `removedAt`".
//
// This file exists because the middle of that sentence does not survive being run.
//
// ── WHAT THE ROWS BELOW MEASURED, BEFORE ANY OF THEM WAS WRITTEN AS AN ASSERTION ────────────
//
//   · `membersui.js#readMembers` has applied `if (r.removedAt) existing.alive = false;` since
//     `101073b`, over the same `rosterCache` `family/mount.js` hands `initMembersUI`. So the
//     member view `eligibleCosigners` counts is ALREADY log ∩ roster, and the prescribed
//     intersection — applied to that view, over that roster — cannot move any answer. §2c is
//     that measurement, kept as a row so the next person does not have to take it on trust.
//
//   · The shell's number is arithmetic and it names its own cause. Four roster rows, two of them
//     stamped `removedAt`: with the roster PRESENT `readMembers` leaves two alive and the count
//     is 0; with the roster ABSENT it leaves four alive and the count is 2.
//     `docs/v2/SHELL-VERIFICATION.md` §5 recorded **2**. So `rosterCache` was EMPTY on that Mac
//     at that moment — `refreshRoster` had not returned or had failed silently (19.3), and §7 of
//     the shell suite never opens the settings sheet that calls it. §1 is that arithmetic, run
//     against the real `readMembers` rather than reasoned about.
//
// **F-SHELL-2 is therefore a FRESHNESS defect, not a missing-intersection defect**, and no row
// here claims to have closed it: closing it means guaranteeing the roster has arrived before the
// count is taken, which is `refreshRoster`'s scheduling and lives in neither of these functions.
//
// ── WHAT THE CHANGE UNDER TEST ACTUALLY IS ──────────────────────────────────────────────────
//
// `adminpanel.js` now takes the roster port, and `eligibleCosigners` uses it for the one thing
// the member view structurally cannot say: **whether this Mac holds a roster at all.** An empty
// roster and an all-present roster produce identical member views. A count taken with no roster
// is the LOG's count, and the log can only ever over-count — so a positive one is a ceiling and
// is now reported as `null` (UNKNOWN), while a **zero stays zero**, because a genuinely stranded
// two-member circle must still get its sentence when the relay is unreachable. §3 is that, from
// both sides.
//
// ── WHY THIS FILE DRIVES `readMembers` AND A PORT, AND NOT `membersUIState()` ────────────────
//
// `initMembersUI` calls `teardownFamilyLegend`, which calls `document.getElementById`. It is
// DOM-coupled, so mounting it belongs in tier 2 (real WKWebView) and this file would have to
// invent a `document` to reach it — which is testing the shim. So the two halves are driven
// separately and honestly: `readMembers` is pure and is called directly (§1), and the port
// contract is driven through the real `createAdminPort` with the member view injected (§2, §3).
// The seam between them — that `mount.js` hands BOTH the same `rosterCache` — is tier 2's, and
// `tests/tier2/cosign.dom.js` is where it is driven in a real engine.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import { readMembers } from '../../src/js/family/membersui.js';
import { createAdminPort, initAdminPanel } from '../../src/js/family/adminpanel.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The fixture: `SHELL-VERIFICATION.md` §5's circle, member for member.
//
// Four members. Two are still in it — me and the person I am trying to remove. One was REMOVED
// (so `afterRemove` published `member.set{_alive:false}` and the log knows). One LEFT (so
// nothing was published at all and the log does not know, and cannot: `purgeMember` deletes
// every op the leaver's devices authored in the same transaction as the leave —
// `server/core/handlers/lifecycle.js:229`, pinned by `tests/server/lifecycle.test.js`).
// ─────────────────────────────────────────────────────────────────────────────────────────────

const ME = 'mem_me';
const TARGET = 'mem_target';
const LEFT = 'mem_founder_who_left';
const REMOVED = 'mem_removed';

const cell = (value) => ({ value });

/** `store.registers()` as `membersUIState` reads it: `member:<id>` → cells. */
function foldedLog() {
  return new Map([
    [`member:${ME}`, new Map([['displayName', cell('Ich')]])],
    [`member:${TARGET}`, new Map([['displayName', cell('Ziel')]])],
    // The leaver. No `_alive` cell — a leave writes nothing, so the log calls them alive forever.
    [`member:${LEFT}`, new Map([['displayName', cell('Papa')]])],
    // The removed one. `REMOVAL_PATCH`, folded.
    [`member:${REMOVED}`, new Map([['displayName', cell('Weg')], ['_alive', cell(false)]])],
  ]);
}

/** `GET /spaces/:id/members`, mapped the way `family/mount.js#refreshRoster` maps it. */
const ROSTER_FULL = Object.freeze([
  Object.freeze({ memberId: ME, colorRef: 'blau', removedAt: null, devices: [] }),
  Object.freeze({ memberId: TARGET, colorRef: 'gruen', removedAt: null, devices: [] }),
  Object.freeze({ memberId: LEFT, colorRef: 'rot', removedAt: '2026-09-01T10:00:00.000Z', devices: [] }),
  Object.freeze({ memberId: REMOVED, colorRef: 'gelb', removedAt: '2026-09-02T10:00:00.000Z', devices: [] }),
]);

const CIRCLE = Object.freeze({
  origin: 'https://relay.invalid', spaceId: 'fsp_test', memberId: ME, name: 'Familie',
});

/** The member view `ports.members()` returns, built from the two lists the product builds it from. */
function viewFrom(roster) {
  return {
    supported: true,
    me: ME,
    adminId: null,
    keysPending: false,
    members: readMembers(foldedLog(), { me: ME, adminId: null, hidden: new Set(), roster }),
  };
}

/** A port with the member view and the roster both stated, so no row depends on a global. */
function countWith({ view, roster, target = TARGET, circle = CIRCLE }) {
  initAdminPanel({ members: () => view, roster: () => roster });
  try {
    return createAdminPort(circle).eligibleCosigners(target);
  } finally {
    initAdminPanel();
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE SHELL'S NUMBER, REPRODUCED — and it names the roster, not the log
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1a with the roster present, the log ∩ roster leaves exactly the two people who are still in it', () => {
  const rows = readMembers(foldedLog(), { me: ME, adminId: null, hidden: new Set(), roster: ROSTER_FULL });
  const alive = rows.filter((m) => m.alive !== false).map((m) => m.memberId).sort();
  assert.deepEqual(alive, [ME, TARGET].sort(),
    'readMembers no longer applies the roster\'s removedAt — F-SHELL-2\'s whole premise moved');
  // The leaver is the one the LOG cannot see. It is the roster that buries them, and only it.
  const logOnly = readMembers(foldedLog(), { me: ME, adminId: null, hidden: new Set(), roster: [] });
  assert.equal(logOnly.find((m) => m.memberId === LEFT).alive, true,
    'the log knows about the leave — then this fixture is not the state F-SHELL-2 was measured in');
});

test('§1b the shell\'s 2 is unreachable with the roster present, and reachable without it', () => {
  // THE ROW THAT REFUTES THE RESIDUAL'S STATED CAUSE. `V2-FINAL.md` §8 R-4 reads the shell's 2 as
  // "the intersection is missing". The shell recorded the RELAY's state (4 rows, 2 alive) and not
  // the local log's, so both plausible log states are enumerated here rather than guessed at:
  // one where this Mac had folded the removal's `member.set{_alive:false}`, one where it had not.
  //
  // With the roster present the answer is 0 in BOTH — the roster buries the leaver and the
  // removed member on its own. So no log state produces a 2 with the roster present, and the
  // shell's 2 says `rosterCache` was empty. That is the whole claim, and it needs no assumption
  // about which log state that Mac was in.
  const removalNotFolded = foldedLog();
  removalNotFolded.get(`member:${REMOVED}`).delete('_alive');

  const count = (log, roster) => readMembers(log, { me: ME, adminId: null, hidden: new Set(), roster })
    .filter((m) => m.alive !== false)
    .filter((m) => m.memberId !== ME && m.memberId !== TARGET).length;

  assert.equal(count(foldedLog(), ROSTER_FULL), 0, 'roster present, removal folded');
  assert.equal(count(removalNotFolded, ROSTER_FULL), 0, 'roster present, removal not folded yet');
  assert.equal(count(foldedLog(), []), 1, 'roster absent, removal folded — the leaver alone');
  assert.equal(count(removalNotFolded, []), 2,
    'roster absent, removal not folded — and 2 is the number SHELL-VERIFICATION.md §5 recorded');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE COUNT, THROUGH THE REAL PORT
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2a a founder-less circle with the roster on the Mac offers nobody — the stranded sentence fires', () => {
  const n = countWith({ view: viewFrom(ROSTER_FULL), roster: ROSTER_FULL });
  assert.equal(n, 0,
    'a circle whose only two live members are the caller and the target is stranded, and '
    + '`leavedelete.js` turns COSIGN_COPY.nobody on `=== 0` and on nothing else');
});

test('§2b a healthy circle still counts the people who could actually sign', () => {
  // Same four members, but nobody has left and nobody was removed: three besides me, one of whom
  // is the target, so two can co-sign. A fix that strands a healthy family is the failure the
  // `null` branch exists to avoid, and this is the row that would catch it.
  const healthy = ROSTER_FULL.map((r) => ({ ...r, removedAt: null }));
  const log = foldedLog();
  log.get(`member:${REMOVED}`).delete('_alive');
  const view = {
    supported: true,
    members: readMembers(log, { me: ME, adminId: null, hidden: new Set(), roster: healthy }),
  };
  assert.equal(countWith({ view, roster: healthy }), 2);
});

test('§2c the prescribed intersection is a no-op over the view the product passes — measured, both ways', () => {
  // THE ROW THAT REFUTES THE RESIDUAL'S PRESCRIBED FIX. `ports.members()` is `membersUIState()`,
  // which is already log ∩ roster, so intersecting the SAME roster into it again cannot change
  // the answer. Both spellings, one assertion, so a future reader cannot be told this without
  // being shown it.
  const view = viewFrom(ROSTER_FULL);
  const withRoster = countWith({ view, roster: ROSTER_FULL });
  const withoutRoster = countWith({ view, roster: [] });   // the pre-change wiring
  assert.equal(withRoster, 0);
  assert.equal(withoutRoster, 0,
    'the count changed when the roster port was withheld from a view that already applied it — '
    + 'then `readMembers` stopped applying `removedAt` and §1a should have died first');
});

test('§2d me and the target are never co-signers, and `space.delete` counts with no target at all', () => {
  const healthy = ROSTER_FULL.map((r) => ({ ...r, removedAt: null }));
  const log = foldedLog();
  log.get(`member:${REMOVED}`).delete('_alive');
  const view = {
    supported: true,
    members: readMembers(log, { me: ME, adminId: null, hidden: new Set(), roster: healthy }),
  };
  // 20.4's `space.delete` has no target: everyone alive but me may co-sign.
  assert.equal(countWith({ view, roster: healthy, target: null }), 3);
  // …and I am excluded from my own act, in both shapes.
  assert.equal(countWith({ view, roster: healthy, target: TARGET }), 2);
});

test('§2e an unmounted member view is UNKNOWN and stays `null`, whatever the roster says (T5-M3)', () => {
  // Reporting an unknown count as zero would tell a five-person family it was stuck. The roster
  // may not change that: it is not a member list this Mac can render.
  assert.equal(countWith({ view: { supported: false, members: [] }, roster: ROSTER_FULL }), null);
  assert.equal(countWith({ view: null, roster: ROSTER_FULL }), null);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE ONE THING THE MEMBER VIEW CANNOT SAY — "this Mac holds no roster"
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3a no roster and a positive count is a CEILING, and is reported as `null`, not as a number', () => {
  // This is the state the shell was in. The log says two could co-sign; the log has never heard
  // of the leave and structurally cannot. `null` is what that is.
  const n = countWith({ view: viewFrom([]), roster: [] });
  assert.equal(n, null,
    'a log-only count above zero was reported as a number — it is an upper bound, not a count');
});

test('§3b no roster and a count of ZERO is still zero — an unreachable relay may not un-strand a circle', () => {
  // The direction that matters. The log can only ever OVER-count, so a log-only zero is certain:
  // there is nobody alive to co-sign whatever the relay would have said. A two-member circle
  // whose roster never arrived must still meet COSIGN_COPY.nobody as a sentence.
  const twoMemberLog = new Map([
    [`member:${ME}`, new Map([['displayName', cell('Ich')]])],
    [`member:${TARGET}`, new Map([['displayName', cell('Ziel')]])],
  ]);
  const view = {
    supported: true,
    members: readMembers(twoMemberLog, { me: ME, adminId: null, hidden: new Set(), roster: [] }),
  };
  assert.equal(countWith({ view, roster: [] }), 0,
    'a stranded two-member circle stopped getting its sentence when the relay was unreachable — '
    + 'that is a regression the `null` branch must never cause');
});

test('§3c a roster in which NOBODY has left is still a roster, and the count is a count', () => {
  // The distinction the branch turns on is `rows.length`, not `gone.size`. A five-person family
  // whose roster says everyone is present must get 3, not `null`: silence about departures is an
  // answer, and treating it as "no roster" would make the honest case unknowable.
  const healthy = ROSTER_FULL.map((r) => ({ ...r, removedAt: null }));
  const log = foldedLog();
  log.get(`member:${REMOVED}`).delete('_alive');
  const view = {
    supported: true,
    members: readMembers(log, { me: ME, adminId: null, hidden: new Set(), roster: healthy }),
  };
  assert.equal(countWith({ view, roster: healthy, target: null }), 3);
});

test('§3d the default roster port is empty, so a panel nobody wired is UNKNOWN and never confidently wrong', () => {
  // `initAdminPanel()` with no deps is what a Mac gets if `mount.js` ever stops passing the port.
  // The count must then admit it does not know, rather than quietly answering from the log.
  initAdminPanel({ members: () => viewFrom([]) });
  try {
    assert.equal(createAdminPort(CIRCLE).eligibleCosigners(TARGET), null,
      'the default roster port is no longer `[]`, or the ceiling branch stopped reading it');
  } finally {
    initAdminPanel();
  }
});

test('§3e a list of rows that name nobody is not a roster — it may not pass for one, and may not throw', () => {
  // The rows come off the network, so the "have I got a roster" question has to be asked of the
  // rows and not of the array. A list of nulls would otherwise let an empty answer masquerade as
  // a fetched one, and the ceiling would be reported as a count again.
  const namesNobody = [null, undefined, {}, { removedAt: '2026-09-01T00:00:00.000Z' }, { memberId: '' }];
  assert.equal(countWith({ view: viewFrom([]), roster: namesNobody }), null,
    'a roster of rows that name nobody was accepted as evidence that a roster arrived');

  // …and ONE row that does name somebody is a roster, even though it says nothing about a
  // departure. This is the pair that pins the branch to "did a roster arrive", not "who left".
  // The count is then the view's own: the log knows about the removal and not about the leave,
  // so it leaves the departed founder standing — which is the over-count, now reported as a
  // number because this Mac has a roster and the roster is what the caller may act on.
  assert.equal(countWith({ view: viewFrom([]), roster: [{ memberId: ME, removedAt: null }] }), 1);
});
