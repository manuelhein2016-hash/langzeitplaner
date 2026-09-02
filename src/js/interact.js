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
import { visibilityForNewEntry } from './core/visibility.js';
// 18.1 / 18.2 — THE predicate, not a copy of it. `board.js` withholds the grips from the same
// function (through the model row it builds in `layout.js:decorate`), so the pixels and the
// pointer state machine can never disagree about who may edit what. See the guard below.
import { canEditEntry } from './layout.js';
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

// ── the edit guard (18.1, 18.2) — E9 / LZP-901, LZP-902 ──────────────────────
//
// THE SEAM IS NOW WIRED, AND THE FIRST THING IT DOES IS STOP CARRYING ITS OWN COPY OF THE RULE.
// `layout.js:canEditEntry` is the ONE predicate. `board.js` reads it (through the model row's
// `canEdit`) to decide the `readonly` class and to withhold the resize grips; this file reads the
// same function to decide whether a press may become a gesture. Two answers to "may I edit this?"
// on one board is not a style problem — it is the board telling the hand one thing and the eye
// another, and it was measurably true here:
//
//     entry { isForeign: true, coEdit: true, level: 'belegt' }
//       layout.js  → false   (no grips, `readonly` painted)
//       this file  → true    (the drag started anyway)
//
// That window is not hypothetical. `pub.coEdit` is a GOVERNING register and `authz.js` stage 3c
// never drops governing fields, so between the arrival of a Geteilt → Belegt downgrade and the
// arrival of the `pub.coEdit: null` beside it, a register map really does hold `level: 'belegt'`
// next to `coEdit: true` — `layout.js` says so in its own comment, and this file used to be the
// place that ignored it.
//
// IT IS UNCONDITIONALLY TRUE IN SOLO MODE, BY CONSTRUCTION AND NOT BY LUCK. `store._project()`
// runs the materialized board through `stripV2Fields` while there is no family space, and that
// keeps exactly `V1_ENTRY_FIELDS` — `isForeign`, `coEdit` and `level` are not among them, so
// every read is `undefined` on a solo board and `canEditEntry` short-circuits true. The moment a
// family space exists the full projection is used and the same line starts biting. That is what
// makes the v1 characterization suite the right oracle for this file: v1 has no foreign entries,
// so not one of its rows may move.
//
// `canEdit(undefined)` is TRUE on purpose: this is a permission question, not an existence
// question. Every caller does its own `if (!entry) return` — v1's decline — and conflating the
// two would turn "the entry is gone" into "you may not edit it", which is a different bug.
export const canEdit = (entry) => !entry || canEditEntry(entry);

/**
 * ⚠ PERMISSION IS NOT CAPABILITY, AND ON THIS BOARD THEY ARE NOT YET THE SAME SET.
 *
 * `canEdit` answers 18.1/18.2's question: MAY this entry be edited. `authorable` answers a
 * different one that only this file has to care about: can this device AUTHOR that write at all.
 *
 * A foreign entry's `id` IS its entity key — `fbar:mem_…/uuid` (`materialize.js:foreignCandidate`,
 * and it must be, because a bare uuid is forgeable while an owner-segmented key is not). Every
 * commit below routes through `store.apply(<v1 mutation>)`, whose op constructors call
 * `entities.js:noteKey(id)` / `barKey(id)` — and those **throw `EntityKeyError`** on anything that
 * is not a bare uuid. So a gesture on a genuinely co-editable foreign entry did not "silently do
 * nothing": it threw out of `onPointerUp`, ABOVE the lines that clear `drag`, drop the ghost and
 * remove `is-dragging` from `<body>` — leaving the board wedged mid-drag with a floating ghost
 * and a pointer machine that would never complete another gesture until reload. Proven, and
 * killed by a mutant, in `tests/tier2/coedit.dom.js` §2.
 *
 * WHY THE ANSWER IS A GUARD AND NOT THE WRITE PATH. 18.2's co-editor write is a `pub.set` into
 * the FAMILY space, built by `core/project.js:projectCoEditPatch` — which exists, is reviewed, and
 * is narrower than the projection — and then sealed. Sealing is where it stops: ADR 004 §2.2
 * barrier 4 makes `crypto/envelope.js:sealOp` re-derive the level from `store.familyLevelOf`, and
 * that function answers `null` for a foreign key **on purpose** ("this device may not publish
 * somebody else's entry"), which barrier 4 turns into a `RedactionError` — and a `RedactionError`
 * on the publish path sets `store.redactionHalt`, stopping ALL family sync from this Mac. So the
 * one thing this file must never do is let a gesture reach that seam. It is the same blocker that
 * holds the admin unshare (18.3, E7 finding 4) and it is owed by `store.js` +
 * `crypto/envelope.js`, not by this file. See the report.
 *
 * `authorable(undefined)` is TRUE for the same reason `canEdit(undefined)` is.
 *
 * ── E9 INTEGRATION · THE CAPABILITY LANDED, SO THE TWO SETS ARE NOW THE SAME SET ────────────
 *
 * The paragraph above described a real gap and it is closed. `store.applyCoEdit(entityKey,
 * changes)` is the door a foreign write goes through: it reads the level from
 * `store.familyCoEditLevelOf` — the AUTHENTICATED fold, not this file's opinion — mints the op
 * through `core/project.js:coEditOp`, and never touches `barKey`/`noteKey`, so the
 * `EntityKeyError` that wedged the board is not merely caught, it is unreachable. `sealOp`'s
 * barrier 4 now has a level for a co-editable foreign entity and seals instead of halting.
 *
 * `authorable` stays, and stays a SEPARATE question, for the case it was always about: an entry
 * this device may edit but whose write it cannot author. That set is now exactly "a foreign entry
 * with no store door" — a store that predates `applyCoEdit`. Keeping the term is what makes the
 * board decline instead of wedging if the two files are ever deployed a version apart.
 */
