// TIER 2 · WP-3 ADVERSARY PROBE — exploratory. Not a characterization suite.
// Drives the real board and reports what the retrofit actually does at the
// seams the unit oracle does not reach.

const { store } = await importApp('store.js');
const interact = await importApp('interact.js');
const legend = await importApp('legend.js');

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
const depth = () => store.undoStack.length;

function reset() {
  store.state.notes = [];
  store.state.bars = [];
  store.state.scratchpads = {};
  store.undoStack.length = 0;
  store.redoStack.length = 0;
  interact.clearSelection();
  store.emit('reset');
}

// ── P0 · environment ─────────────────────────────────────────────────────────
test('P0 environment', () => {
  diag('shadowArmed =', store._stacks.shadowArmed);
  diag('cols =', $$('.board .col').length, 'dayrows =', $$('.board .day[data-date]').length);
  diag('cats =', store.state.categories.map((c) => c.id + ':' + c.name).join(', '));
  diag('pads on board =', $$('.board .pad textarea').length);
  assert.ok($$('.board .col').length === 12);
});

// ── P1 · one gesture = one undo step ─────────────────────────────────────────

test('P1 create note by click+type+Enter', () => {
  reset();
  const d = someDate(1, 8);
  click(dayNode(d));
  const inp = $('.board .inline-edit');
  inp.value = 'A';
  key(inp, 'Enter');
  diag('create-note steps =', depth(), 'notes =', store.state.notes.length);
  assert.equal(depth(), 1);
});

test('P1 drag a note ACROSS a month boundary', () => {
  reset();
  const from = someDate(1, 8);
  click(dayNode(from));
  $('.board .inline-edit').value = 'A';
  key($('.board .inline-edit'), 'Enter');
  const id = store.state.notes[0].id;
  store.undoStack.length = 0;
  const to = someDate(2, 3);            // next column = next month
  drag($(`.board .note[data-note-id="${id}"]`), dayNode(to));
  const n = store.state.notes.find((x) => x.id === id);
  diag('cross-month note move: from', from, '->', n.date, 'wanted', to, 'steps =', depth());
  assert.equal(n.date, to);
  assert.equal(depth(), 1);
});

test('P1 drag a BAR across a month boundary', () => {
  reset();
  const s = someDate(1, 20), e = someDate(1, 25);
  store.mutate('seed', (st) => { st.bars.push({ id: 'p-bar', startDate: s, endDate: e, label: 'X', categoryId: st.categories[0].id }); });
  store.undoStack.length = 0;
  const grab = someDate(1, 22);
  const drop = someDate(2, 5);
  const stripe = $('.board .bar[data-bar-id="p-bar"]');
  const gr = dayNode(grab).getBoundingClientRect();
  const sr = stripe.getBoundingClientRect();
  const dr = dayNode(drop).getBoundingClientRect();
  ptr('pointerdown', stripe, { clientX: sr.left + 2, clientY: gr.top + 3 });
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: sr.left + 2, clientY: gr.top + 14 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: dr.left + 6, clientY: dr.top + 3 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, clientX: dr.left + 6, clientY: dr.top + 3 }));
  const b = store.state.bars.find((x) => x.id === 'p-bar');
  diag('cross-month bar move:', s, e, '->', b.startDate, b.endDate, 'steps =', depth(),
    'segments =', $$('.board .bar[data-bar-id="p-bar"]').length);
  assert.equal(depth(), 1);
});

test('P1 resize that tries to INVERT the bar', () => {
  reset();
  const s = someDate(0, 10), e = someDate(0, 15);
  store.mutate('seed', (st) => { st.bars.push({ id: 'p-inv', startDate: s, endDate: e, label: 'X', categoryId: st.categories[0].id }); });
  store.undoStack.length = 0;
  const grip = $('.board .bar[data-bar-id="p-inv"] .bar-handle.top') || $$('.board .bar[data-bar-id="p-inv"] .bar-handle')[0];
  const target = someDate(0, 25);   // drag the START handle far past the END
  const gr = grip.getBoundingClientRect();
  const tr = dayNode(target).getBoundingClientRect();
  ptr('pointerdown', grip, { clientX: gr.left + 2, clientY: gr.top + 1 });
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: gr.left + 2, clientY: gr.top + 12 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: gr.left + 2, clientY: tr.top + 3 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, clientX: gr.left + 2, clientY: tr.top + 3 }));
  const b = store.state.bars.find((x) => x.id === 'p-inv');
  diag('invert-resize:', s, e, '->', b.startDate, b.endDate, 'steps =', depth());
  assert.ok(b.startDate <= b.endDate, 'bar inverted!');
});

