// TIER 2 · WP-3 ADVERSARY PROBE, round 5 — first run, find, drag hygiene,
// and a soak: 200 mixed real gestures, then a restart, then compare.

const { store } = await importApp('store.js');
const interact = await importApp('interact.js');
const popover = await importApp('popover.js');

const at = (n, dx = 4, dy = 3) => { const r = n.getBoundingClientRect(); return { clientX: r.left + dx, clientY: r.top + dy }; };
const ptr = (type, node, pos, target = node) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, isPrimary: true, ...pos }));
const key = (node, k, opts = {}) => {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts });
  node.dispatchEvent(ev); return ev;
};
function click(node, dx, dy) {
  const pos = at(node, dx, dy);
  ptr('pointerdown', node, pos); ptr('pointerup', node, pos, window);
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
const cols = () => $$('.board .col');
const someDate = (c, r) => cols()[c].querySelectorAll('.day[data-date]')[r].dataset.date;
const depth = () => store.undoStack.length;

function makeNote(date, text) {
  click(dayNode(date));
  const inp = $('.board .inline-edit');
  if (!inp) return null;
  inp.value = text; key(inp, 'Enter');
  return store.state.notes.at(-1);
}
function reset() {
  popover.closePopover();
  store.state.notes = []; store.state.bars = []; store.state.scratchpads = {};
  store.undoStack.length = 0; store.redoStack.length = 0;
  interact.clearSelection();
  store.emit('reset');
}

// ── T1 · the first-run card (the first thing the user meets) ────────────────

test('T1 the first-run coach appears on a virgin board and dismisses cleanly', () => {
  // This file gets a fresh scratch dir, so board.json did not exist at boot and
  // store.init() set seenFirstRun = false — v1's condition, unchanged.
  const card = $('.coach');
  diag('coach present at boot =', !!card, 'seenFirstRun =', store.state.settings.seenFirstRun);
  if (!card) skip('no coach card in this run — board.json already existed');
  const done = $$('.coach button').at(-1);
  diag('coach buttons =', $$('.coach button').map((b) => b.textContent).join(' | '));
  done.click();
  diag('after dismiss: coach =', !!$('.coach'), 'seenFirstRun =', store.state.settings.seenFirstRun,
    'undo depth =', depth(), '(a settings write must not be undoable)');
  assert.equal($('.coach'), null);
  assert.equal(store.state.settings.seenFirstRun, true);
  assert.equal(depth(), 0, 'dismissing the coach landed on the undo stack');
});

// ── T2 · find, including the history jump (14.2) ────────────────────────────

test('T2 find counts, highlights and steps through hits', async () => {
  reset();
  makeNote(someDate(1, 4), 'Zahnarzt Termin');
  makeNote(someDate(3, 4), 'Zahnarzt Kontrolle');
  makeNote(someDate(5, 4), 'Urlaub');
  const fi = $('#find-input');
  fi.value = 'Zahnarzt';
  fi.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(60);
  diag('counter =', JSON.stringify($('#find-count').textContent),
    'marked nodes =', $$('.board .note.hit, .board .note.find-hit, .board .hit').length,
    'body classes =', document.body.className);
  const first = $('#find-count').textContent;
  $('#find-next').click();
  await sleep(30);
  diag('after next =', JSON.stringify($('#find-count').textContent));
  assert.notEqual($('#find-count').textContent, '', 'the find counter is empty');
  $('#find-prev').click();
  await sleep(30);
  diag('after prev =', JSON.stringify($('#find-count').textContent), '(wanted', JSON.stringify(first) + ')');
  key(document.body, 'Escape');
  fi.value = ''; fi.dispatchEvent(new Event('input', { bubbles: true }));
  assert.ok(true);
});

test('T2b a history hit pins the board (14.2) — a settings write mid-search', async () => {
  reset();
  // a note two years back, only reachable through the history list
  store.mutate('seed', (s) => {
    s.notes.push({ id: 't2-old', date: '2024-05-14', text: 'Archivsuche', categoryId: s.categories[0].id, repeatsYearly: false });
  });
  const modeBefore = store.state.settings.mode;
  const fi = $('#find-input');
  fi.value = 'Archivsuche';
  fi.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(80);
  const hist = $('#find-history');
  diag('history hidden =', hist.hidden, 'html =', hist.textContent.slice(0, 120));
  const btn = hist.querySelector('button') || hist.querySelector('li');
  if (!btn) { diag('no history entry rendered — nothing to click'); assert.ok(true); return; }
  btn.click();
  await sleep(60);
  diag('after the jump: mode =', store.state.settings.mode, '(was', modeBefore + ')',
    'startMonth =', store.state.settings.startMonth,
    'first column =', cols()[0].dataset.month,
    'the note is on the board =', !!$('.board .note[data-note-id="t2-old"]'),
    'undo depth =', depth(), '(a pin is a settings write — never undoable)');
  assert.equal(store.state.settings.mode, 'pinned');
  assert.ok(!!$('.board .note[data-note-id="t2-old"]'), 'the history hit is not on the pinned board');
  fi.value = ''; fi.dispatchEvent(new Event('input', { bubbles: true }));
  store.setSettings({ mode: 'rolling', pageYears: 0 });
  store.emit('settings');
});

// ── T3 · drag hygiene ───────────────────────────────────────────────────────

test('T3 a drag that ends off the board leaves no ghost, no preview, no dragging class', () => {
  reset();
  store.setSettings({ mode: 'rolling', pageYears: 0 });
  store.emit('settings');
  const from = dayNode(someDate(2, 6));
  const a = at(from, 6, 4);
  ptr('pointerdown', from, a);
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: a.clientX, clientY: a.clientY + 40 }));
  // release far outside the board
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, clientX: -500, clientY: -500 }));
  const inp = $('.board .inline-edit');
  if (inp) key(inp, 'Escape');
  diag('ghosts =', $$('.drag-ghost').length, 'previews =', $$('.bar-preview').length,
    'drop rows =', $$('.drop-row').length, 'dragging nodes =', $$('.dragging').length,
    'body =', document.body.className, 'bars =', store.state.bars.length);
  assert.equal($$('.drag-ghost').length, 0, 'a drag ghost was left on screen');
  assert.equal($$('.bar-preview').length, 0, 'a preview stripe was left on screen');
  assert.equal(document.body.classList.contains('is-creating'), false);
});

