// TIER 2 · WP-3 ADVERSARY PROBE, round 2 — the day popover (the five hand-built
// `tx` sites nothing automated reaches), persistence shape after real gestures,
// replaceAll/restore through the store's own doors, and the sharp undo orders.

const { store } = await importApp('store.js');
const interact = await importApp('interact.js');
const popover = await importApp('popover.js');

const at = (node, dx = 4, dy = 3) => {
  const r = node.getBoundingClientRect();
  return { clientX: r.left + dx, clientY: r.top + dy };
};
const ptr = (type, node, pos, target = node) =>
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1, isPrimary: true, ...pos,
  }));
const key = (node, k, opts = {}) => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  node.dispatchEvent(ev);
  return ev;
};
function click(node, dx, dy) {
  const pos = at(node, dx, dy);
  ptr('pointerdown', node, pos);
  ptr('pointerup', node, pos, window);
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...pos }));
}
const dayNode = (date) => $(`.board .day[data-date="${date}"]`);
const someDate = (c, r) => $$('.board .col')[c].querySelectorAll('.day[data-date]')[r].dataset.date;
const depth = () => store.undoStack.length;
const pop = () => $('.popover');

function reset() {
  popover.closePopover();
  store.state.notes = [];
  store.state.bars = [];
  store.state.scratchpads = {};
  store.undoStack.length = 0;
  store.redoStack.length = 0;
  interact.clearSelection();
  store.emit('reset');
}

/** Open the popover the way a user does: right-click the day cell. */
function openPop(date) {
  const d = dayNode(date);
  d.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...at(d) }));
  return pop();
}

function makeNote(date, text) {
  click(dayNode(date));
  const inp = $('.board .inline-edit');
  inp.value = text;
  key(inp, 'Enter');
  return store.state.notes.at(-1);
}

// ── Q1 · popover "+ Notiz" ───────────────────────────────────────────────────

test('Q1 popover add-note: one step, and lastCategoryId is NOT written', () => {
  reset();
  const date = someDate(1, 6);
  // move lastCategoryId to cat[2] first so a stray write would show
  store.setSettings({ lastCategoryId: store.state.categories[2].id });
  const lastBefore = store.state.settings.lastCategoryId;
  assert.ok(openPop(date), 'right-click did not open the popover');
  $('.popover .pop-add').click();
  const inp = $('.popover .pop-new .txt');
  assert.ok(inp, 'no new-note input');
  inp.value = 'Popover-Notiz';
  key(inp, 'Enter');
  const n = store.state.notes.at(-1);
  diag('popover add: notes =', store.state.notes.length, 'steps =', depth(),
    'text =', n && n.text, 'cat =', n && n.categoryId === lastBefore,
    'repeatsYearly =', n && n.repeatsYearly,
    'lastCategoryId moved =', store.state.settings.lastCategoryId !== lastBefore);
  assert.equal(store.state.notes.length, 1);
  assert.equal(depth(), 1, 'popover add-note must be exactly one undo step');
  assert.equal(store.state.settings.lastCategoryId, lastBefore,
    'v1 only READS lastCategoryId here — it must not move');
  diag('note keys =', Object.keys(n).join(','));
  store.undo();
  diag('after undo: notes =', store.state.notes.length);
  popover.closePopover();
  store.setSettings({ lastCategoryId: store.state.categories[0].id });
});

test('Q1b popover add-note into a HIDDEN category unhides in the same step (4.6)', () => {
  reset();
  const cat = store.state.categories[1];
  store.mutate('hide', (s) => { s.categories.find((c) => c.id === cat.id).visible = false; });
  store.setSettings({ lastCategoryId: cat.id });
  store.undoStack.length = 0;
  const date = someDate(1, 7);
  openPop(date);
  $('.popover .pop-add').click();
  const inp = $('.popover .pop-new .txt');
  inp.value = 'Unhide';
  key(inp, 'Enter');
  const vis = () => store.state.categories.find((c) => c.id === cat.id).visible;
  diag('after popover create in hidden cat: visible =', vis(), 'steps =', depth());
  assert.equal(vis(), true);
  assert.equal(depth(), 1, 'the unhide must ride in the SAME undo step');
  store.undo();
  diag('after undo: visible =', vis(), 'notes =', store.state.notes.length,
    '(v1: hidden again AND the note gone, one ⌘Z)');
  assert.equal(store.state.notes.length, 0);
  assert.equal(vis(), false, 'the unhide was not part of the undone group');
  popover.closePopover();
  store.setSettings({ lastCategoryId: store.state.categories[0].id });
  reset();
});

