// The legend is both display and control (F4 design note): it names the
// categories, toggles their visibility, and is the way into managing them.

import { store, uid } from './store.js';
import { PALETTE, colorOf, nextFreeRef } from './palette.js';
import { t, getLang } from './i18n.js';
import { el, openSheet, field } from './ui.js';

let legendEl = null;
let notify = () => {};

/**
 * ── §D · THE HORIZONTAL BUDGET OF THE 40 px ROW ──────────────────────────────────────────────
 *
 * `.legend` is `flex:1; min-width:0; overflow:hidden` (app.css:130). It does not wrap and it does
 * not scroll: whatever does not fit is GONE, with no ellipsis, no scrollbar and no cue. Until now
 * nothing in this file asked whether the row fit, so three things were true at once and all three
 * were defects rather than trades:
 *
 *   §D1 · at 900 × 640 — the window `DESIGN-DECISIONS.md` open question 4 declares as v1's FLOOR
 *         — the German row with four categories and eight members overflowed by 22 px, and the
 *         22 px that fell off the end were the family half's `· n` opener. That opener is story
 *         17.3's only entry point: a control that exists and cannot be clicked is not shipped.
 *   §D2 · the fit was decided once, at render time. Dragging the window narrower re-decided
 *         nothing, so the row silently clipped whatever the new width could not hold. „Silently"
 *         is the defect; 3.6 („never clipped silently") is the principle it breaks.
 *   §D3 · when the row was full, the FAMILY half yielded — whatever the cause. A user who added
 *         categories (4.4, unbounded by design) lost the section carrying a privacy control to
 *         make room for the half that had just grown. A3 says the legend has two sections; it
 *         does not say one of them is the shock absorber for the other.
 *
 * ── THE RULE, IN ONE SENTENCE ────────────────────────────────────────────────────────────────
 *
 *     THE HALF THAT GREW IS THE HALF THAT YIELDS, AND WHAT YIELDS IS DISCLOSED, NEVER CLIPPED.
 *
 * The category half is unbounded by design (4.4 adds, 4.5 caps only the palette at ~10 tones) and
 * user-authored, so its width is a number nobody can promise. The family half is bounded — at most
 * `MAX_LIVE_MEMBERS` = 8 chips, measured at 186 px in `family-members.dom.js` §5 — and it already
 * owns a designed collapse (R14's disclosure: the chips go, the `· n` opener stays). So:
 *
 *   1. Everything at its natural width, if the row holds it. This is the common case and it costs
 *      exactly what it cost before: one forced layout.
 *   2. Otherwise the CATEGORIES yield first, youngest first — a new category is pushed last
 *      (`addCategory`), so the ones that go are the ones that arrived most recently. They are not
 *      dropped: they move behind a „+n" chip that opens the full stack. That is v1's OWN idiom for
 *      exactly this situation — 2.4 („the first two notes plus +n; clicking expands a popover with
 *      the full stack"), 3.8, and open question 5's answer: „+n pattern. Popover, as specced."
 *   3. …but only down to `NAMED_FLOOR` categories. Below that the family half yields its chips
 *      instead (its collapse is one click from being undone; a category name behind „+n" is one
 *      click too, and the floor is what keeps the row from becoming a member-chip strip with no
 *      colour key on it). The floor is 4 because 4 is what v1's default board has (4.1 — „a
 *      sensible default set (Work / Family / Travel / Deadlines)"), not because 4 measured well.
 *   4. If even that does not fit, the categories keep yielding, down to none named. „+n" still
 *      accounts for every one of them, and the `· n` opener still ends the row: at v1's floor the
 *      worst row is `+4 · bearbeiten │ · 8`, about 130 px of the 340 px the legend gets at 900.
 *
 * Steps 2–4 are ARITHMETIC OVER MEASURED WIDTHS, not a breakpoint: the row's demand is the member
 * count times the length of user-authored category names in whichever of two languages is on, and
 * no constant can stand for that.
 *
 * ── WHY `applyOverflow` IN `family/membersui.js` IS LEFT ALONE ────────────────────────────────
 *
 * That function asks one question — „does the host overflow?" — and collapses the chips if it
 * does. It is not wrong; it was answering with the only information it had, because the category
 * half never fitted itself first. This file now fits the category half BEFORE the family half is
 * asked, so `applyOverflow`'s question has become the right one and its answer executes step 3.
 * The seam still points one way (`membersui` → here), no class name of its crosses this file, and
 * the family half is still measured rather than modelled: `drawFamilyHalf()` reads the section's
 * real box.
 */