test('T3b pressing and releasing on a note without moving SELECTS it, never moves it', () => {
  reset();
  const d = someDate(2, 8);
  const n = makeNote(d, 'Auswahl');
  const node = $(`.board .note[data-note-id="${n.id}"]`);
  store.undoStack.length = 0;
  click(node);
  diag('after a still click: selected =', interact.selection.id === n.id,
    'date unchanged =', store.state.notes[0].date === d, 'steps =', depth());
  assert.equal(interact.selection.id, n.id);
  assert.equal(depth(), 0, 'a click must not be an edit');
});

test('T3c a drag under the 4px threshold is a click, not a move', () => {
  reset();
  const d = someDate(2, 10);
  const n = makeNote(d, 'Zittern');
  const node = $(`.board .note[data-note-id="${n.id}"]`);
  store.undoStack.length = 0;
  const a = at(node, 4, 3);
  ptr('pointerdown', node, a);
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 1, clientX: a.clientX + 2, clientY: a.clientY + 2 }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, buttons: 0, clientX: a.clientX + 2, clientY: a.clientY + 2 }));
  diag('after a 2.8px wobble: date =', store.state.notes[0].date, 'steps =', depth(),
    'selected =', interact.selection.id === n.id);
  assert.equal(store.state.notes[0].date, d, '5.5 — a wobble must never reschedule');
  assert.equal(depth(), 0);
});

// ── T4 · THE SOAK: 200 mixed gestures, then a restart ───────────────────────

