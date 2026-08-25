// TIER 2 · CHARACTERIZATION — the gestures. Real pointer and keyboard events
// against the real board: click-to-type, drag-to-lay-a-bar, undo, find, the
// legend, the day popover, scratchpads. None of this is reachable from tier 1.

const { store } = await importApp('store.js');
const interact = await importApp('interact.js');

const board = () => $('#board');

// ── event helpers ────────────────────────────────────────────────────────────

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

/** press-and-release on a node without moving — v1 reads that as a click. */
function click(node, dx, dy) {
  const pos = at(node, dx, dy);
  ptr('pointerdown', node, pos);
  ptr('pointerup', node, pos, window);
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...pos }));
}

/** press, move past the 4px threshold, release — v1 reads that as a drag. */
function drag(from, to) {
  const a = at(from, 6, 4);
  const b = at(to, 6, 4);
  ptr('pointerdown', from, a);
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: a.clientX, clientY: a.clientY + 10 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, ...b }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, ...b }));
}

const dayNode = (date) => $(`.board .day[data-date="${date}"]`);
const someDate = (colIndex, row) => $$('.board .col')[colIndex].querySelectorAll('.day[data-date]')[row].dataset.date;

function reset() {
  store.state.notes = [];
  store.state.bars = [];
  store.state.scratchpads = {};
  store.undoStack.length = 0;
  store.redoStack.length = 0;
  interact.clearSelection();
  $('#find-input').value = '';
  $('#find-input').dispatchEvent(new Event('input', { bubbles: true }));
  store.emit('reset');
}

// ── 2.1 click a day and type ─────────────────────────────────────────────────

test('clicking an empty day opens an inline editor on that row', () => {
  reset();
  const date = someDate(1, 8);
  click(dayNode(date));
  const inp = $('.board .inline-edit');
  assert.ok(inp, 'no editor appeared');
  assert.equal(document.activeElement, inp, 'the editor takes focus — no click-then-click');
  assert.equal(inp.maxLength, 80, 'note text is capped at 80 chars (2.5)');
  assert.ok($('.board .cat-strip'), 'category swatches ride along with the editor');
  assert.equal($$('.board .cat-strip .sw').length, store.state.categories.length);
  interact.cancelEditor();
  assert.equal($('.board .inline-edit'), null);
});

test('typing and pressing Enter creates a note in the store and on the board', () => {
  reset();
  const date = someDate(1, 9);
  click(dayNode(date));
  const inp = $('.board .inline-edit');
  inp.value = 'Zahnarzt';
  key(inp, 'Enter');

  assert.equal(store.state.notes.length, 1);
  const n = store.state.notes[0];
  assert.equal(n.text, 'Zahnarzt');
  assert.equal(n.date, date);
  assert.equal(n.repeatsYearly, false);
  assert.equal(n.categoryId, store.state.settings.lastCategoryId);

  const node = $(`.board .note[data-note-id="${n.id}"]`);
  assert.ok(node, 'the note is not on the board');
  assert.equal(node.dataset.date, date);
  assert.equal(node.textContent, 'Zahnarzt');
  assert.ok(node.classList.contains('selected'), 'the new note is selected');
  reset();
});

test('Escape discards the editor without creating anything', () => {
  reset();
  click(dayNode(someDate(2, 4)));
  const inp = $('.board .inline-edit');
  inp.value = 'nicht speichern';
  key(inp, 'Escape');
  assert.equal($('.board .inline-edit'), null);
  assert.equal(store.state.notes.length, 0);
});

test('committing empty text creates nothing (no ghost entries)', () => {
  reset();
  click(dayNode(someDate(2, 5)));
  const inp = $('.board .inline-edit');
  inp.value = '   ';
  key(inp, 'Enter');
  assert.equal(store.state.notes.length, 0);
});

