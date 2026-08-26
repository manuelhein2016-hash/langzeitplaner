// Bootstrap: wire the shell, the keyboard map (§9) and the clock that keeps
// the board honest about what "today" means.

import { store } from './store.js';
import { t, setLang, getLang } from './i18n.js';
import { renderBoard, currentModel } from './board.js';
import {
  initInteractions, clearSelection, deleteSelected, editSelected,
  applySelection, commitEditor, cancelEditor, editorOpen, selection,
} from './interact.js';
import { initLegend, renderLegend } from './legend.js';
import { initFind, focusFind, exitFind, refreshFind, findActive } from './find.js';
import { openSettings, initSettings, applySettingsToBody } from './settings.js';
import { initPrint, printBoard, applyPageRule } from './print.js';
import { exportBoard, importBoard } from './backup.js';
import { closePopover, popoverOpen } from './popover.js';
import { closeTopSheet, anySheetOpen, el, toast } from './ui.js';
import { todayISO, monthKeyOf, addMonths, parseISO, MONTH_DE, MONTH_EN } from './dates.js';
import { isTauri } from './storage.js';

const $ = (id) => document.getElementById(id);

let boardEl, wrapEl;
let lastToday = todayISO();
let lastMonth = monthKeyOf(lastToday);
let pendingRollAnim = false;

// ── boot ─────────────────────────────────────────────────────────────────────
//
// WP-3 (ADR 005 §1.5): the boot IIFE is now an EXPORTED function, called from `index.html`
// rather than by the act of importing this module. Importing `main.js` no longer starts the
// app, which is what lets a test — or, in WP-8, a lazily `import()`ed `sync/` module — reach
// anything in here without a store, a board element and a first-run sheet appearing as a side
// effect. Nothing about the boot sequence itself changed; only who calls it.

export async function boot() {
  boardEl = $('board');
  wrapEl = $('board-wrap');

  await store.init();
  setLang(store.state.settings.language);
  applySettingsToBody();

  if (isTauri()) document.body.classList.add('in-tauri');

  initSettings(onChange);
  initLegend($('legend'), onChange);
  initFind({
    wrap: wrapEl, input: $('find-input'), counter: $('find-count'),
    prev: $('find-prev'), next: $('find-next'),
    history: $('find-history'),
    // 14.2 — a history hit is reachable only by pinning the board to its month.
    onJump: (date) => {
      store.setSettings({ mode: 'pinned', startMonth: date.slice(0, 7), pageYears: 0 });
      onChange('settings');
      toast(t('pinnedToHistory'));
    },
  });
  initPrint();
  initInteractions(boardEl, wrapEl, { onChange });

  wireToolbar();
  wireKeyboard();
  wireClock();
  wireNativeMenu();
  restoreScroll();

  store.subscribe((_, reason) => {
    // A scratchpad keystroke must not rip the textarea out from under the
    // caret, and selection changes only toggle a class.
    if (reason === 'pad' || reason === 'select') return;
    redraw();
  });

  redraw();
  scrollToToday(false);
  maybeFirstRun();
}

// ── rendering ────────────────────────────────────────────────────────────────

function redraw() {
  renderBoard(boardEl);
  applySelection();
  renderLegend();
  syncToolbar();
  refreshFind();
  if (pendingRollAnim) {
    pendingRollAnim = false;
    // 8.6 — one short slide so the leftmost column leaving reads as motion,
    // not as a glitch. Reduce Motion turns this into an instant swap via CSS.
    boardEl.classList.add('roll-anim');
    setTimeout(() => boardEl.classList.remove('roll-anim'), 340);
  }
}

function onChange(reason) {
  if (reason === 'select') { applySelection(); return; }
  if (reason === 'legend' || reason === 'settings' || reason === 'restore') {
    applySettingsToBody();
    applyPageRule();
  }
  redraw();
}

// ── toolbar ──────────────────────────────────────────────────────────────────

function wireToolbar() {
  $('btn-today').addEventListener('click', jumpToToday);
  $('btn-print').addEventListener('click', printBoard);
  $('btn-settings').addEventListener('click', () => openSettings());

  $('btn-feiertage').addEventListener('click', () => toggleLayer('feiertage'));
  $('btn-schulferien').addEventListener('click', () => toggleLayer('schulferien'));

  $('pg-prev').addEventListener('click', () => page(-1));
  $('pg-next').addEventListener('click', () => page(1));

  wrapEl.addEventListener('scroll', saveScroll, { passive: true });
}

