// Direct manipulation (§9). One pointer state machine for the whole board:
// press → maybe-drag → commit. Drags only begin past a 4 px threshold so a
// click to edit can never turn into an accidental move (5.5).

import { store, uid } from './store.js';
import { addDays, diffDays, parseISO, iso, p2 } from './dates.js';
import { renderBoard, currentModel } from './board.js';
import { openDayPopover, closePopover, popoverOpen } from './popover.js';
import { flashCategory } from './legend.js';
import { t } from './i18n.js';
import { colorOf } from './palette.js';

const THRESHOLD = 4;
const EDGE = 48;        // px from the board edge where auto-scroll kicks in
const EDGE_SPEED = 14;

export const selection = { type: null, id: null };

let boardEl = null;
let wrapEl = null;
let pending = null;
let drag = null;
let editor = null;
let autoScrollTimer = null;
let onChange = () => {};

export function initInteractions(board, wrap, opts = {}) {
  boardEl = board;
  wrapEl = wrap;
  onChange = opts.onChange || (() => {});

  board.addEventListener('pointerdown', onPointerDown);
  board.addEventListener('dblclick', onDblClick);
  board.addEventListener('click', onClick);
  board.addEventListener('contextmenu', onContextMenu);
  board.addEventListener('input', onPadInput);
  board.addEventListener('focusout', onPadBlur, true);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

// ── selection ────────────────────────────────────────────────────────────────

export function select(type, id) {
  selection.type = type;
  selection.id = id;
  applySelection();
  onChange('select');
}
export function clearSelection() {
  if (!selection.type) return false;
  selection.type = null;
  selection.id = null;
  applySelection();
  onChange('select');
  return true;
}
export function applySelection() {
  boardEl?.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'));
  if (!selection.id) return;
  const sel =
    selection.type === 'note'
      ? `.note[data-note-id="${cssEsc(selection.id)}"]`
      : `.bar[data-bar-id="${cssEsc(selection.id)}"], .bar-label[data-bar-id="${cssEsc(selection.id)}"]`;
  boardEl?.querySelectorAll(sel).forEach((n) => n.classList.add('selected'));
}
const cssEsc = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));

export function deleteSelected() {
  if (!selection.id) return false;
  const { type, id } = selection;
  store.mutate('delete', (s) => {
    if (type === 'note') s.notes = s.notes.filter((n) => n.id !== id);
    else s.bars = s.bars.filter((b) => b.id !== id);
  });
  selection.type = null;
  selection.id = null;
  return true;
}

export function editSelected() {
  if (!selection.id) return false;
  if (selection.type === 'note') {
    const node = boardEl.querySelector(`.note[data-note-id="${cssEsc(selection.id)}"]`);
    if (node) { startNoteEdit(node); return true; }
  } else {
    const node = boardEl.querySelector(`.bar-label[data-bar-id="${cssEsc(selection.id)}"]`);
    if (node) { startBarLabelEdit(node); return true; }
  }
  return false;
}

// ── pointer state machine ────────────────────────────────────────────────────

function onPointerDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest('textarea, input, .pad, .cat-strip')) return;
  let target = e.target;
  if (editor) {
    // Committing re-renders the board synchronously, so the pressed element is
    // now detached — re-resolve the target from the pointer position or the
    // click lands on a ghost and silently does nothing.
    commitEditor();
    target = document.elementFromPoint(e.clientX, e.clientY) || e.target;
  }
  if (popoverOpen() && !target.closest('.d-more')) closePopover();

  const handle = target.closest('.bar-handle');
  const barNode = target.closest('.bar, .bar-label');
  const noteNode = target.closest('.note');
  const moreNode = target.closest('.d-more');
  const dayNode = target.closest('.day');

  if (moreNode) return; // handled on click

  if (handle && barNode) {
    pending = {
      kind: 'resize',
      edge: handle.classList.contains('top') ? 'start' : 'end',
      id: barNode.dataset.barId, x: e.clientX, y: e.clientY,
    };
  } else if (barNode) {
    pending = {
      kind: 'bar', id: barNode.dataset.barId, node: barNode,
      grabDate: dayNode?.dataset.date || dateUnderPointer(e),
      x: e.clientX, y: e.clientY,
    };
  } else if (noteNode) {
    pending = {
      kind: 'note', id: noteNode.dataset.noteId, node: noteNode,
      fromDate: noteNode.dataset.date, x: e.clientX, y: e.clientY,
    };
  } else if (dayNode && !dayNode.classList.contains('void')) {
    pending = {
      kind: 'day', date: dayNode.dataset.date, node: dayNode,
      x: e.clientX, y: e.clientY,
    };
  } else {
    pending = null;
    clearSelection();
  }
}