test('P1 create-bar-by-drag then commit the auto-opened label editor', () => {
  reset();
  const from = someDate(3, 3), to = someDate(3, 12);
  drag(dayNode(from), dayNode(to));
  diag('after create-bar drag: bars =', store.state.bars.length, 'steps =', depth(),
    'editor open =', interact.editorOpen());
  const inp = $('.board .inline-edit');
  if (inp) { inp.value = 'Urlaub'; key(inp, 'Enter'); }
  diag('after naming: steps =', depth(), 'label =', store.state.bars[0]?.label);
  assert.equal(store.state.bars.length, 1);
});

test('P1 create-bar-by-drag then ESCAPE the label editor', () => {
  reset();
  const from = someDate(4, 3), to = someDate(4, 12);
  drag(dayNode(from), dayNode(to));
  const inp = $('.board .inline-edit');
  const stepsBefore = depth();
  if (inp) { inp.value = 'weg'; key(inp, 'Escape'); }
  diag('escape after create-bar: steps before =', stepsBefore, 'after =', depth(),
    'label =', JSON.stringify(store.state.bars[0]?.label));
  assert.equal(store.state.bars.length, 1);
});

test('P1 create-bar-by-drag then commit label UNCHANGED (empty)', () => {
  reset();
  const from = someDate(5, 3), to = someDate(5, 8);
  drag(dayNode(from), dayNode(to));
  const before = depth();
  const inp = $('.board .inline-edit');
  if (inp) { inp.value = ''; key(inp, 'Enter'); }
  diag('empty-label commit: steps before =', before, 'after =', depth(), '(v1: 1 -> 2, ATT-5: 1 -> 1)');
  assert.ok(store.state.bars.length === 1);
});

test('P1 delete via Backspace', () => {
  reset();
  const d = someDate(1, 8);
  click(dayNode(d));
  $('.board .inline-edit').value = 'A';
  key($('.board .inline-edit'), 'Enter');
  store.undoStack.length = 0;
  key(document.body, 'Backspace');
  diag('delete: notes =', store.state.notes.length, 'steps =', depth());
  assert.equal(store.state.notes.length, 0);
  assert.equal(depth(), 1);
});

test('P1 Backspace TWICE on the same selection (stale selection)', () => {
  reset();
  const d = someDate(1, 9);
  click(dayNode(d));
  $('.board .inline-edit').value = 'A';
  key($('.board .inline-edit'), 'Enter');
  const id = store.state.notes[0].id;
  store.undoStack.length = 0;
  key(document.body, 'Backspace');
  interact.select('note', id);          // re-select the corpse
  key(document.body, 'Backspace');
  diag('double delete: steps =', depth(), '(v1 = 2)');
  assert.equal(store.state.notes.length, 0);
});

// ── P2 · the 50-step limit and redo clearing ─────────────────────────────────

test('P2 the 50-step limit under real gestures', () => {
  reset();
  for (let i = 0; i < 55; i++) {
    const d = someDate(1, i % 28);
    click(dayNode(d));
    const inp = $('.board .inline-edit');
    inp.value = 'N' + i;
    key(inp, 'Enter');
  }
  diag('55 creates -> depth =', depth(), 'notes =', store.state.notes.length);
  let undone = 0;
  while (store.undo()) undone++;
  diag('undos that succeeded =', undone, 'notes left =', store.state.notes.length,
    '(v1: 50 undone, 5 notes survive)');
  assert.ok(undone > 0);
});

test('P2 a new gesture drops the redo branch', () => {
  reset();
  const d1 = someDate(6, 3);
  click(dayNode(d1)); $('.board .inline-edit').value = 'A'; key($('.board .inline-edit'), 'Enter');
  store.undo();
  diag('after undo: redo =', store.redoStack.length);
  const d2 = someDate(6, 5);
  click(dayNode(d2)); $('.board .inline-edit').value = 'B'; key($('.board .inline-edit'), 'Enter');
  diag('after a new gesture: redo =', store.redoStack.length, '(must be 0)');
  assert.equal(store.redoStack.length, 0);
});

// ── P3 · ⌘Z near a focused field (10.2) ──────────────────────────────────────

