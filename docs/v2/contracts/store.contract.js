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
 * @property {(next:Object) => boolean} replaceAll           [v1 shape, DIVERGENT] now a DIFF TXN
 *                                                            (ADR 001 §8.5); clears both stacks
 *                                                            (5.4). RETURNS FALSE when the board
 *                                                            in the file cannot be drawn — see I-1
 *                                                            below; v1 returned undefined and
 *                                                            could not refuse.
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
 * // ── §2.2 ADDITIVE SURFACE — the reporting channel ──────────────────────────
 * //
 * // NORMATIVE, and additive: nothing below replaces a v1 name. Every one of these is READ-ONLY
 * // to callers except `clearWarnings()`. They are the only supported way to find out how the
 * // board on screen came to be there, and `diagnostics()` is the one a settings pane should use.
 * //
 * @property {string[]} warnings                             F-8. ONE array for the store's life —
 *                                                            callers may hold it; `init()` and
 *                                                            `replaceAll()` empty/append IN PLACE
 *                                                            and never reassign. Capped at 1000.
 * @property {() => void} clearWarnings                      empties IN PLACE; never reassigns
 * @property {(fn:(w:string, all:string[])=>void) => (()=>void)} subscribeWarnings
 *                                                            fires once per warning, synchronously;
 *                                                            the return value unsubscribes; a
 *                                                            listener that throws is caught and
 *                                                            cannot take the store down
 * @property {() => StoreDiagnostics} diagnostics            a fresh object every call; the
 *                                                            `warnings` inside it is a COPY
 * @property {?StoreQuarantine} quarantine                   null unless init() refused an op log
 * @property {?StoreBootFailure} bootFailure                 null unless the board could not be
 *                                                            drawn, or could not be READ at all
 *                                                            — see I-2 below. While it is set the
 *                                                            session is READ-ONLY: `persistNow()`
 *                                                            and `flushSync()` return without
 *                                                            writing any file, and `init()` does
 *                                                            not sequester a quarantined log
 *                                                            either, so no file is even renamed.
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
 * @property {'board.json'|'op-log'|'recovery'} source
 *   WHERE THE HISTORY CAME FROM, not the content. Under ADR 006 `board.json` is ALWAYS the content
 *   authority, so this says what happened to the log beside it: `'op-log'` — a log bound to this
 *   board was adopted and its stamps survived; `'recovery'` — there was no readable `board.json`,
 *   so the log had to be the truth (R7) and the user is told; `'board.json'` — solo mode, or the
 *   log was quarantined.
 * @property {StoreLineage} lineage
 * @property {?StoreBootFailure} bootFailure
 * @property {?StoreRecoveredFrom} recoveredFrom
 *   null on an ordinary launch. Tells R7's genuine recovery apart from the read-only disaster
 *   boot that used to hide inside the same `source: 'recovery'` — see below.
 * @property {string[]} warnings              a copy — mutating it does not touch the channel
 * @property {?StoreQuarantine} quarantine
 */

/**
 * ADR 006 §4 — the binding that decides whether a log's history may be adopted.
 * @typedef {Object} StoreLineage
 * @property {?string} id          `lin_` + 128 bits, or null in solo mode, where no log is durable
 *                                 and `board.json` therefore carries no `_v2` at all
 * @property {number} gen          diagnostics ONLY; nothing branches on it, ever
 * @property {boolean} adopted     whether this launch adopted a log's history
 * @property {?boolean} exact      whether `lzp.boardHash` matched the bytes read (reporting only)
 * @property {?number} reconciled  how many changes `board.json` carried that the log did not.
 *                                 0 on an exact match — that is INV-4, and a non-zero number on
 *                                 a quiet launch means the reconciler has started churning.
 */

/**
 * What `init()` refused, kept for a rescue pass and for the UI.
 *
 * A QUARANTINE IS FIVE PROMISES (ADR 006 §7):
 *  1. NOT APPLIED   — the log's registers never reach `state`.
 *  2. NOT DELETED   — the bytes stay on disk. `movedAside` names where; a MOVE is the sanctioned
 *                     form of "refused once rather than once per launch" (I-6), never a delete.
 *  3. NOT OVERWRITTEN — `_opsPersisted` stays false for the session. WP-8 turning it on when a
 *                     space is created MUST consult `store.quarantine` first (ADR 006 §9.5).
 *  4. IT CANNOT COST CONTENT — not "does not", CANNOT: `state` is derived from `board.json`
 *                     before the log is read at all. Provable by construction (INV-15).
 *  5. THE REASON IS TRUE — the enum below names a fact, never a guess. `lzp.v` is never a reason.
 *
 * @typedef {Object} StoreQuarantine
 * @property {string} at
 * @property {'no-checkpoint'|'board-carries-no-lineage'|'log-carries-no-lineage'
 *           |'foreign-lineage'|'unreadable-log'|'board-unreadable'|'clock-skew'
 *           |'reconcile-failed'} reason
 *   `clock-skew` (ADR 006 §7.1, R5-2e): both files are this board's own and well formed, and this
 *   MACHINE's date is what makes the log unusable today — §12.6 cannot be satisfied above a stamp
 *   ADR 001 §1.3 refuses. It is the one DEFERRED reason: it is expected to stop being true, so the
 *   files keep their own names and the next launch reconsiders them.
 *   `board-unreadable` (ADR 006 §5.5, R5-3a/b/c): `board.json` EXISTS and could not be read, so it
 *   has no `_v2.lineageId` and there is nothing to compare the log against. A log is refused on
 *   the ABSENCE of a tie, never adopted on it — inferring the opposite from the same absence is
 *   what let a stranger's log be handed a board whose own file was one truncated byte short.
 *   This reason always travels with a `bootFailure`, so the session is read-only and — because
 *   `_sequesterQuarantine` is gated on `!bootFailure` — the refused bytes are NOT moved aside
 *   either: on a failed boot, every file keeps its own name.
 * @property {string} detail                  prose, already user-facing
 * @property {boolean} [deferred]             true only on a DEFERRED reason; the log was not moved
 * @property {?{ops:?string, checkpoint:?string}} movedAside
 *   where the refused bytes now live, or null when they were left in place (the native shell has
 *   no move-aside command yet; leaving them keeps every promise and costs one repeated warning)
 * @property {?number} checkpointHorizon
 * @property {number} tailLines
 * @property {?Object} checkpoint
 * @property {string[]} tailSample
 */