const NAMED_FLOOR = 4;

/** The categories currently behind „+n" — read by `flashCategory` and by the disclosure sheet. */
let overflowCats = [];

/** Re-entrancy guard: the width observer must not answer a resize this file is causing. */
let painting = false;
let lastWidth = -1;
let widthObserver = null;

/**
 * ── A3 · THE FAMILY HALF OF THE LEGEND, AND IT IS DELIBERATELY A NULL CALLBACK ───────────────
 *
 * This is the same seam `settings.js` has as `setFamilySections`, for the same reason and with
 * the same direction of dependency.
 *
 * `legend.js` is in the BOOT GRAPH — `main.js` imports it on every launch, solo or not — so it
 * may know that a second section EXISTS and may not know what is in it. An import of
 * `family/membersui.js` here, static or dynamic, would put the member reader one edge away from
 * every solo launch, which is exactly what ADR 003 §7 gate 2 forbids and what
 * `tests/attack/privacy-e5-silence.test.js` §5 measures. So the direction is inverted:
 * `family/membersui.js` — which is only ever evaluated behind `family/mount.js`, the one dynamic
 * door — calls this, and until it does the legend has one fewer section and nothing else changes.
 *
 * ── WHY THE SEAM AND NOT THE MutationObserver IT REPLACES ────────────────────────────────────
 *
 * `renderLegend()` opens with `legendEl.textContent = ''`, so anything another module appended
 * was erased on every category toggle, every „bearbeiten" and every `flashCategory`.
 * `membersui.js` bridged that with a `MutationObserver` that re-appended when its own node had
 * gone — correct, and a bridge: it made the family half arrive one animation frame LATE and only
 * ever as a REPAIR, so between the wipe and the callback the toolbar was briefly a legend with
 * one section. A `renderLegend()` that calls its second section is not a repair; there is no
 * frame in which the section is missing, and the observer's cost (one live observer per family
 * Mac, and a callback on every unrelated toolbar mutation) is gone with it.
 *
 * THE OBSERVER IS DELETED. There is no fallback and there must not be one: two mechanisms that
 * both re-append the same node is how it gets appended twice.
 *
 * @type {((host:HTMLElement) => void)|null}
 */
let familyLegend = null;

/**
 * Called by `family/membersui.js#initFamilyLegend`. There is no other caller.
 *
 * A call that changes nothing REDRAWS NOTHING. `initMembersUI()` runs its teardown on every
 * mount, including the first, and a legend that rebuilt itself every time the settings sheet
 * asked whether this Mac is still in a circle would be v1 paying for a question about family
 * mode. The redraw happens on the transition, which is the only moment there is anything to see.
 */
export function setFamilyLegend(fn) {
  const next = typeof fn === 'function' ? fn : null;
  if (next === familyLegend) return;
  familyLegend = next;
  renderLegend();
}

export function initLegend(container, onChange) {
  legendEl = container;
  notify = onChange || (() => {});
  renderLegend();
  watchLegendWidth();
}

export function renderLegend() {
  if (!legendEl) return;
  painting = true;
  try { paintLegend(); } finally { painting = false; }
  lastWidth = legendEl.clientWidth;
}

