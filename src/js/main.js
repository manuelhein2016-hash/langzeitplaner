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
import { openSettings, initSettings, applySettingsToBody, rebuildSettings } from './settings.js';
import { initPrint, printBoard, applyPageRule } from './print.js';
import { exportBoard, importBoard } from './backup.js';
import { closePopover, popoverOpen } from './popover.js';
import { createUpdater, bridgePort } from './platform/updater.js';
import {
  initUpdateUI, shellPort, refreshUpdateChrome, runLaunchCheck,
  startDailyTimer, checkNow as checkUpdatesNow, restartToUpdate,
  updatesSupported, discloseUpdateCheck,
} from './update-ui.js';
import { closeTopSheet, anySheetOpen, el, toast } from './ui.js';
import { todayISO, monthKeyOf, addMonths, parseISO, MONTH_DE, MONTH_EN } from './dates.js';
import { isTauri, loadBoard } from './storage.js';
import { maybeShowUnlock } from './firstrun.js';

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

  // ── F19 · THE ONE DOOR (ADR 003 §7 gate 2 · ADR 002 §2.4) ────────────────
  //
  // This is the only place `net.js`, `src/js/sync/` and `src/js/crypto/` are reachable from the
  // boot graph, and only through a dynamic `import()` that a SOLO install never reaches. The
  // walker in `tests/helpers/importgraph.js` follows the specifier deliberately: a door it can
  // see is a door a test can count, and the gate asserts there is exactly one.
  //
  // It is BEFORE `store.init()` because `usePersonalSpace()` refuses afterwards — a space
  // adopted after init leaves a whole log of placeholder-space ops that `sealOp` refuses one by
  // one, for ever, with nothing on screen to say why.
  await armFamilyMode();

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
  wireUpdates();

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

  // LZP-106 / 22.2 — the unlock screen. It asks the native host whether macOS
  // actually refused this bundle, and shows nothing at all unless the answer is
  // yes, so a healthy launch never meets a security screen. Not awaited: the
  // board is already drawn and must not wait on a bridge round trip.
  maybeShowUnlock().catch((e) => console.warn('[firstrun] unlock probe failed', e));

  // 22.3 — the launch check. Deliberately the LAST thing boot does, deliberately
  // not awaited, and deliberately silent: the board is on screen and usable
  // before a single byte of update traffic is considered, and a release host
  // that is unreachable produces nothing the user can see. It also stops at the
  // 21.5 gate on its own if the first-run screen has not disclosed the check.
  runLaunchCheck();
  startDailyTimer();

  // The engine last, and not awaited: the board is drawn and usable before a byte of sync
  // traffic is considered, exactly as 22.3 does it for the update check.
  startFamilyMode();
}

// ── F19 · family mode — MAIN.JS'S WHOLE PART IN IT ───────────────────────────
//
// One module, one dynamic `import()`, three calls. `main.js` never learns what is inside
// `family/mount.js`, and a solo launch never evaluates it. ADR 003 §7 gate 2 and ADR 002 §2.4
// are the same claim about the module graph, and `tests/tier1/network-scope.test.js` §2 asserts
// it over the real graph: no STATIC path from here into `crypto/`, `sync/` or `net.js`, and
// exactly ONE dynamic door.

/** The `family/mount.js` module, once loaded. Null on every launch nobody opts in on. */
let familyMod = null;
/** Its handle: `{cfg, armed, parts}` on an armed Mac, null on a solo one. */
let family = null;

/** The door. Idempotent, and the ONLY `import()` of `family/` in this file. */
async function openFamilyDoor() {
  if (!familyMod) familyMod = await import('./family/mount.js');
  return familyMod;
}

/**
 * BEFORE `store.init()` — see `family/engine.js`'s ordering note. Reads the RAW board file for a
 * space id rather than `store.state`, because the store does not exist yet and
 * `usePersonalSpace()` refuses to be called after `init()`.
 */
