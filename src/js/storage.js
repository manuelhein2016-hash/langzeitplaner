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

/**
 * The four things `board.json` can be. R5-3a/b/c: THREE OF THEM USED TO LOOK LIKE THE FOURTH.
 *
 *   'ok'           bytes were read and they parsed
 *   'absent'       NO BYTE STRING EXISTED IN EITHER STORE and nothing threw — a fresh install
 *   'unparseable'  bytes exist and `JSON.parse` threw — a truncated write, a bad sector, a
 *                  sync client's conflicted copy. THE USER'S DATA IS ON DISK AND UNREADABLE.
 *   'read-failed'  the READ ITSELF failed — a locked file, a permission prompt the user
 *                  dismissed, an EIO. Nothing is known about the file, including whether it
 *                  exists. This is emphatically NOT 'absent'.
 *
 * ADR 006 makes `board.json` the sole authority over content, so the ONE precondition of the
 * whole rule is that it can be read. Collapsing these four into "is `raw` null?" is what let a
 * corrupted byte hand the board to any log lying beside it (`store._recoverFromLog`).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * R6-5a — THE STATUS IS A FUNCTION OF THE BYTES, AND `''` IS BYTES.
 *
 * Round 5 enumerated the four BRANCHES above and got `''` wrong anyway, because the enumeration
 * was of branches and the input is bytes. `tests/helpers/domains.js` D1 is the enumeration of the
 * input; this is the rule it states, and there is no fifth way to be absent:
 *
 *   THE BYTE AXIS — what a store can answer with, exhaustively:
 *     a string          of ANY length, INCLUDING ZERO  ⇒ these are the file's bytes; they decide.
 *     null / undefined  ⇒ this store holds nothing. Ask the next one.
 *     a throw           ⇒ a FACT about the read, remembered, and never an absence.
 *
 *   THE SOURCE AXIS — where bytes can come from (`D1_SOURCES`), and it may change `fallback`
 *   and nothing else:
 *     the browser                     localStorage is the only store;
 *     Tauri, native answers           the native bytes decide, `''` included;
 *     Tauri, native throws            the localStorage copy `saveBoardText` leaves behind is
 *                                     still consulted — otherwise the one board a failed save
 *                                     rescued is unreachable — and IT decides if it holds bytes;
 *     Tauri, native returns nothing   the same.
 *
 *   THE VERDICT:
 *     some store answered with a string ⇒ `JSON.parse` decides: 'ok' or 'unparseable'.
 *     no store answered with a string   ⇒ 'read-failed' if anything threw, else 'absent'.
 *
 * WHY THIS MATTERS MORE THAN ANY OTHER LINE IN THE FILE. `absent` is the ONE kind that may hand
 * the board to an op log it cannot tie to that board (ADR 006 §5.5, `store._recoverFromLog` —
 * the one branch with no lineage check), and the session that comes out of it is WRITABLE. A
 * zero-byte `board.json` is the single most likely outcome of an interrupted write. Reporting it
 * as `absent` is therefore A3-C1's whole outcome behind zero bytes instead of one bad byte:
 * the stranger's board on screen, `quarantine === null`, and the first autosave committing it.
 * → `tests/attack/round6-recovery.test.js` R6-5a, D1-b01 × all four sources.
 */
export const BOARD_FILE_STATUS = Object.freeze(['ok', 'absent', 'unparseable', 'read-failed']);

const readError = (e) => `${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : String(e)}`;

/**
 * The board file, its BYTES, what they parse to, and WHICH OF THE FOUR THINGS IT IS.
 *
 * ADR 006 §4.2 hashes "the exact bytes written to `board.json` in the same persist", and the
 * check on the way back in has to hash the exact bytes as READ. `loadBoard()` throws the bytes
 * away, so a hash taken over a re-serialization of the parsed object is a hash of something the
 * file never contained (key order, whitespace, a number that round-tripped). Hence `text`.
 *
 * THE FALLBACK IS A PAIR, NOT A GUESS. `saveBoardText` writes to `localStorage` when the native
 * write throws, so a native READ that throws must still look there — otherwise the one board a
 * failed save left behind becomes unreachable. What it may never do is report the result as
 * "there is no board file": if the fallback is empty too, the status is `read-failed` and the
 * store goes read-only rather than treating an EIO as a fresh install (R5-3c).
 *
 * @returns {Promise<{text: string|null, raw: Object|null, status: string, error: string|null,
 *                    where: string, fallback: boolean}>}
 */