function toggleLayer(key) {
  const s = store.state.settings;
  if (key === 'schulferien' && !s.layers.schulferien && !s.bundesland) {
    // 7.5 — no Bundesland, no Ferien: send the user where the answer is.
    toast(t('pickBundesland'));
    openSettings();
    return;
  }
  store.setLayer({ [key]: !s.layers[key] });
  onChange('settings');
}

function syncToolbar() {
  const s = store.state.settings;
  const lang = getLang();
  $('btn-feiertage').setAttribute('aria-pressed', String(!!s.layers.feiertage));
  $('btn-schulferien').setAttribute('aria-pressed', String(!!s.layers.schulferien));
  $('btn-feiertage').querySelector('.lbl').textContent = t('feiertage');
  $('btn-schulferien').querySelector('.lbl').textContent = t('schulferien');
  $('btn-today').textContent = t('today');
  $('find-input').placeholder = t('find');

  const m = currentModel();
  if (m) {
    $('tb-range').textContent = `${m.cols[0].label} – ${m.cols[m.cols.length - 1].label}`;
  }

  // 1.5 — paging controls exist only in pinned mode, where history is reachable.
  const pager = $('pager');
  pager.hidden = s.mode !== 'pinned';
  if (!pager.hidden && m) {
    $('pg-year').textContent = String(m.cols[0].y);
    $('pg-prev').title = t('yearBack');
    $('pg-next').title = t('yearFwd');
  }
  const MN = lang === 'en' ? MONTH_EN : MONTH_DE;
  document.title = m
    ? `LangzeitPlaner — ${MN[m.cols[0].m - 1]} ${m.cols[0].y} …`
    : 'LangzeitPlaner';
}

function page(dir) {
  if (store.state.settings.mode !== 'pinned') return;
  store.setSettings({ pageYears: (store.state.settings.pageYears || 0) + dir });
  onChange('settings');
}

// ── today / scroll ───────────────────────────────────────────────────────────

function jumpToToday() {
  const s = store.state.settings;
  const today = todayISO();
  if (s.mode === 'pinned') {
    // Bring the pinned view back to the year that actually contains today.
    const start = parseISO(`${s.startMonth}-01`);
    const want = Math.floor(
      (Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 -
       (start.y * 12 + start.m - 1)) / 12
    );
    if ((s.pageYears || 0) !== want) {
      store.setSettings({ pageYears: want });
      onChange('settings');
    }
  }
  scrollToToday(true);
}

function scrollToToday(smooth) {
  const key = monthKeyOf(todayISO());
  const col = boardEl.querySelector(`.col[data-month="${key}"]`);
  if (!col) { wrapEl.scrollLeft = 0; return; }
  const target = col.offsetLeft - 8;
  wrapEl.scrollTo({ left: target, behavior: smooth ? 'smooth' : 'auto' });
}

// 13.1 — the window remembers its scroll offset across launches.
let scrollTimer = null;
function saveScroll() {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    try { localStorage.setItem('langzeitplaner.scroll', String(wrapEl.scrollLeft)); } catch {}
  }, 200);
}
function restoreScroll() {
  try {
    const v = Number(localStorage.getItem('langzeitplaner.scroll'));
    if (Number.isFinite(v) && v > 0) requestAnimationFrame(() => { wrapEl.scrollLeft = v; });
  } catch {}
}

// ── the clock (8.2, 8.5) ─────────────────────────────────────────────────────

function wireClock() {
  const tick = () => {
    const now = todayISO();
    if (now === lastToday) return;
    const month = monthKeyOf(now);
    // Rolling mode advances by itself: oldest column out, new twelfth in.
    pendingRollAnim = store.state.settings.mode === 'rolling' && month !== lastMonth;
    lastToday = now;
    lastMonth = month;
    redraw();
  };
  setInterval(tick, 30000);
  // A Mac that slept for a week wakes into the right board without a restart.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('focus', tick);
}