test('a note created in a hidden category unhides it rather than vanishing (4.6)', () => {
  reset();
  const cat = store.state.categories[1];
  cat.visible = false;
  store.state.settings.lastCategoryId = cat.id;
  try {
    click(dayNode(someDate(2, 6)));
    const inp = $('.board .inline-edit');
    inp.value = 'darf nicht verschwinden';
    key(inp, 'Enter');
    assert.equal(store.state.notes.length, 1);
    assert.equal(cat.visible, true, 'the category was unhidden');
    assert.ok($(`.board .note[data-note-id="${store.state.notes[0].id}"]`), 'and the note is visible');
  } finally {
    cat.visible = true;
    store.state.settings.lastCategoryId = store.state.categories[0].id;
    reset();
  }
});

// ── 3.1 drag to lay a bar ────────────────────────────────────────────────────

test('a vertical drag across a column lays down a bar', () => {
  reset();
  const from = someDate(3, 3);
  const to = someDate(3, 12);
  drag(dayNode(from), dayNode(to));

  assert.equal(store.state.bars.length, 1, 'no bar was created');
  const b = store.state.bars[0];
  assert.equal(b.startDate, from);
  assert.equal(b.endDate, to);
  assert.ok($(`.board .bar[data-bar-id="${b.id}"]`), 'the stripe is not on the board');
  assert.equal(document.body.classList.contains('is-creating'), false, 'drag state cleaned up');
  reset();
});

test('dragging upward normalises the range (3.5) rather than making it invalid', () => {
  reset();
  const from = someDate(3, 14);
  const to = someDate(3, 4);
  drag(dayNode(from), dayNode(to));
  assert.equal(store.state.bars.length, 1);
  const b = store.state.bars[0];
  assert.equal(b.startDate, to, 'the earlier day became the start');
  assert.equal(b.endDate, from);
  assert.ok(b.startDate <= b.endDate);
  reset();
});

// ── 5.x undo ─────────────────────────────────────────────────────────────────

test('undo removes a created note from board and store; redo puts it back', () => {
  reset();
  click(dayNode(someDate(4, 7)));
  const inp = $('.board .inline-edit');
  inp.value = 'Rückgängig';
  key(inp, 'Enter');
  const id = store.state.notes[0].id;
  assert.ok($(`.board .note[data-note-id="${id}"]`));

  store.undo();
  assert.equal(store.state.notes.length, 0);
  assert.equal($(`.board .note[data-note-id="${id}"]`), null, 'the DOM did not follow the undo');

  store.redo();
  assert.equal(store.state.notes.length, 1);
  assert.ok($(`.board .note[data-note-id="${id}"]`));
  reset();
});

test('deleting the selected entry goes through the undo stack', () => {
  reset();
  click(dayNode(someDate(4, 9)));
  const inp = $('.board .inline-edit');
  inp.value = 'Löschbar';
  key(inp, 'Enter');
  const id = store.state.notes[0].id;

  assert.equal(interact.deleteSelected(), true);
  assert.equal(store.state.notes.length, 0);
  store.undo();
  assert.equal(store.state.notes.length, 1);
  assert.equal(store.state.notes[0].id, id, 'the same note came back, id and all');
  reset();
});

// ── selection ────────────────────────────────────────────────────────────────

test('clicking a note selects it; clicking the board background clears it', () => {
  reset();
  click(dayNode(someDate(5, 3)));
  const inp = $('.board .inline-edit');
  inp.value = 'Auswahl';
  key(inp, 'Enter');
  const node = $('.board .note');
  interact.clearSelection();
  assert.equal($$('.board .selected').length, 0);

  click(node);
  assert.ok($('.board .note').classList.contains('selected'));
  assert.equal(interact.selection.type, 'note');
  reset();
});

// ── F14 find ─────────────────────────────────────────────────────────────────