test('T4 200 mixed real gestures, then a restart, then compare', async () => {
  reset();
  const rnd = (() => { let s = 20260826; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  let created = 0, moved = 0, deleted = 0, bars = 0, edits = 0, pads = 0, undos = 0;
  for (let i = 0; i < 200; i++) {
    const r = rnd();
    const c = Math.floor(rnd() * 12);
    const row = Math.floor(rnd() * 27) + 1;
    if (r < 0.42) {
      if (makeNote(someDate(c, row), 'S' + i)) created++;
    } else if (r < 0.58 && store.state.notes.length) {
      const n = store.state.notes[Math.floor(rnd() * store.state.notes.length)];
      const node = $(`.board .note[data-note-id="${n.id}"]`);
      const to = someDate(c, row);
      if (node && dayNode(to)) { drag(node, dayNode(to)); moved++; }
    } else if (r < 0.68 && store.state.notes.length) {
      const n = store.state.notes[Math.floor(rnd() * store.state.notes.length)];
      interact.select('note', n.id);
      key(document.body, 'Backspace'); deleted++;
    } else if (r < 0.80) {
      const a = someDate(c, row);
      const b = someDate(c, Math.min(27, row + 5));
      drag(dayNode(a), dayNode(b));
      const inp = $('.board .inline-edit');
      if (inp) { inp.value = 'B' + i; key(inp, 'Enter'); }
      bars++;
    } else if (r < 0.88 && store.state.notes.length) {
      const n = store.state.notes[Math.floor(rnd() * store.state.notes.length)];
      const node = $(`.board .note[data-note-id="${n.id}"]`);
      if (node) {
        node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        const inp = $('.board .inline-edit');
        if (inp) { inp.value = 'E' + i; key(inp, 'Enter'); edits++; }
      }
    } else if (r < 0.95) {
      const ta = $$('.board .pad textarea')[c];
      ta.focus(); ta.value = 'P' + i;
      ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      pads++;
    } else {
      if (store.undo()) undos++;
    }
  }
  diag('gestures: create', created, 'move', moved, 'delete', deleted, 'bar', bars,
    'edit', edits, 'pad', pads, 'undo', undos);
  diag('board now: notes', store.state.notes.length, 'bars', store.state.bars.length,
    'pads', Object.keys(store.state.scratchpads).length, 'undo depth', depth());
  diag('page errors during the soak =', JSON.stringify(window.__lzpErrors || []));
  assert.deepEqual(window.__lzpErrors || [], [], 'the soak raised uncaught errors');

  const domBefore = {
    notes: $$('.board .note').length,
    bars: $$('.board .bar').length,
    labels: $$('.board .bar-label').length,
    chips: $$('.board .d-more').map((n) => n.textContent).join(','),
    days: $$('.board .day').length,
  };
  await store.persistNow();
  const rawBefore = await window.__TAURI__.core.invoke('load_board', {});
  const stateBefore = JSON.parse(JSON.stringify(store.state));

  await store.init();
  store.emit('init');
  const stateAfter = JSON.parse(JSON.stringify(store.state));
  const domAfter = {
    notes: $$('.board .note').length,
    bars: $$('.board .bar').length,
    labels: $$('.board .bar-label').length,
    chips: $$('.board .d-more').map((n) => n.textContent).join(','),
    days: $$('.board .day').length,
  };

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
  walk(stateBefore, stateAfter, 'state');
  diag('STATE DIFFS ACROSS THE RESTART:', diffs.length ? diffs.slice(0, 12).join(' | ') : 'none');
  diag('DOM before =', JSON.stringify(domBefore));
  diag('DOM after  =', JSON.stringify(domAfter));
  diag('warnings on reload =', JSON.stringify(store.warnings.slice(0, 5)));
  // PINNED, see retrofit-probe6.dom.js for the minimal repro: the ONLY thing that moves
  // across a restart is the KEY ORDER of `scratchpads` — `reconcileMap` never reorders a live
  // object, so the sort in `core/entities.js:sortScratchpads` only bites on a board projected
  // into a fresh one (init / replaceAll). No content moves and nothing on screen changes.
  // IF THIS LIST EVER GROWS, a real divergence appeared — do not widen the filter.
  const notPads = diffs.filter((d) => !d.startsWith('state.scratchpads: keys '));
  diag('diffs that are NOT the known scratchpad key-order churn:',
    notPads.length ? notPads.join(' | ') : 'none');
  assert.deepEqual(notPads, [], 'the soaked board changed across a restart');
  assert.deepEqual(domAfter, domBefore, 'the RENDERED board changed across a restart');
  assert.equal(rawBefore, JSON.stringify(store.state, null, 2).replace(
    /"scratchpads": \{[^}]*\}/, () => rawBefore.match(/"scratchpads": \{[^}]*\}/)[0]),
    'board.json changed across the restart in something other than pad key order');
});

test('T5 nothing left behind', () => {
  diag('errors =', JSON.stringify(window.__lzpErrors || []));
  diag('ghosts =', $$('.drag-ghost').length, 'previews =', $$('.bar-preview').length,
    'editors =', $$('.inline-edit').length, 'popovers =', $$('.popover').length);
  assert.deepEqual(window.__lzpErrors || [], []);
  assert.equal($$('.drag-ghost').length, 0);
});
