// src/js/core/oplog.js — the in-memory op log.
// ADR 001 §6, §7.2, §7.3, §7.4, §9, §10, §12.5 · ADR 004 §5.3 · ops.contract.js §8.
//
// WHAT THIS MODULE IS. The container that holds ops, folds them into registers, dedupes by
// opId, checkpoints, compacts, and PARKS what it cannot yet apply. It is the boundary between
// "bytes that arrived" and "state" — and it is where three of the four rules ADR 001 §12 marks
// as unchangeable are actually enforced:
//
//   §12.5  An op is never discarded for being old. Ops from the future, from unknown epochs and
//          of unknown kinds are PARKED. There is NO staleness gate anywhere in this file, and
//          `oplog admits a stamp of zero at any nowMs` is a test. Risk R11 — a joiner opening
//          the board and seeing Oma's epoch-1 birthday — is exactly this rule.
//   §7.3   Tombstone GC obeys all THREE conditions, and the third one is the single rule in the
//          system whose violation causes incorrect behaviour: a long-offline Mac resurrecting
//          deleted entries (risk R15). Condition 3 bounds READ progress AND WRITE progress —
//          `lastSeenSeq` says a device has pulled past the tombstone, and it says nothing at all
//          about what that device is still holding in its outbox. An entity whose registers have
//          been dropped has no stamp left to lose against, so ANY unpushed write against it
//          resurrects it, however old. `tombstoneCollectable` THROWS rather than guesses when
//          the data needed to evaluate condition 3 is missing, so the rule cannot be optimised
//          away by simply not passing it. (ADR 001 §7.3 states only the `lastSeenSeq` half; the
//          write half is an ADR correction reported from WP-1's convergence pass.)
//   §7.2   A checkpoint is the fold of a prefix, and because per-field stamps are RETAINED,
//          fold(checkpoint ∪ tail) === fold(all ops) for ANY partition — including an op older
//          than the horizon arriving after compaction. Compaction is therefore lossless with
//          respect to materialized state, and needs no coordination with any peer.
//          COMPACTION MAY NEVER DECIDE STATE, which is a stronger claim than "lossless" and is
//          what attack A1 broke twice. Two things carry it: `checkpoint().bodies`, a fingerprint
//          per absorbed opId, so a second body under an absorbed id is still recognised as a
//          splice rather than answered `duplicate`; and the splice resolution itself, which is
//          the register join and therefore monotone — a resolution that un-applies a body cannot
//          survive its own compaction, because the value it displaced is gone. See `append`.
//
// I/O. There is none. This is `core/` (ADR 005 §2): no file handle, no timer, no wall clock.
// `ports.now` is the injected clock (used only for `checkpoint().at` and for the 24 h future
// clamp); `ports.storage` is accepted, retained and never called — persisting `ops.jsonl` is
// `platform/oplogfile.js`'s job, driven by the store, and it must stay outside the synchronous
// `txn → apply → materialize → emit` path (ADR 001 §0.9).

import { cmp, msOf, fmt, isStamp } from './stamp.js';
import { ZERO_DEVICE_SHORT, sha256 } from './ids.js';
import { canonicalJSON, utf8 } from './canon.js';
import { b64u } from './b64.js';
import { OP_KINDS, PARK_REASONS, isParkReason, classifyOp, opKindForEntity, spaceClassOf, fieldSpec } from './ops.js';
import { kindOfEntity, parseEntityKey } from './entities.js';
import {
  emptyRegisters, applyOp, foldAll, mergeMaps, cloneRegisters, serializeRegisters, deserializeRegisters,
} from './registers.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Constants and errors
// ─────────────────────────────────────────────────────────────────────────────

/** ADR 001 §7.3 condition 2. A tombstone younger than this is never collectable. */
export const TOMBSTONE_MIN_AGE_MS = 400 * 24 * 60 * 60 * 1000;

/** A real stamp that sorts at or below every stamp any device can mint (ADR 001 §1.2: every
 *  Crockford character sorts at or above '0', so the all-zeros device short is a true minimum). */
export const ZERO_STAMP = fmt(0, 0, ZERO_DEVICE_SHORT);

/** What `append()` did. Returned rather than thrown, because a peer sending junk is normal. */
export const APPEND = Object.freeze({
  /** admitted, folded into the registers */
  APPENDED: 'appended',
  /** this opId is already in the log (or was, before compaction) — a no-op, by design */
  DUPLICATE: 'duplicate',
  /** retained, NOT applied, re-evaluated by `unpark()` (ADR 001 §7.4) */
  PARKED: 'parked',
  /** a protocol violation (bad type, malformed envelope). Not stored. Never a version skew. */
  REJECTED: 'rejected',
  /**
   * this opId is in the log with DIFFERENT content — envelope splicing (ADR 002 §5.1).
   *
   * RESOLVED BY THE REGISTER JOIN, which is the only resolution that survives §7.2 (see the long
   * note on `append`). EVERY well-formed body that arrives under a spliced opId is folded, and
   * `registers.js`'s `≺` — stamp, then opId, then value — decides field by field. No body is ever
   * un-applied. `kept: 'existing' | 'incoming'` reports which body remains a LINE (the canonical
   * max, the identical rule `authz.js` applies, so the retained plaintext is the same everywhere);
   * the other body's writes stay in the fold. The id joins `splicedIds()`.
   */
  CONFLICT: 'conflict',
});

/**
 * The body fingerprint: 96 bits of SHA-256 over the canonical form, 16 base64url characters.
 *
 * It is what makes dedupe-by-opId SOUND rather than merely fast. ADR 001 §6 calls dedupe "a
 * performance optimisation only", and that is true exactly as long as the second delivery carries
 * the SAME body — a second, DIFFERENT body under one opId is envelope splicing, and answering it
 * `duplicate` because the first one happened to be compacted is a state decision made by a
 * compaction §7.2 promises is invisible to state (attack A1, round 2). The fingerprint is small
 * enough to survive compaction in the checkpoint, and a hash rather than the body itself because
 * ADR 004 §5.3's forget pass must be able to get the plaintext off this disk.
 * @param {string} canon @returns {string}
 */
export function bodyFingerprint(canon) {
  return b64u(sha256(utf8(canon)).subarray(0, 12));
}

export class OpLogError extends Error {
  constructor(message) { super(message); this.name = 'OpLogError'; }
}

/**
 * Thrown when `tombstoneCollectable` is asked to decide without the inputs condition 3 needs.
 * This is deliberate and it is the assertion ADR 001 §7.3 asks for: "do not optimize condition 3
 * away" has to be enforced against the caller who simply omits `minDeviceSeq`, because that is
 * what optimising it away looks like in practice.
 */
