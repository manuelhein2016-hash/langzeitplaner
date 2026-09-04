// TIER 2 · E13 — WHERE THE INCREMENTAL RENDERER MEETS A REAL HAND.
// Audit findings F7 (P3) and F8 (P10), inverted · stories 9.5 · 10.2 · 18.2 · 5.1.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE TWO THINGS THIS FILE IS ABOUT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Both were the board doing something the user did not ask for, and both are a standing
// principle rather than a ticket.
//
//  F7 · P3 — THE USER'S OWN INK WINS. `board.js:patchPad` reconciled the scratchpad's `value`
//       property on every render, which was harmless while every render came from a gesture of
//       the user's own (v1: the gesture blurs the textarea first, so `onPadBlur` → `commitPad`
//       has already saved the text). v2 added a caller v1 did not have: a peer's ops folding in
//       emit `'remote'`, `main.js` redraws, and up to 600 ms of her writing — rule U9's debounce
//       window — was discarded mid-sentence. Not undoable: it was never committed.
//       There is a SECOND half, and it is the more reachable one. Once the 600 ms pause DID fire,
//       `padSig` had moved, and the next render REPLACED the whole pad block — so the caret was
//       ripped out of the box she was typing in as well.
//
//  F8 · P10 — THE BOARD IS NOT A MESSENGER. `noteSig` does not mention the day, `renderNote`
//       writes `node.dataset.date = d.date`, and `entities.js:noteOccurrences` pushes THE SAME
//       note object once per year — so a yearly repeat keeps its node across a year page turn
//       and kept last year's date. `interact.js` reads that attribute as the drag ORIGIN while
//       the drop target comes from the day row, so picking a repeating entry up and putting it
//       back down on the same day read as a MOVE: an op in the log, a step on the undo stack,
//       and on a shared entry a `pub.date` published to the whole circle for a day on which
//       nothing happened.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY IT IS A SEPARATE FILE, AND WHAT IT DRIVES THAT THE OTHERS DO NOT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `e1-incremental.dom.js` owns the identity proof and drives the MODEL: it writes `store.state`
// and calls `renderBoard`. That is the right shape for the seam it owns, and it is why neither
// finding was in its 89 cells — one needs a real caret in a real textarea, the other needs the
// year pager and a hand.
//
// So this file starts one step earlier, every time:
//
//   · the year page turn is a CLICK ON `#pg-next`, the shipped button, not `settings.pageYears`;
//   · the drag is a real `pointerdown`/`pointermove`/`pointerup` over the 4 px threshold, and
//     the drop target is resolved by `document.elementsFromPoint` — real hit-testing, which is
//     the thing the audit recorded as NOT proven (§5.7: "a pointer was never driven through
//     real hit-testing to produce the phantom op");
//   · the peer's change arrives through `store.applyRemote` — the same call the transport makes
//     — and the redraw is `main.js`'s own subscriber, not a call to `renderBoard` from here;
//   · the typing goes in as `input` events, so `interact.js`'s debounce is the real one;
//   · the one full rebuild a person can reach while typing is a LANGUAGE SWITCH, so §G5 switches
//     the language rather than dropping the render cache.
//
// ⚠ EVERY ROW THAT COULD PASS VACUOUSLY CARRIES ITS OWN CONTROL. "No op was written" is the
// assertion a broken rig makes for free — a pointer that misses, a note that is not on the
// board, a render that never ran. So each no-op row is paired with the SAME gesture, one day
// further, which must write exactly one op; and the peer's arrival is asserted to have reached
// the board before the pad is examined.
//
// ── WHICH ROW DIES WITH WHICH LINE ───────────────────────────────────────────────────────────
//
// Measured, not asserted: each line below was removed on its own, this file was re-run in the
// same WKWebView, and these are the rows that went red. The honest path — every line in place —
// is 10/10.
//
//   M1   `board.js#patchBody`      the kept note's `data-date` re-sync  → §G1 §G2 §G2b §G7  (4)
//   M2   `interact.js#finishDrag`  `if (moved === n.date) return`       → §G3               (1)
//   M1+M2  both of the above                                            → §G1 §G2 §G2b §G3 §G7
//   M3   `board.js#patchPad`       the `unsent` guard on `value`        → §G4 §G4b §G6      (3)
//   M3b  `board.js#unsent`         its `padShown` half — the caret alone→ §G6               (1)
//   M4   `board.js#patchPad`       patching the pad, not replacing it   → §G4b §G6          (2)
//   M5   `board.js#renderBoard`    `restoreInk` on the full path        → §G5               (1)
//
// M3b is the one worth reading twice. A guard on the CARET ALONE fixes F7 and is too wide: it
// makes a box nobody has typed in hold out against a change made elsewhere. Measured, it also
// turns `retrofit-probe3.dom.js` R3 red — a file this work package does not own — because R1
// leaves a pad focused with text and R3 counts undo steps after it. §G6 is the row that keeps
// the rule narrow, and R3 is the row that would have paid for it being wide.
//
// The two F8 lines are BELT AND BRACES and the table shows it: with M1 alone the gesture rows
// still hold, because the belt in `interact.js` refuses the write even when the attribute lies.
// §G3 is the row that cuts the braces on purpose so the belt is visible on its own.
//
// ⚠ AND `home()` DROPS THE RENDER CACHE FOR A REASON. The first draft of §G2 was green under M1,
// and it was green by LUCK: it inherited §G1's page walk, and a `data-date` one page behind lands
// on the right year again when you page forward — the audit's own „only ever corrected by luck".
// Every row now starts from one full render, which is the state a launch is in.
//
// ── WHAT THIS FILE DOES NOT PROVE ────────────────────────────────────────────────────────────
//
// A real process quit-and-open. Tier 2 evaluates one file per launch and cannot relaunch inside
// itself. §G7 does the half that is reachable and says so: the pager position is PERSISTED, so
// the state F8 needs is the state the app OPENS in on the next launch — the first gesture of
// launch 2 reaches it with nothing else happening — and the first render of a fresh process is
// a full one, which §G7 reproduces by dropping the cache.
//
// Plain script: globals are test, assert, $, $$, waitFor, sleep, importApp, diag, skip.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const { store } = await importApp('store.js');
const { renderBoard, invalidateBoardCache } = await importApp('board.js');
const { reanchorRepeat, familyKey } = await importApp('core/entities.js');
const { makeOp } = await importApp('core/ops.js');
const { createClock } = await importApp('core/stamp.js');
const { parseAttestationBlob } = await importApp('core/authz.js');
const { projectForFamily } = await importApp('core/project.js');
const { canonicalJSON } = await importApp('core/canon.js');
const { b64u } = await importApp('core/b64.js');
const { setLang } = await importApp('i18n.js');