function onPointerMove(e) {
  if (pending && !drag) {
    const dx = Math.abs(e.clientX - pending.x);
    const dy = Math.abs(e.clientY - pending.y);
    if (Math.hypot(dx, dy) < THRESHOLD) return;
    beginDrag(e);
  }
  if (!drag) return;
  e.preventDefault();
  updateDrag(e);
  handleEdgeScroll(e);
}

function onPointerUp(e) {
  stopEdgeScroll();
  if (drag) {
    finishDrag(e);
    drag = null;
    pending = null;
    document.body.classList.remove('is-dragging', 'is-resizing', 'is-creating');
    return;
  }
  if (!pending) return;
  const p = pending;
  pending = null;
  // A press that never became a drag is a click.
  if (p.kind === 'note') select('note', p.id);
  else if (p.kind === 'bar') select('bar', p.id);
  else if (p.kind === 'day') { clearSelection(); startNoteCreate(p.node, p.date); }
}

function onClick(e) {
  const more = e.target.closest('.d-more');
  if (more) {
    e.stopPropagation();
    openDayPopover(more, more.dataset.date, { onChange });
  }
}

// 9.1 — the ↻ repeat toggle lives in the popover, but the "+n" chip only
// exists on crowded days. Right-click opens the popover on ANY day, so a lone
// birthday note can be made yearly without first manufacturing an overflow.
function openPopoverAt(day) {
  if (!day || !day.dataset.date) return false;
  if (editor) commitEditor();
  openDayPopover(day, day.dataset.date, { onChange });
  return true;
}

function onContextMenu(e) {
  if (openPopoverAt(e.target.closest('.day'))) e.preventDefault();
}

// The Swift shell suppresses WKWebView's native context menu (which ignores
// the DOM event's preventDefault entirely) and calls this with the click point.
window.__lzpContextMenu = (x, y) => {
  const hit = document.elementFromPoint(x, y);
  openPopoverAt(hit?.closest?.('.day'));
};

function onDblClick(e) {
  const note = e.target.closest('.note');
  if (note) { startNoteEdit(note); return; }
  const lab = e.target.closest('.bar-label');
  if (lab) { startBarLabelEdit(lab); return; }
  const bar = e.target.closest('.bar');
  if (bar) {
    const l = boardEl.querySelector(`.bar-label[data-bar-id="${cssEsc(bar.dataset.barId)}"]`);
    if (l) startBarLabelEdit(l);
  }
}

// ── drag lifecycle ───────────────────────────────────────────────────────────

