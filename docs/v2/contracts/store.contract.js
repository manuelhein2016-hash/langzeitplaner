// docs/v2/contracts/store.contract.js
//
// INTERFACE CONTRACT — the v1 store seam after LZP-402. Normative for ADR 005 §2.2.
// This is the compatibility contract board.js / find.js / print.js / legend.js / popover.js /
// settings.js / backup.js / main.js are written against. Everything below marked [v1] MUST keep
// its v1 name, signature and semantics. `mutate()` is the ONE deliberate break.

/* eslint-disable no-unused-vars */

/** @typedef {import('./ops.contract.js').Op} Op */
/** @typedef {import('./ops.contract.js').Tx} Tx */
/** @typedef {import('./ops.contract.js').RegisterMap} RegisterMap */

/**
 * @typedef {Object} StorePorts
 * @property {any} storage        defaults to src/js/storage.js; injectable so headless tests do
 *                                not hit the ReferenceError the debounced persistNow() throws
 * @property {() => number} now
 * @property {(ms:number, fn:Function) => any} schedule
 */

/**
 * @typedef {Object} Store
 *
 * // ── v1 surface, preserved verbatim ─────────────────────────────────────────
 * @property {Object} state                                  [v1] the materialized v1 shape
 * @property {boolean} ready                                 [v1]
 * @property {(fn:(state:Object, reason:string)=>void) => (()=>void)} subscribe  [v1]
 * @property {(reason:string) => void} emit                  [v1] SYNCHRONOUS
 * @property {() => Promise<void>} init                      [v1]
 * @property {() => boolean} undo                            [v1]
 * @property {() => boolean} redo                            [v1]
 * @property {() => boolean} canUndo                         [v1]
 * @property {() => boolean} canRedo                         [v1]
 * @property {(patch:Object) => void} setSettings            [v1] → a `pref.set` op, LOCAL space,
 *                                                            never undoable, NEVER SYNCED (17.7)
 * @property {(patch:Object) => void} setLayer               [v1] same
 * @property {(next:Object) => void} replaceAll              [v1] now a DIFF TXN (ADR 001 §8.5);
 *                                                            clears both stacks (story 5.4)
 * @property {(id:string) => Object} category                [v1]
 * @property {(id:string) => boolean} categoryVisible        [v1]
 * @property {(catId:string) => number} countEntriesIn       [v1]
 * @property {(catId:string) => boolean} ensureVisible       [v1] story 4.6
 * @property {() => Array<{day:string, at:string}>} listSnapshots   [v1]
 * @property {(day:string) => boolean} restoreSnapshot       [v1]
 * @property {() => string} exportJSON                       [v1]
 * @property {() => string} exportFilename                   [v1]
 * @property {() => void} schedulePersist                    [v1]
 * @property {() => Promise<void>} persistNow                [v1]
 * @property {() => void} flushSync                          [v1] must also flush the OUTBOX
 *
 * // ── v2 additions ───────────────────────────────────────────────────────────
 * @property {(label:string, fn:(tx:Tx)=>any) => any} txn
 * @property {(ops:Op[]) => void} applyRemote
 * @property {() => RegisterMap} registers
 * @property {Object} publisher                              derivePublication + outbox enqueue
 */

/**
 * Replaces v1's `mutate(label, fn)`.
 *
 * SEMANTICS THAT MUST NOT CHANGE:
 *  1. `fn` returning `false` declines: no ops, no undo entry, no emit, no persist
 *     (store.js:150, verbatim — it already prevents 16 no-op mutations).
 *  2. Emitting zero ops is the same as declining.
 *  3. txn → apply → materialize → emit() is STRICTLY SYNCHRONOUS. interact.js:317 queries the
 *     DOM for the freshly created bar's label element immediately after this returns; an `await`
 *     anywhere before emit() silently breaks bar-label editing. Sealing, the outbox and all
 *     network work happen in a queueMicrotask AFTER emit().
 *  4. The undo stack is bounded by 50 GROUPS, not 50 ops (story 5.4's "~50 steps").
 *  5. `tx.pref()` writes carry no gid and are never undone — v1 parity for
 *     settings.lastCategoryId, now by design rather than by accident.
 *  6. In DEV builds this additionally captures a v1-style content pre-image for the shadow-undo
 *     assertion (ADR 001 §7.1). `DEV` is a module constant — there is no build step in this
 *     project; the app is served as raw ES modules by dev-server.mjs and by the Swift
 *     WKURLSchemeHandler.
 *
 * @param {string} label @param {(tx:Tx)=>any} fn @returns {any}
 */
export function txn(label, fn) { throw new Error('not implemented'); }

/**
 * Apply ops received from a peer.
 * MUST NOT touch the undo stack, MUST NOT touch the redo stack, MUST NOT clear redo
 * (recon B2/B4 — this IS story 18.4, structurally). Its fold + emit are synchronous even though
 * the decrypt that produced `ops` was not.
 * @param {Op[]} ops @returns {void}
 */
export function applyRemote(ops) { throw new Error('not implemented'); }

/** @param {StorePorts} [ports] @returns {Store} */
export function createStore(ports) { throw new Error('not implemented'); }