/**
 * ── THE ORDER IS DELIBERATE, AND IT IS NOT THE ORDER THE ROW READS IN ────────────────────────
 *
 * A3's two sections still land in A3's order — categories, „bearbeiten", then the family half,
 * last, behind the toolbar's own rule. But the family half is DRAWN FIRST, into the empty row,
 * and the categories are then inserted BEFORE it. That is the only way to learn what the family
 * half costs at its natural width: once the row overflows, `membersui.js:applyOverflow` has
 * already collapsed the chips and the number is gone.
 *
 * Drawn into an empty row, the family half is never collapsed by that measurement (nothing else
 * is on the row to overflow it), so `famNatural` is the real 186 px-at-eight figure and the fit
 * below can ask an honest question about it. The one exception is a host too narrow to hold the
 * family half alone — under ~200 px, well below v1's 900 px floor — and that case is detected
 * (`famAtMin`) rather than mismodelled.
 */
function paintLegend() {
  legendEl.textContent = '';
  const lang = getLang();
  const cats = store.state.categories.slice();

  // A3's SECOND section — inside the same wipe-and-rebuild that erased it before.
  // A section that throws must not take „Meine Kategorien" down with it — the categories are v1
  // and ship on every Mac; the family half is an addition and its failure is its own.
  const fam = drawFamilyHalf();
  const famNatural = fam ? fam.getBoundingClientRect().width : 0;
  const famAtMin = !!fam && overflowing();

  paintCategoryHalf(cats, cats.length, lang, fam);
  fitRow(cats, lang, fam, famNatural, famAtMin);
}

/** True when the row is wider than the box that holds it — i.e. something is being clipped. */
const overflowing = () => legendEl.scrollWidth > legendEl.clientWidth + 0.5;

/**
 * Draw (or redraw) the family half and hand back its node.
 *
 * The section is identified as „the child this file did not put there" rather than by
 * `membersui.js`'s id or class: the seam is a callback, and a callback is the whole contract.
 */
function drawFamilyHalf() {
  if (!familyLegend) return null;
  const mine = new Set(legendEl.children);
  try { familyLegend(legendEl); } catch (e) {
    console.warn('[legend] the family half did not draw', e);
    return null;
  }
  for (const n of legendEl.children) if (!mine.has(n)) return n;
  // A redraw of a section that was already there: it is still the one child that is not mine.
  for (const n of legendEl.children) if (!n.classList.contains('legend-item')
    && !n.classList.contains('legend-edit') && !n.classList.contains('legend-more')) return n;
  return null;
}

/**
 * Rebuild the category half — `keep` names, then „+n" for the rest, then „bearbeiten" — leaving
 * the family half exactly as it is. Nothing here touches that node, which is what lets the fit
 * change its mind about the categories without re-opening the question `applyOverflow` answered.
 */
function paintCategoryHalf(cats, keep, lang, fam) {
  for (const n of [...legendEl.children]) if (n !== fam) n.remove();
  for (let i = 0; i < keep; i++) legendEl.insertBefore(categoryItem(cats[i], lang), fam);
  overflowCats = cats.slice(keep);
  if (overflowCats.length) legendEl.insertBefore(moreChip(overflowCats.length, lang), fam);
  const edit = el('button', 'legend-edit', t('edit'));
  edit.addEventListener('click', openCategoryManager);
  legendEl.insertBefore(edit, fam);
}