test('find dims the board and marks matching notes', async () => {
  reset();
  const spec = [['Steuererklärung', 6, 2], ['Zahnarzt', 6, 4], ['Steuerprüfung', 7, 2]];
  for (const [text, col, row] of spec) {
    click(dayNode(someDate(col, row)));
    const inp = $('.board .inline-edit');
    inp.value = text;
    key(inp, 'Enter');
  }
  assert.equal(store.state.notes.length, 3);

  const find = $('#find-input');
  find.value = 'steuer';
  find.dispatchEvent(new Event('input', { bubbles: true }));

  assert.ok(document.body.classList.contains('finding'), 'the board did not enter find mode');
  const hits = $$('.board .note.hit');
  assert.equal(hits.length, 2, 'case-insensitive substring match over note text');
  assert.deepEqual(hits.map((h) => h.textContent).sort(), ['Steuererklärung', 'Steuerprüfung']);
  assert.match($('#find-count').textContent, /\d/, 'the counter shows a position');

  find.value = '';
  find.dispatchEvent(new Event('input', { bubbles: true }));
  assert.equal(document.body.classList.contains('finding'), false);
  assert.equal($$('.board .note.hit').length, 0);
  reset();
});

test('find also searches bar labels', () => {
  reset();
  const key0 = $$('.board .col')[8].dataset.month;
  store.mutate('seed', (s) => {
    s.bars.push({ id: 'find-bar', startDate: `${key0}-03`, endDate: `${key0}-09`,
                  label: 'Umzug Hamburg', categoryId: s.categories[0].id });
  });
  const find = $('#find-input');
  find.value = 'umzug';
  find.dispatchEvent(new Event('input', { bubbles: true }));
  assert.ok($$('.board .bar-label.hit').length > 0, 'no bar label matched');
  find.value = '';
  find.dispatchEvent(new Event('input', { bubbles: true }));
  reset();
});

// ── legend (F4) ──────────────────────────────────────────────────────────────

test('the legend lists every category and toggles visibility on click', () => {
  reset();
  const items = $$('#legend .legend-item');
  assert.equal(items.length, store.state.categories.length);
  assert.deepEqual(items.map((i) => i.textContent), store.state.categories.map((c) => c.name));

  const first = items[0];
  const catId = first.dataset.catId;
  assert.equal(first.dataset.visible, 'true');
  first.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(store.state.categories.find((c) => c.id === catId).visible, false);
  assert.equal($(`#legend .legend-item[data-cat-id="${catId}"]`).dataset.visible, 'false');
  $(`#legend .legend-item[data-cat-id="${catId}"]`).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  assert.equal(store.state.categories.find((c) => c.id === catId).visible, true);
});

// ── day popover (F5 / 9.1) ───────────────────────────────────────────────────

test('right-click opens the day popover listing every entry on that day', () => {
  reset();
  const date = someDate(9, 5);
  store.mutate('seed', (s) => {
    for (let i = 0; i < 3; i++) {
      s.notes.push({ id: `pop-${i}`, date, text: `Termin ${i}`, categoryId: s.categories[0].id, repeatsYearly: false });
    }
  });
  dayNode(date).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const pop = $('.popover');
  assert.ok(pop, 'no popover');
  assert.equal($$('.pop-row', pop).length, 3, 'all three entries, including the overflowed ones');
  assert.includes(pop.textContent, 'Termin 2');
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  assert.equal($('.popover'), null, 'clicking outside closes it');
  reset();
});

test('the +n chip opens the same popover', () => {
  reset();
  const date = someDate(9, 7);
  store.mutate('seed', (s) => {
    for (let i = 0; i < 5; i++) {
      s.notes.push({ id: `chip-${i}`, date, text: `Eintrag ${i}`, categoryId: s.categories[0].id, repeatsYearly: false });
    }
  });
  const chip = $(`.board .day[data-date="${date}"] .d-more`);
  assert.ok(chip, 'no overflow chip');
  chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.ok($('.popover'), 'the chip opened no popover');
  assert.equal($$('.popover .pop-row').length, 5);
  document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  reset();
});

