// src/js/sync/status.js — WHAT „HEALTHY" IS ALLOWED TO MEAN.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// E5 shipped, M1 („Zwei Macs") was demonstrated over a real relay, and two adversaries then
// attacked it. They found no confidentiality break — 21.1 and 21.2 both held. What they found is
// that **the engine loses ops silently and reports `healthy` while doing it**, and the
// convergence adversary's second conclusion is the one that makes every other finding worse:
//
//   > the system has no way to tell the user, or us, that it has diverged.
//
// Story 19.3 says „Stille bedeutet Gesundheit" — silence is the design. That is a good design and
// it is a PROMISE, and the promise is not "the indicator is quiet". It is **"quiet means there is
// nothing to tell you"**. Today silence means only this:
//
//   `sync/personal.js:763`  state = 'healthy' unless (quarantined.size) or (5 failures) or
//                           (a 401/403/426) or (outboxSize() > 0 or offline).
//
// Two in-memory `Map`s and a counter. It cannot see a durably parked line (L-2), it forgets a
// terminal refusal the moment the process ends (L-1), it cannot see a line a compaction folded
// away unacknowledged (E5-2), and it has no fork detector at all because `sync/chain.js` is
// imported by nothing (P-4). In every one of those states both Macs say `healthy`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE METHOD — ENUMERATE THE DOMAIN, DO NOT NAME THE BRANCHES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Round 7's lesson closed 51 findings in one pass: enumerate the INPUT DOMAIN as data, before
// choosing a branch. Every fix in this area that named branches instead got relocated by the next
// adversary — and `status()` above is exactly a named-branch fix: four `if`s, each one a state
// somebody remembered.
//
// `tests/helpers/sync-domains.js` domain **S4** is that enumeration, and it is the contract. Its
// seven rows are "what the user and the system can observe", and each row carries the state it
// must produce, the `store.diagnostics()` field that must NAME it, and whether the answer must
// survive a relaunch. `SYNC_OBSERVABLES` below IS S4's table, transcribed into the product, and
// `judgeSyncStatus` is a fold over it rather than a chain of `if`s. Adding a failure state is
// adding a ROW; it can never again be adding a branch somebody forgets to add a report to.
//
// The consequence that matters is the direction of the default. `judgeSyncStatus` returns
// `healthy` only when EVERY row of the enumeration is empty. Silence is no longer "none of the
// four conditions I happened to check is true"; it is "the whole enumerated domain of things that
// can go wrong is empty". That is the only shape in which 19.3's promise is true, and it is why
// `silent` is returned as its own boolean: a caller can assert the promise rather than infer it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS NOT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// It is a LEAF: zero imports, no DOM, no clock, no network, no i18n. It is a pure function of two
// plain objects — the engine's own reading and `store.diagnostics()` — so the same judgement can
// be made by the engine (`sync/personal.js`'s `status()`), by the chrome
// (`family/syncstatus.js`), by a support bundle and by a test, and they cannot disagree. Nothing
// here decides what a state LOOKS like; `family/syncstatus.js` owns that, and 19.3's three rules
// (healthy is nothing, pending is one hollow ring, never a spinner) live there.
//
// It also does not invent a vocabulary. `field` is the exact path a fix must add to
// `store.diagnostics()`, and `row` is the exact `sync-domains.js` entry the field decides, so a
// green build and a red row cannot drift apart.

// ─────────────────────────────────────────────────────────────────────────────
// 1. The three states, and the one ordering that makes them foldable
// ─────────────────────────────────────────────────────────────────────────────

/** ADR 003 §8.3's `SyncState`. `healthy` is the absence of a glyph, not a green one. */
export const SYNC_STATE = Object.freeze({ healthy: 'healthy', pending: 'pending', error: 'error' });

/**
 * The ONE ordering. Merging two readings is `max`, and it is a max because the states form a
 * ladder of "how much is outstanding", not a set of alternatives: an engine that says `pending`
 * and a store that says `error` are both telling the truth, and the honest answer is the louder
 * one. A merge that took the engine's word (the shape `status()` has today) is precisely how a
 * durable park ends up reported as `healthy`.
 */
export const SYNC_STATE_RANK = Object.freeze({ healthy: 0, pending: 1, error: 2 });

/** @param {...string} states @returns {string} the loudest of them, defaulting to `healthy`. */
export function worstSyncState(...states) {
  let out = SYNC_STATE.healthy;
  for (const s of states) {
    const r = SYNC_STATE_RANK[s];
    if (r !== undefined && r > SYNC_STATE_RANK[out]) out = s;
  }
  return out;
}

