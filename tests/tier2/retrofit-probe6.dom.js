// TIER 2 · WP-3 ADVERSARY PROBE, round 6 — the scratchpad key-order finding,
// minimal and deterministic, plus what it does to board.json and to 11.5.

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
const padFor = (month) => $$('.board .pad textarea').find((t) => t.dataset.month === month);
const monthsOnBoard = () => $$('.board .col').map((c) => c.dataset.month);
const load = () => window.__TAURI__.core.invoke('load_board', {});

function reset() {
  popover.closePopover();
  store.state.notes = []; store.state.bars = []; store.state.scratchpads = {};
  store.undoStack.length = 0; store.redoStack.length = 0;
  interact.clearSelection();
  store.emit('reset');
}

/** Type into a month's scratchpad and commit it the way a blur does. */
function writePad(month, text) {
  const ta = padFor(month);
  if (!ta) return false;
  ta.focus();
  ta.value = text;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  return true;
}

// ── V1 · the minimal repro ──────────────────────────────────────────────────

test('V1 scratchpads written in NON-alphabetical month order, then a restart', async () => {
  reset();
  const ms = monthsOnBoard();
  // Write the LAST month first and the FIRST month last, so write order and
  // sort order are opposites. This is an ordinary thing to do: jot a note for
  // next summer, then one for this month.
  const late = ms[11], early = ms[0], mid = ms[5];
  assert.ok(writePad(late, 'Sommer nächstes Jahr'), 'no scratchpad for ' + late);
  writePad(mid, 'Mitte');
  writePad(early, 'Jetzt');
  const liveOrder = Object.keys(store.state.scratchpads);
  diag('write order  =', late, mid, early);
  diag('live key order =', liveOrder.join(','));

  await store.persistNow();
  const rawBefore = await load();
  const diskOrderBefore = Object.keys(JSON.parse(rawBefore).scratchpads);
  diag('board.json key order (written mid-session) =', diskOrderBefore.join(','));
  assert.deepEqual(diskOrderBefore, liveOrder, 'board.json follows the live object, as 11.4 says');

  // ── the restart ──
  await store.init();
  const afterOrder = Object.keys(store.state.scratchpads);
  diag('live key order AFTER the restart =', afterOrder.join(','));
  await store.persistNow();
  const rawAfter = await load();
  const diskOrderAfter = Object.keys(JSON.parse(rawAfter).scratchpads);
  diag('board.json key order (written after the restart) =', diskOrderAfter.join(','));
  diag('SAME BYTES? ', rawBefore === rawAfter);
  diag('same CONTENT? ', JSON.stringify(Object.entries(JSON.parse(rawBefore).scratchpads).sort())
    === JSON.stringify(Object.entries(JSON.parse(rawAfter).scratchpads).sort()));

  assert.deepEqual(
    Object.entries(JSON.parse(rawBefore).scratchpads).sort(),
    Object.entries(JSON.parse(rawAfter).scratchpads).sort(),
    'a scratchpad LOST TEXT across the restart');
  // The finding: same content, different key order, and therefore different bytes,
  // with no user action between the two writes.
  assert.deepEqual(diskOrderAfter, [...diskOrderBefore].sort(),
    'the restart re-sorted the scratchpad keys');
  assert.notEqual(rawBefore, rawAfter,
    'PINNED TO CURRENT BEHAVIOUR: board.json is not a fixed point of a restart. '
    + 'If this goes green-by-equality the gap was closed — invert the row.');
});

test('V1b a SECOND restart is stable — the churn is one-shot per session', async () => {
  const raw1 = await load();
  await store.init();
  await store.persistNow();
  const raw2 = await load();
  diag('restart 2 -> 3 identical =', raw1 === raw2);
  assert.equal(raw1, raw2, 'the sorted order is not a fixed point either');
});

test('V1c writing one more pad after the restart appends OUT of sort order again', async () => {
  const ms = monthsOnBoard();
  const target = ms.find((m) => !(m in store.state.scratchpads));
  diag('adding a pad for', target, 'to a board whose keys are currently',
    Object.keys(store.state.scratchpads).join(','));
  writePad(target, 'Nachtrag');
  const live = Object.keys(store.state.scratchpads);
  diag('live order after the append =', live.join(','));
  await store.persistNow();
  const disk = Object.keys(JSON.parse(await load()).scratchpads);
  diag('disk order =', disk.join(','), 'sorted =', [...disk].sort().join(','));
  diag('is the file sorted? ', disk.join(',') === [...disk].sort().join(','));
  assert.deepEqual(disk, live, '11.4 — the file still mirrors store.state exactly');
});

// ── V2 · does the reorder reach anything the user can see? ──────────────────

test('V2 the scratchpad TEXT stays with its month across the restart', () => {
  const ms = monthsOnBoard();
  const pairs = ms.map((m) => [m, padFor(m) ? padFor(m).value : null]).filter(([, v]) => v);
  diag('month -> rendered pad text:', JSON.stringify(pairs));
  for (const [m, v] of pairs) {
    assert.equal(v, store.state.scratchpads[m] || '',
      `the rendered pad for ${m} does not match the store`);
  }
});

// ── V3 · the same question for the daily snapshot (11.5) ────────────────────

test('V3 the snapshot ring carries the same reordered map', () => {
  const snaps = store.snapshots;
  diag('snapshots =', snaps.length);
  if (!snaps.length) skip('no snapshot in this run');
  const s = snaps[0];
  diag('snapshot keys =', Object.keys(s.state).join(','));
  diag('snapshot scratchpads order =', Object.keys(s.state.scratchpads || {}).join(','));
  assert.deepEqual(Object.keys(s.state).sort(),
    ['schemaVersion', 'notes', 'bars', 'categories', 'scratchpads', 'settings'].sort(),
    'the snapshot is not a v1-shaped board');
});

// ── V4 · notes/bars/categories are NOT affected (the list path reorders) ────

test('V4 lists are reconciled in projection order, so only the MAP drifts', async () => {
  reset();
  const dates = ['3', '1', '2'].map((i) => $$('.board .col')[Number(i)].querySelectorAll('.day[data-date]')[4].dataset.date);
  for (const [i, d] of dates.entries()) {
    click($(`.board .day[data-date="${d}"]`));
    const inp = $('.board .inline-edit');
    inp.value = 'N' + i;
    key(inp, 'Enter');
  }
  const before = store.state.notes.map((n) => n.text).join(',');
  await store.persistNow();
  const rawBefore = await load();
  await store.init();
  const after = store.state.notes.map((n) => n.text).join(',');
  await store.persistNow();
  const rawAfter = await load();
  diag('note order before =', before, 'after =', after);
  diag('board.json identical across the restart (no pads in play) =', rawBefore === rawAfter);
  assert.equal(after, before, 'note array order drifted across a restart');
  assert.equal(rawBefore, rawAfter,
    'with no scratchpads, board.json IS a fixed point — which isolates the finding to the map');
});

test('V5 no page errors', () => {
  diag('errors =', JSON.stringify(window.__lzpErrors || []));
  assert.deepEqual(window.__lzpErrors || [], []);
});
