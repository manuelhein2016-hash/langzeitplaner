// TIER 2 · E9 — OWNER-ONLY EDITING AT THE HAND (18.1) AND THE CO-EDIT FLAG (18.2).
// LZP-901 · LZP-902 · A7 · ADR 004 §4.3, §8 · decision D7, layer 1.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS SEPARATELY FROM `interaction.dom.js` AND `sharing-control.dom.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `core-authz.test.js` and `coedit.test.js` prove what the FOLD refuses — D7's layer 2, the one
// that actually stops a patched client. This file is layer 1, and layer 1 has a failure mode of
// its own that no pure test can reach: a guard that refuses too LATE.
//
//  §1  THE WEDGE. A foreign entry's `id` IS its entity key (`fbar:mem_…/uuid`), and every commit
//      in `interact.js` routes through `store.apply(<v1 mutation>)`, whose op constructors call
//      `entities.js:barKey(id)` — which THROWS `EntityKeyError` on anything that is not a bare
//      uuid. The throw escapes `onPointerUp` ABOVE the three lines that clear `drag`, remove the
//      ghost and drop `is-dragging` from `<body>`. So the moment a family member ticked
//      „Familie darf bearbeiten", one drag of that bar left the board with a floating ghost and a
//      pointer state machine that would never complete another gesture until reload.
//      §1 drives the real gesture and asserts the board is still alive afterwards.
//
//  §2  REFUSING AT COMMIT TIME IS TOO LATE AND FEELS BROKEN — so the refusal is at PRESS time,
//      and it is narrow: a foreign entry must still SELECT (17.6 — you have to be able to click
//      Mum's holiday to find out whose it is), it simply never becomes a drag.
//
//  §3  THE DOWNGRADE WINDOW. `pub.coEdit` is governing and stage 3c never drops governing
//      fields, so a register map really holds `level: 'belegt'` beside a not-yet-arrived-null
//      `coEdit: true`. Three files used to answer that cell three different ways.
//
//  §4  V1 IS UNTOUCHED. The guard is only worth having if it costs the solo board nothing. The
//      4 px threshold, up-drag normalisation, the inline editor and the auto-unhide flash are
//      re-driven here against MY OWN entries with a family space present.
//
//  §5  THE CLUSTER (A7). One `.pop-share`, the co-edit flag inside it, and the viewer's half of
//      18.2 — in both languages, swept against ADR 002 §7.4's "Never" list.
//
// Every foreign entry here is written straight into `store.state`, which is the shape
// `materialize.js:foreignCandidate` produces — the same technique `family-render.dom.js` uses,
// and for the same reason: no device in this tree can yet RECEIVE one.

const { store } = await importApp('store.js');
const interact = await importApp('interact.js');
const popover = await importApp('popover.js');
const sharing = await importApp('family/sharing.js');
const L = await importApp('layout.js');
const { renderBoard } = await importApp('board.js');
const { setLang, getLang } = await importApp('i18n.js');
const { iso } = await importApp('dates.js');

const boardEl = () => $('#board');
const M0 = renderBoard(boardEl());
const COL = M0.cols[1];
const D = (day) => iso(COL.y, COL.m, day);

const SPACE = 'fsp_0123456789abcdefghijkm';
const MAMA = { id: 'mem_mama0000000000000000000', colorRef: 'magenta', initial: 'M' };

// The one door that turns the v2 projection on. In the product `family/mount.js` makes this
// call; here the test is the door, with the same argument.
store.useFamilySpace(SPACE);
popover.useSharing(sharing);

// ── event helpers — the same ones `interaction.dom.js` characterizes v1 with ──

const at = (node, dx = 4, dy = 3) => {
  const r = node.getBoundingClientRect();
  return { clientX: r.left + dx, clientY: r.top + dy };
};
const ptr = (type, node, pos, target = node) =>
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1, isPrimary: true, ...pos,
  }));
const key = (node, k, opts = {}) =>
  node.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));

function click(node, dx, dy) {
  const pos = at(node, dx, dy);
  ptr('pointerdown', node, pos);
  ptr('pointerup', node, pos, window);
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...pos }));
}

