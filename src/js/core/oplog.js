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
//
// I/O. There is none. This is `core/` (ADR 005 §2): no file handle, no timer, no wall clock.
// `ports.now` is the injected clock (used only for `checkpoint().at` and for the 24 h future
// clamp); `ports.storage` is accepted, retained and never called — persisting `ops.jsonl` is
// `platform/oplogfile.js`'s job, driven by the store, and it must stay outside the synchronous
// `txn → apply → materialize → emit` path (ADR 001 §0.9).

import { cmp, msOf, fmt, isStamp } from './stamp.js';
import { ZERO_DEVICE_SHORT } from './ids.js';
import { canonicalJSON } from './canon.js';
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
   * Resolved CONTENT-ADDRESSABLY, never by arrival order: the body whose `canonicalJSON` sorts
   * higher is the one that stands, which is the identical rule `authz.js` applies, so two Macs
   * that received the two envelopes in opposite orders hold the same body. The result carries
   * `kept: 'existing' | 'incoming'` and the id joins `splicedIds()`.
   */
  CONFLICT: 'conflict',
});

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
 * @param {Map<string, Map<string, {value:any, stamp:string, author:string}>>} regs
 * @param {string} e  entityKey
 * @param {{ nowMs:number, minDeviceSeq:bigint, minPushedSeq:bigint, seqOf:(s:string)=>(bigint|null) }} ctx
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

  // Every register this entity still holds must itself be ACKED. An unacked stamp is one of our
  // OWN writes that never reached the relay — collecting around it drops the very stamp that
  // would have absorbed it, and it comes back on the next push.
  for (const r of cells.values()) if (typeof ctx.seqOf(r.stamp) !== 'bigint') return false;

  const seq = ctx.seqOf(newest);
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
 * @param {{ now: () => number, storage?: any, registers?: Object }} ports
 *        `now` is REQUIRED: core/ may not read the wall clock itself (ADR 005 §2), and the 24 h
 *        future clamp is a safety rule that must not be silently unarmed by an absent clock.
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

  /** @type {Map<string, {op:Object, seq:bigint|null}>} admitted ops, in arrival order */
  let live = new Map();
  /** @type {Map<string, {op:Object, seq:bigint|null, reason:string, fields?:string[]}>} */
  let parked = new Map();
  /** every opId ever appended, INCLUDING ones compacted away. Dedupe is a performance
   *  optimisation only (ADR 001 §6): re-appending a compacted op merges to the same registers. */
  let seen = new Set();
  /** stamp → server seq. Pruned on compaction to the stamps the checkpoint still holds, which is
   *  exactly the set `tombstoneCollectable` can ask about. */
  let seqByStamp = new Map();
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

  function admit(op, seq) {
    live.set(op.id, { op: retain(op), seq });
    seen.add(op.id);
    if (!seqByStamp.has(op.ts) || seq !== null) seqByStamp.set(op.ts, seq);
    invalidate();
  }

  /** Install a classified op in the live or the parked map, and describe what happened. */
  function place(op, seq, c) {
    if (c.status === 'park') {
      const entry = { op: retain(op), seq, reason: c.parkReason };
      if (c.fields) entry.fields = c.fields;
      parked.set(op.id, entry);
      seen.add(op.id);
      invalidate();
      return result(APPEND.PARKED, {
        reason: c.reason, parkReason: c.parkReason, ...(c.fields ? { fields: c.fields } : {}),
      });
    }
    admit(op, seq);
    return result(APPEND.APPENDED, {});
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
   */
  function resolveHorizon(opts, mode) {
    const fallback = mode === 'read' ? (horizon ?? maxLiveStamp()) : (maxLiveStamp() ?? horizon);
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

  function seqsObject() {
    const out = {};
    for (const s of [...seqByStamp.keys()].sort()) {
      const v = seqByStamp.get(s);
      if (typeof v === 'bigint') out[s] = String(v);
    }
    return out;
  }

  /** Keep only the stamps a surviving register still holds, plus the stamps of retained lines. */
  function pruneSeqIndex() {
    const keep = new Set();
    for (const cells of regs.values()) for (const r of cells.values()) keep.add(r.stamp);
    for (const { op } of live.values()) keep.add(op.ts);
    for (const { op } of parked.values()) keep.add(op.ts);
    for (const s of [...seqByStamp.keys()]) if (!keep.has(s)) seqByStamp.delete(s);
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
     * ENVELOPE SPLICING (ADR 002 §5.1) — two DIFFERENT bodies under one opId — is resolved
     * CONTENT-ADDRESSABLY: the body whose `canonicalJSON` sorts higher stands, whichever arrived
     * first. That is byte-for-byte the rule `authz.js` already applies to the same situation, and
     * it has to be the same rule: resolving by arrival order means two honest Macs that received
     * the two envelopes in opposite orders hold different registers, from an identical op set,
     * for ever. The resolution runs for PARKED bodies too — a parked op is retained precisely so
     * it can be applied after an app update, so "whichever arrived first" would merely defer the
     * divergence rather than avoid it. Either way the id joins `splicedIds()`.
     *
     * ONE RESIDUAL LIMIT, stated rather than hidden: once an opId has been COMPACTED its body is
     * gone, so a second body arriving afterwards is indistinguishable from an honest duplicate
     * and is reported as one. Nothing in the log can compare against a body it no longer holds.
     * Splices are a forgery/corruption signal, not a steady-state event, and the window is the
     * one in which the two envelopes are separated by a compaction.
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

      const known = typeof op.id === 'string' ? (live.get(op.id) ?? parked.get(op.id)) : undefined;
      if (!known && typeof op.id === 'string' && seen.has(op.id)) return result(APPEND.DUPLICATE, {});

      // Classify BEFORE resolving a splice: a body that is a protocol violation is not stored at
      // all, so it may not win — or even disturb — a splice against a well-formed one.
      const c = classifyOp(op, { nowMs: now(), haveEpochKey: meta.haveEpochKey });
      if (c.status === 'reject') return result(APPEND.REJECTED, { reason: c.reason });

      if (known) {
        const mine = canonOf(known.op);
        const theirs = canonOf(op);
        if (theirs !== null && theirs === mine) {
          if (seq !== null && known.seq === null) { known.seq = seq; seqByStamp.set(known.op.ts, seq); }
          return result(APPEND.DUPLICATE, {});
        }
        spliced.add(op.id);
        const reason = `opId ${op.id} is already in the log with different content — envelope splicing `
          + '(ADR 002 §5.1); the body whose canonical form sorts higher stands, on every device';
        if (theirs === null || (mine !== null && mine > theirs)) {
          return result(APPEND.CONFLICT, { reason, kept: 'existing' });
        }
        // The incoming body is the content-addressable max. Drop the one we hold and re-fold:
        // `registers()` is `checkpoint ⊕ live`, so removing the loser from `live` un-applies it
        // exactly (nothing below the horizon can be reached here — see the compaction note above).
        live.delete(op.id);
        parked.delete(op.id);
        invalidate();
        const placed = place(op, seq ?? known.seq, c);
        return result(APPEND.CONFLICT, {
          reason,
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
     * Every LINE the log holds — live ops in arrival order, then parked ones. This is the content
     * of `ops.jsonl`, and it is what `{checkpoint(), ops()}` has to mean for that documented pair
     * to round-trip: `checkpoint()` folds only what is APPLIED, so if `ops()` also omitted the
     * parked lines then an ordinary relaunch would silently destroy every parked op — the exact
     * "loses the new thing" failure §7.4 and §12.5 exist to prevent, with no adversary and no
     * corruption required. `load()` re-classifies the whole tail anyway (it must: yesterday's
     * `unknownKind` is today's ordinary op), so a parked line simply re-parks.
     *
     * Pass `{liveOnly:true}` — or the older `{includeParked:false}` — for the ADMITTED ops alone,
     * which is what a caller reasoning about applied state wants.
     *
     * NOTHING may depend on this order (ADR 001 §0.2: state is a function of the SET); it is the
     * order that makes a log file readable by a human, and there is a test that the fold does not
     * change under permutation.
     * @param {{space?:string, sinceStamp?:string, entity?:string, kind?:string,
     *          includeParked?:boolean, liveOnly?:boolean}} [q]
     * @returns {Object[]} a fresh array; mutating it cannot touch the log
     */
    ops(q = {}) {
      const wantParked = q.liveOnly === true ? false : (q.includeParked ?? true);
      const out = [];
      for (const { op } of live.values()) if (matches(op, q)) out.push(op);
      if (wantParked) for (const { op } of parked.values()) if (matches(op, q)) out.push(op);
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
     * The fold of a prefix (ADR 001 §7.2). Pure: it does not mutate the log.
     * @param {{horizon?:string}} [opts] default: fold everything currently held
     * @returns {{horizon:string, regs:Object, cursors:Object, seqs:Object, at:number}}
     *   `seqs` is additive to ops.contract.js §8: without persisting stamp→seq, tombstone GC
     *   silently stops working after every relaunch, because condition 3 becomes unevaluable.
     */
    checkpoint(opts = {}) {
      const h = resolveHorizon(opts, 'read');
      return Object.freeze({
        horizon: h,
        regs: R.serializeRegisters(foldTo(h)),
        cursors: cursorsObject(),
        seqs: seqsObject(),
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
        if (cmp(entry.op.ts, h) <= 0) { live.delete(id); dropped++; }
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
     * @param {{checkpoint?:Object, tail?:Array}} o  tail entries are ops, or `{op, seq}` pairs
     * @returns {Map} the full register map
     */
    load(o = {}) {
      live = new Map(); parked = new Map(); seen = new Set(); seqByStamp = new Map();
      regs = R.emptyRegisters(); horizon = null; cursors = new Map(); spliced = new Set(); invalidate();

      const cp = o.checkpoint;
      if (cp) {
        if (cp.regs !== undefined && cp.regs !== null) regs = R.deserializeRegisters(cp.regs);
        if (cp.horizon !== undefined && cp.horizon !== null) {
          if (!isStamp(cp.horizon)) throw new OpLogError(`load: checkpoint.horizon is not a stamp: ${JSON.stringify(cp.horizon)}`);
          horizon = cp.horizon;
        }
        if (cp.cursors && typeof cp.cursors === 'object') {
          for (const [s, v] of Object.entries(cp.cursors)) if (!isForbiddenKey(s)) cursors.set(s, toSeq(v));
        }
        if (cp.seqs && typeof cp.seqs === 'object') {
          for (const [s, v] of Object.entries(cp.seqs)) if (isStamp(s)) seqByStamp.set(s, toSeq(v));
        }
      }
      for (const line of o.tail ?? []) {
        if (line && typeof line === 'object' && line.op) api.append(line.op, { seq: line.seq });
        else api.append(line);
      }
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
      const current = api.registers().get(e);
      if (!all && only === null && current) {
        const aliveName = aliveFieldFor(parsed.kind);
        const levelName = aliveName === 'pub.alive' ? 'pub.level' : null;
        const dead = aliveName !== null && current.get(aliveName)?.value === false;
        const privat = levelName !== null && current.get(levelName)?.value === 'privat';
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
      // (b) then: purge the lines. Both maps — a parked op for this entity is still a line.
      let purged = 0;
      for (const [id, entry] of [...live]) {
        if (entry.op.e === e && entry.op.space === space) { live.delete(id); purged++; }
      }
      for (const [id, entry] of [...parked]) {
        if (entry.op.e === e && entry.op.space === space) { parked.delete(id); purged++; }
      }
      invalidate();
      return purged;
    },

    // ── tombstone GC (ADR 001 §7.3) ──────────────────────────────────────────

    /** @returns {bigint|null} the server seq of the op that minted `stamp`, or null if unknown. */
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
     * @param {{nowMs:number, minDeviceSeq:bigint, minPushedSeq:bigint, seqOf?:(s:string)=>(bigint|null)}} ctx
     * @returns {string[]} the entity keys collected
     */
    collectTombstones(ctx) {
      const full = api.registers();
      const guard = { ...ctx, seqOf: ctx?.seqOf ?? api.seqOf };
      const hasParked = new Set();
      for (const { op } of parked.values()) hasParked.add(op.e);
      const dropped = [];
      for (const e of full.keys()) {
        if (hasParked.has(e)) continue;                 // §7.4 beats §7.3 — see above
        if (tombstoneCollectable(full, e, guard)) dropped.push(e);
      }
      if (dropped.length === 0) return dropped;
      const gone = new Set(dropped);
      for (const e of dropped) regs.delete(e);
      for (const [id, entry] of [...live]) if (gone.has(entry.op.e)) live.delete(id);
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
      seqByStamp.set(entry.op.ts, entry.seq);
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
