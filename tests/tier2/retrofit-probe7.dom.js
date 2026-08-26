// TIER 2 · WP-3 ADVERSARY PROBE, round 7 — the promise that costs the most if
// it is wrong: 4.4, "deleting a category with entries never silently drops
// them", driven through the real reassign sheet at scale. Plus selection
// hygiene across undo, and pinned-mode paging (a read path that never touched
// a transaction and must not have started to).

const { store } = await importApp('store.js');
const interact = await importApp('interact.js');
const legend = await importApp('legend.js');
const popover = await importApp('popover.js');

const at = (n, dx = 4, dy = 3) => { const r = n.getBoundingClientRect(); return { clientX: r.left + dx, clientY: r.top + dy }; };
const ptr = (type, node, pos, target = node) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, isPrimary: true, ...pos }));
const key = (node, k, opts = {}) => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  node.dispatchEvent(ev); return ev;
};
function click(node) {
  const pos = at(node);
  ptr('pointerdown', node, pos); ptr('pointerup', node, pos, window);
  node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...pos }));
}
const cols = () => $$('.board .col');
const someDate = (c, r) => cols()[c].querySelectorAll('.day[data-date]')[r].dataset.date;
const dayNode = (d) => $(`.board .day[data-date="${d}"]`);
const depth = () => store.undoStack.length;
const closeSheets = () => {
  for (let i = 0; i < 6 && $('.sheet'); i++) {
    const b = $$('.sheet button').find((x) => /Fertig|Done|Abbrechen|Cancel/i.test(x.textContent));
    if (!b) break;
    b.click();
  }
};
function reset() {
  popover.closePopover(); closeSheets();
  store.state.notes = []; store.state.bars = []; store.state.scratchpads = {};
  store.undoStack.length = 0; store.redoStack.length = 0;
  interact.clearSelection();
  store.emit('reset');
}

// ── W1 · 4.4 at scale, through the real sheet ───────────────────────────────

test('W1 deleting a category holding 60 notes and 20 bars, via the reassign sheet', () => {
  reset();
  const doomed = store.state.categories[2];
  const keep = store.state.categories[0];
  const target = store.state.categories[1];
  // a realistic mixture: entries in the doomed category AND in one that must not move
  store.mutate('seed', (s) => {
    for (let i = 0; i < 60; i++) {
      s.notes.push({ id: 'w1-n' + i, date: someDate(i % 12, (i % 26) + 1), text: 'n' + i,
        categoryId: doomed.id, repeatsYearly: i % 9 === 0 });
    }
    for (let i = 0; i < 20; i++) {
      s.bars.push({ id: 'w1-b' + i, startDate: someDate(i % 12, 3), endDate: someDate(i % 12, 3 + (i % 20) + 1),
        label: 'b' + i, categoryId: doomed.id });
    }
    for (let i = 0; i < 10; i++) {
      s.notes.push({ id: 'w1-keep' + i, date: someDate(i % 12, 26), text: 'k' + i,
        categoryId: keep.id, repeatsYearly: false });
    }
  });
  store.setSettings({ lastCategoryId: doomed.id });
  store.undoStack.length = 0;

  const catOrderBefore = store.state.categories.map((c) => c.id);
  const noteCatBefore = new Map(store.state.notes.map((n) => [n.id, n.categoryId]));
  const barCatBefore = new Map(store.state.bars.map((b) => [b.id, b.categoryId]));
  const notesBefore = store.state.notes.length;
  const barsBefore = store.state.bars.length;

  legend.openCategoryManager();
  const row = $$('.sheet .cat-row')[2];
  diag('row count in the sheet =', row.querySelector('.count').textContent, '(wanted 80)');
  assert.equal(row.querySelector('.count').textContent, '80', 'the sheet miscounts the entries');
  row.querySelector('.btn-danger').click();

  const sel = $$('.sheet select').at(-1);
  assert.ok(sel, 'the reassign sheet did not open — 4.4 would have dropped 80 entries silently');
  sel.value = target.id;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const delBtn = $$('.sheet button').filter((b) => /Lösch|Delete/i.test(b.textContent)).at(-1);
  delBtn.click();
  closeSheets();

  diag('after the delete: cats =', store.state.categories.length,
    'notes =', store.state.notes.length, '(wanted', notesBefore + ')',
    'bars =', store.state.bars.length, '(wanted', barsBefore + ')',
    'undo steps =', depth(), '(4.4: exactly 1)');
  assert.equal(store.state.notes.length, notesBefore, 'notes were DROPPED, not reassigned');
  assert.equal(store.state.bars.length, barsBefore, 'bars were DROPPED, not reassigned');
  assert.equal(depth(), 1, 'the 81-write fan-out must be ONE undo step');
  assert.equal(store.state.categories.some((c) => c.id === doomed.id), false);
  assert.equal(store.state.notes.filter((n) => n.categoryId === target.id).length, 60);
  assert.equal(store.state.bars.filter((b) => b.categoryId === target.id).length, 20);
  assert.equal(store.state.notes.filter((n) => n.categoryId === keep.id).length, 10,
    'entries in an untouched category were moved');
  assert.equal(store.state.settings.lastCategoryId, target.id,
    '4.2 — the reassign path repoints lastCategoryId at the TARGET');

  // ── one ⌘Z ──
  store.undo();
  diag('after ONE undo: cats =', store.state.categories.length,
    'order restored =', store.state.categories.map((c) => c.id).join(',') === catOrderBefore.join(','),
    'undo steps =', depth());
  assert.deepEqual(store.state.categories.map((c) => c.id), catOrderBefore,
    'the category came back in the wrong legend position');
  let wrongN = 0;
  for (const n of store.state.notes) if (n.categoryId !== noteCatBefore.get(n.id)) wrongN++;
  let wrongB = 0;
  for (const b of store.state.bars) if (b.categoryId !== barCatBefore.get(b.id)) wrongB++;
  diag('entries whose category did NOT come back: notes', wrongN, 'bars', wrongB);
  assert.equal(wrongN, 0, 'one ⌘Z did not put every note back');
  assert.equal(wrongB, 0, 'one ⌘Z did not put every bar back');
  assert.equal(store.state.notes.length, notesBefore);
  assert.equal(store.state.bars.length, barsBefore);

  // ── and redo ──
  store.redo();
  diag('after redo: cats =', store.state.categories.length,
    'on target =', store.state.notes.filter((n) => n.categoryId === target.id).length,
    store.state.bars.filter((b) => b.categoryId === target.id).length);
  assert.equal(store.state.notes.filter((n) => n.categoryId === target.id).length, 60);
  assert.equal(store.state.categories.some((c) => c.id === doomed.id), false);
  reset();
  store.setSettings({ lastCategoryId: store.state.categories[0].id });
});