/** press, cross the 4 px threshold, move, release. v1's drag, verbatim. */
function drag(from, to) {
  const a = at(from, 6, 4);
  const b = at(to, 6, 4);
  ptr('pointerdown', from, a);
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: a.clientX, clientY: a.clientY + 10 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, ...b }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, ...b }));
}

const dayNode = (date) => $(`.board .day[data-date="${date}"]`);

/** THE EMITTED OPS. `store._log.lines()` is the log itself — there is no public reader, and
 *  asserting on the ops rather than on the pixels is the rule ADR 004's headline invariant sets
 *  (`sharing-control.dom.js` uses the same two lines, deliberately). */
const opMark = () => store._log.lines().length;
const opsSince = (mark) => store._log.lines().slice(mark).map((l) => l.op);
const noteNode = (id) => $(`.board .note[data-note-id="${CSS.escape(id)}"]`);
const barNode = (id) => $(`.board .bar[data-bar-id="${CSS.escape(id)}"]`);

// ── fixtures ─────────────────────────────────────────────────────────────────

let n = 0;
const uuid = () => `e9${(++n).toString().padStart(6, '0')}-1111-4111-8111-aaaaaaaaaaaa`;

/** SOMEONE ELSE'S note, in `materialize.js:foreignCandidate`'s shape. `id` IS the entity key. */
function foreignNote(day, { level = 'geteilt', coEdit = false, text = 'Bescherung' } = {}) {
  const u = uuid();
  const e = {
    id: `fnote:${MAMA.id}/${u}`, uuid: u, entityKey: `fnote:${MAMA.id}/${u}`,
    date: D(day), text: level === 'geteilt' ? text : null, repeatsYearly: false,
    isForeign: true, ownerId: MAMA.id, level, coEdit,
    redacted: level === 'belegt', memberColorRef: MAMA.colorRef, initial: MAMA.initial,
    exposure: null, isNew: false,
  };
  store.state.notes.push(e);
  return e;
}

/** SOMEONE ELSE'S bar — 18.2's own example, „the family vacation bar both of us drag around". */
function foreignBar(from, to, { level = 'geteilt', coEdit = true, label = 'Sommerferien' } = {}) {
  const u = uuid();
  const e = {
    id: `fbar:${MAMA.id}/${u}`, uuid: u, entityKey: `fbar:${MAMA.id}/${u}`,
    startDate: D(from), endDate: D(to), label: level === 'geteilt' ? label : null,
    isForeign: true, ownerId: MAMA.id, level, coEdit,
    redacted: level === 'belegt', memberColorRef: MAMA.colorRef, initial: MAMA.initial,
    exposure: null, isNew: false,
  };
  store.state.bars.push(e);
  return e;
}

/** ONE OF MINE, through the product's own door, so §4 measures the real path. */
function myNote(day, text = 'Zahnarzt') {
  const id = crypto.randomUUID();
  store.apply('createNoteInline', {
    id, date: D(day), text, categoryId: store.state.categories[0].id, visibility: 'privat',
  });
  return store.state.notes.find((x) => x.id === id);
}
function myBar(from, to) {
  const id = crypto.randomUUID();
  store.apply('createBar', {
    id, startDate: D(from), endDate: D(to), categoryId: store.state.categories[0].id,
    visibility: 'privat',
  });
  return store.state.bars.find((x) => x.id === id);
}

/** Is the pointer state machine still alive? Everything §1 is really about. */
function boardIsAlive() {
  return {
    dragging: document.body.classList.contains('is-dragging'),
    resizing: document.body.classList.contains('is-resizing'),
    creating: document.body.classList.contains('is-creating'),
    ghosts: $$('.drag-ghost').length,
    previews: $$('.bar-preview, .drop-row').length,
  };
}

