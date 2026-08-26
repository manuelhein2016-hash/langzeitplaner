// ─────────────────────────────────────────────────────────────────────────────
// THE FROZEN v1 STORE — `src/js/store.js` as it stood at the v1 baseline commit `66126e9`.
//
// WHY THIS FILE EXISTS. Two attack suites were written to compare the v2 core against "the ACTUAL
// v1 store (`src/js/store.js`, unmodified)". WP-3 (LZP-402) is the work package that modifies it,
// so after the retrofit that import measures v2 against v2 — a tautology, and every "the
// divergence closed" row goes red for a reason that has nothing to do with the behaviour under
// test.
//
// The oracle for "does v2 still behave like v1?" is v1, and v1 is a fixed set of bytes in the
// history of this repository. So it is vendored here rather than inferred from the shipping file.
// Nothing in it is edited: everything below the sentinel is byte-for-byte
// `git show 66126e9:src/js/store.js`, with ONLY the three relative import specifiers rewritten
// (`./x.js` → `../../src/js/x.js`) so the module resolves from this directory.
// `tests/attack/v1-frozen-store.test.js` re-derives exactly that from git on every run, so this
// copy cannot drift from the commit it claims to be.
//
// DO NOT "UPDATE" THIS FILE TO MATCH THE SHIPPING STORE. If a test that compares against it goes
// red, either the retrofit changed v1-visible behaviour (a defect) or the divergence is deliberate
// and the test row says so in its own title. Both are conversations, not edits to the oracle.
//
// TIER 1 DOES NOT USE THIS FILE, and must not: `suite-integrity.test.js` requires every tier-1
// import of app code to point at the real `src/`, which is the right rule. The one tier-1 test
// that needed v1's `migrate()` reaches the real exported one instead.
//
// It depends on `dates.js`, `palette.js` and `storage.js`. WP-3 left all three behaviourally
// unchanged for these purposes — `storage.js` gained the five op-log functions and touched none of
// the six this file calls.
// ─────────────────────────────────────────────────────────────────────────────

// ==== VENDORED BODY BEGINS — everything below is 66126e9:src/js/store.js ====
// The whole board lives here: state, undo, autosave, snapshots.
// "Nothing is ever lost" (principle 6) is enforced at this layer, not by
// discipline further up — every content change goes through mutate().

import { todayISO, monthKeyOf } from '../../src/js/dates.js';
import { nextFreeRef } from '../../src/js/palette.js';
import * as storage from '../../src/js/storage.js';

export const SCHEMA_VERSION = 1;
const UNDO_LIMIT = 50;
const SNAPSHOT_LIMIT = 7;
const SAVE_DEBOUNCE = 700;

