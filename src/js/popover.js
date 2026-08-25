// The day popover (wireframe option 1m). This is the one place a day gets room
// to breathe: full note texts, edit/delete in place, category dots, the ↻
// toggle, and the bars that lost their lane to the 3-lane cap.
//
// 1n (row expands in place) was rejected: it breaks day-number alignment across
// columns, which is story 1.6 and the reason the board reads as a grid at all.

import { store, uid } from './store.js';
import { t, getLang } from './i18n.js';
import { colorOf } from './palette.js';
import { flashCategory } from './legend.js';
import { parseISO, dowISO, WD_DE, WD_EN, MONTH_DE, MONTH_EN, projectYearly } from './dates.js';

let node = null;
let ctx = null;

export const popoverOpen = () => !!node;

export function closePopover() {
  node?.remove();
  node = null;
  ctx = null;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('resize', closePopover);
}

function onOutside(e) {
  if (node && !node.contains(e.target)) closePopover();
}

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

function longDate(date) {
  const lang = getLang();
  const { y, m, d } = parseISO(date);
  const WD = lang === 'en' ? WD_EN : WD_DE;
  const MN = lang === 'en' ? MONTH_EN : MONTH_DE;
  return `${WD[dowISO(date)]} ${d}. ${MN[m - 1].slice(0, 3)} ${y}`;
}

/** Notes that render on `date`, including yearly-repeat projections. */
function notesOn(date) {
  const y = Number(date.slice(0, 4));
  return store.state.notes.filter((n) => {
    if (!store.categoryVisible(n.categoryId)) return false;
    if (!n.repeatsYearly) return n.date === date;
    if (Number(n.date.slice(0, 4)) > y) return false;
    return projectYearly(n.date, y) === date;
  });
}

function barsOn(date) {
  return store.state.bars.filter(
    (b) => store.categoryVisible(b.categoryId) && b.startDate <= date && b.endDate >= date
  );
}

export function openDayPopover(anchor, date, opts = {}) {
  closePopover();
  ctx = { date, onChange: opts.onChange || (() => {}) };
  node = el('div', 'popover');
  render();
  document.body.appendChild(node);
  place(anchor);
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', closePopover);
}

function place(anchor) {
  const r = anchor.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  let left = r.right + 8;
  if (left + w > window.innerWidth - 8) left = r.left - w - 8;
  if (left < 8) left = 8;
  let top = r.top - 6;
  if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
  if (top < 8) top = 8;
  node.style.left = `${left}px`;
  node.style.top = `${top}px`;
}

function refresh() {
  // The popover can be closed by the time a blur-commit lands — the store
  // change is already applied; only the (gone) card skips its rebuild.
  if (!node) return;
  const anchorRect = node.getBoundingClientRect();
  render();
  node.style.left = `${anchorRect.left}px`;
  node.style.top = `${anchorRect.top}px`;
  ctx.onChange('popover');
}

function render() {
  const { date } = ctx;
  node.textContent = '';

  const head = el('div', 'pop-head');
  head.appendChild(el('div', 'pop-title', longDate(date)));
  const x = el('button', 'pop-x', '✕');
  x.title = t('close');
  x.addEventListener('click', closePopover);
  head.appendChild(x);
  node.appendChild(head);

  const notes = notesOn(date);
  for (const n of notes) node.appendChild(noteRow(n, date));

  const bars = barsOn(date);
  if (bars.length) {
    const cap = el('div', 'pop-sub');
    cap.style.margin = '7px 0 1px';
    cap.textContent = t('barsHere');
    node.appendChild(cap);
    for (const b of bars) node.appendChild(barRow(b));
  }

  const add = el('button', 'pop-add', t('addNote'));
  // The new-note row is popover-local until it has text. Creating a store
  // entry up front looked simpler but leaked an invisible empty note whenever
  // the popover was dismissed mid-typing — which then inflated the "+n" count.
  add.addEventListener('click', () => startAdd(add, date));
  node.appendChild(add);

  if (!notes.length && !bars.length) {
    const empty = el('div', 'pop-sub', t('emptyHint'));
    empty.style.padding = '4px 0';
    node.insertBefore(empty, add);
  }
}

function startAdd(addBtn, date) {
  if (node.querySelector('.pop-new')) return;
  const row = el('div', 'pop-row pop-new');
  const dot = el('span', 'dot');
  dot.style.background = colorOf(store.category(store.state.settings.lastCategoryId).paletteRef);
  row.appendChild(dot);
  const inp = document.createElement('input');
  inp.className = 'txt';
  inp.type = 'text';
  inp.maxLength = 80;
  row.appendChild(inp);
  node.insertBefore(row, addBtn);
  inp.focus();

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const v = inp.value.trim();
    if (!v) { row.remove(); return; }
    const catId = store.state.settings.lastCategoryId;
    let unhid = false;
    store.mutate('create-note', (s) => {
      unhid = store.ensureVisible(catId);
      s.notes.push({ id: uid(), date, text: v, categoryId: catId, repeatsYearly: false });
    });
    // Flash after refresh — refresh triggers a board redraw that rebuilds the
    // legend, which would wipe a flash started before it (4.6).
    refresh();
    if (unhid) flashCategory(catId);
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); settled = true; row.remove(); }
  });
  inp.addEventListener('blur', commit);
}

