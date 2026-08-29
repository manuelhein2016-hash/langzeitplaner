// src/js/sync/outbox.js — the durable queue out, and the durable park inbound.
// LZP-501 · stories 19.1, 19.2 · ADR 003 §8.1, §8.2 · ADR 002 §5.2.1, §5.2.5 · finding F-6.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// 19.1 IS A PROPERTY OF THIS FILE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
//   "Fully functional offline: create, edit, move, everything, queued locally; sync when
//    connectivity returns. Offline is the NORMAL case, not the error case."
//
// Nothing above this file knows whether the network exists. `store.txn()` commits, a microtask
// seals (ADR 001 §0.9 — after `emit()`, never before), and the sealed envelope lands here. If
// there is a relay it leaves within seconds; if there is not, it waits three weeks and leaves in
// ⌈n/200⌉ batches. Neither path is a special case and neither is an error.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// FOUR RULES, EACH OF WHICH IS SOMEBODY ELSE'S BUG IF IT IS BROKEN HERE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// 1. **IT HOLDS SEALED ENVELOPES AND NEVER RE-SEALS.** ADR 003 §8.1 says so and
//    `server/core/handlers/ops.js` explains what happens otherwise, reporting it as a CLIENT
//    OBLIGATION: the relay is blind, so it cannot tell an honest re-seal (fresh iv, fresh
//    non-deterministic ECDSA signature, identical plaintext) from a genuine `opId` collision. A
//    client that re-sealed on retry would meet `409 forked_op_id` on every retry — and would be
//    right to treat it as a defect, but the defect would be its own. So the bytes that were
//    enqueued are the bytes that are pushed, for ever, until the relay acknowledges them.
//
// 2. **`opId` IS THE IDEMPOTENCY KEY AND A SIGNATURE NEVER IS.** ADR 002 §1 rule 1: WebCrypto
//    ECDSA is non-deterministic in both engines, so two seals of one op differ in `sig`. Keying
//    anything — dedupe, ack, quarantine — on the envelope bytes would classify every honest retry
//    as a new op and duplicate the family's whole board on a flaky connection.
//
// 3. **AN ENTRY LEAVES ONLY ON `accepted` OR `duplicate`.** Both mean "the relay has it"
//    (ADR 003 §3.1) and `protocol.js readPushBody` merges them into one list precisely so this
//    file cannot treat them differently.
//
// 4. **A PERMANENTLY REJECTED OP MUST NEVER SILENTLY SPIN FOREVER** (ADR 003 §8.2). It moves to
//    `quarantined`, with a reason, and the sync state goes to `error` — visible, calm, once.
//    Nothing is deleted: principle 6 is "nothing is ever lost", and a quarantined envelope is
//    still the only copy of that authoring event outside the log.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SECOND FACTORY IN THIS FILE, AND WHY IT IS HERE — FINDING F-6
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// ADR 003 §8.1 says "the inbox is not persisted separately", and for an envelope that OPENS that
// is right: it is decrypted, folded, appended to `ops.jsonl`, and the cursor moves. But ADR 002
// §5.2.1 correction 1 and §5.2.5 say something the transport layer has to act on:
//
//   > `att === null` therefore PARKS THE SEALED ENVELOPE, unopened, and never rejects it — a
//   > rejection is final, and a final rejection here is silent data loss on first contact and on
//   > every partial pull. This is finding **F-6**.
//
// A parked envelope cannot be re-derived: the cursor has moved past it and the relay's `since`
// filter will never serve it again. If it is not durable it is gone. So this file provides
// `createParkingLot`, the inbound counterpart of the outbox, and the client re-opens its contents
// after every pull — when an attestation or a key epoch may have arrived.
//
// **This closes the SPLIT-BATCH half of F-6, which the ground phase's two-pass fold does not.**
// The two-pass `applyRemote` handles an attestation arriving in the SAME batch as the op it
// authorises. The attestation arriving in the NEXT pull is this. The remaining half is
// `src/js/core/ops.js`'s `PARK_REASONS.ATTESTATION`, which does not exist and is not this work
// package's file — see the REPORT at the bottom of this header.
//
// **REPORTED, NOT ASSUMED (obligations on files this package does not own):**
//   · `src/js/core/ops.js` — `PARK_REASONS` needs `ATTESTATION: 'attestation'`. Until it lands,
//     `crypto/envelope.js`'s `ENVELOPE_PARK.ATTESTATION` is a reason `oplog.js park()` refuses,
//     so a parked envelope can be held HERE (this file needs no such constant) but cannot be
//     written into the op log as a parked line. That is the correct, loud symptom.
//   · `src/js/store.js` / `src/js/storage.js` — the two storage ports below want to be
//     `ops.jsonl`'s unsequenced tail and a sibling of it. Until they are, `memoryOutboxStore()`
//     is used and `diagnostics().durable` is `false`, so an undurable outbox is visible rather
//     than assumed.
//
// PURE. No clock, no randomness, no I/O — `storage` and `now` are ports.