const boardEl = () => $('#board');
const $id = (id) => document.getElementById(id);

// ── the circle: this Mac, and Papa, who is a genuine peer ────────────────────────────────────
//
// Lifted from `e9-demonstration.dom.js` §0, which is the file that proved this fixture works:
// Papa has his own HLC, his own device and his own attestation, and his ops are delivered
// through the real `store.applyRemote`. The test is the door for the attestation OPENER only —
// `authz.js` still compares all six ADR 002 §2.3 fields, so nothing is smuggled past the fold.

const SPACE = 'fsp_e13glassE13glassE13gla';
const PAPA = `mem_${'E'.repeat(22)}`;
const PAPA_DEV = `dev_${'E'.repeat(22)}`;
const PAPA_SHORT = 'E'.repeat(16);

const utf8 = (s) => new TextEncoder().encode(s);
const blobFor = (att) => `${b64u(utf8(canonicalJSON(att)))}.${b64u(utf8('signature'))}`;

store.useFamilySpace(SPACE);
const MY = store.diagnostics().identity;
const ME = MY.memberId;
store.setAttestOpen((_m, b) => parseAttestationBlob(b));
store.apply('attestMyDevice', {
  deviceShort: MY.deviceShort,
  blob: blobFor({
    memberId: ME, deviceId: MY.deviceId, deviceShort: MY.deviceShort,
    sigPubRaw: b64u(utf8('mysig')), kexPubRaw: b64u(utf8('mykex')), createdAt: '2026-08-25',
  }),
});
store.apply('setMyProfile', { displayName: 'Ich', colorRef: 'palette-3' });

function peer(member, dev, short) {
  let n = 0;
  const clock = createClock(short, () => Date.now() + 60_000);
  const ctx = {
    act: member, dev, gid: 'E'.repeat(22), space: 'personal', familySpaceId: SPACE,
    mint: () => clock.tick(), newOpId: () => `e13${String(++n).padStart(19, '0')}`,
  };
  const att = blobFor({
    memberId: member, deviceId: dev, deviceShort: short,
    sigPubRaw: b64u(utf8(`sig${short}`)), kexPubRaw: b64u(utf8(`kex${short}`)), createdAt: '2026-08-25',
  });
  return {
    op: (kind, e, f) => makeOp(ctx, kind, e, f, {}),
    joinOps: () => [
      makeOp(ctx, 'member.set', `member:${member}`, { [`dev.${short}`]: att }, {}),
      makeOp(ctx, 'member.set', `member:${member}`, { displayName: 'Papa', colorRef: 'palette-1' }, {}),
    ],
  };
}
const papa = peer(PAPA, PAPA_DEV, PAPA_SHORT);
{
  const r = store.applyRemote(papa.joinOps());
  if (r.applied.length !== 2) throw new Error(`the circle did not form: ${JSON.stringify(r.refused)}`);
}