function noteRow(n, date) {
  const row = el('div', 'pop-row');
  const dot = el('button', 'dot');
  dot.style.background = colorOf(store.category(n.categoryId).paletteRef);
  dot.title = store.category(n.categoryId).name;
  dot.addEventListener('click', () =>
    toggleSwatches(row, n.categoryId, (catId) => {
      store.mutate('recategorise', (s) => {
        const x = s.notes.find((y) => y.id === n.id);
        if (!x || x.categoryId === catId) return false;
        x.categoryId = catId;
        s.settings.lastCategoryId = catId;
      });
    })
  );
  row.appendChild(dot);

  const txt = el('div', 'txt', n.text || '…');
  txt.dataset.edit = n.id;
  txt.title = n.text;
  txt.addEventListener('click', () => startEdit(row, txt, n));
  row.appendChild(txt);

  const rep = el('button', 'act' + (n.repeatsYearly ? ' on' : ''), '↻');
  rep.title = t('repeatsYearly');
  rep.addEventListener('click', () => {
    store.mutate('toggle-repeat', (s) => {
      const x = s.notes.find((y) => y.id === n.id);
      if (!x) return false;
      x.repeatsYearly = !x.repeatsYearly;
      // 9.5 — the series starts in the year it was switched on, so anchor it
      // to the occurrence the user was actually looking at.
      if (x.repeatsYearly) x.date = date;
    });
    refresh();
  });
  row.appendChild(rep);

  const del = el('button', 'act', '✕');
  del.title = t('delete');
  del.addEventListener('click', () => {
    store.mutate('delete-note', (s) => { s.notes = s.notes.filter((y) => y.id !== n.id); });
    refresh();
  });
  row.appendChild(del);
  return row;
}

function barRow(b) {
  const row = el('div', 'pop-row');
  const dot = el('button', 'dot');
  dot.style.background = colorOf(store.category(b.categoryId).paletteRef);
  dot.style.borderRadius = '1px';
  dot.style.height = '9px';
  dot.style.width = '4px';
  dot.title = store.category(b.categoryId).name;
  // Bars need a recolour path too — creation locks in the last-used category,
  // and without this the only fix was delete-and-redraw.
  dot.addEventListener('click', () =>
    toggleSwatches(row, b.categoryId, (catId) => {
      store.mutate('recategorise-bar', (s) => {
        const x = s.bars.find((y) => y.id === b.id);
        if (!x || x.categoryId === catId) return false;
        x.categoryId = catId;
        s.settings.lastCategoryId = catId;
      });
    })
  );
  row.appendChild(dot);
  const txt = el('div', 'txt', b.label || t('untitledBar'));
  txt.title = `${b.startDate} – ${b.endDate}`;
  row.appendChild(txt);
  const range = el('span', 'act');
  range.textContent = `${b.startDate.slice(8)}.${b.startDate.slice(5, 7)}.–${b.endDate.slice(8)}.${b.endDate.slice(5, 7)}.`;
  range.style.font = '400 8.5px var(--mono)';
  row.appendChild(range);
  return row;
}

function startEdit(row, txt, n) {
  const inp = document.createElement('input');
  inp.className = 'txt';
  inp.type = 'text';
  inp.maxLength = 80;
  inp.value = n.text;
  row.replaceChild(inp, txt);
  inp.focus();
  inp.select();
  const commit = () => {
    const v = inp.value.trim();
    store.mutate('edit-note', (s) => {
      const x = s.notes.find((y) => y.id === n.id);
      if (!x) return false;
      if (!v) s.notes = s.notes.filter((y) => y.id !== n.id);
      else if (x.text === v) return false;
      else x.text = v;
    });
    refresh();
  };
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); refresh(); }
  });
  inp.addEventListener('blur', commit);
}

function toggleSwatches(row, currentCatId, apply) {
  const existing = node.querySelector('.pop-cat');
  if (existing) { existing.remove(); return; }
  const strip = el('div', 'pop-cat');
  for (const c of store.state.categories) {
    const sw = el('button', 'sw');
    sw.style.background = colorOf(c.paletteRef);
    sw.title = c.name;
    sw.setAttribute('aria-pressed', String(c.id === currentCatId));
    sw.addEventListener('click', () => { apply(c.id); refresh(); });
    strip.appendChild(sw);
  }
  row.insertAdjacentElement('afterend', strip);
}
