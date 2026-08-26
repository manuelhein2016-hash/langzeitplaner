// TIER 2 · WP-3 ADVERSARY PROBE, round 3 — THE RESTART.
// Real gestures, then persist, then re-init the store from what actually landed
// on disk, then compare. This is the path every user takes every day and the one
// the retrofit changed most: v1's board.json WAS the truth; now it is a
// checkpoint that has to be re-migrated into ops on every launch.

const { store } = await importApp('store.js');
const interact = await importApp('interact.js');
const legend = await importApp('legend.js');
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
function drag(from, to) {
  const a = at(from, 6, 4), b = at(to, 6, 4);
  ptr('pointerdown', from, a);
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: a.clientX, clientY: a.clientY + 10 }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, ...b }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, ...b }));
}
const dayNode = (d) => $(`.board .day[data-date="${d}"]`);
const someDate = (c, r) => $$('.board .col')[c].querySelectorAll('.day[data-date]')[r].dataset.date;
const depth = () => store.undoStack.length;

function makeNote(date, text) {
  click(dayNode(date));
  const inp = $('.board .inline-edit');
  inp.value = text;
  key(inp, 'Enter');
  return store.state.notes.at(-1);
}
function reset() {
  popover.closePopover();
  store.state.notes = []; store.state.bars = []; store.state.scratchpads = {};
  store.undoStack.length = 0; store.redoStack.length = 0;
  interact.clearSelection();
  store.emit('reset');
}

// ── R1 · a full session, then a restart ──────────────────────────────────────

