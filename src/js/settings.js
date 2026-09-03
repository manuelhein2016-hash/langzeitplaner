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
// LZP-1009 — „Rückmeldung senden". A STATIC import on purpose, and the reasoning is the mirror
// image of the family seam's below.
//
// `src/js/feedback/` imports nothing that can open a socket: no `platform/net.js`, no `sync/`,
// no `crypto/`, and no `await import()` of its own. Its sender is a PORT (`feedback/port.js`),
// bound by whoever already holds a transport. So a static edge from here costs a solo launch a
// few kilobytes of pure, DOM-only code and costs ADR 003 §7 gate 2 nothing — whereas a dynamic
// `import()` here WOULD cost gate 2 something real: it would be a SECOND door out of the
// eagerly-evaluated graph, which is precisely the failure
// `tests/tier1/network-scope.test.js` §2 names ("one convenience `await import()` in
// settings.js 'just to draw the section' … one door can be read; three cannot").
import { buildHelpSection, initFeedback } from './feedback/ui.js';

initFeedback({ screen: () => (settingsOpen() ? 'settings' : 'board') });

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

  // ── LZP-1001 · 21.3 · Datenschutz ─────────────────────────────────────────
  // Below the data and snapshot sections ON PURPOSE: three of its paragraphs are about the file
  // the two buttons above it write, and a person who has just exported one is the person who
  // needs „ohne Passwort lesbar" in front of her. Drawn on every launch — see the copy block's
  // header for why it is not inside the Familienkreis section A10 puts it in.
  buildDatenschutzSection(body);

  // ── LZP-1009 · Hilfe — „Rückmeldung senden" ────────────────────────────────
  // PRINCIPLE 10, made structural: this is the ONLY call site. There is no floating button on
  // the board, no error toast that offers to file a report, no badge. A permanent widget on the
  // board would clutter the one screen the product is about — and, the half that is easier to
  // forget, it would make the tester permanently aware she is being studied. She is using a
  // calendar; she should be able to forget this exists until she wants it.
  //
  // It sits beside the Gatekeeper walkthrough because both are Hilfe: the two things a person
  // reaches for when something is wrong, in the one place she will look for them.
  buildHelpSection(body, api);

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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// LZP-1001 · 21.3 — DATENSCHUTZ.  German is the source; the English is a translation of it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ── WHY THE TEXT IS HERE AND NOT IN `i18n.js` ─────────────────────────────────────────────────
// The same argument `feedback/copy.js` makes one section down: `i18n.js` is the product's label
// table and belongs to nobody. These are load-bearing promises — „die Vermittlungsstelle kann sie
// nicht lesen" is a claim that has to stay TRUE — so they live where a person changing the thing
// they describe will see them in the same diff. `settings.js` is the file that draws the screen
// and it is the file that owns the words on it.
//
// ── WHY IT IS A TOP-LEVEL SECTION AND NOT INSIDE „Familienkreis" ──────────────────────────────
// A10 puts the 21.3 text in the *Familie* section. Built that way it would be invisible to
// exactly the reader who needs three of its paragraphs most: a SOLO Mac, which never loads
// `family/mount.js` and therefore never draws that section, and whose backup file, key-loss
// consequence and „dieser Mac spricht mit niemandem" are all still true and still worth reading.
// So it is a section of its own, drawn on every launch. That is a deviation from A10's placement
// and nothing else; the family-specific paragraphs name their condition in their first clause.
//
// ── WHAT THE COPY IS ALLOWED TO CLAIM ─────────────────────────────────────────────────────────
// Only what a document in this repository establishes, and each block is annotated with which:
//
//   · solo / family scope ......... story 21.5 as amended (see D10), ADR 003 §7, and
//                                   `tests/tier1/network-scope.test.js` §1–§5
//   · processors and region ....... decision D2, addendum §3 and §9 — Vercel + Prisma Postgres,
//                                   EU/Frankfurt; `server/core` `meta.region === 'fra1'`
//   · what the relay sees ......... ADR 003 §5.2's inventory, verbatim in substance, and
//                                   `docs/v2/server-metadata.md`
//   · what it never sees .......... ADR 004's redaction boundary — six adversary rounds, zero
//                                   bytes of a Privat entry
//   · retention ................... `docs/v2/RUNBOOK.md` §7.2. It is uncomfortable and it is said
//                                   anyway: „gespeichert, bis sie manuell gelöscht wird", never
//                                   „wird nach einer Stunde gelöscht"
//   · the update check ............ `platform/updater.js`'s 21.5 ↔ 22.3 note; RUNBOOK §7.3
//   · the feedback report ......... LZP-1009 · `server/core/handlers/feedback.js`. It is NOT
//                                   end-to-end encrypted and the copy says so in those words
//   · the backup file ............. LZP-1003 finding **R1** and decision D8
//
// ── THE ONE SENTENCE THAT IS NEW, AND WHY IT IS HERE RATHER THAN ON THE EXPORT SHEET ──────────
// R1: a stolen backup yields the whole board in the clear, with no passphrase. `board` is
// plaintext JSON on BOTH export paths; D8 only ever covered the identity block. The export
// sheet's own strings live in `src/js/crypto/backup.js`, which this ticket does not own — so the
// true sentence is written HERE, in the section a person reads before it matters, and
// `tests/tier2/datenschutz.dom.js` §5 is the inversion of the row that used to assert no string
// anywhere said it (`tests/attack/e10-crypto-backup.test.js` E10-B7). See FINDINGS §20c.
//
// NO URL LITERAL APPEARS IN THIS BLOCK, deliberately: `tests/attack/e10-network-scope.test.js`
// §2e reads "no shipped module names a resolvable remote host" over code, and a Datenschutz
// paragraph is not the place to be the first exception. The processors are named by NAME.