async function armFamilyMode() {
  let settings = null;
  try {
    const raw = await loadBoard();
    settings = raw && typeof raw === 'object' ? raw.settings : null;
  } catch {
    return;                                  // an unreadable board is store.init()'s problem
  }
  // THE GATE ITSELF, and it is now THREE fields of the board file rather than two. Nothing below
  // this line runs on a Mac that has never opted in — `syncEnabled`/`personalSpaceId` is story
  // 19.4's own-device sync, and `familySpaceId` is F15's Familienkreis, and a Mac can have either
  // without the other.
  //
  // ⚠ **THE THIRD FIELD IS A FIX, NOT A WIDENING FOR ITS OWN SAKE.** `useIdentity()` may only be
  // called BEFORE `store.init()` (the spine is minted from `board.json` with whatever identity is
  // current), and it was called from `armStore` alone — which this gate never reached for a Mac
  // that had joined a circle and opted into nothing else. That Mac ran the whole session under
  // the EPHEMERAL identity, so `store._short` was random, `store._me` was not her MemberId, and
  // the family engine refused to construct at all (`me.deviceShort !== store._short`). It is the
  // same Mac E6-VERIFICATION §5.2 measured making zero `/ops` requests, one layer further down.
  if (!settings) return;
  const hasPersonal = !!(settings.syncEnabled && settings.personalSpaceId);
  const hasCircle = typeof settings.familySpaceId === 'string' && settings.familySpaceId.startsWith('fsp_');
  if (!hasPersonal && !hasCircle) return;
  try {
    const mod = await openFamilyDoor();
    // A Mac with BOTH goes through `arm()`, which adopts the personal space as well; `armCircle()`
    // would then be a second `useIdentity()` for the same identity, which the store refuses by
    // design. So it is one or the other, and `start()`/`mountCircleSurfaces()` pick up from there.
    family = hasPersonal ? await mod.arm(settings, { today: todayISO() }) : null;
    if (!hasPersonal) await mod.armCircle(settings, { today: todayISO() });
  } catch (e) {
    // A Mac that cannot open its key store still has its board, and there is nothing a person
    // can do about a locked Keychain from inside a settings sheet. Family mode is what stops.
    console.warn('[family] this launch runs without sync:', e);
    family = null;
  }
}

/** AFTER `init()`, and never awaited: the board is usable before a byte of sync is considered. */
function startFamilyMode() {
  if (family && familyMod) {
    familyMod.start(family, { onChange }).catch((e) => {
      console.warn('[family] the engine did not start:', e);
    });
    return;
  }
  mountCircleIfMember();
}

/**
 * THE SECOND GATE, and the reason it is not the first one: a Mac can be in a Familienkreis
 * without having opted into own-device sync.
 *
 * `armFamilyMode()` opens on `syncEnabled && personalSpaceId` — story 19.4's PERSONAL space. A
 * member of a family circle has `familySpaceId` and may have none of those three, so the door
 * stayed shut and her legend drew no member chips (17.3) until she happened to open ⚙. The
 * members were known; they simply were not drawn.
 *
 * Gated on `familySpaceId` alone, so a solo Mac still reaches none of it — Principle 7 is a
 * statement about a Mac that has opted into NOTHING, and this one has opted into a circle.
 * Nothing here arms an engine or writes anything; the one request it makes is a roster GET.
 */
function mountCircleIfMember() {
  const s = store.state && store.state.settings;
  if (!s || typeof s.familySpaceId !== 'string' || !s.familySpaceId.startsWith('fsp_')) return;
  openFamilyDoor()
    .then((mod) => mod.mountCircleSurfaces({ onChange }))
    .catch((e) => console.warn('[family] the circle surfaces could not be mounted:', e));
}

/**
 * The ⚙ handler's half. A Mac with no Familienkreis has to be able to CREATE one or JOIN one,
 * and both live in the settings sheet — so the door opens here too, on a human action, never at
 * boot. Nothing is generated and nothing is requested by the load itself: `mountSolo` installs a
 * section builder and a joiner-shaped pairing port, and both sit there until they are used.
 */
async function ensureFamilySettings() {
  if (family) return;                        // already armed; `start()` installed the sections
  try {
    const mod = await openFamilyDoor();
    mod.mountSolo({ onChange });
  } catch (e) {
    console.warn('[family] the family settings could not be mounted:', e);
  }
}

/** The 6 px glyph (19.3), reconciled on every redraw — the way `refreshUpdateChrome()` is. */
function refreshFamilyChrome() {
  if (familyMod) familyMod.refreshSyncChrome();
}

