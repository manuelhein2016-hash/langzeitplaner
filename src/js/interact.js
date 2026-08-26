// Direct manipulation (§9). One pointer state machine for the whole board:
// press → maybe-drag → commit. Drags only begin past a 4 px threshold so a
// click to edit can never turn into an accidental move (5.5).
//
// WP-3 (LZP-402/404): all ten `store.mutate()` sites are now `store.apply(<name>, args)` — the
// named constructors in `core/ops.js`'s MUTATIONS table, which own the op shapes, the ADR 001
// §3.2 labels and the ATT-88 existence gates. THE GESTURES DID NOT CHANGE. Three rules govern
// the rewrite and every site below obeys them:
//
//   1. THE OP CARRIES AN ABSOLUTE VALUE, NEVER A DELTA (ADR 001 §3.2, §6). `move-bar` used to
//      read the bar and add `delta` to both ends inside the callback; it now computes both new
//      dates at the call site and ships them. A delta op delivered twice moves the bar twice,
//      and duplicate delivery is not an error condition — it is Tuesday.
//   2. THE DECLINES STAY EXACTLY WHERE V1 PUT THEM. Every `return false` inside a v1 callback
//      becomes an early `return` here, over the same read of the same live entry. Nothing is
//      logged, nothing is broadcast and nothing lands on the undo stack — same as v1.
//   3. WHAT V1 LEARNED INSIDE THE CALLBACK IS READ BEFORE IT. `unhid = store.ensureVisible()`
//      returned "was it hidden?" as a side effect of unhiding it; the op has to carry the
//      unhide, so the question is asked one layer up with `store.categoryVisible()` — the same
//      predicate, and the flash still fires after the re-render (4.6).
//
// `store.apply()` is synchronous through `emit()`, so the create-bar site can still find its
// freshly rendered `.bar-label` on the next line and go straight into naming it (3.3).

import { store, uid } from './store.js';
import { addDays, diffDays, parseISO, p2 } from './dates.js';
// 9.3's re-anchor rule. It WAS these four lines at `:330-334`; `core/entities.js` lifted them
// verbatim so the import door and this gesture can never drift apart (including the deliberate
// "<nonLeapYear>-02-29" quirk documented there).
import { reanchorRepeat } from './core/entities.js';
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

  // ADR 005 §1.5's one-line unblocker, and the reason it is worth its own row in the table.
  //
  // The Swift shell suppresses WKWebView's native context menu (which ignores the DOM event's
  // `preventDefault` entirely) and calls this global with the click point. It used to be
  // assigned at MODULE TOP LEVEL, which meant that merely importing this file touched `window`
  // — so the pointer state machine could not be imported under bare Node at all, and every
  // rule in it was reachable only through a real WKWebView. Installing it here makes the
  // module importable and therefore unit-testable, and ties the global's lifetime to the board
  // it actually drives instead of to the module graph.
  window.__lzpContextMenu = (x, y) => {
    const hit = document.elementFromPoint(x, y);
    openPopoverAt(hit?.closest?.('.day'));
  };
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

// ── entry lookups ────────────────────────────────────────────────────────────
//
// The v1 sites read the entry off the state object handed to the callback (`s.notes.find(…)`).
// `store.state` is now a PROJECTION of the op log rather than the truth itself, but it is the
// same live array and the same object identity, so the reads are unchanged — they simply moved
// from inside the callback to just before the `apply()`.
const noteById = (id) => store.state.notes.find((n) => n.id === id);
const barById = (id) => store.state.bars.find((b) => b.id === id);