function beginDrag(e) {
  const p = pending;
  if (p.kind === 'day') {
    // Vertical press-and-drag from an empty day lays down a bar (3.1).
    drag = { kind: 'create-bar', anchor: p.date, current: p.date, col: p.node.closest('.rows') };
    document.body.classList.add('is-creating');
    drag.preview = document.createElement('div');
    drag.preview.className = 'bar-preview';
    drag.preview.style.background = colorOf(store.category(store.state.settings.lastCategoryId).paletteRef);
    drag.col.appendChild(drag.preview);
  } else if (p.kind === 'note') {
    const n = store.state.notes.find((x) => x.id === p.id);
    if (!n) return;
    drag = { kind: 'move-note', id: p.id, fromDate: p.fromDate, note: n, target: p.fromDate };
    document.body.classList.add('is-dragging');
    p.node.classList.add('dragging');
    drag.ghost = makeGhost(n.text || t('emptyHint'));
    drag.dropRow = makeDropRow();
  } else if (p.kind === 'bar') {
    const b = store.state.bars.find((x) => x.id === p.id);
    if (!b) return;
    drag = { kind: 'move-bar', id: p.id, bar: b, grabDate: p.grabDate, delta: 0 };
    document.body.classList.add('is-dragging');
    boardEl.querySelectorAll(`.bar[data-bar-id="${cssEsc(p.id)}"]`).forEach((n) => n.classList.add('dragging'));
    drag.ghost = makeGhost(b.label || t('untitledBar'));
  } else if (p.kind === 'resize') {
    const b = store.state.bars.find((x) => x.id === p.id);
    if (!b) return;
    drag = { kind: 'resize', id: p.id, bar: b, edge: p.edge, start: b.startDate, end: b.endDate };
    document.body.classList.add('is-resizing');
    drag.ghost = makeGhost('');
  }
  if (drag) updateDrag(e);
}

function updateDrag(e) {
  const date = dateUnderPointer(e);
  if (drag.ghost) {
    drag.ghost.style.left = `${e.clientX + 12}px`;
    drag.ghost.style.top = `${e.clientY - 8}px`;
  }

  if (drag.kind === 'create-bar') {
    if (!date) return;
    drag.current = date;
    const [a, b] = drag.anchor <= date ? [drag.anchor, date] : [date, drag.anchor]; // 3.5
    drag.range = [a, b];
    paintCreatePreview(a, b);
    if (drag.ghost) drag.ghost.textContent = `${short(a)} – ${short(b)} · ${diffDays(a, b) + 1} T`;
    return;
  }
  if (drag.kind === 'move-note') {
    if (!date) return;
    drag.target = date;
    positionDropRow(date);
    return;
  }
  if (drag.kind === 'move-bar') {
    if (!date || !drag.grabDate) return;
    drag.delta = diffDays(drag.grabDate, date);
    const s = addDays(drag.bar.startDate, drag.delta);
    const en = addDays(drag.bar.endDate, drag.delta);
    if (drag.ghost) drag.ghost.textContent = `${short(s)} – ${short(en)}`;
    paintRangePreview(s, en, colorOf(store.category(drag.bar.categoryId).paletteRef));
    return;
  }
  if (drag.kind === 'resize') {
    if (!date) return;
    let s = drag.bar.startDate;
    let en = drag.bar.endDate;
    if (drag.edge === 'start') s = date > en ? en : date;
    else en = date < s ? s : date;
    drag.next = [s, en];
    if (drag.ghost) drag.ghost.textContent = `${short(s)} – ${short(en)} · ${diffDays(s, en) + 1} T`;
    paintRangePreview(s, en, colorOf(store.category(drag.bar.categoryId).paletteRef));
  }
}

