// One human-readable JSON, written atomically (spec 11.4).
//
// Inside Tauri that is ~/Library/Application Support/LangzeitPlaner/board.json
// via the fs plugin (temp file + rename, done in Rust). In a plain browser —
// which is how the board is developed and previewed — it degrades to
// localStorage under the same key names. Nothing above this file knows which.

const DIR = 'LangzeitPlaner';
const FILE = 'board.json';
const LS_BOARD = 'langzeitplaner.board';
const LS_SNAP = 'langzeitplaner.snapshots';

const tauri = () => (typeof window !== 'undefined' ? window.__TAURI__ : null);

export const isTauri = () => !!tauri();

async function tauriInvoke(cmd, args) {
  const T = tauri();
  const invoke = T?.core?.invoke || T?.invoke;
  if (!invoke) throw new Error('tauri invoke unavailable');
  return invoke(cmd, args);
}

export async function loadBoard() {
  if (isTauri()) {
    try {
      const txt = await tauriInvoke('load_board', {});
      return txt ? JSON.parse(txt) : null;
    } catch (e) {
      console.warn('[storage] Tauri load failed, falling back', e);
    }
  }
  try {
    const raw = localStorage.getItem(LS_BOARD);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function saveBoard(state) {
  const txt = JSON.stringify(state, null, 2);
  if (isTauri()) {
    try {
      await tauriInvoke('save_board', { contents: txt });
      return;
    } catch (e) {
      console.warn('[storage] Tauri save failed, falling back', e);
    }
  }
  localStorage.setItem(LS_BOARD, txt);
}

/**
 * Best-effort write during pagehide/beforeunload. Async work is not guaranteed
 * to finish while the window is going away, so this stays synchronous: in the
 * browser it hits localStorage directly, and in Tauri the debounced save plus
 * the window-close hook already cover the same ground.
 */
export function saveBoardSync(state) {
  try {
    localStorage.setItem(LS_BOARD, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[storage] sync flush failed', e);
  }
}

export async function loadSnapshots() {
  if (isTauri()) {
    try {
      const txt = await tauriInvoke('load_snapshots', {});
      return txt ? JSON.parse(txt) : [];
    } catch (e) {
      console.warn('[storage] Tauri snapshot load failed, falling back', e);
    }
  }
  try {
    const raw = localStorage.getItem(LS_SNAP);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveSnapshots(list) {
  const txt = JSON.stringify(list);
  if (isTauri()) {
    try {
      await tauriInvoke('save_snapshots', { contents: txt });
      return;
    } catch (e) {
      console.warn('[storage] Tauri snapshot save failed, falling back', e);
    }
  }
  localStorage.setItem(LS_SNAP, txt);
}

export const storagePath = () =>
  isTauri()
    ? `~/Library/Application Support/${DIR}/${FILE}`
    : `localStorage · ${LS_BOARD}`;
