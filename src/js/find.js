// Find is an overlay state of the board, not a separate screen (F14 design
// note): non-matches dim, matches keep full colour, Enter steps through hits.
// It searches note text, bar labels and scratchpads.

import { t } from './i18n.js';
import { store } from './store.js';
import { currentModel } from './board.js';

let wrap = null;
let input = null;
let counter = null;
let historyEl = null;
let onJump = null;
let hits = [];
let cursor = -1;
let active = false;

export const findActive = () => active;

export function initFind(refs) {
  wrap = refs.wrap;
  input = refs.input;
  counter = refs.counter;
  historyEl = refs.history || null;
  onJump = refs.onJump || null;

  input.addEventListener('input', () => run(input.value));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); exitFind(); }
  });
  refs.prev?.addEventListener('click', () => step(-1));
  refs.next?.addEventListener('click', () => step(1));
}

export function focusFind() {
  input.focus();
  input.select();
  if (input.value) run(input.value);
}

export function exitFind() {
  input.value = '';
  run('');
  input.blur();
}

/** Re-apply after a board re-render, so hits survive edits made while finding. */
export function refreshFind() {
  if (active) run(input.value, true);
}

function run(qRaw, keepCursor = false) {
  const q = qRaw.trim().toLowerCase();
  clearMarks();
  if (!q) {
    active = false;
    document.body.classList.remove('finding');
    counter.textContent = '';
    counter.classList.remove('none');
    hits = [];
    cursor = -1;
    renderHistory([]);
    return;
  }
  active = true;
  document.body.classList.add('finding');

  const nodes = document.querySelectorAll('.board .note, .board .bar-label, .board .pad textarea');
  hits = [];
  const seenBars = new Set();
  for (const n of nodes) {
    const text = n.tagName === 'TEXTAREA' ? n.value : n.textContent;
    if (!text || !text.toLowerCase().includes(q)) continue;
    n.classList.add('hit');
    // A six-month bar wears one label per month segment (3.7) but it is still
    // one entry — stepping through it five times would be a lie about how many
    // things matched. Note occurrences do count separately: each is a real,
    // separate place on the board.
    if (n.dataset.barId) {
      if (seenBars.has(n.dataset.barId)) continue;
      seenBars.add(n.dataset.barId);
    }
    hits.push(n);
  }
  // A bar's stripe should light up with its label, not only the chip.
  for (const n of [...hits]) {
    if (!n.dataset.barId) continue;
    document
      .querySelectorAll(`.board .bar[data-bar-id="${cssEsc(n.dataset.barId)}"]`)
      .forEach((b) => b.classList.add('hit'));
  }

  // 14.2 [Could] — hits in rolled-out history, listed as clickable results.
  renderHistory(offscreenHits(q));

  if (!hits.length) {
    counter.textContent = t('noResults');
    counter.classList.add('none');
    cursor = -1;
    return;
  }
  counter.classList.remove('none');
  if (!keepCursor || cursor < 0 || cursor >= hits.length) cursor = 0;
  mark();
}

/** Store-wide matches whose dates fall outside the visible 12-month window. */
function offscreenHits(q) {
  const m = currentModel();
  if (!m) return [];
  return historyHits(q).filter((h) => h.date < m.firstISO || h.date > m.lastISO);
}

function renderHistory(list) {
  if (!historyEl) return;
  historyEl.textContent = '';
  if (!list.length) { historyEl.hidden = true; return; }
  historyEl.hidden = false;
  const cap = el('div', 'fh-cap', t('historyHitsLabel'));
  historyEl.appendChild(cap);
  for (const h of list.slice(0, 8)) {
    const row = el('button', 'fh-row');
    row.appendChild(el('span', 'fh-date', `${h.date.slice(8)}.${h.date.slice(5, 7)}.${h.date.slice(0, 4)}`));
    row.appendChild(el('span', 'fh-text', h.text));
    // Jumping means pinning the board to that month (1.5/8.4) — rolling mode
    // cannot show the past by definition.
    row.addEventListener('mousedown', (e) => e.preventDefault()); // keep input focus
    row.addEventListener('click', () => onJump?.(h.date));
    historyEl.appendChild(row);
  }
  if (list.length > 8) historyEl.appendChild(el('div', 'fh-cap', `+${list.length - 8}`));
}

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

function step(dir) {
  if (!hits.length) return;
  cursor = (cursor + dir + hits.length) % hits.length;
  mark();
}

function mark() {
  document.querySelectorAll('.board .current').forEach((n) => n.classList.remove('current'));
  const n = hits[cursor];
  if (!n) return;
  n.classList.add('current');
  if (n.dataset.barId) {
    document
      .querySelectorAll(`.board .bar[data-bar-id="${cssEsc(n.dataset.barId)}"]`)
      .forEach((b) => b.classList.add('current'));
  }
  counter.textContent = `${cursor + 1}/${hits.length}`;
  scrollTo(n);
}

function scrollTo(node) {
  const col = node.closest('.col');
  if (!col || !wrap) return;
  const cr = col.getBoundingClientRect();
  const wr = wrap.getBoundingClientRect();
  if (cr.left < wr.left + 8) wrap.scrollLeft -= wr.left + 8 - cr.left;
  else if (cr.right > wr.right - 8) wrap.scrollLeft += cr.right - (wr.right - 8);
  // Dense settings can make the board taller than the window — track the hit
  // vertically too (header is ~26px sticky at the top).
  const nr = node.getBoundingClientRect();
  if (nr.top < wr.top + 34) wrap.scrollTop -= wr.top + 34 - nr.top;
  else if (nr.bottom > wr.bottom - 12) wrap.scrollTop += nr.bottom - (wr.bottom - 12);
}

function clearMarks() {
  document
    .querySelectorAll('.board .hit, .board .current')
    .forEach((n) => n.classList.remove('hit', 'current'));
}

const cssEsc = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));

/** All store-wide matches, regardless of the visible window. */
export function historyHits(q) {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const out = [];
  for (const n of store.state.notes) {
    if (n.text.toLowerCase().includes(query)) out.push({ kind: 'note', date: n.date, text: n.text });
  }
  for (const b of store.state.bars) {
    if ((b.label || '').toLowerCase().includes(query))
      out.push({ kind: 'bar', date: b.startDate, text: b.label });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