export const DATENSCHUTZ = Object.freeze({
  de: Object.freeze({
    title: 'Datenschutz',
    lead: 'Ohne Marketing: was dieses Programm über dich weiß, was ein Server davon sieht, wie lange '
      + 'das dort steht — und was niemand zurückholen kann.',

    soloTitle: 'Ohne Familienkreis spricht dieser Mac mit niemandem.',
    soloBody: 'Solange du keinen Familienkreis nutzt, verlässt kein Eintrag diesen Mac. Es gibt keine '
      + 'Anmeldung, kein Konto, keine Statistik, keine Absturzmeldung und keinen Zähler — auch keinen '
      + 'anonymen. Genau eine Ausnahme gibt es, und sie geschieht nur, wenn du sie auslöst: die '
      + 'Rückmeldung unter „Hilfe". Von allein sendet dieses Programm nichts.',

    privatTitle: 'Was du auf „Privat" stellst, geht nie an die Familie.',
    privatBody: 'Nicht verschlüsselt, sondern gar nicht: für private Einträge gibt es keinen '
      + 'Schlüssel, den ein anderes Mitglied hätte, und es wird dafür nichts an den Familienkreis '
      + 'geschickt, aus dem sich etwas zurückrechnen ließe — auch keine Größe und kein Zeitpunkt. '
      + 'Private Einträge gehen nur zu deinen eigenen, gekoppelten Macs.',

    familyTitle: 'Mit Familienkreis: genau eine Gegenstelle.',
    familyBody: 'Die App spricht mit einer einzigen Adresse — der Vermittlungsstelle, die beim '
      + 'Beitreten eingetragen wurde — und mit keiner weiteren. Sie läuft bei Vercel (Programm) und '
      + 'Prisma Postgres (Datenbank), beide in der EU, Region Frankfurt. Deine Einträge sind '
      + 'verschlüsselt, bevor sie den Mac verlassen; die Schlüssel liegen ausschließlich auf den Macs '
      + 'der Familie. Wer den Server betreibt, kann sie nicht lesen — die Schlüssel sind nicht dort und '
      + 'waren nie dort.',

    seesTitle: 'Was die Vermittlungsstelle trotzdem sieht',
    sees: Object.freeze([
      'die Kennungen von Familienkreis, Mitgliedern und Geräten — Zufallsnummern, keine Namen',
      'die Farbe, die jedes Mitglied gewählt hat: sie muss eindeutig sein, und das lässt sich nicht '
        + 'im Verschlüsselten prüfen',
      'wann welches Gerät zuletzt gesprochen hat, wie viele Änderungen es gab, und wie groß die '
        + 'verschlüsselten Pakete sind — auf 256 Byte gerundet',
      'wann eine Änderung ankam (nicht, wann sie geschrieben wurde), und in welcher Reihenfolge',
      'bei jeder Anfrage: die IP-Adresse deines Anschlusses, die Version der App und die Uhr deines Macs',
    ]),
    seesNotTitle: 'Was sie nie sieht',
    seesNotBody: 'Keinen Text eines Eintrags, keine Beschriftung eines Balkens, keine Kategorie, keinen '
      + 'Notizzettel, kein Datum und keinen einzigen Namen: die Namen der Mitglieder stehen im '
      + 'verschlüsselten Strom, nicht in der Datenbank. Aus den Zeitpunkten und den gerundeten Größen '
      + 'lässt sich ablesen, DASS jemand etwas geändert hat — nicht, was.',

    retentionTitle: 'Wie lange das dort steht',
    retentionBody: 'Ehrlich: unbefristet. Es gibt keine automatische Löschung. Die Zeilen, mit denen '
      + 'Missbrauch gebremst wird, enthalten eine IP-Adresse und bleiben gespeichert, bis sie jemand '
      + 'von Hand löscht. Änderungen verschwinden erst, wenn ein Mitglied entfernt oder der '
      + 'Familienkreis gelöscht wird. Vercel führt zusätzlich ein eigenes Anfrageprotokoll; dafür '
      + 'gelten Vercels Bedingungen und nicht unsere.',

    updateTitle: 'Die zweite Gegenstelle: die Update-Prüfung',
    updateBody: 'Etwa einmal täglich fragt die App-Hülle — nicht das Board — bei GitHub nach, ob es '
      + 'eine neuere Version gibt, und holt dafür eine einzige kleine Datei. Diese Anfrage enthält '
      + 'keine Kennung, keinen Namen und nichts von deinem Plan. Sie läuft nur, wenn du der '
      + 'Update-Prüfung zugestimmt hast, und lässt sich oben unter „Updates" wieder abschalten. GitHub '
      + 'gehört zu Microsoft und steht nicht in der EU.',

    feedbackTitle: 'Die Rückmeldung ist nicht Ende-zu-Ende verschlüsselt.',
    feedbackBody: 'Das ist der eine Unterschied, den du kennen solltest. Deine Einträge sind Ende-zu-Ende '
      + 'verschlüsselt — nur die Macs der Familie können sie öffnen. Eine Rückmeldung ist das nicht: sie '
      + 'ist unterwegs geschützt, aber am Ziel lesbar, und wer die Vermittlungsstelle betreibt, liest '
      + 'sie. Deshalb steht vorher auf dem Bildschirm, was genau verschickt wird, deshalb ist das Bild '
      + 'ohne einen einzigen Buchstaben, und deshalb wird nichts gekürzt. Schreib in eine Rückmeldung '
      + 'nichts, was du in einen Eintrag schreiben würdest.',

    backupTitle: 'Die Sicherungsdatei: bitte genau lesen.',
    backupBody: 'In einer exportierten Sicherung stehen deine Einträge im Klartext — Notizen, Balken, '
      + 'Kategorien, Notizzettel. Wer die Datei hat, kann sie in einem Texteditor öffnen und alles lesen: '
      + 'ohne Passwort lesbar, auch bei einer Sicherung MIT Passwort. Das Passwort schützt die '
      + 'Schlüssel, nicht die Einträge. Es entscheidet, ob jemand mit dieser Datei dein Gerät werden '
      + 'kann, und es macht die Datei fälschungssicher — es macht sie nicht unlesbar. Bewahre sie so '
      + 'auf, wie du deinen Kalender aufbewahren würdest, und nicht offen in einer geteilten Cloud.',

    lossTitle: 'Ist der Schlüssel weg, sind die Daten weg.',
    lossBody: 'Es gibt kein Zurücksetzen des Passworts, weil es kein Konto gibt. Wenn alle deine Macs '
      + 'verloren gehen und du keine Sicherung mit Passwort hast, kann niemand deine Daten '
      + 'wiederherstellen — wir nicht, Vercel nicht, Prisma nicht. Das ist der Preis dafür, dass sonst '
      + 'niemand mitlesen kann. Wenn du noch keine Sicherung hast: jetzt eine machen.',

    thirdTitle: 'Sonst nichts',
    thirdBody: 'Keine Analyse-Werkzeuge, keine Tracker, keine Werbung, keine Schriften von fremden '
      + 'Servern, keine Karten, kein Fehler-Melder. Vercel, Prisma Postgres und GitHub sind alle '
      + 'Stellen, die es gibt.',
  }),

  en: Object.freeze({
    title: 'Privacy',
    lead: 'No marketing: what this program knows about you, what a server sees of it, how long that '
      + 'stays there — and what nobody can get back.',

    soloTitle: 'Without a Familienkreis this Mac talks to nobody.',
    soloBody: 'As long as you use no Familienkreis, no entry leaves this Mac. There is no sign-in, no '
      + 'account, no statistics, no crash report and no counter — not even an anonymous one. There is '
      + 'exactly one exception, and it happens only when you trigger it: the feedback screen under '
      + '"Help". On its own this program sends nothing.',

    privatTitle: 'What you mark "Privat" never goes to the family.',
    privatBody: 'Not encrypted — not at all: private entries have no key any other member holds, and '
      + 'nothing is sent to the Familienkreis from which one could be inferred, not even a size or a '
      + 'time. Private entries travel only to your own paired Macs.',

    familyTitle: 'With a Familienkreis: exactly one counterpart.',
    familyBody: 'The app talks to a single address — the relay entered when you joined — and to no '
      + 'other. It runs on Vercel (the program) and Prisma Postgres (the database), both in the EU, '
      + 'Frankfurt region. Your entries are encrypted before they leave the Mac; the keys live only on '
      + 'the family’s Macs. Whoever operates the server cannot read them — the keys are not there '
      + 'and never were.',

    seesTitle: 'What the relay does see',
    sees: Object.freeze([
      'the ids of the Familienkreis, its members and their devices — random numbers, not names',
      'the colour each member picked: it has to be unique, and that cannot be checked inside ciphertext',
      'when each device last spoke, how many changes there were, and how large the encrypted packets '
        + 'are — rounded to 256 bytes',
      'when a change arrived (not when it was written), and in what order',
      'on every request: your connection’s IP address, the app version and your Mac’s clock',
    ]),
    seesNotTitle: 'What it never sees',
    seesNotBody: 'No entry text, no bar label, no category, no scratchpad, no date and not one name: '
      + 'member names travel inside the encrypted stream, not in the database. The timings and the '
      + 'rounded sizes show THAT somebody changed something — never what.',

    retentionTitle: 'How long that stays there',
    retentionBody: 'Honestly: indefinitely. There is no automatic deletion. The rows used to throttle '
      + 'abuse contain an IP address and stay stored until somebody deletes them by hand. Changes '
      + 'disappear only when a member is removed or the Familienkreis is deleted. Vercel additionally '
      + 'keeps its own request log; Vercel’s terms apply to it, not ours.',

    updateTitle: 'The second counterpart: the update check',
    updateBody: 'About once a day the app shell — not the board — asks GitHub whether a newer version '
      + 'exists, fetching one small file. That request carries no identifier, no name and nothing from '
      + 'your plan. It runs only if you agreed to the update check, and it can be switched off again '
      + 'under "Updates" above. GitHub belongs to Microsoft and is not in the EU.',

    feedbackTitle: 'A feedback report is not end-to-end encrypted.',
    feedbackBody: 'This is the one difference worth knowing. Your entries are end-to-end encrypted — '
      + 'only the family’s Macs can open them. A feedback report is not: it is protected in transit '
      + 'but readable at the far end, and whoever operates the relay reads it. That is why the screen '
      + 'shows you beforehand exactly what will be sent, why the image carries not one letter, and why '
      + 'nothing is truncated. Do not write anything into a report that you would write into an entry.',

    backupTitle: 'The backup file: please read this carefully.',
    backupBody: 'In an exported backup your entries are in the clear — notes, bars, categories, '
      + 'scratchpads. Whoever has the file can open it in a text editor and read everything: readable '
      + 'without the password, including in a backup made WITH one. The password protects the keys, not '
      + 'the entries. It decides whether somebody with this file can become your device, and it makes '
      + 'the file tamper-evident — it does not make it unreadable. Keep it the way you would keep your '
      + 'calendar, and not openly in a shared cloud.',

    lossTitle: 'If the key is gone, the data is gone.',
    lossBody: 'There is no password reset, because there is no account. If all your Macs are lost and '
      + 'you hold no password-protected backup, nobody can restore your data — not us, not Vercel, not '
      + 'Prisma. That is the price of nobody else being able to read along. If you have no backup yet: '
      + 'make one now.',

    thirdTitle: 'Nothing else',
    thirdBody: 'No analytics tooling, no trackers, no advertising, no fonts from foreign servers, no '
      + 'maps, no error reporter. Vercel, Prisma Postgres and GitHub are every party there is.',
  }),
});

