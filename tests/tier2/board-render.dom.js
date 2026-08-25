// TIER 2 · CHARACTERIZATION — the DOM board.js actually produces, in WebKit.
//
// Plain script, not a module: use `await importApp('x.js')`, no `import`
// statements, no top-level `return`. Globals: test, assert, $, $$, waitFor,
// sleep, importApp, diag.

const { store } = await importApp('store.js');
const { buildBoard } = await importApp('layout.js');
const { renderBoard } = await importApp('board.js');

const board = () => $('#board');
const redraw = () => renderBoard(board());
const model = () => buildBoard(store.state);

// Restore the board to defaults after a test that changed settings.
async function withSettings(patch, fn) {
  const before = JSON.parse(JSON.stringify(store.state.settings));
  const { layers, ...rest } = patch;
  try {
    Object.assign(store.state.settings, rest);
    if (layers) Object.assign(store.state.settings.layers, layers);
    redraw();
    await fn();
  } finally {
    store.state.settings = before;
    redraw();
  }
}

// ── skeleton ─────────────────────────────────────────────────────────────────

test('the board renders 12 columns of 31 day rows', () => {
  assert.equal($$('.board .col').length, 12);
  assert.equal($$('.board .day').length, 372, '12 × 31 rows are always laid out');
  for (const col of $$('.board .col')) {
    assert.equal($$('.day', col).length, 31, col.dataset.month + ' row count');
  }
});

test('short months are padded with .void rows carrying no date', () => {
  const dated = $$('.board .day[data-date]').length;
  const voids = $$('.board .day.void').length;
  assert.equal(dated + voids, 372);
  const m = model();
  const expected = m.cols.reduce((n, c) => n + c.len, 0);
  assert.equal(dated, expected, 'one dated row per real calendar day');
  for (const v of $$('.board .day.void')) {
    assert.equal(v.dataset.date, undefined, 'a void row must not be addressable');
  }
});

test('columns are in chronological order and carry their month key', () => {
  const keys = $$('.board .col').map((c) => c.dataset.month);
  assert.equal(keys.length, 12);
  assert.deepEqual(keys, model().cols.map((c) => c.key));
  for (let i = 1; i < keys.length; i++) {
    assert.ok(keys[i - 1] < keys[i], 'columns out of order at ' + keys[i]);
  }
  assert.deepEqual(
    $$('.board .col').map((c) => c.dataset.index),
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']
  );
});

test('every dated row has its zero-padded number and localised weekday', () => {
  const m = model();
  for (const col of m.cols) {
    for (const d of col.days) {
      if (d.empty) continue;
      const node = $(`.board .day[data-date="${d.date}"]`);
      assert.ok(node, 'missing row for ' + d.date);
      assert.equal($('.d-num', node).textContent, d.n);
      assert.equal($('.d-wd', node).textContent, d.wd);
    }
  }
});

test('weekends carry .we, today carries .today, and its column is marked', () => {
  const m = model();
  const weekendDates = m.cols.flatMap((c) => c.days.filter((d) => !d.empty && d.weekend).map((d) => d.date));
  assert.equal($$('.board .day.we').length, weekendDates.length);
  for (const date of weekendDates) {
    assert.ok($(`.board .day[data-date="${date}"]`).classList.contains('we'), date);
  }
  const today = $$('.board .day.today');
  assert.equal(today.length, 1);
  assert.equal(today[0].dataset.date, m.today);
  assert.equal($$('.board .col.is-today-month').length, 1);
  assert.equal($('.board .col.is-today-month').dataset.month, m.today.slice(0, 7));
});

test('density variables live on :root, never as resolved pixels on the rows', () => {
  redraw();
  assert.equal(document.documentElement.style.getPropertyValue('--row-h'), `${model().rowH}px`);
  assert.equal(document.documentElement.style.getPropertyValue('--col-w'), `${model().colW}px`);
  // Row heights come from CSS, so the print stylesheet can re-metric the very
  // same DOM by overriding the variables on <body> (F12).
  assert.match($('.board .rows').style.height, /^calc\(var\(--row-h\) \* 31\)$/);
});

test('every column carries a scratchpad textarea keyed by month', () => {
  const pads = $$('.board .pad textarea');
  assert.equal(pads.length, 12);
  assert.deepEqual(pads.map((p) => p.dataset.month), model().cols.map((c) => c.key));
  assert.ok($('.board .pad').classList.contains('empty'), 'an untouched pad is dimmed');
});

// ── holidays (F6 / 6.5) ──────────────────────────────────────────────────────

test('nationwide holidays render as .d-hol chips with the full name on hover', () => {
  const chips = $$('.board .d-hol');
  assert.ok(chips.length > 0, 'no holidays rendered at all');
  const m = model();
  const expected = m.cols.flatMap((c) => c.days.filter((d) => !d.empty && d.holidayShown));
  assert.equal(chips.length, expected.length);
  for (const d of expected) {
    const chip = $(`.board .day[data-date="${d.date}"] .d-hol`);
    assert.ok(chip, 'no chip on ' + d.date);
    assert.equal(chip.textContent, d.holiday.short);
    assert.equal(chip.title, d.holiday.name, 'full name is one hover away');
  }
});