import { LIMITS, ENVELOPE_KEYS } from './protocol.js';

/** ADR 001 §9 — the device-local space is never synced, never encrypted, never on a wire. */
const LOCAL_SPACE = 'local';
const SPACE_ID_RE = /^(?:psp_|fsp_)[A-Za-z0-9_-]{22}$/;
const OP_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * How many envelopes the parking lot may hold before it refuses to take more.
 *
 * There has to be a number: a relay that serves 500 undecryptable envelopes per pull, for ever,
 * would otherwise fill the disk. The important half is what happens AT the cap — see `park()`.
 */
export const PARK_CAP = 10000;

/**
 * An in-memory store. Used until `store.js` binds the durable one; says so in diagnostics.
 *
 * It DEEP-copies in both directions. A shallow `slice()` would hand a caller the same row objects
 * it holds, so mutating a loaded record would silently rewrite "the disk" — which is the one thing
 * a stand-in for a disk must not do, because it makes a persistence bug invisible in exactly the
 * tests that exist to find one.
 */
export function memoryRecordStore(initial) {
  const copy = (list) => (Array.isArray(list) ? JSON.parse(JSON.stringify(list)) : []);
  let held = copy(initial);
  return {
    durable: false,
    async loadRecords() { return copy(held); },
    async saveRecords(list) { held = copy(list); },
  };
}

/** `true` when `e` is a nine-field envelope for `space`, as ADR 002 §5.1 shapes one. */
function isEnvelopeFor(e, space) {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return false;
  const keys = Object.keys(e);
  if (keys.length !== ENVELOPE_KEYS.length) return false;
  for (const k of ENVELOPE_KEYS) if (!Object.prototype.hasOwnProperty.call(e, k)) return false;
  if (typeof e.oid !== 'string' || !OP_ID_RE.test(e.oid)) return false;
  if (typeof e.sp !== 'string' || e.sp !== space) return false;
  if (!Number.isInteger(e.ep) || e.ep < 1) return false;
  return true;
}

/**
 * The durable queue out.
 *
 * @param {{storage?:{loadRecords:Function, saveRecords:Function, durable?:boolean},
 *          now?:() => number, warn?:(m:string)=>void}} ports
 */
