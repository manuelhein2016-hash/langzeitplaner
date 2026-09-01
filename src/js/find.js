// Find is an overlay state of the board, not a separate screen (F14 design
// note): non-matches dim, matches keep full colour, Enter steps through hits.
// It searches note text, bar labels and scratchpads.
//
// ═════════════════════════════════════════════════════════════════════════════
// A6 / 14.1 — AND THE FAMILY'S ENTRIES (LZP-806)
//
// *"Find searches family entries too (shared text, Belegt matches on owner
// name); dimming logic unchanged."* Three consequences, and the third is the
// one that had to be designed rather than added:
//
//   1. SHARED TEXT NEEDS NOTHING. Another member's Geteilt note renders as a
//      `.note` with its text in it, so the sweep below already found it the day
//      `board.js` learnt to draw it. What follows does not widen the sweep; it
//      widens the HAYSTACK of the nodes it already visits.
//   2. A BELEGT ENTRY HAS NO TEXT TO MATCH, so the owner is the handle. „Mama"
//      finds Mama's busy blocks — which is the only question a Belegt block can
//      answer, and exactly the question a family asks of one („wann kann Mama?").
//      The name comes from `popover.js:memberNameOf`, the one display-name port
//      (17.6); with no roster it falls back to the initial, which is what the
//      chip on the board says, so the handle is never something the user cannot
//      see.
//   3. DIMMING IS UNCHANGED, LITERALLY. `.hit` on the matching nodes and
//      `body.finding` on the body is v1's whole mechanism, and a foreign entry
//      is a `.note` / `.bar-label` like any other. There is no family branch in
//      the marking, the stepping, the counter or the CSS.
//
// v1's counting rule survives intact and now has a second tenant: *find counts
// entries, not segments* (DESIGN-DECISIONS.md). A foreign bar's `data-bar-id`
// is its ENTITY KEY (`fbar:mem_…/uuid`), which is unique per entry across
// members by construction, so the segment de-duplication below counts Mama's
// six-month stripe once — while her yearly repeat still counts once per
// occurrence, because each is a real, separate place on the board.
// ═════════════════════════════════════════════════════════════════════════════

import { t } from './i18n.js';
import { store } from './store.js';
import { currentModel } from './board.js';
import { memberNameOf } from './popover.js';

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
  const handles = ownerHandles();
  const seenBars = new Set();
  for (const n of nodes) {
    const text = n.tagName === 'TEXTAREA' ? n.value : n.textContent;
    // A6 — the owner's name joins the node's own ink, and only for a foreign
    // entry: `handles` holds nothing else, so my own board searches exactly
    // what v1 searched.
    const hay = `${text ?? ''}${handles.get(n.dataset.noteId || n.dataset.barId) ?? ''}`;
    if (!hay || !hay.toLowerCase().includes(q)) continue;
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

// ─────────────────────────────────────────────────────────────────────────────
// A6 — the family half of the haystack
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The searchable handle for ONE foreign entry: the owner's name, and their
 * initial behind it.
 *
 * Both, because they are two different failures otherwise. The name is what a
 * person types („Mama"); the initial is what the board actually shows in the
 * chip, and on a Mac whose roster has not folded yet it is *all* it shows —
 * searching for something visible and being told „keine Treffer" is the worse
 * of the two. They are joined by a space, which no query can span, so the pair
 * can never fabricate a match that neither half would make.
 *
 * There is deliberately no level word in here. „Belegt" is already the block's
 * rendered text and the sweep matches it from the DOM; adding it a second time
 * would double-count nothing but would put a level in the store-wide list where
 * the visible board is the only place it is honest.
 * @param {Object} e a materialized foreign entry @returns {string}
 */
const handleOf = (e) => ` ${memberNameOf(e.ownerId) ?? ''} ${e.initial ?? ''}`;

/**
 * entryId → handle, for the foreign entries only.
 *
 * Keyed on `id` because that is what `board.js` puts in `data-note-id` /
 * `data-bar-id`, and for a foreign entry `id` IS the entity key — unique across
 * members by construction (`materialize.js:foreignCandidate`), which is what
 * makes a Map lookup safe here at all.
 *
 * Rebuilt per query rather than cached: it costs one pass over the state per
 * keystroke on a board that has already spent one on the DOM, and a cache would
 * have to be invalidated by every op that changes a name, a member or an entry.
 * @returns {Map<string,string>}
 */
function ownerHandles() {
  const map = new Map();
  for (const list of [store.state.notes, store.state.bars]) {
    for (const e of list) if (e && e.isForeign) map.set(e.id, handleOf(e));
  }
  return map;
}

/**
 * What ONE entry contributes to the store-wide search (14.2), text and handle.
 *
 * The redaction seam again, in the one place off the board where it could have
 * been forgotten: a Belegt entry's text was never transmitted, so there is
 * nothing to match and nothing to show — the entry answers to its owner's name
 * and renders as the word. `board.js:renderNote` keys the same decision on
 * `redacted` for the same reason: never on the absence of a text.
 * @returns {{hay: string, text: string}}
 */
function searchable(e, ownText) {
  if (!e.isForeign) return { hay: ownText, text: ownText };
  if (e.redacted) return { hay: handleOf(e), text: t('belegt') };
  return { hay: `${ownText}${handleOf(e)}`, text: ownText };
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
    // `n.text` was `n.text.toLowerCase()` here, which is v1 and was safe for as
    // long as every note in the array was mine and therefore had a text. A
    // foreign Belegt note has `text: null` — it was never transmitted — and one
    // keystroke in the search field threw a TypeError that took the whole find
    // with it, offscreen list and all. `searchable` is where that decision now
    // lives, once, for both arrays.
    const { hay, text } = searchable(n, typeof n.text === 'string' ? n.text : '');
    if (hay.toLowerCase().includes(query)) out.push({ kind: 'note', date: n.date, text });
  }
  for (const b of store.state.bars) {
    const { hay, text } = searchable(b, typeof b.label === 'string' ? b.label : '');
    if (hay.toLowerCase().includes(query))
      out.push({ kind: 'bar', date: b.startDate, text });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