/**
 * I-2 / Finding 2 — THE APP ALWAYS BOOTS, AND ALWAYS SAYS WHAT IT REFUSED.
 *
 * `materialize` legitimately refuses a `settings` that would make `layout.js:25` produce a NaN
 * year and hang `holidays.js:51`. A refusal out of `init()` used to mean `ready === false` and a
 * white screen with an intact `board.json` sitting right there. `init()` now escalates: project
 * as-is → reset `mode`/`startMonth`/`pageYears` → reset every setting → open on an empty board and
 * REFUSE TO WRITE. Every step is reported on `warnings`; steps 2 and 3 touch SETTINGS ONLY, and no
 * note, bar, category or scratchpad is ever discarded to make a board drawable.
 *
 * `bootFailure` is set only at the last step, and while it is set no file is written at all — so
 * the board that could not be drawn is still the board on disk, for a rescue pass and for the next
 * build. `replaceAll()` runs the same escalation as a REHEARSAL on a throwaway log (I-1) and
 * returns `false` rather than blanking `state` when even that fails.
 *
 * ROUND 5 WIDENED `reason` FROM ONE VALUE TO FOUR (R5-3a/b/c). `unprojectable` means board.json
 * was READ and then refused to DRAW. The three `board-*` reasons mean the opposite: board.json
 * exists and was never read at all, so whether it draws is unknown and unknowable this launch.
 * They are a different event with different honest copy — see `readOnlyBecause()` in `store.js`
 * and the DE/EN strings in `_bootUnreadableBoard`'s docblock — and they must not be collapsed:
 * telling a user their file is broken when the app merely could not open it is the difference
 * between relaunching and giving up.
 *
 * FIRST REASON WINS. `_bootUnreadableBoard` runs before `_projectSafe`, so if the snapshot shown
 * in place of the unreadable board ALSO refuses to project, `reason` stays `board-*` and the
 * projection error is recorded beside it as `projectionFailure`. Read-only-ness does not depend
 * on the reason: it is `bootFailure` being non-null that gates `persistNow()` and `flushSync()`.
 *
 * @typedef {Object} StoreBootFailure
 * @property {string} at
 * @property {'unprojectable'|'board-unparseable'|'board-not-a-board'|'board-read-failed'} reason
 * @property {string} detail
 * @property {string} [projectionFailure]  set only when a `board-*` boot ALSO failed to project
 * @property {?{from:'snapshot'|'none', day:?string, at:?string}} [shownInstead]
 *   `board-*` only: what the app put on screen instead. The settings pane keys the „Angezeigt wird
 *   der letzte Schnappschuss vom <Tag>" half of the copy off this.
 * @property {boolean} [logPresent]
 *   `board-*` only: whether a log was lying beside the unreadable board. When true it was
 *   quarantined `board-unreadable` and the copy gains the sentence saying so.
 */

/**
 * WHAT THE BOARD ON SCREEN WAS BUILT FROM, when it was not built from `board.json`.
 *
 * `diagnostics().source` keeps its three documented values and cannot answer this: R7's genuine
 * recovery (no board file, a log adopted as the truth) and the read-only disaster boot (a board
 * file that exists and cannot be read, a snapshot standing in) both used to report `'recovery'`
 * and were indistinguishable. `recoveredFrom` is the field that tells them apart.
 *
 *   {from:'op-log'}   R7 — no `board.json`; the log was the truth and the boot is a recovery.
 *   {from:'snapshot'} the disaster boot — `board.json` exists, could not be read, and a
 *                     `snapshots.json` entry from `day` is standing in. Always with a
 *                     `bootFailure`, therefore always read-only.
 *   {from:'none'}     the disaster boot with no usable snapshot: an empty stand-in board.
 *
 * Null on an ordinary launch. `lineageId` is non-null only on `'op-log'`, where the recovered
 * board is written back carrying the checkpoint's lineage so the NEXT launch does not quarantine
 * and rename the only copy of the board it just rebuilt.
 *
 * @typedef {Object} StoreRecoveredFrom
 * @property {'op-log'|'snapshot'|'none'} from
 * @property {?string} day
 * @property {?string} at
 * @property {?string} lineageId
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
 *   · the op-log quarantine (A3-C1 / ADR 006), also readable structurally via
 *     `diagnostics().quarantine`,
 *   · every settings repair `init()` or `replaceAll()` had to make to draw the board (I-2 / I-1),
 *   · a recovery boot — `board.json` was missing and the board came out of the log (ADR 006 R7),
 *   · where a refused log was moved aside to, or why it could not be (I-6).
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
