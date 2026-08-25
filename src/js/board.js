// Turns the layout model into DOM. Nothing here decides geometry — that is
// layout.js — so the same numbers drive screen, drag previews and print.

import { buildBoard } from './layout.js';
import { t } from './i18n.js';
import { parseISO, MONTH_DE, MONTH_EN } from './dates.js';
import { colorOf } from './palette.js';
import { store } from './store.js';

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

let model = null;
export const currentModel = () => model;

export function renderBoard(root) {
  const state = store.state;
  model = buildBoard(state);

  const scrollLeft = root.parentElement ? root.parentElement.scrollLeft : 0;
  root.textContent = '';
  // Density lives on :root only. Every position below is expressed in calc()
  // against these variables, never in resolved pixels — that is what lets the
  // print stylesheet re-metric the identical DOM for A4/A3 (F12) by overriding
  // them on <body>, which sits between :root and the board.
  document.documentElement.style.setProperty('--row-h', `${model.rowH}px`);
  document.documentElement.style.setProperty('--col-w', `${model.colW}px`);

  const frag = document.createDocumentFragment();
  for (const col of model.cols) frag.appendChild(renderColumn(col, model, state));
  root.appendChild(frag);

  if (root.parentElement) root.parentElement.scrollLeft = scrollLeft;
  return model;
}

function renderColumn(col, m, state) {
  const c = el('div', 'col');
  c.dataset.month = col.key;
  c.dataset.index = String(col.index);
  if (col.isTodayMonth) c.classList.add('is-today-month');

  const head = el('div', 'col-head');
  head.appendChild(el('span', null, col.label));
  head.title = col.fullLabel;
  c.appendChild(head);

  const rows = el('div', 'rows');
  rows.style.height = 'calc(var(--row-h) * 31)';
  rows.dataset.month = col.key;

  for (const d of col.days) rows.appendChild(renderDay(d, m));
  for (const seg of col.segs) renderSegment(rows, seg);

  if (col.horizon) {
    rows.appendChild(el('div', 'horizon-cue', t('continues')));
  }
  c.appendChild(rows);
  c.appendChild(renderPad(col, state));
  return c;
}

function renderDay(d, m) {
  const row = el('div', 'day');
  row.dataset.row = String(d.row);
  if (d.empty) {
    row.classList.add('void');
    return row;
  }
  row.dataset.date = d.date;
  if (d.weekend) row.classList.add('we');
  if (d.ferien) row.classList.add('fer');
  if (d.isToday) row.classList.add('today');
  if (d.holiday) row.classList.add('hol');

  // 7.2 — the shading must never be cryptic; the period name is one hover away.
  const tips = [];
  if (d.ferienName) tips.push(d.ferienName);
  if (d.holidayDemoted && d.holiday) tips.push(d.holiday.name);
  if (tips.length) row.title = tips.join(' · ');

  row.appendChild(el('span', 'd-num', d.n));
  row.appendChild(el('span', 'd-wd', d.wd));

  if (d.holidayDemoted) row.appendChild(el('span', 'd-holdot'));

  const body = el('div', 'd-body');
  if (d.holidayShown && d.holiday) {
    const h = el('div', 'd-hol', d.holiday.short);
    if (!d.holiday.own) h.classList.add('foreign');
    h.title = d.holiday.name;
    body.appendChild(h);
  }
  for (const n of d.notes) body.appendChild(renderNote(n, d));
  row.appendChild(body);

  if (d.overflow > 0) {
    const more = el('div', 'd-more', `+${d.overflow}`);
    more.dataset.date = d.date;
    more.title =
      d.laneOverflow > 0 && d.overflow === d.laneOverflow
        ? `${d.laneOverflow} ${t('lanesFull')}`
        : `${d.overflow} ${t('more')}`;
    row.appendChild(more);
  }
  return row;
}