// ── scratchpads (F10) ────────────────────────────────────────────────────────

test('typing in a month scratchpad reaches the store and survives a redraw', async () => {
  reset();
  const ta = $('.board .pad textarea');
  const monthKey = ta.dataset.month;
  ta.value = 'Reifen wechseln';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => store.state.scratchpads[monthKey] === 'Reifen wechseln',
    { what: 'the debounced pad write' });
  store.emit('force-redraw');
  assert.equal($(`.board .pad textarea[data-month="${monthKey}"]`).value, 'Reifen wechseln');
  assert.equal($(`.board .pad[data-month="${monthKey}"]`).classList.contains('empty'), false);
  reset();
});

// ── the run left nothing behind ──────────────────────────────────────────────

test('no uncaught errors were raised by any of the gestures above', () => {
  assert.deepEqual(window.__lzpErrors, []);
});

// ── F5 · move, resize (5.1 / 5.2 / 5.3 / 5.5) ────────────────────────────────
//
// GAP NOTE (phase 3). These five characterizations did not exist when the area
// agents finished: tier 1 covered 5.4's *undo* of a move/resize, and tier 2
// covered drag-to-CREATE, but nothing exercised the move and resize gestures
// themselves. They are the entry points that turn a pointer gesture into a
// store.mutate() call, which makes them precisely the surface LZP-402 replaces.
// A retrofit could break "drag a bar one week later" with the whole rest of the
// suite still green. Now it cannot.

/** Seed one note through the store and hand back its live DOM node. */
function seedNote(date, text) {
  const id = 'itest-note';
  store.mutate('seed', (s) => {
    s.notes.push({ id, date, text, categoryId: s.categories[0].id, repeatsYearly: false });
  });
  return { id, node: () => $(`.board .note[data-note-id="${id}"]`) };
}

function seedBar(startDate, endDate, label) {
  const id = 'itest-bar';
  store.mutate('seed', (s) => {
    s.bars.push({ id, startDate, endDate, label, categoryId: s.categories[0].id });
  });
  return { id, bar: () => store.state.bars.find((b) => b.id === id) };
}

test('5.1 · dragging a note onto another day reschedules it, keeping everything else', () => {
  reset();
  const from = someDate(0, 4);
  const to = someDate(0, 9);
  const { id, node } = seedNote(from, 'Zahnarzt');
  assert.ok(node(), 'the seeded note is on the board');

  drag(node(), dayNode(to));

  const n = store.state.notes.find((x) => x.id === id);
  assert.equal(n.date, to, 'the note moved to the drop target');
  assert.equal(n.text, 'Zahnarzt', 'the text is untouched');
  assert.equal(store.state.notes.length, 1, 'it MOVED — it was not copied');
  // and the board followed the store
  assert.ok($(`.day[data-date="${to}"] .note[data-note-id="${id}"]`), 'rendered on the new day');
  assert.equal($(`.day[data-date="${from}"] .note[data-note-id="${id}"]`), null, 'gone from the old day');
});

test('5.1 · a move is one undo step, and undo puts the note back', () => {
  reset();
  const from = someDate(0, 4);
  const to = someDate(0, 9);
  const { id, node } = seedNote(from, 'Zahnarzt');
  const depth = store.undoStack.length;

  drag(node(), dayNode(to));
  assert.equal(store.undoStack.length, depth + 1, 'exactly one step was recorded (5.4)');

  store.undo();
  assert.equal(store.state.notes.find((x) => x.id === id).date, from);
  assert.ok($(`.day[data-date="${from}"] .note[data-note-id="${id}"]`), 'back on the original day');
});