// ── Q2 · popover recategorise ────────────────────────────────────────────────

test('Q2 popover recategorise a note: one step, lastCategoryId DOES move (v1)', () => {
  reset();
  const date = someDate(2, 6);
  const n = makeNote(date, 'Recat');
  const from = n.categoryId;
  const to = store.state.categories.find((c) => c.id !== from).id;
  store.undoStack.length = 0;
  openPop(date);
  $('.popover .pop-row .dot').click();       // opens the swatch strip
  const strip = $('.popover .pop-cat');
  assert.ok(strip, 'no swatch strip');
  const idx = store.state.categories.findIndex((c) => c.id === to);
  $$('.popover .pop-cat .sw')[idx].click();
  const after = store.state.notes.find((x) => x.id === n.id);
  diag('recategorise: cat', from, '->', after.categoryId, 'wanted', to,
    'steps =', depth(), 'lastCategoryId =', store.state.settings.lastCategoryId === to);
  assert.equal(after.categoryId, to);
  assert.equal(depth(), 1);
  assert.equal(store.state.settings.lastCategoryId, to, '4.2 — v1 wrote it inside the mutation');
  store.undo();
  diag('after undo: cat =', store.state.notes.find((x) => x.id === n.id).categoryId,
    'lastCategoryId =', store.state.settings.lastCategoryId,
    '(v1: cat back, lastCategoryId STAYS — settings are not in CONTENT_KEYS)');
  popover.closePopover();
  store.setSettings({ lastCategoryId: store.state.categories[0].id });
});

test('Q2b popover recategorise to the SAME category declines (no undo step)', () => {
  reset();
  const date = someDate(2, 7);
  const n = makeNote(date, 'Same');
  store.undoStack.length = 0;
  openPop(date);
  $('.popover .pop-row .dot').click();
  const idx = store.state.categories.findIndex((c) => c.id === n.categoryId);
  $$('.popover .pop-cat .sw')[idx].click();
  diag('recategorise to same: steps =', depth(), '(v1 declined -> 0)');
  assert.equal(depth(), 0);
  popover.closePopover();
});

// ── Q3 · toggle-repeat, both directions, and undo ────────────────────────────

test('Q3 toggle-repeat ON anchors the series; OFF leaves date alone; undo restores', () => {
  reset();
  const date = someDate(3, 9);
  const n = makeNote(date, 'Geburtstag');
  store.undoStack.length = 0;
  openPop(date);
  $('.popover .pop-row .act').click();                 // the ↻ button is the first .act
  let x = store.state.notes.find((y) => y.id === n.id);
  diag('after ON: repeats =', x.repeatsYearly, 'date =', x.date, 'steps =', depth());
  assert.equal(x.repeatsYearly, true);
  assert.equal(x.date, date, '9.5 — anchored to the occurrence the user looked at');

  // now OFF
  openPop(date);
  $('.popover .pop-row .act').click();
  x = store.state.notes.find((y) => y.id === n.id);
  diag('after OFF: repeats =', x.repeatsYearly, 'date =', x.date, 'steps =', depth());
  assert.equal(x.repeatsYearly, false);
  assert.equal(x.date, date, 'the OFF direction must not move the date');

  store.undo();
  x = store.state.notes.find((y) => y.id === n.id);
  diag('undo OFF: repeats =', x.repeatsYearly, 'date =', x.date);
  assert.equal(x.repeatsYearly, true);
  store.undo();
  x = store.state.notes.find((y) => y.id === n.id);
  diag('undo ON: repeats =', x.repeatsYearly, 'date =', x.date, '(v1: false /', date, ')');
  assert.equal(x.repeatsYearly, false);
  assert.equal(x.date, date);
  popover.closePopover();
});