/** Papa's note, published the way his Mac would publish it — through the real projection. */
function papaPublishes(uuid, { date, text = 'Elternabend', level = 'geteilt' }) {
  const truth = {
    visibility: level, date, text, repeatsYearly: false, coEdit: false,
    categoryId: 'papas-kategorie', _alive: true, _born: null,
  };
  const patch = projectForFamily('fnote', truth, level, null);
  return papa.op('pub.set', familyKey('fnote', PAPA, uuid), { ...patch });
}

// ── the log, which is where a phantom write is visible and the pixels are not ────────────────

// ⚠ BY OP ID, NOT BY INDEX. `oplog.js:lines()` walks two Maps and a register rewrite can
// supersede a line in place, so `lines().slice(mark)` is not "what was written since" — it is
// "what sits after that offset now", and a real write can move an OLDER line into view (it does:
// the pager's own `pref.set` turned up in the first run of §G2b). A set difference over `op.id`
// answers the question the row is actually asking.
const opMark = () => new Set(store._log.lines().map((l) => l.op.id));
const opsSince = (m) => store._log.lines().map((l) => l.op).filter((o) => !m.has(o.id));
const kindsSince = (m) => opsSince(m).map((o) => o.k);
const showOps = (m) => JSON.stringify(opsSince(m).map((o) => `${o.k} ${o.e} ${JSON.stringify(o.f)}`));

// ── gestures: the same helpers `interaction.dom.js` characterizes v1 with ────────────────────

const at = (node, dx = 6, dy = 4) => {
  const r = node.getBoundingClientRect();
  return { clientX: r.left + dx, clientY: r.top + dy };
};
const ptr = (type, node, pos, target = node) =>
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1, isPrimary: true, ...pos,
  }));
const move = (pos) => window.dispatchEvent(new PointerEvent('pointermove', {
  bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, ...pos,
}));

/**
 * Press on `node`, cross the 4 px threshold, travel to `to`, release there.
 *
 * `to` is a POINT, not an element, because the whole question is what the pointer is over when
 * it is released: `interact.js:dateUnderPointer` runs `document.elementsFromPoint` and the drop
 * is whatever day row is under the glass. Nothing here tells it a date.
 */
function dragTo(node, to) {
  const a = at(node);
  ptr('pointerdown', node, a);
  move({ clientX: a.clientX + 6, clientY: a.clientY });      // > 4 px: `beginDrag`
  move(to);
  window.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, ...to,
  }));
}

/** The middle of a day row, which is what a hand aims at. */
const inRow = (row) => {
  const r = row.getBoundingClientRect();
  return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
};

/** Does the pointer really land on that row? Asked before every drag, so no row passes by miss. */
const hits = (row, pos) =>
  document.elementsFromPoint(pos.clientX, pos.clientY).some((n) => n.closest?.('.day') === row);

// ── the board under test ─────────────────────────────────────────────────────────────────────

const dayRow = (date) => $(`#board .day[data-date="${date}"]`);
const noteNode = (id) => $(`#board .note[data-note-id="${CSS.escape(id)}"]`);
const padOf = (month) => $(`#board .pad[data-month="${month}"] textarea`);

let seq = 0;
const mkId = () => `e13${String(++seq).padStart(5, '0')}-cccc-4ddd-8eee-ffffffffffff`;

const CAT = store.state.categories[0].id;

/** One of mine, through the product's own door, so every op below is a real one. */
function myRepeat(date, text, visibility) {
  const id = mkId();
  store.apply('createNoteInline', { id, date, text, categoryId: CAT, visibility });
  store.apply('toggleRepeat', { id, repeatsYearly: true, date });
  return id;
}

/**
 * The board a launch opens on: pinned to 2026-01, page 0, no layers — and NOT PATCHED BY
 * ANYTHING YET.
 *
 * The cache is dropped on purpose. A stale `data-date` is „only ever corrected by luck" (the
 * audit's §D1b): page away and back and the attribute lands on the right year again by accident,
 * so a row that inherits the previous row's page walk can be testing a lucky board rather than
 * the one it names. Every row below therefore starts from the state a fresh process is in — one
 * full render — and takes exactly the gestures it describes from there.
 */