function reset() {
  popover.closePopover();
  interact.cancelEditor?.();
  interact.clearSelection();
  // Synthetic foreign entries are direct writes to the projection, so they are removed the same
  // way — and `_projected` is re-synced, or the next transaction's `_adopt()` would try to author
  // `note.set` for an entity key that is not a uuid. (`sharing-control.dom.js` §0's rule.)
  store.state.notes = store.state.notes.filter((x) => !x.isForeign);
  store.state.bars = store.state.bars.filter((x) => !x.isForeign);
  store._projected = store._contentClone();
  store._projected.settings = structuredClone(store.state.settings);
  const ns = store.state.notes.map((x) => x.id);
  const bs = store.state.bars.map((x) => x.id);
  if (ns.length || bs.length) {
    store.txn('reset', (tx) => {
      for (const i of ns) tx.note(i).del();
      for (const i of bs) tx.bar(i).del();
    });
  }
  document.body.classList.remove('is-dragging', 'is-resizing', 'is-creating');
  $$('.drag-ghost').forEach((g) => g.remove());
  setLang('de');
  store.emit('reset');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE WEDGE — the defect this ticket found, driven as a real gesture
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1a · dragging a CO-EDITABLE foreign bar leaves the board alive', () => {
  reset();
  const b = foreignBar(6, 12, { level: 'geteilt', coEdit: true });
  store.emit('seed');
  const node = barNode(b.id);
  assert.ok(node, 'precondition: the vacation bar is on my board (17.1)');
  assert.equal(L.canEditEntry(b), true, 'precondition: 18.2 says this one IS co-editable');

  drag(node, dayNode(D(20)));

  const alive = boardIsAlive();
  assert.equal(alive.dragging, false, 'is-dragging survived the gesture — the board is wedged');
  assert.equal(alive.ghosts, 0, 'a drag ghost was left floating over the board');
  assert.equal(alive.previews, 0, 'a range preview was left painted');
  assert.equal(b.startDate, D(6), 'and the bar did not move');
  assert.equal(b.endDate, D(12));
});

test('§1b · …and the NEXT gesture still works, which is what "wedged" really means', () => {
  // The class list and the ghost are symptoms. The disease is that `drag` was never cleared, so
  // `onPointerMove` keeps `preventDefault()`ing and no later press can ever resolve. This row is
  // the one that would have caught it even if the CSS classes had been cleaned up by hand.
  reset();
  // MY entry first, through the real door: `store.apply` runs `_adopt()`, and a synthetic
  // foreign entry already sitting in `state` would make it try to author `note.set` for an
  // entity key that is not a uuid. Real boards never have that ordering problem — the projection
  // builds both at once — but a test that writes to `state` by hand does.
  const mine = myNote(15, 'Zahnarzt');
  const b = foreignBar(6, 12, { level: 'geteilt', coEdit: true });
  store.emit('seed');
  drag(barNode(b.id), dayNode(D(20)));

  drag(noteNode(mine.id), dayNode(D(18)));
  const after = store.state.notes.find((x) => x.id === mine.id);
  assert.equal(after.date, D(18), 'my own note could not be dragged after the refused gesture');
  assert.equal(boardIsAlive().dragging, false);
});