test('with no Bundesland exactly the nine nationwide holidays are shown', async () => {
  await withSettings({ bundesland: '', layers: { feiertage: true, otherStates: false } }, () => {
    const chips = $$('.board .d-hol');
    assert.equal(chips.filter((c) => c.classList.contains('foreign')).length, 0,
      'nothing is dimmed when nothing foreign is shown');
    // Which twelve months are visible depends on the wall clock (rolling mode),
    // and Easter-based dates can fall twice inside one window — so assert the
    // SET of names, which is stable, not the count.
    const names = [...new Set(chips.map((c) => c.title))].sort();
    assert.deepEqual(names, [
      '1. Weihnachtstag', '2. Weihnachtstag', 'Christi Himmelfahrt', 'Karfreitag',
      'Neujahr', 'Ostermontag', 'Pfingstmontag', 'Tag der Arbeit',
      'Tag der Deutschen Einheit',
    ]);
  });
});

test('the otherStates layer adds foreign holidays, marked .foreign', async () => {
  await withSettings({ bundesland: 'BY', layers: { feiertage: true, otherStates: true } }, () => {
    const chips = $$('.board .d-hol');
    const foreign = chips.filter((c) => c.classList.contains('foreign'));
    assert.ok(foreign.length > 0, 'no foreign holidays surfaced');
    assert.ok(chips.length > 9, 'the union is larger than the nationwide set');
    // Bavaria's own regional holidays are NOT dimmed.
    const own = chips.filter((c) => !c.classList.contains('foreign')).map((c) => c.title);
    assert.includes(own, 'Allerheiligen');
    assert.includes(foreign.map((c) => c.title), 'Reformationstag');
  });
});

test('a holiday demoted by a note keeps a gutter dot and a tooltip, not a chip', async () => {
  const chip = $('.board .d-hol');
  const date = chip.closest('.day').dataset.date;
  const fullName = chip.title;
  const catId = store.state.categories[0].id;
  store.state.notes.push({ id: 'dom-demote', date, text: 'belegt', categoryId: catId, repeatsYearly: false });
  try {
    // rowHeight 18 → capacity 1 → the note claims the only line (challenge 2).
    await withSettings({ rowHeight: 18 }, () => {
      const row = $(`.board .day[data-date="${date}"]`);
      assert.equal($('.d-hol', row), null, 'the chip is gone');
      assert.ok($('.d-holdot', row), 'the gutter dot is there');
      assert.ok(row.classList.contains('hol'), 'the row is still tinted');
      assert.equal(row.title, fullName, 'the holiday name survives as a tooltip');
      assert.equal($$('.note', row).length, 1, 'the note is shown');
    });
  } finally {
    store.state.notes = store.state.notes.filter((n) => n.id !== 'dom-demote');
    redraw();
  }
});

// ── notes and bars ───────────────────────────────────────────────────────────

test('notes render tinted by category with the full text on hover', async () => {
  const cat = store.state.categories[2]; // Reisen / orange
  const date = model().cols[3].days[9].date;
  store.state.notes.push({ id: 'dom-note', date, text: 'Kanufahrt auf der Lahn', categoryId: cat.id, repeatsYearly: false });
  try {
    redraw();
    const node = $('.board .note[data-note-id="dom-note"]');
    assert.ok(node);
    assert.equal(node.dataset.date, date);
    assert.equal(node.title, 'Kanufahrt auf der Lahn');
    assert.equal(node.style.color, 'rgb(217, 130, 15)', 'palette ref "orange"');
    assert.equal($('.rep', node), null, 'no repeat marker on a one-off');
  } finally {
    store.state.notes = store.state.notes.filter((n) => n.id !== 'dom-note');
    redraw();
  }
});

test('a yearly note puts its ↻ marker BEFORE the text so truncation cannot eat it', async () => {
  const date = model().cols[3].days[10].date;
  store.state.notes.push({ id: 'dom-rep', date, text: 'Geburtstag', categoryId: store.state.categories[0].id, repeatsYearly: true });
  try {
    redraw();
    const node = $('.board .note[data-note-id="dom-rep"]');
    assert.equal(node.firstChild.className, 'rep');
    assert.equal(node.firstChild.textContent, '↻');
    assert.match(node.textContent, /^↻\s*Geburtstag$/);
  } finally {
    store.state.notes = store.state.notes.filter((n) => n.id !== 'dom-rep');
    redraw();
  }
});

