// Print / PDF (F12). The board itself is the print artefact — the print
// stylesheet only re-metrics it for the paper and strips the interactive layer.
// @page cannot be scoped by a selector, so the paper rule is injected here.
//
// ═════════════════════════════════════════════════════════════════════════════
// A8 / 12.3 — AND THE FAMILY IS ON THE SHEET (LZP-807)
//
// *"Print renders what's visible — including family entries and honouring
// member toggles. A family wall poster is now a two-click product."*
//
// THE FIRST THREE OF THOSE FOUR CLAIMS COST NOTHING, AND THAT IS THE DESIGN,
// not luck. v1 prints the IDENTICAL DOM at paper metrics (DESIGN-DECISIONS.md:
// "all board geometry is `calc()` against `--row-h`/`--col-w`/`--lane-gap` —
// this is what lets the print stylesheet re-metric the identical DOM for A4/A3
// instead of maintaining a second renderer"). So:
//
//   · another member's entries print because they are `.note`s and `.bar`s in
//     that DOM, drawn in her colour with her chip;
//   · a hidden member (17.3) is absent from the sheet because `materialize()`
//     never projected her — the toggle is a PROJECTION filter, not a CSS one,
//     so there is no second place where "hidden" has to be re-decided;
//   · a Belegt block prints as the word „Belegt", because `board.js` painted
//     the word rather than the text and print does not re-render.
//
// THE FOURTH IS THIS FILE'S WORK: the key. Open question 6 was answered in v1
// with "include the legend strip — a printed stripe with no colour key is just
// a coloured line, and the sheet has no hover", and E8 makes that argument
// twice as sharp: a family sheet's stripes are in colours that mean PEOPLE, and
// a 8 px initial chip is not a name. So the strip gains A3's second section.
// ═════════════════════════════════════════════════════════════════════════════

import { store } from './store.js';
import { t, getLang } from './i18n.js';
import { colorOf } from './palette.js';
import { stateName } from './holidays.js';
import { catName } from './legend.js';
import { currentModel } from './board.js';
import { el } from './ui.js';
import { memberNameOf } from './popover.js';

const PAGE = {
  a4: '@page { size: A4 landscape; margin: 8mm; }',
  a3: '@page { size: A3 landscape; margin: 10mm; }',
};

export function applyPageRule() {
  let style = document.getElementById('page-rule');
  if (!style) {
    style = document.createElement('style');
    style.id = 'page-rule';
    document.head.appendChild(style);
  }
  style.textContent = PAGE[store.state.settings.paper || 'a4'];
}

export function initPrint() {
  applyPageRule();
  window.addEventListener('beforeprint', buildPrintFurniture);
}

export function printBoard() {
  applyPageRule();
  buildPrintFurniture();
  // Bare WKWebView ignores window.print() — in the shell the toolbar button
  // and ⌘P must reach the native NSPrintOperation through the bridge instead.
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) {
    invoke('print_board', {}).catch((e) => console.warn('[print] bridge failed', e));
    return;
  }
  // Let layout settle at print metrics before the dialog snapshots the page.
  requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
}