// ── §1c — INVERTED AT THE E9 INTEGRATION, and it is worth saying exactly what changed ────────
//
// This row used to assert that a double-click on a co-editable foreign note opened NO editor,
// with the reason „an editor that could never have committed". That reason was true and it was a
// statement about a MISSING CAPABILITY, not about 18.2: `store.familyLevelOf` answered `null` for
// a foreign key, so `sealOp`'s barrier 4 refused the write and `interact.js` had to refuse the
// gesture before it got there. 18.2 was a permission nobody could exercise.
//
// The capability landed (`store.applyCoEdit` → `core/project.js:coEditOp`, level re-derived from
// the authenticated fold by `store.familyCoEditLevelOf`), so the editor SHOULD open now — that is
// what „Familie darf bearbeiten" means. What must not change is §1's actual subject: the board
// stays alive either way.
//
// THE ROW NOW PINS THE DOOR, NOT THE FIXTURE. These are synthetic foreign entries written
// straight into the projection, so they have no folded `pub.*` registers and `applyCoEdit`
// truthfully answers `false` — asserting „the note did not move" here would be a test of the
// fixture's emptiness. So it asserts what `interact.js` actually decides: which door the gesture
// chose, and with which fields. `conflict.dom.js` drives the end-to-end write against a real
// two-member circle.
test('§1c · a co-editable foreign NOTE reaches the CO-EDIT door, and the board stays alive', () => {
  reset();
  const f = foreignNote(8, { level: 'geteilt', coEdit: true, text: 'Bescherung' });
  store.emit('seed');
  const node = noteNode(f.id);
  assert.ok(node, 'precondition: it is on the board');

  const calls = [];
  const real = store.applyCoEdit;
  store.applyCoEdit = (key, changes) => { calls.push({ key, changes }); return real.call(store, key, changes); };
  try {
    drag(node, dayNode(D(22)));
    assert.equal(boardIsAlive().dragging, false, 'is-dragging survived — the board is wedged');
    assert.equal(boardIsAlive().ghosts, 0, 'a drag ghost was left floating');
    assert.equal(calls.length, 1, 'the drag did not route to the co-edit door');
    assert.equal(calls[0].key, f.id, 'the door was handed the ENTITY KEY, which a foreign id is');
    assert.deepEqual(calls[0].changes, { 'pub.date': D(22) },
      'a move writes pub.date and nothing else — no governing field, no category');

    node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, ...at(node) }));
    assert.ok($('.board .inline-edit'), '18.2: „Familie darf bearbeiten" must open the editor');
  } finally {
    store.applyCoEdit = real;
    interact.cancelEditor?.();
  }
  // And the projection is untouched, because this fixture grants nothing: the door answered
  // `false` from the authenticated fold, which is the SAFE answer and not a silent write.
  assert.equal(f.text, 'Bescherung');
  assert.equal(f.date, D(8));
});

test('§1c-b · a foreign entry that is NOT co-editable never reaches that door at all', () => {
  // The non-vacuity twin of §1c: the door is chosen by `isForeign`, but whether it WRITES is the
  // authenticated fold's answer. Without this row, a `commitEntry` that routed every foreign
  // gesture to `applyCoEdit` unconditionally would look identical above.
  reset();
  const f = foreignNote(8, { level: 'belegt', coEdit: false, text: 'Belegt' });
  store.emit('seed');
  const calls = [];
  const real = store.applyCoEdit;
  store.applyCoEdit = (key, changes) => { calls.push({ key, changes }); return false; };
  try {
    drag(noteNode(f.id), dayNode(D(22)));
    assert.equal(calls.length, 0, '18.1: a gesture that may not start cannot reach any door');
    assert.equal(boardIsAlive().dragging, false);
  } finally { store.applyCoEdit = real; }
});

test('§1d · ⌫ on a selected foreign entry writes nothing and throws nothing', () => {
  // 18.1's second verb. `pub.alive` is a governing register, so deletion is the owner's even
  // where editing is shared — and `deleteSelected` would have thrown on the same key.
  reset();
  const f = foreignNote(9, { level: 'geteilt', coEdit: true });
  store.emit('seed');
  click(noteNode(f.id));
  assert.equal(interact.selection.id, f.id, 'precondition: it selected (17.6)');
  const before = store.undoStack.length;
  assert.equal(interact.deleteSelected(), false, 'the keystroke declines, v1-style');
  assert.equal(store.state.notes.includes(f), true, 'and the entry is still there');
  assert.equal(store.undoStack.length, before, 'nothing reached the undo stack');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE REFUSAL IS AT PRESS TIME, AND IT IS NARROW
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2a · a foreign entry that is NOT co-editable never drags — 18.1 by default', () => {
  reset();
  const f = foreignNote(10, { level: 'geteilt', coEdit: false });
  store.emit('seed');
  drag(noteNode(f.id), dayNode(D(24)));
  assert.equal(f.date, D(10), "someone else's plan was rewritten behind their back");
  assert.equal(boardIsAlive().dragging, false);
});

test('§2b · but it still SELECTS on release — 17.6 needs the click', () => {
  // The guard rides on the PENDING press, not on the branch that creates it, precisely so this
  // stays true. An entry you cannot click is an entry whose owner you cannot look up.
  reset();
  const f = foreignNote(11, { level: 'geteilt', coEdit: false });
  store.emit('seed');
  click(noteNode(f.id));
  assert.equal(interact.selection.type, 'note');
  assert.equal(interact.selection.id, f.id, 'a foreign entry must be selectable');
  assert.ok(noteNode(f.id).classList.contains('selected'));
});

