// TIER 2 · WP-3 ADVERSARY PROBE, round 4 — is the over-length throw REACHABLE?
// Round 3 found that a note text over 80 characters (or a bar label over 40)
// makes `store.apply()` throw an uncaught OpError out of the commit handler and
// silently drops the edit, where v1 stored the long value. This file asks the
// only question that matters: can a user get such a value into the input at all,
// with maxLength=80 in force, in the real engine?

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
const someDate = (c, r) => $$('.board .col')[c].querySelectorAll('.day[data-date]')[r].dataset.date;
const depth = () => store.undoStack.length;
const LONG = 'L'.repeat(140);

function reset() {
  popover.closePopover();
  store.state.notes = []; store.state.bars = []; store.state.scratchpads = {};
  store.undoStack.length = 0; store.redoStack.length = 0;
  interact.clearSelection();
  window.__lzpErrors.length = 0;
  store.emit('reset');
}

/** Everything a person can physically do to get text into a focused <input>. */
function fillAttempts(inp) {
  const out = {};
  const measure = (name, fn) => {
    inp.value = '';
    try { fn(); } catch (e) { out[name] = 'threw: ' + e.message; return; }
    out[name] = inp.value.length;
  };
  measure('execCommand insertText', () => {
    inp.focus();
    document.execCommand('insertText', false, LONG);
  });
  measure('paste event + insertText', () => {
    inp.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', LONG);
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    const notCancelled = inp.dispatchEvent(ev);
    // If nothing handles it, WebKit's default paste runs; emulate with insertText,
    // which is the same editing command a real ⌘V issues.
    if (notCancelled && !inp.value) document.execCommand('insertText', false, LONG);
  });
  measure('drop text/plain', () => {
    inp.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', LONG);
    const notCancelled = inp.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    if (notCancelled && !inp.value) document.execCommand('insertText', false, LONG);
  });
  measure('setRangeText', () => { inp.focus(); inp.setRangeText(LONG, 0, 0, 'end'); });
  measure('per-character typing', () => {
    inp.focus();
    for (const ch of LONG) document.execCommand('insertText', false, ch);
  });
  measure('direct .value assignment', () => { inp.value = LONG; });
  return out;
}

// ── S1 · can 80+ characters get into the note editor at all? ────────────────

test('S1 how many characters each real input route puts into a maxLength=80 field', () => {
  reset();
  click(dayNode(someDate(1, 6)));
  const inp = $('.board .inline-edit');
  assert.equal(inp.maxLength, 80);
  const r = fillAttempts(inp);
  for (const [k, v] of Object.entries(r)) diag('  note editor ·', k, '=>', v, 'chars');
  interact.cancelEditor();
  const overshoot = Object.entries(r).filter(([, v]) => typeof v === 'number' && v > 80).map(([k]) => k);
  diag('ROUTES THAT EXCEED 80:', overshoot.length ? overshoot.join(', ') : 'none');
  assert.ok(true, 'measured — see the diagnostics');
});

test('S1b the same for the popover inputs and the bar-label editor', () => {
  reset();
  const d = someDate(1, 7);
  const dn = dayNode(d);
  dn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...at(dn) }));
  $('.popover .pop-add').click();
  const pinp = $('.popover .pop-new .txt');
  const rp = fillAttempts(pinp);
  for (const [k, v] of Object.entries(rp)) diag('  popover add ·', k, '=>', v, 'chars');
  pinp.value = '';
  key(pinp, 'Escape');
  popover.closePopover();

  reset();
  drag(dayNode(someDate(2, 4)), dayNode(someDate(2, 9)));
  const binp = $('.board .inline-edit');
  assert.equal(binp.maxLength, 40);
  const rb = fillAttempts(binp);
  for (const [k, v] of Object.entries(rb)) diag('  bar label ·', k, '=>', v, 'chars');
  interact.cancelEditor();
  reset();
});

// ── S2 · what the app does when the value IS over the cap ───────────────────

test('S2 an over-length note commit: the edit is lost and an OpError escapes', () => {
  reset();
  const d = someDate(3, 6);
  click(dayNode(d));
  const inp = $('.board .inline-edit');
  inp.value = LONG;                       // whatever route got it here
  const before = depth();
  let threw = null;
  try { key(inp, 'Enter'); } catch (e) { threw = String(e && e.message); }
  diag('notes after the commit =', store.state.notes.length, '(v1: 1, text 140 chars)');
  diag('undo steps', before, '->', depth());
  diag('editor still on screen =', !!$('.board .inline-edit'), '(the typed text is gone either way)');
  diag('page errors =', JSON.stringify(window.__lzpErrors));
  diag('threw synchronously to the caller =', threw);
  assert.equal(store.state.notes.length, 0,
    'DIVERGENCE: v1 created the note with the long text; the retrofit creates nothing');
  assert.ok((window.__lzpErrors || []).some((e) => /longer than 80/.test(e)),
    'no OpError was reported — the failure was even quieter than expected');
  window.__lzpErrors.length = 0;
});