export function createOutbox(ports = {}) {
  const storage = ports.storage || memoryRecordStore();
  const now = typeof ports.now === 'function' ? ports.now : () => 0;
  const warn = typeof ports.warn === 'function' ? ports.warn : () => {};

  /** @type {Array<{space:string, oid:string, env:Object, at:number, state:string, reason:string|null}>} */
  let rows = [];
  let loaded = false;

  const key = (space, oid) => `${space}\n${oid}`;
  /** @type {Map<string, number>} space\noid -> index into `rows`. Rebuilt on every mutation. */
  let index = new Map();
  const reindex = () => {
    index = new Map();
    rows.forEach((r, i) => index.set(key(r.space, r.oid), i));
  };

  const persist = async () => {
    try {
      await storage.saveRecords(rows.map((r) => ({ ...r, env: { ...r.env } })));
      return true;
    } catch (e) {
      warn(`outbox: the queue could not be persisted (${e && e.name}: ${e && e.message}). `
         + 'The ops are still queued in memory and will be pushed this session; a crash before the '
         + 'next successful write would lose them.');
      return false;
    }
  };

  const api = {
    async load() {
      let list = [];
      try {
        list = await storage.loadRecords();
      } catch (e) {
        warn(`outbox: the queue could not be read (${e && e.name}: ${e && e.message}); starting empty`);
      }
      rows = [];
      if (Array.isArray(list)) {
        for (const r of list) {
          if (r === null || typeof r !== 'object') continue;
          if (typeof r.space !== 'string' || !isEnvelopeFor(r.env, r.space)) {
            warn('outbox: a stored row is not a sealed envelope for its space; it was skipped');
            continue;
          }
          if (index.has(key(r.space, r.env.oid))) continue;
          rows.push({
            space: r.space,
            oid: r.env.oid,
            env: { ...r.env },
            at: Number.isFinite(r.at) ? r.at : now(),
            state: r.state === 'quarantined' ? 'quarantined' : 'queued',
            reason: typeof r.reason === 'string' ? r.reason : null,
          });
          index.set(key(r.space, r.env.oid), rows.length - 1);
        }
      }
      reindex();
      loaded = true;
      return rows.length;
    },

    get loaded() { return loaded; },

    /**
     * Take sealed envelopes for one space.
     *
     * Refuses, loudly and without queueing anything, when:
     *   · the space is `local` — `pref.set` is device-local by rule U6 and ADR 001 §9, and a
     *     settings change reaching the relay would be a privacy regression with no story behind
     *     it. This is the outbound half of finding **F-7**;
     *   · `env.sp` disagrees with the space it is being filed under — the AAD binds `sp`, so such
     *     an envelope could never be opened anywhere and pushing it would earn a `space_mismatch`
     *     for ever;
     *   · the envelope is not a nine-field envelope.
     *
     * A `oid` already queued or already quarantined is a no-op: rule 2 above.
     *
     * @returns {Promise<{queued:number, refused:Array<{oid:string|null, why:string}>}>}
     */
    async enqueue(space, envs) {
      const refused = [];
      if (space === LOCAL_SPACE || !SPACE_ID_RE.test(String(space))) {
        const why = space === LOCAL_SPACE
          ? 'the `local` space is never synced (ADR 001 §9, rule U6)'
          : `${JSON.stringify(space)} is not a SpaceId`;
        warn(`outbox: refusing ${Array.isArray(envs) ? envs.length : 0} envelope(s) — ${why}`);
        return { queued: 0, refused: [{ oid: null, why }] };
      }
      const list = Array.isArray(envs) ? envs : [envs];
      let queued = 0;
      for (const env of list) {
        if (!isEnvelopeFor(env, space)) {
          const oid = env && typeof env.oid === 'string' ? env.oid : null;
          refused.push({ oid, why: 'not a sealed envelope for this space' });
          warn(`outbox: refusing an envelope for ${space} — it is not a sealed envelope for this space`);
          continue;
        }
        if (index.has(key(space, env.oid))) continue;          // rule 2: `opId` is the key
        rows.push({ space, oid: env.oid, env: { ...env }, at: now(), state: 'queued', reason: null });
        index.set(key(space, env.oid), rows.length - 1);
        queued++;
      }
      if (queued > 0 || refused.length > 0) await persist();
      return { queued, refused };
    },

    /**
     * The next batch for one space, in enqueue order, capped at `LIMITS.opsPerPush`.
     *
     * FIFO is not cosmetic. Ops merge in any order (ADR 001 §6), but a device three weeks offline
     * that pushed its newest ops first would leave its oldest ones behind a possible failure, and
     * `ackSeq`/`drained` would then describe a queue that is not the queue.
     */
    peek(space, n) {
      const cap = Math.min(Number.isInteger(n) && n > 0 ? n : LIMITS.opsPerPush, LIMITS.opsPerPush);
      const out = [];
      for (const r of rows) {
        if (r.space !== space || r.state !== 'queued') continue;
        out.push(r.env);
        if (out.length >= cap) break;
      }
      return out;
    },

    /** `accepted` and `duplicate`, treated identically — rule 3. */
    async ack(space, oids) {
      const gone = new Set(Array.isArray(oids) ? oids : [oids]);
      const before = rows.length;
      rows = rows.filter((r) => !(r.space === space && r.state === 'queued' && gone.has(r.oid)));
      if (rows.length === before) return 0;
      reindex();
      await persist();
      return before - rows.length;
    },

    /**
     * Rule 4. The envelope is KEPT — quarantine is a state, not a delete.
     *
     * `409 forked_op_id` is the one reason that also needs work elsewhere: ADR 003 §3.1 says the
     * client "must treat this as local corruption: re-mint the affected ops with fresh `opId`s and
     * log it loudly". Re-minting is `store.js`'s — it owns the plaintext and the clock — so this
     * file records the quarantine and the client reports it through `onQuarantine`. **Reported as
     * an obligation**: nothing in E5 can re-mint, and a fork that is only quarantined has lost
     * that edit until somebody does.
     */
    async quarantine(space, oid, reason) {
      const i = index.get(key(space, oid));
      if (i === undefined) return false;
      if (rows[i].state === 'quarantined') return false;
      rows[i] = { ...rows[i], state: 'quarantined', reason: String(reason || 'rejected by the relay') };
      await persist();
      warn(`outbox: ${oid} in ${space} was quarantined — ${rows[i].reason}. It will not be retried; `
         + 'the change it carries is on this Mac and on no other.');
      return true;
    },

    /** Queued (not quarantined) count for one space, or for every space when `space` is omitted. */
    size(space) {
      let n = 0;
      for (const r of rows) {
        if (r.state !== 'queued') continue;
        if (space === undefined || r.space === space) n++;
      }
      return n;
    },

    /** The `at` of the oldest queued entry — the input to §8.3's "non-empty for > 20 s". */
    oldest(space) {
      let t = null;
      for (const r of rows) {
        if (r.state !== 'queued') continue;
        if (space !== undefined && r.space !== space) continue;
        if (t === null || r.at < t) t = r.at;
      }
      return t;
    },

    /** True when nothing is queued for this space — the truthful input to `drained` on push. */
    drained(space) { return api.size(space) === 0; },

    /** Every space with something queued or quarantined. */
    spaces() {
      const out = new Set();
      for (const r of rows) out.add(r.space);
      return [...out];
    },

    quarantined() {
      return rows.filter((r) => r.state === 'quarantined')
        .map((r) => ({ space: r.space, oid: r.oid, reason: r.reason, at: r.at }));
    },

    /** The sealed bytes of a quarantined entry, for an export or a re-mint. */
    envelopeOf(space, oid) {
      const i = index.get(key(space, oid));
      return i === undefined ? null : { ...rows[i].env };
    },

    /** For `store.diagnostics()`. Counts and ids — never an `iv`, a `ct` or a `sig`. */
    diagnostics() {
      const bySpace = {};
      for (const s of api.spaces()) bySpace[s] = { queued: api.size(s), oldest: api.oldest(s) };
      return {
        loaded,
        durable: storage.durable !== false,
        queued: api.size(),
        quarantined: api.quarantined().map((q) => ({ space: q.space, oid: q.oid, reason: q.reason })),
        bySpace,
      };
    },
  };

  return api;
}

