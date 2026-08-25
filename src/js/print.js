// Print / PDF (F12). The board itself is the print artefact — the print
// stylesheet only re-metrics it for the paper and strips the interactive layer.
// @page cannot be scoped by a selector, so the paper rule is injected here.

import { store } from './store.js';
import { t, getLang } from './i18n.js';
import { colorOf } from './palette.js';
import { stateName } from './holidays.js';
import { catName } from './legend.js';
import { currentModel } from './board.js';
import { el } from './ui.js';

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
    const layers = [];
    if (s.layers.feiertage) layers.push(t('feiertage'));
    if (s.layers.schulferien && s.bundesland) layers.push(t('schulferien'));
    legend.appendChild(el('span', 'layers', layers.join(' · ')));
  }
}
