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
// IT CARRIES EIGHT ROWS, NOT SEVEN. The eighth is `shelved`, and it is here rather than in S4
// because it is a state the product can enter that the domain has no row for yet — a hold that
// ENDED, with the bytes retained and nothing left that will ever open them. A state with no row
// is exactly what this enumeration exists to make impossible, so it is enumerated where the fold
// can see it, `S4-held` is named as the entry it belongs beside, and adding `S4-shelved` to
// `tests/helpers/sync-domains.js` is reported as work for that file's owner.
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
// plain objects and one duck-typed port — the engine's own reading, `store.diagnostics()`, and a
// parking lot that answers `shelved(space)` — so the same judgement can be made by the engine
// (`sync/personal.js`'s `status()`), by the chrome
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
 * @property {'sync'|'root'|'held'} at  WHERE the evidence lives — under `diagnostics().sync`, at
 *   the top of `diagnostics()` itself, or (`'held'`) handed in by the caller because the store
 *   cannot see it. Recorded per row rather than special-cased in the reader, because the reader
 *   special-casing ONE top-level field (`warnings`) is what made a second one (`quarantine`)
 *   unreachable for a whole round — R8-8.
 * @property {'count'|'flag'|'list'} shape  how the field reports "present".
 * @property {string} state   the `SYNC_STATE` this observable forces AT LEAST. Never lower.
 * @property {?string} errorKind  the i18n sentence to prefer, or null for the generic one.
 * @property {boolean} durable  must the answer survive a quit-and-relaunch? True for all eight —
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
    id: 'shelved',
    field: 'shelved',
    at: 'held',
    shape: 'list',
    // ── R10-9 · THE HOLD THAT ENDED, AND THE ONE ROW WHOSE EVIDENCE IS NOT IN THE BLOB ───────
    //
    // AHEAD OF `parked`, and the ordering is the finding. A parked envelope is a hold that is
    // still going: the next launch replays it, an attestation or a key can still cure it, and
    // `pending` is the honest state. A SHELVED envelope is the same envelope after the ladder
    // gave up — `outbox.js`'s `refuse()`/`release()` move it to the shelf past `PARK_REVIVALS`
    // launches, and from that moment nothing in the product will ever open it again. The bytes
    // are kept, deliberately ("a park may never become a drop"), and that retention is worth
    // exactly nothing while no reader exists: a change somebody in the family made is on this
    // Mac's disk, correctly stored, and the board will never show it.
    //
    // `error` and not `pending`, for the same reason `refused` is: there is no work outstanding
    // here. Nothing is being waited for. `errorKind: null` — the generic sentence — because the
    // vocabulary in `sync.contract.js` §4 has no word for "held, then given up on", and this
    // module's rule is that a true generic sentence beats a false specific one. Inventing a kind
    // here would also mean inventing an `i18n.js` string, and a row that cannot report until a
    // second file lands is a row that reports nothing.
    //
    // ── `at: 'held'` — WHY THIS ONE ROW IS FED BY A PORT AND NOT BY `diagnostics()` ──────────
    //
    // Every other row names a field `store.diagnostics()` publishes, so an ABSENT field means
    // "this build cannot answer the question" and `blindSpots()` says so out loud. The shelf has
    // no such field and cannot get one from here: the retained envelopes live in the ENGINE's
    // parking lot (`sync/outbox.js`, behind the `parkStore` port), which the store never sees —
    // `diagnostics().sync.parked` counts `_log.parkedOps()` and structurally cannot count the
    // lot's (R8-6b). So the caller reads the lot and hands the rows in, and `shelvedDetail()`
    // below is the one reader.
    //
    // ⚠ THE HONEST CAUTION, STATED RATHER THAN BURIED. An omitted `held` is NOT counted as
    // blindness, so a caller that never looks does not make `silent` false, and this row's
    // silence is therefore weaker than the other six. That is a real weakening and it is bounded
    // in two ways: `judgeSyncStatus` returns `unoffered`, which NAMES every row nobody handed
    // evidence for, and `round8-park.test.js` §7 asserts — now as an INVERTED row — which
    // callers in `src/` pass `held`. The obligation was `sync/personal.js`'s `status()`, and the
    // round-10 integration pass closed it: it already held the lot, and it now hands it in.
    state: SYNC_STATE.error,
    errorKind: null,
    durable: true,
    // ⬆ `S4-shelved`, AND IT USED TO SAY `S4-held`, WHICH IS A DIFFERENT STATE. `S4-held` is a
    // hold that is STILL GOING — `pending`, curable, replayed by the next launch. This row is the
    // same envelope after the ladder gave up. They were pointed at one entry only because the
    // enumeration had none for the second, which is the same defect one level up: a state the
    // product can enter and cannot name. `tests/helpers/sync-domains.js` now carries `S4-shelved`
    // and `tests/property/sync-domains.test.js` drives it through the real engine.
    row: 'S4-shelved',
    why: 'a held envelope was GIVEN UP ON and retained — past `PARK_REVIVALS` launches the '
      + 'parking lot stops replaying it and keeps the bytes (R8-4: a park may never become a '
      + 'drop). The retention is real and the recovery path is not: nothing opens it, no screen '
      + 'shows it, and the family change inside it will never reach this board until something '
      + 'reads the shelf. `outbox.js diagnostics().refused` counts them and a count is not a '
      + 'report — ADR 002 §8.6\'s detail pane is what this row hands its rows to.',
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