/**
 * The durable park for inbound envelopes that could not be opened YET — finding F-6.
 *
 * Two reasons put an envelope here, and `crypto/envelope.js` names both as parks rather than
 * errors:
 *   · `ATTESTATION` — no attestation resolves `env.dv`. The device that wrote it is new to us, or
 *     its `member.set{dev.*}` op has not arrived. ADR 002 §5.2.5: "there is no causal delivery in
 *     this system, so a member's first content op overtaking their attestation is ORDINARY, not
 *     hostile."
 *   · `EPOCH` — the key ring holds no key for `env.ep`. A member offline across three rotations
 *     needs every epoch spanning the ops they have not read (ADR 002 §4.4).
 *
 * Both are re-evaluable, and both are re-evaluated: the client replays this lot after every pull.
 *
 * @param {{storage?:Object, now?:() => number, warn?:(m:string)=>void, cap?:number}} ports
 */
export function createParkingLot(ports = {}) {
  const storage = ports.storage || memoryRecordStore();
  const now = typeof ports.now === 'function' ? ports.now : () => 0;
  const warn = typeof ports.warn === 'function' ? ports.warn : () => {};
  const cap = Number.isInteger(ports.cap) && ports.cap > 0 ? ports.cap : PARK_CAP;

  /** @type {Array<{space:string, oid:string, env:Object, seq:string, reason:string, at:number, tries:number}>} */
  let rows = [];
  let loaded = false;
  let overflowed = 0;
  const seen = new Set();
  const key = (space, oid) => `${space}\n${oid}`;

  const persist = async () => {
    try {
      await storage.saveRecords(rows.map((r) => ({ ...r, env: { ...r.env } })));
      return true;
    } catch (e) {
      warn(`park: the parked envelopes could not be persisted (${e && e.message}). Until they are, `
         + 'a quit loses them and the ops they carry are gone from this Mac (F-6).');
      return false;
    }
  };

  const api = {
    async load() {
      let list = [];
      try {
        list = await storage.loadRecords();
      } catch (e) {
        warn(`park: the parked envelopes could not be read (${e && e.message}); starting empty`);
      }
      rows = [];
      seen.clear();
      if (Array.isArray(list)) {
        for (const r of list) {
          if (r === null || typeof r !== 'object' || typeof r.space !== 'string') continue;
          if (!isEnvelopeFor(r.env, r.space)) continue;
          if (seen.has(key(r.space, r.env.oid))) continue;
          seen.add(key(r.space, r.env.oid));
          rows.push({
            space: r.space,
            oid: r.env.oid,
            env: { ...r.env },
            seq: typeof r.seq === 'string' ? r.seq : '0',
            reason: typeof r.reason === 'string' ? r.reason : 'unknown',
            at: Number.isFinite(r.at) ? r.at : now(),
            tries: Number.isInteger(r.tries) ? r.tries : 0,
          });
        }
      }
      loaded = true;
      return rows.length;
    },

    get loaded() { return loaded; },

    /**
     * Retain one envelope, unopened.
     *
     * **RETURNS `false` AT THE CAP, AND THE CALLER MUST NOT ADVANCE THE CURSOR PAST IT.** That is
     * the whole design of the bound: dropping the newest loses it, dropping the oldest loses that
     * one, and both are the silent data loss ADR 002 §5.2.5 forbids. Refusing to take it and
     * refusing to move the cursor means the pull STALLS — visibly, in the sync status, with a
     * sentence — and nothing is lost. A stalled sync is a bad afternoon; a moved cursor is a
     * missing appointment nobody will ever know about.
     *
     * @returns {Promise<boolean>} false when the lot is full
     */
    async park(space, env, seq, reason) {
      if (!isEnvelopeFor(env, space)) {
        warn(`park: refusing to park something that is not a sealed envelope for ${space}`);
        return true;                                  // not parkable, but not a reason to stall
      }
      const k = key(space, env.oid);
      const at = rows.findIndex((r) => key(r.space, r.oid) === k);
      if (at >= 0) {
        rows[at] = { ...rows[at], reason: String(reason), tries: rows[at].tries + 1 };
        await persist();
        return true;
      }
      if (rows.length >= cap) {
        overflowed++;
        warn(`park: the parking lot is full (${cap}). The cursor for ${space} will NOT advance past `
           + `seq ${seq}, so nothing is lost — but sync for this space has stalled until the `
           + 'attestation or the key epoch these envelopes need arrives (F-6).');
        return false;
      }
      rows.push({
        space, oid: env.oid, env: { ...env }, seq: String(seq),
        reason: String(reason), at: now(), tries: 0,
      });
      seen.add(k);
      await persist();
      return true;
    },

    /** Everything parked for one space, oldest first — the replay order. */
    parked(space) {
      return rows.filter((r) => space === undefined || r.space === space)
        .map((r) => ({ space: r.space, oid: r.oid, env: { ...r.env }, seq: r.seq, reason: r.reason, tries: r.tries }));
    },

    /** Remove the ones that opened. */
    async release(space, oids) {
      const gone = new Set(Array.isArray(oids) ? oids : [oids]);
      const before = rows.length;
      rows = rows.filter((r) => {
        const drop = r.space === space && gone.has(r.oid);
        if (drop) seen.delete(key(r.space, r.oid));
        return !drop;
      });
      if (rows.length !== before) await persist();
      return before - rows.length;
    },

    /** Note one more failed replay, so `tries` can be reported without re-parking. */
    async touch(space, oids, reason) {
      const bump = new Set(Array.isArray(oids) ? oids : [oids]);
      let n = 0;
      rows = rows.map((r) => {
        if (r.space !== space || !bump.has(r.oid)) return r;
        n++;
        return { ...r, tries: r.tries + 1, reason: reason === undefined ? r.reason : String(reason) };
      });
      if (n > 0) await persist();
      return n;
    },

    size(space) {
      if (space === undefined) return rows.length;
      let n = 0;
      for (const r of rows) if (r.space === space) n++;
      return n;
    },

    /** How many envelopes the cap has refused. Non-zero means sync is stalled by design. */
    get overflowed() { return overflowed; },

    diagnostics() {
      const byReason = {};
      for (const r of rows) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
      return {
        loaded,
        durable: storage.durable !== false,
        parked: rows.length,
        cap,
        overflowed,
        byReason,
      };
    },
  };

  return api;
}