test('Q3b toggle-repeat OFF on a note projected into a FUTURE year', () => {
  reset();
  // anchor in the first visible column, project it into the same month next year
  const anchor = someDate(0, 9);
  const id = 'q3-rep';
  store.mutate('seed', (s) => {
    s.notes.push({ id, date: anchor, text: 'Jahrestag', categoryId: s.categories[0].id, repeatsYearly: true });
  });
  store.undoStack.length = 0;
  // find the projected occurrence 12 columns later — the last column is anchor's month +11
  const proj = $$(`.board .note[data-note-id="${id}"]`);
  diag('rendered occurrences of the yearly note =', proj.length);
  const lastOcc = proj.at(-1);
  const occDate = lastOcc.closest('.day').dataset.date;
  diag('last occurrence renders on', occDate, 'anchor is', anchor);
  openPop(occDate);
  const row = $('.popover .pop-row');
  assert.ok(row, 'the popover on the projected day does not list the note (v1 did)');
  $('.popover .pop-row .act').click();
  const x = store.state.notes.find((y) => y.id === id);
  diag('after OFF at the projection: repeats =', x.repeatsYearly, 'date =', x.date,
    '(v1: false, date stays', anchor + ')');
  assert.equal(x.repeatsYearly, false);
  assert.equal(x.date, anchor);
  popover.closePopover();
});

// ── Q4 · popover delete and empty-edit-is-delete ─────────────────────────────

test('Q4 popover ✕ deletes; undo brings it back with the same id and position', () => {
  reset();
  const d0 = someDate(4, 4);
  const a = makeNote(d0, 'A');
  const b = makeNote(someDate(4, 5), 'B');
  const c = makeNote(d0, 'C');
  const orderBefore = store.state.notes.map((x) => x.text).join(',');
  store.undoStack.length = 0;
  openPop(d0);
  const rows = $$('.popover .pop-row');
  diag('rows on the shared day =', rows.length, 'texts =', rows.map((r) => r.querySelector('.txt').textContent).join('|'));
  // delete the FIRST row's note (A)
  rows[0].querySelectorAll('.act')[1].click();      // .act[0] is ↻, .act[1] is ✕
  diag('after ✕: notes =', store.state.notes.length, 'steps =', depth(),
    'order =', store.state.notes.map((x) => x.text).join(','));
  assert.equal(store.state.notes.length, 2);
  assert.equal(depth(), 1);
  store.undo();
  diag('after undo: order =', store.state.notes.map((x) => x.text).join(','), 'wanted', orderBefore);
  assert.equal(store.state.notes.map((x) => x.text).join(','), orderBefore,
    'undo of a popover delete must restore the array position too (v1 restored the array)');
  assert.equal(store.state.notes.find((x) => x.id === a.id).text, 'A');
  popover.closePopover();
});

test('Q4b popover edit to empty deletes the note (2.2), undo restores text', () => {
  reset();
  const d = someDate(5, 4);
  const n = makeNote(d, 'Wegdamit');
  store.undoStack.length = 0;
  openPop(d);
  $('.popover .pop-row .txt').click();
  const inp = $('.popover .pop-row input.txt');
  assert.ok(inp, 'clicking the text did not open an editor');
  inp.value = '   ';
  key(inp, 'Enter');
  diag('after emptying: notes =', store.state.notes.length, 'steps =', depth());
  assert.equal(store.state.notes.length, 0);
  store.undo();
  const back = store.state.notes.find((x) => x.id === n.id);
  diag('after undo: text =', back && back.text, 'date =', back && back.date,
    'cat =', back && back.categoryId, 'repeats =', back && back.repeatsYearly);
  assert.equal(back.text, 'Wegdamit');
  popover.closePopover();
});

test('Q4c popover edit with NO change declines', () => {
  reset();
  const d = someDate(5, 6);
  makeNote(d, 'Unverändert');
  store.undoStack.length = 0;
  openPop(d);
  $('.popover .pop-row .txt').click();
  key($('.popover .pop-row input.txt'), 'Enter');
  diag('no-change popover edit: steps =', depth(), '(v1 declined -> 0)');
  assert.equal(depth(), 0);
  popover.closePopover();
});