/** One category, as both display and control (F4 design note). Used on the row and in the sheet. */
function categoryItem(c, lang, onToggled) {
  const item = el('button', 'legend-item');
  item.dataset.catId = c.id;
  item.dataset.visible = String(c.visible !== false);
  item.setAttribute('aria-pressed', String(c.visible !== false));
  const sw = el('span', 'sw');
  sw.style.background = colorOf(c.paletteRef);
  sw.style.color = colorOf(c.paletteRef);
  item.appendChild(sw);
  item.appendChild(document.createTextNode(catName(c, lang)));
  item.title = `${catName(c, lang)} · ${store.countEntriesIn(c.id)}`;
  // 4.3 — isolate a category by clicking it in the legend.
  //
  // ABSOLUTE, not a toggle (ops.js #17): the site reads the current value and emits the NEW
  // one, so two devices clicking the same category concurrently converge on one answer instead
  // of cancelling each other out. `x.visible === false` is v1's own expression verbatim
  // (`legend.js:37`), which is why a category with no `visible` field toggles to `false`
  // (ATT-91) — it renders as visible, so the first click must hide it. The lookup goes through
  // `store.state` exactly as v1's did, so a category that has gone away throws here, as it did
  // in v1, rather than emitting an op about an entity nobody has.
  //
  // The SAME function builds the row and the „+n" sheet, so a category that the row could not
  // hold is not a second, weaker control: it is this one, in a different place.
  item.addEventListener('click', () => {
    const x = store.state.categories.find((y) => y.id === c.id);
    store.apply('toggleCategory', { id: c.id, visible: x.visible === false });
    notify('legend');
    onToggled?.();
  });
  return item;
}

/**
 * 2.4's „+n", on the legend instead of on a day. A count, opening the full stack.
 *
 * It is a BUTTON and it says a number, so it can collide with no category anybody has ever named
 * — the same argument `membersui.js` makes for the family half's `· n` opener one section over.
 */
function moreChip(count, lang) {
  ensureFitCss();
  const b = el('button', 'legend-more', `+${count}`);
  b.type = 'button';
  b.dataset.count = String(count);
  b.title = lang === 'en'
    ? `${count} more categories — the row is full; click for all of them`
    : `${count} weitere Kategorien — die Zeile ist voll; klicken zeigt alle`;
  b.setAttribute('aria-label', b.title);
  b.addEventListener('click', () => openOverflowSheet());
  return b;
}

/**
 * 2.4 verbatim: „clicking expands a popover with the FULL stack". Not the hidden ones — all of
 * them, in board order, each one the same control it is on the row. A sheet that listed only the
 * overflow would make the user hold two halves of one legend in their head.
 */
function openOverflowSheet() {
  const hidden = new Set(overflowCats.map((c) => c.id));
  openSheet({
    title: t('categories'),
    narrow: true,
    build: (body, api) => {
      ensureFitCss();
      const lang = getLang();
      const list = el('div', 'legend-more-list');
      for (const c of store.state.categories) {
        const row = categoryItem(c, lang, () => api.rebuild());
        if (hidden.has(c.id)) row.classList.add('legend-more-hidden');
        list.appendChild(row);
      }
      body.appendChild(list);
      const note = el('p', 'hint');
      note.style.margin = '12px 0 0';
      note.textContent = lang === 'en'
        ? 'The toolbar row could not hold every name at this window width — the ones it dropped are marked. Nothing is hidden from the board, and the printed legend strip still carries all of them.'
        : 'Die Werkzeugzeile hat bei dieser Fensterbreite nicht alle Namen gefasst — die ausgelagerten sind markiert. Auf dem Board fehlt nichts, und die gedruckte Legende trägt weiterhin alle.';
      body.appendChild(note);
    },
    actions: [{ label: t('done'), kind: 'primary', run: (api) => api.close() }],
  });
}

/**
 * THE FIT. Measured widths in, one repaint out.
 *
 * @param {Array} cats        every category, in board order (youngest last)
 * @param {string} lang
 * @param {HTMLElement|null} fam   the family half, or null on a solo Mac
 * @param {number} famNatural      its width with the chips shown
 * @param {boolean} famAtMin       it was ALREADY collapsed when drawn alone — the host is tiny
 */