const authorable = (entry) => !entry
  || entry.isForeign !== true
  || typeof store.applyCoEdit === 'function';

/** May this press become a gesture? Permission AND capability — see `authorable`. */
const mayGesture = (entry) => canEdit(entry) && authorable(entry);

/**
 * ── THE ONE PLACE A GESTURE'S COMMIT CHOOSES ITS DOOR (18.1 / 18.2) ────────────────────────
 *
 * Every gesture below used to end in `store.apply(<v1 mutation>)`. On a foreign entry that is
 * the wrong door twice over — it addresses a bare uuid (and throws), and it would write a TRUTH
 * register for an entity whose truth lives on somebody else's Mac. A co-edit is a `pub.set` into
 * the family space and nothing else.
 *
 * The split is on `entry.isForeign`, which `materialize.js` sets, and NOT on `coEdit`: whether
 * the family will accept the write is `store.applyCoEdit`'s question, answered from the
 * authenticated fold one layer down. This function decides only WHICH REGISTER SET the gesture
 * is about, which is a structural fact about the entity (ADR 001 §4.4) and cannot be stale.
 *
 * ⚠ THE V1 PATH IS BYTE-FOR-BYTE UNCHANGED, and that is why the v1 suite is the oracle. On a
 * solo board `stripV2Fields` removes `isForeign` entirely, so `entry.isForeign` is `undefined`,
 * the first branch is taken, and this function is `store.apply` with extra steps.
 *
 * @param {Object} entry    the materialized entry the gesture is about
 * @param {string} name     the v1 mutation name, for my own entry
 * @param {Object} args     the v1 mutation args, for my own entry
 * @param {Object} changes  the `pub.*` changes, for a co-editor's write
 * @returns {boolean}
 */
function commitEntry(entry, name, args, changes) {
  if (!entry || entry.isForeign !== true) return store.apply(name, args);
  return store.applyCoEdit(entry.id, changes);
}
const canEditNote = (id) => mayGesture(noteById(id));
const canEditBar = (id) => mayGesture(barById(id));

/**
 * 16.4 / ADR 004 §3 — an entry's `visibility` is its category's default, read ONCE at creation
 * and never again.
 *
 * It goes through `core/visibility.js:visibilityForNewEntry`, which is the one function that owns
 * that rule, rather than reading the field here. The old form — `store.category(catId)?.
 * defaultVisibility` — was CORRECT and correct only by coincidence: it answers `undefined` for a
 * dangling category and for a category whose `defaultVisibility` is a value outside the enum, and
 * three other files (`ops.js`'s enum validation, `replace.js`'s floor, `materialize.js`) all had
 * to hold for that `undefined` to become `'privat'` rather than a level nobody chose. Routed
 * through the policy it holds on its own, and it FAILS CLOSED twice: never the last level used,
 * never `undefined` handed on for somebody else to default.
 */