/**
 * Every field this module reads, `sync`-scoped, root-scoped and port-fed alike, in enumeration
 * order. `shelved` is in here and is deliberately NOT in `SYNC_DIAGNOSTIC_FIELDS` above: that
 * list is the store's contract, and `store.js` cannot answer for the engine's parking lot. A
 * `shelved` added there would be a field the store publishes as `0` for ever, which is the exact
 * arithmetic L-2 is about — "I cannot see it" written down as "there is none".
 */
export const SYNC_OBSERVABLE_FIELDS = Object.freeze(SYNC_OBSERVABLES.map((o) => o.field));

// ─────────────────────────────────────────────────────────────────────────────
// 2b. THE DETAIL PANE'S READER — ADR 002 §8.6
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the parking lot's SHELF: the envelopes a hold gave up on and did not destroy.
 *
 * ── WHY THIS FUNCTION EXISTS AT ALL ─────────────────────────────────────────────────────────
 *
 * `sync/outbox.js` retains those bytes on purpose and says so in its own words — *"That is not a
 * drop: the bytes are on disk, `diagnostics().refused` counts them, and `shelved()` hands them
 * back whole."* Round 10 measured the other half of that sentence: **`shelved()` had no caller
 * anywhere in `src/`.** The retention was real and the recovery path did not exist, so a change
 * from a family member sat on the disk, correctly kept, and no screen, no diagnostic and no
 * launch would ever surface it as anything but a number. That is the shape of every observability
 * finding in this project — R8-5 (a durably held op invisible while the build said `silent:
 * true`), R8-6 (`chain` declared `durable: true` and persisted nowhere), R8-8 (a log quarantine
 * erasing the refusal ledger and not itself an observable) — and it is closed the same way: by
 * something READING the state.
 *
 * ── WHAT IT MAY AND MAY NOT CARRY (21.3) ────────────────────────────────────────────────────
 *
 * The lot's own `shelved(space)` hands back the whole row INCLUDING `env` — the sealed envelope,
 * with its `ct`, `iv` and `sig`. That is right for a recovery path (it is the only copy) and
 * wrong for a REPORT, which ends up in a settings sheet, a screenshot and a support bundle. So
 * this reader returns the same four facts `store.syncRefusals` already publishes about a refusal
 * — an opId, a seq, the park reason and how many ladders it has burned — and never the bytes.
 * `env` is dropped HERE rather than at the display, because a field that is dropped at the
 * display is a field the next display forgets to drop.
 *
 * PURE, and the lot is a PORT, duck-typed: this module imports nothing and must not start with
 * `outbox.js`. Anything with a `shelved(space)` method fits, which is what makes the same reader
 * usable from the engine, from the chrome and from a test.
 *
 * @param {{shelved:(space:string)=>Array<Object>}|null} lot the parking lot, or null
 * @param {string|string[]} spaces the space ids to ask about
 * @returns {ReadonlyArray<{space:string, oid:string, seq:string, reason:string, refusals:number}>}
 */