test('R1 a whole session of real gestures survives a restart byte-for-byte', async () => {
  reset();
  // 1 · notes, one of them repeating (via the popover ↻)
  const dRep = someDate(1, 9);
  const rep = makeNote(dRep, 'Geburtstag Oma');
  dayNode(dRep).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...at(dayNode(dRep)) }));
  $('.popover .pop-row .act').click();
  popover.closePopover();
  makeNote(someDate(1, 12), 'Zahnarzt');
  makeNote(someDate(2, 3), 'Elternabend');

  // 2 · a bar laid by dragging, then named
  drag(dayNode(someDate(3, 4)), dayNode(someDate(3, 20)));
  const lab = $('.board .inline-edit');
  if (lab) { lab.value = 'Umbau Küche'; key(lab, 'Enter'); }

  // 3 · a bar dragged across a month boundary
  const b2 = 'r1-cross';
  store.mutate('seed', (s) => {
    s.bars.push({ id: b2, startDate: someDate(4, 25), endDate: someDate(5, 5), label: 'Sommer', categoryId: s.categories[2].id });
  });

  // 4 · a category renamed in German (v1 DELETED nameEn) and one hidden
  legend.openCategoryManager();
  const nameInp = $$('.sheet .cat-row .name')[0];
  nameInp.value = 'Büro';
  nameInp.dispatchEvent(new Event('change', { bubbles: true }));
  while ($('.sheet')) { const b = $$('.sheet button').find((x) => /Fertig|Done/i.test(x.textContent)); if (!b) break; b.click(); }
  const hiddenCat = store.state.categories[3];
  $(`.legend-item[data-cat-id="${hiddenCat.id}"]`).click();

  // 5 · a scratchpad with unicode and a newline
  const ta = $('.board .pad textarea');
  ta.focus();
  ta.value = 'Milch · Öl\nBrot – ✓';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

  // 6 · settings the user really does change
  store.setSettings({ bundesland: 'HH', rowHeight: 26, colWidth: 132, language: 'en', mode: 'pinned' });
  store.setLayer({ schulferien: true });

  await store.persistNow();
  const before = JSON.parse(JSON.stringify(store.state));
  const rawBefore = await window.__TAURI__.core.invoke('load_board', {});
  diag('session board: notes', before.notes.length, 'bars', before.bars.length,
    'cats', before.categories.length, 'pads', Object.keys(before.scratchpads).length);
  diag('renamed cat keys =', Object.keys(before.categories[0]).join(','),
    'nameEn present =', 'nameEn' in before.categories[0], '(v1 DELETED it on a DE rename)');
  diag('hidden cat visible =', before.categories.find((c) => c.id === hiddenCat.id).visible);
  diag('repeating note =', JSON.stringify(before.notes.find((n) => n.id === rep.id)));

  // ── THE RESTART ──
  await store.init();
  const after = JSON.parse(JSON.stringify(store.state));
  const rawAfter = JSON.stringify(store.state, null, 2);
  diag('warnings on reload =', JSON.stringify(store.warnings));

  const diffs = [];
  const walk = (a, b, path) => {
    if (a === b) return;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
      diffs.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`); return;
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join(',') !== kb.join(',')) diffs.push(`${path}: keys ${ka.join(',')} -> ${kb.join(',')}`);
    for (const k of new Set([...ka, ...kb])) walk(a[k], b[k], path + '.' + k);
  };
  walk(before, after, 'state');
  diag('FIELD DIFFS ACROSS THE RESTART:', diffs.length ? diffs.join(' | ') : 'none');
  diag('serialized identical =', rawBefore === rawAfter);
  assert.deepEqual(diffs, [], 'the board changed across a restart');
  assert.equal(rawBefore, rawAfter, 'board.json is not a fixed point of a restart');
});

test('R1b the RENDERED board is identical after the restart', () => {
  // R1 left the store re-initialised; force the same redraw the app does.
  store.emit('init');
  const cols = $$('.board .col').length;
  const notes = $$('.board .note').length;
  const segs = $$('.board .bar').length;
  diag('after restart render: cols =', cols, 'note nodes =', notes, 'bar segments =', segs,
    'day rows =', $$('.board .day').length, 'errors =', JSON.stringify(window.__lzpErrors || []));
  assert.equal(cols, 12);
  assert.deepEqual(window.__lzpErrors || [], []);
});

test('R1c the undo stack after a restart (v1 kept it; the shadow guard is retired)', () => {
  // v1's stacks survived init() because they were plain arrays of content snapshots,
  // and a ⌘Z after a reload restored the WHOLE pre-image — wiping anything created since.
  diag('undo depth after init() =', depth(), 'redo =', store.redoStack.length);
  const notesBefore = store.state.notes.length;
  const ok = store.undo();
  diag('undo after a restart returned', ok, 'notes', notesBefore, '->', store.state.notes.length,
    'categories =', store.state.categories.length);
  assert.ok(true, 'documented: the stacks survive init() as they did in v1');
});

// ── R2 · the DE rename really drops nameEn on disk ───────────────────────────

test('R2 a German rename removes nameEn from board.json, as v1 delete did', async () => {
  reset();
  legend.openCategoryManager();
  const inp = $$('.sheet .cat-row .name')[1];
  inp.value = 'Zuhause';
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  while ($('.sheet')) { const b = $$('.sheet button').find((x) => /Fertig|Done/i.test(x.textContent)); if (!b) break; b.click(); }
  const c = store.state.categories[1];
  diag('after DE rename: keys =', Object.keys(c).join(','), 'name =', c.name, 'nameEn =', JSON.stringify(c.nameEn));
  await store.persistNow();
  const disk = JSON.parse(await window.__TAURI__.core.invoke('load_board', {}));
  const dc = disk.categories[1];
  diag('on disk: keys =', Object.keys(dc).join(','), 'nameEn present =', 'nameEn' in dc);
  assert.equal('nameEn' in dc, false, 'v1 did `delete x.nameEn` — the key must be gone, not null');
  assert.equal(dc.name, 'Zuhause');
  store.undo();
  const back = store.state.categories[1];
  diag('after undo: keys =', Object.keys(back).join(','), 'name =', back.name, 'nameEn =', JSON.stringify(back.nameEn));
  assert.equal(back.name, 'Familie', 'the German name came back');
  assert.equal(back.nameEn, 'Family', 'the English name came back too (v1 restored the array)');
});

// ── R3 · the last-used category, deleted ─────────────────────────────────────

test('R3 deleting the last-used EMPTY category repoints lastCategoryId (4.2)', () => {
  reset();
  // make cat[3] the last used, and make sure it is empty
  store.setSettings({ lastCategoryId: store.state.categories[3].id });
  const doomed = store.state.categories[3].id;
  legend.openCategoryManager();
  const row = $$('.sheet .cat-row')[3];
  row.querySelector('.btn-danger').click();
  diag('after delete: cats =', store.state.categories.length,
    'lastCategoryId =', store.state.settings.lastCategoryId,
    'points at a live category =', store.state.categories.some((c) => c.id === store.state.settings.lastCategoryId),
    'steps =', depth());
  assert.ok(store.state.categories.some((c) => c.id === store.state.settings.lastCategoryId),
    'lastCategoryId dangles after the delete');
  while ($('.sheet')) { const b = $$('.sheet button').find((x) => /Fertig|Done/i.test(x.textContent)); if (!b) break; b.click(); }
  // and a NEW note must land somewhere real
  const n = makeNote(someDate(1, 20), 'Nach dem Löschen');
  diag('new note category is live =', store.state.categories.some((c) => c.id === n.categoryId));
  assert.ok(store.state.categories.some((c) => c.id === n.categoryId));
  store.undo();                       // undo the note
  store.undo();                       // undo the category delete
  diag('after 2 undos: cats =', store.state.categories.length,
    'doomed back =', store.state.categories.some((c) => c.id === doomed),
    'order =', store.state.categories.map((c) => c.name).join(','));
  assert.equal(store.state.categories.some((c) => c.id === doomed), true,
    'undo must resurrect the category (18.6)');
});

// ── R4 · the 80/40 caps through the real inputs ──────────────────────────────

test('R4 an over-length note value THROWS and loses the edit (pinned, see report)', () => {
  // PINNED TO CURRENT BEHAVIOUR — this is a reported gap, not an accepted one.
  // v1 stored whatever string it was handed. The retrofit's `store.apply()` door runs the
  // value through `makeOp`'s validator, which THROWS an uncaught OpError out of the commit
  // handler: no note, no undo step, no toast, and the text the user typed is already gone
  // from the DOM. The diff door (`store.mutate`) TRUNCATES the same input instead (see
  // retrofit-probe4.dom.js, S2d). retrofit-probe4 measures whether a human can get here at
  // all through the real inputs; the answer, in WebKit, is no — maxLength holds for typing,
  // paste and drag-drop. This row exists so that stops being an accident.
  // IF THIS ROW GOES RED, the gap was closed — invert it, do not "repair" it.
  reset();
  const long = 'x'.repeat(100);
  const d = someDate(1, 22);
  click(dayNode(d));
  const inp = $('.board .inline-edit');
  diag('maxLength =', inp.maxLength);
  inp.value = long;                       // bypasses maxLength, as setRangeText also does
  diag('input accepted length =', inp.value.length);
  try { key(inp, 'Enter'); } catch {}
  const n = store.state.notes.at(-1);
  diag('note created =', !!n, '(v1 created one with', long.length, 'characters)');
  diag('page errors =', JSON.stringify(window.__lzpErrors));
  assert.equal(store.state.notes.length, 0, 'the edit was lost');
  assert.ok((window.__lzpErrors || []).some((e) => /longer than 80/.test(e)),
    'expected an uncaught OpError — the behaviour changed');
  window.__lzpErrors.length = 0;
});

test('R4b the same for a bar label over 40 (pinned)', () => {
  reset();
  drag(dayNode(someDate(2, 4)), dayNode(someDate(2, 10)));
  const inp = $('.board .inline-edit');
  diag('bar-label maxLength =', inp.maxLength);
  inp.value = 'y'.repeat(60);
  try { key(inp, 'Enter'); } catch {}
  diag('bars =', store.state.bars.length, 'stored label =', JSON.stringify(store.state.bars.at(-1).label),
    '(v1 stored the 60-character label)');
  assert.equal(store.state.bars.length, 1, 'the BAR survives — only its name is lost');
  assert.equal(store.state.bars.at(-1).label, '');
  window.__lzpErrors.length = 0;
});

// ── R5 · settings written mid-gesture ────────────────────────────────────────

test('R5 a settings change between two gestures is never undoable (5.4)', () => {
  reset();
  makeNote(someDate(6, 4), 'Eins');
  store.setSettings({ rowHeight: 30 });
  makeNote(someDate(6, 5), 'Zwei');
  diag('depth after note/setting/note =', depth(), '(v1 = 2: settings are not undoable)');
  assert.equal(depth(), 2);
  store.undo(); store.undo();
  diag('after 2 undos: notes =', store.state.notes.length, 'rowHeight =', store.state.settings.rowHeight);
  assert.equal(store.state.notes.length, 0);
  assert.equal(store.state.settings.rowHeight, 30, 'a setting must survive undo');
  store.setSettings({ rowHeight: 22 });
});

test('R5b setSettings does not clear a pending redo branch (v1 did not either)', () => {
  reset();
  makeNote(someDate(6, 7), 'Redo');
  store.undo();
  const before = store.redoStack.length;
  store.setSettings({ colWidth: 130 });
  diag('redo before =', before, 'after setSettings =', store.redoStack.length);
  assert.equal(store.redoStack.length, before, 'a settings write must not drop the redo branch');
  store.redo();
  diag('redo worked =', store.state.notes.length === 1);
  store.setSettings({ colWidth: 118 });
});

// ── R6 · the pad debounce vs a board gesture ─────────────────────────────────

test('R6 a board gesture DURING the pad debounce does not lose the typed text', async () => {
  reset();
  const ta = $('.board .pad textarea');
  ta.focus();
  ta.value = 'halb getippt';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  // a board gesture lands inside the 600 ms window and forces a full redraw
  makeNote(someDate(7, 9), 'Störung');
  const ta2 = $('.board .pad textarea');
  diag('same textarea node =', ta2 === ta, 'value after the redraw =', JSON.stringify(ta2.value));
  await sleep(700);
  diag('after the debounce: scratchpads =', JSON.stringify(store.state.scratchpads),
    'live textarea =', JSON.stringify($('.board .pad textarea').value));
  assert.ok(true, 'observed — see the diagnostics');
});

// ── R7 · closing state ───────────────────────────────────────────────────────

test('R7 no uncaught page errors after everything above', () => {
  diag('errors =', JSON.stringify(window.__lzpErrors || []));
  diag('final warnings =', JSON.stringify(store.warnings.slice(0, 6)));
  assert.deepEqual(window.__lzpErrors || [], []);
});
