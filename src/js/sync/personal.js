// src/js/sync/personal.js — LZP-502.  MY TWO MACS, MY WHOLE PRIVATE BOARD.
// Stories 19.4, 21.2, 19.1, 19.6 · ADR 003 §3, §8 · ADR 006 §9 · ADR 002 §5, §6 · ADR 001 §4, §7.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The personal space is the one milestone M1 demonstrates: the PO's desktop and laptop in daily
// sync of the WHOLE private board — including entries marked `privat` — end-to-end encrypted,
// with no family, no members, no invites and no governance anywhere in the path.
//
//   store.txn() ─▶ the log ─▶ store.outbox() ─▶ sealOp ─▶ POST /api/v1/ops
//                                                              │
//   store.applyRemote() ◀─ openOp ◀─ GET /api/v1/ops ◀──────────┘
//
// It owns four things and deliberately owns nothing else:
//
//   1. the OUTBOX — sealing the log's unacknowledged lines and pushing them (§8.1);
//   2. the INBOX — opening a pulled page and handing the plaintext to `store.applyRemote`;
//   3. the CURSOR — advanced only below the commit point (§3.3 and ADR 006 §9.1's W1);
//   4. the RETRACTION HAND-OFF — ADR 004 §3's publisher, which is the WP-3 obligation.
//
// It does NOT own the cadence table, the backoff ladder or the three-state indicator: those are
// ADR 003 §8.2/§8.3 and belong to LZP-504/505. `pushNow()`, `pullNow()` and `syncNow()` are the
// verbs such an engine drives, and `attach()` wires the one trigger that cannot live anywhere
// else — the debounced push after a transaction commits — because only this file knows how to
// seal and only the store knows when something changed.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// 21.2 — WHY NO FAMILY KEY CAN EVER APPLY HERE, AND WHY THIS FILE ADDS NO NEW RULE FOR IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// "My entire board, including private entries, syncs between MY devices only. No family key can
// ever apply." That property is already enforced twice underneath this file and it would be a
// mistake to re-derive it here:
//
//   · `KeyRing.get(space, epoch)` is keyed BY SPACE ID, and a `psp_…` id and an `fsp_…` id are
//     different keys of that map. A family key is not merely the wrong key for a personal
//     envelope — it is not reachable from a personal `sp` at all (ADR 002 §3 barrier 1: the two
//     scopes are DRAWN, not derived; possessing every family key reveals nothing about a
//     personal one because there is nothing to reveal).
//   · the AAD binds `sp`, so an envelope re-labelled from one space to the other fails its GCM
//     tag before a single plaintext byte exists (§5.1, barrier 3).
//
// So this file's contribution to 21.2 is negative work: it never widens the key lookup, never
// falls back to another epoch or another space on a decrypt failure, and refuses at construction
// if it is handed anything but a `psp_…` id. `assertPersonalSpace()` below is that refusal, and
// §21.2's test drives a family envelope at this door and asserts it never opens.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ADR 006 §9 — `board.json` IS THE TRUTH AND THE LOG IS HISTORY, ONCE A PEER EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §9 is the section written for this ticket, and it changes three things about a naive puller:
//
// **W1 — the cursor rides BELOW the commit point.** A peer op that `applyRemote` has folded but
// no `persistNow` has committed exists only in memory. It is not lost, because *the durable
// record of a peer's op is the SERVER, not the local log*, and the resume point is the cursor —
// so the cursor may never be ahead of `board.json`. `store.noteCursor()` is the only way to move
// one and it writes into the log, whose only route to disk is `_persistOps`, which runs strictly
// after `saveBoardText`. `advanceCursor()` below therefore folds, persists, and only then moves
// the cursor; a crash anywhere in that sequence re-fetches rather than skips, and the re-fetch is
// idempotent by `opId` (ADR 001 §6).
//
// **W2 — a quarantine is a RE-JOIN, not a silent convergence reset.** A device whose log was
// refused would otherwise rejoin at the bottom of the stamp order and lose every field contest
// and un-delete on its peers. `store` handles the stamps (ADR 006 §9.4's `'now'` re-derivation);
// what this file does is notice — `diagnostics().rejoin` — and let the outbox do the rest, which
// it does by construction: after a quarantine the log IS the spine, every line is unacknowledged,
// and so the whole personal projection is republished. That is W2, and it needs no special path.
//
// **GENESIS stamps are for upgrade day only.** Also the store's, and also visible from here: a
// re-join republishing at GENESIS would lose every contest it should win.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// F-6 — AN OP WHOSE ATTESTATION HAS NOT ARRIVED YET IS NOT DROPPED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// FINDINGS §3 item 4: "the ATTESTATION park reason, **or retain refused ops**. First contact
// loses data without it." The rule the whole seam is built on is:
//
//   **the cursor is not advanced past an op this device could not yet apply.**
//
// That is not a workaround, it is §9.1 used for the thing §9.1 is about: the server is the
// durable record, so "retain it" and "do not tell the server I have consumed it" are the same
// statement, and the second one survives a quit while an in-memory park would not. Concretely:
//
//   · an envelope `openOp` PARKS — for ANY of `ENVELOPE_PARK`'s reasons, see `PARK_HANDLING` in
//     §0 — or an op the fold refuses with a reason a later op can cure (`unattestedDevice`,
//     `notMyDevice`), is DEFERRED;
//   · the cursor advances only to the last seq before the first deferred op, so the next pull
//     re-delivers it — in the same session it is retried from memory as well, which is what makes
//     a same-batch attestation work without a round trip;
//   · after `maxDeferrals` fruitless attempts it moves to QUARANTINE with a visible error and the
//     cursor is released past it. ADR 003 §8.2 is explicit that "a permanently rejected op must
//     never silently spin forever", and a cursor pinned for ever behind one op would block every
//     later op on the space — a worse failure than the one it was avoiding. It is also how a
//     hostile relay would wedge this device with one unreadable envelope.
//
// A refusal nothing can cure (a bad shape, a foreign space, a `local`-space op) is TERMINAL and
// never holds the cursor: re-pulling it would produce the same answer for ever.
//
// ⚠ **NONE OF THE ABOVE ACTUALLY RAN UNTIL 2026-08-29 — finding P-8, and it is worth one
// paragraph here because the prose was right and the code was not.** `pullNow` tested `out.parked`
// on an object whose discriminator is `out.status`, so the entire park branch was dead: every
// parked envelope fell through it into `terminal()`, was quarantined as "openOp returned no op",
// and the cursor was released past it. First contact between two Macs — the ordinary case, since
// there is no causal delivery — destroyed the op, and one relaunch later the only trace was gone
// and `status()` said `healthy`. The lesson is in §0's `PARK_HANDLING`: the branch was written
// against the two reasons somebody remembered, so a table keyed off `ENVELOPE_PARK` itself
// replaces it and `tests/tier1/sync-personal.test.js` §4b asserts the two agree.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// R8-1 / R8-2 — THE CHAIN WITNESS IS A DIAGNOSTIC, AND IT IS THE WRAPPER
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// P-4 put ADR 002 §5.4's detector on this path by importing `verifyChain`, which is the LEAF of
// `sync/chain.js`: a pure function over one contiguous run, with no memory of what this device has
// already folded. Everything the leaf lacked, the wrapper beside it already had — and the round
// compensated for the missing mechanism by giving the leaf a power the ADR forbids in one
// sentence: *"it NEVER BLOCKS SYNC in v2 (a false positive that broke a family's board would be
// far worse than the attack)"*. Two failures fell out of that, and both were on an HONEST relay:
//
//   · **R8-1.** `chainAnchor` advanced whenever a PAGE verified; the CURSOR advanced only when
//     nothing in the page was held. F-6's first contact is exactly where those differ, so the
//     honest re-serve of a held page was verified against an anchor inside itself and reported as
//     `seq jumped from 1 to 1`. Its durable form was worse: the record persisted beside the cursor
//     took `seq` from the commit and `chain` from the last row of the page, so the value the relay
//     was accused of forging was the value this device had stored as its own anchor.
//   · **R8-2.** One member removal (ADR 003 §6.3, story 20.2) leaves a hole nothing can ever fill.
//     A permanent cursor hold on an unfillable hole is a wedge: the cursor never moved again and
//     every op above it was unreachable, across relaunches, for ever.
//
// The rule now, stated once here and once in `chain.js`:
//
//   **A CHAIN FINDING MAY HOLD THE CURSOR FOR THE PULL THAT DISCOVERS IT, AND NOT AFTER.**
//
// One honest round trip for a relay that truncated a page; then the witness re-anchors on the row
// it was served, does not re-report the break, and sync continues — with the finding standing in
// `store.syncChain` and the state at `error` until positive evidence arrives. The claim check
// below (`nextCursor` past the last row served) is a different mechanism and is NOT bounded: it is
// derived from a claim the relay repeats on every page, so it is re-armed on every page.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// PURITY (ADR 005 §2, `tests/helpers/purity.js` PURE_DIRS)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// This directory is DOM-free and I/O-free. There is no `fetch` here — the transport is a PORT,
// bound in production to `src/js/platform/net.js` (the only fetch in the product, story 21.5)
// and in tests directly to the real server handlers. There is no clock and no randomness either:
// `now` is injected, and every id and every iv is minted by `core/` or by `crypto/` from ports
// they were given. The store is injected too, so `src/js/store.js` — which is not in a pure
// directory — is never imported from here.

import { sealOp, openOp, ENVELOPE_PARK } from '../crypto/envelope.js';
import { spaceKindOf, isSpaceId } from '../crypto/spacekeys.js';
// P-4 — ADR 002 §5.4's chain witness. It shipped with E5 and `src/` imported it from NOWHERE, so
// the client verified no chain at all and a relay that withheld, reordered or renumbered was
// undetectable BY CONSTRUCTION. `pullNow` is the only call site the design ever named for it.
//
// **R8-1/R8-2 — THE WRAPPER, NOT THE LEAF.** Round 8 imported `verifyChain`, which is a pure
// function over ONE contiguous run and knows nothing about what this device has already folded.
// `createChainWitness` is the stateful wrapper in the same file, and every piece round 8 then had
// to fake is already inside it: the `fresh` filter that drops rows at or below the verified head
// (without which the honest re-serve of a held page is reported as `seq jumped from 1 to 1`), the
// per-break dedupe, the `broken` flag, the re-anchor that makes a member purge survivable, and
// `fromGenesis` so an unprovable claim is reported as unprovable rather than as a fork.
// `CHAIN_FINDINGS` comes with it because the ONE cursor decision this file makes on the witness's
// word is per-kind (R10-2b, below), and `chain.js`'s own docblock says a caller may enumerate the
// kinds and nothing else may — so the enum is imported rather than a string literal typed here.
import { createChainWitness, CHAIN_FINDINGS } from './chain.js';
// P-8's third axis — the DURABLE park for a sealed envelope. See `lot` below for why this is not
// `core/oplog.js`'s park and why the module it lives in is a defence rather than a dead engine.
import { createParkingLot } from './outbox.js';
// The nine fields ADR 002 §5.1 shapes an envelope from. A PULLED row carries `seq` and `chain`
// on top of them — the relay's own framing, not part of the sealed thing — and the parking lot
// stores envelopes, so the row is projected down to exactly these before it is retained.
import { ENVELOPE_KEYS } from './protocol.js';
// P-4's second half — the DURABLE chain anchor. `cursor.js`'s own header is the argument for
// putting it here: the chain head "answers the same question the cursor does — where was I in
// this space's log? — and two persisted answers to one question is how they drift apart".
import { createCursors } from './cursor.js';
// L-1/L-2/E5-2/P-4 — the enumeration of what can be observed, and the fold over it. `status()`
// below merges the engine's own reading with the DURABLE evidence in the store, by `max` over the
// three-state ladder, so this file can only ever raise a state and never lower one.
import { judgeSyncStatus, shelvedDetail } from './status.js';

// ─────────────────────────────────────────────────────────────────────────────
// The protocol numbers, from `docs/v2/contracts/sync.contract.js` §0 (ADR 003 §4, §6.1, §8.2).
//
// They are RESTATED rather than imported: `docs/` is not shippable source, and the purity gate's
// one-way import rule (`tests/helpers/purity.js` ALLOWED_IMPORT_TARGETS) confines this directory
// to `src/js/sync`, `src/js/crypto` and `src/js/core`. `tests/tier1/sync-personal.test.js`
// asserts every value here against the contract file, so the copy cannot drift from the source
// of truth without a red test. **If LZP-501 lands a shared `src/js/sync/` constants module,
// these should move into it and this block should be deleted, not duplicated.**
// ─────────────────────────────────────────────────────────────────────────────

/** ADR 003 §6.1's caps. */
export const LIMITS = Object.freeze({
  opsPerPush: 200,
  bytesPerEnvelope: 64 * 1024,
  bytesPerRequest: 4 * 1024 * 1024,
  opsPerPull: 500,
});

/** ADR 003 §8.2's cadence. This file uses only `pushDebounceMs`; the rest is LZP-504's. */
export const CADENCE = Object.freeze({
  pushDebounceMs: 2000,
  pullVisibleMs: 45000,
  pullJitterMs: 15000,
  pullHiddenMs: 600000,
  backoffBaseMs: 2000,
  backoffMaxMs: 300000,
  pendingAfterMs: 20000,
  statusDebounceMs: 2000,
});

/**
 * How many `seq → chain` pairs one session remembers, so the anchor persisted beside the cursor
 * can be the chain of THE COMMITTED ROW rather than of whatever row the page ended on (R8-1b).
 *
 * Four pages' worth. The map is a convenience with a safe miss — an unknown seq stores no anchor
 * and the next page re-anchors — so the bound may be small, and it must be bounded: a relay that
 * serves pages for a week must not be able to grow a client's heap one row at a time.
 */