/**
 * The Datenschutz section (21.3). Pure DOM, no imports beyond `el` — the copy above is the
 * deliverable and this only lays it out.
 *
 * Every block carries `data-ds="<key>"` so `tests/tier2/datenschutz.dom.js` can assert that the
 * text on the glass is the text in the table, rather than asserting the table to itself.
 *
 * @param {HTMLElement} body
 */
export function buildDatenschutzSection(body) {
  const d = DATENSCHUTZ[getLang() === 'en' ? 'en' : 'de'];

  // ⚠ EVERY RULE HERE IS AN INLINE STYLE, AND THAT IS DELIBERATE.
  //
  // `src/css/app.css` belongs to a parallel workflow (ONE OWNER PER FILE), so this section may
  // not add a class to it. It also should not simply inherit `.hint`: that class carries
  // `margin-left:178px` and lands at 306 px wide, because every other `.hint` in this sheet is a
  // caption sitting beside a control in the label column. This section has no controls — it is
  // ~3 500 characters of prose — and 306 px turns it into a very tall ribbon nobody finishes.
  // So the four rules below undo the label-column offset for THIS section only and give the text
  // the sheet's full 484 px. Measured in the browser, both languages.
  const PROSE = 'margin-left:0;width:auto;max-width:none;';

  const sec = el('div', 'section-title', d.title);
  sec.dataset.ds = 'title';
  body.appendChild(sec);

  const lead = el('p', 'hint', d.lead);
  lead.style.cssText = `${PROSE}margin-top:2px`;
  lead.dataset.ds = 'lead';
  body.appendChild(lead);

  const heading = (key) => {
    const h = el('p', 'hint', d[key]);
    h.style.cssText = `${PROSE}font-weight:700;font-size:12px;margin:14px 0 3px;color:var(--ink, #3d2185)`;
    h.dataset.ds = key;
    body.appendChild(h);
  };

  const block = (titleKey, bodyKey) => {
    heading(titleKey);
    const p = el('p', 'hint', d[bodyKey]);
    p.style.cssText = `${PROSE}margin-top:0`;
    p.dataset.ds = bodyKey;
    body.appendChild(p);
  };

  block('soloTitle', 'soloBody');
  block('privatTitle', 'privatBody');
  block('familyTitle', 'familyBody');

  heading('seesTitle');
  const ul = el('ul', 'hint');
  ul.style.cssText = `${PROSE}margin-top:0;padding-left:16px`;
  ul.dataset.ds = 'sees';
  for (const line of d.sees) ul.appendChild(el('li', null, line));
  body.appendChild(ul);

  block('seesNotTitle', 'seesNotBody');
  block('retentionTitle', 'retentionBody');
  block('updateTitle', 'updateBody');
  block('feedbackTitle', 'feedbackBody');
  block('backupTitle', 'backupBody');
  block('lossTitle', 'lossBody');
  block('thirdTitle', 'thirdBody');
}

export { stateName };