test('5.1/9.3 · moving a REPEATING note re-anchors month/day but keeps the series year', () => {
  // The one-object-per-series rule (9.3): a birthday dragged to a new day must
  // still be the same series starting in the same year, not a new anchor.
  reset();
  const to = someDate(0, 9);
  const anchorYear = '2019';
  const id = 'itest-rep';
  store.mutate('seed', (s) => {
    s.notes.push({
      id, date: `${anchorYear}-${someDate(0, 4).slice(5)}`, text: 'Geburtstag',
      categoryId: s.categories[0].id, repeatsYearly: true,
    });
  });
  const node = $(`.board .note[data-note-id="${id}"]`);
  assert.ok(node, 'the projected occurrence is on the board');

  drag(node, dayNode(to));

  const n = store.state.notes.find((x) => x.id === id);
  assert.equal(n.date.slice(0, 4), anchorYear, 'the series still starts in its original year');
  assert.equal(n.date.slice(5), to.slice(5), 'but it now falls on the dropped month/day');
  assert.equal(n.repeatsYearly, true, 'it is still a series');
  assert.equal(store.state.notes.length, 1, 'still exactly one object for the whole series');
});

test('5.2 · dragging a bar shifts it whole — same length, both ends moved', () => {
  reset();
  const start = someDate(0, 2);
  const end = someDate(0, 6);
  const grab = someDate(0, 4);   // grab it in the middle
  const drop = someDate(0, 11);  // seven rows down
  const { id, bar } = seedBar(start, end, 'Umbau');
  const lengthBefore = bar().endDate;

  const stripe = $(`.board .bar[data-bar-id="${id}"]`);
  assert.ok(stripe, 'the bar is on the board');
  // press on the stripe but over a specific day row, so grabDate is that day
  const dayR = dayNode(grab).getBoundingClientRect();
  const stripeR = stripe.getBoundingClientRect();
  ptr('pointerdown', stripe, { clientX: stripeR.left + 2, clientY: dayR.top + 3 });
  const dropR = dayNode(drop).getBoundingClientRect();
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: stripeR.left + 2, clientY: dayR.top + 14 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: stripeR.left + 2, clientY: dropR.top + 3 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, clientX: stripeR.left + 2, clientY: dropR.top + 3 }));

  const b = bar();
  const days = (s, e) => Math.round((Date.parse(e) - Date.parse(s)) / 86400000);
  assert.equal(days(b.startDate, b.endDate), days(start, end), 'the length is preserved (5.2)');
  assert.notEqual(b.endDate, lengthBefore, 'it actually moved');
  assert.equal(b.startDate > start, true, 'it moved forward, in the drag direction');
  assert.equal(b.label, 'Umbau', 'the label survived the move');
  assert.equal(store.state.bars.length, 1, 'moved, not copied');
});

test('5.3 · dragging a bar\'s end grip stretches it without moving its start', () => {
  reset();
  const start = someDate(0, 2);
  const end = someDate(0, 6);
  const target = someDate(0, 12);
  const { id, bar } = seedBar(start, end, 'Projekt');

  const grip = $(`.board .bar[data-bar-id="${id}"] .bar-handle.bottom`)
    || $$(`.board .bar[data-bar-id="${id}"] .bar-handle`).at(-1);
  assert.ok(grip, 'the end grip exists on a real bar');

  const gr = grip.getBoundingClientRect();
  const tr = dayNode(target).getBoundingClientRect();
  ptr('pointerdown', grip, { clientX: gr.left + 2, clientY: gr.top + 1 });
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: gr.left + 2, clientY: gr.top + 12 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: gr.left + 2, clientY: tr.top + 3 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, clientX: gr.left + 2, clientY: tr.top + 3 }));

  const b = bar();
  assert.equal(b.startDate, start, 'the start edge did not move (5.3)');
  assert.equal(b.endDate, target, 'the end edge followed the grip');
  assert.equal(store.state.bars.length, 1);
});