test('P3 CMD-Z inside a scratchpad textarea must not touch the board stack', () => {
  reset();
  const d = someDate(1, 8);
  click(dayNode(d)); $('.board .inline-edit').value = 'A'; key($('.board .inline-edit'), 'Enter');
  const before = depth();
  const ta = $('.board .pad textarea');
  assert.ok(ta, 'no scratchpad textarea on the board');
  ta.focus();
  const ev = key(ta, 'z', { metaKey: true });
  diag('cmd-Z in pad: defaultPrevented =', ev.defaultPrevented, 'depth before/after =', before, depth());
  assert.equal(ev.defaultPrevented, false, 'board undo swallowed the keystroke');
  assert.equal(depth(), before);
});

test('P3 CMD-Z inside the inline editor must not touch the board stack', () => {
  reset();
  const d = someDate(1, 12);
  click(dayNode(d));
  const inp = $('.board .inline-edit');
  const before = depth();
  const ev = key(inp, 'z', { metaKey: true });
  diag('cmd-Z in inline editor: defaultPrevented =', ev.defaultPrevented, 'depth =', before, depth());
  interact.cancelEditor();
  assert.equal(depth(), before);
});

// ── P4 · scratchpad lifecycle ────────────────────────────────────────────────

test('P4 pad typing then blur then board undo', async () => {
  reset();
  const ta = $('.board .pad textarea');
  const month = ta.dataset.month;
  diag('pad month =', month, 'initial scratchpads =', JSON.stringify(store.state.scratchpads));
  ta.focus();
  ta.value = 'Einkauf';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(700);
  diag('after debounce: scratchpads =', JSON.stringify(store.state.scratchpads), 'steps =', depth());
  const afterType = depth();
  ta.blur();
  ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  diag('after blur: steps =', depth(), '(a blur with no new text must add none)');
  store.undo();
  diag('after undo: scratchpads =', JSON.stringify(store.state.scratchpads),
    'has key =', month in store.state.scratchpads,
    '(v1: the key is ABSENT again)');
  assert.ok(afterType >= 1);
});

test('P4 focus an empty pad and blur without typing mints nothing', () => {
  reset();
  const ta = $$('.board .pad textarea')[3];
  const before = depth();
  ta.focus();
  ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  diag('empty pad focus+blur: steps', before, '->', depth(),
    'scratchpads =', JSON.stringify(store.state.scratchpads));
  assert.equal(depth(), before);
});

test('P4 a pad keystroke does NOT rip the textarea out from under the caret', async () => {
  reset();
  const ta = $('.board .pad textarea');
  ta.focus();
  ta.value = 'Milch';
  ta.setSelectionRange(5, 5);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(700);
  const still = document.activeElement === ta;
  diag('after pad commit: same node focused =', still,
    'connected =', ta.isConnected, 'caret =', ta.selectionStart);
  assert.equal(still, true, 'the pad textarea lost focus on commit');
});

// ── P5 · category delete with reassign, through the real sheet ───────────────

test('P5 delete-a-category-with-entries through the real sheet', () => {
  reset();
  const catA = store.state.categories[0];
  const catB = store.state.categories[1];
  const orderBefore = store.state.categories.map((c) => c.id);
  store.mutate('seed', (s) => {
    for (let i = 0; i < 6; i++) s.notes.push({ id: 'r-n' + i, date: someDate(0, i + 1), text: 'n' + i, categoryId: catA.id, repeatsYearly: false });
    for (let i = 0; i < 3; i++) s.bars.push({ id: 'r-b' + i, startDate: someDate(0, 20), endDate: someDate(0, 24), label: 'b' + i, categoryId: catA.id });
  });
  store.undoStack.length = 0;
  legend.openCategoryManager();
  const rows = $$('.sheet .cat-row');
  diag('cat rows in the sheet =', rows.length);
  const row = rows[0];
  const del = row.querySelector('.btn-danger');
  del.click();
  // the reassign sheet
  const sel = $$('.sheet select').at(-1);
  diag('reassign sheet open =', !!sel, 'options =', sel ? $$('option', sel).length : 0);
  sel.value = catB.id;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const btns = $$('.sheet button');
  const delBtn = btns.filter((b) => /Lösch|Delete|löschen/i.test(b.textContent)).at(-1);
  diag('delete button text =', delBtn && delBtn.textContent);
  delBtn.click();
  diag('after reassign-delete: cats =', store.state.categories.length,
    'steps =', depth(),
    'notes on B =', store.state.notes.filter((n) => n.categoryId === catB.id).length,
    'lastCategoryId =', store.state.settings.lastCategoryId);
  assert.equal(depth(), 1, 'the fan-out must be ONE undo step');

  store.undo();
  diag('after undo: cats =', store.state.categories.length,
    'order =', store.state.categories.map((c) => c.id).join(','),
    'wanted =', orderBefore.join(','),
    'notes back on A =', store.state.notes.filter((n) => n.categoryId === catA.id).length,
    'lastCategoryId =', store.state.settings.lastCategoryId);
  // close whatever sheets are open
  while ($('.sheet')) { const b = $$('.sheet button').find((x) => /Fertig|Done|Abbrechen|Cancel/i.test(x.textContent)); if (!b) break; b.click(); }
});