test('W1b Cancel in the reassign sheet changes nothing at all', () => {
  reset();
  const doomed = store.state.categories[2];
  store.mutate('seed', (s) => {
    for (let i = 0; i < 4; i++) s.notes.push({ id: 'w1b-' + i, date: someDate(1, i + 2), text: 'x' + i, categoryId: doomed.id, repeatsYearly: false });
  });
  store.undoStack.length = 0;
  legend.openCategoryManager();
  $$('.sheet .cat-row')[2].querySelector('.btn-danger').click();
  const cancel = $$('.sheet button').find((b) => /Abbrechen|Cancel/i.test(b.textContent));
  assert.ok(cancel, 'no Cancel in the reassign sheet');
  cancel.click();
  closeSheets();
  diag('after cancel: cats =', store.state.categories.length, 'notes =', store.state.notes.length,
    'still on the doomed cat =', store.state.notes.filter((n) => n.categoryId === doomed.id).length,
    'steps =', depth());
  assert.equal(store.state.categories.some((c) => c.id === doomed.id), true);
  assert.equal(depth(), 0, 'Cancel wrote something');
  reset();
});

// ── W2 · selection hygiene across undo ──────────────────────────────────────

test('W2 a selection pointing at an undone entry cannot resurrect it or throw', () => {
  reset();
  const d = someDate(1, 6);
  click(dayNode(d));
  const inp = $('.board .inline-edit');
  inp.value = 'Auswahl'; key(inp, 'Enter');
  const id = store.state.notes[0].id;
  assert.equal(interact.selection.id, id, 'a new note is selected');
  store.undo();
  diag('after undo: selection still points at', interact.selection.id === id ? 'the ghost' : 'nothing',
    'notes =', store.state.notes.length,
    'rendered =', $$(`.board .note[data-note-id="${id}"]`).length);
  // ⌫ on the ghost
  const before = depth();
  key(document.body, 'Backspace');
  diag('⌫ on the ghost: steps', before, '->', depth(), '(v1 recorded one; the filter was a no-op)',
    'errors =', JSON.stringify(window.__lzpErrors || []));
  assert.deepEqual(window.__lzpErrors || [], [], '⌫ on a stale selection threw');
  // Enter on the ghost
  key(document.body, 'Enter');
  diag('Enter on the ghost: editor =', !!$('.board .inline-edit'), 'errors =', JSON.stringify(window.__lzpErrors || []));
  assert.deepEqual(window.__lzpErrors || [], []);
  interact.clearSelection();
});