test('5.3 · dragging the START grip moves the start edge only, leaving the end', () => {
  // The mirrored half of 5.3. Worth its own test: a mutant that made the start
  // grip drag BOTH edges (i.e. turned resize-from-the-top into a move) was not
  // caught by the end-grip test alone.
  reset();
  const start = someDate(0, 8);
  const end = someDate(0, 14);
  const target = someDate(0, 3);
  const { id, bar } = seedBar(start, end, 'Projekt');

  const grip = $(`.board .bar[data-bar-id="${id}"] .bar-handle.top`);
  assert.ok(grip, 'a bar that starts inside the window has a top grip');

  const gr = grip.getBoundingClientRect();
  const tr = dayNode(target).getBoundingClientRect();
  ptr('pointerdown', grip, { clientX: gr.left + 2, clientY: gr.top + 1 });
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: gr.left + 2, clientY: gr.top - 12 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: gr.left + 2, clientY: tr.top + 3 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, clientX: gr.left + 2, clientY: tr.top + 3 }));

  const b = bar();
  assert.equal(b.endDate, end, 'the end edge did NOT move — this is a resize, not a move');
  assert.equal(b.startDate, target, 'the start edge followed the grip');
  assert.equal(store.state.bars.length, 1);
});

test('5.5 · a press that never crosses the threshold selects instead of moving', () => {
  // The whole point of the 4 px threshold: clicking a note to edit it must
  // never turn into an accidental reschedule.
  reset();
  const from = someDate(0, 4);
  const { id, node } = seedNote(from, 'Zahnarzt');

  const n0 = node();
  const pos = at(n0, 4, 3);
  ptr('pointerdown', n0, pos);
  // move 2 px — under the 4 px threshold
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: pos.clientX + 2, clientY: pos.clientY + 1 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, clientX: pos.clientX + 2, clientY: pos.clientY + 1 }));

  assert.equal(store.state.notes.find((x) => x.id === id).date, from, 'the note did NOT move');
  assert.ok($(`.board .note[data-note-id="${id}"].selected`), 'it was selected instead');
});

// ── 8.3 · the Today button ───────────────────────────────────────────────────
//
// GAP NOTE (phase 3): 8.3 had no coverage in either tier. The scroll half is
// not meaningfully assertable headlessly (smooth scrolling on a viewport that
// may already show every column), but the half that CHANGES STATE is — and
// that is the half a store retrofit can break.

test('8.3 · Today brings a paged-away pinned board back to the year holding today', () => {
  reset();
  const before = { ...store.state.settings };
  try {
    // Pin to a month whose window contains today, then page two years back —
    // exactly the "exploring next summer is never a one-way trip" case.
    const todayKey = $('.board .col.is-today-month')?.dataset.month
      || $$('.board .col')[0].dataset.month;
    store.setSettings({ mode: 'pinned', startMonth: todayKey, pageYears: -2 });
    store.emit('settings');
    assert.equal(store.state.settings.pageYears, -2, 'the board is paged into the past');
    assert.equal($('.board .col.is-today-month'), null, 'today is not on screen');

    $('#btn-today').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.equal(store.state.settings.pageYears, 0, 'paging was reset to the year holding today');
    assert.ok($('.board .col.is-today-month'), 'the today column is back on the board');
    assert.ok($('.board .day.today'), 'and the today row is rendered again');
  } finally {
    store.setSettings(before);
    store.emit('settings');
  }
});

test('8.3 · Today is a no-op for state in rolling mode — it never repins the board', () => {
  reset();
  const before = { ...store.state.settings };
  try {
    store.setSettings({ mode: 'rolling', pageYears: 0 });
    store.emit('settings');
    const first = $$('.board .col')[0].dataset.month;

    $('#btn-today').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    assert.equal(store.state.settings.mode, 'rolling', 'the mode is untouched');
    assert.equal(store.state.settings.pageYears, 0);
    assert.equal($$('.board .col')[0].dataset.month, first, 'the window did not move');
  } finally {
    store.setSettings(before);
    store.emit('settings');
  }
});