test('Q4d popover Escape during an edit abandons it', () => {
  reset();
  const d = someDate(5, 8);
  makeNote(d, 'Original');
  store.undoStack.length = 0;
  openPop(d);
  $('.popover .pop-row .txt').click();
  const inp = $('.popover .pop-row input.txt');
  inp.value = 'Geändert';
  key(inp, 'Escape');
  diag('after Escape: text =', store.state.notes[0].text, 'steps =', depth());
  assert.equal(store.state.notes[0].text, 'Original');
  assert.equal(depth(), 0);
  popover.closePopover();
});

// ── Q5 · what the popover shows vs what the board shows (2.4) ────────────────

test('Q5 the "+n" chip count and the popover stack agree', () => {
  reset();
  const d = someDate(6, 10);
  for (let i = 0; i < 5; i++) makeNote(d, 'S' + i);
  const more = $(`.day[data-date="${d}"] .d-more`);
  diag('chip =', more && more.textContent, 'notes on the day =',
    store.state.notes.filter((n) => n.date === d).length,
    'notes drawn in the cell =', $$(`.day[data-date="${d}"] .note`).length);
  openPop(d);
  const rows = $$('.popover .pop-row');
  diag('popover rows =', rows.length, 'texts =', rows.map((r) => r.querySelector('.txt').textContent).join('|'));
  assert.equal(rows.length, 5, 'the popover must list every note on the day');
  popover.closePopover();
});

// ── Q6 · what lands on disk after a session of real gestures (11.4) ──────────

test('Q6 board.json after real gestures is byte-identical to store.state, v1 keys only', async () => {
  reset();
  makeNote(someDate(7, 3), 'Disk1');
  makeNote(someDate(7, 4), 'Disk2');
  const ta = $('.board .pad textarea');
  ta.focus(); ta.value = 'Pad'; ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  await store.persistNow();
  const raw = await window.__TAURI__.core.invoke('load_board', {});
  const onDisk = JSON.parse(raw);
  diag('top-level keys =', Object.keys(onDisk).join(','));
  diag('note keys =', Object.keys(onDisk.notes[0]).join(','));
  diag('cat keys =', Object.keys(onDisk.categories[0]).join(','));
  diag('schemaVersion =', onDisk.schemaVersion, 'scratchpads =', JSON.stringify(onDisk.scratchpads));
  diag('settings keys =', Object.keys(onDisk.settings).join(','));
  const v2leak = JSON.stringify(onDisk).match(/_born|_alive|ownerId|updatedBy|createdAt|updatedAt|visibility|coEdit|defaultVisibility/g);
  diag('v2 leakage =', v2leak ? [...new Set(v2leak)].join(',') : 'none');
  assert.equal(v2leak, null, 'v2 fields leaked into board.json');
  assert.equal(raw, JSON.stringify(store.state, null, 2),
    '11.4 — board.json must be exactly store.state');
  assert.deepEqual(Object.keys(onDisk.notes[0]).sort(),
    ['categoryId', 'date', 'id', 'repeatsYearly', 'text'].sort());
});

// ── Q7 · replaceAll / restore through the store's own doors ──────────────────

test('Q7 export -> edit -> replaceAll(export) restores the board and clears history', () => {
  reset();
  const n1 = makeNote(someDate(8, 3), 'Vorher');
  const snapshot = store.exportJSON();
  makeNote(someDate(8, 4), 'Nachher');
  diag('before replaceAll: notes =', store.state.notes.length, 'undo =', depth(), 'redo =', store.redoStack.length);
  store.undo();
  diag('one undo pending redo =', store.redoStack.length);
  store.replaceAll(JSON.parse(snapshot));
  diag('after replaceAll: notes =', store.state.notes.map((n) => n.text).join(','),
    'undo =', depth(), 'redo =', store.redoStack.length);
  assert.equal(depth(), 0, 'import clears the undo history (5.4)');
  assert.equal(store.redoStack.length, 0, 'import clears the redo branch too');
  assert.equal(store.state.notes.length, 1);
  assert.equal(store.state.notes[0].text, 'Vorher');
  assert.equal(store.state.notes[0].id, n1.id, 'the same entry, not a fresh one');
});