function renderNote(n, d) {
  const node = el('div', 'note');
  node.dataset.noteId = n.note.id;
  node.dataset.date = d.date;
  node.style.color = n.color;
  if (n.note.repeatsYearly) {
    // 9.2 / design note — the marker goes *before* the text so truncation can
    // never eat it.
    node.appendChild(el('span', 'rep', '↻'));
  }
  node.appendChild(document.createTextNode(n.note.text));
  node.title = n.note.text; // 2.5 — full text on hover
  return node;
}

function renderSegment(rows, seg) {
  const right = `calc(2px + var(--lane-gap) * ${seg.lane})`;
  const bar = el('div', 'bar');
  bar.dataset.barId = seg.bar.id;
  bar.dataset.lane = String(seg.lane);
  bar.style.top = `calc(var(--row-h) * ${seg.topRow} + 1px)`;
  bar.style.height = `calc(var(--row-h) * ${seg.rows} - 3px)`;
  bar.style.right = right;
  bar.style.background = seg.color;
  bar.title = `${seg.bar.label || t('untitledBar')} · ${seg.bar.startDate} – ${seg.bar.endDate}`;

  // Resize grips only exist where the real end of the bar is, so dragging the
  // December half of a January bar can never silently reshape the wrong edge.
  if (!seg.contTop) bar.appendChild(el('div', 'bar-handle top'));
  if (!seg.contBot) bar.appendChild(el('div', 'bar-handle bottom'));
  rows.appendChild(bar);

  // 3.3 / 3.7 — one label per month segment, on a row that carries no ink.
  const lab = el('div', 'bar-label');
  lab.dataset.barId = seg.bar.id;
  lab.dataset.row = String(seg.labelRow);
  lab.style.top = `calc(var(--row-h) * ${seg.labelRow} + (var(--row-h) - 11px) / 2)`;
  lab.style.right = `calc(2px + var(--lane-gap) * ${seg.lane + 1})`;
  lab.style.background = seg.color;
  if (seg.contTop) {
    const cue = el('span', 'cue', '↑ ');
    lab.appendChild(cue);
  }
  lab.appendChild(document.createTextNode(seg.bar.label || t('untitledBar')));
  lab.title = bar.title;
  rows.appendChild(lab);

  // 3.6 — a bar that runs past the last visible column says so on the stripe
  // itself, not only in the column footer. Mirrored: one that began before the
  // first column gets the same glyph at its top, so "started earlier than you
  // can see" is distinguishable from an ordinary month split.
  if (seg.beyondEnd) {
    const cue = el('div', 'bar-cont-down', '↓');
    cue.style.color = seg.color;
    cue.style.right = `calc(1px + var(--lane-gap) * ${seg.lane})`;
    cue.style.top = `calc(var(--row-h) * ${seg.topRow + seg.rows} - 11px)`;
    rows.appendChild(cue);
  }
  if (seg.beyondStart) {
    const cue = el('div', 'bar-cont-up', '↑');
    cue.style.color = seg.color;
    cue.style.right = `calc(1px + var(--lane-gap) * ${seg.lane})`;
    cue.style.top = `calc(var(--row-h) * ${seg.topRow} + 1px)`;
    rows.appendChild(cue);
  }
}

function renderPad(col, state) {
  const pad = el('div', 'pad');
  pad.dataset.month = col.key;
  pad.appendChild(el('div', 'pad-label', t('scratchpad')));
  const ta = document.createElement('textarea');
  ta.value = col.pad;
  ta.spellcheck = false;
  ta.dataset.month = col.key;
  ta.rows = 5;
  ta.setAttribute('aria-label', `${t('scratchpad')} ${col.fullLabel}`);
  pad.appendChild(ta);
  if (!col.pad.trim()) pad.classList.add('empty');
  return pad;
}

export function monthLabel(key, lang) {
  const { y, m } = parseISO(`${key}-01`);
  const MN = lang === 'en' ? MONTH_EN : MONTH_DE;
  return `${MN[m - 1]} ${y}`;
}

export { colorOf };