export const uid = () =>
  (crypto.randomUUID?.() ??
    `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

export function defaultState() {
  const cats = [
    { id: uid(), name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true },
    { id: uid(), name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: true },
    { id: uid(), name: 'Reisen', nameEn: 'Travel', paletteRef: 'orange', visible: true },
    { id: uid(), name: 'Deadlines', nameEn: 'Deadlines', paletteRef: 'magenta', visible: true },
  ];
  const t = todayISO();
  return {
    schemaVersion: SCHEMA_VERSION,
    notes: [],
    bars: [],
    categories: cats,
    scratchpads: {},
    settings: {
      bundesland: '',
      layers: {
        feiertage: true,
        // 7.5 — off until a Bundesland exists; flipped on automatically when
        // one is first chosen (settings.js). Shipping it "on" with no state
        // showed a pressed toggle that shaded nothing.
        schulferien: false,
        otherStates: false,
        ferienPattern: false,
      },
      mode: 'rolling',
      startMonth: monthKeyOf(t),
      pageYears: 0,
      language: 'de',
      launchAtLogin: false,
      menuBarIcon: true,
      rowHeight: 22,
      colWidth: 118,
      paper: 'a4',
      lastCategoryId: cats[0].id,
      seenFirstRun: false,
    },
  };
}

// ── migration ────────────────────────────────────────────────────────────────
// 11.6: the file carries a schema version and newer app versions migrate it.
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return defaultState();
  let s = raw;
  const v = s.schemaVersion ?? 0;
  if (v > SCHEMA_VERSION) {
    console.warn('[store] file is newer than this app; loading defensively');
  }
  // v0 → v1: earliest internal builds had no scratchpads map / layer object.
  const d = defaultState();
  s = {
    schemaVersion: SCHEMA_VERSION,
    notes: Array.isArray(s.notes) ? s.notes : [],
    bars: Array.isArray(s.bars) ? s.bars : [],
    categories:
      Array.isArray(s.categories) && s.categories.length ? s.categories : d.categories,
    scratchpads: s.scratchpads && typeof s.scratchpads === 'object' ? s.scratchpads : {},
    settings: {
      ...d.settings,
      ...(s.settings || {}),
      layers: { ...d.settings.layers, ...((s.settings || {}).layers || {}) },
    },
  };
  // Repair references so a hand-edited file can never orphan an entry.
  const ids = new Set(s.categories.map((c) => c.id));
  const fallback = s.categories[0].id;
  for (const n of s.notes) if (!ids.has(n.categoryId)) n.categoryId = fallback;
  for (const b of s.bars) if (!ids.has(b.categoryId)) b.categoryId = fallback;
  if (!ids.has(s.settings.lastCategoryId)) s.settings.lastCategoryId = fallback;
  for (const c of s.categories) if (!c.paletteRef) c.paletteRef = nextFreeRef([]);
  // 7.5 — a Ferien layer without a Bundesland cannot mean anything; normalise
  // boards written before the default changed.
  if (!s.settings.bundesland) s.settings.layers.schulferien = false;
  return s;
}

// ── store ────────────────────────────────────────────────────────────────────

const CONTENT_KEYS = ['notes', 'bars', 'categories', 'scratchpads'];

class Store {
  constructor() {
    this.state = defaultState();
    this.undoStack = [];
    this.redoStack = [];
    this.snapshots = [];
    this.listeners = new Set();
    this._saveTimer = null;
    this._lastSnapshotDay = null;
    this.ready = false;
  }

  async init() {
    const loaded = await storage.loadBoard();
    this.state = migrate(loaded ?? defaultState());
    if (!loaded) this.state.settings.seenFirstRun = false;
    this.snapshots = (await storage.loadSnapshots()) || [];
    this._lastSnapshotDay = this.snapshots[0]?.day ?? null;
    // What was on disk when the app opened. This — not the edited state — is
    // what the day's snapshot has to preserve.
    this._persisted = structuredClone(this.state);
    this.ready = true;
    this.emit('init');
  }

  // ── subscription ───────────────────────────────────────────────────────────
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(reason) {
    for (const fn of this.listeners) fn(this.state, reason);
  }

  // ── undo-aware mutation ────────────────────────────────────────────────────
  _contentClone() {
    const o = {};
    for (const k of CONTENT_KEYS) o[k] = structuredClone(this.state[k]);
    return o;
  }
  _applyContent(snap) {
    for (const k of CONTENT_KEYS) this.state[k] = structuredClone(snap[k]);
  }

  /**
   * Every content change goes through here. `fn` mutates state in place;
   * the pre-image is what ⌘Z restores.
   */
  mutate(label, fn) {
    const before = this._contentClone();
    const r = fn(this.state);
    if (r === false) return r; // fn declined — don't pollute the undo stack
    this.undoStack.push({ label, snap: before });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.schedulePersist();
    this.emit(label);
    return r;
  }

  /** Settings are configuration, not board content — not undoable (spec 5.4). */
  setSettings(patch) {
    Object.assign(this.state.settings, patch);
    this.schedulePersist();
    this.emit('settings');
  }
  setLayer(patch) {
    Object.assign(this.state.settings.layers, patch);
    this.schedulePersist();
    this.emit('settings');
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return false;
    this.redoStack.push({ label: e.label, snap: this._contentClone() });
    this._applyContent(e.snap);
    this.schedulePersist();
    this.emit('undo');
    return true;
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return false;
    this.undoStack.push({ label: e.label, snap: this._contentClone() });
    this._applyContent(e.snap);
    this.schedulePersist();
    this.emit('redo');
    return true;
  }

  /** Import replaces everything and clears history (spec 5.4: excluded). */
  replaceAll(next) {
    this.state = migrate(next);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.persistNow();
    this.emit('replace');
  }

  // ── persistence ────────────────────────────────────────────────────────────
  schedulePersist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.persistNow(), SAVE_DEBOUNCE);
  }

  async persistNow() {
    clearTimeout(this._saveTimer);
    await this.rollSnapshot();
    await storage.saveBoard(this.state);
    this._persisted = structuredClone(this.state);
  }

  /** Synchronous last-chance write for pagehide/beforeunload. */
  flushSync() {
    if (!this.ready) return;
    clearTimeout(this._saveTimer);
    if (storage.isTauri()) { this.persistNow(); return; }
    storage.saveBoardSync(this.state);
  }

  /**
   * 11.5 — one snapshot per calendar day, last 7 kept. It stores the *last
   * persisted* board, i.e. the state before today's first write. Snapshotting
   * the edited state instead would make "restore yesterday" return the very
   * change you wanted to undo.
   */
  async rollSnapshot() {
    const day = todayISO();
    if (this._lastSnapshotDay === day) return;
    this._lastSnapshotDay = day;
    this.snapshots.unshift({
      day,
      at: new Date().toISOString(),
      state: structuredClone(this._persisted || this.state),
    });
    this.snapshots = this.snapshots.slice(0, SNAPSHOT_LIMIT);
    await storage.saveSnapshots(this.snapshots);
  }

  listSnapshots() {
    return this.snapshots.map((s) => ({ day: s.day, at: s.at }));
  }
  restoreSnapshot(day) {
    const s = this.snapshots.find((x) => x.day === day);
    if (!s) return false;
    this.replaceAll(structuredClone(s.state));
    return true;
  }

  // ── export / import ────────────────────────────────────────────────────────
  exportJSON() {
    return JSON.stringify(this.state, null, 2);
  }
  exportFilename() {
    return `LangzeitPlaner-${todayISO()}.json`;
  }

  // ── derived helpers ────────────────────────────────────────────────────────
  category(id) {
    return this.state.categories.find((c) => c.id === id) || this.state.categories[0];
  }
  categoryVisible(id) {
    const c = this.state.categories.find((x) => x.id === id);
    return c ? c.visible !== false : true;
  }
  countEntriesIn(catId) {
    return (
      this.state.notes.filter((n) => n.categoryId === catId).length +
      this.state.bars.filter((b) => b.categoryId === catId).length
    );
  }

  /** 4.6 — a new entry can never vanish into a hidden category. */
  ensureVisible(catId) {
    const c = this.state.categories.find((x) => x.id === catId);
    if (!c || c.visible !== false) return false;
    c.visible = true;
    return true;
  }
}

export const store = new Store();