test('Q7b replaceAll is idempotent over its own export', () => {
  reset();
  makeNote(someDate(9, 3), 'Idem');
  const a = store.exportJSON();
  store.replaceAll(JSON.parse(a));
  const b = store.exportJSON();
  store.replaceAll(JSON.parse(b));
  const c = store.exportJSON();
  diag('a===b', a === b, 'b===c', b === c);
  assert.equal(b, c, 'export -> import -> export is not a fixed point');
});

test('Q7c a snapshot restore round-trips through the real snapshot ring (11.5)', async () => {
  reset();
  makeNote(someDate(10, 3), 'Gestern');
  await store.persistNow();
  // force a fresh snapshot day so rollSnapshot stores the CURRENT persisted board
  store._lastSnapshotDay = null;
  makeNote(someDate(10, 4), 'Heute');
  await store.persistNow();
  const snaps = store.listSnapshots();
  diag('snapshots =', JSON.stringify(snaps));
  if (!snaps.length) skip('no snapshot in this run');
  const before = store.state.notes.map((n) => n.text).join(',');
  const ok = store.restoreSnapshot(snaps[0].day);
  diag('restore ok =', ok, 'notes before =', before, 'after =', store.state.notes.map((n) => n.text).join(','),
    'undo depth =', depth());
  assert.equal(ok, true);
  assert.equal(depth(), 0, 'a restore clears history');
});

// ── Q8 · v1 field semantics of undoStack / redoStack ─────────────────────────

test('Q8 store.undoStack.length = 0 also wipes the REDO branch (v1 did not)', () => {
  reset();
  makeNote(someDate(11, 3), 'Stack');
  store.undo();
  const redoBefore = store.redoStack.length;
  store.undoStack.length = 0;
  diag('redo before =', redoBefore, 'after undoStack.length=0 =', store.redoStack.length,
    '(v1: clearing one array left the other alone)');
  assert.equal(redoBefore, 1);
  assert.equal(store.redoStack.length, 0, 'documenting the divergence');
});

test('Q8b store.undoStack.push() is silently ignored (v1 grew the stack)', () => {
  reset();
  const before = depth();
  store.undoStack.push({ label: 'fake', snap: {} });
  diag('after push: depth', before, '->', depth(), '(v1: +1)');
  assert.equal(depth(), before, 'documenting the divergence');
});

// ── Q9 · undo/redo interleaving under real gestures ──────────────────────────

test('Q9 undo, undo, redo, new gesture, redo', () => {
  reset();
  makeNote(someDate(1, 3), 'A');
  makeNote(someDate(1, 4), 'B');
  makeNote(someDate(1, 5), 'C');
  store.undo(); store.undo();
  diag('after 2 undos: notes =', store.state.notes.map((n) => n.text).join(','), 'redo =', store.redoStack.length);
  store.redo();
  diag('after redo: notes =', store.state.notes.map((n) => n.text).join(','), 'redo =', store.redoStack.length);
  makeNote(someDate(1, 6), 'D');
  diag('after a new gesture: redo =', store.redoStack.length, 'notes =', store.state.notes.map((n) => n.text).join(','));
  assert.equal(store.redoStack.length, 0);
  assert.equal(store.state.notes.map((n) => n.text).join(','), 'A,B,D');
  const ok = store.redo();
  diag('redo after the branch was dropped returned', ok);
  assert.equal(ok, false);
});

test('Q9b undo past the bottom returns false and toasts', () => {
  reset();
  makeNote(someDate(1, 7), 'Solo');
  assert.equal(store.undo(), true);
  assert.equal(store.undo(), false, 'undo past the bottom must decline, not throw');
  key(document.body, 'z', { metaKey: true });
  diag('toast after an empty ⌘Z =', $('.toast') ? $('.toast').textContent : 'none');
  assert.ok(true);
});

// ── Q10 · the board still renders what the store says, after all of this ─────

test('Q10 the board is intact and error-free after the whole probe', () => {
  reset();
  diag('cols =', $$('.board .col').length,
    'day rows =', $$('.board .day').length,
    'dated =', $$('.board .day[data-date]').length,
    'pads =', $$('.board .pad textarea').length,
    'page errors =', JSON.stringify(window.__lzpErrors || []));
  assert.equal($$('.board .col').length, 12);
  assert.equal($$('.board .day').length, 372);
  assert.deepEqual(window.__lzpErrors || [], []);
});