function fitRow(cats, lang, fam, famNatural, famAtMin) {
  const avail = legendEl.clientWidth;
  // Not laid out yet (boot, a hidden toolbar, a detached host). Fitting against a zero-width box
  // would bucket every category for no reason; the width observer comes back when there is a
  // width to fit against.
  if (!(avail > 1)) return;

  const n = cats.length;
  const gap = parseFloat(getComputedStyle(legendEl).columnGap) || 0;
  const catW = [...legendEl.querySelectorAll('.legend-item')].map((x) => x.getBoundingClientRect().width);
  const editEl = legendEl.querySelector('.legend-edit');
  const editW = editEl ? editEl.getBoundingClientRect().width : 0;
  const moreW = measureMoreChip(n, lang, fam);
  if (catW.length !== n) return;                  // a redraw raced us; the next one will fit it

  /** Does a row of `k` named categories (+ „+n" if any are left over) fit beside a `famW` family? */
  const fits = (k, famW) => {
    let sum = editW;
    let parts = 1;
    for (let i = 0; i < k; i++) { sum += catW[i]; parts++; }
    if (k < n) { sum += moreW; parts++; }
    if (famW > 0) { sum += famW; parts++; }
    return sum + gap * Math.max(0, parts - 1) <= avail + 0.5;
  };
  const most = (famW) => { let k = n; while (k > 0 && !fits(k, famW)) k--; return k; };

  let keep = most(famNatural);
  let famDirty = false;
  // Step 3 — the categories have yielded past v1's own default set and the row is still full.
  // Now, and only now, the family half gives up its chips. The exploratory redraw happens with
  // the WHOLE category half still on the row, which is what makes `applyOverflow`'s question
  // („does the host overflow?") answer yes; the collapsed section's real width is then measured
  // rather than guessed.
  if (fam && !famAtMin && keep < Math.min(NAMED_FLOOR, n)) {
    drawFamilyHalf();
    famDirty = true;
    const keepMin = most(fam.getBoundingClientRect().width);
    if (keepMin > keep) { keep = keepMin; famDirty = false; }
  }

  paintCategoryHalf(cats, keep, lang, fam);
  // The collapse bought no category back, so it bought nothing: give the chips their room again.
  if (famDirty) drawFamilyHalf();

  // THE BACKSTOP. The arithmetic above is over real boxes, but sub-pixel gaps, a font that
  // finished loading between two frames, or a category renamed to something enormous can still
  // leave the row one pixel long — and one pixel long is a clipped `· n` opener, which is the
  // whole defect. So the answer is verified against the layout and walked down until it holds.
  for (let guard = n; guard > 0 && keep > 0 && overflowing(); guard--) {
    keep -= 1;
    paintCategoryHalf(cats, keep, lang, fam);
  }
}

/** Build the widest „+n" this row could need, measure it in place, take it back out. */
function measureMoreChip(n, lang, fam) {
  if (n === 0) return 0;
  const probe = moreChip(n, lang);
  legendEl.insertBefore(probe, fam);
  const w = probe.getBoundingClientRect().width;
  probe.remove();
  return w;
}

/**
 * §D2 — THE FIT FOLLOWS THE WINDOW.
 *
 * `applyOverflow` ran inside `renderFamilyLegend` and nowhere else, and nothing in `src/js/`
 * listened for a resize except `popover.js`'s „close on resize". So the row was fitted against
 * whatever width the window had when the legend was last drawn — and 13.1 says the window
 * remembers its size, which means it is also a window the user drags. Dragging it narrower
 * clipped the row silently; dragging it wider left the disclosure up with room to spare.
 *
 * A `ResizeObserver` on the legend box answers both. It is the legend's OWN box rather than the
 * window's, so a change in the toolbar's other items (a longer „Heute", the find field opening)
 * re-fits the row too, which a `window.resize` listener would have missed.
 *
 * BOTH SIGNALS ARE TAKEN, and that is not belt-and-braces. A `ResizeObserver` is delivered from
 * the „update the rendering" steps, which a browser is entitled to suspend while the page is not
 * being painted — measured, in the Browser pane, as `document.hidden === true` and an observer
 * that never fires even for its initial callback. `window.resize` is the coarse signal and it is
 * the one the actual story is about (13.1's remembered window, dragged). Neither alone covers
 * both cases: the observer catches a width change that is not a window resize at all (the find
 * field opening, a longer „Heute" in the other language), and the event catches the drag.
 *
 * TWO GUARDS, because a callback that re-renders the thing it observes is how a loop starts:
 * `painting` ignores anything this file is doing, and the width is compared with the last one
 * FITTED — so whichever of the two signals arrives second is a no-op. `.legend` is
 * `flex:1; min-width:0`, so its width is decided by its siblings and never by its own content:
 * the re-render cannot move the box that triggered it.
 */
