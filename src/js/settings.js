// One settings surface (⌘,) holding the whole inventory from F13's design
// notes. Everything here is configuration, not board content — none of it goes
// on the undo stack.

import { store } from './store.js';
import { t, getLang, setLang } from './i18n.js';
import { BUNDESLAENDER, stateName } from './holidays.js';
import { FERIEN_META } from './ferien.js';
import { el, openSheet, field, switchBox, confirmSheet, toast } from './ui.js';
import { openUnlockHelp } from './firstrun.js';
import { storagePath, isTauri } from './storage.js';
import { exportBoard, importBoard } from './backup.js';
import { buildUpdateSection } from './update-ui.js';
import { MONTH_DE, MONTH_EN, todayISO, parseISO } from './dates.js';
// 17.7 — the presets and the capacity rule live in `layout.js`'s DENSITY SEAM,
// because the number of lines a row can host is board geometry and not a
// settings-pane opinion. This file owns the CONTROL and the body class; it owns
// none of the numbers. `layout.js` is already in the boot graph (`board.js`
// imports it on every launch, solo or not), so this import adds no edge.
import { DENSITY, DENSITIES, densityOf } from './layout.js';

let notify = () => {};
export function initSettings(onChange) { notify = onChange || (() => {}); }

/**
 * ── F19 · THE FAMILY SEAM, AND IT IS DELIBERATELY A NULL CALLBACK ───────────
 *
 * ADR 005 §1.5 budgets this file "~25 lines" for the whole of family mode, and this is them.
 *
 * `settings.js` is in the boot graph — `main.js` imports it on every launch, solo or not — so it
 * may know that a family section EXISTS and may not know what is in it. An `import` here, static
 * or dynamic, would put `crypto/`, `sync/` and `platform/net.js` one edge away from every solo
 * launch, which is exactly what ADR 003 §7 gate 2 and ADR 002 §2.4 forbid and what
 * `tests/tier1/network-scope.test.js` §2 measures.
 *
 * So the direction is inverted: `family/mount.js` — the ONE dynamically imported door — calls
 * this, and until it does the sheet has one fewer section and nothing else changes. A solo
 * install that never opens ⚙ never evaluates a line of family mode.
 *
 * @type {((body:HTMLElement, api:Object) => void)|null}
 */
let familySections = null;

/** Called by `family/mount.js`. There is no other caller and there must not be. */
export function setFamilySections(fn) {
  familySections = typeof fn === 'function' ? fn : null;
  rebuildSettings();
}

export function applySettingsToBody() {
  const s = store.state.settings;
  document.body.classList.toggle('ferien-hatch', !!s.layers.ferienPattern);
  document.body.classList.remove('paper-a4', 'paper-a3');
  document.body.classList.add(`paper-${s.paper || 'a4'}`);
  // 17.7 — the type half of the density preset. ONE class, and only ever the
  // one that is NOT the default: Kompakt puts no class on the body, so a board
  // that never touches this setting renders through exactly the rules it
  // rendered through before LZP-808 existed. That is what makes „Kompakt is
  // today, to the pixel" checkable rather than merely claimed.
  document.body.classList.toggle('density-komfort', densityOf(s) === 'komfort');
  document.documentElement.lang = s.language || 'de';
}

// The open sheet's api, so a background event that changes what settings SHOWS
// can redraw it in place. Today the only such event is the update check
// finishing while the user is looking at the Updates section (22.4) — without
// this, "Jetzt suchen" would leave the sheet frozen on „Wird geprüft …".
let openApi = null;

export function openSettings() {
  const api = openSheet({
    title: t('settings'),
    build: (body, a) => build(body, a),
    actions: [{ label: t('done'), kind: 'primary', run: (a) => a.close() }],
    onClose: () => { openApi = null; },
  });
  openApi = api;
  return api;
}

/** No-op unless the settings sheet is on screen. */
export function rebuildSettings() {
  if (openApi) openApi.rebuild();
}

/** Whether the settings sheet is currently open. */
export const settingsOpen = () => !!openApi;

