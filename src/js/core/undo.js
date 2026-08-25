// src/js/core/undo.js — transaction groups, pre/post images, inverse-op emission.
// ADR 001 §7.1 (rules U1–U10) · ADR 005 §1.1 · ops.contract.js §7 · store.contract.js.
// Stories 5.4 (solo undo/redo), 18.4 (own actions only), 18.6 (undo of a delete resurrects).
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2). No clock, no CSPRNG read directly: the
// stamp source (`mint`) and the id sources are injected exactly as they are everywhere else in
// core/.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE IDEA. UNDO NEVER REWINDS THE LOG.
//
// The log is append-only and a peer may already have merged the op you are undoing. So ⌘Z emits
// NEW ops — fresh opIds, fresh stamps, through the same path a user action takes — that assign
// the fields' PRE-values (rule U4). Those ops compete for LWW like any other write. They can win
// (the normal case: this device's next stamp is greater than anything it has observed) and they
// can legitimately LOSE to a change that arrives afterwards with a greater stamp. Both outcomes
// are correct; neither is a special case in the merge.
//
// There is no `_applyContent(snapshot)` anywhere in this module, and there must never be one.
// Restoring a snapshot would silently discard every concurrent remote write to every field the
// snapshot covers — including fields the undone action never touched.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT AN UNDO ENTRY IS, AND WHAT IT IS NOT (rule U3 — privacy).
//
// An entry is `{ gid, label, pre, post }` where `pre`/`post` are arrays of
// `[entityKey, fieldName, value]` triples. It holds NO op, NO stamp, NO author, NO opId and no
// envelope. It is captured from the registers at emit time, it lives in memory on this device
// (rule U7), and nothing in this file can serialise it. Pre-images are a local editing
// convenience; they are not history and they never reach a wire or a disk.
//
// ─────────────────────────────────────────────────────────────────────────────
// SCOPED TO MY OWN ACTIONS (rule U2, story 18.4).
//
// Only `txn()` writes the stacks. `applyRemote()` writes neither and NEVER clears redo. This
// module enforces that structurally in two places:
//   1. `captureImages()` refuses an op whose `act` is not me — a foreign op cannot even be
//      turned into an undo entry, so a retrofit that accidentally routed remote ops through the
//      transaction path fails loudly instead of putting Mama's edit on my ⌘Z stack.
//   2. There is no method on `UndoStacks` that takes an op. The stacks cannot be fed from the
//      remote path at all, because the remote path has nothing to hand them.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE INVERSE RULES (ADR 001 §7.1, "Inverse computation"), stated exactly.
//
//   generic   for each field the group wrote, restore the value the register held BEFORE the
//             group — `null` where the register did not exist. `null` is a first-class value
//             meaning "cleared"; it is not "leave it alone".
//   create    an op carrying `_born` created the entity. Its inverse is `{_alive: false}` and
//             NOTHING ELSE: the content registers are deliberately left standing, so a later
//             redo — or a peer's resurrect — brings back the newest content rather than the
//             blanks (ADR 001 §6, "Delete/edit races converge"). All other fields that op wrote
//             are dropped from the images for that entity.
//   delete    the inverse of `{_alive:false}` is `{_alive:true}` ON THE ORIGINAL ENTITY ID —
//             the convergence-friendly reading of 18.6: a NEW op on the SAME entity, so a peer
//             that already tombstoned sees a resurrect rather than a duplicate entry.
//   `_born`   IS NEVER WRITTEN BY AN INVERSE OP, in either direction. It is `writeOnce`, and an
//             entity's creation stamp is its sort key (ADR 001 §5 step 5): preserving it is what
//             makes undo→redo of a create restore the entry to its ORIGINAL POSITION in the
//             array rather than to the end.
//
// A field whose pre-value must be reconstructed rather than read: `_alive` on an entity that has
// no `_alive` register. If the entity has other registers it existed and was alive (§5 step 3
// drops only `_alive === false`), so the pre-value is `true`; if it has no registers at all it
// did not exist, so the pre-value is `false`. Writing that out explicitly, rather than restoring
// `null` and relying on absence to mean "alive", is ADR 001 §5 step 3's rule that meaning is
// never inferred from a missing field.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS NOT UNDOABLE, AND WHY IT IS A FILTER RATHER THAN A BAN.
//
// v1's `mutate()` snapshots exactly `CONTENT_KEYS = notes/bars/categories/scratchpads`
// (`store.js:97,134-141`). Settings written INSIDE a mutation — `interact.js:546` sets
// `settings.lastCategoryId` in the middle of create-note — are therefore not rolled back by ⌘Z,
// deliberately, so "last used category" (4.2) is not dragged backwards. Rule U6 is the same fact
// stated in op terms: `pref.set` carries no gid and is never undone.
//
// So this module FILTERS local/pref writes out of the images instead of rejecting them. That is
// v1's behaviour reproduced exactly, and it is why `UNDOABLE_KINDS` is note/bar/cat/pad — v1's
// four content keys, one for one.
//
// Family (`pub.set`) registers are absent from that list for a different reason: a publication is
// DERIVED from the truth (`derivePublication`, ops.contract §6). Undoing the truth and letting
// the publisher re-derive is the only path that cannot leave the family space describing a state
// the owner's board no longer holds.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SHADOW-UNDO ASSERTION (ADR 001 §7.1's first mechanical guard, PLAN risk R5).
//
// With `shadow` armed (default: `DEV`), every entry additionally carries a v1-style
// `_contentClone()` of the state the entry's restore is expected to produce. After the store has
// applied the inverse ops and re-materialised, `stacks.verify(state)` deep-compares and throws
// `ShadowUndoError` on any mismatch. It is the same bookkeeping v1's snapshot undo does, running
// beside the op-log undo and disagreeing out loud — which is how "did we cover every mutation?"
// becomes a test failure instead of a support email.
//
// IT IS A *SOLO* EQUIVALENCE CHECK, AND IT HAS TO BE. ADR 001 §7.1 states the solo-equivalence
// theorem itself as "With one device and no remote ops" — and that qualifier is load-bearing for
// the assertion too, which the ADR does not say. A v1-style snapshot is a WHOLE-CONTENT
// expectation: it records what every note said before my transaction. The moment a peer's op
// lands, that expectation is stale in a way that has nothing to do with undo, and a whole-content
// comparison would then fail on *correct* behaviour — restoring my `date` while Mama's concurrent
// edit of the same note's `text` rightly survives (18.5) is precisely the case.
//
// So the store calls `stacks.remoteApplied()` from `applyRemote()`, and any entry captured before
// that point has its shadow expectation dropped. Note carefully what this does NOT do: it creates
// no entry, removes none, reorders none, and does not clear the redo branch (rule U2 stands
// untouched). It only retires a DEV-only diagnostic that has stopped being meaningful. With
// `shadow` disarmed it is a no-op in the strictest sense.
//
// The consequence is the right one: the assertion runs at full strength exactly where LZP-402's
// acceptance criterion lives — solo mode, and therefore the whole v1 regression suite — and it
// declines to make claims about the concurrent case, which is what property tests P1–P4 and the
// fleet scenarios are for.
// ─────────────────────────────────────────────────────────────────────────────

