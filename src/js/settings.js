// One settings surface (⌘,) holding the whole inventory from F13's design
// notes. Everything here is configuration, not board content — none of it goes
// on the undo stack.

import { store } from './store.js';
import { t, getLang, setLang } from './i18n.js';
import { BUNDESLAENDER, stateName } from './holidays.js';
import { FERIEN_META } from './ferien.js';
import { el, openSheet, field, switchBox, confirmSheet, toast } from './ui.js';
import { storagePath, isTauri } from './storage.js';
import { exportBoard, importBoard } from './backup.js';
import { MONTH_DE, MONTH_EN, todayISO, parseISO } from './dates.js';

let notify = () => {};
export function initSettings(onChange) { notify = onChange || (() => {}); }

export function applySettingsToBody() {
  const s = store.state.settings;
  document.body.classList.toggle('ferien-hatch', !!s.layers.ferienPattern);
  document.body.classList.remove('paper-a4', 'paper-a3');
  document.body.classList.add(`paper-${s.paper || 'a4'}`);
  document.documentElement.lang = s.language || 'de';
}

export function openSettings() {
  openSheet({
    title: t('settings'),
    build: (body, api) => build(body, api),
    actions: [{ label: t('done'), kind: 'primary', run: (api) => api.close() }],
  });
}

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

  body.appendChild(rangeField(t('rowHeight'), s.rowHeight, 18, 32, (v) => {
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
  if (!isTauri()) body.appendChild(el('p', 'hint', t('gatekeeper')));
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