export function shelvedDetail(lot, spaces) {
  if (!lot || typeof lot.shelved !== 'function') return Object.freeze([]);
  const list = Array.isArray(spaces) ? spaces : [spaces];
  const out = [];
  for (const space of list) {
    if (typeof space !== 'string' || space === '') continue;
    for (const r of lot.shelved(space) || []) {
      if (!r || typeof r !== 'object') continue;
      out.push(Object.freeze({
        space: typeof r.space === 'string' ? r.space : space,
        oid: typeof r.oid === 'string' ? r.oid : '',
        seq: typeof r.seq === 'string' ? r.seq : String(r.seq ?? ''),
        reason: typeof r.reason === 'string' ? r.reason : '',
        refusals: Number.isFinite(r.refusals) ? r.refusals : 0,
      }));
    }
  }
  return Object.freeze(out);
}

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
function fieldValue(diag, obs, held) {
  // `at: 'held'` does not read the blob at all — the evidence is handed in by the caller, who
  // read it off the engine's parking lot with `shelvedDetail()`. See the `shelved` row.
  if (obs.at === 'held') return held === null ? undefined : held;
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
 * A PORT-FED row (`at: 'held'`) that was offered nothing is reported as `unoffered` and NOT as
 * `unknown`, and the difference is deliberate: `unknown` feeds `blind`, which feeds `silent`, and
 * a row that made every launch un-silent until a second file wires it would break story 19.3 in
 * the direction `S4-quiet` is the control against. It is not free either — `judgeSyncStatus`
 * returns the `unoffered` list, so "nobody looked" is a fact the build states rather than one it
 * omits. See the `shelved` row for the full argument and for who owes the wiring.
 *
 * @returns {{count:number, unknown:boolean, unoffered?:boolean}}
 */
function presenceOf(obs, diag, held = null) {
  const v = fieldValue(diag, obs, held);
  if (v === undefined) {
    return obs.at === 'held'
      ? { count: 0, unknown: false, unoffered: true }
      : { count: 0, unknown: true };
  }
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
 * @param {?ReadonlyArray<Object>} [held] the shelf, as `shelvedDetail()` read it, or null when
 *   the caller holds no parking lot to read
 * @returns {ReadonlyArray<{id:string, field:string, count:number, state:string,
 *   errorKind:?string, row:string, why:string}>}
 */
export function observeSync(diagnostics, held = null) {
  const out = [];
  for (const obs of SYNC_OBSERVABLES) {
    const { count, unknown } = presenceOf(obs, diagnostics, held);
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

/**
 * The rows nobody handed evidence for — the PORT-FED ones this caller did not offer.
 *
 * Not the same claim as `blindSpots()` and kept apart from it on purpose. A blind spot is a
 * build that cannot answer; an unoffered row is a CALL SITE that did not look. The first is a
 * missing field and makes silence a lie; the second is a missing argument, and the honest thing
 * to do with it is to name it — a settings sheet can say "the shelf was not read", and
 * `round8-park.test.js` §7 asserts which call sites still owe the look.
 *
 * @param {?ReadonlyArray<Object>} held @returns {ReadonlyArray<string>} observable ids
 */
export function unofferedRows(held = null) {
  const out = [];
  for (const obs of SYNC_OBSERVABLES) if (presenceOf(obs, null, held).unoffered) out.push(obs.id);
  return Object.freeze(out);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The judgement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge the engine's own reading with the durable evidence in the store, and say plainly whether
 * silence is earned.
 *
 * @param {{engine?:Object, diagnostics?:Object, held?:?ReadonlyArray<Object>}} input
 *   `engine` — whatever `sync.status()` returned, or null/undefined in solo mode. Its `state`,
 *   `errorKind` and counters are respected and never lowered; this function only ever ADDS.
 *   `diagnostics` — `store.diagnostics()`, or null when there is no store to ask.
 *   `held` — the parking lot's SHELF, as `shelvedDetail(lot, spaces)` read it. Omit it and the
 *   `shelved` row is reported as `unoffered` rather than answered; there is no third thing this
 *   function can do, because the shelf is not in the blob and never will be (see the row).
 * @returns {{state:string, errorKind:?string, detail:?string, pendingOps:number,
 *   consecutiveFailures:number, lastPullAt:?number, observables:ReadonlyArray<Object>,
 *   blind:ReadonlyArray<string>, unoffered:ReadonlyArray<string>, silent:boolean}}
 */
export function judgeSyncStatus({ engine = null, diagnostics = null, held = null } = {}) {
  const e = engine && typeof engine === 'object' ? engine : {};
  const engineState = SYNC_STATE_RANK[e.state] === undefined ? SYNC_STATE.healthy : e.state;

  const observables = observeSync(diagnostics, held);
  const blind = blindSpots(diagnostics);
  const unoffered = unofferedRows(held);

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
    unoffered,
    /**
     * 19.3's promise, as a boolean. TRUE only when the state is healthy AND the whole enumerated
     * domain is empty AND every row of it could actually be answered. A build that cannot see one
     * of the store-fed rows is not silent; it is uninformed, and it says so.
     *
     * ⚠ `unoffered` is NOT in this conjunction, and the `shelved` row is the whole of why: a
     * row whose evidence is a PORT is answered by the call site, and making every call site that
     * holds no parking lot un-silent would put a permanent glyph on a solo Mac. What the caution
     * costs is stated where it is incurred (the `shelved` row) and named in the return value, so
     * a reader of this object can see the difference between "nothing to tell you" and "nothing
     * to tell you about the seven I was shown".
     */
    silent: state === SYNC_STATE.healthy && observables.length === 0 && blind.length === 0,
  });
}