test('S2b the board is still usable after the throw', () => {
  reset();
  const d = someDate(3, 8);
  click(dayNode(d));
  const inp = $('.board .inline-edit');
  inp.value = LONG;
  try { key(inp, 'Enter'); } catch {}
  window.__lzpErrors.length = 0;
  // and now a normal gesture
  const d2 = someDate(3, 10);
  click(dayNode(d2));
  const inp2 = $('.board .inline-edit');
  assert.ok(inp2, 'no editor opened after the throw — the board is wedged');
  inp2.value = 'danach';
  key(inp2, 'Enter');
  diag('after the throw, a normal note still works =', store.state.notes.length === 1,
    'errors =', JSON.stringify(window.__lzpErrors));
  assert.equal(store.state.notes.length, 1);
  assert.deepEqual(window.__lzpErrors, []);
});

test('S2c an over-length bar label: the bar survives, the NAME is lost', () => {
  reset();
  drag(dayNode(someDate(4, 4)), dayNode(someDate(4, 12)));
  const inp = $('.board .inline-edit');
  inp.value = 'Z'.repeat(60);
  try { key(inp, 'Enter'); } catch {}
  diag('bars =', store.state.bars.length, 'label =', JSON.stringify(store.state.bars[0]?.label),
    '(v1: the 60-char label)', 'errors =', JSON.stringify(window.__lzpErrors));
  assert.equal(store.state.bars.length, 1);
  assert.equal(store.state.bars[0].label, '', 'the label the user typed was dropped');
  window.__lzpErrors.length = 0;
});

test('S2d the two doors disagree: mutate() truncates where apply() throws', () => {
  reset();
  // the diff door — what a v1-era caller and the characterization harness use
  let mutErr = null;
  try {
    store.mutate('long', (s) => {
      s.notes.push({ id: 'long-1', date: someDate(5, 4), text: LONG, categoryId: s.categories[0].id, repeatsYearly: false });
    });
  } catch (e) { mutErr = String(e.message); }
  const n = store.state.notes.find((x) => x.id === 'long-1');
  diag('mutate() door: threw =', mutErr, 'stored length =', n && n.text.length,
    'warnings =', JSON.stringify(store.warnings.slice(-1)));
  assert.ok(n, 'the diff door dropped the note entirely');
  assert.equal(n.text.length, 80, 'the diff door TRUNCATES');
  diag('=> apply() throws and loses the edit; mutate() truncates and warns. Same input, two doors.');
});

// ── S3 · the native-menu undo path near a field ─────────────────────────────

test('S3 the native menu Undo respects a focused text field (13.7 / 10.2)', () => {
  reset();
  const d = someDate(6, 4);
  click(dayNode(d));
  const inp = $('.board .inline-edit');
  inp.value = 'Menu';
  key(inp, 'Enter');
  const before = depth();
  const ta = $('.board .pad textarea');
  ta.focus();
  window.__lzpEmit('menu', 'undo');
  diag('menu undo with a textarea focused: depth', before, '->', depth(),
    'notes =', store.state.notes.length);
  assert.equal(depth(), before, 'the native menu Undo hit the BOARD stack while typing');
  document.body.focus();
  ta.blur();
  window.__lzpEmit('menu', 'undo');
  diag('menu undo with nothing focused: depth =', depth(), 'notes =', store.state.notes.length);
  assert.equal(depth(), before - 1, 'the native menu Undo did not reach the board');
});

// ── S4 · a create-bar drag that crosses columns ─────────────────────────────

test('S4 a diagonal create-bar drag spanning two months', () => {
  reset();
  const from = someDate(7, 24);
  const to = someDate(8, 6);
  drag(dayNode(from), dayNode(to));
  const inp = $('.board .inline-edit');
  if (inp) key(inp, 'Escape');
  const b = store.state.bars[0];
  diag('cross-column create-bar:', b && b.startDate, '->', b && b.endDate,
    'wanted', from, to, 'segments =', $$(`.board .bar[data-bar-id="${b?.id}"]`).length,
    'steps =', depth());
  assert.ok(b, 'no bar was created');
  assert.equal(b.startDate, from);
  assert.equal(b.endDate, to);
  assert.equal(depth(), 1);
});

test('S4b an upward create-bar drag normalises the range (3.5)', () => {
  reset();
  const from = someDate(9, 18);
  const to = someDate(9, 4);
  drag(dayNode(from), dayNode(to));
  const inp = $('.board .inline-edit');
  if (inp) key(inp, 'Escape');
  const b = store.state.bars[0];
  diag('upward drag:', b && b.startDate, '->', b && b.endDate, '(wanted', to, from + ')');
  assert.equal(b.startDate, to);
  assert.equal(b.endDate, from);
});

// ── S5 · closing ────────────────────────────────────────────────────────────

test('S5 no page errors left behind by the clean paths', () => {
  reset();
  diag('errors =', JSON.stringify(window.__lzpErrors));
  assert.deepEqual(window.__lzpErrors, []);
});