import { DEV } from './dev.js';
import { kindOfEntity, isMemberId, isDeviceId } from './entities.js';
import {
  makeOp, opKindForEntity, flattenPref,
  noteSet, barSet, catSet, padSet, prefSet,
} from './ops.js';
import { opId as defaultOpId, groupId as defaultGroupId } from './ids.js';
// One import, one frozen array of names, no behaviour: the shadow assertion compares v1 CONTENT,
// so it needs the single authority on which fields are v2-additive. materialize.js is that
// authority (it is the file that decides which fields it decorates with) and it does not import
// this one, so the dependency is one-way. See `shadowContent`.
import { V2_ENTRY_FIELDS } from './materialize.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Constants and errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v1's `store.js:97` list, verbatim: the four keys `_contentClone()` snapshots and therefore the
 * four ⌘Z rolls back. `shadowContent()` covers exactly these and nothing else (it names them
 * one by one because notes and bars need the foreign-entry filter and the others do not).
 * Exported so the retrofit and the regression suite have one place to read the list.
 */
export const CONTENT_KEYS = Object.freeze(['notes', 'bars', 'categories', 'scratchpads']);

/** v1's `UNDO_LIMIT` (`store.js:10`). Rule U5: it counts GROUPS, not ops. */
export const UNDO_LIMIT = 50;

