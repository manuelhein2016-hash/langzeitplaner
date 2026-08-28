// server/adapters/memory.js — the SyncStore over Maps, with a mutex for tx().  ADR 003 §9.
//
// Used by every tier-1 server test and by the fleet suite, where the client's Transport port is
// bound straight to the real handlers over this store — no sockets, no database, and still the
// same handler code that runs in Frankfurt.
//
// TWO THINGS THIS FILE IS RESPONSIBLE FOR AND MUST NOT DELEGATE:
//
//   1. RULE 1 (the relay is blind). Every write goes through `normalizeRow`, so an opaque column
//      refuses a String and an unknown column refuses outright. There is no path from a handler
//      to a plaintext column because there is no plaintext column, and the check is here rather
//      than in the handlers so that adding an adapter cannot quietly drop it.
//
//   2. RULE 2 (per-space, gapless seq). `reserveSeq` bumps one counter on one space row and
//      `upsertOps` filters duplicates BEFORE it calls that, so a retried push burns no numbers.
//
// The engine is shared with `file.js`, which is the same data structure with a write-through to
// disk. That is deliberate: two adapters running the contract suite are only two witnesses if
// they are two implementations of the same rules, not two copies of the same bug — so the part
// that could diverge (serialisation, durability, locking against a second process) is what
// file.js overrides, and the part that encodes the ADR is shared.

import {
  MODEL_COLUMNS, normalizeRow, StoreShapeError, STORE_METHODS,
} from '../core/store-interface.js';

/** Op columns a caller may supply. `spaceId`, `seq` and `receivedAt` are assigned by the store. */
const OP_INPUT_COLUMNS = Object.freeze(MODEL_COLUMNS.Op.filter((c) => !['spaceId', 'seq', 'receivedAt'].includes(c)));

/** Pair-session fields a caller may patch. Never `attempts`, never `expiresAt`, never `burnedAt`. */
const PAIR_PATCH_COLUMNS = Object.freeze(['boxA', 'boxB', 'delivery']);

/** How long a burned rendezvous keeps its tombstone. Long enough that no live rid can be reused. */
const BURN_TOMBSTONE_MS = 86400000;

/** Composite map key. JSON, not a joined string: a separator is only safe while every id
 *  alphabet excludes it, and a nonce is caller-supplied. ["a","b"] and ["a|b"] differ under
 *  JSON and collide under any join, so no clever nonce can forge a neighbouring row. */
const K = (...parts) => JSON.stringify(parts);

/** A stable placeholder for a column the store is about to assign. */
const EPOCH0 = new Date(0);

/** Shallow copy. Byte arrays are shared and are treated as immutable by every caller. */
const copy = (row) => (row ? { ...row } : row);
const copies = (rows) => rows.map(copy);

function emptyState() {
  return {
    spaces: new Map(),      // id -> SpaceRow
    epochs: new Map(),      // spaceId\0epoch -> {spaceId, epoch, createdAt}
    ops: new Map(),         // spaceId -> Map<opId, OpRow>
    members: new Map(),     // memberId -> MemberRowDb
    devices: new Map(),     // deviceId -> DeviceRow
    keyWraps: new Map(),    // spaceId\0epoch\0recipientId -> KeyWrapRow
    invites: new Map(),     // id -> InviteRow
    pairs: new Map(),       // rid -> PairSessionRow
    nonces: new Map(),      // deviceShort\0nonce -> expiresAtMs (number)
    rates: new Map(),       // key -> {count, windowStart}
  };
}

/**
 * The shared engine. Everything below is SYNCHRONOUS by construction: the whole store is one
 * object graph, so a method cannot be interleaved with another at an await point, and the mutex
 * exists to serialise whole *transactions* rather than individual statements.
 *
 * @param {{now?: () => number, persist?: () => Promise<void>, state?: Object}} [opts]
 * @returns {Object} a SyncStore
 */
