// Minimal browser-shaped globals for tier 1 (node --test). Zero dependencies.
//
// HONESTY NOTE — this shim is deliberately tiny. It provides exactly two things
// the v1 source actually reaches for and Node does not have:
//
//   1. `localStorage`  — storage.js calls it bare (no typeof guard) in
//      loadBoard / saveBoard / saveBoardSync / loadSnapshots / saveSnapshots.
//      Without it those five functions throw ReferenceError under Node.
//   2. `window`        — storage.js reads `window.__TAURI__` behind a
//      `typeof window !== 'undefined'` guard, so it *tolerates* window being
//      absent. We still define it, without __TAURI__, so that the branch under
//      test is the one a plain browser takes, explicitly rather than by
//      accident. That is the whole point: v1's browser branch is the branch
//      that must stay green when LZP-402 rewrites the store.
//
// Everything else the pure modules use — crypto.randomUUID, structuredClone,
// setTimeout/clearTimeout, Map/Set/Intl-free date math — is a real Node 22
// global. We assert that below instead of shimming it, so a Node downgrade
// fails loudly rather than silently testing a stand-in.
//
// There is NO document here on purpose. A module that needs `document` is
// DOM-COUPLED and belongs in tier 2 (real WKWebView), not in a fake DOM.

for (const g of ['crypto', 'structuredClone', 'setTimeout', 'queueMicrotask']) {
  if (typeof globalThis[g] === 'undefined') {
    throw new Error(
      `tests/helpers/env.js: Node is missing global "${g}". ` +
      'Tier 1 assumes Node >= 18 (developed on v22). Refusing to shim it — ' +
      'that would mean testing the shim instead of the app.'
    );
  }
}
if (typeof globalThis.crypto.randomUUID !== 'function') {
  throw new Error('tests/helpers/env.js: crypto.randomUUID missing; store.uid() would silently take its fallback branch.');
}

/** A localStorage stand-in with the real Storage semantics v1 depends on:
 *  string coercion, `null` (not undefined) for a missing key. */
class MemoryStorage {
  #map = new Map();
  get length() { return this.#map.size; }
  key(i) { return [...this.#map.keys()][i] ?? null; }
  getItem(k) { return this.#map.has(String(k)) ? this.#map.get(String(k)) : null; }
  setItem(k, v) { this.#map.set(String(k), String(v)); }
  removeItem(k) { this.#map.delete(String(k)); }
  clear() { this.#map.clear(); }
  /** test-only introspection, not part of the Storage interface */
  _keys() { return [...this.#map.keys()]; }
}

export const localStorage = new MemoryStorage();

// A window object that is emphatically NOT Tauri. storage.isTauri() must be
// false here; that is asserted in tests/tier1/store-storage.test.js so this
// assumption can never rot silently.
const windowStub = {
  localStorage,
  // no __TAURI__ — browser branch
};

if (!Object.prototype.hasOwnProperty.call(globalThis, 'window')) {
  globalThis.window = windowStub;
}
if (!Object.prototype.hasOwnProperty.call(globalThis, 'localStorage')) {
  globalThis.localStorage = localStorage;
}

/** Wipe persisted board/snapshot state between tests. */
export function resetStorage() {
  localStorage.clear();
}

/** Seed the browser-branch store keys directly, the way v1 writes them. */
export function seedBoard(state) {
  localStorage.setItem('langzeitplaner.board', JSON.stringify(state, null, 2));
}
export function seedSnapshots(list) {
  localStorage.setItem('langzeitplaner.snapshots', JSON.stringify(list));
}
export function readBoardRaw() {
  return localStorage.getItem('langzeitplaner.board');
}