// ── F22 · updates (LZP-103 wiring) ───────────────────────────────────────────
//
// One updater, built here, from the native bridge. `update-ui.js` receives it
// as a parameter — like every other collaborator this app initialises — which
// is also the only way a test can drive the UI states, since there is no real
// release server yet. There is no test hook of any kind in the shipped page:
// no `window.__lzp*` updater, no query parameter, no build flag.

function wireUpdates() {
  const invoke = window.__TAURI__?.core?.invoke;
  initUpdateUI({
    // No bridge (browser preview) ⇒ no updater at all, and the settings section
    // says so in one line rather than offering a button that cannot work.
    updater: invoke
      ? createUpdater({ port: bridgePort(invoke), now: () => Date.now() })
      : null,
    shell: invoke ? shellPort(invoke) : null,
    // 22.7 is a *server* protocol statement, so it can only be true where a
    // server exists. E3/WP-7 owns the family-space flag; until it lands this
    // reads false and the minimum-version bar is unreachable — which is the
    // correct behaviour for a solo install, not a stub.
    familyMode: () => {
      const s = store.state.settings;
      return !!(s.familySpaceId || s.familyMode);
    },
    // A check that finishes in the background must not leave an open settings
    // sheet showing a stale answer. `rebuildSettings()` is a no-op when the
    // sheet is closed, which is the overwhelmingly common case.
    onChange: () => { syncToolbar(); rebuildSettings(); },
    // 11.1 — the same flush ⌘Q performs. The Swift shell asks the page for it
    // too; Tauri's restart does not, so the guarantee lives here where both
    // shells share it.
    flush: () => store.persistNow(),
  });
}

// ── rendering ────────────────────────────────────────────────────────────────

/** Open ⚙, with the family sections mounted first so the sheet is complete on its first draw. */
function openSettingsWithFamily() {
  ensureFamilySettings().finally(() => openSettings());
}

function redraw() {
  renderBoard(boardEl);
  applySelection();
  renderLegend();
  syncToolbar();
  refreshFind();
  // 22.4 / 22.7 — the ⚙ dot, the native menu item and the minimum-version bar,
  // reconciled on every redraw. All three are derived from one predicate in
  // update-ui.js, so they cannot disagree with each other.
  refreshUpdateChrome();
  // 19.3 — healthy draws NOTHING, so this is also the call that removes the glyph.
  refreshFamilyChrome();
  if (pendingRollAnim) {
    pendingRollAnim = false;
    // 8.6 — one short slide so the leftmost column leaving reads as motion,
    // not as a glitch. Reduce Motion turns this into an instant swap via CSS.
    boardEl.classList.add('roll-anim');
    setTimeout(() => boardEl.classList.remove('roll-anim'), 340);
  }
  armFamilySeen();
}

// ── 17.5 · „DER PUNKT VERBLASST, WENN MAN IHN GESEHEN HAT" ───────────────────
//
// ADR 004 §7.2: *"The dot fades once seen. No popups, no counters, no push."*
// `store.markFamilySeen()` records the baseline and `store._lastSeenSeqCtx()`
// reads it back; `board.js` paints the dot and `layout.js` gates it on
// `foreign`. This is the one call that was missing, and the decision it encodes
// is a view decision, which is why it lives here and not in the store.
//
// WHAT COUNTS AS A LOOK, AND WHY NOT THE OBVIOUS TWO
//
//  · NOT the render. Fading inside `redraw()` erases the dot before a single
//    frame carries it — the dot would be structurally invisible, which is the
//    defect F6 names with an extra step.
//  · NOT window focus alone. A Mac left focused overnight is not a person
//    looking at a board, and clearing on focus would swallow every entry that
//    arrived while she was in the kitchen. That is principle 10's whole point:
//    *"you notice when you look."*
//  · A deliberate gesture, on a visible document: a press, a key, a scroll.
//    That is the cheapest signal that a person is in front of the board with
//    the dot already painted, and it cannot fire before the paint because the
//    listener is armed by the render that painted it.
//
// Solo mode never arms: with no family entries there is no `.neu-dot` in the
// DOM, `querySelector` answers null, and no listener is attached. P7 holds —
// the whole mechanism costs a solo launch one failed selector per redraw.
//
// Termination: `markFamilySeen()` re-projects and emits `'remote'`, so it
// redraws once. That redraw finds no dot and does not re-arm.
let seenArmed = null;