test('W2b redo re-selects nothing but restores the entry (v1 did the same)', () => {
  reset();
  const d = someDate(1, 8);
  click(dayNode(d));
  const inp = $('.board .inline-edit');
  inp.value = 'Wiederholen'; key(inp, 'Enter');
  const id = store.state.notes[0].id;
  store.undo();
  store.redo();
  const back = store.state.notes.find((n) => n.id === id);
  diag('after undo+redo: same id =', !!back, 'text =', back && back.text,
    'rendered =', !!$(`.board .note[data-note-id="${id}"]`),
    'selection =', interact.selection.id);
  assert.ok(back, 'redo did not restore the note');
  assert.equal(back.text, 'Wiederholen');
  assert.ok($(`.board .note[data-note-id="${id}"]`), 'restored in the store but not on the board');
});

// ── W3 · pinned-mode paging, a pure read path ───────────────────────────────

test('W3 pinned mode + year paging still renders the right window and the right entries', () => {
  reset();
  store.mutate('seed', (s) => {
    s.notes.push({ id: 'w3-a', date: '2026-09-15', text: 'Dieses Jahr', categoryId: s.categories[0].id, repeatsYearly: false });
    s.notes.push({ id: 'w3-b', date: '2027-09-15', text: 'Nächstes Jahr', categoryId: s.categories[0].id, repeatsYearly: false });
  });
  store.setSettings({ mode: 'pinned', startMonth: '2026-09', pageYears: 0 });
  store.emit('settings');
  diag('pinned: first col =', cols()[0].dataset.month, 'last =', cols().at(-1).dataset.month,
    'pager hidden =', $('#pager').hidden, 'year =', $('#pg-year').textContent);
  assert.equal(cols()[0].dataset.month, '2026-09');
  assert.ok(!!$('.board .note[data-note-id="w3-a"]'), 'the 2026 note is missing from the 2026 window');
  assert.equal($('.board .note[data-note-id="w3-b"]'), null, 'the 2027 note leaked into the 2026 window');

  $('#pg-next').click();
  diag('after ▶: first col =', cols()[0].dataset.month, 'year =', $('#pg-year').textContent,
    '2027 note visible =', !!$('.board .note[data-note-id="w3-b"]'),
    '2026 note visible =', !!$('.board .note[data-note-id="w3-a"]'),
    'undo depth =', depth());
  assert.equal(cols()[0].dataset.month, '2027-09');
  assert.ok(!!$('.board .note[data-note-id="w3-b"]'));
  assert.equal($('.board .note[data-note-id="w3-a"]'), null);

  $('#pg-prev').click();
  assert.equal(cols()[0].dataset.month, '2026-09', 'paging back did not return');
  store.setSettings({ mode: 'rolling', pageYears: 0 });
  store.emit('settings');
  diag('back to rolling: first col =', cols()[0].dataset.month, 'pager hidden =', $('#pager').hidden);
  reset();
});

// ── W4 · layer toggles are settings, never undoable ─────────────────────────

test('W4 the Feiertage toggle redraws, persists and stays out of the undo stack', () => {
  reset();
  const before = store.state.settings.layers.feiertage;
  const holBefore = $$('.board .d-hol').length;
  $('#btn-feiertage').click();
  diag('feiertage', before, '->', store.state.settings.layers.feiertage,
    'holiday cells', holBefore, '->', $$('.board .d-hol').length,
    'undo depth =', depth(),
    'aria-pressed =', $('#btn-feiertage').getAttribute('aria-pressed'));
  assert.notEqual(store.state.settings.layers.feiertage, before);
  assert.equal(depth(), 0, 'a layer toggle landed on the undo stack');
  assert.notEqual($$('.board .d-hol').length, holBefore, 'the board did not follow the toggle');
  $('#btn-feiertage').click();
  assert.equal($$('.board .d-hol').length, holBefore);
});

test('W5 nothing left behind', () => {
  reset();
  diag('errors =', JSON.stringify(window.__lzpErrors || []),
    'sheets =', $$('.sheet').length, 'popovers =', $$('.popover').length,
    'ghosts =', $$('.drag-ghost').length);
  assert.deepEqual(window.__lzpErrors || [], []);
  assert.equal($$('.sheet').length, 0);
});