/**
 * `sync.contract.js` §4's `errorKind` domain, mirrored (nothing under `src/` may import from
 * `docs/`). Every kind has a sentence in `i18n.js`; a `null` kind is the generic sentence, which
 * is the right answer for a fault the vocabulary has no word for yet — better a true generic
 * sentence than a false specific one.
 */
export const SYNC_ERROR_KINDS = Object.freeze(
  ['offline', 'auth', 'protocol', 'quarantine', 'decrypt', 'clockSkew']
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE ENUMERATION — sync-domains.js domain S4, transcribed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SyncObservable
 * @property {string} id      stable; quote it in a fix, a commit, a row.
 * @property {string} field   the `store.diagnostics()` key that carries it. `'outbox'` and
 *   `'warnings'` already exist; `parked`, `refused`, `lost` and `chain` are what S4 requires and
 *   `store.diagnostics()` now supplies.
 * @property {'sync'|'root'} at  WHERE the field lives — under `diagnostics().sync`, or at the top
 *   of `diagnostics()` itself. Recorded per row rather than special-cased in the reader, because
 *   the reader special-casing ONE top-level field (`warnings`) is what made a second one
 *   (`quarantine`) unreachable for a whole round — R8-8.
 * @property {'count'|'flag'|'list'} shape  how the field reports "present".
 * @property {string} state   the `SYNC_STATE` this observable forces AT LEAST. Never lower.
 * @property {?string} errorKind  the i18n sentence to prefer, or null for the generic one.
 * @property {boolean} durable  must the answer survive a quit-and-relaunch? True for all seven —
 *   it is the whole point — and recorded per row so a partial fix is legible as a partial fix.
 * @property {string} row     the `tests/helpers/sync-domains.js` S4 entry this decides.
 * @property {string} why     one line, for a failure report and for the next reader.
 */

/**
 * S4's rows, minus the two controls (`S4-quiet` is the empty case, and it is the DEFAULT of the
 * fold rather than a row — which is the only way silence stays free).
 *
 * ORDER IS SIGNIFICANT and it is the order `tests/property/sync-domains.test.js`'s
 * `storeReportsOf` reads the fields in: the first present observable is the one a one-line report
 * names. It runs strongest-evidence-first — a held op is a specific line you can point at, a
 * warning is a sentence — so the report is as sharp as the evidence allows.
 *
 * `quarantine` (R8-8) is FIRST, ahead of every sharp row, because it is the row that says the
 * evidence the others are reading has itself been refused by this launch. When it is present the
 * honest one-line report is not "one op was refused"; it is "this Mac does not trust its own
 * history", and the rows below are answering off a record that has just been thrown away.
 */
export const SYNC_OBSERVABLES = Object.freeze([
  Object.freeze({
    id: 'quarantine',
    field: 'quarantine',
    at: 'root',
    shape: 'flag',
    // ── WHY THIS ROW IS `healthy` — THE SAME ARGUMENT `warnings` MAKES, AND THE CONTROL ──────
    //
    // A quarantine is ADR 006 §9.3's "a VISIBLE, REPORTED, CONVERGING event, never a quiet one",
    // and the operative word for the INDICATOR is `converging`: the log is moved aside, the board
    // is intact and authoritative, the Mac re-publishes, and the family ends up agreeing. Nothing
    // failed that the person can act on. `tests/fleet/attack-converge-rejoin.test.js` §2 pins
    // exactly that — "the INDICATOR stays quiet, deliberately" — and it is one of the controls
    // against the failure round 8 walked into in the other direction: a fix that shows a fault
    // for ever. Making this row `error` was MEASURED turning that control red.
    //
    // It still counts, and that is the whole of R8-8. A present row makes `silent` false, puts
    // the state in `observables` for the settings sheet, and — the part that matters — makes the
    // claim SHARP: before this row, the only thing keeping a quarantined launch from asserting
    // 19.3's promise was somebody having written a sentence into the mixed `warnings` prose
    // channel. "There is nothing to tell you" may not rest on that.
    //
    // ⚠ THE LOUD HALF IS NOT THIS FILE'S. What round 8 measured was a quarantine ERASING the
    // durable refusal ledger: `store.js` restores `syncRefusals` only from the checkpoint it
    // adopted, so `sync.refused` drops from 1 to 0 and the permanent divergence L-1 exists to
    // remember stops being reportable. That is a loss of EVIDENCE, and it is `store.js`'s to
    // preserve — the honest signal for it would be `diagnostics().quarantine` saying what the
    // quarantine discarded, at which point this row can distinguish a converging re-join from a
    // launch that threw a divergence record away, and be `error` for the second. Reported, not
    // guessed at: a row that lit for every quarantine would break the control above.
    state: SYNC_STATE.healthy,
    errorKind: 'quarantine',
    durable: true,
    row: 'S4-untrusted',
    // ── R8-8 · THE LOUDEST THING THAT CAN HAPPEN TO A LOG, AND IT WAS NOT A ROW ──────────────
    //
    // FIRST in the enumeration, and that is the finding stated as an ordering. A quarantine is not
    // one held line or one refused op — it is the app having decided it cannot trust its OWN
    // HISTORY, refusing the checkpoint and rebuilding from `board.json` alone. Round 8 measured
    // what that costs the rows below it: `store.js` restores the durable refusal ledger only from
    // the checkpoint it ADOPTED, so a quarantine takes `sync.refused` to zero with it, and the
    // one permanent divergence L-1 exists to remember stops being reportable at the exact moment
    // the app is least able to vouch for itself. Every sharp row underneath can be zeroed this
    // way; this row cannot, because it IS the zeroing.
    //
    // It is bounded and therefore not the "reports errors for ever" failure `S4-quiet` guards
    // against: `store.init()` nulls `this.quarantine` on every launch and only a launch that
    // refuses its log again sets it. A log moved aside is a clean next launch and silence returns.
    why: 'this launch refused its own op log — `store.diagnostics().quarantine` is non-null. The '
      + 'board is intact (ADR 006: `board.json` is the content authority) and nothing the user can '
      + 'see is wrong, which is exactly why it must be SAID: the history, the cursors, the parked '
      + 'lines and the durable refusal ledger are all gone with it, so every other row in this '
      + 'enumeration is answering from a record this launch has just declared untrustworthy.',
  }),
  Object.freeze({
    id: 'parked',
    field: 'parked',
    at: 'sync',
    shape: 'count',
    state: SYNC_STATE.pending,
    errorKind: null,
    durable: true,
    row: 'S4-held',
    why: 'an op is HELD — parked with its reason, durably, waiting for an attestation, a key, a '
      + 'pairing or an app update. `pending` and not `error`: a held op is not a fault, it is work '
      + 'outstanding, exactly like an unacknowledged outbox line. It must be VISIBLE (L-2).',
  }),
  Object.freeze({
    id: 'refused',
    field: 'refused',
    at: 'sync',
    shape: 'count',
    state: SYNC_STATE.error,
    errorKind: 'quarantine',
    durable: true,
    row: 'S4-refused',
    why: 'an op was terminally refused — a bad signature, a failed AEAD, a malformed envelope. '
      + 'The refusal is CORRECT; the record of it is what L-1 is about. ADR 003 §8.2 releases the '
      + 'cursor past it, so the relay will never offer it again and this record is the only thing '
      + 'left. It may not die with the session.',
  }),
  Object.freeze({
    id: 'lost',
    field: 'lost',
    at: 'sync',
    shape: 'count',
    state: SYNC_STATE.error,
    errorKind: null,
    durable: true,
    row: 'S4-lost',
    why: 'an unacknowledged line was folded away by a compaction (E5-2). The board keeps the '
      + 'value, so nothing is lost to the user ON THIS MAC — but the other Mac will never see it, '
      + 'and the app cannot recover the DATA. It can and must recover the FACT.',
  }),
  Object.freeze({
    id: 'chain',
    field: 'chain',
    at: 'sync',
    shape: 'flag',
    state: SYNC_STATE.error,
    errorKind: null,
    durable: true,
    row: 'S4-diverged',
    why: 'ADR 002 §5.4 chain-witness verification failed, or the digests forked. This is the ONE '
      + 'mechanism the design names for detecting a relay that withholds, reorders or renumbers, '
      + 'and `sync/chain.js` is imported by nothing in `src/` (P-4), so today a fork is '
      + 'undetectable by construction.',
  }),
  Object.freeze({
    id: 'outbox',
    field: 'outbox',
    at: 'sync',
    shape: 'count',
    state: SYNC_STATE.pending,
    errorKind: null,
    durable: true,
    row: 'S4-pending',
    why: 'CONTROL, and the one observable that already survives a relaunch properly: the outbox '
      + 'is DERIVED from the lines, and the lines are on disk. It is enumerated here so that the '
      + 'fold has a row it is known to get right.',
  }),
  Object.freeze({
    id: 'warnings',
    field: 'warnings',
    at: 'root',
    shape: 'list',
    // ── THE ONE OBSERVABLE THAT DOES NOT RAISE THE INDICATOR, AND WHY ────────────────────────
    //
    // `store.warnings` is a MIXED PROSE CHANNEL. `_warn` fires for a refusal and a quarantine —
    // faults — and equally for a reconciliation after a crash ("expected", in its own text), a
    // §9.3 re-join ("nothing is lost and nothing on your peers is deleted"), a settings repair,
    // and `unparkAttested`'s "held ops are now authorised and have been applied", which is the
    // sound of a fix WORKING. Folding all of that into `error` was measured turning three green
    // rows red — `S3-parked` after its cure, `attack-converge-rejoin` §2, and every launch that
    // reconciles — and a build that shows a fault whenever it has anything to say breaks story
    // 19.3 in the other direction, which is exactly what `S4-quiet` and `S4-pending` are the
    // controls against.
    //
    // So it stays `healthy` and still COUNTS: a non-empty channel puts a row in `observables`,
    // which makes `silent` false and hands the settings sheet the sentences. The distinction is
    // the one this module exists for — "there is nothing to tell you" is not the same claim as
    // "the indicator is quiet", and only the SHARP rows above (a parked line, a refusal, a lost
    // line, a forked chain) are evidence sharp enough to light it.
    state: SYNC_STATE.healthy,
    errorKind: null,
    durable: true,
    row: 'S4-warnings',
    why: 'everything this layer wrote down about what it could not do (F-8). `_warn` already '
      + 'fires for every refusal, every park, every coercion and every quarantine, and '
      + '`subscribeWarnings()` is already the seam. Two things were missing: nothing SUBSCRIBED, '
      + 'and `init()` empties the array before anything could.',
  }),
]);

/**
 * The four fields a fix has to ADD to `store.diagnostics().sync`, in the product's own
 * vocabulary. Exported so the store seam and this enumeration cannot drift: a field renamed on
 * one side and not the other is a test failure, not a silent `undefined` that reads as healthy.
 *
 * `quarantine` is not in this list and does not need to be: it is a TOP-LEVEL field `store.js`
 * has always published. R8-8 was never a missing field — it was a missing ROW.
 */
export const SYNC_DIAGNOSTIC_FIELDS = Object.freeze(['parked', 'refused', 'lost', 'chain']);

/** Every field this module reads, `sync`-scoped and root-scoped alike, in enumeration order. */
export const SYNC_OBSERVABLE_FIELDS = Object.freeze(SYNC_OBSERVABLES.map((o) => o.field));

// ─────────────────────────────────────────────────────────────────────────────
// 3. Reading the enumeration off a diagnostics blob
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the row says its field lives. `at: 'root'` reads the top of `diagnostics()`, `'sync'`
 * reads `diagnostics().sync`.
 *
 * THIS USED TO BE `if (field === 'warnings')`, and R8-8 is what that cost: the ONE top-level
 * field anybody had thought of was hard-coded here, so the second one — `quarantine`, the state
 * in which the app has refused its own history — could not be enumerated at all. A row now
 * carries its own scope, which is the same rule the rest of this module lives by: the domain is
 * data, and reading it is a fold, not a branch somebody has to remember to extend.
 */
function fieldValue(diag, obs) {
  if (!diag || typeof diag !== 'object') return undefined;
  if (obs.at === 'root') return diag[obs.field];
  const s = diag.sync;
  return s && typeof s === 'object' ? s[obs.field] : undefined;
}

/**
 * How many of this observable there are. `undefined` — the field is not there at all, which is
 * what an OLD store or a partial fix looks like — is reported as `null` and NOT as zero.
 *
 * THE DISTINCTION IS THE FINDING. A missing field means "nobody can answer this question", and
 * folding that into `0` is precisely the move that turns "I cannot see a parked op" into
 * "there are no parked ops" — L-2 in one line of arithmetic. `unknown` below carries it out.
 *
 * @returns {{count:number, unknown:boolean}}
 */
function presenceOf(obs, diag) {
  const v = fieldValue(diag, obs);
  if (v === undefined) return { count: 0, unknown: true };
  if (obs.shape === 'list') return { count: Array.isArray(v) ? v.length : 0, unknown: false };
  if (obs.shape === 'flag') return { count: v === null || v === false ? 0 : 1, unknown: false };
  return { count: Number.isFinite(v) && v > 0 ? v : 0, unknown: false };
}

/**
 * Walk the whole enumeration over one `store.diagnostics()` blob.
 *
 * TOTAL by construction: every row is visited, every row reports, and a row whose field is absent
 * says so rather than saying nothing. Returns the rows that are PRESENT, in enumeration order.
 *
 * @param {Object} diagnostics `store.diagnostics()`
 * @returns {ReadonlyArray<{id:string, field:string, count:number, state:string,
 *   errorKind:?string, row:string, why:string}>}
 */
export function observeSync(diagnostics) {
  const out = [];
  for (const obs of SYNC_OBSERVABLES) {
    const { count, unknown } = presenceOf(obs, diagnostics);
    if (unknown || count <= 0) continue;
    out.push(Object.freeze({
      id: obs.id, field: obs.field, count, state: obs.state,
      errorKind: obs.errorKind, row: obs.row, why: obs.why,
    }));
  }
  return Object.freeze(out);
}

/**
 * The rows this build cannot answer at all — the fields `store.diagnostics()` does not carry.
 *
 * A build with an unanswerable row MAY NOT claim silence, and `judgeSyncStatus` does not: it
 * returns `silent: false` while any row is blind. That is the difference between "there is
 * nothing to tell you" and "I have not looked", and 19.3 promises the first.
 *
 * @param {Object} diagnostics @returns {ReadonlyArray<string>} observable ids, in enumeration order
 */
export function blindSpots(diagnostics) {
  const out = [];
  for (const obs of SYNC_OBSERVABLES) if (presenceOf(obs, diagnostics).unknown) out.push(obs.id);
  return Object.freeze(out);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The judgement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge the engine's own reading with the durable evidence in the store, and say plainly whether
 * silence is earned.
 *
 * @param {{engine?:Object, diagnostics?:Object}} input
 *   `engine` — whatever `sync.status()` returned, or null/undefined in solo mode. Its `state`,
 *   `errorKind` and counters are respected and never lowered; this function only ever ADDS.
 *   `diagnostics` — `store.diagnostics()`, or null when there is no store to ask.
 * @returns {{state:string, errorKind:?string, detail:?string, pendingOps:number,
 *   consecutiveFailures:number, lastPullAt:?number, observables:ReadonlyArray<Object>,
 *   blind:ReadonlyArray<string>, silent:boolean}}
 */
export function judgeSyncStatus({ engine = null, diagnostics = null } = {}) {
  const e = engine && typeof engine === 'object' ? engine : {};
  const engineState = SYNC_STATE_RANK[e.state] === undefined ? SYNC_STATE.healthy : e.state;

  const observables = observeSync(diagnostics);
  const blind = blindSpots(diagnostics);

  let state = engineState;
  for (const o of observables) state = worstSyncState(state, o.state);

  // The kind, and the rule for choosing between two of them: THE ENGINE WINS. It saw the failure
  // happen and can name the transport reason (`auth`, `protocol`, `offline`); the enumeration
  // only knows what is left over afterwards. The enumeration supplies a kind only when the engine
  // has none and the state it forced is `error` — which is exactly the L-1/E5-2/P-4 case, where
  // the engine is saying `healthy` and the evidence is on disk.
  let errorKind = SYNC_ERROR_KINDS.includes(e.errorKind) ? e.errorKind : null;
  if (state === SYNC_STATE.error && errorKind === null) {
    for (const o of observables) {
      if (o.state === SYNC_STATE.error && SYNC_ERROR_KINDS.includes(o.errorKind)) {
        errorKind = o.errorKind;
        break;
      }
    }
  }

  return Object.freeze({
    state,
    errorKind,
    detail: typeof e.detail === 'string' && e.detail ? e.detail : null,
    pendingOps: Number.isFinite(e.pendingOps) ? e.pendingOps : 0,
    consecutiveFailures: Number.isFinite(e.consecutiveFailures) ? e.consecutiveFailures : 0,
    lastPullAt: Number.isFinite(e.lastPullAt) ? e.lastPullAt : null,
    observables,
    blind,
    /**
     * 19.3's promise, as a boolean. TRUE only when the state is healthy AND the whole enumerated
     * domain is empty AND every row of it could actually be answered. A build that cannot see one
     * of the seven is not silent; it is uninformed, and it says so.
     */
    silent: state === SYNC_STATE.healthy && observables.length === 0 && blind.length === 0,
  });
}
