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
/** bar id → its stripe elements, rebuilt by each `run()`. See `mark()`. */
let stripes = new Map();

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
  if (!q) {
    clearMarks();
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
  // Every node that must be wearing `.hit` when this call returns. Collected
  // rather than marked as we go — see `applyMarks` below for why.
  const wantHit = new Set();
  for (const n of nodes) {
    const text = n.tagName === 'TEXTAREA' ? n.value : n.textContent;
    // A6 — the owner's name joins the node's own ink, and only for a foreign
    // entry: `handles` holds nothing else, so my own board searches exactly
    // what v1 searched.
    //
    // The join is CONDITIONAL, not because a missing handle is a special case
    // but because `${text}${undefined ?? ''}` is a string allocation per node
    // per keystroke that produces exactly `text` — 862 of them on the family
    // fixture. A board with no family reaches none of them. The two branches
    // must stay one expression apart: a query may span the seam between an
    // entry's own text and its owner's name, so they are still searched JOINED
    // and never separately.
    const handle = handles.get(n.dataset.noteId || n.dataset.barId);
    const hay = handle === undefined ? (text ?? '') : `${text ?? ''}${handle}`;
    if (!hay || !hay.toLowerCase().includes(q)) continue;
    wantHit.add(n);
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
  //
  // ═══ ONE PASS OVER THE STRIPES, NOT ONE PASS PER HIT (LZP-1007) ════════════
  // This was `document.querySelectorAll('.board .bar[data-bar-id="…"]')` INSIDE
  // the loop — a full-document attribute-selector scan per matching bar, so the
  // cost was O(hits × nodes on the board). On a solo board that is invisible: a
  // handful of bars, 1 975 nodes. On the 8-member fixture it is 135 bar labels
  // against 4 195 nodes, and it is paid on EVERY KEYSTROKE, because `run()` is
  // the input handler. Measured on that fixture (`e8-density-perf.dom.js` §E1),
  // a one-letter query — the widest possible hit set, which is exactly what the
  // FIRST keystroke of every search is — cost 25.4 ms, half of it here.
  //
  // The stripes are indexed once instead. Same nodes, same classes, same order;
  // the only thing that changes is that the board is walked once rather than
  // once per hit. `cssEsc` was needed on this path and is now gone from the
  // file entirely (R-5 took its last caller out of `mark()`), which also
  // removes a bar id's ability to reach a CSS selector parser at all.
  //
  // R-5 finished the job. Two things were still proportional to the BOARD here
  // rather than to the hits: the scan itself was `querySelectorAll` with an
  // attribute selector, which is a walk over all 4 195 elements, and it indexed
  // every stripe on the board when only the stripes of MATCHING bars are ever
  // read. It is now the live `.bar` collection — engine-maintained, the same
  // one `board.js#scrubMarks` leans on — filtered by the ids that matched.
  const hitBarIds = new Set();
  for (const n of hits) if (n.dataset.barId) hitBarIds.add(n.dataset.barId);
  stripes = new Map();
  if (hitBarIds.size) {
    const live = boardRoot()?.getElementsByClassName('bar') || [];
    for (let i = 0; i < live.length; i++) {
      const b = live[i];
      const id = b.dataset.barId;
      if (!id || !hitBarIds.has(id)) continue;
      const list = stripes.get(id);
      if (list) list.push(b); else stripes.set(id, [b]);
      wantHit.add(b);
    }
  }

  // ═══ MARK THE DIFFERENCE, NOT THE WHOLE HIT SET (R-5) ══════════════════════
  // This is the second half of the cost the LZP-1007 note above found the first
  // half of, and it is where `findWorst`'s remaining milliseconds were.
  //
  // MEASURED, before this changed: of 21.4 ms in `run()`, **16.5 ms was one
  // line** — the first `getBoundingClientRect()` in `scrollTo`, which is the
  // first geometry read after the marking and therefore pays for the style
  // recalculation the marking made necessary. The other eight phases together
  // were 2.8 ms. The read is not the cost; the marking is, and the read is
  // merely where the bill arrives.
  //
  // And the marking was doing twice the work it needed to. `clearMarks()` took
  // `.hit` off EVERY node that had it, and the loop then put it back on every
  // node that matched — so a keystroke that moves the hit set from „E" to „El"
  // dirties ~500 nodes it is about to re-mark identically. Measured on the 8x2
  // fixture: touching 358 notes + 136 bar nodes costs 11.6 ms of recalculation
  // whatever the property is (border-bottom 8.8 ms, box-shadow 8.6 ms,
  // background alone 4.1 ms — so this is style recalculation and paint, not
  // reflow, and no CSS edit would have helped).
  //
  // `applyMarks` brings the marked set to exactly `wantHit` and touches only
  // the difference. It reads the set it is diffing against out of the LIVE
  // `getElementsByClassName` collection rather than out of a cached Set, which
  // is what makes it safe next to `board.js#scrubMarks`: a render that strips
  // every mark, a full rebuild that replaces every node, `applySelection`, or
  // anything else that touches these classes simply shows up in the collection,
  // and the next `run()` reconciles to it. There is no state to get stale.
  applyMarks('hit', wantHit);

  // 14.2 [Could] — hits in rolled-out history, listed as clickable results.
  renderHistory(offscreenHits(q));

  if (!hits.length) {
    // `clearMarks()` used to run at the top of every call and took `.current`
    // with it. It does not any more, so the no-results path has to say so:
    // without this the previous query's `.current` outline survives on a board
    // whose counter reads „keine Treffer".
    applyMarks('current', EMPTY);
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

/**
 * Store-wide matches whose dates fall outside the visible 12-month window.
 *
 * This was `historyHits(q).filter(...)`: every entry in the store was
 * lowercased and substring-tested, the matches were collected and SORTED, and
 * then the half of them that are on screen — the half the board has already
 * marked — was thrown away. The date test is the cheap one and it is now first,
 * so the string work and the sort are paid only for entries that can actually
 * appear in the list. The result is the same list in the same order;
 * `historyHits` itself is untouched and still uncapped and still sorted, which
 * is what the v1 rows pin.
 */
function offscreenHits(q) {
  const m = currentModel();
  if (!m) return [];
  return scanStore(q, (date) => date < m.firstISO || date > m.lastISO);
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
  const n = hits[cursor];
  const want = new Set();
  if (n) {
    want.add(n);
    // The stripe index `run()` built a moment ago, instead of a second
    // full-document attribute scan per step. It is rebuilt by every `run()`,
    // and `refreshFind()` makes every re-render a `run()`, so it is exactly as
    // fresh as `hits` itself — which `step()` has always trusted.
    if (n.dataset.barId) for (const b of stripes.get(n.dataset.barId) || []) want.add(b);
  }
  applyMarks('current', want);
  if (!n) return;
  counter.textContent = `${cursor + 1}/${hits.length}`;
  scrollTo(n);
}

/** The board root the marks live under; `null` before the DOM exists (tier 1). */
const boardRoot = () => document.querySelector('.board');

/**
 * Make the set of nodes under the board carrying `cls` be exactly `want`,
 * writing only the difference.
 *
 * The „had" side is read from the live HTMLCollection `getElementsByClassName`
 * maintains — the same collection `board.js#scrubMarks` relies on, and for the
 * same reason: the engine keeps it per class name, so this is a length read and
 * a copy rather than a walk over 4 195 elements. It is snapshotted into an array
 * BEFORE anything is removed, because removing the class shrinks the collection
 * under the loop.
 *
 * `classList.contains` is a string test against the token list; it neither
 * invalidates style nor forces layout. `add`/`remove` do, which is the whole
 * point of only calling them on the difference.
 */
function applyMarks(cls, want) {
  const root = boardRoot();
  if (!root) return;
  const live = root.getElementsByClassName(cls);
  const had = [];
  for (let i = 0; i < live.length; i++) had.push(live[i]);
  for (const n of had) if (!want.has(n)) n.classList.remove(cls);
  for (const n of want) if (!n.classList.contains(cls)) n.classList.add(cls);
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

const EMPTY = new Set();
function clearMarks() {
  applyMarks('hit', EMPTY);
  applyMarks('current', EMPTY);
  stripes = new Map();
}

/** All store-wide matches, regardless of the visible window. */
export function historyHits(q) {
  return scanStore(q, null);
}

/**
 * The store-wide sweep both callers share. `keep` is an optional date predicate
 * applied BEFORE any string work; `null` means every date.
 * @param {string} q @param {((date: string) => boolean)|null} keep
 */
function scanStore(q, keep) {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const out = [];
  // `searchable()` is the decision, and it stays the decision — but it is only
  // CONSULTED for a foreign entry. For my own note the answer it returns is
  // `{hay: text, text}`, so calling it allocates an object per entry per
  // keystroke to be told what the caller already had. 3 475 of those on the
  // family fixture; on a solo board, all of them.
  for (const n of store.state.notes) {
    if (keep && !keep(n.date)) continue;
    // `n.text` was `n.text.toLowerCase()` here, which is v1 and was safe for as
    // long as every note in the array was mine and therefore had a text. A
    // foreign Belegt note has `text: null` — it was never transmitted — and one
    // keystroke in the search field threw a TypeError that took the whole find
    // with it, offscreen list and all. `searchable` is where that decision now
    // lives, once, for both arrays.
    const own = typeof n.text === 'string' ? n.text : '';
    if (!n.isForeign) {
      if (own.toLowerCase().includes(query)) out.push({ kind: 'note', date: n.date, text: own });
      continue;
    }
    const { hay, text } = searchable(n, own);
    if (hay.toLowerCase().includes(query)) out.push({ kind: 'note', date: n.date, text });
  }
  for (const b of store.state.bars) {
    if (keep && !keep(b.startDate)) continue;
    const own = typeof b.label === 'string' ? b.label : '';
    if (!b.isForeign) {
      if (own.toLowerCase().includes(query)) out.push({ kind: 'bar', date: b.startDate, text: own });
      continue;
    }
    const { hay, text } = searchable(b, own);
    if (hay.toLowerCase().includes(query)) out.push({ kind: 'bar', date: b.startDate, text });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}