function watchLegendWidth() {
  if (!legendEl) return;
  lastWidth = legendEl.clientWidth;
  if (widthObserver) { widthObserver.disconnect(); widthObserver = null; }
  if (typeof ResizeObserver === 'function') {
    widthObserver = new ResizeObserver(onWidthChange);
    widthObserver.observe(legendEl);
  }
  window.removeEventListener('resize', onWidthChange);
  window.addEventListener('resize', onWidthChange);
}

function onWidthChange() {
  if (!legendEl || painting) return;
  const w = legendEl.clientWidth;
  if (Math.abs(w - lastWidth) < 0.5) return;
  renderLegend();
}

// The „+n" chip and its sheet are chrome for a row that has run out of room, so like
// `membersui.js`'s `MEMBERS_CSS` and `syncstatus.js`'s `SYNC_CSS` the rules ship with the code
// that needs them rather than widening `app.css`.
//
// They are injected on the first FIT, not on the first overflow, and that is deliberate: the fit
// measures a real „+n" chip to decide whether one is affordable, and an unstyled probe would
// measure a UA-default button and answer a question about a node that never renders. One <style>
// element, once per launch, on any page that draws a legend at all.
export const LEGEND_FIT_CSS_ID = 'lzp-legend-fit-css';
export const LEGEND_FIT_CSS = `
.legend-more {
  font: 500 11px var(--font); color: var(--ink-3); white-space: nowrap;
  background: none; border: 0; padding: 0 2px; cursor: pointer; flex: none;
}
.legend-more:hover { color: var(--ink-1); }
/* 4.6's flash has to have somewhere to land when the new category is behind the chip. */
.legend-more.flash { animation: unhide-flash .5s ease-out; border-radius: 4px; }
.legend-more-list { display: flex; flex-direction: column; gap: 1px; }
.legend-more-list .legend-item { width: 100%; justify-content: flex-start; padding: 5px 6px; }
.legend-more-list .legend-more-hidden { background: var(--chip); }
`;

function ensureFitCss() {
  if (document.getElementById(LEGEND_FIT_CSS_ID)) return;
  const s = document.createElement('style');
  s.id = LEGEND_FIT_CSS_ID;
  s.textContent = LEGEND_FIT_CSS;
  document.head.appendChild(s);
}

export const catName = (c, lang) =>
  lang === 'en' && c.nameEn ? c.nameEn : c.name;

/**
 * 4.6 — a new entry auto-unhides its category with a brief flash.
 *
 * A category the row could not hold is behind „+n", so there is no swatch to flash. The flash
 * moves to the chip instead: 4.6's promise is that the user SEES the unhide happen, and a flash
 * on the thing that now contains it keeps that promise where a silent no-op would drop it.
 */
export function flashCategory(catId) {
  renderLegend();
  const node = legendEl?.querySelector(`.legend-item[data-cat-id="${catId}"]`)
    || (overflowCats.some((c) => c.id === catId) ? legendEl?.querySelector('.legend-more') : null);
  if (!node) return;
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
  setTimeout(() => node.classList.remove('flash'), 600);
}

// ── management (4.1, 4.4, 4.5) ───────────────────────────────────────────────