export async function loadBoardFile() {
  const where = storagePath();
  let txt = null;
  let failure = null;
  let fallback = false;

  if (isTauri()) {
    try {
      const native = await tauriInvoke('load_board', {});
      // `typeof native === 'string'` — NOT `native ?? …` and NOT `if (native)`. An empty string
      // is a file that holds nothing, which is a completely different fact from a store that
      // holds no file, and every falsy test collapses the two (R6-5a).
      if (typeof native === 'string') txt = native;
    } catch (e) {
      // NOT `txt = null`. A throw here is a fact about the read, and it survives to the caller.
      console.warn('[storage] Tauri load failed, falling back', e);
      failure = readError(e);
    }
  }
  if (txt === null) {
    const nativeMiss = isTauri();
    try {
      const ls = localStorage.getItem(LS_BOARD);
      // Same test, same reason. `fallback` reports WHICH store answered and may never decide
      // WHETHER one did: a zero-byte fallback copy has still answered.
      if (typeof ls === 'string') { txt = ls; fallback = nativeMiss; }
    } catch (e) {
      failure = failure ?? readError(e);
    }
  }

  if (txt === null) {
    // NO STORE ANSWERED WITH A STRING. Only here can the file be `absent` — and a read that
    // FAILED is not a board that is absent. The distinction is the whole point.
    return failure
      ? { text: null, raw: null, status: 'read-failed', error: failure, where, fallback: false }
      : { text: null, raw: null, status: 'absent', error: null, where, fallback: false };
  }
  // Bytes reached us — from either store, of any length, ZERO INCLUDED. `JSON.parse('')` throws,
  // so an empty file lands on `unparseable`, which is exactly what it is: bytes on disk that do
  // not say what the board is. It goes to ADR 006 §5.6's read-only boot with the other two, and
  // never to §5.5's recovery.
  if (txt === '') {
    return { text: '', raw: null, status: 'unparseable', where, fallback,
      error: 'the file is EMPTY: zero bytes, which is what an interrupted write leaves behind' };
  }
  try {
    return { text: txt, raw: JSON.parse(txt), status: 'ok', error: null, where, fallback };
  } catch (e) {
    return { text: txt, raw: null, status: 'unparseable', error: readError(e), where, fallback };
  }
}

/**
 * `loadBoardFile` reduced to the two keys its v1-era callers destructure.
 *
 * Kept at EXACTLY two keys — `tests/tier1/storage.test.js` deep-equals the whole object — and
 * kept as a thin wrapper so there is one read path and not two. A caller that has to tell
 * "absent" from "unreadable" from "the read failed" calls `loadBoardFile` instead; this one
 * cannot express the difference and never could.
 * @returns {Promise<{text: string|null, raw: Object|null}>}
 */
export async function loadBoardText() {
  const { text, raw } = await loadBoardFile();
  return { text, raw };
}

export async function loadBoard() {
  const { raw } = await loadBoardText();
  return raw;
}

/**
 * Write the EXACT bytes given. `saveBoard(state)` is the thin wrapper its v1 callers use;
 * everything that needs the bytes it wrote (ADR 006 §6: serialize once, hash those bytes) calls
 * this one so that no second `JSON.stringify` can quietly produce a different string.
 * @param {string} txt
 */