function finishDrag(e) {
  clearPreviews();
  drag.ghost?.remove();
  drag.dropRow?.remove();
  boardEl.querySelectorAll('.dragging').forEach((n) => n.classList.remove('dragging'));

  if (drag.kind === 'create-bar' && drag.range) {
    const [a, b] = drag.range;
    const catId = store.state.settings.lastCategoryId;
    const id = uid();
    let unhid = false;
    store.mutate('create-bar', (s) => {
      unhid = store.ensureVisible(catId);
      s.bars.push({ id, startDate: a, endDate: b, label: '', categoryId: catId });
    });
    // After the mutation, not inside it: mutate() re-renders the legend, which
    // would otherwise wipe the flash before anyone saw it (4.6).
    if (unhid) flashCategory(catId);
    select('bar', id);
    // A fresh bar has no label yet — go straight into naming it (3.3).
    // mutate() re-renders synchronously, so the chip is already in the DOM.
    const lab = boardEl.querySelector(`.bar-label[data-bar-id="${cssEsc(id)}"]`);
    if (lab) startBarLabelEdit(lab);
    return;
  }
  if (drag.kind === 'move-note' && drag.target && drag.target !== drag.fromDate) {
    const id = drag.id;
    const target = drag.target;
    store.mutate('move-note', (s) => {
      const n = s.notes.find((x) => x.id === id);
      if (!n) return false;
      if (n.repeatsYearly) {
        // 9.3 — one object per series: keep the series' first year, move the
        // month/day the whole series lands on.
        const anchorY = n.date.slice(0, 4);
        const tgt = parseISO(target);
        n.date = iso(Number(anchorY), tgt.m, tgt.d);
      } else {
        n.date = target;
      }
    });
    return;
  }
  if (drag.kind === 'move-bar' && drag.delta) {
    const { id, delta } = drag;
    store.mutate('move-bar', (s) => {
      const b = s.bars.find((x) => x.id === id);
      if (!b) return false;
      b.startDate = addDays(b.startDate, delta);
      b.endDate = addDays(b.endDate, delta);
    });
    return;
  }
  if (drag.kind === 'resize' && drag.next) {
    const { id } = drag;
    const [s0, e0] = drag.next;
    store.mutate('resize-bar', (s) => {
      const b = s.bars.find((x) => x.id === id);
      if (!b) return false;
      if (b.startDate === s0 && b.endDate === e0) return false;
      b.startDate = s0;
      b.endDate = e0;
    });
  }
}

// ── previews ─────────────────────────────────────────────────────────────────

function makeGhost(text) {
  const g = document.createElement('div');
  g.className = 'drag-ghost';
  g.textContent = text;
  document.body.appendChild(g);
  return g;
}
function makeDropRow() {
  const d = document.createElement('div');
  d.className = 'drop-row';
  return d;
}
function positionDropRow(date) {
  const key = date.slice(0, 7);
  const rows = boardEl.querySelector(`.rows[data-month="${key}"]`);
  if (!rows) return;
  const day = parseISO(date).d;
  if (drag.dropRow.parentElement !== rows) rows.appendChild(drag.dropRow);
  drag.dropRow.style.top = `calc(var(--row-h) * ${day - 1})`;
}

function clearPreviews() {
  boardEl.querySelectorAll('.bar-preview').forEach((n) => n.remove());
  boardEl.querySelectorAll('.drop-row').forEach((n) => n.remove());
}

function paintCreatePreview(a, b) {
  clearPreviews();
  paintRangePreview(a, b, colorOf(store.category(store.state.settings.lastCategoryId).paletteRef));
}

/** Draws one preview stripe per month the range touches (3.2 while dragging). */
function paintRangePreview(a, b, color) {
  clearPreviews();
  const m = currentModel();
  for (const col of m.cols) {
    const first = `${col.key}-01`;
    const last = `${col.key}-${p2(col.len)}`;
    if (b < first || a > last) continue;
    const s = a > first ? a : first;
    const en = b < last ? b : last;
    const rows = boardEl.querySelector(`.rows[data-month="${col.key}"]`);
    if (!rows) continue;
    const sd = parseISO(s).d;
    const ed = parseISO(en).d;
    const p = document.createElement('div');
    p.className = 'bar-preview';
    p.style.top = `calc(var(--row-h) * ${sd - 1} + 1px)`;
    p.style.height = `calc(var(--row-h) * ${ed - sd + 1} - 3px)`;
    p.style.right = '2px';
    p.style.background = color;
    rows.appendChild(p);
  }
}

// ── auto-scroll (5.6) ────────────────────────────────────────────────────────