/** The entity kinds ⌘Z restores — v1's four content keys, one for one. See the header. */
export const UNDOABLE_KINDS = Object.freeze(['note', 'bar', 'cat', 'pad']);
const UNDOABLE = new Set(UNDOABLE_KINDS);

/** Thrown when a transaction or an undo stack is used in a way that cannot be correct. */
export class UndoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UndoError';
  }
}

/**
 * Thrown when the op-log undo and the v1-style snapshot it ran beside disagree. This is never a
 * user-visible condition: it means a transaction's op set did not describe everything that
 * transaction changed, which is a bug in a mutate site, not in the user's data.
 */
export class ShadowUndoError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ShadowUndoError';
    /** @type {{direction:string, label:string, difference:string}} */
    this.detail = detail;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Reading the register map
//
// The RegisterMap is `Map<EntityKey, Map<field, {value, stamp, author}>>` (ops.contract §3).
// This module only READS it, and only through these two helpers, so it has no dependency on
// registers.js and cannot accidentally mutate the store's state while capturing a pre-image.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Map} regs @param {string} e @param {string} field
 * @returns {{value:any, stamp:string, author:string}|undefined}
 */
export function readRegister(regs, e, field) {
  if (!regs || typeof regs.get !== 'function') return undefined;
  const cell = regs.get(e);
  if (!cell || typeof cell.get !== 'function') return undefined;
  return cell.get(field);
}

/** True when the entity has at least one register, i.e. it exists at all. */
export function entityExists(regs, e) {
  if (!regs || typeof regs.get !== 'function') return false;
  const cell = regs.get(e);
  return !!cell && typeof cell.size === 'number' && cell.size > 0;
}

/**
 * The value to restore for one field. See "THE INVERSE RULES" in the header for why `_alive`
 * is reconstructed rather than restored as `null`.
 * @param {Map} regs @param {string} e @param {string} field @returns {any}
 */