function home() {
  store.setSettings({
    mode: 'pinned', startMonth: '2026-01', pageYears: 0,
    layers: { feiertage: false, schulferien: false, otherStates: false },
  });
  invalidateBoardCache();
  renderBoard(boardEl());
}
home();
const PRIVAT = myRepeat('2026-03-12', 'Omas Geburtstag', 'privat');
const GETEILT = myRepeat('2026-03-20', 'Zahnarzt Lena', 'geteilt');

diag(`fixture: ${store.state.notes.length} note(s) on the board, `
  + `mine repeating at 2026-03-12 (privat) and 2026-03-20 (geteilt)`);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §G1 · THE YEAR PAGER, AT THE GLASS — F8's mechanism, inverted
//
// One click of „›" and a repeating note must name the day it is drawn on. Both directions, six
// pages, and after every one of them the incremental board is compared against a from-scratch
// rebuild of the same model — LZP-1007's stated invariant, at the transition `e1-incremental`'s
// fixed seed reaches in 6.47 % of pairs and did not draw.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * e1's comparison, verbatim in shape: render incrementally, snapshot; drop the cache, render
 * from scratch, snapshot; the two must be the same string — and the same scratchpad values,
 * which is the one piece of board state `outerHTML` does not carry.
 */
function agreesWithRebuild() {
  renderBoard(boardEl());
  const inc = boardEl().outerHTML;
  const incPads = $$('#board .pad textarea').map((t) => t.value).join('');
  invalidateBoardCache();
  renderBoard(boardEl());
  const full = boardEl().outerHTML;
  const fullPads = $$('#board .pad textarea').map((t) => t.value).join('');
  if (inc === full && incPads === fullPads) return { ok: true };
  let i = 0;
  while (i < inc.length && i < full.length && inc[i] === full[i]) i++;
  return {
    ok: false,
    why: incPads !== fullPads
      ? `the scratchpad values differ: ${JSON.stringify(incPads)} vs ${JSON.stringify(fullPads)}`
      : `at char ${i}\n      incremental: …${inc.slice(Math.max(0, i - 80), i + 100)}`
        + `\n      full       : …${full.slice(Math.max(0, i - 80), i + 100)}`,
  };
}

