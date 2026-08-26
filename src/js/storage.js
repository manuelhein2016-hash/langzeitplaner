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

// ─────────────────────────────────────────────────────────────────────────────
// LZP-402 — the op log (ADR 001 §9, ADR 005 §2.3)
//
// Five more functions in exactly the shape of the five above: try Tauri, fall back to
// localStorage, never let the caller know which. They write two more files beside `board.json`:
//
//   ops.jsonl        one op per line, APPENDED — never a whole-file rewrite
//   checkpoint.json  the serialized RegisterMap + cursors + seqs + parked lines
//
// ADR 001 §9/§11: **neither file exists in solo mode.** `board.json` is the checkpoint and the
// log is empty until a space is created, so `store.js` does not call `appendOps`/`saveCheckpoint`
// while `familySpaceId === null`. That is not a nicety — `tests/tier1/store-persistence.test.js`
// asserts that a persist touches EXACTLY the two v1 storage slots, and it is the promise §11
// makes ("no extra file"). The READ functions are safe to call at any time: they create nothing.
//
// `appendOps` MUST be an append. Appending a log by rewriting it is O(n²) (ADR 001 §9), so the
// Tauri/Swift side uses `FileHandle.seekToEnd` / `OpenOptions::append`, and the browser fallback
// — which has no append primitive at all — is capped instead (see LS_OPS_CAP).
// ─────────────────────────────────────────────────────────────────────────────

const OPS_FILE = 'ops.jsonl';
const LS_OPS = 'langzeitplaner.ops';
const LS_CHECKPOINT = 'langzeitplaner.checkpoint';

/**
 * ADR 005 §2.3 — `localStorage` cannot hold a growing log: ~5 MB of quota and a whole-value
 * rewrite on every `setItem`. In the browser fallback the tail is capped at 2 000 ops and the
 * store checkpoints aggressively. Dev fidelity degrades; the shipped path's correctness does not.
 */
export const LS_OPS_CAP = 2000;

/** Parse a JSONL blob into lines, skipping anything unreadable rather than throwing. */
function parseJSONL(txt) {
  const out = [];
  if (typeof txt !== 'string' || txt === '') return out;
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* a torn last line — skip it, keep the rest */ }
  }
  return out;
}

const toJSONL = (lines) => lines.map((l) => JSON.stringify(l)).join('\n');

/** @returns {Promise<Object[]>} the parsed JSONL lines; `[]` when there is no log */
export async function loadOps() {
  if (isTauri()) {
    try {
      return parseJSONL(await tauriInvoke('load_ops', {}));
    } catch (e) {
      console.warn('[storage] Tauri op-log load failed, falling back', e);
    }
  }
  try {
    return parseJSONL(localStorage.getItem(LS_OPS));
  } catch {
    return [];
  }
}

/**
 * APPEND lines to the log. Never rewrites the file on the native path.
 * @param {Object[]} lines @returns {Promise<void>}
 */
export async function appendOps(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return;
  const txt = `${toJSONL(lines)}\n`;
  if (isTauri()) {
    try {
      await tauriInvoke('append_ops', { contents: txt });
      return;
    } catch (e) {
      console.warn('[storage] Tauri op-log append failed, falling back', e);
    }
  }
  // The browser has no append primitive, so this is a read-modify-write — and therefore the
  // path that has to be capped. The store is told (`LS_OPS_CAP`) and checkpoints accordingly.
  let existing = [];
  try { existing = parseJSONL(localStorage.getItem(LS_OPS)); } catch { existing = []; }
  const next = existing.concat(lines).slice(-LS_OPS_CAP);
  localStorage.setItem(LS_OPS, toJSONL(next));
}

/**
 * Whole-file rewrite, keeping the tail from `keepFromLine` onwards. Rare: it runs after a
 * compaction has folded the head into the checkpoint (ADR 001 §7.2).
 * @param {number} keepFromLine @returns {Promise<void>}
 */
export async function truncateOps(keepFromLine = 0) {
  const from = Number.isInteger(keepFromLine) && keepFromLine > 0 ? keepFromLine : 0;
  if (isTauri()) {
    try {
      await tauriInvoke('truncate_ops', { keepFromLine: from });
      return;
    } catch (e) {
      console.warn('[storage] Tauri op-log truncate failed, falling back', e);
    }
  }
  let existing = [];
  try { existing = parseJSONL(localStorage.getItem(LS_OPS)); } catch { existing = []; }
  const kept = existing.slice(from);
  if (kept.length === 0) localStorage.removeItem(LS_OPS);
  else localStorage.setItem(LS_OPS, toJSONL(kept));
}

/** @returns {Promise<Object|null>} the parsed checkpoint, or null when there is none */
export async function loadCheckpoint() {
  if (isTauri()) {
    try {
      const txt = await tauriInvoke('load_checkpoint', {});
      return txt ? JSON.parse(txt) : null;
    } catch (e) {
      console.warn('[storage] Tauri checkpoint load failed, falling back', e);
    }
  }
  try {
    const raw = localStorage.getItem(LS_CHECKPOINT);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Atomic whole-file write, exactly like `saveBoard` — a torn checkpoint is the one file that
 * cannot be re-derived from anything else.
 * @param {Object} blob `oplog.checkpoint()` @returns {Promise<void>}
 */
export async function saveCheckpoint(blob) {
  const txt = JSON.stringify(blob);
  if (isTauri()) {
    try {
      await tauriInvoke('save_checkpoint', { contents: txt });
      return;
    } catch (e) {
      console.warn('[storage] Tauri checkpoint save failed, falling back', e);
    }
  }
  localStorage.setItem(LS_CHECKPOINT, txt);
}

/**
 * Does an op log exist? The other half of ADR 001 §8.4's idempotence predicate
 * (`shouldMigrate(board, {opsLogExists})`) — a READ, so it creates nothing.
 * @returns {Promise<boolean>}
 */
export async function opsLogExists() {
  const cp = await loadCheckpoint();
  if (cp) return true;
  const ops = await loadOps();
  return ops.length > 0;
}

export const opsPath = () =>
  isTauri()
    ? `~/Library/Application Support/${DIR}/${OPS_FILE}`
    : `localStorage · ${LS_OPS}`;