// ── the edit guard (18.1, 18.2) ──────────────────────────────────────────────
//
// SEAM ONLY. This is the predicate ADR 004 §4.3 names for `interact.js:116-127` and
// `board.js:141-142`, landed now so the pointer state machine has one place to ask the question
// and WP-10 has nothing to retrofit into it. IT DOES NOT BUILD ANY FAMILY UI — that is WP-10's
// (LZP-901/902).
//
// IT IS UNCONDITIONALLY TRUE IN SOLO MODE, BY CONSTRUCTION AND NOT BY LUCK. `store._project()`
// runs the materialized board through `stripV2Fields` while there is no family space, and that
// keeps exactly `V1_ENTRY_FIELDS` — `isForeign` and `coEdit` are not among them, so both reads
// are `undefined` on every entry the solo board can produce and `canEdit` short-circuits true.
// The moment a family space exists the full projection is used and the same line starts biting.
//
// `canEdit(undefined)` is TRUE on purpose: this is a permission question, not an existence
// question. Every caller does its own `if (!entry) return` — v1's decline — and conflating the
// two would turn "the entry is gone" into "you may not edit it", which is a different bug.
export const canEdit = (entry) => !entry || entry.isForeign !== true || entry.coEdit === true;
const canEditNote = (id) => canEdit(noteById(id));
const canEditBar = (id) => canEdit(barById(id));

/** 16.4 / ADR 004 §3 — an entry's `visibility` is its category's default, read ONCE at creation
 *  and never again. Stripped out of the solo projection, so this is `undefined` there and the op
 *  constructor's own default ('privat', 16.1) applies; it starts carrying a value in WP-10. */
const defaultVisibilityOf = (catId) => store.category(catId)?.defaultVisibility;

/**
 * `[L]` — v1's `s.settings.lastCategoryId = catId` (story 4.2: "every entry has a category, and it
 * defaults to the last one used") is now the `lastCategoryId` ARGUMENT of the three `[L]` rows
 * below. `core/ops.js` turns it into a `pref.set` that rides OUTSIDE the undo group (rule U6), so
 * ⌘Z reverts the entry and leaves the remembered category alone — which is what v1 did, there by
 * accident (settings were not in `CONTENT_KEYS`) and here by design.
 *
 * The bridge that used to live here is gone: `store.js:_commit()` now reflects a committed group's
 * `pref.set` onto `state.settings` before `emit()`, so the register and the projection agree from
 * the same instant, at all seven `[L]` sites, without any call site holding a copy of the rule.
 */