export function preValueOf(regs, e, field) {
  const reg = readRegister(regs, e, field);
  if (reg) return reg.value;
  if (field === '_alive') return entityExists(regs, e);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Capturing the images
// ─────────────────────────────────────────────────────────────────────────────

/** An ordered `Map<entityKey, Map<field, value>>` flattened to triples, insertion order kept. */
function toTriples(byEntity) {
  const out = [];
  for (const [e, fields] of byEntity) for (const [f, v] of fields) out.push([e, f, v]);
  return out;
}

/**
 * Turn one transaction's ops into the `pre` / `post` images ⌘Z and ⇧⌘Z restore.
 *
 * MUST BE CALLED BEFORE THE OPS ARE APPLIED. `pre` is read out of the registers as they stand,
 * so a caller that folds first and captures second records the post-state twice and produces an
 * undo that does nothing — the failure mode the shadow assertion exists to catch.
 *
 * @param {Map} regs   the RegisterMap in its PRE-transaction state
 * @param {Iterable<Object>} ops  the ops the transaction is about to apply
 * @param {{me?:string}} [opts]   `me` arms the story-18.4 guard: a foreign op is refused
 * @returns {{pre:Array<[string,string,any]>, post:Array<[string,string,any]>}}
 */
export function captureImages(regs, ops, opts = {}) {
  const list = [...(ops || [])];
  const me = opts.me;

  // Pass 1 — which entities does this group CREATE? An entity created here is inverted as a
  // whole ("un-create it"), so its other field writes must not also appear in the images.
  const created = new Set();
  for (const op of list) {
    if (me !== undefined && op.act !== me) {
      throw new UndoError(
        `captureImages: op ${op.id} was authored by ${op.act}, not by ${me} — ` +
        'another member\'s ops must never enter this device\'s undo stack (story 18.4)',
      );
    }
    if (!UNDOABLE.has(kindOfEntity(op.e))) continue;
    if (Object.prototype.hasOwnProperty.call(op.f, '_born')) created.add(op.e);
  }

  // Pass 2 — the images. `pre` keeps the FIRST value seen for a field (the value before the
  // group); `post` keeps the LAST (the value after it). Two ops in one group touching the same
  // field is not something the 22 v1 mutate sites do, but a group that did would otherwise
  // record an undo that restores an intermediate value.
  const pre = new Map();
  const post = new Map();
  const put = (map, e, f, v, keepFirst) => {
    let cell = map.get(e);
    if (!cell) { cell = new Map(); map.set(e, cell); }
    if (keepFirst && cell.has(f)) return;
    cell.set(f, v);
  };

  for (const op of list) {
    const kind = kindOfEntity(op.e);
    if (!UNDOABLE.has(kind)) continue;        // pref / family / member / space — rule U6
    if (created.has(op.e)) {
      // The create rule: un-create is a tombstone, re-create is a resurrect, and every content
      // register is left exactly where it is.
      put(pre, op.e, '_alive', false, true);
      put(post, op.e, '_alive', true, false);
      continue;
    }
    // No `_born` filter is needed here and there deliberately is not one: an op carrying `_born`
    // put its entity in `created` in pass 1, so it took the branch above and never reaches this
    // loop. A filter here would be unreachable code pretending to be a safety net. The invariant
    // is enforced where it can actually be violated — `undoableTriples()` (a caller handing
    // `push()` an image it built itself) and `opsFromImage()` (the last gate before an op is
    // minted) — and both of those have a test.
    for (const f of Object.keys(op.f)) {
      put(pre, op.e, f, preValueOf(regs, op.e, f), true);
      put(post, op.e, f, op.f[f], false);
    }
  }

  return { pre: toTriples(pre), post: toTriples(post) };
}

/** Drop anything that is not an undoable content register. Defensive: `captureImages` already
 *  filtered, but `push()` is a public entry point and v1's filter is the invariant, not the
 *  caller's discipline. */
function undoableTriples(triples) {
  const out = [];
  for (const t of triples || []) {
    if (!Array.isArray(t) || t.length !== 3) {
      throw new UndoError(`undo image entries are [entityKey, field, value] triples, got ${JSON.stringify(t)}`);
    }
    if (t[1] === '_born') continue;
    if (!UNDOABLE.has(kindOfEntity(t[0]))) continue;
    out.push(Object.freeze([t[0], t[1], t[2]]));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Images → ops
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the ops that assign a set of `[entityKey, field, value]` triples.
 *
 * ONE OP PER ENTITY, because one op carries one stamp for every field in it (ADR 001 §2) and the
 * fields of one entity restored by one ⌘Z should not be able to interleave with a concurrent
 * remote write in the middle. Entities keep the order they appear in the image, so the emitted
 * group is deterministic and a test can pin it.
 *
 * @param {Object} ctx an OpCtx: { act, dev, gid, mint, newOpId, space, familySpaceId }
 * @param {Array<[string,string,any]>} triples
 * @returns {Object[]} frozen Ops
 */
export function opsFromImage(ctx, triples) {
  const byEntity = new Map();
  for (const [e, f, v] of triples) {
    const kind = kindOfEntity(e);
    if (!UNDOABLE.has(kind)) {
      throw new UndoError(`opsFromImage: ${e} is not an undoable entity (${UNDOABLE_KINDS.join('|')})`);
    }
    if (f === '_born') throw new UndoError('opsFromImage: `_born` is write-once and is never restored');
    let patch = byEntity.get(e);
    if (!patch) { patch = {}; byEntity.set(e, patch); }
    patch[f] = v;
  }
  const ops = [];
  for (const [e, patch] of byEntity) {
    ops.push(makeOp(ctx, opKindForEntity(kindOfEntity(e)), e, patch));
  }
  return ops;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The shadow (v1-style snapshot) side of the assertion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v1's `_contentClone()` (`store.js:134-138`), in shape and in scope: a deep clone of exactly the
 * four content keys, reduced to what a v1 board would have held.
 *
 * TWO REDUCTIONS, both forced by what the assertion actually claims.
 *
 * The claim is "the op-log undo agrees with v1's snapshot undo". v1's snapshot holds v1 entries,
 * so the comparison is over v1 fields:
 *
 *   - **The v2-additive decoration is dropped** (`V2_ENTRY_FIELDS`, ADR 001 §5 step 4). Three of
 *     those fields are DERIVED FROM STAMPS — `createdAt`, `updatedAt`, `updatedBy` — and an undo
 *     emits fresh ops, so `updatedAt` MUST move forward. That is correct behaviour and it is what
 *     17.6's "geändert So." should say; comparing it would make the assertion fire on every
 *     single undo. The rest are dropped with them so that "v1 fields" has one definition and not
 *     two. The v2-only registers (`visibility`, `coEdit`, `defaultVisibility`) are therefore
 *     outside this assertion's remit and are covered by direct tests instead.
 *   - **Foreign entries are dropped.** v1 has no representation for one, and whether a foreign
 *     entry is on the board is decided by a peer's ops, never by my ⌘Z.
 *
 * Settings are absent for the third reason, the ADR's own: they are configuration, not board
 * content (5.4), and v1 does not roll them back either.
 *
 * @param {Object} state a materialised state
 * @returns {{notes:Object[], bars:Object[], categories:Object[], scratchpads:Object}}
 */
export function shadowContent(state) {
  if (!state || typeof state !== 'object') {
    throw new UndoError('shadowContent: a materialised state object is required');
  }
  const additive = new Set(V2_ENTRY_FIELDS);
  const v1Entry = (e) => {
    const o = {};
    for (const k of Object.keys(e)) if (!additive.has(k)) o[k] = e[k];
    return o;
  };
  const own = (list) => (list || []).filter((e) => !e.isForeign).map(v1Entry);
  return {
    notes: structuredClone(own(state.notes)),
    bars: structuredClone(own(state.bars)),
    categories: structuredClone((state.categories || []).map(v1Entry)),
    scratchpads: structuredClone(state.scratchpads),
  };
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * The first structural difference between two JSON-shaped values, as a readable path, or `null`
 * when they are identical. A diff beats a boolean here: the assertion fires inside a `queueMicro`
 * -free synchronous undo, and "notes[3].date: "2026-03-01" vs "2026-03-09"" names the bug where
 * "shadow mismatch" would start a debugging session.
 * @returns {string|null}
 */
export function firstDifference(a, b, path = '$') {
  if (Object.is(a, b)) return null;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return `${path}: ${ta} vs ${tb}`;
  if (ta === 'array') {
    if (a.length !== b.length) return `${path}.length: ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (ta === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) {
      return `${path}: keys ${JSON.stringify(ka)} vs ${JSON.stringify(kb)}`;
    }
    for (const k of ka) {
      const d = firstDifference(a[k], b[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
}

/** @returns {boolean} */
export const sameContent = (a, b) => firstDifference(a, b) === null;

// ─────────────────────────────────────────────────────────────────────────────
// 5. The stacks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} UndoStacks
 * @property {(gid:string, label:string, pre:Array, post:Array, shadow?:Object) => boolean} push
 * @property {(state?:Object) => Object[]} undo
 * @property {(state?:Object) => Object[]} redo
 * @property {() => boolean} canUndo
 * @property {() => boolean} canRedo
 * @property {() => void} clear
 * @property {(state:Object) => boolean} verify
 */

/**
 * @param {Object} cfg
 * @param {number}   [cfg.limitGroups]  rule U5 — GROUPS, not ops. Default `UNDO_LIMIT` (50).
 * @param {() => string} cfg.mint       `clock.tick()`. Required; core/ reads no clock (ADR 005 §2).
 * @param {string}   cfg.act            my MemberId — every emitted inverse op is authored by me
 * @param {string}   cfg.dev            this DeviceId
 * @param {string}   [cfg.space]        the personal space id; defaults to ops.js's placeholder
 * @param {string|null} [cfg.familySpaceId]
 * @param {() => string} [cfg.newOpId]  defaults to `ids.opId`
 * @param {() => string} [cfg.newGid]   defaults to `ids.groupId`
 * @param {boolean}  [cfg.shadow]       arm the shadow assertion. Defaults to `DEV`.
 * @returns {UndoStacks}
 */
export function createUndoStacks(cfg = {}) {
  const limitGroups = cfg.limitGroups ?? UNDO_LIMIT;
  if (!Number.isInteger(limitGroups) || limitGroups < 1) {
    throw new UndoError(`createUndoStacks: limitGroups must be a positive integer, got ${JSON.stringify(cfg.limitGroups)}`);
  }
  if (typeof cfg.mint !== 'function') {
    throw new UndoError('createUndoStacks: `mint` is required — core/ may not read a clock (ADR 005 §2)');
  }
  if (!isMemberId(cfg.act)) throw new UndoError(`createUndoStacks: act must be a MemberId, got ${JSON.stringify(cfg.act)}`);
  if (!isDeviceId(cfg.dev)) throw new UndoError(`createUndoStacks: dev must be a DeviceId, got ${JSON.stringify(cfg.dev)}`);

  const newOpId = cfg.newOpId ?? defaultOpId;
  const newGid = cfg.newGid ?? defaultGroupId;
  const shadowOn = cfg.shadow ?? DEV;

  /** @type {Array<{gid:string,label:string,pre:Array,post:Array,shadow:Object|null}>} */
  const undoStack = [];
  /** @type {Array<{gid:string,label:string,pre:Array,post:Array,shadow:Object|null}>} */
  const redoStack = [];
  /** What `verify()` will check, set by the last `undo()`/`redo()`. */
  let pending = null;
  /** Bumped by `remoteApplied()`. An entry captured under an older epoch has a stale
   *  whole-content shadow and its expectation is retired — see the header. */
  let epoch = 0;

  /** An OpCtx for one emitted group. `gid` is FRESH: an undo is itself a user action, and rule
   *  U1 says one user action is one group. Reusing the undone group's gid would put two distinct
   *  groups on the wire under one identifier. */
  const ctxFor = (gid) => ({
    act: cfg.act,
    dev: cfg.dev,
    gid,
    mint: cfg.mint,
    newOpId,
    space: cfg.space,
    familySpaceId: cfg.familySpaceId ?? null,
  });

  function requireShadow(state, where) {
    if (!shadowOn) return null;
    if (!state || typeof state !== 'object') {
      throw new UndoError(`${where}: the shadow assertion is armed, so the current materialised state is required`);
    }
    return shadowContent(state);
  }

  return {
    /**
     * Record one LOCAL transaction. Called by `store.txn()` and by nothing else — `applyRemote()`
     * has no way in, which IS story 18.4 (rule U2).
     *
     * Returns false, and records nothing, when the transaction wrote no undoable register. That
     * covers the ADR's "emitting zero ops is the same as declining" and the `pref`-only case, and
     * in both of those the redo branch is deliberately NOT dropped: v1 keeps a pending redo alive
     * across a settings change, and a transaction that changed no content is not a history event.
     */
    push(gid, label, pre, post, shadow) {
      const p = undoableTriples(pre);
      const q = undoableTriples(post);
      if (p.length === 0 && q.length === 0) return false;
      if (shadowOn && (!shadow || typeof shadow !== 'object')) {
        throw new UndoError('push: the shadow assertion is armed, so the transaction must capture a v1-style pre-image');
      }
      undoStack.push({
        gid,
        label,
        pre: Object.freeze(p),
        post: Object.freeze(q),
        shadow: shadowOn ? shadow : null,
        epoch,
      });
      // Rule U5 — the limit counts groups. v1 drops the OLDEST first (`store.js:152`).
      while (undoStack.length > limitGroups) undoStack.shift();
      redoStack.length = 0;                       // a new mutation drops the redo branch
      return true;
    },

    /**
     * Pop the newest group and return the ops that restore its pre-values. The caller applies
     * them, re-materialises, and calls `verify(state)`.
     * @param {Object} [state] the CURRENT materialised state; required when the shadow is armed
     * @returns {Object[]} `[]` when there is nothing to undo (the store maps that to v1's `false`)
     */
    undo(state) {
      const entry = undoStack.pop();
      if (!entry) { pending = null; return []; }
      // Captured BEFORE the inverse ops are applied — exactly what v1's `undo()` pushes onto its
      // redo stack (`store.js:177`), so redo's expectation is the state undo is about to leave.
      const shadowBefore = requireShadow(state, 'undo');
      const ops = opsFromImage(ctxFor(newGid()), entry.pre);
      redoStack.push({ ...entry, shadow: shadowBefore, epoch });
      pending = { direction: 'undo', label: entry.label, expected: entry.epoch === epoch ? entry.shadow : null };
      return ops;
    },

    /** The mirror image of `undo()`. @param {Object} [state] @returns {Object[]} */
    redo(state) {
      const entry = redoStack.pop();
      if (!entry) { pending = null; return []; }
      const shadowBefore = requireShadow(state, 'redo');
      const ops = opsFromImage(ctxFor(newGid()), entry.post);
      undoStack.push({ ...entry, shadow: shadowBefore, epoch });
      pending = { direction: 'redo', label: entry.label, expected: entry.epoch === epoch ? entry.shadow : null };
      return ops;
    },

    /**
     * DEV-ONLY BOOKKEEPING, called from `store.applyRemote()`. It retires shadow expectations
     * captured before this point, because a v1-style whole-content snapshot stops being a valid
     * expectation the moment somebody else writes to the board (see the header).
     *
     * IT IS NOT A WRITE TO THE STACKS in the sense rule U2 forbids: no entry is created, removed
     * or reordered, and the redo branch is untouched. With the shadow disarmed it does nothing at
     * all. `applyRemote()` still "writes neither stack".
     */
    remoteApplied() {
      if (!shadowOn) return;
      epoch += 1;
    },

    canUndo() { return undoStack.length > 0; },
    canRedo() { return redoStack.length > 0; },

    /** Import and snapshot restore clear both stacks — 5.4 excludes import (rule U10). */
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      pending = null;
    },

    /**
     * THE SHADOW-UNDO ASSERTION (ADR 001 §7.1, PLAN risk R5).
     * Call immediately after applying the ops the last `undo()`/`redo()` returned and
     * re-materialising. Throws `ShadowUndoError` when the op-log undo and the v1-style snapshot
     * disagree about a single field.
     * @param {Object} state the materialised state AFTER the inverse ops were applied
     * @returns {boolean} true when it checked and agreed, false when nothing was armed
     */
    verify(state) {
      const p = pending;
      pending = null;
      if (!p || !p.expected) return false;
      const difference = firstDifference(p.expected, shadowContent(state));
      if (difference) {
        throw new ShadowUndoError(
          `shadow-undo mismatch after ${p.direction} of "${p.label}": ${difference}`,
          { direction: p.direction, label: p.label, difference },
        );
      }
      return true;
    },

    // ── introspection; no op, no stamp and no author ever leaves this module ──
    /** @returns {{undo:number, redo:number}} */
    size() { return { undo: undoStack.length, redo: redoStack.length }; },
    /** @returns {{gid:string,label:string,pre:Array,post:Array}|null} */
    peekUndo() { return undoStack.length ? view(undoStack[undoStack.length - 1]) : null; },
    /** @returns {{gid:string,label:string,pre:Array,post:Array}|null} */
    peekRedo() { return redoStack.length ? view(redoStack[redoStack.length - 1]) : null; },
    /** @returns {string[]} newest last */
    labels() { return undoStack.map((e) => e.label); },
    /** Whether the shadow assertion is armed on this instance. */
    get shadowArmed() { return shadowOn; },
  };
}

const view = (e) => Object.freeze({ gid: e.gid, label: e.label, pre: e.pre, post: e.post });

// ─────────────────────────────────────────────────────────────────────────────
// 6. The transaction builder (ops.contract.js §7's `Tx`)
//
// `store.mutate(label, fn)` becomes `store.txn(label, fn)` and `fn` receives THIS instead of the
// state. The rewrite at each of the 22 sites is mechanical: branching, `return false` declines
// and reads of current values all stay; only the assignment lines become builder calls
// (ADR 001 §7.1).
//
//   store.txn('move-note', (tx) => {
//     const n = tx.get('note', id);
//     if (!n) return false;                        // ← the v1 decline protocol, verbatim
//     tx.note(id).set({ date: n.repeatsYearly ? reanchored : target });
//   });
// ─────────────────────────────────────────────────────────────────────────────

const SETTERS = { note: noteSet, bar: barSet, cat: catSet, pad: padSet };

/**
 * @param {Object} cfg
 * @param {Object} cfg.state  the CURRENT materialised v1-shaped state — reads only
 * @param {Map}    cfg.regs   the RegisterMap in its PRE-transaction state — reads only
 * @param {string} cfg.act @param {string} cfg.dev
 * @param {() => string} cfg.mint
 * @param {string} [cfg.gid]  supply one to pin it in a test; otherwise minted
 * @param {() => string} [cfg.newOpId] @param {() => string} [cfg.newGid]
 * @param {string} [cfg.space] @param {string|null} [cfg.familySpaceId]
 * @returns {Object} a Tx
 */
export function makeTx(cfg = {}) {
  const state = cfg.state;
  if (!state || typeof state !== 'object') throw new UndoError('makeTx: a materialised state is required');
  if (typeof cfg.mint !== 'function') throw new UndoError('makeTx: `mint` is required (ADR 005 §2)');
  const newGid = cfg.newGid ?? defaultGroupId;
  const ctx = {
    act: cfg.act,
    dev: cfg.dev,
    gid: cfg.gid ?? newGid(),
    mint: cfg.mint,
    newOpId: cfg.newOpId ?? defaultOpId,
    space: cfg.space,
    familySpaceId: cfg.familySpaceId ?? null,
  };
  const regs = cfg.regs;
  const ops = [];

  const push = (op) => { ops.push(op); return op; };

  /** `set` refuses `_born` because it is write-once: creation goes through `create()`, which
   *  stamps it from the op's own stamp (ADR 001 §1.4's derived `createdAt`). */
  const guard = (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new UndoError('tx: a field patch object is required');
    }
    if (Object.prototype.hasOwnProperty.call(patch, '_born')) {
      throw new UndoError('tx: `_born` is write-once and is set by create(), never by set()');
    }
    return patch;
  };

  const handle = (kind, id) => ({
    /** @param {Object} patch */
    set(patch) { return push(SETTERS[kind](ctx, id, guard(patch))); },
    /** The create path: `_born` = this op's own stamp, and `_alive` defaults to true so an
     *  entity is never born without the register §5 step 3 filters on. */
    create(f) {
      const patch = guard({ ...f });
      if (!Object.prototype.hasOwnProperty.call(patch, '_alive')) patch._alive = true;
      return push(SETTERS[kind](ctx, id, patch, { born: true }));
    },
    del() { return push(SETTERS[kind](ctx, id, { _alive: false })); },
  });

  const tx = {
    gid: ctx.gid,
    state,
    ops,

    /** Read a current value, exactly as the v1 sites read it off `s.notes` / `s.bars` / … */
    get(kind, id) {
      if (kind === 'note') return (state.notes || []).find((n) => n.id === id);
      if (kind === 'bar') return (state.bars || []).find((b) => b.id === id);
      if (kind === 'cat') return (state.categories || []).find((c) => c.id === id);
      if (kind === 'pad') {
        const text = (state.scratchpads || {})[id];
        return text === undefined ? undefined : { id, text };
      }
      throw new UndoError(`tx.get: kind must be note|bar|cat|pad, got ${JSON.stringify(kind)}`);
    },

    note: (id) => handle('note', id),
    bar: (id) => handle('bar', id),
    cat: (id) => handle('cat', id),
    /** `pad:<YYYY-MM>` is keyed by month, not by a uuid; otherwise the same handle. */
    pad: (month) => handle('pad', month),

    /** LOCAL space, no gid, never undone (rule U6). Nested patches are flattened to dotted
     *  register names because `f` is scalars-only (ADR 001 §2). */
    pref(patch) { return push(prefSet(ctx, flattenPref(patch))); },

    /** Story 4.6 — a new entry can never vanish into a hidden category. `store.js:276-281`'s
     *  logic exactly, including its return value, and INSIDE the same group so it is one ⌘Z. */
    ensureVisible(catId) {
      const c = (state.categories || []).find((x) => x.id === catId);
      if (!c || c.visible !== false) return false;
      push(catSet(ctx, catId, { visible: true }));
      return true;
    },

    /** The images for this transaction, captured against the PRE-state registers. */
    images() { return captureImages(regs, ops, { me: ctx.act }); },
    preImages() { return this.images().pre; },
    postImages() { return this.images().post; },
  };

  return tx;
}