function build(body, api) {
  const s = store.state.settings;
  const lang = getLang();

  // ── layers & region ────────────────────────────────────────────────────────
  body.appendChild(el('div', 'section-title', t('layers')));

  const sel = document.createElement('select');
  for (const b of BUNDESLAENDER) {
    const o = document.createElement('option');
    o.value = b.code;
    o.textContent = b[lang === 'en' ? 'en' : 'de'];
    sel.appendChild(o);
  }
  sel.value = s.bundesland;
  sel.addEventListener('change', () => {
    const hadState = !!store.state.settings.bundesland;
    store.setSettings({ bundesland: sel.value });
    // 7.5 — with no Bundesland the Ferien layer cannot mean anything; and the
    // first pick turns it on, so choosing a state makes the shading appear
    // without a second, non-obvious toggle.
    if (!sel.value) store.setLayer({ schulferien: false });
    else if (!hadState) store.setLayer({ schulferien: true });
    notify('settings');
    api.rebuild();
  });
  body.appendChild(field(t('bundesland'), sel));

  body.appendChild(
    field('', switchBox(t('feiertage') + '  (⌘1)', s.layers.feiertage, (v) => {
      store.setLayer({ feiertage: v });
      notify('settings');
    }))
  );
  body.appendChild(
    field('', switchBox(t('schulferien') + '  (⌘2)', s.layers.schulferien, (v) => {
      if (v && !store.state.settings.bundesland) {
        // 7.5 — toggling it on without a state prompts for the selection first.
        toast(t('pickBundesland'));
        sel.focus();
        api.rebuild();
        return;
      }
      store.setLayer({ schulferien: v });
      notify('settings');
    }))
  );
  body.appendChild(
    field('', switchBox(t('showOtherStates'), s.layers.otherStates, (v) => {
      store.setLayer({ otherStates: v });
      notify('settings');
    }))
  );
  body.appendChild(
    field('', switchBox(t('ferienPattern'), s.layers.ferienPattern, (v) => {
      store.setLayer({ ferienPattern: v });
      applySettingsToBody();
      notify('settings');
    }))
  );
  body.appendChild(el('p', 'hint', t('ferienPatternHint')));

  // 7.4 — the Ferien horizon is stated, not hidden.
  const horizon = el('div', 'field');
  horizon.appendChild(el('label', null, t('ferienHorizon')));
  const hv = el('div', 'ctl');
  hv.appendChild(el('span', null, formatDate(FERIEN_META.horizon, lang)));
  horizon.appendChild(hv);
  body.appendChild(horizon);
  if (!FERIEN_META.verified) body.appendChild(el('p', 'warn', t('ferienUnverified')));

  // ── board mode & density ───────────────────────────────────────────────────
  body.appendChild(el('div', 'section-title', t('appearance')));

  const modeSel = document.createElement('select');
  for (const [v, label] of [['rolling', t('rolling')], ['pinned', t('pinned')]]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    modeSel.appendChild(o);
  }
  modeSel.value = s.mode;
  modeSel.addEventListener('change', () => {
    store.setSettings({ mode: modeSel.value, pageYears: 0 });
    notify('settings');
    api.rebuild();
  });
  body.appendChild(field(t('mode'), modeSel));

  if (s.mode === 'pinned') {
    const monthSel = document.createElement('select');
    const MN = lang === 'en' ? MONTH_EN : MONTH_DE;
    const y0 = Number(todayISO().slice(0, 4));
    for (let y = y0 - 2; y <= y0 + 2; y++) {
      for (let m = 1; m <= 12; m++) {
        const o = document.createElement('option');
        o.value = `${y}-${String(m).padStart(2, '0')}`;
        o.textContent = `${MN[m - 1]} ${y}`;
        monthSel.appendChild(o);
      }
    }
    monthSel.value = s.startMonth;
    monthSel.addEventListener('change', () => {
      store.setSettings({ startMonth: monthSel.value, pageYears: 0 });
      notify('settings');
    });
    body.appendChild(field(lang === 'en' ? 'Start month' : 'Startmonat', monthSel));
  }

  // ── 17.7 · Dichte (Kompakt / Komfort) — PER DEVICE ────────────────────────
  //
  // „Mom's display and eyes are not mine." This is the whole story, and the
  // reason the control is here and not in the Familienkreis section: it is a
  // fact about THIS MAC, in the same local space as the Bundesland and the
  // window frame, and it never travels (rule U6 — `settings` is a `pref.set` in
  // the `local` space and `store.js:outbox()` filters it out by construction).
  //
  // A PRESET WRITES ITS NUMBERS. Picking one moves the two sliders directly
  // beneath it to that preset's pair, in view, so „what did that just do?" is
  // answered by looking down rather than by a paragraph — and either slider is
  // then free to disagree with the preset. Density itself only ever decides the
  // TYPE and the capacity rule.
  const dens = densityOf(s);
  const densSel = document.createElement('select');
  const DENS_LABEL = {
    de: { kompakt: 'Kompakt — 12 Monate, so dünn wie möglich', komfort: 'Komfort — größere Schrift, breitere Spalten' },
    en: { kompakt: 'Compact — 12 months, as thin as it goes', komfort: 'Comfortable — larger type, wider columns' },
  }[lang === 'en' ? 'en' : 'de'];
  for (const d of DENSITIES) {
    const o = document.createElement('option');
    o.value = d;
    o.textContent = DENS_LABEL[d];
    densSel.appendChild(o);
  }
  densSel.value = dens;
  densSel.addEventListener('change', () => {
    const p = DENSITY[densSel.value] || DENSITY.kompakt;
    store.setSettings({ density: densSel.value, rowHeight: p.rowHeight, colWidth: p.colWidth });
    applySettingsToBody();
    notify('settings');
    api.rebuild();
  });
  body.appendChild(field(lang === 'en' ? 'Density' : 'Dichte', densSel));

  // The floor is the preset's, not v1's flat 18. A Komfort row below 26 px
  // hosts ONE 10.5 px line where a Kompakt row hosts two 9 px ones — Komfort
  // would then show FEWER entries than Kompakt, which is the exact opposite of
  // what 17.7 is for. `layout.js:DENSITY.komfort.minRowHeight` is that floor and
  // the reason it is 26; this line only obeys it.
  const rowMin = DENSITY[dens].minRowHeight;
  const rowMax = DENSITY[dens].maxRowHeight;
  body.appendChild(rangeField(t('rowHeight'), Math.max(rowMin, Math.min(rowMax, s.rowHeight)), rowMin, rowMax, (v) => {
    store.setSettings({ rowHeight: v });
    notify('settings');
  }, 'px'));
  body.appendChild(rangeField(t('colWidth'), s.colWidth, 92, 160, (v) => {
    store.setSettings({ colWidth: v });
    notify('settings');
  }, 'px'));
  body.appendChild(el('p', 'hint',
    lang === 'en'
      ? '31 rows plus header and scratchpad have to fit without vertical scrolling. From 22 px a holiday and a note share a row; below 21 px each day carries a single line.'
      : '31 Zeilen plus Kopf und Notizzettel müssen ohne vertikales Scrollen passen. Ab 22 px teilen sich Feiertag und Notiz eine Zeile; unter 21 px trägt jeder Tag nur eine Zeile.'));
  // The trade, named. Story 1.4 already scrolls the board horizontally with the
  // month headers pinned below 12 columns; Komfort does not invent a second
  // behaviour, it lands in that one — and this line says how much earlier.
  const rowNow = Math.max(rowMin, Math.min(rowMax, s.rowHeight));
  body.appendChild(el('p', 'hint',
    lang === 'en'
      ? `Density applies to this Mac only — it is never synced to the family. This setting needs a window about ${12 * s.colWidth + 16} px wide to show all 12 months and about ${31 * rowNow + 88} px tall; below that the board scrolls sideways with the month headers pinned.`
      : `Die Dichte gilt nur für diesen Mac — sie wird nie mit der Familie synchronisiert. Diese Einstellung braucht für alle 12 Monate ein Fenster von etwa ${12 * s.colWidth + 16} px Breite und etwa ${31 * rowNow + 88} px Höhe; darunter scrollt das Brett seitlich, die Monatsköpfe bleiben stehen.`));

  // ⚠ THE HALF OF THE TRADE 17.7 DOES NOT MENTION, AND THE ONE v1 FORBIDS.
  //
  // The story offers horizontal scroll as the price. The board also has a
  // VERTICAL budget — v1 §2: „header + 31 rows + scratchpad should fit without
  // vertical scrolling", and §1's design note is blunt: „The board never scrolls
  // vertically." Horizontal scroll degrades gracefully (1.4); vertical scroll
  // takes the last days of every month below the fold, and a wall calendar you
  // have to scroll to see the 31st is not a wall calendar.
  //
  // So the shortfall is measured against THIS window and stated in the two units
  // the user can act on — pixels of window, and days of month. It is measured
  // rather than derived from a constant because the chrome above the board
  // changes with the toolbar's own wrapping.
  const wrapEl = document.querySelector('.board-wrap');
  if (wrapEl) {
    const have = wrapEl.clientHeight;
    const need = 31 * rowNow + 26 + 62;         // 31 rows + --head-h + --pad-h
    if (have > 0 && need > have + 1) {
      const lostRows = Math.ceil((need - have) / rowNow);
      body.appendChild(el('p', 'warn',
        lang === 'en'
          ? `This window is ${need - have} px too short for that row height: the scratchpad and roughly the last ${lostRows} day rows of every month fall below the fold and have to be scrolled to. Make the window taller, or choose Compact.`
          : `Dieses Fenster ist ${need - have} px zu niedrig für diese Zeilenhöhe: der Notizzettel und etwa die letzten ${lostRows} Tageszeilen jedes Monats liegen unter der Kante und müssen gescrollt werden. Fenster höher ziehen — oder Kompakt wählen.`));
    }
  }

  const paperSel = document.createElement('select');
  for (const [v, label] of [['a4', 'A4 quer / landscape'], ['a3', 'A3 quer / landscape']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    paperSel.appendChild(o);
  }
  paperSel.value = s.paper || 'a4';
  paperSel.addEventListener('change', () => {
    store.setSettings({ paper: paperSel.value });
    applySettingsToBody();
    notify('settings');
  });
  body.appendChild(field(t('paper'), paperSel));

  const langSel = document.createElement('select');
  for (const [v, label] of [['de', 'Deutsch'], ['en', 'English']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    langSel.appendChild(o);
  }
  langSel.value = s.language;
  langSel.addEventListener('change', () => {
    setLang(langSel.value);
    store.setSettings({ language: langSel.value });
    applySettingsToBody();
    // 13.7 — the native menu bar is UI too; tell the shell to relabel it.
    applyShellPref('language', langSel.value);
    notify('settings');
    api.close();
    openSettings();
  });
  body.appendChild(field(t('language'), langSel));

  // ── app shell ──────────────────────────────────────────────────────────────
  body.appendChild(el('div', 'section-title', t('window')));
  body.appendChild(field('', switchBox(t('launchAtLogin'), s.launchAtLogin, (v) => {
    store.setSettings({ launchAtLogin: v });
    applyShellPref('launch_at_login', v);
  })));
  body.appendChild(field('', switchBox(t('menuBarIcon'), s.menuBarIcon, (v) => {
    store.setSettings({ menuBarIcon: v });
    applyShellPref('menu_bar_icon', v);
  })));
  if (!isTauri()) {
    body.appendChild(el('p', 'hint',
      lang === 'en'
        ? 'Both are handled by the native shell; in the browser preview they are stored but inert.'
        : 'Beides erledigt die native Hülle; in der Browser-Vorschau werden sie gespeichert, wirken aber nicht.'));
  }

  // ── updates (22.4 — the second, and only other, home of the quiet hint) ────
  // Deliberately placed with the app-shell settings and not with the data
  // section: an update is a fact about the *program*, and 22.7 guarantees it
  // never touches the board. Putting it next to Export/Import/Sicherungen would
  // suggest otherwise to exactly the reader least able to check.
  buildUpdateSection(body, api);

  // ── F19 · Familienkreis / Meine Geräte / Synchronisation ───────────────────
  // Null on a solo install, and null until `family/mount.js` has been loaded. See the seam's
  // docblock at the top of this file for why this is a callback and not an import.
  if (familySections) {
    try { familySections(body, api); }
    catch (e) { console.warn('[settings] the family sections did not draw:', e); }
  }

  // ── data ───────────────────────────────────────────────────────────────────
  body.appendChild(el('div', 'section-title', t('data')));

  const exp = el('button', 'btn-ghost', `${t('export')} …  ⇧⌘E`);
  exp.addEventListener('click', () => exportBoard());
  const imp = el('button', 'btn-ghost', `${t('import')} …  ⇧⌘I`);
  imp.addEventListener('click', () => importBoard(() => { notify('settings'); api.close(); }));
  const btns = el('div', 'ctl');
  btns.appendChild(exp);
  btns.appendChild(imp);
  const wrapf = el('div', 'field');
  wrapf.appendChild(el('label', null, 'JSON'));
  wrapf.appendChild(btns);
  body.appendChild(wrapf);
  body.appendChild(el('p', 'hint', storagePath()));

  // 11.5 — snapshot restore
  body.appendChild(el('div', 'section-title', t('snapshots')));
  const snaps = store.listSnapshots();
  if (!snaps.length) {
    body.appendChild(el('p', 'hint', t('noSnapshots')));
  } else {
    for (const sn of snaps) {
      const row = el('div', 'snap-row');
      row.appendChild(el('span', null, formatDate(sn.day, lang)));
      const right = el('div');
      right.style.cssText = 'display:flex;align-items:center;gap:10px';
      right.appendChild(el('span', 'when', new Date(sn.at).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'de-DE')));
      const b = el('button', 'btn-ghost', t('restore'));
      b.style.cssText = 'height:22px;padding:0 9px';
      b.addEventListener('click', () => {
        confirmSheet({
          title: t('restoreConfirm'),
          body: t('restoreBody', formatDate(sn.day, lang)),
          confirmLabel: t('restore'),
          danger: true,
          onConfirm: () => {
            store.restoreSnapshot(sn.day);
            notify('restore');
            api.close();
          },
        });
      });
      right.appendChild(b);
      row.appendChild(right);
      body.appendChild(row);
    }
  }

  body.appendChild(el('p', 'hint', t('shortcutHint')));
  // LZP-106 — the unlock walkthrough, reachable forever and on every platform.
  // Under D1 (unsigned) this is the screen the PO points at over the phone, and
  // the one a second Mac needs; it must not be a one-shot that a dismissed
  // first run puts out of reach. The v1 note that used to sit here taught the
  // Control-click bypass macOS 15 removed (A12).
  const help = el('button', 'btn-ghost', t('gatekeeper'));
  help.style.cssText = 'height:24px;padding:0 10px;margin-left:178px';
  help.addEventListener('click', () => { api.close(); openUnlockHelp(); });
  body.appendChild(help);
}

function rangeField(label, value, min, max, onInput, unit) {
  const f = el('div', 'field');
  f.appendChild(el('label', null, label));
  const c = el('div', 'ctl');
  const r = document.createElement('input');
  r.type = 'range';
  r.min = String(min);
  r.max = String(max);
  r.step = '1';
  r.value = String(value);
  const v = el('span', 'val', `${value} ${unit}`);
  r.addEventListener('input', () => {
    v.textContent = `${r.value} ${unit}`;
    onInput(Number(r.value));
  });
  c.appendChild(r);
  c.appendChild(v);
  f.appendChild(c);
  return f;
}

function formatDate(d, lang) {
  const { y, m, day } = { ...parseISO(d), day: parseISO(d).d };
  const MN = lang === 'en' ? MONTH_EN : MONTH_DE;
  return lang === 'en' ? `${MN[m - 1]} ${day}, ${y}` : `${day}. ${MN[m - 1]} ${y}`;
}

/** Shell preferences only exist inside a native shell; in the browser they are stored but inert. */
export function applyShellPref(cmd, value) {
  const T = window.__TAURI__;
  const invoke = T?.core?.invoke || T?.invoke;
  if (!invoke) return;
  invoke('set_shell_pref', { key: cmd, value }).catch((e) =>
    console.warn('[settings] shell pref failed', e)
  );
}

export { stateName };
