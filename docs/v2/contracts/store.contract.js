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
 * @property {UndoStackView} undoStack                       [v1 shape, DIVERGENT — see F-3 below]
 * @property {UndoStackView} redoStack                       [v1 shape, DIVERGENT — see F-3 below]
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
 *
 * // ── the warnings channel (F-8) ─────────────────────────────────────────────
 * @property {string[]} warnings                             STABLE IDENTITY for the store's life
 * @property {() => void} clearWarnings                      empties IN PLACE; never reassigns
 * @property {(fn:(w:string)=>void) => (()=>void)} subscribeWarnings   per warning, not per batch
 * @property {() => StoreDiagnostics} diagnostics
 * @property {?StoreQuarantine} quarantine                   null unless init() refused an op log
 */

/**
 * F-3 — `undoStack` / `redoStack` ARE NOT ARRAYS, and the divergence is recorded here because it
 * is invisible at the call site. v1 exposed two real arrays; v2 exposes a view over the group
 * stacks in `undo.js`, because a v1 array entry has no op-log meaning.
 *
 *   · `.length` READS the group depth (v1: op depth — 5.4's "~50 steps" is now 50 GROUPS).
 *   · `.length = 0` clears BOTH stacks, not just this one. There is one stack pair and one
 *     clear; `store.undoStack.length = 0` is the v1 idiom for "forget the history" and that is
 *     what it does. Setting it to any OTHER number is a silent no-op.
 *   · `.push(entry)` is ACCEPTED AND IGNORED, returning the new depth. Nothing can be injected.
 *   · `.toJSON()` is the depth, so a `JSON.stringify(store)` in a debugger prints a number.
 *   · There is no `pop`, `slice`, `map`, or index access. A caller that reaches for one gets
 *     `undefined`, not a stale entry.
 *
 * No shipping caller reaches past `.length` and `.length = 0` (`main.js`, `settings.js`,
 * `backup.js` — checked). The tier-2 harnesses use `.length = 0` between gestures, which is the
 * idiom this view exists to keep working.
 *
 * @typedef {Object} UndoStackView
 * @property {number} length
 * @property {(entry:any) => number} push  accepted, ignored, returns the depth
 * @property {() => number} toJSON
 */

/**
 * @typedef {Object} StoreDiagnostics
 * @property {boolean} ready
 * @property {'board.json'|'op-log'} source   which of the two the board on screen came from
 * @property {string[]} warnings              a copy — mutating it does not touch the channel
 * @property {?StoreQuarantine} quarantine
 */

/**
 * What `init()` refused, kept for a rescue pass and for the UI. The files themselves are LEFT ON
 * DISK, unmodified — see `store.js:_quarantineLog`'s three promises.
 * @typedef {Object} StoreQuarantine
 * @property {string} at
 * @property {'no-provenance'|'unrelated-log'|'unreadable-log'} reason
 * @property {string} detail                  prose, already user-facing
 * @property {?number} checkpointHorizon
 * @property {number} tailLines
 * @property {?Object} checkpoint
 * @property {string[]} tailSample
 */

/**
 * THE WARNINGS CHANNEL — normative, added 2026-08-27 with A3-H2 / A3-C1 / F-8.
 *
 * `warnings` is ONE array for the life of the store. Callers may hold it. `clearWarnings()`
 * empties it in place and `replaceAll()` APPENDS to it — the original `this.warnings =
 * plan.warnings` erased the session's whole report whenever an import happened to be clean, which
 * is precisely the launch on which the migration's report matters most.
 *
 * Everything the layer knows it changed or refused is on this channel and nowhere else:
 *   · every A3-H2 coercion, with the old value and the new one,
 *   · every field or entry either door dropped,
 *   · every op `applyRemote` refused, with the reason,
 *   · the op-log quarantine (A3-C1), also readable structurally via `diagnostics().quarantine`.
 *
 * F-8 IS NOT CLOSED BY THIS. The carrier exists and is durable; **no UI reads it** (WP-10). The
 * seam to wire is `subscribeWarnings(fn)` for live events and `diagnostics()` for the settings
 * pane; `diagnostics().quarantine` is what a "your op log was refused" notice should read.
 *
 * A listener that throws is caught and does not stop the other listeners or the store.
 * The channel is capped at `WARN_LIMIT` (1000) entries per session.
 */

/**
 * Replaces v1's `mutate(label, fn)`.
 *
 * SEMANTICS THAT MUST NOT CHANGE:
 *  1. `fn` returning `false` declines: no ops, no undo entry, no emit, no persist
 *     (store.js:150, verbatim — it already prevents 16 no-op mutations).
 *  2. Emitting zero ops is the same as declining.
 *     [WP-1] ⚠ THIS CONTRADICTS A V1 CHARACTERIZATION TEST AND SOMEONE MUST DECIDE IT IN WRITING
 *     BEFORE WP-3. `tests/tier1/store-persistence.test.js:501` ("only a strict `false` declines —
 *     other falsy returns still record a step") pins the OPPOSITE for v1: `store.mutate('x', () => 0)`
 *     records an undo step for a mutation that changed nothing. `undo.js` implements THIS rule and
 *     pins the divergence with its own test. WP-2's regression suite will hit it at that exact
 *     line; it is a deliberate change, not a regression.
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