export async function saveBoardText(txt) {
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

export async function saveBoard(state) {
  return saveBoardText(JSON.stringify(state, null, 2));
}

/**
 * Best-effort write during pagehide/beforeunload. Async work is not guaranteed
 * to finish while the window is going away, so this stays synchronous: in the
 * browser it hits localStorage directly, and in Tauri the debounced save plus
 * the window-close hook already cover the same ground.
 */
export function saveBoardSync(state) {
  saveBoardSyncText(JSON.stringify(state, null, 2));
}

/** The same, for a caller that has already serialized (ADR 006 §6 — serialize exactly once). */
export function saveBoardSyncText(txt) {
  try {
    localStorage.setItem(LS_BOARD, txt);
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

// ─────────────────────────────────────────────────────────────────────────────
// I-6 — MOVING A QUARANTINED LOG ASIDE
//
// A quarantine makes three promises (ADR 006 §7): the log is not applied, not deleted, not
// overwritten. Leaving the two files exactly where they are keeps all three — and re-derives the
// refusal, and re-reports it, on every single launch, with no way for the user to make it stop.
// That is I-6.
//
// The sanctioned form is a MOVE, never a delete: `ops.quarantined-<ts>.jsonl` /
// `checkpoint.quarantined-<ts>.json` beside the originals. "Not deleted" is one of the three
// promises and it survives the move — the bytes are still on disk, under a name that says why.
//
// PLATFORM SPLIT, STATED HONESTLY. The browser/localStorage fallback can do this with the
// primitives it already has (a key is a file). The NATIVE path cannot: `src-tauri/src/lib.rs` and
// `shell-macos/main.swift` expose exactly nine file commands (`load_board`, `save_board`,
// `load_snapshots`, `save_snapshots`, `load_ops`, `append_ops`, `truncate_ops`, `load_checkpoint`,
// `save_checkpoint`) and none of them can create a THIRD file in the data directory. Truncating
// `ops.jsonl` without first writing the copy would break promise 2 outright, so on the native path
// this function does nothing and says so: `{moved: false, reason: …}`. The store must therefore
// treat a successful move as a bonus and never as a precondition.
//
// OWED (a file no one owned this round): `quarantine_logs(suffix)` on both shells — rename
// `ops.jsonl` → `ops.quarantined-<ts>.jsonl` and `checkpoint.json` →
// `checkpoint.quarantined-<ts>.json`, atomically, creating neither if the source is absent.
// ─────────────────────────────────────────────────────────────────────────────

/** `2026-08-27T10-31-04-512Z` — an ISO instant that is legal in a filename and sorts correctly. */
function quarantineStamp(at = Date.now()) {
  return new Date(at).toISOString().replace(/[:.]/g, '-');
}

/**
 * Move a refused op log aside so it is refused ONCE (I-6). Never deletes; never throws.
 *
 * @param {{at?: number}} [opts]
 * @returns {Promise<{moved: boolean, reason: string, ops: string|null, checkpoint: string|null}>}
 *   `ops` / `checkpoint` name the slots the bytes now live in, or null when that slot was empty.
 */
export async function quarantineLogAside({ at = Date.now() } = {}) {
  const suffix = quarantineStamp(at);
  if (isTauri()) {
    return {
      moved: false,
      reason: 'the native shell has no move-aside command yet (owed: quarantine_logs in '
        + 'src-tauri/src/lib.rs and shell-macos/main.swift); the refused files are LEFT WHERE THEY '
        + 'ARE, which keeps every quarantine promise and costs one repeated warning per launch',
      ops: null,
      checkpoint: null,
    };
  }
  let ops = null;
  let checkpoint = null;
  try {
    const opsBytes = localStorage.getItem(LS_OPS);
    if (typeof opsBytes === 'string' && opsBytes !== '') {
      ops = `${LS_OPS}.quarantined-${suffix}`;
      // Write the copy FIRST. If the write throws (quota), the original is still the only copy
      // and nothing has been lost — which is the whole reason the order is this way round.
      localStorage.setItem(ops, opsBytes);
      localStorage.removeItem(LS_OPS);
    }
    const cpBytes = localStorage.getItem(LS_CHECKPOINT);
    if (typeof cpBytes === 'string' && cpBytes !== '') {
      checkpoint = `${LS_CHECKPOINT}.quarantined-${suffix}`;
      localStorage.setItem(checkpoint, cpBytes);
      localStorage.removeItem(LS_CHECKPOINT);
    }
  } catch (e) {
    console.warn('[storage] could not move the quarantined log aside', e);
    return {
      moved: false,
      reason: `the move failed (${e && e.name ? e.name : 'Error'}); the refused files are left where they are`,
      ops: null,
      checkpoint: null,
    };
  }
  if (!ops && !checkpoint) {
    return { moved: false, reason: 'there was nothing on disk to move', ops: null, checkpoint: null };
  }
  return {
    moved: true,
    reason: 'the refused files were moved aside; they are still on disk, under a name that says why',
    ops,
    checkpoint,
  };
}

/** Every quarantined slot currently on disk, newest last. Read-only; a rescue pass reads these. */
export function quarantinedSlots() {
  const out = [];
  try {
    const n = localStorage.length;
    for (let i = 0; i < n; i++) {
      const k = localStorage.key(i);
      if (typeof k === 'string' && (k.startsWith(`${LS_OPS}.quarantined-`) || k.startsWith(`${LS_CHECKPOINT}.quarantined-`))) out.push(k);
    }
  } catch { /* a storage that cannot be enumerated simply reports nothing */ }
  return out.sort();
}

/**
 * Does an op log exist? The other half of ADR 001 §8.4's idempotence predicate
 * (`shouldMigrate(board, {opsLogExists})`) — a READ, so it creates nothing.
 *
 * DEPRECATED by ADR 006 R1: the store no longer branches on whether a log exists, so this has no
 * caller in `src/`. It is kept because `tests/tier2/shell-oplog.dom.js` uses it as the honest
 * "reading created no file" probe against the real shells. Remove it with `shouldMigrate`'s
 * `opsLogExists` parameter, not before.
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