test('a bar renders one stripe plus one label per month segment', async () => {
  const m = model();
  const start = `${m.cols[1].key}-20`;
  const end = `${m.cols[3].key}-10`;
  store.state.bars.push({ id: 'dom-bar', startDate: start, endDate: end, label: 'Projekt Nordwind', categoryId: store.state.categories[0].id });
  try {
    redraw();
    const stripes = $$('.board .bar[data-bar-id="dom-bar"]');
    const labels = $$('.board .bar-label[data-bar-id="dom-bar"]');
    assert.equal(stripes.length, 3, 'one stripe per crossed month');
    assert.equal(labels.length, 3, 'one label per month segment (3.7)');
    for (const l of labels) assert.includes(l.textContent, 'Projekt Nordwind');
    // Resize grips exist only where the real ends are (3.3).
    assert.equal($$('.board .bar[data-bar-id="dom-bar"] .bar-handle.top').length, 1);
    assert.equal($$('.board .bar[data-bar-id="dom-bar"] .bar-handle.bottom').length, 1);
    assert.equal($('.bar-handle.top', stripes[1]), null, 'middle month has no grips');
    assert.equal($('.bar-handle.bottom', stripes[1]), null);
    // Continuation cue on the months that were entered from above.
    assert.equal($('.cue', labels[0]), null);
    assert.equal($('.cue', labels[1]).textContent.trim(), '↑');
    assert.equal(stripes[0].style.background, 'rgb(42, 124, 192)');
  } finally {
    store.state.bars = store.state.bars.filter((b) => b.id !== 'dom-bar');
    redraw();
  }
});

test('a bar past the horizon draws the ↓ cue and the column footer (3.6)', async () => {
  const m = model();
  store.state.bars.push({
    id: 'dom-long', startDate: `${m.cols[10].key}-01`, endDate: '2099-01-01',
    label: 'Endlos', categoryId: store.state.categories[0].id,
  });
  try {
    redraw();
    const lastCol = $$('.board .col')[11];
    assert.ok($('.bar-cont-down', lastCol), 'the ↓ cue is on the stripe itself');
    assert.ok($('.horizon-cue', lastCol), 'and the column says "läuft weiter →"');
    assert.equal($$('.board .horizon-cue').length, 1, 'only the last column');
  } finally {
    store.state.bars = store.state.bars.filter((b) => b.id !== 'dom-long');
    redraw();
  }
});

test('a fourth overlapping bar becomes a +n chip, never a silent disappearance', async () => {
  const m = model();
  const key = m.cols[2].key;
  const cat = store.state.categories[0].id;
  for (let i = 0; i < 4; i++) {
    store.state.bars.push({ id: `dom-l${i}`, startDate: `${key}-05`, endDate: `${key}-25`, label: `L${i}`, categoryId: cat });
  }
  try {
    redraw();
    const col = $$('.board .col')[2];
    assert.equal($$('.bar', col).length, 3, 'only MAX_LANES stripes are drawn');
    const chip = $(`.day[data-date="${key}-10"] .d-more`, col);
    assert.ok(chip, 'the hidden bar is announced');
    assert.equal(chip.textContent, '+1');
    assert.includes(chip.title, 'weitere Balken');
  } finally {
    store.state.bars = store.state.bars.filter((b) => !b.id.startsWith('dom-l'));
    redraw();
  }
});

test('notes past the row capacity become a +n chip', async () => {
  const m = model();
  const date = m.cols[4].days[14].date;
  const cat = store.state.categories[0].id;
  for (let i = 0; i < 5; i++) {
    store.state.notes.push({ id: `dom-o${i}`, date, text: `Termin ${i}`, categoryId: cat, repeatsYearly: false });
  }
  try {
    redraw();
    const row = $(`.board .day[data-date="${date}"]`);
    const shown = $$('.note', row).length;
    const chip = $('.d-more', row);
    assert.ok(shown >= 1 && shown <= 3, 'capacity is 1..3 lines');
    assert.ok(chip, 'overflow is announced');
    assert.equal(chip.textContent, `+${5 - shown}`);
    assert.equal(chip.dataset.date, date);
  } finally {
    store.state.notes = store.state.notes.filter((n) => !n.id.startsWith('dom-o'));
    redraw();
  }
});

test('hiding a category removes its entries from the DOM entirely (4.6)', async () => {
  const cat = store.state.categories[1];
  const date = model().cols[5].days[5].date;
  store.state.notes.push({ id: 'dom-hid', date, text: 'versteckt', categoryId: cat.id, repeatsYearly: false });
  try {
    redraw();
    assert.ok($('.note[data-note-id="dom-hid"]'));
    cat.visible = false;
    redraw();
    assert.equal($('.note[data-note-id="dom-hid"]'), null);
  } finally {
    cat.visible = true;
    store.state.notes = store.state.notes.filter((n) => n.id !== 'dom-hid');
    redraw();
  }
});

// ── language ─────────────────────────────────────────────────────────────────

test('switching language re-labels weekdays, months and chrome', async () => {
  const i18n = await importApp('i18n.js');
  const before = i18n.getLang();
  try {
    i18n.setLang('en');
    await withSettings({ language: 'en' }, () => {
      assert.ok($$('.board .d-wd').some((n) => n.textContent === 'We'), 'English weekday');
      assert.equal($$('.board .d-wd').filter((n) => n.textContent === 'Mi').length, 0);
      assert.includes($('.board .pad-label').textContent, 'Scratchpad');
    });
  } finally {
    i18n.setLang(before);
    redraw();
  }
});