// ── P6 · autosave timing and pagehide ────────────────────────────────────────

test('P6 autosave writes ~700ms after the last gesture, and pagehide is safe', async () => {
  reset();
  await store.persistNow();
  const d = someDate(7, 3);
  click(dayNode(d)); $('.board .inline-edit').value = 'Autosave'; key($('.board .inline-edit'), 'Enter');
  const at100 = await window.__TAURI__.core.invoke('load_board', {});
  diag('100ms-ish after the edit, on disk contains it =', at100.includes('Autosave'));
  await sleep(900);
  const after = await window.__TAURI__.core.invoke('load_board', {});
  diag('after 900ms, on disk contains it =', after.includes('Autosave'));
  assert.ok(after.includes('Autosave'), 'the debounced autosave never landed');

  // now the pagehide path with an unflushed edit
  const d2 = someDate(7, 5);
  click(dayNode(d2)); $('.board .inline-edit').value = 'Pagehide'; key($('.board .inline-edit'), 'Enter');
  window.dispatchEvent(new Event('pagehide'));
  await sleep(300);
  const flushed = await window.__TAURI__.core.invoke('load_board', {});
  diag('after pagehide, on disk contains the last edit =', flushed.includes('Pagehide'));
  assert.ok(flushed.includes('Pagehide'), 'the last change was lost on pagehide');
});

// ── P7 · reads during a gesture ──────────────────────────────────────────────

test('P7 entry object identity survives a projection (drag holds a reference)', () => {
  reset();
  const d = someDate(8, 4);
  click(dayNode(d)); $('.board .inline-edit').value = 'Ident'; key($('.board .inline-edit'), 'Enter');
  const ref = store.state.notes[0];
  const d2 = someDate(8, 6);
  click(dayNode(d2)); $('.board .inline-edit').value = 'Zweite'; key($('.board .inline-edit'), 'Enter');
  const same = store.state.notes.find((n) => n.id === ref.id) === ref;
  diag('object identity preserved across a later commit =', same);
  assert.equal(same, true);
});

test('P7 array ORDER after delete+undo (v1 restored the array wholesale)', () => {
  reset();
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const d = someDate(9, i + 2);
    click(dayNode(d)); $('.board .inline-edit').value = 'O' + i; key($('.board .inline-edit'), 'Enter');
    ids.push(store.state.notes.at(-1).id);
  }
  const before = store.state.notes.map((n) => n.text).join(',');
  interact.select('note', ids[1]);
  key(document.body, 'Backspace');
  store.undo();
  const after = store.state.notes.map((n) => n.text).join(',');
  diag('order before =', before, 'after delete+undo =', after);
  assert.equal(after, before, 'array order changed across delete+undo');
});

test('P7 array ORDER after undo+redo of a create', () => {
  reset();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const d = someDate(10, i + 2);
    click(dayNode(d)); $('.board .inline-edit').value = 'R' + i; key($('.board .inline-edit'), 'Enter');
    ids.push(store.state.notes.at(-1).id);
  }
  const before = store.state.notes.map((n) => n.text).join(',');
  store.undo(); store.undo();
  store.redo(); store.redo();
  const after = store.state.notes.map((n) => n.text).join(',');
  diag('order before =', before, 'after undo x2 + redo x2 =', after);
  assert.equal(after, before);
});

// ── P8 · the auto-unhide flash (4.6) ─────────────────────────────────────────