export class TombstoneGuardError extends Error {
  constructor(message) { super(message); this.name = 'TombstoneGuardError'; }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The register join  (ADR 001 §6)
//
// Owned by `registers.js` (ADR 005 §1.1). This module does not re-implement any part of it: two
// implementations of the LWW join guarded by nothing is exactly the hazard ADR 001 §5.1 refuses
// for materialize(). The whole module is injectable through `ports.registers` so the fleet
// harness can instrument the fold, but the DEFAULT is the real one and there is no fallback.
// ─────────────────────────────────────────────────────────────────────────────

const REGISTERS = Object.freeze({
  emptyRegisters, applyOp, foldAll, mergeMaps, cloneRegisters, serializeRegisters, deserializeRegisters,
});

const isForbiddenKey = (k) => k === '__proto__' || k === 'constructor' || k === 'prototype';

// ─────────────────────────────────────────────────────────────────────────────
// 2. Tombstone GC — ADR 001 §7.3, the one rule whose violation is incorrect
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The register that carries "this entity is dead", per entity kind. Transcribed from
 * `FIELDS` (ADR 001 §3.1) rather than derived, because the split is not mechanical: the two
 * owned family kinds use `pub.alive` — a truth register in the family space would be exactly the
 * leak ADR 004 forbids — while `member` keeps `_alive`, and `pref` / `space` have no tombstone
 * register at all and are therefore NEVER collectable.
 */
const ALIVE_FIELD = Object.freeze({
  note: '_alive', bar: '_alive', cat: '_alive', pad: '_alive', member: '_alive',
  fnote: 'pub.alive', fbar: 'pub.alive',
  pref: null, space: null,
});

function aliveFieldFor(kind) {
  if (kind === null || !(kind in ALIVE_FIELD)) return null;
  return ALIVE_FIELD[kind];
}

/**
 * An entity may be dropped from a checkpoint ONLY when all three hold:
 *
 *   1. `_alive === false` (or `pub.alive === false`), and
 *   2. `max(all its stamps)` is more than 400 days old, and
 *   3. EVERY registered, non-revoked device in that space has BOTH
 *        (a) read past that stamp's op  — `min(lastSeenSeq)   >= seq`, and
 *        (b) written past it            — `min(lastPushedSeq) >= seq`,
 *      and every register the entity still holds is itself acked.
 *
 * Condition 3 is the one that matters. Conditions 1 and 2 are about tidiness; condition 3 is the
 * difference between "the tombstone is gone because nobody needs it" and "the tombstone is gone
 * while a Mac that has been in a drawer for a year still holds an unsynced write against that
 * entity" — and in the second case the entity comes back from the dead the moment that Mac
 * reconnects. A device that never returns blocks GC forever, and that is the SAFE outcome.
 *
 * WHY (b) IS NOT OPTIONAL, and why ADR 001 §7.3 as written is not sufficient. §7.3 phrases
 * condition 3 purely as `lastSeenSeq` — READ progress. A device can be fully caught up on reads
 * and still be sitting on ops it authored and never managed to PUSH; the outbox is not
 * `lastSeenSeq`, and §12.5 guarantees those ops will never be discarded for being old. Once the
 * entity's registers are dropped there is no retained stamp left for the tombstone to win with,
 * so such a write does not merely lose the join — it RECREATES the entity, no matter how old it
 * is. That is risk R15 arriving through the door §7.3 left open. `minPushedSeq` is therefore
 * required alongside `minDeviceSeq`, and both are compared against the same seq.
 *
 * `lastPushedSeq` is defined as the space's global seq high-water at the last moment that device
 * confirmed a DRAINED outbox (the relay knows both, and reports it opportunistically on push,
 * exactly like `lastSeenSeq`). `min(lastPushedSeq) >= seq` therefore reads: every device has
 * emptied its outbox at a point where the relay already held the tombstone.
 *
 * Every way of evading condition 3 is guarded, INSIDE this function, so that no caller can
 * arrange to skip it:
 *   • omitting `minDeviceSeq`, `minPushedSeq` or `seqOf` throws TombstoneGuardError, rather than
 *     defaulting to something permissive;
 *   • `seqOf` returning anything but a BigInt for ANY of the entity's register stamps (an op we
 *     never saw a server seq for — because it is still in OUR OWN outbox, or because it was
 *     compacted before we started tracking) makes the entity NOT collectable. Unknown never
 *     means yes, and it never means yes for any register, not just the newest one.
 *
 * WHICH SEQ, AND WHY NOT THE STAMP'S (attack A7, round 2). A stamp is unique per (device, ms,
 * ctr) — which our own clock guarantees for our own ops and guarantees for NOBODY else's. Two
 * boards migrated into one personal space collide by construction, because §8.1 stamps every
 * migrated op `GENESIS(index)` with the all-zeros device short. A seq index keyed by STAMP
 * therefore answers this rule with an unrelated op's seq, and if that op's seq is LOWER the
 * tombstone is collected early — R15 through the front door, no adversary required. `ctx.seqOfOp`
 * resolves by the register's own winning OPID and is preferred whenever it is supplied;
 * `ctx.seqOf` remains as the fallback for a caller (or a checkpoint) that only has stamps, and
 * that fallback is the MAXIMUM over every op sharing the stamp — over-reporting the seq can only
 * refuse a collection, never permit one early.
 *
 * @param {Map<string, Map<string, {value:any, stamp:string, author:string, op?:string}>>} regs
 * @param {string} e  entityKey
 * @param {{ nowMs:number, minDeviceSeq:bigint, minPushedSeq:bigint,
 *           seqOf:(s:string)=>(bigint|null), seqOfOp?:(id:string)=>(bigint|null) }} ctx
 * @returns {boolean}
 */
export function tombstoneCollectable(regs, e, ctx) {
  if (!(regs instanceof Map)) throw new TombstoneGuardError('tombstoneCollectable: regs must be a RegisterMap');
  if (ctx === null || typeof ctx !== 'object') {
    throw new TombstoneGuardError('tombstoneCollectable: a ctx with nowMs, minDeviceSeq and seqOf is required (ADR 001 §7.3)');
  }

  const cells = regs.get(e);
  if (!cells || cells.size === 0) return false;

  // ── condition 1 — dead ────────────────────────────────────────────────────
  const aliveField = aliveFieldFor(kindOfEntity(e));
  if (aliveField === null) return false;              // pref / space have no tombstone; never collected
  const alive = cells.get(aliveField);
  if (!alive || alive.value !== false) return false;

  // ── condition 2 — older than 400 days ─────────────────────────────────────
  if (typeof ctx.nowMs !== 'number' || !Number.isFinite(ctx.nowMs)) {
    throw new TombstoneGuardError('tombstoneCollectable: ctx.nowMs must be a finite number');
  }
  let newest = null;
  for (const r of cells.values()) if (newest === null || cmp(r.stamp, newest) > 0) newest = r.stamp;
  if (ctx.nowMs - msOf(newest) <= TOMBSTONE_MIN_AGE_MS) return false;

  // ── condition 3 — THE RULE. Do not optimize this away. ────────────────────
  if (typeof ctx.seqOf !== 'function') {
    throw new TombstoneGuardError(
      'tombstoneCollectable: ctx.seqOf is required — condition 3 of ADR 001 §7.3 cannot be evaluated without it, '
      + 'and skipping it lets a long-offline device resurrect deleted entries (risk R15)');
  }
  if (typeof ctx.minDeviceSeq !== 'bigint') {
    throw new TombstoneGuardError(
      'tombstoneCollectable: ctx.minDeviceSeq must be a BigInt — the MINIMUM lastSeenSeq over every registered, '
      + 'non-revoked device in the space (ADR 001 §7.3 condition 3). A device that never returns blocks GC forever, '
      + 'which is the safe outcome.');
  }
  if (typeof ctx.minPushedSeq !== 'bigint') {
    throw new TombstoneGuardError(
      'tombstoneCollectable: ctx.minPushedSeq must be a BigInt — the MINIMUM lastPushedSeq over every registered, '
      + 'non-revoked device in the space. minDeviceSeq bounds READ progress only; a device that has pulled past the '
      + 'tombstone can still hold an unpushed write against the entity, and once the registers are gone there is no '
      + 'stamp left for the tombstone to win with, so that write RESURRECTS the entry (risk R15). Pass the outbox '
      + 'high-water too, or do not collect.');
  }
  if (ctx.minDeviceSeq < 0n) throw new TombstoneGuardError('tombstoneCollectable: minDeviceSeq may not be negative');
  if (ctx.minPushedSeq < 0n) throw new TombstoneGuardError('tombstoneCollectable: minPushedSeq may not be negative');

  // Resolve a register's server seq by the OPID that wrote it (see the note above); fall back to
  // the stamp only when the caller supplied no opId resolver or the opId is unknown to it — a
  // pre-A7 checkpoint whose `seqs` map is keyed by stamp is exactly that case.
  const seqOfCell = (r) => {
    if (typeof ctx.seqOfOp === 'function' && typeof r.op === 'string' && r.op !== '') {
      const byId = ctx.seqOfOp(r.op);
      if (typeof byId === 'bigint') return byId;
    }
    return ctx.seqOf(r.stamp);
  };

  // Every register this entity still holds must itself be ACKED. An unacked stamp is one of our
  // OWN writes that never reached the relay — collecting around it drops the very stamp that
  // would have absorbed it, and it comes back on the next push.
  let seq = null;
  for (const r of cells.values()) {
    const s = seqOfCell(r);
    if (typeof s !== 'bigint') return false;
    if (r.stamp === newest && (seq === null || s > seq)) seq = s;
  }
  if (typeof seq !== 'bigint') return false;          // unknown seq ⇒ NOT collectable, always
  return ctx.minDeviceSeq >= seq && ctx.minPushedSeq >= seq;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The log
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise a server seq. Accepts a decimal string (the wire form), a safe integer or a BigInt. */
function toSeq(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') { if (v < 0n) throw new OpLogError('seq may not be negative'); return v; }
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new OpLogError(`seq must be a non-negative safe integer, got ${v}`);
    return BigInt(v);
  }
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  throw new OpLogError(`seq must be a decimal string, a non-negative safe integer or a BigInt, got ${JSON.stringify(v)}`);
}

const result = (status, extra) => Object.freeze({ status, ...extra });

/**
 * HOW MANY ABSORBED BODY FINGERPRINTS THE CHECKPOINT MAY CARRY (R6-3 · ADR 001 §7.2).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THERE HAS TO BE A NUMBER HERE AT ALL
 *
 * `bodies` is right to exist. Round 2's attack A1 was that a COMPACTION DECIDED STATE: once a
 * body is folded into the checkpoint its line is gone, and answering a second, different body at
 * that opId with `duplicate` made two devices converge to two different boards depending on when
 * each happened to compact. One 96-bit fingerprint per absorbed opId is what tells the two cases
 * apart afterwards, and it is the right price.
 *
 * What was missing is that NOTHING EVER FORGAVE ONE. `compact()` calls `rememberBody` for every
 * line it drops; `pruneSeqIndex()` prunes `seqById`, `tsById` and `legacySeqByStamp` on the same
 * call and stepped over `bodies`. So `checkpoint.json` — a file `storage.saveCheckpoint` rewrites
 * ATOMICALLY AND WHOLE on every debounced save — grew with the number of ops the user had EVER
 * written, on a board that never grew at all: measured at round 6, 6 000 fingerprints and 282 KB
 * for a board of one note, ~46 bytes per op ever written, durable across restarts, and over
 * localStorage's quota inside five years of ordinary use.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE INPUT DOMAIN — WHAT FORGETTING A FINGERPRINT ACTUALLY COSTS
 *
 * The fix is not "prune it like the others". `pruneSeqIndex`'s `keepIds` is "ids a surviving
 * register attributes, plus retained lines", and `bodies` holds precisely the ids that are
 * NEITHER — that is what it is for. Pruning by `keepIds` (round 6's own mutant F1) keeps exactly
 * the WINNER of each field and drops every absorbed op no register points at any more, which
 * after a day's editing is nearly all of them.
 *
 * BE PRECISE ABOUT WHAT THAT COSTS, because the loose version of this claim — "it puts A1 back"
 * — is false and was measured false. `append()` answers an unfingerprinted opId by RE-FOLDING
 * (`oplog.js:645`), which is idempotent, so a purge does not by itself change state. What it
 * destroys is (a) the ADR 002 §5.1 tamper evidence: a second body arriving under a superseded
 * opId comes back `appended` with `splicedIds()` empty, and `spliced` is the only report that an
 * opId ever arrived under two bodies and cannot be re-derived from the tail (REG-28); and (b)
 * the cross-restart dedupe index, since `load()` seeds `seen` from `bodies` alone — so after a
 * restart every re-pulled op is re-folded and re-written to the tail. `tests/tier1/
 * core-oplog.test.js` pins (a) ON A SUPERSEDED OP, which is the only shape of that test the
 * mutant fails; written against the winner it is green under the mutant and proves nothing.
 *
 * So the question is not which branch to prune in; it is what each STATE an opId can be in costs
 * when its fingerprint is gone. Enumerated, over `append()`'s own dispatch (`oplog.js:613-645`):
 *
 *  # state of opId X on re-delivery       fp?  SAME body again          A SECOND, DIFFERENT body
 *  ─ ────────────────────────────────     ───  ───────────────────────  ────────────────────────
 *  1 a live line is held                   —   `duplicate` (the `known` path — fp never consulted)
 *  2 a parked line is held                 —   `duplicate` (ditto)
 *  3 absorbed, fingerprint KEPT           yes  `duplicate`, cheap       `conflict`, `spliced`
 *                                                                        records it, body folded
 *  4 absorbed, fingerprint EVICTED,        no  RE-FOLDED — one line     RE-FOLDED — one line
 *    id still in `seen` (same session)          back in the tail             back in the tail
 *  5 absorbed, fingerprint evicted,        no  RE-FOLDED                RE-FOLDED
 *    id not in `seen` (after a restart)
 *  6 never seen                            no  folded                   folded
 *
 * ROWS 4, 5 AND 6 ARE THE SAME OUTCOME AS ROW 3 FOR STATE, and `append` already says so in as
 * many words: "No fingerprint to compare against: re-fold rather than guess. Idempotent either
 * way." Applying an op twice is idempotent by construction (ADR 001 §6); folding BOTH bodies of
 * a splice is exactly what row 3 does too, because the register join — not the line — decides
 * field by field. So a device that evicted converges with a device that did not.
 *
 * THE COST IS THEREFORE EXACTLY TWO THINGS, both bounded and neither of them state:
 *   · one re-folded line back in the tail, which the next compaction drops again; and
 *   · `spliced` — the ADR 002 §5.1 TAMPER EVIDENCE — not recording that particular splice.
 *
 * The second is why the eviction is OLDEST-FIRST rather than arbitrary, and why a CAP is not the
 * same trade as the purge above even though both forget fingerprints. A spliced envelope is
 * delivered near in time to the body it re-uses the opId of, so the cap keeps the whole window in
 * which a splice is plausible; the purge keeps one fingerprint per live FIELD, which is a set
 * chosen by what the board looks like now and has nothing to do with what arrived recently.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY 1 500
 *
 * It is not a number picked here. It is `store.js`'s `TAIL_COMPACT_AT` — `min(5000,
 * floor(LS_OPS_CAP × 0.75))` — the design's own name for "the most lines this log ever holds at
 * once". Bounding `bodies` by the same number makes every index the checkpoint carries a
 * function of the LIVE log, which is the rule `tests/helpers/domains.js` D4 states, and makes
 * the whole file O(entities × fields) again. `tests/tier1/core-oplog.test.js` asserts the two
 * constants agree, so moving one and not the other is a red test rather than a silent unbounding.
 *
 * `core/` may not import from `store.js` (ADR 005 §2), hence the restatement rather than an
 * import; `createOpLog({ bodyCap })` overrides it for a test that wants a small number.
 */
export const BODY_FINGERPRINT_CAP = 1500;

/**
 * @param {{ now: () => number, storage?: any, registers?: Object, bodyCap?: number }} ports
 *        `now` is REQUIRED: core/ may not read the wall clock itself (ADR 005 §2), and the 24 h
 *        future clamp is a safety rule that must not be silently unarmed by an absent clock.
 *        `bodyCap` overrides `BODY_FINGERPRINT_CAP` — see it for what the bound costs.
 */
export function createOpLog(ports = {}) {
  const now = ports.now;
  if (typeof now !== 'function') {
    throw new OpLogError('createOpLog: ports.now is required — core/ may not read the wall clock itself (ADR 005 §2), '
      + 'and the 24 h future-stamp park (ADR 001 §7.4) is unarmed without it');
  }
  const R = ports.registers ?? REGISTERS;
  for (const fn of ['emptyRegisters', 'applyOp', 'cloneRegisters', 'serializeRegisters', 'deserializeRegisters']) {
    if (typeof R[fn] !== 'function') throw new OpLogError(`createOpLog: ports.registers is missing ${fn}()`);
  }
  const storage = ports.storage ?? null;     // accepted, retained, never called — see the header
  const bodyCap = Number.isInteger(ports.bodyCap) && ports.bodyCap >= 0
    ? ports.bodyCap : BODY_FINGERPRINT_CAP;

  /** @type {Map<string, {op:Object, seq:bigint|null}>} admitted ops, in arrival order */
  let live = new Map();
  /** @type {Map<string, {op:Object, seq:bigint|null, reason:string, fields?:string[]}>} */
  let parked = new Map();
  /** every opId ever appended, INCLUDING ones compacted away. Dedupe is a performance
   *  optimisation only (ADR 001 §6): re-appending a compacted op merges to the same registers. */
  let seen = new Set();
  /**
   * opId → the fingerprints of the bodies that opId has been ADMITTED under and whose LINE is
   * gone (compacted, absorbed by a splice, or purged by `forget`). This is what lets `append()`
   * tell an honest duplicate from a second body after the first has been compacted — see
   * `bodyFingerprint` and the splice note on `append`. Persisted as `checkpoint().bodies`.
   * @type {Map<string, Set<string>>}
   */
  let bodies = new Map();
  /** opId → server seq. THE authoritative seq index (attack A7: a stamp is not unique). */
  let seqById = new Map();
  /** opId → the stamp that op carries, for the stamp-keyed compatibility view below. */
  let tsById = new Map();
  /** stamp → server seq, the MAXIMUM over every op sharing the stamp. Derived from `seqById`
   *  plus whatever a pre-A7, stamp-keyed checkpoint carried. Never lowered. */
  let seqByStamp = new Map();
  /** stamp → seq entries read from a pre-A7 checkpoint, which carries no opIds to key them by. */
  let legacySeqByStamp = new Map();
  /** the checkpoint: the fold of every op at or below `horizon` */
  let regs = R.emptyRegisters();
  /** @type {string|null} */
  let horizon = null;
  /** @type {Map<string, bigint>} per-space transport cursor (ADR 003 §3.3) */
  let cursors = new Map();
  /** opIds seen under two or more DIFFERENT bodies (ADR 002 §5.1). A SET, not a running list:
   *  the report has to be a function of the op SET, or a re-pull whose batch boundary differs
   *  makes two devices report a different number of splices for the same log. */
  let spliced = new Set();
  /** memoised fold of `regs` ⊕ `live`. Invalidated on every mutation; never handed out mutable. */
  let cache = null;

  const invalidate = () => { cache = null; };

  /** The canonical form of an op, or null if it cannot be canonicalised (cyclic, BigInt, …). */
  function canonOf(o) {
    try { return canonicalJSON(o); } catch { return null; }
  }

  function retain(op) {
    if (op.f && !Object.isFrozen(op.f)) Object.freeze(op.f);
    if (!Object.isFrozen(op)) Object.freeze(op);
    return op;
  }

  /** Raise the stamp view for `ts` to `seq`. NEVER lowers it — see `noteSeq`. */
  function bumpStamp(ts, seq) {
    const prev = seqByStamp.get(ts);
    if (prev === undefined || seq > prev) seqByStamp.set(ts, seq);
  }

  /**
   * Record what we know about one op's server seq. The seq is keyed by OPID, and it is only ever
   * raised: a well-formed op that happens to reuse another op's stamp may not drag the seq the
   * §7.3 tombstone rule is evaluated against DOWNWARDS, because down is the unsafe direction
   * (attack A7, round 2 — and it is reachable with no adversary at all, because §8.1 stamps every
   * migrated op `GENESIS(index)` with `ZERO_DEVICE_SHORT`).
   */
  function noteSeq(id, ts, seq) {
    if (typeof id === 'string' && typeof ts === 'string') tsById.set(id, ts);
    if (typeof seq !== 'bigint') return;
    const prev = seqById.get(id);
    if (prev === undefined || seq > prev) seqById.set(id, seq);
    if (typeof ts === 'string') bumpStamp(ts, seqById.get(id));
  }

  /** This body's line is gone but its writes are folded — remember the fingerprint. */
  function rememberBody(id, canon) {
    if (canon === null) return;
    let set = bodies.get(id);
    if (set === undefined) { set = new Set(); bodies.set(id, set); }
    set.add(bodyFingerprint(canon));
  }

  function admit(op, seq) {
    live.set(op.id, { op: retain(op), seq });
    seen.add(op.id);
    noteSeq(op.id, op.ts, seq);
    invalidate();
  }

  /** Install a classified op in the live or the parked map, and describe what happened. */
  function place(op, seq, c) {
    if (c.status === 'park') {
      const entry = { op: retain(op), seq, reason: c.parkReason };
      if (c.fields) entry.fields = c.fields;
      parked.set(op.id, entry);
      seen.add(op.id);
      noteSeq(op.id, op.ts, seq);
      invalidate();
      return result(APPEND.PARKED, {
        reason: c.reason, parkReason: c.parkReason, ...(c.fields ? { fields: c.fields } : {}),
      });
    }
    admit(op, seq);
    return result(APPEND.APPENDED, {});
  }

  /**
   * Fold a body into the checkpoint and keep no line for it: exactly what `compact()` does, done
   * early for the losing body of a splice. The writes stay in the fold (which is what makes the
   * splice resolution survive a later compaction — see `append`), the plaintext line does not.
   */
  function absorb(op, seq, canon) {
    R.applyOp(regs, op);
    noteSeq(op.id, op.ts, seq);
    rememberBody(op.id, canon);
    seen.add(op.id);
    invalidate();
  }

  function matches(op, q) {
    if (q.space !== undefined && op.space !== q.space) return false;
    if (q.entity !== undefined && op.e !== q.entity) return false;
    if (q.kind !== undefined && op.k !== q.kind) return false;
    if (q.sinceStamp !== undefined && cmp(op.ts, q.sinceStamp) <= 0) return false;
    return true;
  }

  function maxLiveStamp() {
    let max = null;
    for (const { op } of live.values()) if (max === null || cmp(op.ts, max) > 0) max = op.ts;
    return max;
  }

  /** The checkpoint as a live RegisterMap (not yet serialized). Shared by checkpoint() and compact(). */
  function foldTo(h) {
    const out = R.cloneRegisters(regs);
    for (const { op } of live.values()) if (cmp(op.ts, h) <= 0) R.applyOp(out, op);
    return out;
  }

  /**
   * `mode: 'read'` — what `checkpoint()` should serialize: the checkpoint we already hold, or,
   * before the first compaction, everything. `mode: 'advance'` — what `compact()` should absorb:
   * everything currently held. The two differ only after a compaction, and the difference is what
   * makes `{checkpoint(), ops()}` the exact pair that belongs on disk: a checkpoint whose horizon
   * ran ahead of the tail it was written beside would compact lines nobody asked it to.
   *
   * `'advance'` takes the MAX of the two, not `maxLiveStamp() ?? horizon` (R5-4). "Everything
   * currently held" is the checkpoint we hold PLUS the lines above it, so a live line BELOW the
   * horizon — an op that arrived late (§7.2), or a tail line the checkpoint already folds because
   * a crash landed between `saveCheckpoint` and `truncateOps` — must not drag the horizon
   * backwards. It used to: `maxLiveStamp()` was answered first, the receding-horizon guard three
   * lines below then threw, and `compact()` threw for the rest of that log's life — which means
   * the one call that bounds `ops.jsonl` could be permanently disabled by one late op.
   */
  function resolveHorizon(opts, mode) {
    const live0 = maxLiveStamp();
    const fallback = mode === 'read'
      ? (horizon ?? live0)
      : (live0 === null || (horizon !== null && cmp(live0, horizon) < 0) ? horizon : live0);
    const h = opts.horizon ?? fallback ?? ZERO_STAMP;
    if (!isStamp(h)) throw new OpLogError(`checkpoint: horizon must be a 37-char stamp, got ${JSON.stringify(h)}`);
    if (horizon !== null && cmp(h, horizon) < 0) {
      throw new OpLogError(`checkpoint: the horizon may not recede (${h} < ${horizon}) — a receding horizon would `
        + 'silently re-open ops the checkpoint has already absorbed');
    }
    return h;
  }

  function cursorsObject() {
    const out = {};
    for (const s of [...cursors.keys()].sort()) out[s] = String(cursors.get(s));
    return out;
  }

  /**
   * `checkpoint().seqs`, keyed by OPID since A7. A pre-A7 file keyed them by stamp; `load()`
   * accepts both and tells them apart by shape (a stamp is 37 characters and `isStamp` proves it,
   * an OpId is 22 base64url characters), so the format migration needs no version flag and no
   * migration pass.
   */
  function seqsObject() {
    const out = {};
    for (const id of [...seqById.keys()].sort()) {
      const v = seqById.get(id);
      if (typeof v === 'bigint') out[id] = String(v);
    }
    for (const s of [...legacySeqByStamp.keys()].sort()) {
      if (out[s] === undefined) out[s] = String(legacySeqByStamp.get(s));
    }
    return out;
  }

  /**
   * `checkpoint().bodies` — the fingerprints of absorbed bodies, sorted for a stable file.
   * An id that is a LINE again is skipped: its body travels in the tail, and listing it here too
   * would make `load()` answer that very line `duplicate` and drop it.
   */
  function bodiesObject() {
    const out = {};
    for (const id of [...bodies.keys()].sort()) {
      if (live.has(id) || parked.has(id)) continue;
      const set = bodies.get(id);
      if (set && set.size > 0) out[id] = [...set].sort();
    }
    return out;
  }

  /** Rebuild the derived stamp view from the opId index plus the legacy entries. */
  function rebuildStampIndex() {
    seqByStamp = new Map(legacySeqByStamp);
    for (const [id, seq] of seqById) {
      const ts = tsById.get(id);
      if (typeof ts === 'string') bumpStamp(ts, seq);
    }
  }

  /**
   * FORGET THE OLDEST ABSORBED BODY FINGERPRINTS ONCE THERE ARE MORE THAN `bodyCap` (R6-3).
   *
   * See `BODY_FINGERPRINT_CAP` for the whole argument — what an evicted fingerprint costs, per
   * state an opId can be in, and why the answer is "one re-folded line and one missing entry in
   * the tamper report, and never a difference in state".
   *
   * TWO PROPERTIES THE LOOP HAS TO HAVE, and both are one line each:
   *
   *  · OLDEST FIRST. A `Map` iterates in insertion order, so `bodies.keys()` is already
   *    absorption order and `delete` during a `for…of` over it is defined behaviour. (After a
   *    RELOAD that order is `bodiesObject()`'s sorted order rather than absorption order, because
   *    a JSON object is all `load()` gets. OpIds are random, so that degrades "oldest first" to
   *    "arbitrary but stable" for the fingerprints that survived a restart — which costs nothing
   *    the table above does not already price, and the CAP, which is the whole point, holds
   *    either way.)
   *
   *  · NEVER EVICT AN ID THAT STILL HAS A LINE. `bodiesObject()` already skips those on the way
   *    to disk, but the in-memory entry is what `append()` consults the moment that line is
   *    compacted, and evicting it would throw away a fingerprint we are about to need. Skipping
   *    them can leave `bodies.size` above the cap when every entry has a line — which is exactly
   *    right: those are RETAINED LINES, they are bounded by `TAIL_COMPACT_AT` themselves, and
   *    they cost the checkpoint nothing because they are not serialized.
   *
   * @returns {number} fingerprints forgotten
   */
  function boundBodies() {
    let over = bodies.size - bodyCap;
    if (over <= 0) return 0;
    let evicted = 0;
    for (const id of bodies.keys()) {
      if (over <= 0) break;
      if (live.has(id) || parked.has(id)) continue;
      bodies.delete(id);
      over--;
      evicted++;
    }
    return evicted;
  }

  /**
   * Keep only the ops a surviving register attributes, plus the retained lines — and, since
   * round 7, bound `bodies` too. It was the one index this function stepped over (R6-3b), and
   * `bodies` is the index the file's growth was made of. Deleting the `boundBodies()` call is
   * the mutant; it reddens R6-3a, R6-3b and D4-i5/D4-g5/D4-g6.
   */
  function pruneSeqIndex() {
    const keepIds = new Set();
    const keepStamps = new Set();
    for (const cells of regs.values()) {
      for (const r of cells.values()) {
        keepStamps.add(r.stamp);
        if (typeof r.op === 'string' && r.op !== '') {
          keepIds.add(r.op);
          if (!tsById.has(r.op)) tsById.set(r.op, r.stamp);
        }
      }
    }
    for (const { op } of live.values()) { keepIds.add(op.id); keepStamps.add(op.ts); }
    for (const { op } of parked.values()) { keepIds.add(op.id); keepStamps.add(op.ts); }
    for (const id of [...seqById.keys()]) if (!keepIds.has(id)) seqById.delete(id);
    for (const id of [...tsById.keys()]) if (!keepIds.has(id)) tsById.delete(id);
    for (const s of [...legacySeqByStamp.keys()]) if (!keepStamps.has(s)) legacySeqByStamp.delete(s);
    boundBodies();
    rebuildStampIndex();
  }

  const api = {
    // ── ports, exposed so a later work package can wire persistence without a new signature ──
    ports: Object.freeze({ storage, registers: R }),

    /**
     * Append one op. IDEMPOTENT: the same op twice is a no-op, and 1 000 copies of a stream fold
     * to what one copy folds to (ADR 001 §6 corollary 1).
     *
     * Routing is `classifyOp`'s (ops.js), so exactly one table decides admit / park / reject:
     *   • admit   — folded into the registers
     *   • park    — RETAINED and not applied: unknown version, kind, field, space, or a stamp
     *               more than 24 h in the future. Never dropped (ADR 001 §12.5).
     *   • reject  — a protocol violation (a declared type broken, a malformed envelope). This is
     *               the ONLY thing that is not kept, and it is never a version skew.
     *
     * There is NO lower bound. An op stamped at the beginning of the epoch is admitted at any
     * `nowMs`: risk R11, the joiner who must see Oma's birthday.
     *
     * ENVELOPE SPLICING (ADR 002 §5.1) — two DIFFERENT bodies under one opId — IS RESOLVED BY THE
     * REGISTER JOIN, and this is the round-2 correction to attack A1. Every body that classifies
     * `admit` is FOLDED; `registers.js`'s `≺` (stamp, then opId, then value) decides field by
     * field; no body is ever un-applied. The whole-body canonical max — the identical rule
     * `authz.js` applies — still decides which body remains a LINE, so the plaintext this log
     * retains is the same on every device and `kept:` still reports it. The loser's line is
     * ABSORBED into the checkpoint at once: exactly what `compact()` would have done to it, done
     * early.
     *
     * WHY IT HAD TO CHANGE, and why no smaller fix exists. Round 1 resolved a splice by DELETING
     * the losing body and re-folding, and admitted "one residual limit": after compaction the log
     * no longer holds the first body, so the second was answered `duplicate`. That is not a
     * reporting limit, it is permanent divergence — device A, which ran its ordinary §7.2 tail
     * trim between the two envelopes, keeps the FIRST body while device B, which did not, keeps
     * the canonical max, from an identical op set, for ever, and A's next checkpoint bakes it onto
     * disk. §7.2 exists so that compaction is invisible to state; there it decided state.
     *
     * The un-apply cannot be made to survive compaction: once a body is folded into the
     * checkpoint, the value it displaced is gone, so no bounded amount of retained metadata can
     * put it back. A resolution that is stable under compaction must therefore be MONOTONE with
     * respect to the fold — and the fold is the register join. Folding every admitted body makes
     * the state a function of the op SET again, under any delivery order and any interleaving of
     * compaction, because compaction is nothing but partial evaluation of that same join. What is
     * given up is only that the losing body's fields no longer vanish; what is bought is
     * convergence, which §12.2 does not make optional. A parked body is still not applied — a park
     * is a promise not to fold, and it is kept — so two bodies of which one parks converge too;
     * a parked body that also LOSES the contest for the line contributes nothing to state on any
     * device, so its bytes go with the line. That is not §12.5's "discarded for being old": it is
     * the losing half of one opId, and every device drops the same half, by content.
     *
     * DEDUPE IS SOUND AGAIN. ADR 001 §6 calls dedupe-by-opId "a performance optimisation only",
     * which is true of a REPEATED body and false of a SECOND one. `checkpoint().bodies` therefore
     * carries a 96-bit `bodyFingerprint` per absorbed opId, so an id whose line is gone can still
     * tell an honest duplicate (same fingerprint → DUPLICATE, free) from a splice (different
     * fingerprint → folded, reported, `splicedIds()`). An id whose fingerprint is not known —
     * a pre-A1 checkpoint, or a body dropped by tombstone GC — is RE-FOLDED rather than assumed
     * duplicate, which is correct, just not free.
     *
     * @param {Object} op
     * @param {{seq?:string|number|bigint, haveEpochKey?:boolean}} [meta]
     * @returns {{status:string, reason?:string, parkReason?:string, fields?:string[], kept?:string}}
     */
    append(op, meta = {}) {
      if (op === null || typeof op !== 'object' || Array.isArray(op)) {
        return result(APPEND.REJECTED, { reason: 'op is not an object' });
      }
      const seq = toSeq(meta.seq);
      const id = typeof op.id === 'string' ? op.id : null;
      const known = id === null ? undefined : (live.get(id) ?? parked.get(id));

      // Classify BEFORE resolving a splice: a body that is a protocol violation is not stored at
      // all, so it may not win — or even disturb — a splice against a well-formed one.
      const c = classifyOp(op, { nowMs: now(), haveEpochKey: meta.haveEpochKey });
      if (c.status === 'reject') return result(APPEND.REJECTED, { reason: c.reason });

      const theirs = canonOf(op);
      const spliceReason = `opId ${op.id} is already in the log with different content — envelope `
        + 'splicing (ADR 002 §5.1); every admitted body is folded and the register join decides '
        + 'field by field, so the resolution survives compaction; the canonical max keeps the line';

      // ── the id is in `seen` but no line is held: it was compacted, absorbed or purged ───────
      if (!known && id !== null && (bodies.has(id) || seen.has(id))) {
        const fps = bodies.get(id);
        if (theirs !== null && fps !== undefined && fps.has(bodyFingerprint(theirs))) {
          noteSeq(id, op.ts, seq);                     // a re-pull may be telling us the seq
          return result(APPEND.DUPLICATE, {});
        }
        if (theirs !== null && fps !== undefined) {
          // A SECOND body under an absorbed opId. The first one's writes are already in the fold;
          // folding this one lands on the same registers as a peer that never compacted.
          spliced.add(id);
          const placed = place(op, seq, c);
          return result(APPEND.CONFLICT, {
            reason: spliceReason,
            kept: 'incoming',
            ...(placed.status === APPEND.PARKED ? { parkReason: placed.parkReason } : {}),
          });
        }
        if (fps === undefined && theirs === null) return result(APPEND.DUPLICATE, {});
        // No fingerprint to compare against: re-fold rather than guess. Idempotent either way.
        return place(op, seq, c);
      }

      if (known) {
        const mine = canonOf(known.op);
        if (theirs !== null && theirs === mine) {
          if (seq !== null && known.seq === null) known.seq = seq;
          noteSeq(known.op.id, known.op.ts, seq);
          return result(APPEND.DUPLICATE, {});
        }
        spliced.add(op.id);
        if (theirs === null || (mine !== null && mine > theirs)) {
          // The body we hold keeps the line. The incoming one is still folded, unless it parks —
          // a park is a promise not to fold and it is kept on both sides of the splice.
          if (c.status !== 'park') absorb(op, seq, theirs);
          return result(APPEND.CONFLICT, { reason: spliceReason, kept: 'existing' });
        }
        // The incoming body is the canonical max, so it takes the line. The body we hold is
        // absorbed into the checkpoint exactly as `compact()` would absorb it: its writes stay in
        // the fold — which is what makes this resolution survive a later compaction — its
        // plaintext line goes. A PARKED loser was never folded, so only its line goes.
        const wasParked = parked.has(op.id);
        if (!wasParked) absorb(known.op, known.seq, mine);
        else rememberBody(op.id, mine);
        live.delete(op.id);
        parked.delete(op.id);
        invalidate();
        const placed = place(op, seq ?? known.seq, c);
        return result(APPEND.CONFLICT, {
          reason: spliceReason,
          kept: 'incoming',
          ...(placed.status === APPEND.PARKED ? { parkReason: placed.parkReason } : {}),
        });
      }

      return place(op, seq, c);
    },

    /**
     * The opIds this log has seen under two or more different bodies (ADR 002 §5.1), sorted.
     * A function of the op SET: re-delivering a spliced body does not lengthen it.
     * @returns {string[]}
     */
    splicedIds() { return [...spliced].sort(); },

    /**
     * The ADMITTED ops — what has actually been folded — in arrival order.
     *
     * THE DEFAULT IS THE APPLIED SET, and it is deliberate (regression REG-29). Round 1 reversed
     * it to "every LINE" so that the documented persist pair `{checkpoint(), ops()}` would stop
     * destroying parked ops, and that silently changed every OTHER reader: `fold(log.ops())` — the
     * obvious way to rebuild a register map — throws `RegisterError` the moment any op is parked
     * for an unknown FIELD, which happens the first time a sibling on a newer build sends one. So
     * the persist pair got its own carrier instead: the parked lines now ride in `checkpoint()`,
     * WITH their park reasons (which is what A2 round 2 needed anyway, since `load()` cannot
     * re-derive `epoch`). Neither reader can now get the wrong set by accident.
     *
     * Pass `{includeParked:true}` for every LINE the log holds — live first, then parked.
     * `{liveOnly:true}` is the explicit spelling of the default.
     *
     * NOTHING may depend on this order (ADR 001 §0.2: state is a function of the SET); it is the
     * order that makes a log file readable by a human, and there is a test that the fold does not
     * change under permutation.
     * @param {{space?:string, sinceStamp?:string, entity?:string, kind?:string,
     *          includeParked?:boolean, liveOnly?:boolean}} [q]
     * @returns {Object[]} a fresh array; mutating it cannot touch the log
     */
    ops(q = {}) {
      const wantParked = q.liveOnly === true ? false : (q.includeParked === true);
      const out = [];
      for (const { op } of live.values()) if (matches(op, q)) out.push(op);
      if (wantParked) for (const { op } of parked.values()) if (matches(op, q)) out.push(op);
      return out;
    },

    /**
     * EVERY LINE the log holds, with the two facts a bare op cannot carry: its server seq and, for
     * a parked line, the reason it is parked. This is the explicit persistence accessor — the one
     * `ops()` used to be by default — and it exists so that a caller who means "the content of
     * `ops.jsonl`" can say so instead of relying on a default that a fold-shaped caller also
     * relies on (REG-29). `{checkpoint(), ops()}` remains a complete pair on its own, because the
     * checkpoint carries the parked lines; `lines()` is for a store that would rather keep the
     * tail file self-describing.
     * @returns {Array<{op:Object, seq:string|null, park:string|null, fields?:string[]}>} JSON-safe
     */
    lines() {
      const out = [];
      for (const e of live.values()) out.push({ op: e.op, seq: e.seq === null ? null : String(e.seq), park: null });
      for (const e of parked.values()) {
        out.push({
          op: e.op, seq: e.seq === null ? null : String(e.seq), park: e.reason,
          ...(e.fields ? { fields: e.fields.slice() } : {}),
        });
      }
      return out;
    },

    /** The full register map: checkpoint ⊕ tail. Memoised; treat as READ-ONLY. */
    registers() {
      if (cache === null) {
        const out = R.cloneRegisters(regs);
        for (const { op } of live.values()) R.applyOp(out, op);
        cache = out;
      }
      return cache;
    },

    /** A detached deep copy, for a caller that wants to mutate. */
    registersCopy() { return R.cloneRegisters(api.registers()); },

    /**
     * The fold of a prefix (ADR 001 §7.2), plus everything about the log that is NOT a folded op
     * and would otherwise not survive a relaunch. Pure: it does not mutate the log.
     *
     * @param {{horizon?:string}} [opts] default: fold everything currently held
     * @returns {{horizon:string, regs:Object, cursors:Object, seqs:Object, bodies:Object,
     *            parked:Array, spliced:string[], at:number}}
     *
     *   `seqs` is additive to ops.contract.js §8: without persisting op→seq, tombstone GC silently
     *   stops working after every relaunch, because condition 3 becomes unevaluable. Keyed by
     *   OPID since A7 round 2 — a stamp is not unique across devices and a migrated board's
     *   stamps collide by construction. Pre-A7 files keyed it by stamp and still load.
     *
     *   `bodies` is the splice guard (A1 round 2): one 96-bit `bodyFingerprint` per opId whose
     *   line has been absorbed, so that dedupe-by-opId can still tell a re-delivery from a second
     *   body after the first has been compacted. Without it a compaction decides state.
     *
     *   `parked` carries the parked LINES and — the part round 1 lost — their REASONS (A2 round
     *   2). `load()` re-classifies every line on purpose, so that yesterday's `unknownKind`
     *   becomes today's ordinary op with nobody writing a migration; but `epoch` is by definition
     *   the reason the classifier CANNOT re-derive, because core/ holds no key material. Round 1
     *   saved the parked bytes and lost the meaning: an op parked under `epoch` came back live and
     *   APPLIED, and `parkedOps({reason:'epoch'})` could not even tell the store it still needed a
     *   key. The reason rides here, and `load()` feeds it back through the classifier.
     *
     *   `spliced` is the ADR 002 §5.1 tamper evidence (REG-28). It is the only report that an
     *   opId ever arrived under two bodies, and it cannot be re-derived from the tail, so a
     *   restart used to erase it.
     */
    checkpoint(opts = {}) {
      const h = resolveHorizon(opts, 'read');
      const parkedLines = [];
      for (const e of parked.values()) {
        parkedLines.push({
          op: e.op,
          seq: e.seq === null ? null : String(e.seq),
          reason: e.reason,
          ...(e.fields ? { fields: e.fields.slice() } : {}),
        });
      }
      return Object.freeze({
        horizon: h,
        regs: R.serializeRegisters(foldTo(h)),
        cursors: cursorsObject(),
        seqs: seqsObject(),
        bodies: bodiesObject(),
        parked: parkedLines,
        spliced: [...spliced].sort(),
        at: Math.floor(now()),
      });
    },

    /**
     * Fold every op at or below the horizon into the checkpoint and drop those lines.
     * Lossless by construction: the per-field stamps survive, so a late op older than the horizon
     * is compared against the retained stamp and wins or loses by the identical rule. Parked ops
     * are NEVER dropped — an unknown-kind op from a newer sibling can easily be older than the
     * horizon, and dropping it would be exactly the "loses the new thing" failure §7.4 exists to
     * prevent.
     * @returns {number} lines dropped
     */
    compact(opts = {}) {
      const h = resolveHorizon(opts, 'advance');
      regs = foldTo(h);
      horizon = h;
      let dropped = 0;
      for (const [id, entry] of [...live]) {
        if (cmp(entry.op.ts, h) <= 0) {
          // The body's line goes; its FINGERPRINT stays, so that a second body arriving under the
          // same opId afterwards is still recognised as a splice rather than answered `duplicate`
          // (A1 round 2). Compaction must be invisible to state, and answering `duplicate` here
          // made it decide state.
          rememberBody(id, canonOf(entry.op));
          live.delete(id);
          dropped++;
        }
      }
      pruneSeqIndex();
      invalidate();
      return dropped;
    },

    /**
     * Restore from disk. The tail is re-appended through the FULL classify path, deliberately:
     * an op parked as `unknownKind` by yesterday's build must become live after an app update
     * without anybody writing a migration, and an op that was live under a stamp 23 h in the
     * future must re-park if the user's clock jumped backwards.
     * A tail entry is an op, a `{op, seq}` pair, or a `lines()` record `{op, seq, park}`; a
     * `park` of `'epoch'` is fed back through the classifier as `haveEpochKey:false`, because it
     * is the one verdict core/ cannot reach on its own.
     * @param {{checkpoint?:Object, tail?:Array}} o
     * @returns {Map} the full register map
     */
    load(o = {}) {
      live = new Map(); parked = new Map(); seen = new Set();
      seqById = new Map(); tsById = new Map(); seqByStamp = new Map(); legacySeqByStamp = new Map();
      bodies = new Map();
      regs = R.emptyRegisters(); horizon = null; cursors = new Map(); spliced = new Set(); invalidate();

      const cp = o.checkpoint;
      let parkedLines = [];
      if (cp) {
        if (cp.regs !== undefined && cp.regs !== null) regs = R.deserializeRegisters(cp.regs);
        if (cp.horizon !== undefined && cp.horizon !== null) {
          if (!isStamp(cp.horizon)) throw new OpLogError(`load: checkpoint.horizon is not a stamp: ${JSON.stringify(cp.horizon)}`);
          horizon = cp.horizon;
        }
        if (cp.cursors && typeof cp.cursors === 'object') {
          for (const [s, v] of Object.entries(cp.cursors)) if (!isForbiddenKey(s)) cursors.set(s, toSeq(v));
        }
        // The stamps a surviving register attributes to an opId — the bridge that lets a
        // stamp-keyed reader (`seqOf`) still answer after the index moved to opIds.
        for (const cells of regs.values()) {
          for (const r of cells.values()) {
            if (typeof r.op === 'string' && r.op !== '' && !tsById.has(r.op)) tsById.set(r.op, r.stamp);
          }
        }
        if (cp.seqs && typeof cp.seqs === 'object') {
          for (const [k, v] of Object.entries(cp.seqs)) {
            if (isForbiddenKey(k)) continue;
            const n = toSeq(v);
            if (n === null) continue;
            if (isStamp(k)) legacySeqByStamp.set(k, n);            // a pre-A7 checkpoint
            else seqById.set(k, n);
          }
          rebuildStampIndex();
        }
        if (cp.bodies && typeof cp.bodies === 'object') {
          for (const [k, v] of Object.entries(cp.bodies)) {
            if (isForbiddenKey(k)) continue;
            const list = Array.isArray(v) ? v : [v];
            const set = new Set();
            for (const fp of list) if (typeof fp === 'string' && fp !== '') set.add(fp);
            if (set.size > 0) { bodies.set(k, set); seen.add(k); }
          }
        }
        if (Array.isArray(cp.spliced)) for (const s of cp.spliced) if (typeof s === 'string') spliced.add(s);
        if (Array.isArray(cp.parked)) parkedLines = cp.parked;
      }
      const feed = (line) => {
        if (line === null || typeof line !== 'object') { api.append(line); return; }
        if (!line.op) { api.append(line); return; }
        const reason = typeof line.park === 'string' ? line.park : (typeof line.reason === 'string' ? line.reason : null);
        api.append(line.op, {
          seq: line.seq,
          ...(reason === PARK_REASONS.EPOCH ? { haveEpochKey: false } : {}),
        });
      };
      for (const line of parkedLines) feed(line);
      for (const line of o.tail ?? []) feed(line);
      return api.registers();
    },

    // ── parking (ADR 001 §7.4) ───────────────────────────────────────────────

    /**
     * Park an op the log cannot classify for itself. In practice that is exactly one reason —
     * `epoch`: whether we hold an epoch key is a fact about `crypto/spacekeys.js`, and core/ holds
     * no key material. The other five reasons `append()` derives on its own.
     *
     * REFUSES an op that has already been folded into the checkpoint (compacted, collected or
     * forgotten): its line is gone and its writes are inseparably merged into `regs`, so parking
     * it could only ever be COSMETIC — `isParked()` would say true while the register it wrote
     * sits there unchanged, and a peer that parked the same op BEFORE compacting would hold
     * different state from an identical op set. The alternative — "rebuild the checkpoint from
     * the surviving lines" — is not available and never will be: compaction dropped those lines,
     * which is the whole point of §7.2, so the rebuild would silently delete every other op
     * already absorbed. Between lying and losing data, this throws. The caller that genuinely
     * needs the write gone reloads from a checkpoint that predates it, or uses `forget()`.
     *
     * @param {Object} op @param {'future'|'epoch'|'unknownKind'|'unknownField'|'version'|'unknownSpace'} reason
     * @throws {OpLogError} if the op is below the checkpoint horizon and no longer a line
     */
    park(op, reason) {
      if (op === null || typeof op !== 'object' || typeof op.id !== 'string') {
        throw new OpLogError('park: an op with an id is required');
      }
      if (!isParkReason(reason)) {
        throw new OpLogError(`park: ${JSON.stringify(reason)} is not a park reason (${Object.values(PARK_REASONS).join(', ')})`);
      }
      if (!live.has(op.id) && !parked.has(op.id) && seen.has(op.id)) {
        throw new OpLogError(`park: op ${op.id} has already been folded into the checkpoint and its line is gone `
          + '— parking it now would be cosmetic (the registers it wrote stay behind, so this log would diverge from '
          + 'a peer that parked the same op before compacting). Reload from a checkpoint that predates it.');
      }
      const existing = live.get(op.id);
      if (existing) { live.delete(op.id); invalidate(); }
      const prev = parked.get(op.id);
      parked.set(op.id, { op: retain(op), seq: existing?.seq ?? prev?.seq ?? null, reason });
      seen.add(op.id);
      return result(APPEND.PARKED, { parkReason: reason });
    },

    /**
     * Re-evaluate parked ops. `pred` selects candidates — it is how the caller says "the missing
     * prerequisite arrived" (we fetched the epoch key; the app was updated). The CLASSIFIER, not
     * `pred`, decides admission: a candidate whose stamp is still 24 h in the future stays
     * parked, with its reason refreshed. Nothing is ever dropped here, including an op that has
     * become un-classifiable — a downgrade must not delete a peer's work.
     * @param {(op:Object) => boolean} [pred]
     * @returns {Object[]} the ops that became live
     */
    unpark(pred = () => true) {
      const promoted = [];
      for (const [id, entry] of [...parked]) {
        if (!pred(entry.op)) continue;
        // `haveEpochKey: true` — the caller asserting `pred` has asserted the key question. What
        // this re-checks is what core/ CAN re-check: the vocabulary and the wall clock.
        const c = classifyOp(entry.op, { nowMs: now(), haveEpochKey: true });
        if (c.status !== 'admit') {
          if (c.status === 'park') entry.reason = c.parkReason;
          continue;
        }
        parked.delete(id);
        admit(entry.op, entry.seq);
        promoted.push(entry.op);
      }
      return promoted;
    },

    /** @returns {Array<{op:Object, reason:string, fields?:string[]}>} */
    parkedOps(q = {}) {
      const out = [];
      for (const e of parked.values()) {
        if (q.reason !== undefined && e.reason !== q.reason) continue;
        if (!matches(e.op, q)) continue;
        out.push(Object.freeze({ op: e.op, reason: e.reason, ...(e.fields ? { fields: e.fields } : {}) }));
      }
      return out;
    },

    /** @returns {string|null} */
    parkReasonOf(id) { return parked.get(id)?.reason ?? null; },

    // ── the forget pass (ADR 004 §5.3 mechanism 2) ───────────────────────────

    /**
     * Purge one entity's lines for one space, and drop the corresponding register VALUES while
     * RETAINING their stamps. Retaining the stamps is required for convergence; dropping the
     * values is what makes the removal real on this peer's disk.
     *
     * Three details that are easy to get wrong and are each tested:
     *   • the entity's registers are first materialised into the checkpoint and THEN blanked, so
     *     forget is stable whether or not the entity has been compacted yet;
     *   • the blanked register keeps its stamp, its author AND its winning opId, so it is a
     *     legal register: `registers.js` refuses a checkpoint whose `op` is not an OpId, and a
     *     blank that could not be persisted would be undone by the next relaunch;
     *   • governing registers keep their values by default: `pub.alive:false` / `pub.level` ARE
     *     the retraction, and blanking them would erase the signal that triggered the pass.
     *     Pass `{values:'all'}` for a hard purge.
     *
     * THE TIE IS ALREADY BROKEN THE RIGHT WAY, and the comment that used to stand here said the
     * opposite. `registers.js:valueKey` ranks `null` ABOVE every non-null value, so the exact
     * (stamp, opId) tie that a cold re-delivery of the blanked op produces is won BY THE BLANK
     * and forget is absorbing. That comparator is consulted only when the stamp and the opId both
     * tie — i.e. only for this case — so nothing else in the fold is affected. Only a genuinely
     * NEWER publication restores the value, which is the owner sharing again rather than a leak.
     *
     * THE OTHER EDGE OF THE SAME KNIFE, and why the liveness guard below exists: because the
     * blank wins every tie, an unscoped `forget()` on an entity that is still PUBLISHED is
     * irreversible. No re-delivery of the original ops brings the value back, while every peer
     * that did not run the pass still shows it — permanent divergence, triggered by a mistaken
     * call rather than by a retraction. ADR 004 §5.3 fires this pass only on a family op that
     * retracts (`pub.alive:false` / `pub.level:'privat'`) or that nulls one content field, so an
     * unscoped forget on a live entity is outside the mechanism it implements. It is refused
     * unless the caller says `{values:'all'}` (the deliberate hard purge) or `{fields:[…]}` (the
     * §5.3 trigger (ii) downgrade, where the register is already null and only the plaintext in
     * `ops.jsonl` remains to remove).
     *
     * TWO TRIGGERS, ONE PASS. ADR 004 §5.3 fires this on a family op that either
     *   (i)  sets `pub.alive` to false / the level to privat — a full retraction. The registers
     *        that need blanking are the CONTENT ones the retraction did not itself null:
     *        `pub.date`, `pub.repeatsYearly`, `_born`. That is the default.
     *   (ii) nulls one content field on an entity that stays visible — a Geteilt→Belegt
     *        downgrade, where `pub.date` is still legitimately published and blanking it would
     *        erase a Belegt entry the family is meant to see. Pass `{fields:['pub.text']}`.
     *        (The register itself is already `null` by then — mechanism 1 did that. What this
     *        pass adds in case (ii) is (b): getting the plaintext out of `ops.jsonl`.)
     *
     * @param {string} e @param {string} space
     * @param {{values?:'content'|'all', fields?:string[]}} [opts]
     * @returns {number} op lines purged
     */
    forget(e, space, opts = {}) {
      const parsed = parseEntityKey(e);
      if (!parsed) throw new OpLogError(`forget: ${JSON.stringify(e)} is not an entity key`);
      const cls = spaceClassOf(space);
      if (cls === null) throw new OpLogError(`forget: ${JSON.stringify(space)} is not a space reference`);
      const home = OP_KINDS[opKindForEntity(parsed.kind)].space;
      if (home !== cls) {
        throw new OpLogError(`forget: a ${parsed.kind} entity lives in the ${home} space, not in ${cls} `
          + '— forgetting it there would purge the wrong log');
      }
      const all = opts.values === 'all';
      if (opts.values !== undefined && opts.values !== 'all' && opts.values !== 'content') {
        throw new OpLogError(`forget: values must be 'content' or 'all', got ${JSON.stringify(opts.values)}`);
      }
      if (opts.fields !== undefined && !Array.isArray(opts.fields)) {
        throw new OpLogError('forget: fields must be an array of field names');
      }
      const only = opts.fields ? new Set(opts.fields) : null;

      // (a) LIVENESS GUARD. An unscoped forget blanks content registers irreversibly (see the
      //     note above), so it may only run on an entity the owner has actually retracted.
      //
      //     IT RUNS WHETHER OR NOT THERE IS A FOLD (A2-b, round 2). It used to be written
      //     `if (!all && only === null && current)`, and `current` is the FOLD — so an entity that
      //     exists ONLY as a parked line has no fold, the guard was skipped entirely, and one
      //     unscoped `forget(e, space)` deleted a newer sibling's retained op. An entity with no
      //     registers has no retraction either, so this now refuses, which is the same answer it
      //     gives every other unretracted entity.
      const current = api.registers().get(e);
      if (!all && only === null) {
        const aliveName = aliveFieldFor(parsed.kind);
        const levelName = aliveName === 'pub.alive' ? 'pub.level' : null;
        const dead = aliveName !== null && current?.get(aliveName)?.value === false;
        const privat = levelName !== null && current?.get(levelName)?.value === 'privat';
        if (!dead && !privat) {
          throw new OpLogError(`forget: ${e} is still live — ${aliveName ?? 'its tombstone register'} is not false`
            + `${levelName ? ` and ${levelName} is not 'privat'` : ''}. An unscoped forget blanks its content `
            + 'registers at their existing stamps, and because a blank wins the (stamp, opId) tie no re-delivery '
            + 'can undo it, while every peer that did not run the pass still shows the value. Pass {fields:[…]} for '
            + "an ADR 004 §5.3 trigger (ii) downgrade, or {values:'all'} for a deliberate hard purge.");
        }
      }

      // (c) then: fold what we currently know about this entity into the checkpoint, blanked.
      if (current) {
        const cells = new Map();
        for (const [f, r] of current) {
          const spec = fieldSpec(parsed.kind, f);
          const keepValue = only ? !only.has(f) : (!all && spec !== null && spec.gov === true);
          cells.set(f, keepValue ? r : Object.freeze({ value: null, stamp: r.stamp, author: r.author, op: r.op }));
        }
        regs.set(e, cells);
      }
      // (b) then: purge the lines — the ADMITTED ones only.
      //
      //     A PARKED LINE IS NEVER TOUCHED (A2-b, round 2), for the reason `collectTombstones`
      //     already gives in full: a parked op is retained precisely so that an app update can
      //     apply it, it may carry a stamp NEWER than every register this entity holds, and
      //     deleting it destroys a newer sibling's write — "loses the new thing", which is the
      //     whole reason §7.4 exists. It is also unrecoverable, because the id stays in `seen` and
      //     the fingerprint index answers a re-delivery `duplicate`. §7.4 beats ADR 004 §5.3 here
      //     exactly as it beats §7.3 there. The residue is that a parked op's plaintext survives a
      //     retraction until it can be classified; the store re-runs the pass after `unpark()`.
      //     NO FINGERPRINT IS KEPT for a purged body, unlike compaction's. A fingerprint of the
      //     retracted plaintext is precisely the derived residue §5.3 exists to get off this disk,
      //     and it buys nothing: what makes forget absorbing is that `registers.js:valueKey` ranks
      //     the blank above the value at the identical (stamp, opId), so a re-delivery is RE-FOLDED
      //     and still loses. Dedupe is never what protects this case.
      let purged = 0;
      for (const [id, entry] of [...live]) {
        if (entry.op.e === e && entry.op.space === space) { bodies.delete(id); live.delete(id); purged++; }
      }
      if (current) for (const r of current.values()) if (typeof r.op === 'string') bodies.delete(r.op);
      invalidate();
      return purged;
    },

    // ── tombstone GC (ADR 001 §7.3) ──────────────────────────────────────────

    /**
     * The server seq of one OP. This is the accessor §7.3 condition 3 should be evaluated with:
     * an opId identifies exactly one op, a stamp does not (attack A7).
     * @param {string} id @returns {bigint|null}
     */
    seqOfOp(id) {
      const v = seqById.get(id);
      return typeof v === 'bigint' ? v : null;
    },

    /**
     * The server seq for a STAMP — the MAXIMUM over every op that carries it.
     *
     * A stamp is unique per (device, ms, ctr), which our own clock guarantees for our own ops and
     * for nobody else's: one well-formed op reusing a stamp used to overwrite this entry, and a
     * LOWER seq collapsed the value §7.3 condition 3 is compared against and collected a tombstone
     * hundreds of seqs early (R15). It needs no adversary either — §8.1 stamps every migrated op
     * `GENESIS(index)` with `ZERO_DEVICE_SHORT`, so two boards migrated into one personal space
     * collide by construction. Taking the maximum can only make a collection HARDER, which is the
     * safe direction; `seqOfOp` is the exact answer and is what `collectTombstones` uses.
     * @returns {bigint|null}
     */
    seqOf(stamp) {
      const v = seqByStamp.get(stamp);
      return typeof v === 'bigint' ? v : null;
    },

    /**
     * Drop every entity that satisfies ALL THREE conditions of ADR 001 §7.3. `ctx` must carry
     * `nowMs`, `minDeviceSeq` and `minPushedSeq`; `seqOf` is supplied by this log unless the
     * caller overrides it.
     *
     * PARKED OPS ARE NEVER TOUCHED, and an entity that has one is NOT collectable. §7.3's three
     * conditions all reason about the entity's REGISTERS, and a parked op is by construction not
     * in the registers: it never contributed to condition 2's `max(stamps)` and never contributed
     * to condition 3, and it may well carry a stamp NEWER than every register the entity holds.
     * Deleting it here would destroy a newer sibling's write that was retained precisely so an
     * app update could apply it — "loses the new thing", §7.4's whole reason to exist — and it
     * would leave a device that has GC'd applying a different op set from one that has not.
     * §7.4 therefore beats §7.3: the tombstone waits until the op is understood.
     *
     * AND NEITHER IS AN UNPUSHED LIVE LINE (A7-b, round 2). The "every register must be acked"
     * guard inside `tombstoneCollectable` cannot see a write of ours that LOST the join to the
     * tombstone: a losing write leaves no register behind to check. Such a line was then deleted
     * here — an op discarded for being old, which §12.5 forbids outright — and deleting it is not
     * even the safe half of the choice, because RETAINING it while dropping the entity's registers
     * would fold it back into a live entity, which is R15 itself. The only correct answer is the
     * one §7.3 condition 3(b) already gives: an entity we still hold an unpushed line for is NOT
     * collectable. It becomes collectable the moment that line is acked.
     *
     * @param {{nowMs:number, minDeviceSeq:bigint, minPushedSeq:bigint,
     *          seqOf?:(s:string)=>(bigint|null), seqOfOp?:(id:string)=>(bigint|null)}} ctx
     * @returns {string[]} the entity keys collected
     */
    collectTombstones(ctx) {
      const full = api.registers();
      const guard = { ...ctx, seqOf: ctx?.seqOf ?? api.seqOf, seqOfOp: ctx?.seqOfOp ?? api.seqOfOp };
      const blocked = new Set();
      for (const { op } of parked.values()) blocked.add(op.e);        // §7.4 beats §7.3
      for (const e of live.values()) if (e.seq === null) blocked.add(e.op.e);   // §12.5 beats §7.3
      const dropped = [];
      for (const e of full.keys()) {
        if (blocked.has(e)) continue;
        if (tombstoneCollectable(full, e, guard)) dropped.push(e);
      }
      if (dropped.length === 0) return dropped;
      const gone = new Set(dropped);
      for (const e of dropped) regs.delete(e);
      for (const [id, entry] of [...live]) {
        if (gone.has(entry.op.e)) { rememberBody(id, canonOf(entry.op)); live.delete(id); }
      }
      pruneSeqIndex();
      invalidate();
      return dropped;
    },

    // ── transport cursors (ADR 003 §3.3) ─────────────────────────────────────

    /**
     * Advance a per-space cursor. NEVER moves backwards: the cursor is advanced only after a
     * batch has been folded and persisted, and a crash mid-pull must re-fetch rather than skip.
     * @returns {boolean} true iff it advanced
     */
    setCursor(space, seq) {
      const next = toSeq(seq);
      if (next === null) throw new OpLogError('setCursor: a seq is required');
      const prev = cursors.get(space);
      if (prev !== undefined && next <= prev) return false;
      cursors.set(space, next);
      return true;
    },

    /** @returns {bigint|null} */
    cursor(space) { return cursors.get(space) ?? null; },
    /** @returns {Object<string,string>} JSON-safe */
    cursors() { return cursorsObject(); },

    /** Record a server ack for an op already in the log. @returns {boolean} */
    ack(id, seq) {
      const entry = live.get(id) ?? parked.get(id);
      if (!entry) return false;
      entry.seq = toSeq(seq);
      noteSeq(id, entry.op.ts, entry.seq);
      invalidate();                 // an acked line can un-block a §7.3 collection
      return true;
    },

    // ── introspection ────────────────────────────────────────────────────────

    has(id) { return live.has(id) || parked.has(id); },
    isParked(id) { return parked.has(id); },
    get(id) { return live.get(id)?.op ?? parked.get(id)?.op ?? null; },
    get size() { return live.size; },
    get parkedSize() { return parked.size; },
    horizon() { return horizon; },
    stats() {
      return Object.freeze({
        live: live.size,
        parked: parked.size,
        seen: seen.size,
        spliced: spliced.size,
        entities: api.registers().size,
        horizon,
        cursors: cursorsObject(),
      });
    },
  };

  return api;
}

/**
 * A horizon that admits every op stamped strictly before `ms` (plus the vanishingly unlikely op
 * stamped at exactly `(ms, 0, all-zero device)`). This is how the §7.2 policy — "keep a 30-day
 * tail for debuggability" — is expressed without any module in core/ reading a clock.
 * @param {number} ms @returns {string}
 */
export function horizonBeforeMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw new OpLogError(`horizonBeforeMs: expected a non-negative number, got ${ms}`);
  return fmt(Math.floor(ms), 0, ZERO_DEVICE_SHORT);
}