function armFamilySeen() {
  if (seenArmed) return;
  // `.d-more.has-new` is 17.4's badge carrying a peer's change inside the „+n" —
  // it is the same signal in a crowded day and must fade on the same look.
  if (!boardEl.querySelector('.neu-dot, .d-more.has-new')) return;

  const look = () => {
    // A key or a wheel reaching a hidden document is not a person looking.
    if (document.hidden) return;
    disarm();
    store.markFamilySeen();
  };
  const disarm = () => {
    if (!seenArmed) return;
    seenArmed = null;
    window.removeEventListener('pointerdown', look, true);
    window.removeEventListener('keydown', look, true);
    window.removeEventListener('scroll', look, true);
  };

  seenArmed = disarm;
  window.addEventListener('pointerdown', look, true);
  window.addEventListener('keydown', look, true);
  window.addEventListener('scroll', look, true);
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
  $('btn-settings').addEventListener('click', () => openSettingsWithFamily());

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

/**
 * 8.B — macOS "Reduce Motion", for the animations CSS cannot reach.
 *
 * `app.css:1308-1312` already neutralises every CSS animation and transition under
 * `prefers-reduced-motion`. A `scrollTo({behavior:'smooth'})` is a SCRIPTED animation and no media
 * query can touch it, so ⌘T swept the board across twelve columns for a person who had asked the
 * system for exactly the opposite. This is the only scripted animation in the product.
 */
const reduceMotion = () => {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; }
  catch { return false; }        // a host without matchMedia is not a host that asked for less
};

function scrollToToday(smooth) {
  const key = monthKeyOf(todayISO());
  const col = boardEl.querySelector(`.col[data-month="${key}"]`);
  if (!col) { wrapEl.scrollLeft = 0; return; }
  const target = col.offsetLeft - 8;
  wrapEl.scrollTo({ left: target, behavior: smooth && !reduceMotion() ? 'smooth' : 'auto' });
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
    if (mod && e.key === ',') { e.preventDefault(); openSettingsWithFamily(); return; }
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
    settings: () => openSettingsWithFamily(),
    export: () => exportBoard(),
    import: () => importBoard(() => onChange('restore')),
    print: () => printBoard(),
    undo: () => menuUndo(false),
    redo: () => menuUndo(true),
    find: () => focusFind(),
    today: () => jumpToToday(),
    'layer-feiertage': () => toggleLayer('feiertage'),
    'layer-ferien': () => toggleLayer('schulferien'),
    // 22.4 — the glossary's „Auf Updates prüfen …“. The ellipsis is honest: it
    // opens the settings sheet, where the answer will appear, and starts the
    // check. A menu item that ran a check and reported the result nowhere would
    // be the one place a quiet feature is allowed to be rude — the user asked.
    'check-updates': () => { openSettings(); checkUpdatesNow(); },
    // The hint item, which the shell only shows while a build is staged.
    'update-restart': () => restartToUpdate(),
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
  // 21.5 / 22.3 — the disclosure, and the only place a FRESH install meets it.
  //
  // The daily update check is the one request this app makes, and both shells
  // refuse to make it until a human has been told. LZP-106's unlock screen
  // cannot carry that sentence: it appears only on a launch macOS actually
  // blocked, so on every healthy install the check would stay switched off
  // forever and 22.3 would be a promise the product never keeps.
  //
  // The same string the settings sheet shows, deliberately — one sentence, one
  // source, no chance of the two disagreeing. Shown only inside a real shell:
  // the browser preview has nothing to update and would be lying.
  const discloses = updatesSupported();
  if (discloses) body.appendChild(el('p', 'hint', t('updateCheckHint')));
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
    // Dismissing the card is the act that follows having read it. Not awaited:
    // a shell that cannot record consent simply keeps refusing to check, which
    // is the safe direction.
    if (discloses) discloseUpdateCheck().catch(() => {});
  }
}

// Committing an open editor when focus leaves the window keeps the "no save
// button anywhere" promise honest.
window.addEventListener('blur', () => { if (editorOpen()) commitEditor(); });