test('§2c · a foreign bar carries no resize grips, and a press where one would be does not resize', () => {
  reset();
  const b = foreignBar(5, 9, { level: 'geteilt', coEdit: false });
  store.emit('seed');
  const node = barNode(b.id);
  assert.equal(node.querySelectorAll('.bar-handle').length, 0,
    'board.js withheld the grips — layout.js said readonly');
  assert.ok(node.classList.contains('readonly'));
  drag(node, dayNode(D(16)));
  assert.equal(b.startDate, D(5));
  assert.equal(b.endDate, D(9));
});

test('§2d · the popover offers no editor and no delete on a foreign entry', () => {
  reset();
  myNote(12, 'meins');                       // mine first — see §1b
  const f = foreignNote(12, { level: 'geteilt', coEdit: true });
  store.emit('seed');
  const more = $(`.board .day[data-date="${D(12)}"] .d-more`) || dayNode(D(12));
  popover.openDayPopover(more, D(12), { onChange: () => {} });
  const row = $(`.pop-row[data-entry="${CSS.escape(f.id)}"]`);
  assert.ok(row, 'the foreign entry is listed in the popover');
  assert.equal(row.querySelector('.txt[contenteditable], input.txt'), null,
    'no inline editor on somebody else\'s entry');
  const dels = [...row.querySelectorAll('button')].filter((x) => /löschen|delete|✕|×/i.test(x.title + x.textContent));
  assert.equal(dels.length, 0, 'no delete affordance either — 18.1\'s second verb');
  popover.closePopover();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · THE DOWNGRADE WINDOW — `level: 'belegt'` beside a stale `coEdit: true`
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3a · a Belegt block with a stale co-edit flag is not editable anywhere', () => {
  // `pub.coEdit` is governing; `authz.js` stage 3c never drops governing fields; there is no
  // causal delivery. So this register map is reachable between two pulls, and it is the ONE
  // shape where the content is deliberately not mine to read — let alone to write.
  reset();
  const b = foreignBar(4, 8, { level: 'belegt', coEdit: true });
  store.emit('seed');
  const node = barNode(b.id);
  assert.equal(L.canEditEntry(b), false, 'layout.js — the board\'s pixels');
  assert.equal(interact.canEdit(b), false, 'interact.js — the pointer state machine');
  assert.equal(sharing.canEditEntry(b), false, 'family/sharing.js — the popover');
  assert.ok(node.classList.contains('readonly'));
  drag(node, dayNode(D(18)));
  assert.equal(b.startDate, D(4), 'the Belegt block moved');
  assert.equal(boardIsAlive().dragging, false);
});

test('§3b · and a Geteilt one with the flag really is editable — the gate is not "foreign"', () => {
  // The mirror. Without this row §3a would pass just as well if the guard simply refused
  // everything foreign, which is 18.2 deleted rather than implemented.
  reset();
  const b = foreignBar(4, 8, { level: 'geteilt', coEdit: true });
  store.emit('seed');
  assert.equal(L.canEditEntry(b), true);
  assert.equal(interact.canEdit(b), true);
  assert.equal(sharing.canEditEntry(b), true);
  assert.equal(barNode(b.id).classList.contains('readonly'), false,
    'the invited bar is painted as editable');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · V1 IS UNTOUCHED — with a Familienkreis present, which is the hard case
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4a · my own note still drags, and the 4 px threshold still holds', () => {
  reset();
  const mine = myNote(7, 'Zahnarzt');
  store.emit('seed');

  // under the threshold: a press that moved 3 px is a click, not a drag (5.5)
  const node = noteNode(mine.id);
  const p = at(node, 6, 4);
  ptr('pointerdown', node, p);
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: p.clientX + 2, clientY: p.clientY + 2 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, clientX: p.clientX + 2, clientY: p.clientY + 2 }));
  assert.equal(store.state.notes.find((x) => x.id === mine.id).date, D(7), 'a 3 px wobble moved it');
  assert.equal(interact.selection.id, mine.id, 'it selected instead — v1');

  drag(noteNode(mine.id), dayNode(D(19)));
  assert.equal(store.state.notes.find((x) => x.id === mine.id).date, D(19));
});

