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
import { parseISO, dowISO, WD_DE, WD_EN, MONTH_DE, MONTH_EN } from './dates.js';
import { notesOnDate, barsOnDate } from './core/entities.js';
// 16.4 / ADR 004 §3. `core/visibility.js` is a LEAF in `core/` — it imports nothing — so this is
// not a door into `family/` and solo mode reaches only the level POLICY, never the projection.
import { visibilityForNewEntry } from './core/visibility.js';

let node = null;
let ctx = null;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE SHARING CLUSTER ARRIVES THROUGH THE ONE DOOR — IT IS NOT IMPORTED (A7, LZP-702)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠ THERE IS DELIBERATELY NO `import … from './family/sharing.js'` ABOVE, AND ADDING ONE TURNS A
// GATE RED. ADR 003 §7 gate 2 and ADR 002 §2.4: nothing under `src/js/family/` may be reachable
// from the boot graph — statically at all, and dynamically through EXACTLY ONE door,
// `family/mount.js`. `tests/tier1/network-scope.test.js` §2 asserts both rows, and it caught this
// module the first time the cluster was wired the obvious way.
//
// The gate is not a formality here, it is the better design. Solo mode now fails to render the
// cluster for TWO independent reasons, either of which suffices:
//
//   1. `store._project()` runs `stripV2Fields` while there is no family space, and `visibility`
//      is not in `V1_ENTRY_FIELDS` — so no entry HAS a level for a control to change
//      (`sharing.js:sharingApplies` is that absence, read as an answer); and
//   2. this port is `null`, so not one byte of the module has been evaluated.
//
// 16.1 says oversharing must be *structurally* impossible. Two structures, no flag, no `if` that
// somebody can invert.
let sharing = null;

/**
 * Install the sharing cluster. Called from `family/mount.js` — the one door — when a
 * Familienkreis exists, and from `tests/tier2/sharing-control.dom.js`, which is the same call.
 * Passing `null` uninstalls it, which is what leaving a circle must do.
 * @param {Object|null} mod the `family/sharing.js` module namespace
 */
export function useSharing(mod) {
  sharing = mod || null;
  return sharing;
}

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

// Notes and bars that render on `date`, yearly-repeat projections included.
//
// ADR 005 §3: ONE implementation of "is this entry on this day". What used to stand here was a
// second one, hand-written beside `layout.js`'s — and the yearly-repeat rules (9.4's Feb-29 fold,
// 9.5's "never before its first year") are exactly the kind of thing two copies drift apart on.
// `notesOnDate` is the degenerate one-day case of the very range query the grid runs for a whole
// board, so the popover and the grid can no longer disagree about what a day holds; that is what
// makes the "+n" chip's count and the stack it opens the same list (2.4).
//
// The visibility gate is unchanged: `categoryVisibilityOf` is v1's tri-state rule (`visible`
// missing or true → visible, only an explicit `false` hides), i.e. `store.categoryVisible`.
const notesOn = (date) => notesOnDate(store.state, date).map((o) => o.note);
const barsOn = (date) => barsOnDate(store.state, date);

/**
 * 4.2 — v1 wrote `s.settings.lastCategoryId` inside the mutation, so picking a colour here also
 * set the default for the next entry.
 *
 * The op is emitted INSIDE the transaction but in the LOCAL space with no `gid`, which is what
 * keeps ⌘Z from dragging 4.2 backwards (rule U6 — v1's behaviour, not a change). `store.js`'s
 * `_commit()` reflects it onto `store.state.settings` before `emit()`, so the register and the
 * live board move together and every reader below sees the new default immediately, exactly as
 * they did when v1 assigned it inside the callback.
 */
const rememberCategory = (tx, catId) => tx.pref({ lastCategoryId: catId });