const defaultVisibilityOf = (catId) => visibilityForNewEntry(store.category(catId) ?? null);

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
  // ── 18.1's SECOND VERB, AND THE ONE PLACE 18.2's GRANT DELIBERATELY DOES NOT REACH ────────
  //
  // A foreign entry that was not opted into co-editing is not mine to delete. AND A CO-EDITABLE
  // ONE IS NOT MINE TO TOMBSTONE EITHER — which is why this gate is `isForeign`, not
  // `mayGesture`: everywhere else in this file 18.2 widened what a gesture may do, and here it
  // must not.
  //
  // `pub.alive` is a GOVERNING register (`ops.js:FIELDS`), and `authz.js` stage 3a folds every
  // governing field from the entity's structural OWNER alone. A co-editor's `pub.alive: false` is
  // therefore an op every honest device rejects: the entry would vanish from MY board and stay on
  // everyone else's — a divergence, which is worse than a refusal. 18.2 grants the right to edit
  // the family vacation bar, not the right to take it out of the family's year; 18.6's "deletions
  // propagate" is the OWNER's deletion; and `projectCoEditPatch` has no field that could carry
  // one, so this is a refusal the projection would make anyway, made early where it is cheap.
  //
  // IT DECLINES v1-STYLE — `false`, AND THE SELECTION SURVIVES. The entry is still on the board
  // and still the thing the user is looking at, so clearing the selection would be a second
  // consequence of a keystroke that was supposed to have none.
  if (!mayGesture(entry) || (entry && entry.isForeign === true)) return false;
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
    const moved = n.repeatsYearly ? reanchorRepeat(n.date, target) : target;
    commitEntry(n, 'moveNote', { id, date: moved }, { 'pub.date': moved });
    return;
  }
  if (drag.kind === 'move-bar' && drag.delta) {
    const { id, delta } = drag;
    const b = barById(id);
    if (!b) return;                                   // v1's `return false`, verbatim
    // NOT `{delta}`. The op carries both new endpoints (ADR 001 §3.2, §6): a relative op
    // delivered twice — a retry, a re-fold of the tail, a sibling replaying the log — would move
    // the bar twice, and nothing downstream could tell that apart from two drags.
    const s1 = addDays(b.startDate, delta);
    const e1 = addDays(b.endDate, delta);
    commitEntry(b, 'moveBar', { id, startDate: s1, endDate: e1 },
      { 'pub.startDate': s1, 'pub.endDate': e1 });
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
    const pub = {};
    if (b.startDate !== s0) { f.startDate = s0; pub['pub.startDate'] = s0; }
    if (b.endDate !== e0) { f.endDate = e0; pub['pub.endDate'] = e0; }
    commitEntry(b, 'resizeBar', f, pub);
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
  if (!mayGesture(n)) return;                           // 18.1 — no editor on someone else's note
  const rows = noteNode.closest('.rows');
  const day = noteNode.closest('.day');
  const row = parseInt(day.dataset.row, 10);
  select('note', id);
  makeEditor(rows, row, n.text, {
    categoryId: n.categoryId,
    onCommit: (text, catId) => {
      const x = noteById(id);
      if (!x) return;                                   // v1's `return false`, verbatim
      if (!mayGesture(x)) return;                       // 18.1 — the guard is on the WRITE too
      // 2.2 — clearing the text is how you delete without a dialog. `editNoteInline` reads
      // `text: ''` as exactly that, and takes the ATT-88 existence gate with it.
      if (!text) {
        // A co-editor clearing the text writes `pub.text: ''`, NOT a deletion: 18.2 grants the
        // right to edit the entry, and `pub.alive` is a governing field the owner alone folds
        // (stage 3a). Emptying somebody else's note is an edit; removing it is not on offer.
        commitEntry(x, 'editNoteInline', { id, text: '' }, { 'pub.text': '' });
        return;
      }
      if (x.text === text && x.categoryId === catId) return;   // v1's second decline
      // v1 wrote `lastCategoryId` only when the category actually moved (`:573-575`); `null`
      // is how the constructor is told to omit the `[L]` pref op entirely.
      const recat = x.categoryId !== catId;
      // The category is MINE and local — categories are never synced (A3), so a co-edit carries
      // the text and nothing else. `COEDIT_FIELDS.fnote` has no category field to carry it in.
      commitEntry(x, 'editNoteInline', {
        id, text,
        categoryId: recat ? catId : null,
        lastCategoryId: recat ? catId : null,
      }, { 'pub.text': text });
    },
  });
}

function startBarLabelEdit(labNode) {
  const id = labNode.dataset.barId;
  const b = barById(id);
  if (!b) return;
  if (!mayGesture(b)) return;                           // 18.1 — no editor on someone else's bar
  const rows = labNode.closest('.rows');
  select('bar', id);
  const row = Number(labNode.dataset.row) || 0;
  makeEditor(rows, row, b.label, {
    forBar: true, right: labNode.style.right, maxLength: 40,
    categoryId: b.categoryId,
    onCommit: (label, catId) => {
      const x = barById(id);
      if (!x) return;                                   // v1's `return false`, verbatim
      if (!mayGesture(x)) return;                       // 18.1 — the guard is on the WRITE too
      if (x.label === label && x.categoryId === catId) return;
      // A bar label may legally be empty — `create-bar` writes `''` — so unlike a note there is
      // no empty-means-delete branch here. v1 has none either.
      const recat = x.categoryId !== catId;
      commitEntry(x, 'editBarLabel', {
        id, label,
        categoryId: recat ? catId : null,
        lastCategoryId: recat ? catId : null,
      }, { 'pub.label': label });
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