export function openCategoryManager() {
  openSheet({
    title: t('categories'),
    build: (body, api) => {
      const lang = getLang();
      const list = el('div', 'cat-list');
      for (const c of store.state.categories) list.appendChild(catRow(c, lang, api));
      body.appendChild(list);

      const add = el('button', 'btn-ghost', `＋ ${t('newCategory')}`);
      add.style.marginTop = '12px';
      add.addEventListener('click', () => {
        // `nextFreeRef` was read inside the v1 callback off `s.categories`; `store.state` IS that
        // same array, so reading it here is the same expression one line earlier (4.5 — a new
        // category takes a tone nobody else is using). `visible: true` is the constructor's, and
        // the new entry sorts LAST because it is the youngest — v1 pushed it there.
        store.apply('addCategory', {
          id: uid(),
          // Both language slots explicitly — creating a category while the
          // UI is English must not store the English label as the German name.
          name: 'Neue Kategorie',
          nameEn: 'New category',
          paletteRef: nextFreeRef(store.state.categories.map((x) => x.paletteRef)),
        });
        notify('legend');
        api.rebuild();
      });
      body.appendChild(add);

      const note = el('p', 'hint');
      note.style.margin = '14px 0 0';
      note.textContent =
        getLang() === 'en'
          ? 'Ten fixed tones, no free picker — the legend has to stay readable at 6 px bar width and on paper.'
          : 'Zehn feste Töne, kein freier Farbwähler — die Legende muss bei 6 px Balkenbreite und auf Papier lesbar bleiben.';
      body.appendChild(note);
    },
    actions: [{ label: t('done'), kind: 'primary', run: (api) => api.close() }],
  });
}

function catRow(c, lang, api) {
  const row = el('div', 'cat-row');

  const name = document.createElement('input');
  name.className = 'name';
  name.type = 'text';
  name.value = catName(c, lang);
  name.addEventListener('change', () => {
    const v = name.value.trim();
    if (!v) { name.value = catName(c, lang); return; }
    // Per-language rename (ATT-10 / ATT-11). `lang` is the language the row was BUILT in, which
    // is what v1 closed over. The EN path writes `nameEn` and leaves the German name alone; the
    // DE path writes `name` and DROPS `nameEn` — v1 spelled that `delete x.nameEn`, and a
    // register log has no delete, so `renameCategory` emits `{nameEn: null}` explicitly. Omitting
    // it would leave the stale English label in a register with its old stamp and every sibling
    // device would keep rendering it.
    store.apply('renameCategory', { id: c.id, lang: lang === 'en' ? 'en' : 'de', name: v });
    notify('legend');
  });
  row.appendChild(name);

  const sws = el('div', 'swatches');
  for (const p of PALETTE) {
    const sw = el('button', 'sw');
    sw.style.background = p.hex;
    sw.title = p[lang === 'en' ? 'en' : 'de'];
    sw.setAttribute('aria-pressed', String(p.ref === c.paletteRef));
    sw.addEventListener('click', () => {
      // v1's `return false` when the tone is already the current one — clicking the active
      // swatch is not an edit and must not land on the undo stack. `recolorCategory` has no such
      // gate of its own (a recolor to the same value is a legal op), so the decline stays HERE,
      // where v1 put it. The redraw below runs either way, exactly as in v1.
      const x = store.state.categories.find((y) => y.id === c.id);
      if (x.paletteRef !== p.ref) store.apply('recolorCategory', { id: c.id, paletteRef: p.ref });
      notify('legend');
      api.rebuild();
    });
    sws.appendChild(sw);
  }
  row.appendChild(sws);

  const n = store.countEntriesIn(c.id);
  row.appendChild(el('span', 'count', String(n)));

  const del = el('button', 'btn-ghost btn-danger', '✕');
  del.style.cssText = 'height:22px;padding:0 7px';
  del.title = t('deleteCategory');
  del.disabled = store.state.categories.length <= 1;
  if (del.disabled) del.style.opacity = '.35';
  del.addEventListener('click', () => {
    if (store.state.categories.length <= 1) return;
    if (n === 0) {
      // The empty-category path. v1 filtered the array and, ONLY if the doomed category was the
      // last-used one, repointed `settings.lastCategoryId` at the first SURVIVOR (4.2 — the
      // default a new entry gets must never dangle). The condition is v1's, verbatim: `null`
      // tells the constructor to omit the `[L]` pref op entirely, so a delete of a category
      // nobody was pointing at writes no pref at all, exactly as in v1.
      //
      // It rides INSIDE the op group rather than in a separate `setSettings` call, which is what
      // v1 did — one mutation, one emit, one label. `store.js:_commit()` reflects the `pref.set`
      // onto `state.settings` BEFORE `emit()`, so nothing that redraws on this delete can observe
      // the dangling id, and rule U6 keeps the pref out of the undo group as v1's settings were
      // out of `CONTENT_KEYS` (spec 5.4).
      const survivors = store.state.categories.filter((y) => y.id !== c.id);
      const repair = store.state.settings.lastCategoryId === c.id ? survivors[0].id : null;
      store.apply('deleteCategory', { id: c.id, lastCategoryId: repair });
      notify('legend');
      api.rebuild();
      return;
    }
    openReassign(c, n, () => { notify('legend'); api.rebuild(); });
  });
  row.appendChild(del);
  return row;
}