// ── keyboard map (§9) ────────────────────────────────────────────────────────

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const inField = e.target.closest?.('input, textarea, select');

    if (e.key === 'Escape') {
      if (editorOpen()) { cancelEditor(); return; }
      if (popoverOpen()) { closePopover(); return; }
      if (anySheetOpen()) { closeTopSheet(); return; }
      if (findActive() || document.activeElement === $('find-input')) { exitFind(); return; }
      clearSelection();
      return;
    }

    if (mod && e.key.toLowerCase() === 'z') {
      // Any focused field — scratchpad, find, settings, the inline editor —
      // keeps native text undo. preventDefault() must come AFTER this guard;
      // before it, the browser's own undo was suppressed and nothing ran.
      if (inField) return;
      e.preventDefault();
      const ok = e.shiftKey ? store.redo() : store.undo();
      if (!ok) toast(e.shiftKey ? '⇧⌘Z —' : '⌘Z —');
      return;
    }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); focusFind(); return; }
    if (mod && e.key.toLowerCase() === 't') { e.preventDefault(); jumpToToday(); return; }
    if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); printBoard(); return; }
    if (mod && e.key === ',') { e.preventDefault(); openSettings(); return; }
    if (mod && e.key === '1') { e.preventDefault(); toggleLayer('feiertage'); return; }
    if (mod && e.key === '2') { e.preventDefault(); toggleLayer('schulferien'); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); exportBoard(); return; }
    if (mod && e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); importBoard(() => onChange('restore')); return; }

    if (inField) return;

    if (e.key === 'Enter' && selection.id) { e.preventDefault(); editSelected(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && selection.id) {
      e.preventDefault();
      deleteSelected();
      return;
    }
  });

  // ⌘W hides the window and the app keeps running (13.5) — Tauri owns that;
  // in the browser it is simply not ours to intercept.
  window.addEventListener('pagehide', () => store.flushSync());
}

// ── native menu bridge (§9 menu bar) ─────────────────────────────────────────
// The Rust side owns the menu; every item that maps to a board action emits an
// event handled here, so each command has exactly one implementation.

function wireNativeMenu() {
  const listen = window.__TAURI__?.event?.listen;
  if (!listen) return;
  // Menu key equivalents bypass the page's keydown handler, so the in-field
  // guard from wireKeyboard has to be repeated here — otherwise ⌘Z while
  // typing in a scratchpad fires *board* undo instead of text undo.
  const menuUndo = (redo) => {
    const a = document.activeElement;
    const inField = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
    if (inField) { document.execCommand(redo ? 'redo' : 'undo'); return; }
    redo ? store.redo() : store.undo();
  };
  const actions = {
    settings: () => openSettings(),
    export: () => exportBoard(),
    import: () => importBoard(() => onChange('restore')),
    print: () => printBoard(),
    undo: () => menuUndo(false),
    redo: () => menuUndo(true),
    find: () => focusFind(),
    today: () => jumpToToday(),
    'layer-feiertage': () => toggleLayer('feiertage'),
    'layer-ferien': () => toggleLayer('schulferien'),
    'mode-toggle': () => {
      const next = store.state.settings.mode === 'rolling' ? 'pinned' : 'rolling';
      store.setSettings({ mode: next, pageYears: 0 });
      onChange('settings');
    },
  };
  listen('menu', (e) => actions[e.payload]?.());

  // The Swift shell awaits this before letting ⌘Q proceed, so an edit made
  // inside the save debounce window can't be lost to a fast quit.
  window.__lzpFlush = () => store.persistNow();

  // 13.2 / 13.3 — the shell has no direct view of board.json; push the stored
  // shell preferences to it at every boot so tray icon, autostart and menu
  // language match what settings says rather than the shell's defaults.
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) {
    const s = store.state.settings;
    invoke('set_shell_pref', { key: 'menu_bar_icon', value: !!s.menuBarIcon }).catch(() => {});
    invoke('set_shell_pref', { key: 'launch_at_login', value: !!s.launchAtLogin }).catch(() => {});
    if (s.language && s.language !== 'de') {
      invoke('set_shell_pref', { key: 'language', value: s.language }).catch(() => {});
    }
  }
}

// ── first run (open question 1) ──────────────────────────────────────────────
// Answer: start bare. A modal on first launch would contradict the whole
// premise ("no dialogs"), and the board is legible before any setting is made.
// One dismissible card explains the two gestures and offers the Bundesland.

function maybeFirstRun() {
  if (store.state.settings.seenFirstRun) return;
  const card = el('div', 'coach');
  const body = el('div');
  body.appendChild(el('h3', null, t('firstRunTitle')));
  body.appendChild(el('p', null, t('firstRunBody')));
  if (!store.state.settings.bundesland) {
    body.appendChild(el('p', null, t('firstRunState')));
  }
  const acts = el('div', 'acts');
  if (!store.state.settings.bundesland) {
    const pick = el('button', 'btn-primary', t('pickBundesland'));
    pick.addEventListener('click', () => { dismiss(); openSettings(); });
    acts.appendChild(pick);
  }
  const ok = el('button', 'btn-ghost', t('done'));
  ok.addEventListener('click', dismiss);
  acts.appendChild(ok);
  body.appendChild(acts);
  card.appendChild(body);
  document.body.appendChild(card);

  function dismiss() {
    card.remove();
    store.setSettings({ seenFirstRun: true });
  }
}

// Committing an open editor when focus leaves the window keeps the "no save
// button anywhere" promise honest.
window.addEventListener('blur', () => { if (editorOpen()) commitEditor(); });