test('§4b · my own bar still resizes from its grips, and up-drag still normalises', () => {
  reset();
  const b = myBar(10, 14);
  store.emit('seed');
  const node = barNode(b.id);
  const grip = node.querySelector('.bar-handle.top');
  assert.ok(grip, 'my own bar keeps its grips');
  drag(grip, dayNode(D(6)));
  const after = store.state.bars.find((x) => x.id === b.id);
  assert.equal(after.startDate, D(6), 'the start edge did not follow the pointer');
  assert.equal(after.endDate, D(14));

  // 3.5 — dragging the start edge PAST the end clamps rather than inverting
  drag(barNode(after.id).querySelector('.bar-handle.top'), dayNode(D(20)));
  const after2 = store.state.bars.find((x) => x.id === b.id);
  assert.ok(after2.startDate <= after2.endDate, 'a bar inverted');
});

test('§4c · my own entry still inline-edits, and the editor still commits', () => {
  reset();
  const mine = myNote(13, 'Zahnarzt');
  store.emit('seed');
  const node = noteNode(mine.id);
  node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, ...at(node) }));
  const inp = $('.board .inline-edit');
  assert.ok(inp, 'no editor on my own note');
  inp.value = 'Zahnarzt 14:30';
  key(inp, 'Enter');
  assert.equal(store.state.notes.find((x) => x.id === mine.id).text, 'Zahnarzt 14:30');
});

test('§4d · press-and-drag on an empty day still lays down a bar (3.1)', () => {
  reset();
  const before = store.state.bars.length;
  drag(dayNode(D(3)), dayNode(D(9)));
  assert.equal(store.state.bars.length, before + 1, 'the create-bar gesture stopped working');
  const made = store.state.bars[store.state.bars.length - 1];
  assert.equal(made.startDate, D(3));
  assert.equal(made.endDate, D(9));
  interact.cancelEditor?.();
});