function buildPrintFurniture() {
  const m = currentModel();
  const s = store.state.settings;
  const lang = getLang();

  const head = document.getElementById('print-head');
  if (head && m) {
    head.textContent = '';
    head.appendChild(el('span', 't', t('appName')));
    head.appendChild(
      el('span', 'r', `${m.cols[0].fullLabel} – ${m.cols[m.cols.length - 1].fullLabel}`)
    );
    const meta = [];
    if (s.layers.feiertage) meta.push(`${t('feiertage')}: ${s.bundesland ? stateName(s.bundesland, lang) : (lang === 'en' ? 'nationwide' : 'bundesweit')}`);
    if (s.layers.schulferien && s.bundesland) meta.push(`${t('schulferien')}: ${stateName(s.bundesland, lang)}`);
    head.appendChild(el('span', 'meta', meta.join(' · ')));
  }

  // 12.2 / design note — a slim legend strip so a printed stripe still has a
  // key. Only *visible* categories appear: what you see is what prints (12.3).
  const legend = document.getElementById('print-legend');
  if (legend) {
    legend.textContent = '';
    for (const c of store.state.categories) {
      if (c.visible === false) continue;
      const item = el('div', 'item');
      const sw = el('span', 'sw');
      sw.style.background = colorOf(c.paletteRef);
      item.appendChild(sw);
      item.appendChild(el('span', 'nm', catName(c, lang)));
      legend.appendChild(item);
    }
    // A3 / 17.3 — the legend's second section, on paper. Appended BEFORE the
    // layers line, which floats right on `margin-left:auto` and must stay the
    // last thing on the strip.
    for (const item of memberKey()) legend.appendChild(item);

    const layers = [];
    if (s.layers.feiertage) layers.push(t('feiertage'));
    if (s.layers.schulferien && s.bundesland) layers.push(t('schulferien'));
    legend.appendChild(el('span', 'layers', layers.join(' · ')));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The member key (A3 · 17.3 · A8)
// ─────────────────────────────────────────────────────────────────────────────

/** „Mitglied" for a member whose profile has not folded yet.
 *
 *  `i18n.js` belongs to another work package and `t()` answers the KEY when a
 *  table has no entry, so this resolves through i18n FIRST and falls back here
 *  only while the key is missing — `board.js:FAMILY_COPY` set the precedent and
 *  the day the i18n owner lands `member`, i18n wins with no line changing here. */
const memberWord = () => {
  const s = t('member');
  return s === 'member' ? (getLang() === 'en' ? 'Member' : 'Mitglied') : s;
};

/**
 * WHO IS ACTUALLY ON THE SHEET — read off the rendered board, not off the store.
 *
 * "Print renders what's VISIBLE" is taken literally, and it is the cheaper
 * reading as well as the truer one. Asking the store would mean re-deriving
 * which entries fall in the visible window, which yearly repeats project into
 * it, and which bars lost their lane — three of v1's hardest rules, re-implemented
 * in a file that has no business knowing them, to answer a question the DOM
 * already holds. So the DOM is the query: every foreign note and bar that was
 * actually drawn names its owner, and nobody else appears in the key.
 *
 * What falls out of that, and is wanted:
 *   · a hidden member (17.3) has no nodes, so no key row — the toggle is
 *     honoured without this file knowing the toggle exists;
 *   · a member whose only entry is inside a „+n" or beyond the lane cap has no
 *     ink on the sheet, so her colour needs no key. The „+n" still prints,
 *     because it is content (v1's own decision), and it says a count, not a
 *     colour.
 *
 * `data-note-id` / `data-bar-id` carry the entry `id`, which for a foreign
 * entry IS its entity key — unique across members by construction, which is
 * what makes this lookup safe.
 *
 * @returns {Array<{ownerId:string, colorRef:string|null, initial:string|null}>}
 */
function membersOnSheet() {
  const foreign = new Map();
  for (const list of [store.state.notes, store.state.bars]) {
    for (const e of list) if (e && e.isForeign && e.ownerId) foreign.set(e.id, e);
  }
  if (!foreign.size) return [];                 // solo, and every v1 board: one `Map.size` check

  const seen = new Map();
  for (const node of document.querySelectorAll('.board .note[data-note-id], .board .bar[data-bar-id]')) {
    const e = foreign.get(node.dataset.noteId || node.dataset.barId);
    if (!e || seen.has(e.ownerId)) continue;
    seen.set(e.ownerId, {
      ownerId: e.ownerId,
      colorRef: e.memberColorRef ?? null,
      initial: e.initial ?? null,
    });
  }
  return [...seen.values()];
}

/**
 * The member section as DOM: a divider, then one chip-and-name per member.
 *
 * THE DIVIDER CARRIES THE TWO SECTIONS, AND THERE IS NO „Familie" HEADING —
 * the same decision `membersui.js` made for the on-screen legend, for the same
 * reason and with more force on paper: v1 ships a default CATEGORY called
 * „Familie", so a labelled section would print the word twice in one strip
 * meaning two different things, with no hover to disambiguate. The chips say
 * people (round, initialled, in member colours) where the category swatches say
 * categories (flat stripes); that is the distinction, and it survives a
 * photocopier better than a word would.
 *
 * Sorted by the label so the key is stable between two prints of the same
 * board — DOM order is chronological, and a poster whose key reshuffles when an
 * entry moves is a poster nobody trusts.
 */
function memberKey() {
  const rows = membersOnSheet();
  if (!rows.length) return [];
  const items = rows
    .map((r) => ({ ...r, name: memberNameOf(r.ownerId) || r.initial || memberWord() }))
    .sort((a, b) => a.name.localeCompare(b.name, getLang() === 'en' ? 'en' : 'de'));

  const sep = el('span', 'sep');
  // `print.css` is another owner's file and has no rule for this; the strip's
  // own vocabulary (0.5pt #C9BFE4) is reused inline rather than invented.
  sep.style.cssText = 'align-self:stretch;border-left:0.5pt solid #C9BFE4;margin:0 -4px;';

  const out = [sep];
  for (const r of items) {
    const item = el('div', 'item member');
    const chip = el('span', 'sw member-sw', r.initial || '');
    // The board's chip, at print scale: a round member tone with the initial in
    // white. `colorOf(null)` would answer PALETTE[0] — blue, i.e. a colour that
    // belongs to somebody — so a member with no colour yet gets neutral ink,
    // exactly as `layout.js` and the popover's `paintDot` do.
    // `line-height` comes AFTER the `font` shorthand, which resets it.
    chip.style.cssText = 'width:9px;height:9px;border-radius:50%;display:inline-flex;'
      + 'align-items:center;justify-content:center;'
      + "font:600 5pt 'Ubuntu',sans-serif;line-height:1;color:#fff;";
    chip.style.background = r.colorRef ? colorOf(r.colorRef) : 'var(--ink-4)';
    item.appendChild(chip);
    item.appendChild(el('span', 'nm', r.name));
    out.push(item);
  }
  return out;
}