export function deleteSelected() {
  if (!selection.id) return false;
  // v1 branched on `type === 'note'` and treated everything else as a bar. Normalising here
  // reproduces that dispatch verbatim while feeding the op constructor — which rejects any third
  // value — only the two it accepts.
  const kind = selection.type === 'note' ? 'note' : 'bar';
  const id = selection.id;
  const entry = kind === 'note' ? noteById(id) : barById(id);
  // 18.1 — a foreign entry that was not opted into co-editing is not mine to delete.
  if (!canEdit(entry)) return false;
  // ATT-88 · THE STALE-SELECTION PHANTOM, CLOSED TWICE OVER.
  //
  // v1's delete was `s.notes.filter(…)`: on an id that is no longer on the board it changed
  // nothing at all. A log has no no-ops. `note.set{_alive:false}` on an id with no registers
  // MINTS a register for an entity that never existed, permanently, and the family relay then
  // synchronises that ghost to every sibling device — invisible on the board, so nothing ever
  // cleans it up. `selection` is precisely the input that goes stale (⌫ fired twice, or an entry
  // a sibling deleted while it was selected here), which is why this is the site the gate was
  // found on.
  //
  //   · The CONSTRUCTOR refuses to mint: handed the register view it returns zero ops for an
  //     unknown target, and `store.apply()` then returns false having logged, broadcast and
  //     recorded nothing — v1's `return false` decline, one layer down.
  //   · THIS SITE refuses to re-tombstone. The constructor's gate is deliberately an EXISTENCE
  //     check and not a liveness one (`ops.js`: an already-dead entity still has registers, so a
  //     resurrect race stays admissible) — which leaves ⌫ on an entry that is already deleted
  //     emitting a fresh `_alive:false` and recording an undo step that visibly does nothing.
  //     That is the ATT-5 defect the suite has already decided against, so the entry has to be
  //     ON THE BOARD, which is exactly the condition v1's `filter` tested implicitly.
  //
  // The selection is cleared either way — it is gone whether or not we wrote anything — and the
  // return stays v1's `true`: the keystroke was handled.
  if (entry) store.apply('deleteSelected', { type: kind, id });
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

  // `locked` is the 18.1/18.2 guard seam (ADR 004 §4.3). It rides on the PENDING press rather
  // than on the branch condition, so a foreign entry still SELECTS on release — you must be able
  // to click Mum's holiday to read who it belongs to (17.6) — it simply never becomes a drag.
  // Always false in solo mode; see `canEdit` above.
  if (handle && barNode) {
    pending = {
      kind: 'resize',
      edge: handle.classList.contains('top') ? 'start' : 'end',
      id: barNode.dataset.barId, x: e.clientX, y: e.clientY,
      locked: !canEditBar(barNode.dataset.barId),
    };
  } else if (barNode) {
    pending = {
      kind: 'bar', id: barNode.dataset.barId, node: barNode,
      grabDate: dayNode?.dataset.date || dateUnderPointer(e),
      x: e.clientX, y: e.clientY,
      locked: !canEditBar(barNode.dataset.barId),
    };
  } else if (noteNode) {
    pending = {
      kind: 'note', id: noteNode.dataset.noteId, node: noteNode,
      fromDate: noteNode.dataset.date, x: e.clientX, y: e.clientY,
      locked: !canEditNote(noteNode.dataset.noteId),
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
  // 18.1 / 18.2 — bailing without assigning `drag` leaves `pending` in place, so the press still
  // resolves as a click on pointerup. That is deliberately the same shape as the "the entry is
  // gone" bails below (`if (!n) return`), which v1 already relied on.
  if (p.locked) return;
  if (p.kind === 'day') {
    // Vertical press-and-drag from an empty day lays down a bar (3.1).
    drag = { kind: 'create-bar', anchor: p.date, current: p.date, col: p.node.closest('.rows') };
    document.body.classList.add('is-creating');
    drag.preview = document.createElement('div');
    drag.preview.className = 'bar-preview';
    drag.preview.style.background = colorOf(store.category(store.state.settings.lastCategoryId).paletteRef);
    drag.col.appendChild(drag.preview);
  } else if (p.kind === 'note') {
    const n = noteById(p.id);
    if (!n) return;
    drag = { kind: 'move-note', id: p.id, fromDate: p.fromDate, note: n, target: p.fromDate };
    document.body.classList.add('is-dragging');
    p.node.classList.add('dragging');
    drag.ghost = makeGhost(n.text || t('emptyHint'));
    drag.dropRow = makeDropRow();
  } else if (p.kind === 'bar') {
    const b = barById(p.id);
    if (!b) return;
    drag = { kind: 'move-bar', id: p.id, bar: b, grabDate: p.grabDate, delta: 0 };
    document.body.classList.add('is-dragging');
    boardEl.querySelectorAll(`.bar[data-bar-id="${cssEsc(p.id)}"]`).forEach((n) => n.classList.add('dragging'));
    drag.ghost = makeGhost(b.label || t('untitledBar'));
  } else if (p.kind === 'resize') {
    const b = barById(p.id);
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
    // 4.6 — a new entry can never vanish into a hidden category. v1 got the answer as a side
    // effect of `store.ensureVisible()`, which unhid the category and reported whether it had
    // needed to. The unhide is now a `cat.set{visible:true}` INSIDE the same group (so it is one
    // ⌘Z, exactly as v1's was), which means the question has to be asked first. Same predicate:
    // `categoryVisible()` is false only when the category exists AND is hidden, which is
    // precisely when `ensureVisible()` returned true — including the missing-category case,
    // where both say "no" and no phantom `cat:` register is minted.
    const unhid = !store.categoryVisible(catId);
    store.apply('createBar', {
      id, startDate: a, endDate: b, categoryId: catId,
      visibility: defaultVisibilityOf(catId),
      unhideCategoryId: unhid ? catId : null,
    });
    // After the transaction, not inside it: apply() re-renders the legend, which
    // would otherwise wipe the flash before anyone saw it (4.6).
    if (unhid) flashCategory(catId);
    select('bar', id);
    // A fresh bar has no label yet — go straight into naming it (3.3).
    // apply() re-renders synchronously, so the chip is already in the DOM.
    const lab = boardEl.querySelector(`.bar-label[data-bar-id="${cssEsc(id)}"]`);
    if (lab) startBarLabelEdit(lab);
    return;
  }
  if (drag.kind === 'move-note' && drag.target && drag.target !== drag.fromDate) {
    const { id, target } = drag;
    const n = noteById(id);
    if (!n) return;                                   // v1's `return false`, verbatim
    // 9.3 — one object per series: keep the series' first year, move the month/day the whole
    // series lands on. The op carries the ABSOLUTE resulting date either way.
    store.apply('moveNote', {
      id, date: n.repeatsYearly ? reanchorRepeat(n.date, target) : target,
    });
    return;
  }
  if (drag.kind === 'move-bar' && drag.delta) {
    const { id, delta } = drag;
    const b = barById(id);
    if (!b) return;                                   // v1's `return false`, verbatim
    // NOT `{delta}`. The op carries both new endpoints (ADR 001 §3.2, §6): a relative op
    // delivered twice — a retry, a re-fold of the tail, a sibling replaying the log — would move
    // the bar twice, and nothing downstream could tell that apart from two drags.
    store.apply('moveBar', {
      id, startDate: addDays(b.startDate, delta), endDate: addDays(b.endDate, delta),
    });
    return;
  }
  if (drag.kind === 'resize' && drag.next) {
    const { id } = drag;
    const [s0, e0] = drag.next;
    const b = barById(id);
    if (!b) return;                                   // v1's first `return false`
    if (b.startDate === s0 && b.endDate === e0) return;   // v1's second: nothing moved
    // Only the edge that actually moved is written. `updateDrag` clamps the dragged edge against
    // the other one (`:288-289`), so exactly one of these is ever true — and re-writing the
    // stationary edge at a fresh stamp would let a resize beat a concurrent remote move of the
    // other end for no reason. Same argument `ops.js` makes for `toggleRepeat`'s `date`.
    const f = { id };
    if (b.startDate !== s0) f.startDate = s0;
    if (b.endDate !== e0) f.endDate = e0;
    store.apply('resizeBar', f);
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
      const unhid = !store.categoryVisible(catId);      // 4.6, read before the txn — see :302
      store.apply('createNoteInline', {
        id, date, text, categoryId: catId,
        visibility: defaultVisibilityOf(catId),
        unhideCategoryId: unhid ? catId : null,
        // `[L]`. It rides along as a `pref.set` in the LOCAL space, outside the group and with
        // no gid, so ⌘Z on the new note does not also drag the swatch picker backwards (rule U6
        // — v1's `lastCategoryId` survived undo because settings were not in `CONTENT_KEYS`).
        lastCategoryId: catId,
      });
      if (unhid) flashCategory(catId);
      select('note', id);
    },
  });
}