// ── 2.2 · edit an existing note in place ─────────────────────────────────────
//
// GAP NOTE (phase 3): 2.1 (create) was covered, 2.2 (maintain) was not. Editing
// and clearing are store mutations, so a retrofit can break them.

test('2.2 · double-clicking an existing note edits it in place, keeping its identity', () => {
  reset();
  const date = someDate(0, 5);
  const { id, node } = seedNote(date, 'Zahnarzt');

  node().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, ...at(node()) }));
  const inp = $('.board .inline-edit');
  assert.ok(inp, 'an inline editor opened on the note');
  assert.equal(inp.value, 'Zahnarzt', 'it is seeded with the current text, not blank');

  inp.value = 'Zahnarzt 14:30';
  key(inp, 'Enter');

  const notes = store.state.notes;
  assert.equal(notes.length, 1, 'edited in place — no second note was created');
  assert.equal(notes[0].id, id, 'the SAME object was edited (identity preserved)');
  assert.equal(notes[0].text, 'Zahnarzt 14:30');
  assert.equal(notes[0].date, date, 'editing does not move the note');
  assert.ok($(`.board .note[data-note-id="${id}"]`).textContent.includes('14:30'), 'the board redrew');
});

test('2.2 · clearing a note\'s text deletes it rather than leaving a blank row', () => {
  reset();
  const date = someDate(0, 5);
  const { id, node } = seedNote(date, 'Zahnarzt');

  node().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, ...at(node()) }));
  const inp = $('.board .inline-edit');
  assert.ok(inp);
  inp.value = '';
  key(inp, 'Enter');

  assert.equal(store.state.notes.find((x) => x.id === id), undefined, 'the note is gone from the store');
  assert.equal($(`.board .note[data-note-id="${id}"]`), null, 'and off the board');
  // and it is undoable like every other edit (5.4)
  store.undo();
  assert.equal(store.state.notes.find((x) => x.id === id)?.text, 'Zahnarzt', 'undo brings it back');
});

// ── 4.1 · add and remove categories ──────────────────────────────────────────
//
// GAP NOTE (phase 3): only rename/recolor were covered. Add and delete both go
// through store.mutate and both touch settings.lastCategoryId.

const { openCategoryManager } = await importApp('legend.js');
const sheetButton = (label) => $$('.sheet button').find((b) => b.textContent.includes(label));
const closeSheet = () => $$('.sheet .btn-close, .sheet-backdrop, .sheet button')
  .find((b) => /schließen|close|✕|fertig|done/i.test(b.textContent || b.className))?.click();

test('4.1 · adding a category appends it with the next free tone, undoably', () => {
  reset();
  const before = store.state.categories.length;
  const usedBefore = store.state.categories.map((c) => c.paletteRef);
  try {
    openCategoryManager();
    const add = sheetButton('Neue Kategorie') || sheetButton('New category');
    assert.ok(add, 'the category sheet offers an add button');
    add.click();

    const cats = store.state.categories;
    assert.equal(cats.length, before + 1, 'exactly one category was added');
    const fresh = cats.at(-1);
    assert.equal(fresh.visible, true, 'a new category starts visible');
    assert.ok(fresh.id, 'it has an id');
    assert.ok(!usedBefore.includes(fresh.paletteRef), 'it took a tone nobody else was using (4.5)');
    // both language slots are written, so renaming later is not forced
    assert.equal(typeof fresh.name, 'string');
    assert.equal(typeof fresh.nameEn, 'string');

    store.undo();
    assert.equal(store.state.categories.length, before, 'adding a category is undoable');
  } finally {
    document.querySelectorAll('.sheet, .sheet-backdrop').forEach((n) => n.remove());
  }
});