test('§4e · a foreign entry on the SAME day does not disturb any of that', () => {
  // The realistic board: mine and Mama's in one day row. A guard that keyed on the row rather
  // than on the entry would show up here and nowhere else.
  reset();
  const mine = myNote(17, 'meins');           // mine first — see §1b
  const f = foreignNote(17, { level: 'geteilt', coEdit: false });
  store.emit('seed');
  drag(noteNode(mine.id), dayNode(D(23)));
  assert.equal(store.state.notes.find((x) => x.id === mine.id).date, D(23), 'mine still moves');
  assert.equal(f.date, D(17), 'hers still does not');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · THE CLUSTER (A7) — one sharing cluster, extended, not a second one
// ═════════════════════════════════════════════════════════════════════════════════════════════

const openClusterFor = (entry, kind, date) => {
  const anchor = $(`.board .day[data-date="${date}"] .d-more`) || dayNode(date);
  popover.openDayPopover(anchor, date, { onChange: () => {} });
  const row = $(`.pop-row[data-entry="${CSS.escape(entry.id)}"]`);
  assert.ok(row, `no popover row for ${kind} ${entry.id}`);
  const trig = row.querySelector('.share-trig');
  assert.ok(trig, 'the sharing trigger is missing from the row');
  trig.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return $('.pop-share');
};

test('§5a · the co-edit flag lives INSIDE the visibility strip — one cluster, not two', () => {
  reset();
  const mine = myNote(14, 'Bescherung');
  store.txn('seed-level', (tx) => { tx.note(mine.id).set({ visibility: 'geteilt' }); });
  store.emit('seed');
  const strip = openClusterFor(store.state.notes.find((x) => x.id === mine.id), 'note', D(14));
  assert.ok(strip, 'no sharing strip');
  assert.equal($$('.pop-share').length, 1, 'A7: ONE cluster');
  assert.ok(strip.querySelector('.share-seg[role="radiogroup"]'), 'the three-state control');
  const cb = strip.querySelector('.share-coedit input[type="checkbox"]');
  assert.ok(cb, 'the co-edit flag is not in the cluster');
  assert.equal(cb.disabled, false, 'at Geteilt it is live');
  assert.includes(strip.querySelector('.share-coedit').textContent, 'Familie darf bearbeiten');
  popover.closePopover();
});

test('§5b · ticking it writes ONLY the truth register — no pub.* field is built in the UI', () => {
  reset();
  const mine = myNote(14, 'Bescherung');
  store.txn('seed-level', (tx) => { tx.note(mine.id).set({ visibility: 'geteilt' }); });
  store.emit('seed');
  const undoBefore = store.undoStack.length;
  const strip = openClusterFor(store.state.notes.find((x) => x.id === mine.id), 'note', D(14));
  const mark = opMark();
  strip.querySelector('.share-coedit input').click();

  const live = store.state.notes.find((x) => x.id === mine.id);
  assert.equal(live.coEdit, true, '18.2 — the grant landed');
  assert.equal(store.undoStack.length, undoBefore + 1, 'one transaction, therefore one ⌘Z (18.4)');

  const ops = opsSince(mark);
  assert.ok(ops.length > 0, 'the click emitted nothing at all');

  // THE UI'S OWN WRITE: one `note.set`, carrying nothing but the flag. Not the level, not the
  // text, not the category — and above all no `pub.*` field of any kind.
  const truth = ops.filter((op) => op.k === 'note.set');
  assert.equal(truth.length, 1, 'exactly one truth write');
  assert.deepEqual(Object.keys(truth[0].f), ['coEdit'], 'and it writes nothing but the flag');
  for (const f of Object.keys(truth[0].f)) {
    assert.equal(f.startsWith('pub.'), false, `the UI constructed a pub.* field: ${f}`);
  }

  // THE PUBLICATION rides along in the same transaction — it must, or ⌘Z would revert the truth
  // and leave the family holding the old one (ADR 004 §5, story 18.4). What this row pins is
  // WHERE it came from: `store._publishAndEnqueue` → `core/project.js:projectForFamily`, the
  // single choke point of ADR 004 §2, whose output carries a non-enumerable brand that
  // `crypto/envelope.js:sealOp` refuses to seal without. A `pub.set` assembled anywhere else —
  // by this cluster, say — would be unbranded and therefore unsealable, and the test for "the UI
  // did not build it" is exactly that the brand is present.
  const pubs = ops.filter((op) => op.k === 'pub.set');
  assert.equal(pubs.length, 1, 'the co-edit grant is published once');
  assert.equal(pubs[0].space, SPACE, 'into the family space');
  assert.equal(pubs[0].gid, truth[0].gid, 'in the SAME undo group — one ⌘Z (18.4)');
  assert.equal(pubs[0].f['pub.coEdit'], true, 'and it carries the flag the owner just granted');
  assert.ok(Object.getOwnPropertySymbols(pubs[0].f).includes(Symbol.for('lzp/v2/family-patch')),
    'the published patch is UNBRANDED — it was not built by projectForFamily (ADR 004 §2.2 '
    + 'barrier 3), which means some other path in the product is assembling pub.* fields');
  popover.closePopover();
});

test('§5c · below Geteilt the flag is inert AND refused, so a caller past the DOM still fails', () => {
  reset();
  const mine = myNote(14, 'Zahnarzt');           // privat by default (16.1)
  store.emit('seed');
  const strip = openClusterFor(store.state.notes.find((x) => x.id === mine.id), 'note', D(14));
  const cb = strip.querySelector('.share-coedit input');
  assert.equal(cb.disabled, true, 'ADR 004 §8 — the flag exists only at Geteilt');
  assert.includes(strip.querySelector('.share-coedit').textContent, 'Nur bei');
  // and the model refuses it too (ADR 004 §8, belt and braces)
  assert.equal(sharing.planCoEditChange(store.state.notes.find((x) => x.id === mine.id), true), null);
  popover.closePopover();
});

test('§5d · leaving Geteilt clears the grant in the same click — no silent re-grant', () => {
  reset();
  const mine = myNote(14, 'Bescherung');
  store.txn('seed', (tx) => { tx.note(mine.id).set({ visibility: 'geteilt', coEdit: true }); });
  store.emit('seed');
  const strip = openClusterFor(store.state.notes.find((x) => x.id === mine.id), 'note', D(14));
  [...strip.querySelectorAll('.share-opt')].find((b) => b.dataset.level === 'belegt').click();
  const live = store.state.notes.find((x) => x.id === mine.id);
  assert.equal(live.visibility, 'belegt');
  assert.equal(live.coEdit, false,
    'Geteilt → Belegt → Geteilt would otherwise hand the family write access nobody re-granted');
  popover.closePopover();
});

test('§5e · 18.2\'s viewer half appears on exactly the invited entries, and nowhere else', () => {
  reset();
  const invited = foreignNote(14, { level: 'geteilt', coEdit: true });
  const plain = foreignNote(14, { level: 'geteilt', coEdit: false });
  const stale = foreignNote(14, { level: 'belegt', coEdit: true });   // the downgrade window
  store.emit('seed');

  const lineOf = (e) => {
    const strip = openClusterFor(e, 'note', D(14));
    const el = strip.querySelector('.share-coedit-on');
    const txt = el ? el.textContent : null;
    popover.closePopover();
    return txt;
  };
  assert.match(lineOf(invited), /^Familie darf bearbeiten —/,
    'the member the owner invited has no other way to learn the invitation exists');
  assert.equal(lineOf(plain), null, 'and it is silent everywhere else (18.2)');
  assert.equal(lineOf(stale), null, 'including in the downgrade window');
});

test('§5f · the foreign cluster still has no control at all — the level is not mine to set', () => {
  reset();
  const invited = foreignNote(14, { level: 'geteilt', coEdit: true });
  store.emit('seed');
  const strip = openClusterFor(invited, 'note', D(14));
  assert.equal(strip.querySelector('.share-seg'), null, 'a foreign entry has no radiogroup');
  assert.equal(strip.querySelector('.share-coedit input'), null, 'and no checkbox to click at');
  assert.includes(strip.querySelector('.share-foreign').textContent, 'Die Sichtbarkeit bestimmt');
  popover.closePopover();
});

test('§5g · both languages, and neither line claims anything the crypto cannot keep', () => {
  reset();
  const invited = foreignNote(14, { level: 'geteilt', coEdit: true });
  store.emit('seed');
  for (const lang of ['de', 'en']) {
    setLang(lang);
    const strip = openClusterFor(invited, 'note', D(14));
    const line = strip.querySelector('.share-coedit-on').textContent;
    assert.ok(line.length > 0, `no viewer line in ${lang}`);
    assert.includes(line, lang === 'de' ? 'Familie darf bearbeiten' : 'Family can edit');
    for (const claim of sharing.FORBIDDEN_CLAIMS) {
      assert.equal(line.toLowerCase().includes(claim.toLowerCase()), false,
        `ADR 002 §7.4 forbids "${claim}" and ${lang} says it`);
    }
    popover.closePopover();
  }
  setLang('de');
  assert.equal(getLang(), 'de');
});

test('§5h · every string this cluster can render is swept in both languages', () => {
  // `sharing-control.dom.js` §5 sweeps the table as it stood at E7. Two strings were added by
  // E9 and a sweep that only covers what was on screen when it was written is not a sweep.
  let checked = 0;
  for (const [k, pair] of Object.entries(sharing.TXT)) {
    for (const lang of ['de', 'en']) {
      const s = pair[lang];
      assert.equal(typeof s, 'string', `TXT.${k}.${lang} is missing`);
      assert.ok(s.length > 0, `TXT.${k}.${lang} is empty`);
      for (const claim of sharing.FORBIDDEN_CLAIMS) {
        assert.equal(s.toLowerCase().includes(claim.toLowerCase()), false,
          `TXT.${k}.${lang} makes the forbidden claim "${claim}"`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 34, `only swept ${checked} strings — the table shrank`);
  assert.ok(Object.hasOwn(sharing.TXT, 'coEditForeign'), '18.2\'s viewer line is gone');
  reset();
});