test('§G1 · a click of the year pager leaves every repeating note naming the day it is drawn on', () => {
  try {
    home();
    const seen = [];
    let bad = 0;
    for (const step of [+1, +1, +1, -1, -1, -1]) {
      $id(step > 0 ? 'pg-next' : 'pg-prev').click();       // THE SHIPPED BUTTON
      const y = store.state.settings.pageYears;
      for (const id of [PRIVAT, GETEILT]) {
        const el = noteNode(id);
        assert.ok(el, `the repeating note vanished from the board on page +${y}y`);
        const row = el.closest('.day').dataset.date;
        seen.push(`+${y}y ${el.dataset.date} in ${row}`);
        if (el.dataset.date !== row) bad++;
      }
      const cmp = agreesWithRebuild();
      if (!cmp.ok) diag(`  page +${y}y: ${cmp.why}`);
      assert.ok(cmp.ok, `on page +${y}y the incremental board is not the board a full rebuild produces`);
    }
    for (const s of seen) diag('  ' + s);
    assert.equal(bad, 0, `${bad} of ${seen.length} readings carried another year's date`);
  } finally { home(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §G2 · WHAT IT COST — THE GESTURE, WITH REAL HIT-TESTING
//
// The audit could state the precondition and not the gesture. This is the gesture: after a page
// turn, pick the repeating entry up and put it back down where it was. Nothing happened, so
// nothing may be written — and on the shared one, nothing may be published.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§G2 · after a year page turn, putting a repeating entry back where it was writes nothing', () => {
  try {
    home();
    const kept = noteNode(PRIVAT);
    $id('pg-next').click();
    const el = noteNode(PRIVAT);
    const row = el.closest('.day');
    diag(`  page +1y: the note ${el === kept ? 'is the node the last render kept' : 'was rebuilt'}`
      + `, says ${el.dataset.date}, its row says ${row.dataset.date}`);
    // The precondition, asserted where the gesture reads it. §G1 owns the attribute; this row
    // owns what a hand does with it, and a hand can only prove something about a kept node.
    assert.equal(el === kept, true, 'the page turn rebuilt the note — this row is then about nothing');
    assert.equal(el.dataset.date, row.dataset.date, 'the drag origin is a year out before the gesture even starts');

    const pos = inRow(row);
    assert.ok(hits(row, pos), 'the rig missed the row it is aiming at — the gesture below would prove nothing');

    const before = store.state.notes.find((n) => n.id === PRIVAT).date;
    const mark = opMark();
    const couldUndo = store.canUndo();
    dragTo(el, pos);                                        // up, and back down on the same day
    diag(`  ops written by the no-op gesture: ${showOps(mark)}`);
    assert.equal(opsSince(mark).length, 0, 'a gesture that changed nothing wrote to the log');
    assert.equal(store.canUndo(), couldUndo, 'a gesture that changed nothing put a step on the undo stack');
    assert.equal(store.state.notes.find((n) => n.id === PRIVAT).date, before, 'and the entry itself moved');
  } finally { home(); }
});

test('§G2b · on a SHARED entry the same gesture publishes nothing — P10 (control: a real move does)', () => {
  try {
    home();
    const kept = noteNode(GETEILT);
    $id('pg-next').click();
    const el = noteNode(GETEILT);
    const row = el.closest('.day');
    diag(`  page +1y: the shared note ${el === kept ? 'is the kept node' : 'was rebuilt'}, `
      + `says ${el.dataset.date}, its row says ${row.dataset.date}`);
    assert.equal(el === kept, true, 'the page turn rebuilt the note — this row is then about nothing');
    assert.equal(el.dataset.date, row.dataset.date, 'the drag origin is a year out before the gesture even starts');
    const pos = inRow(row);
    assert.ok(hits(row, pos), 'the rig missed the row it is aiming at');

    const mark = opMark();
    dragTo(el, pos);
    diag(`  no-op gesture on the shared entry wrote: ${showOps(mark)}`);
    assert.equal(kindsSince(mark).filter((k) => k === 'pub.set').length, 0,
      'a gesture that changed nothing published a pub.date to the whole circle');
    assert.equal(opsSince(mark).length, 0, 'a gesture that changed nothing wrote to the log');

    // ── THE HONEST-PATH CONTROL ──────────────────────────────────────────────────────────────
    // The same hand, the same rig, one row further down. If this does not write, the row above
    // is proving that the pointer missed rather than that the board held its tongue.
    const target = dayRow('2027-03-21');
    const tpos = inRow(target);
    assert.ok(hits(target, tpos), 'the control missed its target row');
    const mark2 = opMark();
    dragTo(noteNode(GETEILT), tpos);
    const ops = opsSince(mark2);
    diag(`  the real move wrote: ${showOps(mark2)}`);
    assert.ok(ops.length > 0, 'a real move wrote nothing — the rig is not driving the app');
    // 9.3 — the series keeps its first year and moves the month/day it lands on.
    const want = reanchorRepeat('2026-03-20', '2027-03-21');
    assert.equal(store.state.notes.find((n) => n.id === GETEILT).date, want,
      `a real move must land on ${want}`);
    assert.equal(ops.filter((o) => o.k === 'pub.set' && o.f['pub.date'] === want).length, 1,
      `a real move on a shared entry publishes exactly one pub.date: ${showOps(mark2)}`);
    // put it back, through the same door, so the fixture is where the next row expects it
    store.apply('moveNote', { id: GETEILT, date: '2026-03-20' });
  } finally { home(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §G3 · THE MUTANT — the stale attribute, put back by hand
//
// The two F8 lines are belt and braces, and a belt is only visible while the braces are cut. So
// this row cuts them: the DOM is put back into exactly the state the defect produced — one
// attribute, a year out, on a node the renderer is otherwise keeping correctly — and the same
// gesture must still write nothing, because `interact.js#finishDrag` asks the question the op
// would answer (does the RESULT differ from the entry?) rather than the question the DOM was
// asked (do these two attributes differ?).
//
// It is the only row that dies when that line goes, and it dies for both mutants (M2 and M1+M2)
// in the table above.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§G3 · with the stale attribute planted by hand, the no-op gesture still writes nothing', () => {
  try {
    home();
    $id('pg-next').click();
    const el = noteNode(PRIVAT);
    const row = el.closest('.day');
    el.dataset.date = '2026-03-12';                          // the defect, reproduced exactly
    diag(`  mutant: the note says ${el.dataset.date}, its row says ${row.dataset.date}`);
    assert.notEqual(el.dataset.date, row.dataset.date, 'the mutant did not take');

    const pos = inRow(row);
    assert.ok(hits(row, pos), 'the rig missed the row it is aiming at');
    const mark = opMark();
    dragTo(el, pos);
    diag(`  under the mutant, the no-op gesture wrote: ${showOps(mark)}`);
    assert.equal(opsSince(mark).length, 0,
      'with the drag origin a year out, a press-and-release became a published move');

    // The control under the mutant: a genuine move still writes, so the belt is narrow.
    const target = dayRow('2027-03-14');
    const tpos = inRow(target);
    assert.ok(hits(target, tpos), 'the control missed its target row');
    const mark2 = opMark();
    dragTo(noteNode(PRIVAT), tpos);
    diag(`  under the mutant, a real move wrote: ${showOps(mark2)}`);
    assert.equal(store.state.notes.find((n) => n.id === PRIVAT).date,
      reanchorRepeat('2026-03-12', '2027-03-14'),
      'the belt swallowed a real move');
    store.apply('moveNote', { id: PRIVAT, date: '2026-03-12' });
  } finally { home(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §G4 · F7 — SHE IS MID-SENTENCE AND SOMEBODY ELSE'S OP ARRIVES
//
// Nothing here calls `renderBoard`. Papa's note goes in through `store.applyRemote`, which is
// what the transport calls; the store emits `'remote'`; `main.js`'s subscriber redraws. The
// arrival is asserted ON THE BOARD first, so a row that "preserved" the text because no render
// happened would fail rather than pass.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Type into the pad the way a keyboard does: one character at a time, through `input`. */
function type(ta, text) {
  for (const ch of text) {
    ta.value += ch;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

const PAD_MONTH = '2026-12';
const padText = () => store.state.scratchpads[PAD_MONTH];

function clearPad() {
  const ta = padOf(PAD_MONTH);
  if (ta) ta.blur();
  if (padText() !== undefined) store.apply('padBlur', { month: PAD_MONTH, text: '', born: false });
  delete store.state.scratchpads[PAD_MONTH];
  invalidateBoardCache();
  renderBoard(boardEl());
}

test('§G4 · a peer’s op arriving mid-sentence leaves her uncommitted typing alone', async () => {
  try {
    home();
    clearPad();
    const ta = padOf(PAD_MONTH);
    ta.focus();
    const typed = 'Zahnarzt Lena Di 15 Uhr\nSchulranzen kaufen\nOma anrufen';
    type(ta, typed);
    ta.setSelectionRange(9, 9);                              // the caret, mid-word
    diag(`  typed ${typed.length} characters; the store still has ${JSON.stringify(padText())}`);
    assert.equal(padText(), undefined, 'the fixture is wrong: the debounce already committed');

    const uuid = mkId();
    const r = store.applyRemote([papaPublishes(uuid, { date: '2026-12-08' })]);
    assert.equal(r.refused.length, 0, `Papa's publication was refused: ${JSON.stringify(r.refused)}`);
    await sleep(5);

    // THE RENDER REALLY HAPPENED — his entry is on the board, drawn by the redraw under test.
    const his = noteNode(familyKey('fnote', PAPA, uuid));
    assert.ok(his, "Papa's entry never reached the board — the redraw this row is about did not run");

    const after = padOf(PAD_MONTH);
    diag(`  after his op: same node=${after === ta}, still focused=${document.activeElement === after}, `
      + `caret=${after.selectionStart}, value=${JSON.stringify(after.value)}`);
    assert.equal(after, ta, 'the textarea she is typing in was replaced');
    assert.equal(after.value, typed, "a peer's op discarded text she had typed and not yet committed");
    assert.equal(document.activeElement, after, 'the caret was taken out of the box she is typing in');
    assert.equal(after.selectionStart, 9, 'the caret moved inside the box she is typing in');
    assert.equal(after.closest('.pad').classList.contains('empty'), false,
      'the pad still calls itself empty while she is writing in it');
  } finally { clearPad(); home(); }
});

test('§G4b · and after the 600 ms pause has committed once, the rest of the sentence survives too', async () => {
  try {
    home();
    clearPad();
    const ta = padOf(PAD_MONTH);
    ta.focus();
    type(ta, 'Hütte buchen');
    await waitFor(() => padText() === 'Hütte buchen', { what: 'the debounced pad write (rule U9)' });
    // She keeps writing. `padSig` has now MOVED — this is the half that used to replace the
    // whole pad block and take the caret with it.
    type(ta, ', Bettwäsche mitnehmen');
    const whole = 'Hütte buchen, Bettwäsche mitnehmen';
    diag(`  the store has ${JSON.stringify(padText())}; the box has ${JSON.stringify(ta.value)}`);

    const uuid = mkId();
    const r = store.applyRemote([papaPublishes(uuid, { date: '2026-12-09', text: 'Skiausrüstung' })]);
    assert.equal(r.refused.length, 0, `Papa's publication was refused: ${JSON.stringify(r.refused)}`);
    await sleep(5);
    assert.ok(noteNode(familyKey('fnote', PAPA, uuid)), "Papa's entry never reached the board");

    const after = padOf(PAD_MONTH);
    diag(`  after his op: same node=${after === ta}, focused=${document.activeElement === after}, `
      + `value=${JSON.stringify(after.value)}`);
    assert.equal(after, ta, 'the pad block was rebuilt under the caret');
    assert.equal(after.value, whole, 'the tail she had not committed yet was discarded');
    assert.equal(document.activeElement, after, 'the caret was ripped out of the box she is typing in');

    // 10.2 — and none of it is lost on the way out: the blur commits the whole sentence.
    ta.blur();
    assert.equal(padText(), whole, 'the sentence did not reach the store when she left the box');
  } finally { clearPad(); home(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §G5 · THE FULL REBUILD A USER CAN ACTUALLY CAUSE, WITH THE CARET IN THE BOX
//
// `patchPad` leaves an unsent sentence alone; the full path is about to DELETE the box it is in.
// The one full rebuild a person can reach while typing is a LANGUAGE SWITCH — `copyEpoch` moves,
// `canPatch` says no, and the whole board is rebuilt (13.7) — so that is the gesture this row
// makes, and her sentence and her caret have to come out the other side.
//
// ⚠ AND THE LIMIT OF IT, STATED. What the full path carries across is what the cache it is
// replacing calls UNSENT. A render with no cache — the first of a process, or a test that
// dropped it — has nothing to judge by and nothing to carry, so the model wins there exactly as
// it did in v1. That is not a hole: a fresh process has no half-typed sentence, and it is the
// behaviour `e1-incremental.dom.js` §I4 pins, which is why §I4 is still green.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§G5 · a language switch rebuilds the whole board and keeps her unsent sentence', () => {
  try {
    home();
    clearPad();
    const ta = padOf(PAD_MONTH);
    ta.focus();
    type(ta, 'Reifen wechseln');
    ta.setSelectionRange(6, 6);

    setLang('en');                       // 13.7 — the copy epoch moves, so `canPatch` says no
    renderBoard(boardEl());
    const after = padOf(PAD_MONTH);
    diag(`  after the language switch rebuilt the board: same node=${after === ta}, `
      + `focused=${document.activeElement === after}, caret=${after.selectionStart}, `
      + `value=${JSON.stringify(after.value)}`);
    assert.notEqual(after, ta, 'the fixture is wrong: this was supposed to be a full rebuild');
    assert.equal(after.value, 'Reifen wechseln', 'the full rebuild dropped her sentence');
    assert.equal(document.activeElement, after, 'the full rebuild dropped the caret');
    assert.equal(after.selectionStart, 6, 'the full rebuild moved the caret');
    assert.equal(after.closest('.pad').classList.contains('empty'), false,
      'the rebuilt pad calls itself empty while her sentence is in it');

    // AND THE REST OF THE BOARD IS STILL THE BOARD A FROM-SCRATCH REBUILD PRODUCES — with one
    // difference, which is stated rather than normalised away by accident. A from-scratch render
    // has no cache to judge unsent typing by, so it builds the box from the model: it holds no
    // sentence (`value` is not in `outerHTML` at all) and its `.pad` therefore calls itself
    // `empty`, which IS. That one class is the whole difference, and this asserts both halves —
    // that it differs there, and that it differs nowhere else.
    const inc = boardEl().outerHTML;
    invalidateBoardCache();
    renderBoard(boardEl());
    const full = boardEl().outerHTML;
    const strip = (h) => h.replace(/class="pad empty"/g, 'class="pad"');
    if (strip(inc) !== strip(full)) {
      const a = strip(inc); const b = strip(full);
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      diag(`  at char ${i}\n      kept: …${a.slice(Math.max(0, i - 80), i + 100)}`
        + `\n      full: …${b.slice(Math.max(0, i - 80), i + 100)}`);
    }
    assert.equal(strip(inc), strip(full),
      'the rebuilt board differs from a from-scratch rebuild somewhere other than the one box she is typing in');
    assert.notEqual(inc, full,
      'the from-scratch board kept her sentence — then it knew something it cannot know, and this row is not measuring what it says');
  } finally { setLang('de'); clearPad(); home(); }
});

test('§G6 · the rule is UNSENT KEYSTROKES, and nothing wider', () => {
  try {
    home();
    clearPad();
    const ta = padOf(PAD_MONTH);

    // 1 · §I4's state, restated here because it is the CONTROL for §G4: text in the element that
    // the model does not have, and no caret in it. `e1-incremental.dom.js` §I4 pins the reset and
    // it stays pinned — a guard that skipped on the value alone would leave a kept board holding
    // a string a rebuilt one does not, and this row would die instead of §I4.
    ta.blur();
    ta.value = 'nicht getippt, nur hineingeschrieben';
    assert.notEqual(document.activeElement, ta, 'the fixture is wrong: the caret is still in the box');
    renderBoard(boardEl());
    diag(`  caret elsewhere → the box holds ${JSON.stringify(padOf(PAD_MONTH).value)}`);
    assert.equal(padOf(PAD_MONTH).value, '', 'the model no longer wins when the caret is elsewhere');

    // 2 · THE HALF THAT IS NOT ABOUT THE CARET. The caret is in the box, but she has typed
    // nothing since the board and the box last agreed — so what is in there is not ink, it is a
    // box that lags, and a change from anywhere else displaces it. Nothing she typed is lost,
    // because there is nothing she typed.
    const ta2 = padOf(PAD_MONTH);
    ta2.focus();
    store.state.scratchpads[PAD_MONTH] = 'von woanders';
    renderBoard(boardEl());
    diag(`  caret in an untouched box, a change from elsewhere → `
      + `${JSON.stringify(padOf(PAD_MONTH).value)}`);
    assert.equal(padOf(PAD_MONTH).value, 'von woanders',
      'a box nobody had typed in held a change out — that is not ink, that is a stale box');

    // 3 · And one keystroke changes the answer, because now there IS ink.
    type(ta2, '!');
    store.state.scratchpads[PAD_MONTH] = 'und noch woanders';
    renderBoard(boardEl());
    diag(`  after one keystroke, the same change → ${JSON.stringify(padOf(PAD_MONTH).value)}`);
    assert.equal(padOf(PAD_MONTH).value, 'von woanders!',
      'a change from elsewhere took the box away from the person typing in it');
  } finally { clearPad(); home(); }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §G7 · THE NEXT LAUNCH
//
// A real quit-and-open is out of tier 2's reach — one file, one launch. What IS reachable is the
// half that decides whether F8 is a deep-session curiosity or an opening state: the pager
// position is persisted, so a user who quits on page +1 OPENS on page +1, and the first gesture
// of launch 2 is already in the state the finding is about. The first render of a fresh process
// is a full one, which is what dropping the cache reproduces; the SECOND render is incremental,
// and that is the one that used to go stale.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§G7 · the paged year is on disk, and the first two renders of the next launch agree', async () => {
  try {
    home();
    $id('pg-next').click();
    await store.persistNow();
    const disk = JSON.parse(await window.__TAURI__.core.invoke('load_board', {}));
    diag(`  board.json says mode=${disk.settings.mode} startMonth=${disk.settings.startMonth} `
      + `pageYears=${disk.settings.pageYears}`);
    assert.equal(disk.settings.pageYears, 1,
      'the pager position is not persisted — then the next launch does not open in this state');

    // Launch 2, render 1: a fresh process has no render cache.
    invalidateBoardCache();
    renderBoard(boardEl());
    const el1 = noteNode(PRIVAT);
    assert.equal(el1.dataset.date, el1.closest('.day').dataset.date,
      'the first render of the next launch draws the repeat with another year’s date');

    const first = `${el1.dataset.date} in ${el1.closest('.day').dataset.date}`;

    // Launch 2, render 2 — incremental, and reached by a real gesture.
    $id('pg-next').click();
    const el2 = noteNode(PRIVAT);
    diag(`  launch 2: render 1 (full) → ${first}, render 2 (incremental) → `
      + `${el2.dataset.date} in ${el2.closest('.day').dataset.date}`);
    assert.equal(el2.dataset.date, el2.closest('.day').dataset.date,
      'the second render of the next launch goes stale again');
    const cmp = agreesWithRebuild();
    if (!cmp.ok) diag('  ' + cmp.why);
    assert.ok(cmp.ok, 'the incremental board of launch 2 is not the board a full rebuild produces');
  } finally { home(); }
});

test('§G8 · none of the gestures above raised an error', () => {
  assert.deepEqual(window.__lzpErrors, [], JSON.stringify(window.__lzpErrors));
});