function startNoteEdit(noteNode) {
  const id = noteNode.dataset.noteId;
  const n = noteById(id);
  if (!n) return;
  if (!canEdit(n)) return;                              // 18.1 — no editor on someone else's note
  const rows = noteNode.closest('.rows');
  const day = noteNode.closest('.day');
  const row = parseInt(day.dataset.row, 10);
  select('note', id);
  makeEditor(rows, row, n.text, {
    categoryId: n.categoryId,
    onCommit: (text, catId) => {
      const x = noteById(id);
      if (!x) return;                                   // v1's `return false`, verbatim
      if (!canEdit(x)) return;                          // 18.1 — the guard is on the WRITE too
      // 2.2 — clearing the text is how you delete without a dialog. `editNoteInline` reads
      // `text: ''` as exactly that, and takes the ATT-88 existence gate with it.
      if (!text) { store.apply('editNoteInline', { id, text: '' }); return; }
      if (x.text === text && x.categoryId === catId) return;   // v1's second decline
      // v1 wrote `lastCategoryId` only when the category actually moved (`:573-575`); `null`
      // is how the constructor is told to omit the `[L]` pref op entirely.
      const recat = x.categoryId !== catId;
      store.apply('editNoteInline', {
        id, text,
        categoryId: recat ? catId : null,
        lastCategoryId: recat ? catId : null,
      });
    },
  });
}