test('4.1/4.4 · deleting an EMPTY category removes it; the last one cannot be deleted', () => {
  reset();
  try {
    // add one we can safely delete
    openCategoryManager();
    (sheetButton('Neue Kategorie') || sheetButton('New category')).click();
    const victim = store.state.categories.at(-1);
    const count = store.state.categories.length;
    assert.equal(store.countEntriesIn(victim.id), 0, 'the victim holds no entries');
    // Point lastCategoryId AT the victim first. Without this the dangling-
    // reference assertion below is vacuous: a freshly added category is never
    // the last-used one, so it would pass even if the repair were deleted.
    store.setSettings({ lastCategoryId: victim.id });
    assert.equal(store.state.settings.lastCategoryId, victim.id);

    // its row's ✕ — the last row in the list
    const dels = $$('.sheet .cat-list .btn-danger');
    assert.equal(dels.length, count, 'every category row offers a delete button');
    dels.at(-1).click();

    assert.equal(store.state.categories.length, count - 1, 'the empty category was removed outright');
    assert.equal(store.state.categories.find((c) => c.id === victim.id), undefined);
    assert.notEqual(store.state.settings.lastCategoryId, victim.id, 'lastCategoryId never dangles (4.2)');

    // 4.1's floor: the legend can never be emptied
    const remaining = $$('.sheet .cat-list .btn-danger');
    if (store.state.categories.length === 1) {
      assert.equal(remaining[0].disabled, true, 'the final category cannot be deleted');
    }
  } finally {
    document.querySelectorAll('.sheet, .sheet-backdrop').forEach((n) => n.remove());
  }
});

// ── 14.1 · stepping through hits ─────────────────────────────────────────────
//
// GAP NOTE (phase 3): the dimming and the counter were covered; Enter/⇧Enter
// stepping and Esc were not.

test('14.1 · Enter steps forward through hits, ⇧Enter back, and it wraps', () => {
  reset();
  const dates = [someDate(0, 2), someDate(0, 5), someDate(0, 8)];
  store.mutate('seed', (s) => {
    dates.forEach((d, i) => s.notes.push({
      id: `find-${i}`, date: d, text: `Meeting ${i}`,
      categoryId: s.categories[0].id, repeatsYearly: false,
    }));
  });

  const inp = $('#find-input');
  inp.value = 'Meeting';
  inp.dispatchEvent(new Event('input', { bubbles: true }));

  const hits = $$('.board .note.hit');
  assert.equal(hits.length, 3, 'all three notes matched');
  const current = () => $('.board .note.current');
  const readCount = () => $('#find-count').textContent;

  assert.ok(current(), 'one hit is the current one straight away');
  const first = current().dataset.noteId;
  assert.match(readCount(), /1\s*\/\s*3/, 'the counter reads 1/3');

  key(inp, 'Enter');
  assert.notEqual(current().dataset.noteId, first, 'Enter advanced to another hit');
  assert.match(readCount(), /2\s*\/\s*3/);

  key(inp, 'Enter');
  assert.match(readCount(), /3\s*\/\s*3/);

  key(inp, 'Enter');
  assert.match(readCount(), /1\s*\/\s*3/, 'it wrapped around to the first hit');
  assert.equal(current().dataset.noteId, first);

  key(inp, 'Enter', { shiftKey: true });
  assert.match(readCount(), /3\s*\/\s*3/, '⇧Enter wrapped backwards');
});

test('14.1 · Escape restores the board — no dimming, no hit marks', () => {
  reset();
  store.mutate('seed', (s) => {
    s.notes.push({ id: 'find-esc', date: someDate(0, 3), text: 'Meeting',
                   categoryId: s.categories[0].id, repeatsYearly: false });
  });
  const inp = $('#find-input');
  inp.value = 'Meeting';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  assert.ok($$('.board .note.hit').length > 0, 'find is active');
  assert.ok(document.body.classList.contains('finding'), 'the board is in the find state');

  key(inp, 'Escape');

  assert.equal(document.body.classList.contains('finding'), false, 'the dim state is gone');
  assert.equal($$('.board .note.hit').length, 0, 'no hit marks survive');
  assert.equal($$('.board .note.current').length, 0);
});