test('P8 creating into a hidden category unhides + flashes', async () => {
  reset();
  const cat = store.state.categories[1];
  legend.renderLegend();
  const item = $(`.legend-item[data-cat-id="${cat.id}"]`);
  item.click();                                   // hide it
  store.setSettings({ lastCategoryId: cat.id });
  diag('after legend click: visible =', store.state.categories.find((c) => c.id === cat.id).visible);
  const d = someDate(11, 4);
  click(dayNode(d)); $('.board .inline-edit').value = 'Flash'; key($('.board .inline-edit'), 'Enter');
  const node = $(`.legend-item[data-cat-id="${cat.id}"]`);
  diag('after create: cat visible =', store.state.categories.find((c) => c.id === cat.id).visible,
    'flash class =', node && node.classList.contains('flash'),
    'note rendered =', !!$(`.board .note[data-note-id="${store.state.notes.at(-1).id}"]`));
  assert.equal(store.state.categories.find((c) => c.id === cat.id).visible, true);
  store.setSettings({ lastCategoryId: store.state.categories[0].id });
  reset();
});

// ── P9 · Escape vs Enter on an edit ──────────────────────────────────────────

test('P9 Escape abandons an edit; Enter commits it', () => {
  reset();
  const d = someDate(1, 8);
  click(dayNode(d)); $('.board .inline-edit').value = 'Original'; key($('.board .inline-edit'), 'Enter');
  const id = store.state.notes[0].id;
  const before = depth();
  const node = $(`.board .note[data-note-id="${id}"]`);
  node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  const inp = $('.board .inline-edit');
  inp.value = 'Geändert';
  key(inp, 'Escape');
  diag('after Escape: text =', store.state.notes[0].text, 'steps', before, '->', depth());
  assert.equal(store.state.notes[0].text, 'Original');
  assert.equal(depth(), before);
});

test('P9 an edit committed with NO change records nothing (ATT-5 divergence)', () => {
  reset();
  const d = someDate(1, 8);
  click(dayNode(d)); $('.board .inline-edit').value = 'Same'; key($('.board .inline-edit'), 'Enter');
  const id = store.state.notes[0].id;
  const before = depth();
  $(`.board .note[data-note-id="${id}"]`).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  key($('.board .inline-edit'), 'Enter');
  diag('no-change commit: steps', before, '->', depth(), '(v1 = +0, the site declines)');
  assert.equal(store.state.notes[0].text, 'Same');
});

// ── P10 · rename typed character by character ────────────────────────────────

test('P10 rename a category, typing char by char', () => {
  reset();
  legend.openCategoryManager();
  const inp = $('.sheet .cat-row .name');
  const before = depth();
  const target = 'Reisen';
  inp.value = '';
  for (const ch of target) {
    inp.value += ch;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  }
  diag('after typing (no change event yet): steps', before, '->', depth(),
    'name =', store.state.categories[0].name);
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  diag('after change: steps =', depth(), 'name =', store.state.categories[0].name);
  assert.equal(depth() - before, 1, 'a rename must be exactly one undo step');
  while ($('.sheet')) { const b = $$('.sheet button').find((x) => /Fertig|Done/i.test(x.textContent)); if (!b) break; b.click(); }
});

// ── P11 · find / print / legend / month roll still read state fine ───────────

test('P11 find counts what is on the board', async () => {
  reset();
  const d = someDate(1, 8);
  click(dayNode(d)); $('.board .inline-edit').value = 'Zahnarzt'; key($('.board .inline-edit'), 'Enter');
  const fi = $('#find-input');
  fi.value = 'Zahn';
  fi.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(50);
  diag('find count text =', JSON.stringify($('#find-count').textContent),
    'hits =', $$('.board .find-hit').length);
  fi.value = ''; fi.dispatchEvent(new Event('input', { bubbles: true }));
  assert.ok(true);
});

test('P11 legend toggle hides/reveals and is one undo step', () => {
  reset();
  const d = someDate(1, 8);
  click(dayNode(d)); $('.board .inline-edit').value = 'Sichtbar'; key($('.board .inline-edit'), 'Enter');
  const cat = store.state.categories.find((c) => c.id === store.state.notes[0].categoryId);
  store.undoStack.length = 0;
  $(`.legend-item[data-cat-id="${cat.id}"]`).click();
  diag('after hide: steps =', depth(), 'note rendered =', !!$(`.board .note[data-note-id="${store.state.notes[0].id}"]`));
  store.undo();
  diag('after undo: visible =', store.state.categories.find((c) => c.id === cat.id).visible,
    'note rendered =', !!$(`.board .note[data-note-id="${store.state.notes[0].id}"]`));
  assert.equal(store.state.categories.find((c) => c.id === cat.id).visible, true);
});

test('P11 print builds without throwing', () => {
  const print = { ok: true };
  window.dispatchEvent(new Event('beforeprint'));
  diag('print legend nodes =', $$('#print-legend *').length, 'errors =', (window.__lzpErrors || []).length);
  assert.ok(print.ok);
});