const CHAIN_SEQ_MEMORY = 4 * LIMITS.opsPerPull;

// ─────────────────────────────────────────────────────────────────────────────
// 0. Errors and the refusal taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export class PersonalSyncError extends Error {
  /** @param {string} message @param {string} [kind] */
  constructor(message, kind = 'config') {
    super(message);
    this.name = 'PersonalSyncError';
    this.kind = kind;
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE PARK DOMAIN, WRITTEN DOWN AS DATA — finding **P-8**, and the reason it is a table and not
 * an `if`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT WAS WRONG, IN TWO WORDS. `openOp` reports a park as
 *
 *     { status: 'park', parkReason: 'attestation'|'epoch'|'version'|…, reason: '<a sentence>' }
 *
 * and this file read `out.parked` — a field nothing ever sets — so the WHOLE PARK BRANCH WAS DEAD
 * CODE. Every parked envelope fell through it, found no `op.id` on a `{status:'park'}` object, and
 * was sent to `terminal()`: quarantined as "openOp returned no op", with the cursor RELEASED past
 * it. The relay's `since` filter then never offers the op again, the engine's quarantine dies with
 * the session, and one relaunch later `status()` says `healthy` over a permanent divergence.
 * The second mistake was inside the dead branch and would have defeated it even if it had run:
 * the list held ENUM VALUES and was tested against `out.reason`, which is the human sentence.
 *
 * WHY A TABLE. The previous shape was a two-element allow-list, and an allow-list answers the
 * question "is this one of the two I thought of?" — which is the question that lost `version` and
 * `unknownKind`. This table answers "what do I do with **every** reason the envelope layer can
 * emit?", is keyed off `ENVELOPE_PARK` itself so a reason added upstream cannot be silently
 * omitted (`tests/tier1/sync-personal.test.js` asserts the two agree), and `parkHandlingOf()`
 * below is TOTAL — an unknown reason from a newer `crypto/envelope.js` is still a park, never a
 * drop.
 *
 * THE RULE, WITH NO EXCEPTIONS: **a park is a deferral and it may never become a drop.** The
 * envelope is retained and the cursor is held below it, because while the cursor is held THE RELAY
 * IS THE DURABLE COPY (ADR 006 §9.1 W1) — "retain it" and "do not tell the server I have consumed
 * it" are the same statement, and only the second one survives a quit.
 *
 * `curedBy` is what the entry is FOR — it is not a second disposition, it is the answer to "what
 * has to happen in the world before re-opening this envelope can give a different answer":
 *
 *   'session' a later page, a pairing, a key fetch. A re-pull in THIS session can cure it, and
 *             `CURABLE_PARKS` below is exactly this subset — which is what `isCurable` means.
 *   'update'  an app update, and nothing else. Re-opening it costs one AES call and always
 *             answers the same way until the binary changes.
 *
 * ⚠ **THE HALF THIS FILE CANNOT FINISH, STATED HERE RATHER THAN DISCOVERED AGAIN.** The `'update'`
 * rows ought to RELEASE the cursor — a cursor pinned behind an op that only a new binary can read
 * blocks every later op for as long as the user does not update, and a hostile relay that serves
 * one `v: 99` envelope would wedge the stream for ever. Releasing it is only safe once the sealed
 * envelope is retained DURABLY, and there is nowhere to put it: `openOp` parks `version` BEFORE it
 * decrypts, so there is no op to hand `oplog.park()`, and `oplog` has no line shape for a sealed
 * envelope. Between two silent losses this file takes the recoverable one — the cursor is held for
 * every park, the ladder below bounds it, and the gap is reported rather than papered over.
 * **Owner: `core/oplog.js` + `store.js` — a durable park for a SEALED ENVELOPE, with its reason.
 * The day it exists, the `'update'` rows release the cursor immediately and `S1-park-version` /
 * `S1-park-unknownKind` close.**
 *
 * @type {Readonly<Record<string, Readonly<{curedBy:'session'|'update', note:string}>>>}
 */
export const PARK_HANDLING = Object.freeze({
  [ENVELOPE_PARK.ATTESTATION]: Object.freeze({
    curedBy: 'session',
    note: 'P1 — no attestation resolves `env.dv` yet. F-6\'s whole case, and M1\'s first contact: '
      + 'my other Mac\'s op arriving before this Mac has learned that the device is mine. There is '
      + 'no causal delivery, so this is the ORDINARY order of events, not an edge.',
  }),
  [ENVELOPE_PARK.EPOCH]: Object.freeze({
    curedBy: 'session',
    note: 'P4 — sealed under a key epoch this ring does not hold. ADR 002 §4.4: a member offline '
      + 'across three rotations needs every epoch spanning the ops they have not read, so the cure '
      + 'is a key fetch rather than a re-pull — but the cursor must still be held, because the ops '
      + 'have to still be there when the key lands.',
  }),
  [ENVELOPE_PARK.VERSION]: Object.freeze({
    curedBy: 'update',
    note: 'ADR 002 §1 "versioning, not negotiation" — `env.v` is a version this build does not '
      + 'know. ADR 003 §4: "a client keeps the ability to OPEN every Envelope.v it has ever seen", '
      + 'which is a promise about the op still existing after the update.',
  }),
  [ENVELOPE_PARK.UNKNOWN_KIND]: Object.freeze({
    curedBy: 'update',
    note: 'ADR 003 §4 / ADR 001 §7.4 — "unknown op KINDS and unknown FIELD NAMES are parked, not '
      + 'dropped. An old client in a family with a newer one degrades to *does not show the new '
      + 'thing* instead of *loses the new thing*." `sealOp` refuses to seal one, so the only '
      + 'producer in the world is a newer build.',
  }),
  [ENVELOPE_PARK.UNKNOWN_FIELD]: Object.freeze({
    curedBy: 'update',
    note: 'The same sentence of ADR 003 §4, one column over: a name in `f` this build has never '
      + 'heard of. `openOp` returns the field list with the park.',
  }),
  [ENVELOPE_PARK.UNKNOWN_SPACE]: Object.freeze({
    curedBy: 'update',
    note: '`op.space` is a form this build does not recognise — a space CLASS from a newer build, '
      + 'not a foreign space id (check 2 has already bound `op.space` to `env.sp`).',
  }),
});

/**
 * The handling for one park reason. **TOTAL**, and that is the point: a reason this build has
 * never heard of is a message from a NEWER build, which is the one case where dropping the op is
 * certainly wrong. It is treated as `'update'` — held, and re-judged after an app update — and the
 * caller says so out loud.
 *
 * @param {string} reason @returns {{curedBy:'session'|'update', known:boolean}}
 */
export function parkHandlingOf(reason) {
  const known = Object.prototype.hasOwnProperty.call(PARK_HANDLING, reason) ? PARK_HANDLING[reason] : null;
  return known ? { curedBy: known.curedBy, known: true } : { curedBy: 'update', known: false };
}

/**
 * The park reasons a LATER OP, a pairing or a key fetch can cure **within this session** — i.e.
 * the ones for which re-opening the same bytes on the next pull can give a different answer.
 *
 * DERIVED from `PARK_HANDLING` rather than restated, so the two cannot disagree. Every park holds
 * the cursor; this subset is the one where holding it is expected to pay off soon.
 */
export const CURABLE_PARKS = Object.freeze(
  Object.keys(PARK_HANDLING).filter((r) => PARK_HANDLING[r].curedBy === 'session'));

/**
 * The `foldAuthorized` rejection codes a later op can cure — i.e. the ones that are a statement
 * about WHAT HAS ARRIVED SO FAR rather than about the op itself.
 *
 * Both of them are the personal-space device gate (`core/authz.js` stage 0b). `notMyDevice` is
 * the M1 case exactly: my second Mac's op, arriving before this Mac has learned that the device
 * is mine. `unattestedDevice` is its family-space twin and is here for the same reason.
 * Everything else — `shape`, `notMyAct`, `writeOnce`, `notOwner`, … — is a property of the op
 * and re-pulling it a thousand times produces the same verdict.
 */
export const CURABLE_REFUSALS = Object.freeze(['notMyDevice', 'unattestedDevice']);

/** @param {string} reason @returns {boolean} */
export const isCurable = (reason) => CURABLE_PARKS.includes(reason) || CURABLE_REFUSALS.includes(reason);

/** How many pulls an op may be deferred before it is quarantined instead (ADR 003 §8.2). */
export const MAX_DEFERRALS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// 1. The publication port — ADR 004 §3, and the WP-3 obligation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The publisher `store.setPublisher()` installs.
 *
 * **WHY THIS EXISTS AT ALL IN A TICKET WITH NO FAMILY IN IT.** `store.replaceAll()` — import
 * (11.3) and snapshot restore (11.5) — goes through `planReplaceAll`, never through the short
 * `replaceAllOps` entry point, precisely because only the PLAN carries `plan.retractions`: the
 * family-visible entries whose personal truth the replacement just tombstoned. Nothing in
 * `core/` runs after the transaction lands, so a `retractions` list dropped at this seam cannot
 * be recovered anywhere, and the consequence is story 16.5's: an imported board leaves entries
 * live on the other device.
 *
 * At M1 there is no family space, so there is nothing to send — and that is exactly the case in
 * which the list is most likely to be quietly thrown away. It is therefore RECORDED, reported
 * through `store.diagnostics().sync.pendingRetractions`, and handed on unchanged the day a
 * family space exists. `drain()` is the seam WP-6 takes it from.
 *
 * @param {{familySpaceId?:string|null, onRetract?:(keys:string[]) => void}} [opts]
 */
export function createPersonalPublisher(opts = {}) {
  const pending = [];
  const reshares = [];
  return {
    familySpaceId: opts.familySpaceId ?? null,
    pendingRetractions: pending,
    pendingReshares: reshares,
    retract(keys) {
      if (!keys || !keys.length) return;
      for (const k of keys) if (typeof k === 'string' && !pending.includes(k)) pending.push(k);
      if (typeof opts.onRetract === 'function') opts.onRetract(pending.slice());
    },
    askToReshare(list) {
      // NOTHING is re-shared without the user saying so (ADR 004 §3, story 16.5). This records a
      // question to ask, never an action to take.
      if (!list || !list.length) return;
      for (const e of list) reshares.push(e);
    },
    derivePublication() { return []; },
    enqueue() {},
    /** Take the recorded list, leaving the publisher empty. @returns {string[]} */
    drain() { return pending.splice(0, pending.length); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Small helpers — all total, none of them reaching for a global
// ─────────────────────────────────────────────────────────────────────────────

/** ADR 003 §3.3: seqs are decimal strings on the wire and BigInt-comparable, never Numbers. */
function toSeq(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]{1,19}$/.test(v)) return BigInt(v);
  return null;
}

/**
 * The one refusal 21.2 turns on. A `psp_…` id is required and an `fsp_…` id is a THROW, not a
 * fallback: a personal sync engine pointed at a family space would push the user's private board
 * into the family stream, which is the single worst thing this product could do.
 */
function assertPersonalSpace(spaceId) {
  // `isSpaceId` first: `spaceKindOf` THROWS on anything it cannot classify (deliberately — both
  // branches of a wrong guess are catastrophic), and this refusal wants to name the caller.
  if (!isSpaceId(spaceId) || spaceKindOf(spaceId) !== 'personal') {
    throw new PersonalSyncError(
      `personal sync: spaceId must be a psp_… id; got ${JSON.stringify(spaceId)}. A family space `
      + 'is not a fallback here (story 21.2).');
  }
  return spaceId;
}

/** @returns {{status:number, headers:Object, json:any}} normalised, never throwing on shape. */
function normalizeResponse(res) {
  const status = res && Number.isInteger(res.status) ? res.status : 0;
  const headers = res && res.headers && typeof res.headers === 'object' ? res.headers : {};
  const json = res && 'json' in (res || {}) ? res.json : (res ? res.body : null);
  return { status, headers, json };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PersonalSyncDeps
 * @property {Object} store            the live `store` — injected, never imported (purity)
 * @property {{request:(m:string,p:string,q:Object,b:any,h:Object)=>Promise<Object>}} transport
 * @property {Object} keyring          `createKeyRing()` — holds the PSK for THIS space only
 * @property {CryptoKey} sigPriv       this device's non-extractable `IK_sig` private key
 * @property {string} spaceId          `psp_…`
 * @property {string} deviceShort      mine; must equal `store`'s, and it is checked
 * @property {(dv:string) => (Object|null)} attestationOf
 *           `openOp`'s P1 — the partial function from a device short to its verified attestation.
 *           A PORT, and it must be: see §5 of this file's notes for where M1's answer comes from.
 * @property {Object} [attestation]    MY own attestation, so `sealOp` can mirror the far-side gate
 * @property {() => number} now        injected clock — nothing here reads one
 * @property {(ms:number, fn:Function) => any} [schedule]    injected; no setTimeout in sync/
 * @property {(h:any) => void} [unschedule]
 * @property {() => boolean} [isOnline]
 * @property {(s:Object) => void} [onStatus]
 * @property {SubtleCrypto} [subtle] @property {(n:number)=>Uint8Array} [random]
 * @property {number} [maxDeferrals]
 * @property {number} [pushDebounceMs]
 */

/**
 * @param {PersonalSyncDeps} deps
 */
export function createPersonalSync(deps) {
  const d = deps || {};
  const store = d.store;
  const transport = d.transport;
  const spaceId = assertPersonalSpace(d.spaceId);

  if (!store || typeof store.outbox !== 'function' || typeof store.applyRemote !== 'function') {
    throw new PersonalSyncError('personal sync: `store` must be the LZP store (outbox/applyRemote/noteCursor)');
  }
  if (!transport || typeof transport.request !== 'function') {
    throw new PersonalSyncError('personal sync: `transport` must implement request(method, path, query, body, headers)');
  }
  if (typeof d.now !== 'function') {
    throw new PersonalSyncError('personal sync: `now` is an injected port — src/js/sync/ reads no clock');
  }
  if (typeof d.attestationOf !== 'function') {
    // FAIL CLOSED. `openOp` refuses a missing `attestationOf` too, but by then the caller has
    // already built a keyring and a transport and believes it is syncing.
    throw new PersonalSyncError(
      'personal sync: `attestationOf` is required — it is openOp\'s P1 and the ONLY source of the '
      + 'verification key (ADR 002 §5.2.1). Without it every peer envelope parks, permanently.');
  }
  if (store.personalSpaceId && store.personalSpaceId() !== spaceId) {
    throw new PersonalSyncError(
      `personal sync: the store writes into ${JSON.stringify(store.personalSpaceId())} but this engine `
      + `was pointed at ${JSON.stringify(spaceId)}. Call store.usePersonalSpace() before init().`);
  }
  if (d.deviceShort && store._short && d.deviceShort !== store._short) {
    // ADR 002 §5.2.2 check 4: `devOf(op.ts) === env.dv`. If these two disagree, EVERY envelope
    // this device seals is one no peer will ever open — and the failure is remote and silent.
    throw new PersonalSyncError(
      `personal sync: deviceShort ${JSON.stringify(d.deviceShort)} is not the short this store stamps `
      + `with (${JSON.stringify(store._short)}). Every envelope would fail §5.2.2 check 4 on the peer.`);
  }

  const deviceShort = d.deviceShort ?? store._short;
  const maxDeferrals = Number.isSafeInteger(d.maxDeferrals) && d.maxDeferrals > 0 ? d.maxDeferrals : MAX_DEFERRALS;
  const pushDebounceMs = Number.isSafeInteger(d.pushDebounceMs) && d.pushDebounceMs >= 0
    ? d.pushDebounceMs : CADENCE.pushDebounceMs;
  const ports = { subtle: d.subtle, random: d.random };
  const isOnline = typeof d.isOnline === 'function' ? d.isOnline : () => true;

  /**
   * SEALED ENVELOPES, CACHED BY opId — and this cache is a CORRECTNESS requirement, not a
   * performance one.
   *
   * `server/core/handlers/ops.js` compares the STORED bytes on a re-push and answers
   * `409 forked_op_id` when they differ. A fresh `iv` and a non-deterministic ECDSA signature
   * mean a RE-SEAL of the same op differs in bytes every time, so ADR 003 §8.1's "the outbox
   * holds SEALED envelopes" is load-bearing rather than descriptive: a client that re-seals on
   * retry sees a 409 on every retry.
   *
   * ⚠ **AN ADR CONTRADICTION, RESOLVED HERE AND ESCALATED — do not "simplify" this away.**
   * ADR 003 §8.1 says the outbox IS "`ops.jsonl` lines whose seq is unset, i.e. sealed envelopes
   * not yet acknowledged". ADR 006 §9.2 and `store.js:_uncommittedTailLines` say `ops.jsonl`
   * holds PLAINTEXT op lines — and they are right to, because the log is what `board.json` is
   * reconciled against and a checkpoint of ciphertext would fold nothing. So the two documents
   * disagree about what the outbox is made of, and the disagreement is only visible at the one
   * moment it matters: **a relaunch with a non-empty outbox.** Without somewhere to keep the
   * sealed bytes, the ops are re-derived from the log, re-sealed with a fresh iv, and refused
   * `409 forked_op_id` — permanently, for every op queued when the app was last quit, which is
   * the ordinary case for a laptop closed on a train (19.1).
   *
   * `envelopeStore` is the seam that closes it: an injected `{load(spaceId), save(spaceId, envs)}`
   * port, because `src/js/sync/` is I/O-free (ADR 005 §2) and `src/js/storage.js` belongs to
   * another owner. Absent, the cache is per-session and the 409 path below is what stands between
   * the user and a wedged outbox. **Reported to WP-3: `storage.js` needs one slot for this, and
   * ADR 003 §8.1 needs one sentence saying which file the envelopes live in.**
   * @type {Map<string, Object>}
   */
  const sealed = new Map();
  let sealedLoaded = false;

  async function loadSealed() {
    if (sealedLoaded) return;
    sealedLoaded = true;
    if (!d.envelopeStore || typeof d.envelopeStore.load !== 'function') return;
    try {
      const rows = await d.envelopeStore.load(spaceId);
      for (const env of rows || []) if (env && typeof env.oid === 'string') sealed.set(env.oid, env);
    } catch (e) {
      // A cache that cannot be read costs a re-seal, never a lost op. It is a warning, not a stop.
      if (typeof store._warn === 'function') store._warn(`sync: the sealed outbox could not be read (${e.message})`);
    }
  }

  /** The cache holds exactly what the outbox still owes. See the call site for why. */
  function pruneSealed() {
    const live = new Set(store.outbox().map((l) => l.op.id));
    for (const oid of [...sealed.keys()]) if (!live.has(oid)) sealed.delete(oid);
  }

  async function saveSealed() {
    if (!d.envelopeStore || typeof d.envelopeStore.save !== 'function') return;
    try { await d.envelopeStore.save(spaceId, [...sealed.values()]); }
    catch { /* the same trade as above, in the other direction */ }
  }

  /**
   * ── P-8's THIRD AXIS · THE DURABLE PARK FOR A SEALED ENVELOPE ─────────────────────────────
   *
   * `deferred` below is a `Map` and dies with the session. That was survivable while the cursor
   * was held under every park — the relay is the durable copy below the cursor (ADR 006 §9.1 W1)
   * — and it is NOT survivable at the two places the design needs the cursor released: ADR 003
   * §8.2 forbids a cursor pinned for ever behind an envelope only a new binary can read, and the
   * ladder below therefore ends every hold in a quarantine. From that instant an envelope with
   * nothing but a `Map` behind it is gone.
   *
   * `sync/outbox.js`'s `createParkingLot` is the mechanism, and it already existed: a capped,
   * storage-backed retention of SEALED ENVELOPES with their reasons, which **refuses at its cap
   * rather than dropping** and tells the caller to hold the cursor. It could not be reached from
   * anywhere in `src/` (P-4 counted it an orphan and `sync-domains.js` first called it dead),
   * because its one importer was LZP-501's superseded `sync/client.js`. It is not superseded:
   * `store.outbox()` replaces `createOutbox` and nothing replaces this.
   *
   * WHY NOT `core/oplog.js`. A park at P1 (no attestation), P4 (no epoch key) or the version gate
   * happens BEFORE the decrypt, so there is no op to hand `oplog.park()` and the log has no line
   * shape for ciphertext. The two layers are parking two different things and both are needed:
   * the LOG parks ops it can read and will not apply; this parks bytes it cannot read yet.
   *
   * `parkStore` is the injected port, exactly like `envelopeStore` above and for the same reason
   * (`src/js/sync/` is I/O-free, ADR 005 §2). Absent, the lot is per-session and says so through
   * `diagnostics().park.durable`, which is `S4`'s "an undurable seam is visible rather than
   * assumed" applied to itself.
   */
  const lot = createParkingLot({
    storage: d.parkStore && typeof d.parkStore.loadRecords === 'function' ? d.parkStore : undefined,
    now: () => d.now(),
    warn: (m) => { if (typeof store._warn === 'function') store._warn(m); },
  });
  let lotLoaded = false;

  /** Read the durable park back, once per session, and re-arm the retry set from it. */
  async function loadLot() {
    if (lotLoaded) return;
    lotLoaded = true;
    try {
      await lot.load();
    } catch { /* the lot warns for itself; a pull may not die here */ }
    try {
      await cursors.load();
      // The head AND what this device may claim about it. `fromGenesis` is the difference between
      // "a peer committed to a chain I have never been served" (a fork) and "a peer committed to a
      // chain outside my window" (not evidence) — `chain.js` will not let this device make the
      // first claim unless it earned it, and a restored record is where that right is carried.
      witness.restore(spaceId, cursors.head(spaceId), cursors.fromGenesis(spaceId));
    } catch { /* likewise: with no anchor this session re-anchors on its first page */ }
    for (const row of lot.parked(spaceId)) {
      if (deferred.has(row.oid)) continue;
      const seq = toSeq(row.seq);
      if (seq === null) continue;
      deferred.set(row.oid, {
        env: row.env,
        seq,
        // `tries` starts again at what the lot remembers, so a hold that has already burned the
        // ladder on a previous run is not handed a fresh six attempts every launch.
        tries: Number.isInteger(row.tries) ? row.tries : 0,
        why: row.reason,
        curedBy: parkHandlingOf(row.reason).curedBy,
      });
    }
  }

  /** Ops pulled but not yet applicable — F-6. @type {Map<string, {env:Object, seq:bigint, tries:number, why:string}>} */
  const deferred = new Map();
  /** Terminally refused, with a visible error (ADR 003 §8.2). @type {Map<string, {seq:string, reason:string}>} */
  const quarantined = new Map();
  /** Park reasons this build does not know, warned about once each rather than once a pull. */
  const warnedParks = new Set();
  /** Chain-witness verdicts already reported, so a wedged relay writes one sentence, not one a pull. */
  const warnedChain = new Set();
  /**
   * P-4 · R8-1 · R8-2 — ADR 002 §5.4's witness, ONE PER ENGINE, holding the verified head of
   * this space and the bounded memory the `wit` cross-check needs.
   *
   * Round 8 kept a bare `chainAnchor` here and called `verifyChain` on it. That is the leaf of
   * this module, and a leaf has no memory: it cannot know that a row it is being shown has
   * already been folded, so the honest re-serve of a page whose cursor is held — F-6's ordinary
   * first contact — was verified a second time against an anchor INSIDE it and reported as a hole
   * between a seq and itself (R8-1). The wrapper's first act is `rows.filter(above the head)`.
   *
   * It is also the thing that makes ADR 003 §6.3's member purge survivable: it re-anchors on the
   * row the relay served, reports the break ONCE with its `benignCause`, and keeps verifying
   * afterwards. Round 8's `verifyChain` re-derived the same break on every pull for ever (R8-2).
   */
  const witness = createChainWitness(ports);
  /**
   * seq → the chain value the relay served for THAT seq, for the rows seen this session.
   *
   * R8-1b's fix. `cursor.js advance(space, seq, head, …)` persists `{seq, chain: head.chain}`, and
   * round 8 handed it the commit point for `seq` and the LAST ROW OF THE PAGE for `chain` — two
   * different rows in one record, so the next launch anchored on a chain value that never belonged
   * to the seq it was stored against and accused an honest relay of forging its own log. The
   * record has to be ONE ROW, so the chain persisted beside the cursor is looked up BY the commit
   * seq here; when it is not known the anchor is cleared rather than paired with the wrong row
   * (`''`, which `cursor.js head()` reads as "no anchor" and `pullNow` answers by re-anchoring on
   * the next page — the honest degradation, measured in `attack-converge-relay.test.js` §5).
   * @type {Map<string, string>}
   */
  const chainBySeq = new Map();
  /**
   * The seqs a chain finding said this device was owed, still unserved.
   *
   * A verdict about the relay may only be cleared by POSITIVE EVIDENCE, and after the witness
   * re-anchors past a break there are two shapes of it, not one: a page of FRESH rows that
   * verifies, and — the one round 8 could not express — THE MISSING ROW ARRIVING. A transient
   * withhold heals by re-serving the row below this device's head, where the witness (correctly)
   * has nothing to say about it, so without this the indicator would stay red for ever after a
   * lie the relay had already stopped telling. It is emptied by delivery and by nothing else: a
   * relay cannot clear its own verdict by repeating a page it has already served.
   * @type {Set<string>}
   */
  const chainOwed = new Set();
  /**
   * The durable home for that anchor.
   *
   * **THIS IS NOT A SECOND TRANSPORT CURSOR, and the distinction is load-bearing.** ADR 006 §9.1
   * W1 makes "there is exactly one way to move a cursor and it writes into the LOG" a STRUCTURAL
   * claim, and `store.js`'s `noteCursor` docblock names "persisting a cursor through some other
   * file" as how a future engine would break it. So `store.cursor(spaceId)` remains the ONLY
   * value read as `since`, and the only one anything branches on. What is read back from here is
   * `head()` — the chain value — and nothing else.
   *
   * What this module contributes is its ONE WRITE PATH: `advance()` runs the commit FIRST and
   * persists only if it resolves, which is the same ordering W1 requires and the reason the seq
   * kept beside the head can lag the store's cursor but can never lead it.
   */
  const cursors = createCursors({
    storage: d.chainStore && typeof d.chainStore.loadCursors === 'function' ? d.chainStore : undefined,
    warn: (m) => { if (typeof store._warn === 'function') store._warn(m); },
  });

  const stats = {
    pushes: 0, pulls: 0, opsPushed: 0, opsApplied: 0, opsDeferred: 0, opsQuarantined: 0,
    lastPullAt: null, lastPushAt: null, consecutiveFailures: 0, lastError: null,
    rejoin: false, protocol: null,
  };

  let attached = false;
  let unsubscribe = null;
  let pushTimer = null;
  let running = null;

  // ── sealing ────────────────────────────────────────────────────────────────

  /**
   * Seal one outbox line. The header is AUTHENTICATED, not derived — `sealOp` checks every field
   * against the op rather than rewriting either, so a disagreement is a local throw instead of a
   * remote, permanent, silent failure to open.
   *
   * ── R10-1 · `wit` IS THE FORK DETECTOR, AND IT IS ONE EXPRESSION ─────────────────────────
   *
   * Until round 10 this file sealed the literal `wit: ''` on every push and explained it as "the
   * honest value: the chain witness is computed by the RELAY". Half of that is true — the CHAIN is
   * the relay's, and this device may not invent one — and the conclusion drawn from it was wrong.
   * ADR 002 §5.4 asks for something this device *can* answer for: **the highest chain value it has
   * itself been served.** `witness.witness(spaceId)` is exactly that, it is `''` before the first
   * pull (§5.1's "`''` on the first push"), and it is checkable by any peer that recomputes the
   * same chain — which is the whole of check 2:
   *
   *   > every op a member authors commits to what that member had seen … the half that a relay
   *   > lying consistently to one device cannot escape.
   *
   * With `''` there is no input to that check anywhere in the system, so `UNKNOWN_WITNESS` could
   * not fire on the product path in any circumstance whatsoever (`round9-witness.test.js` §1a).
   *
   * THREE PROPERTIES THIS MUST NOT LOSE, ALL OF THEM ALREADY HELD BY THE CODE AROUND IT:
   *
   *   · **the bytes are frozen once sealed.** `sealed` caches by opId and `envelopeStore` persists
   *     it, because the relay answers `409 forked_op_id` when a re-push differs in ANY
   *     authenticated field — and `wit` is authenticated (`envelope.js AAD_FIELDS`, and the server
   *     compares `prev.witness` in its pre-pass). A value read at seal time and never re-read is
   *     stable; re-deriving it at push time would 409 every op queued across a pull;
   *   · **it is a claim about this device, not about the op.** An op sealed before the first pull
   *     carries `''` for ever, which is honest and is what §5.1 provides for;
   *   · **it never blocks anything.** The value is a diagnostic input for a PEER; nothing in this
   *     file reads it back, and a relay that rewrites it can only produce a finding, never a stop.
   */
  async function sealLine(op) {
    const cached = sealed.get(op.id);
    if (cached) return cached;
    const epoch = typeof d.keyring?.currentEpoch === 'function' ? d.keyring.currentEpoch(spaceId) : 0;
    if (!epoch) {
      throw new PersonalSyncError(
        `personal sync: the key ring holds no key for ${spaceId}. Nothing is pushed unencrypted, ever.`,
        'key');
    }
    const env = await sealOp(op, d.keyring, d.sigPriv, {
      v: 1, sp: spaceId, ep: epoch, dv: deviceShort, oid: op.id, wit: witness.witness(spaceId),
    }, { ...ports, ...(d.attestation ? { attestation: d.attestation } : {}) });
    sealed.set(op.id, env);
    return env;
  }

  // ── push ───────────────────────────────────────────────────────────────────

  /**
   * Drain the outbox in `LIMITS.opsPerPush` batches (§3.1, §6.1).
   *
   * `accepted` and `duplicate` are treated IDENTICALLY — both mean "the server has it" — which is
   * what makes at-least-once delivery sufficient and exactly-once unnecessary (§3.1). Everything
   * either list names is handed to `store.ackPushed`, which records the seq in the log, which
   * rides in `checkpoint().seqs`, which is what stops the op being offered again after a
   * relaunch.
   *
   * @returns {Promise<{pushed:number, batches:number}>}
   */
  async function pushNow() {
    if (store.personalSpaceId && store.personalSpaceId() === null) return { pushed: 0, batches: 0 };
    // FINDING E5-3 — the lower verb answers the same way the higher one does.
    //
    // `syncNow()` consults `isOnline()` first and returns `{skipped:'offline'}` (ADR 003 §8.2:
    // "offline → stop scheduling and queue in ops.jsonl"). `pushNow()` did not, so a caller that
    // reached for the lower verb — the debounce timer at `bump()`, `flush()` on pagehide, or a
    // test — got a REJECTED PROMISE where the higher one got a value, and the rejection was a
    // `NetError('transport')` raised from inside the transport rather than a decision this layer
    // made. Two verbs, two answers to one question, and the one that fires on every quit was the
    // one that threw. The queue is intact either way; what differs is whether the caller has to
    // know that.
    if (!isOnline()) { emitStatus(); return { pushed: 0, batches: 0, skipped: 'offline' }; }
    await loadSealed();
    let pushed = 0;
    let batches = 0;
    for (;;) {
      const lines = store.outbox({ limit: LIMITS.opsPerPush });
      if (!lines.length) break;

      const envelopes = [];
      const oids = [];
      for (const line of lines) {
        // A quarantined op stays in the LOG and on the BOARD — nothing is ever deleted for a
        // transport failure (principle 6) — but it is never offered again. Without this the
        // outbox, which is derived from the log and so cannot "remove" anything, would re-offer a
        // permanently refused op on every push for the life of the install.
        if (quarantined.has(line.op.id)) continue;
        let env;
        try {
          env = await sealLine(line.op);
        } catch (e) {
          // An op THIS BUILD would refuse to seal is one no peer could ever open. It is
          // quarantined rather than retried for ever — and it stays in the log and on screen,
          // because a board entry is never deleted for a transport failure (principle 6).
          quarantined.set(line.op.id, { seq: null, reason: `seal: ${e.message}` });
          stats.opsQuarantined += 1;
          if (typeof store._warn === 'function') {
            store._warn(`sync: an op could not be sealed and will not be uploaded (${e.message}). `
              + 'It is still on your board and still in board.json.');
          }
          continue;
        }
        envelopes.push(env);
        oids.push(line.op.id);
      }
      if (!envelopes.length) break;
      // Durable BEFORE the push, never after: an envelope that reached the relay and whose bytes
      // this device then forgot is exactly the 409 above.
      await saveSealed();

      const res = normalizeResponse(await transport.request('POST', '/api/v1/ops', {}, {
        space: spaceId,
        ackSeq: store.cursor(spaceId),
        ops: envelopes,
        // ADR 001 §7.3 condition 3 / server E2-202-E: "the outbox was empty at this moment" is a
        // claim only the client can make, and getting it wrong resurrects deleted entries. It is
        // therefore made only when this batch is the last one.
        drained: envelopes.length < LIMITS.opsPerPush,
      }, {}));

      noteProtocol(res);
      if (res.status !== 200) {
        stats.consecutiveFailures += 1;
        stats.lastError = errorOf(res);
        if (res.status === 409) {
          // `forked_op_id` — the relay already holds DIFFERENT BYTES under one of these ids.
          //
          // ADR 003 §3.1 tells the client to treat this as local corruption and re-mint with a
          // fresh opId. This engine cannot re-mint: the op is in the log, `core/ops.js` owns op
          // identity, and an op's id is inside the ciphertext its peers have already read. So the
          // damage is BOUNDED instead: only the named `oid` is quarantined (the response carries
          // it), the rest of the batch is retried on the next push, and the user is told in a
          // sentence that is true — the board is unchanged and the entry is still there.
          //
          // The one benign cause of this is a re-seal after a relaunch (see `sealed` above), and
          // it is why `envelopeStore` exists. If this ever fires in the field WITH an
          // `envelopeStore` wired, it is the malicious case ADR 003 §3.1 is about.
          const forked = res.json && typeof res.json.oid === 'string' ? [res.json.oid] : oids;
          for (const id of forked) quarantined.set(id, { seq: null, reason: 'forked_op_id' });
          stats.opsQuarantined += forked.length;
          if (typeof store._warn === 'function') {
            store._warn('sync: the relay already holds a different change under one of these ids '
              + '(forked_op_id). Nothing was uploaded and your board is unchanged.');
          }
        }
        emitStatus();
        return { pushed, batches };
      }

      const body = res.json || {};
      const acks = [...(body.accepted || []), ...(body.duplicate || [])]
        .filter((a) => a && typeof a.oid === 'string' && toSeq(a.seq) !== null);
      store.ackPushed(acks);
      // THE CACHE IS PRUNED AGAINST THE OUTBOX, NOT AGAINST THE ACK LIST — and the difference is
      // a real failure mode. ADR 003 §8.1: "an entry is removed only after the server reports it
      // in `accepted` OR `duplicate`". Deleting on the ack LIST assumes the store took the ack;
      // if it did not (a full disk, a refused seq, a crash between the two), the op stays in the
      // outbox with its seal thrown away, and the very next push re-seals it into a 409. Deriving
      // the cache from the outbox makes it self-healing: it holds exactly what is still owed.
      pruneSealed();
      await saveSealed();
      pushed += acks.length;
      batches += 1;
      stats.opsPushed += acks.length;
      stats.consecutiveFailures = 0;
      stats.lastError = null;
      stats.lastPushAt = d.now();

      // No progress means the server accepted nothing this device can retire. Stopping is the
      // only safe answer: looping would be an infinite push of the same batch.
      if (!acks.length) break;
      if (envelopes.length < LIMITS.opsPerPush) break;
    }
    stats.pushes += batches;
    emitStatus();
    return { pushed, batches };
  }

  // ── pull ───────────────────────────────────────────────────────────────────

  /**
   * One pull pass: fetch from the cursor, open, fold, persist, then advance.
   *
   * THE ORDER IS THE INVARIANT (ADR 003 §3.3 + ADR 006 §9.1 W1) and it is:
   *
   *    open ──▶ store.applyRemote ──▶ await store.persistNow() ──▶ store.noteCursor
   *
   * A crash before `persistNow` loses the fold and the cursor together — the ops are re-pulled.
   * A crash between `saveBoardText` and the checkpoint inside `persistNow` keeps the CONTENT
   * (board.json is the commit point) and loses the cursor — the ops are re-pulled and are
   * idempotent by `opId`. There is no ordering of these three that loses an op, and there is
   * exactly one that never leaves the cursor ahead of the board. This is it.
   *
   * @returns {Promise<{applied:number, deferred:number, cursor:string, hasMore:boolean}>}
   */
  async function pullNow() {
    await loadLot();
    // ── R10-9d · A NEW PULL, SO THE LOT'S "STILL CANNOT OPEN THIS" MARKS START EMPTY ──────────
    //
    // `lot.release()` shelves rather than destroys any oid the caller PARKED OR TOUCHED "since
    // its last release" — R8-4's guard, and the safe direction: it can only ever retain an
    // envelope it could have destroyed. The window is the bug. `unopened` is cleared inside
    // `release()` and nowhere else, so in a session where nothing applies for several pulls the
    // marks ACCUMULATE — and the pull where the cure finally lands releases an op that opened
    // while it is still carrying four pulls' worth of "cannot open this".
    //
    // The consequence is F-6's ordinary story: first contact parks an op, the attestation lands a
    // few pulls later, the op opens and applies — and its envelope goes on the shelf anyway, with
    // `shelved()` reporting for ever that nothing will ever open bytes whose op is on the board.
    // `round8-park.test.js` §6.2 models the pull boundary with a FRESH LOT and says so in its own
    // comment ("the marks do not outlive a release"); this line is what makes that assumption
    // true of the engine rather than only of the test.
    //
    // It was invisible while nothing read the shelf. It became a user-visible permanent `error`
    // the moment `status()` began offering the shelf to `judgeSyncStatus`, which is why it is
    // fixed in the same pass and not filed: shipping the observable over this would have put a red
    // light on every Mac that ever paired slowly once.
    //
    // NO NEW API, deliberately: `release()` clears `unopened` BEFORE its `n === 0` early return,
    // so an empty release is exactly "a new round starts here" and nothing else — no write, no
    // persist, no state change. `refuse()` is untouched, and so is the retention it performs.
    await lot.release(spaceId, []);
    const since = store.cursor(spaceId);
    const res = normalizeResponse(await transport.request('GET', '/api/v1/ops', {
      space: spaceId, since, limit: String(LIMITS.opsPerPull),
    }, null, {}));
    noteProtocol(res);
    if (res.status !== 200) {
      stats.consecutiveFailures += 1;
      stats.lastError = errorOf(res);
      emitStatus();
      return { applied: 0, deferred: deferred.size, cursor: since, hasMore: false };
    }
    stats.consecutiveFailures = 0;
    stats.lastError = null;
    stats.pulls += 1;
    stats.lastPullAt = d.now();

    const body = res.json || {};
    const page = Array.isArray(body.ops) ? body.ops : [];

    // ── P-4 · ADR 002 §5.4 — THE RELAY'S OWN CLAIMS MUST ADD UP ──────────────
    //
    // Every envelope in the page is individually authenticated: P3 checks the author's signature
    // and AES-GCM checks the AAD, so a relay CANNOT forge, re-attribute or alter one. What a
    // relay CAN do, and what nothing here checked before, is lie by OMISSION and by ORDER —
    // withhold an op from one device, renumber a page, serve two devices two different streams.
    // ADR 002 §5.4 names exactly one mechanism for that and `sync/chain.js` implements it; until
    // this line it was imported by nothing in `src/`, so the fork was undetectable and
    // `sync-domains.js`'s `S4-diverged` could be closed by nothing at all.
    //
    // TWO CHECKS, and they catch different halves:
    //
    //   1. THE WITNESS — `createChainWitness().observe(space, rows)`, which folds the page into
    //      the head this device has verified. Catches a hole INSIDE a page, a re-ordering, a
    //      fabricated `chain` value, and a stream re-chained across a relaunch.
    //   2. THE PAGE CLAIM. `server/core/handlers/ops.js` is explicit that "`nextCursor` is the seq
    //      of the last op ACTUALLY RETURNED, and when the page is empty it is `since`". A
    //      `nextCursor` past the last row served is the relay telling this device to step over
    //      rows it never sent — which is the withhold that leaves no hole to find, because the
    //      hole is at the END of the page. That is the shape `S4-diverged` measures, and it is
    //      the ONLY one of the two that can also cause a loss, so it is the only one that touches
    //      the cursor UNCONDITIONALLY.
    //
    // NEITHER CHECK REFUSES THE OPS. The rows that did arrive are authentic and applying them
    // loses nothing; refusing them would hand a hostile relay a way to wedge the device with one
    // bad `chain` byte.
    //
    // ── R8-1 / R8-2 · WHAT A CHAIN FINDING IS ALLOWED TO DO TO THE CURSOR ────────────────────
    //
    // ADR 002 §5.4 spends one sentence on this and round 8 crossed it: the witness is
    // "detection-only, best-effort, and it NEVER BLOCKS SYNC in v2 (a false positive that broke a
    // family's board would be far worse than the attack)". Round 8 turned every finding into a
    // PERMANENT cursor hold, and a permanent hold on an unfillable hole is a wedge: after the one
    // legitimate destructive operation in the product — `POST /members/remove`, which purges the
    // removed member's op rows (ADR 003 §6.3, story 20.2) — the rows the hold waits for are gone
    // BY DESIGN, so the cursor stopped at the hole for ever and every op above it was lost on an
    // honest relay (R8-2).
    //
    // The rule now is the one `chain.js` was built around, and it is a rule about WHO OWNS THE
    // HOLD rather than about which findings are believed:
    //
    //   · a NEW break holds the cursor for the pull that found it, and for that pull only. That
    //     is one honest round trip in which a relay that truncated a page, raced a write or
    //     re-ordered two pages can serve what it says it owes — and it is what keeps a withheld
    //     op below the cursor while the relay is still lying (`fleet-harness.test.js` §2a);
    //   · the witness then RE-ANCHORS on the row it was served and the break is not re-armed:
    //     the same rows re-served are at or below the head, `observe`'s `fresh` filter drops them,
    //     and no second finding is manufactured. So sync resumes, which is what the ADR requires
    //     and what makes a purge survivable rather than terminal;
    //   · the FINDING outlives the hold. `store.syncChain` carries it, the witness is `broken`
    //     for the rest of the space's life, and detection continues from the new anchor — the
    //     honest ceiling `chain.js`'s header names: "provable since the last anchor".
    //
    // What this costs against a relay that withholds one row in the MIDDLE of a page and keeps
    // withholding it: it consumes that row on the second poll rather than never. The alternative
    // is the wedge above, and the protocol offers no third option — `GET /ops` can only be asked
    // "everything after `since`", so "keep asking for the hole" and "block every later op" are the
    // same request. **Reported: ADR 003 §4 needs a way to re-request one seq.** The end-withhold,
    // which is the shape that can also move the cursor by a LIE rather than by a gap, is still
    // refused unconditionally by check 2 below on every pull, for ever.
    //
    // ── R10-1 · THE ROW SHAPE IS `observe()`'s, NOT A SUBSET OF IT ───────────────────────────
    //
    // `observe(space, rows)` documents its input as `{seq, chain, env:{oid, wit, dv}}` and its
    // cross-check loop reads `row.env.wit` — the value each PEER committed to when it authored the
    // op. Round 9 handed it `{seq, chain, env:{oid}}`, so check 2 had no input even for a peer that
    // had sealed one, and neither `unknownWitness` nor its honest weaker sibling could ever fire.
    // `wit` and `dv` are relay data and are copied WITHOUT validation on purpose: `chain.js` treats
    // a `wit` it cannot place as a finding, never as a throw, and `dv` only ever appears inside a
    // diagnostic. Passing them is the whole of the fix at this end.
    const rows = [];
    for (const e of page) {
      if (e && typeof e.oid === 'string' && e.seq !== undefined) {
        rows.push({ seq: String(e.seq), chain: e.chain, env: { oid: e.oid, wit: e.wit, dv: e.dv } });
      }
    }
    // WHERE THE VERIFICATION STARTS, AND WHY IT IS NOT ALWAYS ROW ZERO.
    //
    // A witness with no head verifies from the space's GENESIS — it computes `SHA-256(∅ ‖ oid)`
    // for the first row. That is right for a device pulling from `since = 0` and WRONG for every
    // other page: a device resuming at seq 40 is handed a row whose chain is
    // `SHA-256(chain₃₉ ‖ oid₄₀)`, which cannot match, and reporting a fork there would accuse an
    // honest relay on the first pull after every relaunch. `chain.js`'s own answer to an anchor it
    // cannot use is "re-anchor on the next row rather than reporting a fork this device cannot
    // prove", and this is the same rule one layer up: with no head and a page that does not start
    // at genesis, the FIRST row is RESTORED as the head — the witness's own re-entry point — and
    // the links after it are checked.
    //
    // What that costs is exactly one unverifiable row per session, and it is the row the device
    // has no evidence about. It is not a hole a relay can widen: every LATER row in the page and
    // in the session is checked against it, and `restore(…, false)` withholds the right to call an
    // unknown witness a fork, because this device has not pulled from genesis.
    if (witness.head(spaceId) === null && rows.length && (toSeq(since) ?? 0n) !== 0n) {
      witness.restore(spaceId, { seq: rows[0].seq, chain: rows[0].chain }, false);
    }
    const headBefore = witness.head(spaceId);
    /** The first seq of each run the relay did not serve. Turned into ONE cursor hold below. */
    const chainHoles = [];
    let found = [];
    try {
      found = await witness.observe(spaceId, rows);
    } catch (err) {
      // `chain.js` promises never to throw, and a promise is not a proof: a broken `subtle` port
      // reaches it through `digest`. A detector that dies takes the pull with it, so it is caught
      // and reported as what it is — something this device could not check, not a fork.
      found = [{ kind: 'unreadable', detail: `${err.name}: ${err.message}` }];
    }
    const headAfter = witness.head(spaceId);
    // POSITIVE EVIDENCE means rows this device had never folded were folded and verified. A page
    // whose every row is at or below the head proves nothing new — it is the honest re-serve of a
    // held page (R8-1a), and treating it as proof would let a relay clear a verdict by repeating
    // itself. So the head must have MOVED.
    const foldedFresh = headAfter !== null
      && (headBefore === null || (toSeq(headAfter.seq) ?? 0n) > (toSeq(headBefore.seq) ?? 0n));
    // THE SECOND SHAPE OF POSITIVE EVIDENCE: a row this device was told it was owed has arrived.
    // A withhold that heals delivers the missing row BELOW the head the witness re-anchored to, so
    // the witness says nothing about it and `foldedFresh` cannot see it. Delivery is still proof —
    // the accusation was "this row is missing" and the row is here.
    let owedFilled = false;
    for (const r of rows) {
      if (chainOwed.delete(r.seq)) owedFilled = true;
    }
    // ⚠ R10-2 · THE DEBT IS NOT IN THIS EXPRESSION, AND THAT IS A REPORTED BLOCKER, NOT AN
    // OVERSIGHT. Round 10's adversary asks for `&& chainOwed.size === 0` here, so that a relay
    // withholding one appointment for ever cannot go green two honest pages later. The clause is
    // correct about the attack and it is **unshippable on its own**: a member purge (ADR 003 §6.3)
    // produces a gap of exactly the same shape, its rows are gone BY DESIGN, and the debt can then
    // never be discharged — so the clause turns the one legitimate destructive operation in the
    // product into the permanent red light `chain.js`'s header forbids in as many words. Measured,
    // not argued: with the clause in place `round8-chain.test.js` §2 fails on *"the red light
    // `chain.js` forbids is out"* (`'error' !== 'healthy'`) and `round9-headline.test.js` §2b fails
    // on *"the indicator is OUT"*, both after a purge that withholds nothing from anybody.
    //
    // The two events are byte-for-byte indistinguishable at this client — that is round 10's own
    // R10-4, pinned field by field in `round9-witness.test.js` §4a — so no rule computed from the
    // findings can hold the verdict for one and release it for the other. Closing R10-2 therefore
    // needs a SECOND input, and §4b names the only one that arrives: the roster piggyback ADR 003
    // §3.2 puts on every pull response, whose `Member.removedAt` says a removal really happened.
    // `protocol.js`'s total pull-body reader already surfaces it; this path reads neither. Neither
    // the field nor that reader is spelled here the way `round9-e6.test.js` §2 and
    // `round9-witness.test.js` §4b grep for them — those rows assert this file does not TOUCH
    // them, they are still open, and a mention in a comment is not a call site.
    //
    // **REPORTED: R10-2 is blocked on R10-4, and even R10-4 does not finish it.** Both purge rows
    // delete op rows with no membership write at all, so the roster is silent there too, and a PO
    // has to rule on which way the light goes for a hole with no corroboration of any kind.
    //
    // ── R10-1b · A FINDING THAT SAYS "NOT EVIDENCE" MAY NOT BE READ AS EVIDENCE ──────────────
    //
    // `unverifiableWitness` is the witness declining to judge: *"a peer committed to a chain value
    // outside this device's own chain window. **Not evidence**"*. It is emitted whenever this
    // device's window does not reach back far enough to place a peer's `wit` — after a relaunch,
    // after a break, past the 4096-value memory bound — which is to say on an honest relay, in
    // ordinary use, whenever one Mac is further behind than another.
    //
    // `store.syncChain` is a FLAG in `status.js`'s taxonomy (`shape: 'flag'`, `state: error`), so
    // writing anything into it lights S4-diverged. Handing it a finding whose own text says it
    // proves nothing is exactly the shape of alarm this round exists to avoid: MEASURED, before
    // this split, as `round9-headline.test.js` §2b going red on *"the indicator is OUT"* — three
    // honest Macs, a legitimate member purge, and a red light nobody can clear.
    //
    // So the verdict is computed from EVIDENCE, and the declined judgements ride along in the
    // payload of a verdict something else created. When they are all there is, nothing is written.
    // **Reported: `status.js` and `store.js` have no channel for "seen, not evidence"** — an
    // observable that counts without forcing `error`, or an `ok: true` shape `presenceOf` reads as
    // absent. Until one exists this diagnostic is visible only through `witness.snapshot()`.
    const evidence = found.filter((f) => f && f.kind !== CHAIN_FINDINGS.UNVERIFIABLE_WITNESS);
    const chainVerified = (foldedFresh || owedFilled) && evidence.length === 0;
    if (evidence.length) noteChain('chain', found);
    // A GAP finding carries the seq the counter jumped FROM, so the first row the relay owes is
    // the next one. Anything else the witness reports (a mismatch, an unreadable chain value) is a
    // statement about a row that WAS served, and the cursor is left to the ordinary rule.
    //
    // ── R10-2b · AND THE GENESIS PAGE IS DEFENDED THE WAY EVERY LATER PAGE IS ────────────────
    //
    // A device with no anchor verifies its first page from the space's GENESIS: row zero is checked
    // as `SHA-256(∅ ‖ oid)`. Withhold the FIRST row of the log from such a device and the break
    // lands on row zero, where there is no `prevSeq` for §3.3's gapless rule to be violated against
    // — so the witness reports a MISMATCH, a mismatch carries no `from`, and until this clause the
    // cursor was not held at all. The relay could pick the shape of the finding by picking which
    // row to withhold, and the shape that cost it nothing was always available.
    //
    // That is the position E6 creates constantly and by design — a new member, a new Mac, a
    // restored backup all start at `since = 0` — which is why *the least defended pull in the
    // product was the one every new device makes first*.
    //
    // The hold is the SAME hold, with the same bound: one honest round trip, for the pull that
    // discovered the break and for that pull only. The witness re-anchors on the row it was served,
    // the re-served page is at or below the new head, `observe`'s `fresh` filter drops it, no second
    // finding is manufactured, and the cursor moves. So a purge that removed the OLDEST rows of a
    // space — which produces exactly this mismatch on a device pulling from zero — costs one pull
    // and not a wedge, and R8-2's rule is not re-crossed.
    //
    // It is deliberately narrow: only the FIRST row of a page verified from genesis. A mismatch
    // anywhere else is a statement about a row that WAS served, its neighbours pin it, and holding
    // the cursor under it would hand a hostile relay a wedge for one rewritten byte.
    const genesisPage = headBefore === null && rows.length > 0;
    for (const fi of found) {
      const from = fi && fi.from !== undefined ? toSeq(fi.from) : null;
      if (from !== null) {
        chainHoles.push(from + 1n);
        chainOwed.add(String(from + 1n));
        while (chainOwed.size > CHAIN_SEQ_MEMORY) chainOwed.delete(chainOwed.values().next().value);
        continue;
      }
      if (!genesisPage || fi.kind !== CHAIN_FINDINGS.MISMATCH) continue;
      const brokeAt = toSeq(fi.seq);
      if (brokeAt === null || String(fi.seq) !== String(rows[0].seq)) continue;
      chainHoles.push(brokeAt);
    }
    // The chain values, by the seq they belong to, so the durable anchor is ONE ROW (R8-1b).
    for (const r of rows) {
      if (typeof r.chain === 'string' && r.chain !== '') chainBySeq.set(r.seq, r.chain);
    }
    while (chainBySeq.size > CHAIN_SEQ_MEMORY) chainBySeq.delete(chainBySeq.keys().next().value);
    // The page claim. `served` is the last row the relay actually handed over; `claimed` is where
    // it says the cursor may go. On an honest relay these are equal, or the page is empty and
    // `claimed === since`, so this never fires — measured by every green fleet row.
    const served = rows.length ? toSeq(rows[rows.length - 1].seq) : null;
    const claimed = toSeq(body.nextCursor);
    const claimFloor = served === null ? (toSeq(since) ?? 0n) : served;
    const claimSound = claimed === null || claimed <= claimFloor;
    if (!claimSound) {
      chainHoles.push(claimFloor + 1n);
      noteChain('withheld', [{
        kind: 'withheld',
        seq: String(body.nextCursor),
        from: String(claimFloor),
        detail: `the relay served ${rows.length} row(s) up to seq ${claimFloor} and asked this `
          + `device to move its cursor to ${body.nextCursor}. ADR 003 §3.3 makes the counter `
          + 'gapless per space and the ops handler sets nextCursor to the last op actually '
          + 'returned, so rows between those two seqs were withheld from THIS device. The cursor '
          + 'is held below them; the relay still has them.',
        benignCause: 'member-purge',
      }]);
    }
    // A fork that healed is not a fork — but only POSITIVE evidence clears the verdict. An empty
    // page is not evidence of anything, and a relay that answers `{ops: []}` for ever must not be
    // able to erase what it was caught doing by saying nothing.
    if (chainVerified && claimSound && 'syncChain' in store) store.syncChain = null;

    // ── the re-try set comes FIRST, and in seq order ─────────────────────────
    // A deferred envelope and a fresh one are the same kind of thing; merging them here means the
    // F-6 case where the attestation arrives in a LATER page is handled by exactly the code that
    // handles the same-batch case, rather than by a second path nobody exercises.
    /** @type {Array<{env:Object, seq:bigint, retry:boolean}>} */
    const work = [];
    for (const [, held] of deferred) {
      // A DORMANT hold is not re-tried within this session. It is an envelope only a NEW BINARY
      // can open — `PARK_HANDLING`'s `curedBy: 'update'` — so re-running `openOp` over the same
      // bytes with the same build costs one AES call and always answers the same way. It is
      // re-judged once per session, when `loadLot()` seeds it off the disk, which is exactly
      // "the launch after the app was updated".
      if (held.dormant) continue;
      work.push({ env: held.env, seq: held.seq, retry: true });
    }
    for (const e of page) {
      const seq = toSeq(e && e.seq);
      if (seq === null) continue;                      // a row the relay could not frame; never silent
      if (deferred.has(e.oid) || quarantined.has(e.oid)) continue;
      work.push({ env: e, seq, retry: false });
    }
    work.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

    const opened = [];
    const seqs = Object.create(null);
    /** seq → why it is held. The cursor stops BELOW the smallest of these. */
    const holds = new Map();
    /** What this pull owes the DURABLE park, flushed once below rather than inside the loop. */
    const toPark = [];
    /**
     * The holds that ENDED without the op ever opening — the ladder's casualties and every other
     * `terminal()`. R8-4's closing move: these go to `lot.refuse()`, which SHELVES the bytes, and
     * not to `lot.release()`, which destroys them.
     *
     * `release()`'s own `unopened` guard reaches the same state, and it reaches it by inference —
     * it works because `pullNow` flushes `toPark` before it releases, so an envelope this pull
     * parked is still marked unopened when the release walks past it. That coupling is invisible
     * at the two flush sites and would break silently if they were ever reordered. `refuse()` says
     * the transition out loud instead, so the guard is a belt behind braces rather than the only
     * thing standing between a ladder and a drop.
     * @type {Array<{oid:string, reason:string}>}
     */
    const toRefuse = [];
    // ── P-4 · THE HOLE THE WITNESS FOUND, AS A CURSOR HOLD ───────────────────
    //
    // Naming the fork is not enough on its own: `seq` is gapless per space (ADR 003 §3.3), so a
    // hole means rows were withheld, and the rows ABOVE the hole are still served. Without this,
    // the commit loop below walks right over the missing seq on the strength of the ones after
    // it — the withhold-in-the-middle, which is the same permanent consumption as the
    // withhold-at-the-end and is not fixed by gating `nextCursor` alone.
    //
    // So the first missing seq becomes a HOLD, in the same structure every other hold uses, and
    // the commit stops strictly below it. The ops that DID arrive are still applied: ADR 002 §8.6
    // and ADR 003 §10.6 keep the witness diagnostic-only in v2, and this respects that — nothing
    // is refused on the witness's word. Only the cursor waits.
    //
    // ⚠ AND IT WAITS FOR ONE PULL, NOT FOR EVER — R8-2. `chainHoles` now carries only what the
    // WITNESS reported as NEW on this page: a break it had not already seen and re-anchored past.
    // That is the whole difference between a hold and a wedge. A relay that is still lying is
    // still owed the row on the next poll, which is what `fleet-harness.test.js` §2a measures; a
    // hole that cannot be filled because a member removal deleted the rows (ADR 003 §6.3) is
    // re-anchored past instead of waited on for the rest of the family's life. The page-claim
    // hold below is NOT part of this and does not expire: it is derived from a claim the relay
    // repeats on every page, so it is re-armed on every page.
    for (const chainHole of chainHoles) holds.set(chainHole, 'withheld');

    for (const item of work) {
      let out;
      try {
        out = await openOp(item.env, d.keyring, d.attestationOf, ports);
      } catch (e) {
        // A protocol violation — P2, P3, a failed AEAD, a non-canonical plaintext. `openOp`
        // throws only on those, and every one of them is FINAL: the bytes are what they are, and
        // re-pulling them cannot change the answer. Quarantine, report, and let the cursor past.
        terminal(item, `envelope: ${e.message}`);
        continue;
      }
      // ── P-8 · A PARK IS A DEFERRAL, FOR EVERY REASON, WITHOUT EXCEPTION ──────
      //
      // `openOp`'s contract is `{status:'park', parkReason, reason}` (`crypto/envelope.js` §5).
      // `status` is the discriminator and `parkReason` is the ENUM; `reason` is a sentence for a
      // human and is never compared against anything. Reading either of the other two fields is
      // what made this branch dead code for the whole of E5 — see `PARK_HANDLING` above.
      if (out && out.status === 'park') {
        parked(item, out.parkReason);
        continue;
      }
      const op = out && out.status === 'opened' ? out.op : (out && out.op ? out.op : out);
      if (!op || typeof op !== 'object' || typeof op.id !== 'string') {
        // NOT A PARK AND NOT AN OP. `openOp` has exactly three outcomes — opened, park, throw —
        // so reaching this line means the seam changed under this file. It is DEFERRED rather
        // than quarantined: an answer this build cannot read is the one case where destroying
        // the op is certainly wrong, and the ladder below still bounds it.
        parked(item, 'unreadableOutcome');
        continue;
      }
      opened.push({ op, item });
      seqs[op.id] = String(item.seq);
    }

    let applied = [];
    if (opened.length) {
      const r = store.applyRemote(opened.map((o) => o.op), { seqs });
      applied = Array.isArray(r?.applied) ? r.applied : [];
      const byId = new Map(opened.map((o) => [o.op.id, o.item]));
      const answered = new Set(applied);
      for (const ref of (r?.refused || [])) {
        if (ref && typeof ref.id === 'string') answered.add(ref.id);
        const item = byId.get(ref.id);
        if (!item) continue;
        if (isCurable(ref.reason)) defer(item, ref.reason);
        else terminal(item, `refused: ${ref.reason}`);
      }
      // ── THE THIRD ANSWER `applyRemote` CAN GIVE, WHICH IS NO ANSWER AT ALL ───────────────────
      //
      // `{applied, refused}` is meant to be a partition of the batch, and `store.js`'s shape gate
      // has one arm — "not a well-formed op" — that warns and reports NEITHER. Nothing `openOp`
      // returns can take it today (`isOpId(op.id)` has already run), which is exactly why it is
      // worth closing rather than trusting: an op that appears in neither list would slip past the
      // hold computation below and the cursor would be released over it, silently. Held, not
      // dropped, and the ladder bounds it.
      //
      // Like the unknown-park arm above, this is a REACHABILITY CLAIM and reverting it kills no
      // test. The claim is pinned instead: `tests/tier1/sync-personal.test.js` §4b's "`applyRemote`
      // answers for EVERY op it is handed" drives a mixed batch through the real store and asserts
      // the partition is total. If that ever stops being true, this becomes load-bearing.
      for (const o of opened) {
        if (!answered.has(o.op.id)) defer(o.item, 'notReported');
      }
      // Anything that WAS applied leaves the deferral set — including one that had been held for
      // several pulls, which is the F-6 cure landing.
      for (const id of applied) deferred.delete(id);
      stats.opsApplied += applied.length;
      // ── R8-4 · A CURED REFUSAL IS RETRACTED, IN THE SESSION AND ON DISK ─────────────────────
      //
      // The ladder gives up on an envelope whose attestation had not landed in `maxDeferrals`
      // pulls; `terminal()` above records that as a refusal and `lot.refuse()` shelves the bytes,
      // and the NEXT LAUNCH revives them — so the op that was reported as permanently diverged
      // arrives after all. Round 8's failure was reporting `healthy` while wrong; leaving the
      // ledger to say `error` for the rest of the device's life is the same failure with the sign
      // flipped, and an indicator that cannot go out is one nobody reads.
      //
      // Only the STORE's own `applied` list can clear it (`retractSyncRefusal`'s docblock says
      // why), so this is not a channel a relay can reach: it would have to make the op apply,
      // which is the cure.
      for (const id of applied) quarantined.delete(id);
      if (applied.length && typeof store.retractSyncRefusal === 'function') {
        try { store.retractSyncRefusal(applied); } catch { /* diagnostics may never break a pull */ }
      }
    }

    // ── THE DURABLE PARK IS WRITTEN BEFORE THE CURSOR MOVES ──────────────────
    //
    // Same ordering rule as W1 below and for the same reason: the cursor is a claim that this
    // device has consumed the op, and it may not be made until the op is somewhere a fresh
    // process can find it. The lot's `park()` RETURNS FALSE AT ITS CAP, and its own docblock is
    // explicit that "the caller MUST NOT advance the cursor past it" — so a refusal puts the seq
    // straight into `holds`, which is the one structure the cursor is computed from. A full lot
    // therefore STALLS this space, visibly, instead of losing an envelope.
    for (const p of toPark) {
      let kept = true;
      try { kept = await lot.park(spaceId, p.env, String(p.seq), p.reason); }
      catch { kept = false; }                 // the lot warns; an unwritable park is a stall
      if (!kept) holds.set(p.seq, `park-full:${p.reason}`);
    }
    // A hold that ended without the op opening RETAINS the envelope (R8-4).
    //
    // ⚠ NO REASON IS PASSED, AND THAT IS THE WHOLE CARE IN THIS LINE. `refuse(space, oids, reason)`
    // overwrites the shelved row's reason, and the shelf's reason is not prose for a human — it is
    // the ENUM the next launch re-judges the envelope by: `loadLot()` reads it back through
    // `parkHandlingOf(row.reason)` to decide `curedBy`, and `pullNow` warns about a reason this
    // build does not recognise. `terminal()`'s reason is a sentence ("still attestation after 5
    // attempts"), so writing it here would turn a revived `ENVELOPE_PARK.ATTESTATION` into an
    // unknown park on the very launch that was supposed to cure it. The sentence belongs in the
    // refusal LEDGER, where a human reads it, and `store.syncRefusals` already has it.
    for (const r of toRefuse) {
      try { await lot.refuse(spaceId, [r.oid]); } catch { /* next pull */ }
    }

    // ── W1: persist BEFORE the cursor moves ──────────────────────────────────
    if (applied.length) await store.persistNow();
    // An op that LANDED is not parked any more. Released after the board is committed, so a crash
    // between the two leaves the envelope retained rather than dropped — the safe direction.
    if (applied.length) { try { await lot.release(spaceId, applied); } catch { /* next pull */ } }

    // ── THE CURSOR RULE, MADE HONEST ─────────────────────────────────────────
    //
    //     THE CURSOR MAY NOT ADVANCE PAST AN OP THAT WAS NOT APPLIED — unless the op is retained
    //     somewhere this Mac can still reach (a hold) or the refusal is recorded (a quarantine).
    //
    // `holds` is that rule as data: every disposition that keeps neither the op nor a record puts
    // its seq in it, and the commit point stops strictly BELOW the smallest one. It is the whole
    // of ADR 006 §9.1's W1 on the receiving side — while the cursor is held the RELAY is the
    // durable copy, which is why "retain it" and "do not tell the server I have consumed it" are
    // the same statement, and why only the second one survives a quit.
    //
    // `nextCursor` may only be taken when NOTHING is held: it is the relay's claim about a page,
    // and a page whose middle is held is not a page this device has consumed.
    let commit = toSeq(since) ?? 0n;
    const floor = holds.size ? [...holds.keys()].reduce((a, b) => (a < b ? a : b)) : null;
    for (const item of work) {
      if (floor !== null && item.seq >= floor) break;
      if (item.seq > commit) commit = item.seq;
    }
    // `nextCursor` is the relay's claim and is only taken while that claim is SOUND — see the
    // page-claim check above. Unsound, the cursor stops at the last row this device was actually
    // handed, which is the whole of the defence: a withheld op stays below the cursor, so the
    // relay keeps owing it and the next honest page delivers it.
    const nextCursor = toSeq(body.nextCursor);
    if (floor === null && claimSound && nextCursor !== null && nextCursor > commit) commit = nextCursor;
    // ── R10-3 · THE RECORD IS ALSO WRITTEN ON THE PULL THAT HOLDS THE CURSOR ─────────────────
    //
    // `fromGenesis` is *"the RIGHT TO CALL AN UNKNOWN `wit` A FORK"* (`cursor.js`), and R9-1 made
    // it writable in both directions so a device cannot hand itself back a right it has given up.
    // The only writer is `cursors.advance`, and this call site ran it only when the cursor MOVED —
    // so the one pull that lowers the flag (a break, which sets `s.fromGenesis = false` inside the
    // witness) is exactly the pull whose cursor is held by that same break, and the lowering was
    // never written down. Quit there — which is what a person does when the indicator goes red —
    // and the next launch restores `true` and accuses the relay of a fork it can no longer prove.
    // That is the false positive ADR 002 §5.4 forbids, and it is why this had to land in the same
    // change as `wit`: wiring check 2 without it ARMS the accusation instead of enabling it.
    //
    // So the record is written when the cursor moves **or** when this pull disagrees with the disk
    // about the flag. Not on every pull: `advance()` persists unconditionally, and a write per
    // idle poll is churn with nothing to say.
    //
    // ⚠ AND THE HELD PULL MAY NOT WIPE THE ANCHOR. `advance` treats any `head.chain` STRING as the
    // value to store, `''` included — which is deliberate when the cursor moves to a row this
    // device holds no chain for (R8-1b: no anchor beats a wrong one). A pull that did not move is
    // making no claim about a new row, so it passes `null` and the stored chain is carried
    // forward; passing `{chain: ''}` there would erase a good anchor on every held pull and on the
    // first empty pull after a relaunch, when `chainBySeq` is still empty.
    const at = toSeq(since) ?? 0n;
    const fromGenesisNow = witness.snapshot()[spaceId]?.fromGenesis === true;
    if (commit > at || cursors.fromGenesis(spaceId) !== fromGenesisNow) {
      // The cursor move and the chain anchor, in ONE ordered write. `cursor.js`'s `advance` runs
      // the commit first and persists the record only if it resolves — so a crash between them
      // costs a re-pull (idempotent, ADR 001 §6) and never a cursor ahead of what was folded.
      // `store.noteCursor` inside the commit keeps the AUTHORITATIVE cursor exactly where W1 put
      // it: in the log, written by `_persistOps`, below the board.
      //
      // R8-1b — THE RECORD IS ONE ROW. `advance` writes `{seq, chain: head.chain}` and does not
      // check that the two are the same row; round 8 handed it the commit point and the chain of
      // the LAST ROW OF THE PAGE, which are the same row only when nothing in the page was held.
      // One parked op — F-6's ordinary first contact — was enough to persist a chain value for a
      // seq that never had it, and the next launch then accused an honest relay of forging the
      // value this device had invented. So the chain is looked up BY the commit seq, and when
      // this device does not hold one for that row it stores NO anchor rather than a wrong one:
      // `''` reads back as "no head" and the next page re-anchors, which accuses nobody.
      const anchorAt = chainBySeq.get(String(commit)) ?? '';
      const record = commit > at || anchorAt !== '' ? { seq: String(commit), chain: anchorAt } : null;
      await cursors.advance(
        spaceId, String(commit), record,
        async () => { store.noteCursor(spaceId, String(commit)); },
        { fromGenesis: fromGenesisNow },
      );
    }

    // ── L-3 · THE REAPER, ON THE ORDINARY SCHEDULE ───────────────────────────
    //
    // `store.unparkAttested()` re-judges a line held for a missing device attestation. It was
    // called from ONE place in the product — `family/mount.js`, on the adoption of a new peer —
    // so a hold whose cure arrived by any other route (a pairing that completed while the app was
    // closed, `useIdentity()` on the next launch, a peer list refreshed by `family/engine.js`)
    // was never looked at again. And the cure has to be looked for HERE, not only at launch: by
    // the time the ladder above has released the cursor the parked line is the only copy this Mac
    // can reach, and no batch will ever arrive to trigger `applyRemote`'s own sweep.
    //
    // It is a no-op with nothing parked, and it is deliberately AFTER the cursor: a launch that
    // promotes a line has changed the board, and the persist that follows is scheduled by
    // `unparkAttested` itself.
    if (typeof store.unparkAttested === 'function') {
      let promoted = [];
      try { promoted = store.unparkAttested() || []; }
      catch { /* the store warns; a reaper may not break a pull */ }
      if (promoted.length) {
        // W1 AGAIN, IN THE ONE PLACE IT IS EASY TO MISS. A promotion changes the board, and the
        // cursor is ALREADY past the op — the ladder released it, which is why the parked line
        // was the only copy. `unparkAttested` schedules a debounced persist; a quit inside that
        // debounce would leave the board without the entry and the cursor beyond it. It is
        // recoverable (the line is still parked on disk and the next launch's reaper re-does the
        // promotion), but "recoverable by accident" is what this round exists to stop, so the
        // commit is taken here, synchronously with the pull that caused it.
        await store.persistNow();
        // ── L-1, THE OTHER DIRECTION: A REFUSAL THAT WAS LATER RESOLVED IS NOT EVIDENCE ─────────
        //
        // The ladder's terminal is a statement about ONE DELIVERY — "six pulls and this envelope
        // still would not open" — and ADR 003 §8.2 requires it, because a cursor pinned behind one
        // op blocks every later op. It is NOT a statement that the op is lost: the STORE parked
        // the line independently, and that is exactly the copy this promotion just applied.
        //
        // Leaving the row in the ledger would light `error` for ever over an op that is on the
        // board. The ledger is evidence of a PERMANENT divergence and nothing else, so evidence
        // the world has falsified is withdrawn.
        if (Array.isArray(store.syncRefusals) && store.syncRefusals.length) {
          const landed = new Set(promoted);
          const kept = store.syncRefusals.filter((r) => !landed.has(r && r.oid));
          if (kept.length !== store.syncRefusals.length) {
            store.syncRefusals.length = 0;
            for (const r of kept) store.syncRefusals.push(r);
            await store.persistNow();
          }
        }
      }
    }

    emitStatus();
    return {
      applied: applied.length,
      deferred: deferred.size,
      cursor: store.cursor(spaceId),
      hasMore: body.hasMore === true,
    };

    /**
     * P-8's landing point: ONE entry per `openOp` park reason, decided from `PARK_HANDLING`
     * rather than from a branch, and never a drop.
     *
     * Both `curedBy` classes defer and hold the cursor. They differ only in what the engine says
     * about them, because they differ only in what would have to happen for a re-open to answer
     * differently — and telling a user "held until you update the app" is a different sentence
     * from "held until your other Mac finishes pairing".
     */
    //
    // ⚠ THE UNKNOWN-REASON ARM IS A REACHABILITY CLAIM, NOT A LIVE BRANCH — labelled as such
    // after mutation testing, because reverting it to `terminal()` kills NO test. `openOp` emits
    // only the six values of `ENVELOPE_PARK` today (`validateOp` in `core/ops.js` can produce
    // `VERSION`, `UNKNOWN_SPACE`, `UNKNOWN_KIND` and `UNKNOWN_FIELD`, and `openOp` adds P1 and
    // P4), so no input reaches it. What is pinned is the CLAIM: `tests/tier1/sync-personal.test.js`
    // §4b asserts `PARK_HANDLING`'s keys are exactly `ENVELOPE_PARK`'s values, so a seventh reason
    // is a red test here rather than a destroyed op in the field. The day one exists this arm
    // becomes load-bearing, which is why it stays.
    function parked(item, parkReason) {
      const h = parkHandlingOf(parkReason);
      if (!h.known && typeof store._warn === 'function' && !warnedParks.has(parkReason)) {
        warnedParks.add(parkReason);
        store._warn(
          `sync: a change from your other Mac is being held for a reason this version does not `
          + `recognise (${parkReason}). It is kept, not discarded; updating the app should let it in.`);
      }
      // THE ENVELOPE ITSELF IS RETAINED, not just a note that it exists. `defer` puts it in the
      // session `Map` and holds the cursor; this puts the BYTES somewhere a fresh process can
      // find them, with the reason, which is what makes "a park is a deferral" true across a
      // quit and across the cursor release the ladder eventually performs.
      toPark.push({ env: envelopeOnly(item.env), seq: item.seq, reason: parkReason });
      defer(item, parkReason, h.curedBy);
    }

    /**
     * @param {Object} item @param {string} why the ENUM — a park reason or a rejection code
     * @param {'session'|'update'} [curedBy] what has to happen before re-judging can differ.
     *   `'session'` for every REFUSAL (`CURABLE_REFUSALS` is by definition "a later op cures it")
     *   and for the two anomaly holds; a park brings its own from `PARK_HANDLING`.
     */
    function defer(item, why, curedBy = 'session') {
      const oid = keyOf(item);
      const prev = deferred.get(oid);
      const tries = (prev ? prev.tries : 0) + 1;
      // ── THE TWO KINDS OF HOLD, AND WHY ONLY ONE OF THEM PINS THE CURSOR ─────────────────────
      //
      // `PARK_HANDLING` splits every park reason by what would have to happen in the world before
      // re-opening the envelope could answer differently. `'session'` — a later page, a pairing, a
      // key fetch — is cured by waiting, so the cursor is held below it and the relay keeps the op.
      // `'update'` is cured by a NEW BINARY and by nothing else, and ADR 003 §8.2 forbids a cursor
      // pinned behind one of those: a single `v: 99` envelope would block every later op on the
      // space until the user updates, which is also how a hostile relay would wedge this device.
      //
      // Releasing the cursor is only safe once the envelope is retained DURABLY — after the
      // release the parked copy is the only one this Mac can reach. That is what `lot` now
      // provides, and the condition is the LOT'S OWN ANSWER about itself (`durable`), not an
      // assumption: with no `parkStore` injected the retention is per-session, and the cursor is
      // held exactly as it was before. Between two silent losses this file still takes the
      // recoverable one; it just no longer has to.
      const dormant = curedBy === 'update' && lot.diagnostics().durable === true;
      if (!dormant && tries > maxDeferrals) {
        // ADR 003 §8.2 — "a permanently rejected op must never silently spin forever", and a
        // cursor pinned behind one op blocks every later op on the space, which is also how a
        // hostile relay would wedge this device with a single unreadable envelope. So the hold is
        // BOUNDED, and its end is a visible quarantine rather than silence.
        //
        // The ladder does not apply to a DORMANT hold, and must not: nothing is spinning. The
        // cursor has moved on, the envelope is on disk with its reason, and the thing it is
        // waiting for is an app update rather than a message. Burning six pulls and then
        // quarantining it would destroy precisely the op ADR 003 §4 promises to keep ("an old
        // client in a family with a newer one degrades to *does not show the new thing* instead
        // of *loses the new thing*").
        deferred.delete(oid);
        terminal(item, `still ${why} after ${maxDeferrals} attempts`);
        return;
      }
      deferred.set(oid, { env: item.env, seq: item.seq, tries, why, curedBy, dormant });
      if (!dormant) holds.set(item.seq, why);
      if (!prev) stats.opsDeferred += 1;
    }

    function terminal(item, reason) {
      const oid = keyOf(item);
      deferred.delete(oid);
      // A terminal is FINAL, so the retained bytes are no longer a deferral and must not be
      // replayed on every launch for ever. The RECORD of the refusal replaces them, below.
      //
      // R8-4 — AND "not replayed" IS NOT "destroyed". The ladder's own casualty is the op whose
      // attestation had not landed within `maxDeferrals` pulls, and the attestation lands minutes
      // later on an ordinary honest relay. `refuse()` takes it out of the replay set and keeps the
      // sealed bytes on the shelf, where the next launch gives it `PARK_REVIVALS` more chances.
      // The refusal below is still recorded, and it is retracted if the revival ever applies.
      toRefuse.push({ oid, reason });
      quarantined.set(oid, { seq: String(item.seq), reason });
      stats.opsQuarantined += 1;
      // ── L-1 · THE RECORD OF A REFUSAL OUTLIVES THE REFUSAL ───────────────────────────────────
      //
      // The refusal above is CORRECT and final, and the cursor is released past it, so the relay
      // will never offer the op again — which makes this record the only thing left. Keeping it
      // in the `Map` two lines up means it is visible for minutes and then, after one relaunch,
      // the permanent divergence is reported as `healthy` with nothing on disk that remembers it.
      //
      // `store.syncRefusals` is the store's own seam for it: `store.diagnostics().sync.refused`
      // counts this array, and `sync/status.js`'s `S4-refused` row reads that count. The write is
      // GUARDED rather than initialising — `src/js/store.js` belongs to another owner this round
      // and an engine that creates fields on the store it was injected with is how two files stop
      // agreeing about what the store is. Absent the array this is a no-op and the session `Map`
      // is all there is, which is today's behaviour exactly.
      //
      // **OWED, and reported rather than reached for: `store.js` must (a) create `syncRefusals`
      // and (b) PERSIST it.** An array on a store instance dies with the process just as this Map
      // does, so until it rides in the checkpoint, L-1 is narrowed and not closed.
      if (Array.isArray(store.syncRefusals)) {
        store.syncRefusals.push({ oid, seq: String(item.seq), reason, at: d.now() });
      }
      if (typeof store._warn === 'function') {
        store._warn(`sync: one change from your other Mac could not be applied (${reason}). `
          + 'It is not lost on the device that made it; nothing here was changed.');
      }
    }

    /**
     * The key an envelope is remembered under.
     *
     * `env.oid` when there is one — that is the identity every other layer uses. An envelope with
     * NO `oid` at all is the one cell of the fate grid nothing in this product could report: the
     * old `terminal()` was guarded on `typeof oid === 'string'`, so a header-less envelope was
     * dropped with the cursor released and WITHOUT a record in the session either. It is refused
     * either way — `assertHeader` sees to that — but a refusal that leaves no trace is precisely
     * the failure this pass exists to remove, so it is filed under its seq instead.
     */
    function keyOf(item) {
      const oid = item.env && item.env.oid;
      return typeof oid === 'string' && oid !== '' ? oid : `seq:${String(item.seq)}`;
    }

    /**
     * The SEALED thing, without the relay's framing.
     *
     * `GET /ops` returns each envelope with `seq` and `chain` beside it; those are the relay's
     * claims ABOUT the row, not part of what was signed, and they are carried separately here
     * (`item.seq`, and the chain witness above). The parking lot's own shape gate is exact — nine
     * fields, no more — because an envelope with an extra field is not an envelope, and letting a
     * tenth field through would let a relay smuggle bytes into a file this device replays for
     * weeks. So the projection is a whitelist, not a delete-list.
     */
    function envelopeOnly(env) {
      const out = {};
      for (const k of ENVELOPE_KEYS) out[k] = env ? env[k] : undefined;
      return out;
    }

    /**
     * P-4's landing point: the chain witness's verdict, written where a relaunch and a settings
     * pane can both read it.
     *
     * `store.syncChain` is `store.diagnostics().sync.chain`, which `sync/status.js` enumerates as
     * an `error` observable — so one call here is what turns ADR 002 §5.4 from a module nobody
     * imports into a state the product can be in and can say. It is REPLACED rather than
     * appended: the newest verdict about the stream is the true one, and a page that verifies
     * clears it (below), because a fork that healed is not a fork.
     *
     * The write is guarded on the field EXISTING, exactly as the refusal ledger's is: an engine
     * that invents properties on the store it was handed is how two files stop agreeing about
     * what the store is.
     */
    function noteChain(kind, findings) {
      if (!('syncChain' in store)) return;
      store.syncChain = { ok: false, kind, findings: findings || [], at: d.now() };
      if (typeof store._warn === 'function' && !warnedChain.has(kind)) {
        warnedChain.add(kind);
        // ── TWO FINDINGS, TWO SENTENCES, BECAUSE THEY PROMISE DIFFERENT THINGS (R8-2) ─────────
        //
        // `withheld` is the page claim: the relay asked this device to step over rows it never
        // sent, the cursor refuses, and the changes ARE still owed — by a relay that still holds
        // them. Saying so is true and it is the sentence a user can act on.
        //
        // A chain break is not that. It is a hole this device cannot fill by waiting, because the
        // most likely cause is the one legitimate destructive operation in the product: a member
        // removal purges that member's op rows (ADR 003 §6.3) and every chain after it becomes
        // unrecomputable BY ANYONE, for ever. Round 8 told the user those changes were "still
        // owed" while holding the cursor below rows that had been deleted on purpose — a promise
        // nothing could keep. So this half says what happened, says sync continues, and does not
        // promise a delivery.
        store._warn(kind === 'withheld'
          ? 'sync: the server\'s record of this board does not add up — it asked this device to '
            + 'skip over changes it never sent (ADR 002 §5.4). Nothing here was changed and '
            + 'nothing was accepted on its word; the cursor is held so those changes are still '
            + 'owed. If this persists, the two devices may not be seeing the same board.'
          : 'sync: this device can no longer check the server\'s record of this board against '
            + 'itself — one stretch of the history does not hash together (ADR 002 §5.4). If '
            + 'somebody was removed from a shared board, that is expected and nothing is wrong: '
            + 'their changes were deleted with them. Syncing continues either way, checking '
            + 'resumes from here, and nothing on this board was changed on the server\'s word.');
      }
    }
  }

  /** Pull, then push — the order ADR 003 §8.2 gives for coming back online. */
  async function syncNow() {
    if (running) return running;
    running = (async () => {
      if (!isOnline()) { emitStatus(); return { skipped: 'offline' }; }
      let guard = 0;
      let more = true;
      while (more && guard < 64) {
        guard += 1;
        // eslint-disable-next-line no-await-in-loop
        const r = await pullNow();
        more = r.hasMore;
      }
      await pushNow();
      return { ok: true };
    })().finally(() => { running = null; });
    return running;
  }

  // ── status ─────────────────────────────────────────────────────────────────

  function errorOf(res) {
    const code = res.json && typeof res.json.error === 'string' ? res.json.error : null;
    return { status: res.status, error: code };
  }

  /** ADR 003 §4 — every response carries the window, so a client learns about a gate early. */
  function noteProtocol(res) {
    const h = res.headers || {};
    const min = h['x-lzp-min-protocol'] ?? h['X-LZP-Min-Protocol'];
    const max = h['x-lzp-protocol'] ?? h['X-LZP-Protocol'];
    if (min !== undefined || max !== undefined) stats.protocol = { min: Number(min), max: Number(max) };
  }

  /**
   * ADR 003 §8.3's three states. `healthy` is NOTHING AT ALL in the UI — F11's "silence is the
   * design" extends to the network — so this returns the state and never a message for it.
   */
  function status() {
    const pending = store.outboxSize ? store.outboxSize() : 0;
    let state = 'healthy';
    let errorKind = null;
    if (quarantined.size) { state = 'error'; errorKind = 'quarantine'; }
    else if (stats.consecutiveFailures >= 5) { state = 'error'; errorKind = 'offline'; }
    else if (stats.lastError && [401, 403].includes(stats.lastError.status)) { state = 'error'; errorKind = 'auth'; }
    else if (stats.lastError && stats.lastError.status === 426) { state = 'error'; errorKind = 'protocol'; }
    // A HELD OP IS `pending`, NOT `healthy`. Story 19.3's promise is not "the indicator is quiet",
    // it is "quiet means there is nothing to tell you" — and an op this Mac is holding is work
    // outstanding in exactly the way an unacknowledged outbox line is. It is not `error`: nothing
    // has failed, and P-8's whole cost was that a held op looked like a healthy one.
    else if (pending > 0 || deferred.size > 0 || !isOnline() || stats.consecutiveFailures > 0) state = 'pending';

    // ── THE THREE-STATE READING IS NOT THIS FILE'S ALONE ─────────────────────────────────────
    //
    // Everything above is what THIS SESSION saw happen. Four of the states story 19.3 promises to
    // report are not in this session at all: a line parked before the last quit (L-2), a refusal
    // recorded before it (L-1), an unacknowledged line a compaction folded away (E5-2), and a
    // relay whose stream does not add up (P-4). All four are on disk, all four are enumerated in
    // `sync/status.js`, and none of them could be seen from here — which is why every row of
    // domain S4 measured `healthy`.
    //
    // `judgeSyncStatus` is a FOLD over that enumeration and merges the two readings by `max` over
    // the ladder, so it can only ever RAISE this state and never lower one. The engine keeps the
    // right to name the transport `errorKind` (it saw the failure; the enumeration only sees what
    // is left over), and `deferredOps` is carried across because it is this file's own counter and
    // the settings sheet reads it.
    // ── R10-9c · AND THE SHELF IS OFFERED, BECAUSE THIS IS THE CALL SITE THAT HOLDS IT ───────
    //
    // The eighth observable, `shelved`, is a hold that ENDED: bytes this Mac kept, correctly, and
    // will never open again. It is the one row of the enumeration `store.diagnostics()` cannot
    // structurally answer — the shelf is in the ENGINE's parking lot, not in the log (R8-6b) — so
    // `status.js` declares it `at: 'held'` and the evidence is handed in from here.
    //
    // Unwired, `judgeSyncStatus` reported it as `unoffered`: named, not counted, and deliberately
    // NOT `unknown`, because a port-fed row nobody answered must not put a permanent glyph on
    // every solo Mac (`S4-quiet`). That caution has a price — the shelf was readable and unread —
    // and this argument is the whole of what it costs to stop paying it. `shelvedDetail` drops
    // `env`, so no ciphertext reaches a status object (21.3); it is pure and duck-typed, so this
    // stays the only call site that needs to know the lot exists.
    const judged = judgeSyncStatus({
      engine: {
        state, pendingOps: pending, consecutiveFailures: stats.consecutiveFailures,
        lastPullAt: stats.lastPullAt, errorKind, detail: null,
      },
      diagnostics: typeof store.diagnostics === 'function' ? store.diagnostics() : null,
      // ⚠ AND ONLY ONCE THE LOT HAS BEEN READ, WHICH IS THE WHOLE CARE IN THIS LINE.
      //
      // The lot's shelf reader answers from memory, and the lot is empty until `loadLot()` has read the
      // disk back. Handing that in unconditionally is WORSE than not wiring the row at all: an
      // un-loaded lot answers "zero shelved", `judgeSyncStatus` reads a list that was offered and
      // empty, and the verdict states — with no caveat, and with `unoffered` empty to prove it
      // looked — that there is nothing on the shelf, about a Mac with a retained envelope on the
      // disk beside it. MEASURED before this guard existed: a fresh process reported
      // `observables: ['refused'], unoffered: []` over a shelf holding one envelope.
      //
      // `null` is the honest answer to "have you read it yet", and `status.js` has a word for it:
      // the row comes back as `unoffered` — named, not counted, and not folded into `blind` so a
      // launch does not go un-silent over a question that is about to be answered. `attach()`
      // starts `loadLot()` and re-emits when it lands (R8-6), so the window is one microtask in
      // the shipping app and the whole session only for a caller that never attaches.
      held: lotLoaded ? shelvedDetail(lot, [spaceId]) : null,
    });
    return {
      ...judged,
      deferredOps: deferred.size,
    };
  }

  function emitStatus() {
    if (typeof d.onStatus === 'function') d.onStatus(status());
  }

  // ── attach ─────────────────────────────────────────────────────────────────

  /**
   * The one trigger that belongs to this file: a committed transaction schedules a push.
   *
   * `store.subscribe` fires SYNCHRONOUSLY inside `_commit`, right after `emit()`. The seal must
   * not happen there — ADR 001 §0.9 and `store.js` header note 2: `txn → apply → project → emit`
   * is strictly synchronous because `interact.js:317` asks the DOM for the new bar's label
   * element the instant the call returns, and an `await` above `emit()` silently breaks bar-label
   * editing. So the listener does nothing but arm a timer, through the injected `schedule`.
   *
   * `'remote'` and `'init'` are deliberately not triggers: the first is this engine's own fold
   * coming back round, and the second is a launch, where the caller decides when to start.
   */
  function attach() {
    if (attached) return () => {};
    attached = true;
    unsubscribe = store.subscribe((_state, reason) => {
      if (reason === 'remote' || reason === 'init' || reason === 'settings') return;
      schedulePush();
    });
    stats.rejoin = !!(store.diagnostics && store.diagnostics().sync?.rejoin);
    emitStatus();
    // ── R8-6 · A DURABLY HELD OP IS VISIBLE FROM THE FIRST STATUS, NOT FROM THE FIRST PULL ────
    //
    // `loadLot()` is what reads the durable park back and re-arms `deferred` from it, and it was
    // called from `pullNow()` and `heldEnvelopes()` and nowhere else. So between a launch and its
    // first successful pull — up to a whole `pullIntervalMs`, and for ever on a Mac that opens the
    // lid in a tunnel — `deferred` was empty, `status()` read `pending === 0`, and the indicator
    // said the quiet thing about a board with a held change on the disk beside it. That is
    // round 8's own failure (`healthy` while wrong) in the one window nobody was looking at.
    //
    // It cannot be `await`ed: `attach()` is called synchronously from the mount and returns
    // `detach`, and making it async would move a `store.subscribe` behind a microtask. So the read
    // is started here and the status is re-emitted when it lands — the same shape as any other
    // late-arriving fact, and `attached` is re-checked because a detach may have won the race.
    //
    // The other half — `store.diagnostics().sync.parked`, which counts `_log.parkedOps()` and can
    // never see the lot — is `src/js/store.js`'s and is deliberately NOT reached for from here:
    // this engine's own `deferred` is the honest source for its own held envelopes, and two files
    // answering one question is how they drift.
    loadLot()
      .then(() => { if (attached) emitStatus(); })
      .catch(() => {});
    return detach;
  }

  function schedulePush() {
    if (typeof d.schedule !== 'function') return;
    if (pushTimer !== null && typeof d.unschedule === 'function') d.unschedule(pushTimer);
    pushTimer = d.schedule(pushDebounceMs, () => { pushTimer = null; pushNow().catch(() => {}); });
  }

  function detach() {
    if (!attached) return;
    attached = false;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (pushTimer !== null && typeof d.unschedule === 'function') d.unschedule(pushTimer);
    pushTimer = null;
  }

  /**
   * FORCE-FLUSH (ADR 003 §8.2's `pagehide` row). It cannot be synchronous — sealing is
   * WebCrypto — so what it guarantees is that the BOARD is on disk, which is the commit point
   * (ADR 006 R5) and the thing that must not be lost. The envelopes are re-derived from the log
   * on the next launch, because the outbox is a projection of the log and the log is persisted
   * below the board.
   */
  async function flush() {
    if (typeof store.flushSync === 'function') store.flushSync();
    return pushNow();
  }

  return {
    spaceId,
    attach,
    detach,
    pushNow,
    pullNow,
    syncNow,
    flush,
    status,
    /**
     * The ops this engine is holding, and why. F-6's visible half — and `curedBy` is the field a
     * UI needs to write the right sentence: "held until your other Mac finishes pairing" and
     * "held until you update the app" are the same STATE and two different things to tell a
     * person. It is recorded at the moment of the hold from `PARK_HANDLING` rather than
     * re-derived here, so the taxonomy has exactly one home and this seam cannot disagree with
     * the one that made the decision.
     */
    deferredOps: () => [...deferred.entries()].map(([oid, v]) => ({
      oid, seq: String(v.seq), tries: v.tries, why: v.why, curedBy: v.curedBy ?? 'session',
    })),
    quarantined: () => [...quarantined.entries()].map(([oid, v]) => ({ oid, ...v })),
    /**
     * The SEALED envelopes this device is retaining, with their park reasons — P-8's third axis.
     * Read from the durable lot, not from the session `Map`, so a fresh process answers the same
     * question the same way. `load()` is idempotent and is what makes this callable before the
     * first pull of a session.
     */
    heldEnvelopes: async () => { await loadLot(); return lot.parked(spaceId); },
    diagnostics: () => ({
      spaceId,
      deviceShort,
      cursor: store.cursor(spaceId),
      outbox: store.outboxSize ? store.outboxSize() : 0,
      sealedCached: sealed.size,
      deferred: deferred.size,
      quarantined: quarantined.size,
      // P-8 — the durable park, and whether it IS durable. `durable: false` means the `parkStore`
      // port was not injected and the retention is per-session, which is the state this seam
      // exists to stop being invisible.
      park: lot.diagnostics(),
      rejoin: stats.rejoin,
      protocol: stats.protocol,
      ...stats,
    }),
  };
}