export function createStoreEngine(opts) {
  const options = opts || {};
  const now = options.now || (() => Date.now());
  const persist = options.persist || null;
  let state = options.state || emptyState();

  // ── helpers over `state` ──────────────────────────────────────────────────
  const mustSpace = (id) => {
    const s = state.spaces.get(id);
    if (!s) throw new StoreShapeError(`unknown space ${id}`);
    return s;
  };
  const EMPTY = new Map();
  /** Write path: materialises the per-space op map. */
  const opsOf = (spaceId) => {
    let m = state.ops.get(spaceId);
    if (!m) { m = new Map(); state.ops.set(spaceId, m); }
    return m;
  };
  /** Read path: never materialises anything, so a query cannot mutate the store. */
  const opsRead = (spaceId) => state.ops.get(spaceId) || EMPTY;
  const memberIdsOf = (spaceId) => {
    const out = new Set();
    for (const m of state.members.values()) if (m.spaceId === spaceId) out.add(m.id);
    return out;
  };

  // ── the implementation, one function per interface method ────────────────
  const impl = {
    // spaces ───────────────────────────────────────────────────────────────
    getSpace(id) { return copy(state.spaces.get(id) || null); },

    createSpace(row) {
      const r = normalizeRow('Space', row);
      if (state.spaces.has(r.id)) throw new StoreShapeError(`space ${r.id} already exists`);
      if (typeof r.nextSeq !== 'bigint') throw new StoreShapeError('Space.nextSeq must be a bigint');
      state.spaces.set(r.id, r);
      return copy(r);
    },

    deleteSpace(id) {
      // 20.4 — a cascade, in one place, so nothing survives a space deletion by omission.
      const members = memberIdsOf(id);
      for (const [devId, d] of [...state.devices]) if (members.has(d.memberId)) state.devices.delete(devId);
      for (const memId of members) state.members.delete(memId);
      state.ops.delete(id);
      for (const k of [...state.epochs.keys()]) if (state.epochs.get(k).spaceId === id) state.epochs.delete(k);
      for (const k of [...state.keyWraps.keys()]) if (state.keyWraps.get(k).spaceId === id) state.keyWraps.delete(k);
      for (const [k, inv] of [...state.invites]) if (inv.spaceId === id) state.invites.delete(k);
      state.spaces.delete(id);
    },

    /**
     * RULE 2. Returns the LAST seq of the reserved block: the block is [ret-n+1 … ret].
     * Mirrors `UPDATE "Space" SET "nextSeq" = "nextSeq" + $n WHERE id = $1 RETURNING "nextSeq"`.
     */
    reserveSeq(id, n) {
      if (!Number.isInteger(n) || n < 1) throw new StoreShapeError(`reserveSeq needs n >= 1, got ${n}`);
      const s = mustSpace(id);
      s.nextSeq = s.nextSeq + BigInt(n);
      return s.nextSeq;
    },

    claimEpoch(id, epoch) {
      mustSpace(id);
      const key = K(id, String(epoch));
      if (state.epochs.has(key)) return false;         // first writer wins -> 409 epoch_taken
      state.epochs.set(key, { spaceId: id, epoch, createdAt: new Date(now()) });
      return true;
    },

    setCurrentEpoch(id, epoch) { mustSpace(id).currentEpoch = epoch; },

    setHeadChain(id, chain) {
      const s = mustSpace(id);
      s.headChain = normalizeRow('Space', { ...s, headChain: chain }).headChain;
    },

    // ops ──────────────────────────────────────────────────────────────────
    upsertOps(spaceId, rows) {
      mustSpace(spaceId);
      const byId = opsOf(spaceId);
      // VALIDATE EVERY ROW BEFORE RESERVING A SINGLE NUMBER. A batch that is rejected halfway
      // through would burn seq on the rows it had already accepted, and the client's retry of
      // the same batch would then see a hole it can never fill.
      const inputs = (rows || []).map((r) => {
        if (!r || typeof r !== 'object') throw new StoreShapeError('Op: row must be an object');
        for (const k of Object.keys(r)) {
          if (!OP_INPUT_COLUMNS.includes(k)) {
            throw new StoreShapeError(
              `Op.${k} may not be supplied by a caller. seq and receivedAt are assigned by the ` +
              `store (RULE 2: duplicates are filtered before the counter bump), and anything ` +
              `else is not a column.`,
            );
          }
        }
        if (typeof r.opId !== 'string' || r.opId === '') throw new StoreShapeError('Op.opId is required');
        return normalizeRow('Op', { ...r, spaceId, seq: 0n, receivedAt: EPOCH0 });
      });

      const fresh = [];
      const plan = [];
      const claimed = new Set();
      for (const r of inputs) {
        if (byId.has(r.opId) || claimed.has(r.opId)) { plan.push({ kind: 'existing', opId: r.opId }); continue; }
        claimed.add(r.opId);
        fresh.push(r);
        plan.push({ kind: 'new', opId: r.opId });
      }

      if (fresh.length > 0) {
        const last = impl.reserveSeq(spaceId, fresh.length);
        let seq = last - BigInt(fresh.length) + 1n;
        const at = new Date(now());
        for (const r of fresh) {
          byId.set(r.opId, { ...r, seq, receivedAt: at });
          seq += 1n;
        }
      }

      const inserted = [];
      const existing = [];
      for (const p of plan) {
        const row = copy(byId.get(p.opId));
        if (p.kind === 'new') inserted.push(row); else existing.push(row);
      }
      return { inserted, existing };
    },

    existingOpIds(spaceId, opIds) {
      const byId = opsRead(spaceId);
      const out = [];
      for (const id of opIds || []) if (byId.has(id)) out.push(copy(byId.get(id)));
      return out;
    },

    listOps(spaceId, since, limit) {
      const cursor = typeof since === 'bigint' ? since : BigInt(since || 0);
      const cap = Math.max(0, Number(limit) || 0);
      const all = [...opsRead(spaceId).values()].filter((o) => o.seq > cursor).sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
      return { ops: copies(all.slice(0, cap)), hasMore: all.length > cap };
    },

    headSeq(spaceId) {
      let max = 0n;
      for (const o of opsRead(spaceId).values()) if (o.seq > max) max = o.seq;
      return max;
    },

    deleteOpsByDevices(spaceId, deviceShorts) {
      // 20.2. Keyed on deviceShort — never on a bare deviceId, which ADR 002 §2.3 shows is a
      // forgeable label: a purge keyed on it lets a removed member name an honest peer's label
      // and have that peer's ops deleted alongside her own.
      const wanted = new Set(deviceShorts || []);
      if (wanted.size === 0) return 0;
      const byId = opsOf(spaceId);
      let n = 0;
      for (const [opId, o] of [...byId]) if (wanted.has(o.deviceShort)) { byId.delete(opId); n++; }
      // NOTE: `nextSeq` is deliberately NOT rewound. A purge leaves holes, and that is correct:
      // rewinding would re-issue a seq a peer's cursor has already passed, which is the exact
      // silent skip ADR 003 §3.3 forbids. Gaplessness is a property of ASSIGNMENT, not of the
      // surviving rows.
      return n;
    },

    // members and devices ──────────────────────────────────────────────────
    listMembers(spaceId) {
      return copies([...state.members.values()].filter((m) => m.spaceId === spaceId));
    },

    addMember(m) {
      const r = normalizeRow('Member', m);
      if (state.members.has(r.id)) throw new StoreShapeError(`member ${r.id} already exists`);
      mustSpace(r.spaceId);
      for (const other of state.members.values()) {
        if (other.spaceId === r.spaceId && other.colorRef === r.colorRef) {
          throw new StoreShapeError(`colorRef ${r.colorRef} is taken in ${r.spaceId} (15.3)`);
        }
      }
      state.members.set(r.id, r);
      return copy(r);
    },

    removeMember(memberId, at) {
      const m = state.members.get(memberId);
      if (!m || m.removedAt !== null) return;          // idempotent; the first removal stands
      m.removedAt = new Date(at);
    },

    /** Includes removed members: `@@unique([spaceId, colorRef])` does not free a colour on removal. */
    colorFree(spaceId, colorRef) {
      for (const m of state.members.values()) if (m.spaceId === spaceId && m.colorRef === colorRef) return false;
      return true;
    },

    addDevice(d) {
      const r = normalizeRow('Device', d);
      if (state.devices.has(r.id)) throw new StoreShapeError(`device ${r.id} already exists`);
      for (const other of state.devices.values()) {
        if (other.deviceShort === r.deviceShort) {
          throw new StoreShapeError(`deviceShort ${r.deviceShort} is already registered — it is derived from the signing key (ADR 001 §1.2)`);
        }
      }
      if (typeof r.lastSeenSeq !== 'bigint' || typeof r.lastPushedSeq !== 'bigint') {
        throw new StoreShapeError('Device.lastSeenSeq and lastPushedSeq must be bigints');
      }
      state.devices.set(r.id, r);
    },

    getDevice(deviceId) { return copy(state.devices.get(deviceId) || null); },

    getDeviceByShort(deviceShort) {
      for (const d of state.devices.values()) if (d.deviceShort === deviceShort) return copy(d);
      return null;
    },

    listDevices(spaceId) {
      // The rotation coverage input (ADR 002 §4.2) and the `members` piggyback (ADR 003 §3.2).
      // Revoked devices are included: the caller decides who is owed a wrap, and the caller is
      // also the one that must delete a revoked device's wraps.
      const members = memberIdsOf(spaceId);
      return copies([...state.devices.values()].filter((d) => members.has(d.memberId)));
    },

    revokeDevice(deviceId, at) {
      const d = state.devices.get(deviceId);
      if (!d || d.revokedAt !== null) return;
      d.revokedAt = new Date(at);
    },

    setLastSeenSeq(deviceShort, seq) {
      for (const d of state.devices.values()) {
        if (d.deviceShort !== deviceShort) continue;
        if (seq > d.lastSeenSeq) d.lastSeenSeq = seq;   // monotone: a stale ack never rewinds it
        return;
      }
    },

    setLastPushedSeq(deviceShort, seq) {
      for (const d of state.devices.values()) {
        if (d.deviceShort !== deviceShort) continue;
        if (seq > d.lastPushedSeq) d.lastPushedSeq = seq;
        return;
      }
    },

    minLastSeenSeq(spaceId) { return minOver(spaceId, 'lastSeenSeq'); },
    minLastPushedSeq(spaceId) { return minOver(spaceId, 'lastPushedSeq'); },

    // key wraps ────────────────────────────────────────────────────────────
    putKeyWraps(rows) {
      // Validate the whole batch first: a rotation is one transaction, and half a set of wraps
      // is exactly the incomplete coverage ADR 002 §4.2 exists to prevent.
      const clean = (rows || []).map((raw) => normalizeRow('KeyWrap', raw));
      for (const r of clean) state.keyWraps.set(K(r.spaceId, String(r.epoch), r.recipientId), r);
    },

    getKeyWraps(spaceId, recipientId) {
      return copies([...state.keyWraps.values()].filter((w) => w.spaceId === spaceId && w.recipientId === recipientId));
    },

    deleteKeyWrapsForDevices(spaceId, recipientIds) {
      const wanted = new Set(recipientIds || []);
      if (wanted.size === 0) return 0;
      let n = 0;
      for (const [k, w] of [...state.keyWraps]) {
        if (w.spaceId === spaceId && wanted.has(w.recipientId)) { state.keyWraps.delete(k); n++; }
      }
      return n;
    },

    // invites ──────────────────────────────────────────────────────────────
    putInvite(row) {
      const r = normalizeRow('Invite', row);
      state.invites.set(r.id, r);
    },

    getInvite(id) { return copy(state.invites.get(id) || null); },

    /** ATOMIC single-use. Used, revoked, expired and unknown are indistinguishable to the caller. */
    consumeInvite(id, at) {
      const inv = state.invites.get(id);
      if (!inv) return null;
      if (inv.usedAt !== null || inv.revokedAt !== null) return null;
      if (inv.expiresAt.getTime() <= at) return null;
      inv.usedAt = new Date(at);
      return copy(inv);
    },

    revokeInvite(id, at) {
      const inv = state.invites.get(id);
      if (!inv || inv.revokedAt !== null) return;
      inv.revokedAt = new Date(at);
    },

    listOpenInvites(spaceId) {
      const t = now();
      return copies([...state.invites.values()].filter(
        (i) => i.spaceId === spaceId && i.usedAt === null && i.revokedAt === null && i.expiresAt.getTime() > t,
      ));
    },

    /** D9 — the epoch and nothing else. There is no key material on an invite to refresh. */
    refreshInvite(id, epoch) {
      const inv = state.invites.get(id);
      if (!inv) return;
      inv.epoch = epoch;
    },

    // pairing ──────────────────────────────────────────────────────────────
    putPairSession(rid, patch, ttlMs) {
      const p = patch || {};
      for (const k of Object.keys(p)) {
        if (!PAIR_PATCH_COLUMNS.includes(k)) throw new StoreShapeError(`PairSession.${k} is not patchable`);
      }
      const clean = normalizeRow('PairSession', p, { partial: true });
      const t = now();
      const cur = state.pairs.get(rid);
      if (cur && cur.burnedAt !== null) return;        // THE BURN IS PERMANENT (ADR 002 §6.2)
      let row = cur;
      if (!row || row.expiresAt.getTime() <= t) {
        row = { rid, boxA: null, boxB: null, delivery: null, attempts: 0, expiresAt: new Date(t + ttlMs), burnedAt: null };
        state.pairs.set(rid, row);
      }
      for (const k of Object.keys(clean)) row[k] = clean[k];
    },

    getPairSession(rid) {
      const row = state.pairs.get(rid);
      if (!row) return null;
      if (row.burnedAt !== null) return null;
      if (row.expiresAt.getTime() <= now()) return null;
      return copy(row);
    },

    /**
     * ADR 002 §6.2's 5-attempt budget. Returns MAX_SAFE_INTEGER on an unknown, expired or burned
     * rid so that `if (n >= limits.pairAttempts) burn()` fails closed with no special case.
     */
    bumpPairAttempts(rid) {
      const row = state.pairs.get(rid);
      if (!row || row.burnedAt !== null || row.expiresAt.getTime() <= now()) return Number.MAX_SAFE_INTEGER;
      row.attempts += 1;
      return row.attempts;
    },

    burnPairSession(rid) {
      const t = now();
      const cur = state.pairs.get(rid);
      // A tombstone, not a delete: a deleted row can be re-created by replaying pair/offer,
      // which resets the attempt budget and makes the 60-bit code the security parameter after
      // all. The tombstone outlives any live rid and is swept lazily below.
      state.pairs.set(rid, {
        rid, boxA: null, boxB: null, delivery: null,
        attempts: cur ? cur.attempts : 0,
        expiresAt: cur ? cur.expiresAt : new Date(t),
        burnedAt: new Date(t),
      });
      for (const [k, row] of [...state.pairs]) {
        if (row.burnedAt !== null && t - row.expiresAt.getTime() > BURN_TOMBSTONE_MS) state.pairs.delete(k);
      }
    },

    // nonces and rate limits ───────────────────────────────────────────────
    claimNonce(deviceShort, nonce, ttlMs) {
      const t = now();
      for (const [k, exp] of [...state.nonces]) if (exp <= t) state.nonces.delete(k);   // lazy sweep
      const key = K(deviceShort, nonce);
      const exp = state.nonces.get(key);
      if (exp !== undefined && exp > t) return false;                                    // replay
      state.nonces.set(key, t + ttlMs);
      return true;
    },

    /**
     * A tumbling window over RateBucket {key, count, windowStart}.
     *
     * ADR 003 §6.1 says "sliding window in RateBucket"; three columns cannot express a true
     * sliding window, and widening the model would add a second counter to a table that exists
     * to be cheap. A tumbling window admits at most 2*max across a window boundary, which at
     * these limits (60 pushes/min, 10 redemptions/hour) is the correct trade. Recorded rather
     * than papered over.
     */
    rateAllow(key, windowMs, max) {
      const t = now();
      let b = state.rates.get(key);
      if (!b || t - b.windowStart >= windowMs) { b = { count: 0, windowStart: t }; state.rates.set(key, b); }
      if (b.count >= max) return false;
      b.count += 1;
      return true;
    },
  };

  function minOver(spaceId, field) {
    const members = memberIdsOf(spaceId);
    let min = null;
    for (const d of state.devices.values()) {
      if (!members.has(d.memberId) || d.revokedAt !== null) continue;
      if (min === null || d[field] < min) min = d[field];
    }
    // FAIL CLOSED. No devices, or a device that has never reported, must never read as
    // "everything is collectable" — unknown never means yes (server.contract.js amendment).
    return min === null ? 0n : min;
  }

  // ── the mutex ─────────────────────────────────────────────────────────────
  // One queue. It serialises whole transactions against each other and against every bare call,
  // which is what makes the concurrency cases in the contract meaningful rather than accidental.
  let tail = Promise.resolve();
  function lock(fn) {
    const result = tail.then(fn);
    tail = result.then(() => {}, () => {});
    return result;
  }

  // WHICH CALLS THE FILE ADAPTER HAS TO FLUSH. Stated as the READ-ONLY set, not as the mutating
  // one, so the default for a method added later is "flush it" — an unnecessary write rather
  // than a silently unpersisted one. A missing entry on the other list would be data the
  // dev-server acknowledged with a 200 and then lost on restart, which is the worst failure
  // shape a relay has.
  const READ_ONLY = new Set([
    'getSpace', 'existingOpIds', 'listOps', 'headSeq',
    'listMembers', 'colorFree', 'getDevice', 'getDeviceByShort', 'listDevices',
    'minLastSeenSeq', 'minLastPushedSeq',
    'getKeyWraps', 'getInvite', 'listOpenInvites', 'getPairSession',
  ]);
  const mutates = (name) => !READ_ONLY.has(name);

  /** The handle passed into `tx(fn)`: the same implementation, without re-taking the lock. */
  function txHandle() {
    const h = {};
    for (const name of STORE_METHODS) {
      if (name === 'tx') continue;
      h[name] = async (...args) => impl[name](...args);
    }
    h.tx = async (fn) => fn(h);          // re-entrant: one transaction, never a second one
    return h;
  }

  function snapshot() { return structuredClone(state); }
  function restore(snap) {
    for (const k of Object.keys(state)) delete state[k];
    for (const k of Object.keys(snap)) state[k] = snap[k];
  }

  const store = {};
  for (const name of STORE_METHODS) {
    if (name === 'tx') continue;
    store[name] = (...args) => lock(async () => {
      const out = impl[name](...args);
      if (persist && mutates(name)) await persist(state);
      return out;
    });
  }

  store.tx = (fn) => lock(async () => {
    const snap = snapshot();
    try {
      const out = await fn(txHandle());
      if (persist) await persist(state);
      return out;
    } catch (err) {
      restore(snap);
      if (persist) await persist(state);
      throw err;
    }
  });

  return store;
}

/**
 * Tests and the fleet suite.
 * @param {{now?: () => number}} [opts] inject a clock; tests must never read the wall clock
 * @returns {Object} SyncStore
 */
export function memoryStore(opts) {
  return createStoreEngine({ now: opts && opts.now, state: emptyState() });
}

/** Exported for `file.js`, which needs to build the same shape before hydrating it from disk. */
export { emptyState };
