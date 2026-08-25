// Export / import (11.2, 11.3, 11.7). Inside Tauri these go through the native
// save/open dialogs; in the browser they fall back to a download and a file
// picker. Import is the one board-wide change undo does not cover, so it asks
// first — and the daily snapshot taken before the write is the real safety net.

import { store } from './store.js';
import { t } from './i18n.js';
import { confirmSheet, toast } from './ui.js';

const tauriInvoke = () => {
  const T = window.__TAURI__;
  return T?.core?.invoke || T?.invoke || null;
};

export async function exportBoard() {
  const json = store.exportJSON();
  const name = store.exportFilename();

  const invoke = tauriInvoke();
  if (invoke) {
    try {
      const saved = await invoke('export_board', { contents: json, suggestedName: name });
      if (saved) toast(`${t('export')} ✓`);
      return;
    } catch (e) {
      console.warn('[backup] native export failed, falling back', e);
    }
  }

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`${t('export')} ✓`);
}

export async function importBoard(done = () => {}) {
  const invoke = tauriInvoke();
  if (invoke) {
    try {
      const txt = await invoke('import_board', {});
      if (txt) confirmAndReplace(txt, done);
      return;
    } catch (e) {
      console.warn('[backup] native import failed, falling back', e);
    }
  }

  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'application/json,.json';
  inp.addEventListener('change', async () => {
    const f = inp.files?.[0];
    if (!f) return;
    confirmAndReplace(await f.text(), done);
  });
  inp.click();
}

function confirmAndReplace(txt, done) {
  let parsed;
  try {
    parsed = JSON.parse(txt);
  } catch {
    toast(t('importConfirm') + ' — JSON ✗');
    return;
  }
  confirmSheet({
    title: t('importConfirm'),
    body: t('importBody'),
    confirmLabel: t('replace'),
    danger: true,
    onConfirm: () => {
      store.replaceAll(parsed);
      toast(`${t('import')} ✓`);
      done();
    },
  });
}