function handleEdgeScroll(e) {
  const r = wrapEl.getBoundingClientRect();
  let dir = 0;
  if (e.clientX < r.left + EDGE) dir = -1;
  else if (e.clientX > r.right - EDGE) dir = 1;
  if (!dir) return stopEdgeScroll();
  if (autoScrollTimer) return;
  autoScrollTimer = setInterval(() => {
    wrapEl.scrollLeft += dir * EDGE_SPEED;
  }, 16);
}
function stopEdgeScroll() {
  if (autoScrollTimer) { clearInterval(autoScrollTimer); autoScrollTimer = null; }
}

// ── hit testing ──────────────────────────────────────────────────────────────

function dateUnderPointer(e) {
  const stack = document.elementsFromPoint(e.clientX, e.clientY);
  for (const n of stack) {
    const d = n.closest?.('.day');
    if (d && d.dataset.date) return d.dataset.date;
  }
  // Between columns or below row 31 — fall back to the nearest column's row.
  const col = stack.find((n) => n.classList?.contains('rows') || n.closest?.('.rows'));
  const rows = col?.closest?.('.rows');
  if (!rows) return null;
  const m = currentModel();
  const r = rows.getBoundingClientRect();
  const row = Math.max(0, Math.min(30, Math.floor((e.clientY - r.top) / m.rowH)));
  const key = rows.dataset.month;
  const colModel = m.cols.find((c) => c.key === key);
  if (!colModel) return null;
  return `${key}-${p2(Math.min(row + 1, colModel.len))}`;
}

const short = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;

// ── inline editing (2.1, 2.2, 3.3) ───────────────────────────────────────────

function makeEditor(rows, row, value, opts = {}) {
  const inp = document.createElement('input');
  inp.className = 'inline-edit' + (opts.forBar ? ' for-bar' : '');
  inp.type = 'text';
  inp.value = value;
  inp.maxLength = opts.maxLength ?? 80; // 2.5
  inp.style.top = `calc(var(--row-h) * ${row} + 1px)`;
  if (opts.right != null) inp.style.right = opts.right;
  rows.appendChild(inp);

  // Category swatches ride along with every editor, so picking a colour is
  // part of the same gesture as typing — the popover is no longer the only
  // recolour path. The pick applies at commit; Esc discards it with the text.
  let cat = opts.categoryId ?? store.state.settings.lastCategoryId;
  const paint = () => { inp.style.color = colorOf(store.category(cat).paletteRef); };
  const strip = document.createElement('div');
  strip.className = 'cat-strip';
  // Near the bottom rows the strip flips above the editor to stay on-screen.
  strip.style.top = row >= 28
    ? `calc(var(--row-h) * ${row} - 26px)`
    : `calc(var(--row-h) * ${row + 1} + 3px)`;
  if (opts.right != null) strip.style.right = opts.right;
  else strip.style.left = '27px';
  for (const c of store.state.categories) {
    const sw = document.createElement('button');
    sw.className = 'sw';
    sw.style.background = colorOf(c.paletteRef);
    sw.title = c.name;
    sw.setAttribute('aria-pressed', String(c.id === cat));
    // pointerdown would blur the input and commit the editor mid-pick.
    sw.addEventListener('pointerdown', (ev) => ev.preventDefault());
    sw.addEventListener('click', () => {
      cat = c.id;
      strip.querySelectorAll('.sw').forEach((n) =>
        n.setAttribute('aria-pressed', String(n === sw)));
      paint();
      inp.focus();
    });
    strip.appendChild(sw);
  }
  rows.appendChild(strip);
  paint();

  inp.focus();
  inp.select();
  editor = { node: inp, strip, commit: opts.onCommit, cancel: opts.onCancel, cat: () => cat };
  inp.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); commitEditor(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); cancelEditor(); }
  });
  inp.addEventListener('blur', () => commitEditor());
  return inp;
}