/** 4.4 — deleting a category with entries never silently drops them. */
function openReassign(cat, count, done) {
  const lang = getLang();
  const others = store.state.categories.filter((c) => c.id !== cat.id);
  let targetId = others[0].id;

  openSheet({
    title: t('reassignTitle'),
    narrow: true,
    build: (body) => {
      const p = el('p', null, t('reassignBody', count, catName(cat, lang)));
      p.style.cssText = 'margin:0 0 14px;font:400 12.5px/1.6 var(--font);color:var(--ink-2)';
      body.appendChild(p);

      const sel = document.createElement('select');
      for (const c of others) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = catName(c, lang);
        sel.appendChild(o);
      }
      sel.value = targetId;
      sel.addEventListener('change', () => { targetId = sel.value; });
      body.appendChild(field(t('reassignTo'), sel));
    },
    actions: [
      { label: t('cancel'), run: (api) => api.close() },
      {
        label: t('delete'),
        kind: 'danger',
        run: (api) => {
          // 4.4 — THE FAN-OUT, AND IT MUST STAY ONE UNDO STEP.
          //
          // v1 did N note reassignments + M bar reassignments + the removal inside ONE mutate, so
          // one ⌘Z put every entry back in its old category AND restored the category at its
          // original position. `deleteCategoryReassign` builds the same N + M + 1 register writes
          // under ONE gid, so the store records one step; the category comes back at its old
          // index because the projection orders categories by birth, not by arrival.
          //
          // The ids are enumerated HERE rather than expressed as "everything pointing at cat" —
          // an op of that shape would not commute, its effect depending on which entities the
          // folding device had already seen. Each op names its target and carries an absolute
          // value, so a half-delivered group is a consistent half-reassigned board.
          //
          // `=== cat.id` is exact, never a prefix or a coercion (ATT-16).
          const noteIds = store.state.notes.filter((x) => x.categoryId === cat.id).map((x) => x.id);
          const barIds = store.state.bars.filter((x) => x.categoryId === cat.id).map((x) => x.id);
          // As at `legend.js:152`, the `lastCategoryId` repair rides inside the group. Here v1
          // repointed it at the REASSIGN TARGET, not at the first surviving category — the two
          // delete paths genuinely differ (if you reassign into "Reisen" you want the next entry
          // to land in Reisen) and both are kept verbatim, condition included.
          const repair = store.state.settings.lastCategoryId === cat.id ? targetId : null;
          store.apply('deleteCategoryReassign', {
            id: cat.id, targetId, noteIds, barIds, lastCategoryId: repair,
          });
          api.close();
          done();
        },
      },
    ],
  });
}