function startBarLabelEdit(labNode) {
  const id = labNode.dataset.barId;
  const b = barById(id);
  if (!b) return;
  if (!canEdit(b)) return;                              // 18.1 — no editor on someone else's bar
  const rows = labNode.closest('.rows');
  select('bar', id);
  const row = Number(labNode.dataset.row) || 0;
  makeEditor(rows, row, b.label, {
    forBar: true, right: labNode.style.right, maxLength: 40,
    categoryId: b.categoryId,
    onCommit: (label, catId) => {
      const x = barById(id);
      if (!x) return;                                   // v1's `return false`, verbatim
      if (!canEdit(x)) return;                          // 18.1 — the guard is on the WRITE too
      if (x.label === label && x.categoryId === catId) return;
      // A bar label may legally be empty — `create-bar` writes `''` — so unlike a note there is
      // no empty-means-delete branch here. v1 has none either.
      const recat = x.categoryId !== catId;
      store.apply('editBarLabel', {
        id, label,
        categoryId: recat ? catId : null,
        lastCategoryId: recat ? catId : null,
      });
    },
  });
}

// ── scratchpad (F10) ─────────────────────────────────────────────────────────

let padTimer = null;

/**
 * Sites 9 and 10 share one op shape but stay two named mutations, because a missed one is a lost
 * paragraph and `V1_MUTATE_SITES` enumerates them separately.
 *
 * The guard is v1's, verbatim — `(s.scratchpads[key] || '') === val` — and it is doing more work
 * than it looks. Blanking a month that never had a scratchpad is `delete` on a missing key in v1,
 * a genuine no-op; in a log it would mint a `pad:<month>` register, and this is the single most
 * reachable phantom in the app (`onPadBlur` fires on every focusout, so clicking into an empty
 * pad and clicking out again is enough). ATT-88 is closed twice over here: once by this decline
 * and once inside `padOps`, which asks the register view before emitting a blank tombstone.
 *
 * `born` says whether this month's pad is new, which is the same question `_born` answers for a
 * note or a bar: the month has a scratchpad register from now on, and `createdAt` derives from
 * that stamp.
 * @param {'padTyping'|'padBlur'} name @param {string} month `YYYY-MM` @param {string} text
 */
function commitPad(name, month, text) {
  const cur = store.state.scratchpads[month];
  if ((cur || '') === text) return;                     // v1's `return false`, verbatim
  // v1 stores the UNTRIMMED value when `.trim()` is non-empty, and deletes the key otherwise;
  // `padOps` reproduces both halves off `text` alone.
  store.apply(name, { month, text, born: cur === undefined });
}

function onPadInput(e) {
  const ta = e.target.closest('.pad textarea');
  if (!ta) return;
  const key = ta.dataset.month;
  const val = ta.value;
  ta.closest('.pad').classList.toggle('empty', !val.trim());
  clearTimeout(padTimer);
  // Debounced so a paragraph of typing is one undo step, not forty. THE DEBOUNCE IS THE OP
  // BOUNDARY (rule U9) — one `pad.set` per 600 ms pause, not one per keystroke.
  padTimer = setTimeout(() => commitPad('padTyping', key, val), 600);
}
function onPadBlur(e) {
  const ta = e.target.closest?.('.pad textarea');
  if (!ta) return;
  clearTimeout(padTimer);
  // The blur path bypasses the debounce and commits immediately.
  commitPad('padBlur', ta.dataset.month, ta.value);
}

export { renderBoard };