export function commitEditor() {
  if (!editor) return;
  const e = editor;
  editor = null;
  const v = e.node.value.trim();
  e.node.remove();
  e.strip?.remove();
  e.commit?.(v, e.cat());
}
export function cancelEditor() {
  if (!editor) return;
  const e = editor;
  editor = null;
  e.node.remove();
  e.strip?.remove();
  e.cancel?.();
}
export const editorOpen = () => !!editor;

function startNoteCreate(dayNode, date) {
  const rows = dayNode.closest('.rows');
  const row = parseInt(dayNode.dataset.row, 10);
  makeEditor(rows, row, '', {
    onCommit: (text, catId) => {
      if (!text) return;
      const id = uid();
      let unhid = false;
      store.mutate('create-note', (s) => {
        unhid = store.ensureVisible(catId);
        s.notes.push({ id, date, text, categoryId: catId, repeatsYearly: false });
        s.settings.lastCategoryId = catId;
      });
      if (unhid) flashCategory(catId);
      select('note', id);
    },
  });
}

function startNoteEdit(noteNode) {
  const id = noteNode.dataset.noteId;
  const n = store.state.notes.find((x) => x.id === id);
  if (!n) return;
  const rows = noteNode.closest('.rows');
  const day = noteNode.closest('.day');
  const row = parseInt(day.dataset.row, 10);
  select('note', id);
  makeEditor(rows, row, n.text, {
    categoryId: n.categoryId,
    onCommit: (text, catId) => {
      store.mutate('edit-note', (s) => {
        const x = s.notes.find((y) => y.id === id);
        if (!x) return false;
        // 2.2 — clearing the text is how you delete without a dialog.
        if (!text) { s.notes = s.notes.filter((y) => y.id !== id); return; }
        if (x.text === text && x.categoryId === catId) return false;
        x.text = text;
        if (x.categoryId !== catId) {
          x.categoryId = catId;
          s.settings.lastCategoryId = catId;
        }
      });
    },
  });
}

function startBarLabelEdit(labNode) {
  const id = labNode.dataset.barId;
  const b = store.state.bars.find((x) => x.id === id);
  if (!b) return;
  const rows = labNode.closest('.rows');
  select('bar', id);
  const row = Number(labNode.dataset.row) || 0;
  makeEditor(rows, row, b.label, {
    forBar: true, right: labNode.style.right, maxLength: 40,
    categoryId: b.categoryId,
    onCommit: (label, catId) => {
      store.mutate('edit-bar', (s) => {
        const x = s.bars.find((y) => y.id === id);
        if (!x) return false;
        if (x.label === label && x.categoryId === catId) return false;
        x.label = label;
        if (x.categoryId !== catId) {
          x.categoryId = catId;
          s.settings.lastCategoryId = catId;
        }
      });
    },
  });
}

// ── scratchpad (F10) ─────────────────────────────────────────────────────────

let padTimer = null;
function onPadInput(e) {
  const ta = e.target.closest('.pad textarea');
  if (!ta) return;
  const key = ta.dataset.month;
  const val = ta.value;
  ta.closest('.pad').classList.toggle('empty', !val.trim());
  clearTimeout(padTimer);
  // Debounced so a paragraph of typing is one undo step, not forty.
  padTimer = setTimeout(() => {
    store.mutate('pad', (s) => {
      if ((s.scratchpads[key] || '') === val) return false;
      if (val.trim()) s.scratchpads[key] = val;
      else delete s.scratchpads[key];
    });
  }, 600);
}
function onPadBlur(e) {
  const ta = e.target.closest?.('.pad textarea');
  if (!ta) return;
  clearTimeout(padTimer);
  const key = ta.dataset.month;
  const val = ta.value;
  store.mutate('pad', (s) => {
    if ((s.scratchpads[key] || '') === val) return false;
    if (val.trim()) s.scratchpads[key] = val;
    else delete s.scratchpads[key];
  });
}

export { renderBoard };