export function openDayPopover(anchor, date, opts = {}) {
  closePopover();
  // `share` is the ONE open disclosure, remembered across `render()` so a level change does not
  // slam the strip shut under the finger that just used it — and so the §7.4 downgrade sentence
  // is still on screen at the moment it is true. `{id, kind, lastChange}` or null.
  // `nameOf` is the display-name port (17.6); there is no roster carrying names on this device
  // yet, so it is absent and `attributionLine` falls back honestly. See the report.
  ctx = { date, onChange: opts.onChange || (() => {}), share: null, nameOf: opts.nameOf || null };
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

  reopenSharing();

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
    // This site only READS lastCategoryId — it never writes it. ADR 001 §3.2 marks the row `[L]`;
    // the v1 source does not, and the source wins (reported).
    store.txn('create-note', (tx) => {
      // 4.6, inside the same group, so the unhide is part of the one ⌘Z.
      unhid = tx.ensureVisible(catId);
      tx.note(uid()).create({
        date, text: v, categoryId: catId, repeatsYearly: false,
        // 16.4 / ADR 004 §3 — ONE of the six create paths, and it was the one hardcoding the
        // floor. The category's default is read exactly once, here, at creation; changing a
        // default never re-publishes an existing entry, which 16.1 forbids as a bulk disclosure
        // triggered by a settings click.
        visibility: visibilityForNewEntry(store.category(catId) ?? null), coEdit: false,
      });
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

/**
 * 18.1 — only the owner writes, and in the popover that is a CORRECTNESS gate before it is a
 * permission one.
 *
 * A foreign entry's `id` IS its entity key (`fnote:mem_…/uuid`, `materialize.js:foreignCandidate`),
 * so `tx.note(entry.id).set(…)` would mint the register `note:fnote:mem_…/uuid` in MY personal
 * space — an entity that cannot exist, in a space that is not its own.
 *
 * `sharing.js:canEditEntry` is the EVENTUAL predicate (18.2 makes a co-editable foreign entry
 * editable), and it is deliberately not used here yet: a co-editor's write is a `pub.set` built
 * by `core/project.js:projectCoEditPatch`, and no store path publishes anything at all today
 * (LZP-701's blocker). An editor that cannot write is worse than no editor, so the popover gates
 * on ownership and LZP-902 switches the predicate over when the write path lands.
 */
const writable = (entry) => !entry.isForeign;

/** 17.2 — others' entries carry the MEMBER's colour, never a category colour of mine.
 *  ADR 004 §4.3 names the `layout.js:142` version of this trap: `colorOf(undefined)` silently
 *  returns `PALETTE[0]` (blue), which would render Mama's entry as one of my blue ones. The
 *  popover had the identical fall-through through `store.category()`, whose `|| categories[0]`
 *  is the same accident by a different route. A member with no colour on this device yet gets
 *  neutral ink — never a category tone. */
function paintDot(dot, entry) {
  if (!entry.isForeign) {
    dot.style.background = colorOf(store.category(entry.categoryId).paletteRef);
    dot.title = store.category(entry.categoryId).name;
    return dot;
  }
  dot.style.background = entry.memberColorRef ? colorOf(entry.memberColorRef) : 'var(--ink-4)';
  dot.title = attribution(entry) || '';
  return dot;
}

/** ADR 004 §4.2 — a Belegt block shows the word in place of the text, everywhere. `board.js:137`
 *  is the same seam on the grid; this is it in the popover, which reads from the same `redacted`
 *  decoration so the two cannot disagree about what a Belegt entry says. */
const rowText = (entry, fallback) =>
  (entry.redacted && sharing ? sharing.levelWord('belegt') : (entry.text ?? entry.label) || fallback);

/** 17.6, through the port. `null` in solo mode, where there is nobody to attribute anything to. */
const attribution = (entry) =>
  (sharing ? sharing.attributionLine(entry, { nameOf: ctx?.nameOf }) : null);

function noteRow(n, date) {
  const row = el('div', 'pop-row');
  row.dataset.entry = n.id;
  row.dataset.kind = 'note';
  const mine = writable(n);

  const dot = paintDot(el(mine ? 'button' : 'span', 'dot'), n);
  if (mine) {
    dot.addEventListener('click', () =>
      toggleSwatches(row, n.categoryId, (catId) => {
        store.txn('recategorise', (tx) => {
          const x = tx.get('note', n.id);
          if (!x || x.categoryId === catId) return false;   // the v1 decline protocol, verbatim
          tx.note(n.id).set({ categoryId: catId });
          rememberCategory(tx, catId);
        });
      })
    );
  }
  row.appendChild(dot);

  const txt = el('div', 'txt', rowText(n, '…'));
  if (mine) {
    txt.dataset.edit = n.id;
    txt.title = n.text;
    txt.addEventListener('click', () => startEdit(row, txt, n));
  } else {
    txt.style.cursor = 'default';
    txt.title = attribution(n) || '';
  }
  row.appendChild(txt);

  if (!mine) {
    // A7's cluster is the viewer's half here: the level, the sentence saying whose it is, and
    // 17.6's attribution. No control — 18.1.
    attachCluster(row, n, 'note');
    return row;
  }

  const rep = el('button', 'act' + (n.repeatsYearly ? ' on' : ''), '↻');
  rep.title = t('repeatsYearly');
  rep.addEventListener('click', () => {
    // ONE op, two fields, ONE stamp — a repeat that was switched on has always been anchored,
    // and two ops could be split by a merge into a repeat with the wrong anchor year.
    store.txn('toggle-repeat', (tx) => {
      const x = tx.get('note', n.id);
      if (!x) return false;
      const on = !x.repeatsYearly;
      // 9.5 — the series starts in the year it was switched on, so anchor it to the occurrence
      // the user was actually looking at. Switching it OFF leaves `date` alone: v1 assigns the
      // date only on the ON branch, and writing an unchanged value at a fresh stamp would let a
      // toggle beat a concurrent remote move for no reason. (ADR 001 §3.2 row 13 reads as though
      // both directions carry the date; the code is right and the row is wrong — reported.)
      tx.note(n.id).set(on ? { repeatsYearly: true, date } : { repeatsYearly: false });
    });
    refresh();
  });
  row.appendChild(rep);

  // A7 / ADR 004 §4.3 — "between popover.js:212 and :214 for notes (after the ↻ toggle, before
  // delete)". Exactly here, and the ordering matters twice over: `↻` stays the row's FIRST
  // `.act`, which two characterization probes index by position.
  attachCluster(row, n, 'note');

  const del = el('button', 'act', '✕');
  del.title = t('delete');
  del.addEventListener('click', () => {
    // v1's `notes.filter()` is a harmless no-op on an id that is already gone; a log has no
    // no-ops, so the tombstone goes through the vetted constructor and its ATT-88 existence
    // gate, which declines rather than minting a register for a note that never existed.
    store.apply('deleteNotePopover', { id: n.id });
    refresh();
  });
  row.appendChild(del);
  return row;
}

function barRow(b) {
  const row = el('div', 'pop-row');
  row.dataset.entry = b.id;
  row.dataset.kind = 'bar';
  const mine = writable(b);

  const dot = paintDot(el(mine ? 'button' : 'span', 'dot'), b);
  dot.style.borderRadius = '1px';
  dot.style.height = '9px';
  dot.style.width = '4px';
  // Bars need a recolour path too — creation locks in the last-used category,
  // and without this the only fix was delete-and-redraw.
  if (mine) {
    dot.addEventListener('click', () =>
      toggleSwatches(row, b.categoryId, (catId) => {
        store.txn('recategorise-bar', (tx) => {
          const x = tx.get('bar', b.id);
          if (!x || x.categoryId === catId) return false;
          tx.bar(b.id).set({ categoryId: catId });
          rememberCategory(tx, catId);
        });
      })
    );
  }
  row.appendChild(dot);
  const txt = el('div', 'txt', rowText(b, t('untitledBar')));
  txt.title = mine
    ? `${b.startDate} – ${b.endDate}`
    : (attribution(b) || `${b.startDate} – ${b.endDate}`);
  row.appendChild(txt);
  const range = el('span', 'act');
  range.textContent = `${b.startDate.slice(8)}.${b.startDate.slice(5, 7)}.–${b.endDate.slice(8)}.${b.endDate.slice(5, 7)}.`;
  range.style.font = '400 8.5px var(--mono)';
  row.appendChild(range);
  // ADR 004 §4.3: "`barRow` currently has no ✕ and no ↻ — the cluster must be added to BOTH row
  // builders or bars lose visibility control in the popover." A shared family holiday bar is the
  // single most likely thing in the product to be Geteilt (A4, 18.2), so this is not symmetry for
  // its own sake.
  attachCluster(row, b, 'bar');
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// The sharing cluster (A7, deliverable 18 · LZP-702) — `family/sharing.js` builds every pixel
// and every string of it; this file only decides WHERE it hangs and WHICH transaction it writes.
//
// ⚠ NO `pub.*` FIELD IS CONSTRUCTED HERE. The two writes below touch the entity's own
// `visibility` / `coEdit` TRUTH registers in the personal space and nothing else. What leaves the
// device is built from those registers by `core/project.js:projectForFamily` on the store's
// publish path — the single choke point of ADR 004 §2 — and there is no second path.
// ─────────────────────────────────────────────────────────────────────────────

/** The trigger, in the row's existing `.act` slot. Zero rows in the resting state (16.3, 1.x). */
function attachCluster(row, entry, kind) {
  if (!sharing || !sharing.clusterApplies(entry)) return;   // solo mode: see `useSharing`
  const trig = sharing.sharingTrigger(entry);
  trig.addEventListener('click', () => toggleSharing(row, entry, kind));
  row.appendChild(trig);
}

/** One disclosure at a time: the category swatches and the sharing strip are siblings in the
 *  same slot and would otherwise stack, which at 214 px is two popovers' worth of height. */
function closeDisclosures() {
  if (!node) return;
  node.querySelector('.pop-cat')?.remove();
  node.querySelector('.pop-share')?.remove();
  for (const b of node.querySelectorAll('.share-trig')) b.setAttribute('aria-expanded', 'false');
}

function openSharing(row, entry, kind, lastChange = null) {
  closeDisclosures();
  ctx.share = { id: entry.id, kind, lastChange };
  const strip = sharing.sharingStrip({
    entry,
    nameOf: ctx.nameOf,
    lastChange,
    // ⚠ THE CALLBACKS CLOSE OVER THE **ID**, NEVER OVER `entry`.
    //
    // `store.js:reconcileList` preserves entry-object identity across a mutation on purpose
    // ("a caller may be holding a reference to one of these"), so `entry` and `tx.get`'s answer
    // are the SAME OBJECT for a surviving entry — and a mutant that read the captured one
    // survived the whole 36-cell domain, because on every surviving entry the two reads are
    // provably equal. They stop being equal for an entry that does NOT survive: a delete plus a
    // ⌘Z (18.6 — "undo of my own deletion restores the entry as a NEW operation") makes
    // `reconcileList` push a fresh object, and the strip would then be holding a detached
    // snapshot of a level the user last saw some time ago.
    //
    // Rather than guard against reading it, the closure cannot reach it. There is exactly one
    // read of the entry on the write path and it is inside the transaction.
    onLevel: (level) => applyLevel(entry.id, kind, level),
    onCoEdit: (on) => applyCoEdit(entry.id, kind, on),
  });
  row.insertAdjacentElement('afterend', strip);
  row.querySelector('.share-trig')?.setAttribute('aria-expanded', 'true');
  return strip;
}

function toggleSharing(row, entry, kind) {
  const isOpen = ctx.share && ctx.share.id === entry.id && node.querySelector('.pop-share');
  if (isOpen) { closeDisclosures(); ctx.share = null; return; }
  openSharing(row, entry, kind);
}

/** `render()` rebuilds every row, so the open strip is re-created rather than preserved — which
 *  is what keeps a level change from slamming it shut under the finger that just used it, and
 *  what keeps ADR 002 §7.4's downgrade sentence on screen at the moment it is true. */
function reopenSharing() {
  const want = ctx?.share;
  if (!want) return;
  const row = node.querySelector(`.pop-row[data-entry="${CSS.escape(want.id)}"]`);
  const entry = currentEntry(want.kind, want.id);
  if (!row || !entry) { ctx.share = null; return; }
  openSharing(row, entry, want.kind, want.lastChange);
}

const currentEntry = (kind, id) =>
  (kind === 'bar' ? store.state.bars : store.state.notes).find((e) => e.id === id);

/**
 * 16.3/16.5 — the level change. ONE transaction, therefore one ⌘Z (18.4).
 *
 * THE ONLY READ OF THE ENTRY IS `tx.get`, INSIDE THE TRANSACTION. A level that moved under the
 * open strip — a co-editor, a second Mac, an admin unshare landing between the render and the
 * click — therefore meets v1's decline protocol rather than an overwrite with a level the user
 * never saw. See the note at `openSharing` for why the entry is not passed in.
 */
function applyLevel(id, kind, level) {
  if (!sharing) return;
  let done = null;
  store.txn('set-visibility', (tx) => {
    const x = tx.get(kind, id);
    if (!x) return false;
    done = sharing.planVisibilityChange(x, level);
    if (!done) return false;                       // the v1 decline protocol, verbatim
    tx[kind](id).set(done.patch);
  });
  if (!done) return;
  ctx.share = { id, kind, lastChange: done };
  refresh();
}

/** 18.2 — „Familie darf bearbeiten". Refused below Geteilt by `planCoEditChange` as well as by
 *  the disabled input, so a caller that gets past the DOM still cannot set it (ADR 004 §8). */
function applyCoEdit(id, kind, on) {
  if (!sharing) return;
  let done = null;
  store.txn('toggle-coedit', (tx) => {
    const x = tx.get(kind, id);
    if (!x) return false;
    done = sharing.planCoEditChange(x, on);
    if (!done) return false;
    tx[kind](id).set(done.patch);
  });
  if (!done) return;
  ctx.share = { id, kind, lastChange: null };             // a grant is not a downgrade
  refresh();
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
    store.txn('edit-note', (tx) => {
      const x = tx.get('note', n.id);
      if (!x) return false;
      // Clearing the text IS the delete, and it is tested first — a note that was already empty
      // is deleted rather than declined as "unchanged". v1, verbatim. The `!x` guard above is
      // also the existence gate the tombstone needs (ATT-88).
      if (!v) tx.note(n.id).del();
      else if (x.text === v) return false;
      else tx.note(n.id).set({ text: v });
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
  closeDisclosures();                 // one disclosure at a time — see `closeDisclosures`
  ctx.share = null;
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
