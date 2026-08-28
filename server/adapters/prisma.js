// server/adapters/prisma.js — PRODUCTION ONLY.  ADR 003 §9; risk R3.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
//  THIS FILE CANNOT BE EXECUTED ON THIS MACHINE. THERE IS NO POSTGRES AND NO @prisma/client.
//  EVERY BEHAVIOURAL CLAIM BELOW IS **UNVERIFIED** UNTIL A MACHINE WITH A DATABASE RUNS
//  tests/server/store-contract.test.js AGAINST IT. The claims are enumerated, with the exact
//  Postgres semantics each one depends on, in `UNVERIFIED_CLAIMS` at the bottom — that export
//  exists so the honesty is machine-readable rather than a comment somebody deletes.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// WHAT *IS* CHECKED HERE, and it is not nothing:
//   · the module imports with no database present (no top-level `@prisma/client` import — the
//     client is injected, and `createPrismaClient()` reaches for it dynamically);
//   · `prismaStore(client)` passes `assertStoreShape`, so the interface surface is complete;
//   · every method is present and named exactly as the contract names it.
// tests/server/store-contract.test.js asserts all three. What it cannot assert is that any of
// these queries return what the comment says they return.
//
// CONNECTION POOLING FROM DAY ONE (risk R3). Vercel functions are stateless and a cold start per
// request would open a connection per request, which exhausts a Hobby-tier Postgres long before
// it exhausts anything else. Two mitigations, both here:
//   1. the client is a module-level singleton stashed on globalThis, so a WARM invocation reuses
//      the connection rather than opening one; and
//   2. the connection string is required to carry `connection_limit=1`, so a function instance
//      holds exactly one connection and the pool lives in the platform's connection pooler
//      rather than in eight copies of this process.

import { STORE_METHODS, normalizeRow, StoreShapeError, MODEL_COLUMNS } from '../core/store-interface.js';

const OP_INPUT_COLUMNS = MODEL_COLUMNS.Op.filter((c) => !['spaceId', 'seq', 'receivedAt'].includes(c));
const PAIR_PATCH_COLUMNS = ['boxA', 'boxB', 'delivery'];
const BURN_TOMBSTONE_MS = 86400000;

/** Postgres unique-violation. Prisma surfaces it as `err.code === 'P2002'`. */
const isUniqueViolation = (err) => !!err && err.code === 'P2002';

const toBig = (v) => (typeof v === 'bigint' ? v : BigInt(v || 0));
const toBytes = (v) => (v == null ? null : v instanceof Uint8Array ? v : new Uint8Array(v));

/**
 * Map a Prisma row back to the interface's shape.
 * UNVERIFIED (U-BYTES): Prisma returns `Bytes` columns as Node `Buffer`, which IS a Uint8Array,
 * so `instanceof Uint8Array` holds and RULE 1's read-side check passes. If a future Prisma
 * version returns something else, C59 and C03 in the contract suite are what catch it.
 */
function outRow(model, row) {
  if (!row) return null;
  const out = {};
  for (const c of MODEL_COLUMNS[model]) {
    const v = row[c];
    if (v === undefined || v === null) { out[c] = null; continue; }
    if (typeof v === 'bigint') out[c] = v;
    else if (v instanceof Uint8Array) out[c] = toBytes(v);
    else out[c] = v;
  }
  return out;
}

/**
 * Build (or reuse) the production client.
 *
 * The import is DYNAMIC on purpose: this module must be importable — and shape-checkable — on a
 * machine with no `@prisma/client` installed, which is every machine in this repository today.
 *
 * @param {{url?:string}} [opts]
 * @returns {Promise<Object>} a PrismaClient
 */
export async function createPrismaClient(opts) {
  const g = globalThis;
  if (g.__lzpPrismaClient) return g.__lzpPrismaClient;               // warm invocation: reuse

  const url = (opts && opts.url) || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. It is an environment variable and is never written into a file (LZP-109 pre-flight).');
  if (!/connection_limit=/.test(url)) {
    // Risk R3. A serverless function that opens an unbounded pool per instance exhausts a
    // Hobby-tier database at eight family members long before it exhausts anything else.
    throw new Error('DATABASE_URL must pin connection_limit (use connection_limit=1 behind the platform pooler) — ADR 003 §10 risk R3.');
  }

  const mod = await import('@prisma/client');
  const client = new mod.PrismaClient({ datasources: { db: { url } } });
  g.__lzpPrismaClient = client;
  return client;
}

/**
 * @param {Object} client a PrismaClient (or, in a shape test, anything with the same surface)
 * @param {{now?: () => number}} [opts]
 * @returns {Object} SyncStore
 */
export function prismaStore(client, opts) {
  const now = (opts && opts.now) || (() => Date.now());
  return build(client, now, false);
}

function build(db, now, inTransaction) {
  const impl = {
    // ── transactions ────────────────────────────────────────────────────────
    /**
     * UNVERIFIED (U-TX): `$transaction(fn)` runs fn against an interactive transaction client and
     * ROLLS BACK on throw, re-throwing. Serializable is required, not Read Committed: C57 needs
     * two concurrent rotations to serialise, and C16 needs `reserveSeq`'s read-modify-write not
     * to lose an update. On a serialisation failure Postgres raises 40001 and Prisma surfaces
     * P2034; the handler layer (LZP-202) retries the whole request, which is safe because push
     * is idempotent on (spaceId, opId).
     * UNVERIFIED (U-TXNEST): a nested `tx` must NOT open a second transaction — Prisma would
     * deadlock against its own connection limit of 1. It re-enters on the same client.
     */
    async tx(fn) {
      if (inTransaction) return fn(build(db, now, true));
      return db.$transaction(async (t) => fn(build(t, now, true)), {
        isolationLevel: 'Serializable',
        maxWait: 5000,
        timeout: 10000,
      });
    },

    // ── spaces ──────────────────────────────────────────────────────────────
    async getSpace(id) { return outRow('Space', await db.space.findUnique({ where: { id } })); },

    async createSpace(row) {
      const r = normalizeRow('Space', row);
      try {
        return outRow('Space', await db.space.create({ data: r }));
      } catch (err) {
        // UNVERIFIED (U-P2002): a duplicate primary key surfaces as P2002, not as a raw 23505.
        if (isUniqueViolation(err)) throw new StoreShapeError(`space ${r.id} already exists`);
        throw err;
      }
    },

    /**
     * UNVERIFIED (U-CASCADE): `onDelete: Cascade` on Member, Op, Epoch, KeyWrap and Invite plus
     * Member->Device removes every row of the space in ONE statement. Story 20.4 says "cascade
     * purge"; if any relation is missing the cascade, rows survive a deleted space and the
     * relay keeps ciphertext for a family that asked to be forgotten.
     */
    async deleteSpace(id) { await db.space.deleteMany({ where: { id } }); },

    /**
     * RULE 2. UNVERIFIED (U-SEQ): this single UPDATE takes a row lock on the Space row for the
     * duration of the transaction, so concurrent pushes to ONE space serialise here and nowhere
     * else, and the returned value is the post-increment counter. Returns the LAST seq of the
     * block: [ret-n+1 … ret]. `$queryRaw` rather than `update()` because the atomic
     * read-after-write is the entire point and an ORM round trip would reintroduce the race.
     */
    async reserveSeq(id, n) {
      if (!Number.isInteger(n) || n < 1) throw new StoreShapeError(`reserveSeq needs n >= 1, got ${n}`);
      const rows = await db.$queryRaw`UPDATE "Space" SET "nextSeq" = "nextSeq" + ${n}::bigint WHERE "id" = ${id} RETURNING "nextSeq"`;
      if (!rows || rows.length === 0) throw new StoreShapeError(`unknown space ${id}`);
      return toBig(rows[0].nextSeq);
    },

    /**
     * UNVERIFIED (U-EPOCH): the composite primary key on Epoch is the race resolution. The
     * loser gets P2002, which becomes `false`, which the handler answers as 409 epoch_taken.
     */
    async claimEpoch(id, epoch) {
      try {
        await db.epoch.create({ data: { spaceId: id, epoch, createdAt: new Date(now()) } });
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    async setCurrentEpoch(id, epoch) { await db.space.update({ where: { id }, data: { currentEpoch: epoch } }); },

    async setHeadChain(id, chain) {
      if (chain !== null && !(chain instanceof Uint8Array)) throw new StoreShapeError('Space.headChain must be raw bytes or null');
      await db.space.update({ where: { id }, data: { headChain: chain } });
    },

    // ── ops ─────────────────────────────────────────────────────────────────
    /**
     * RULE 2 + idempotency, in the order ADR 003 §3.3 requires.
     *
     * UNVERIFIED (U-UPSERT): the duplicate filter must happen BEFORE the counter bump, or a
     * retried push burns seq numbers and the cursor develops holes. Here that is a SELECT of the
     * existing opIds inside the same Serializable transaction, then `reserveSeq`, then
     * `createMany({ skipDuplicates: true })`. `skipDuplicates` is belt and braces: under
     * Serializable the SELECT already saw the truth, and if it did not, the unique index is what
     * stops a double insert — at the cost of a seq hole, which is why the SELECT is not optional.
     */
    async upsertOps(spaceId, rows) {
      const inputs = (rows || []).map((r) => {
        for (const k of Object.keys(r || {})) {
          if (!OP_INPUT_COLUMNS.includes(k)) throw new StoreShapeError(`Op.${k} may not be supplied by a caller`);
        }
        return normalizeRow('Op', { ...r, spaceId, seq: 0n, receivedAt: new Date(0) });
      });
      if (inputs.length === 0) return { inserted: [], existing: [] };

      return impl.tx(async (t) => {
        const known = await t.existingOpIds(spaceId, inputs.map((r) => r.opId));
        const byId = new Map(known.map((o) => [o.opId, o]));
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
          const last = await t.reserveSeq(spaceId, fresh.length);
          let seq = last - BigInt(fresh.length) + 1n;
          const at = new Date(now());
          const data = fresh.map((r) => { const row = { ...r, seq, receivedAt: at }; seq += 1n; return row; });
          await db.op.createMany({ data, skipDuplicates: true });
          for (const row of data) byId.set(row.opId, row);
        }
        const inserted = [];
        const existing = [];
        for (const p of plan) {
          const row = outRow('Op', byId.get(p.opId));
          if (p.kind === 'new') inserted.push(row); else existing.push(row);
        }
        return { inserted, existing };
      });
    },

    async existingOpIds(spaceId, opIds) {
      const ids = opIds || [];
      if (ids.length === 0) return [];
      const found = await db.op.findMany({ where: { spaceId, opId: { in: ids } } });
      const byId = new Map(found.map((o) => [o.opId, o]));
      const out = [];
      for (const id of ids) if (byId.has(id)) out.push(outRow('Op', byId.get(id)));
      return out;
    },

    /**
     * UNVERIFIED (U-CURSOR): `gt` on a BigInt column with `orderBy: seq asc` and `take: limit+1`
     * is the pagination. `limit+1` rather than a second COUNT: one round trip, and `hasMore` is
     * exact rather than estimated.
     */
    async listOps(spaceId, since, limit) {
      const cap = Math.max(0, Number(limit) || 0);
      const found = await db.op.findMany({
        where: { spaceId, seq: { gt: toBig(since) } },
        orderBy: { seq: 'asc' },
        take: cap + 1,
      });
      return { ops: found.slice(0, cap).map((o) => outRow('Op', o)), hasMore: found.length > cap };
    },

    async headSeq(spaceId) {
      const agg = await db.op.aggregate({ where: { spaceId }, _max: { seq: true } });
      return toBig(agg && agg._max && agg._max.seq);
    },

    /**
     * 20.2. UNVERIFIED (U-PURGE): `@@index([spaceId, deviceShort])` makes this an index scan
     * rather than a table scan on a space with a year of ops. Keyed on deviceShort, never on a
     * bare deviceId (ADR 002 §2.3). `nextSeq` is deliberately NOT rewound.
     */
    async deleteOpsByDevices(spaceId, deviceShorts) {
      const shorts = deviceShorts || [];
      if (shorts.length === 0) return 0;
      const r = await db.op.deleteMany({ where: { spaceId, deviceShort: { in: shorts } } });
      return r.count;
    },

    // ── members and devices ─────────────────────────────────────────────────
    async listMembers(spaceId) {
      return (await db.member.findMany({ where: { spaceId } })).map((m) => outRow('Member', m));
    },

    async addMember(m) {
      const r = normalizeRow('Member', m);
      try {
        return outRow('Member', await db.member.create({ data: r }));
      } catch (err) {
        // UNVERIFIED (U-COLOR): @@unique([spaceId, colorRef]) is what actually enforces 15.3.
        // `colorFree` is a read and therefore advisory; two joiners racing on one colour are
        // separated here, in the index, or not at all.
        if (isUniqueViolation(err)) throw new StoreShapeError(`member ${r.id} or colorRef ${r.colorRef} already exists in ${r.spaceId}`);
        throw err;
      }
    },

    /** The first removal stands: `removedAt: null` in the WHERE makes it idempotent. */
    async removeMember(memberId, at) {
      await db.member.updateMany({ where: { id: memberId, removedAt: null }, data: { removedAt: new Date(at) } });
    },

    async colorFree(spaceId, colorRef) {
      return (await db.member.count({ where: { spaceId, colorRef } })) === 0;
    },

    async addDevice(d) {
      const r = normalizeRow('Device', d);
      try { await db.device.create({ data: r }); } catch (err) {
        if (isUniqueViolation(err)) throw new StoreShapeError(`device ${r.id} or deviceShort ${r.deviceShort} already exists`);
        throw err;
      }
    },

    async getDevice(deviceId) { return outRow('Device', await db.device.findUnique({ where: { id: deviceId } })); },

    async getDeviceByShort(deviceShort) { return outRow('Device', await db.device.findUnique({ where: { deviceShort } })); },

    /**
     * The rotation coverage input (ADR 002 §4.2) and the `members` piggyback (ADR 003 §3.2).
     * UNVERIFIED (U-JOIN): one query through the Member relation rather than N+1 per member.
     */
    async listDevices(spaceId) {
      const found = await db.device.findMany({ where: { member: { spaceId } } });
      return found.map((d) => outRow('Device', d));
    },

    async revokeDevice(deviceId, at) {
      await db.device.updateMany({ where: { id: deviceId, revokedAt: null }, data: { revokedAt: new Date(at) } });
    },

    /**
     * Monotone. UNVERIFIED (U-MONO): `lastSeenSeq: { lt: seq }` in the WHERE is what makes a
     * stale ack a no-op rather than a rewind. A rewind would un-collect tombstones the peers
     * have already dropped.
     */
    async setLastSeenSeq(deviceShort, seq) {
      await db.device.updateMany({ where: { deviceShort, lastSeenSeq: { lt: toBig(seq) } }, data: { lastSeenSeq: toBig(seq) } });
    },

    async setLastPushedSeq(deviceShort, seq) {
      await db.device.updateMany({ where: { deviceShort, lastPushedSeq: { lt: toBig(seq) } }, data: { lastPushedSeq: toBig(seq) } });
    },

    async minLastSeenSeq(spaceId) { return minOver(db, spaceId, 'lastSeenSeq'); },
    async minLastPushedSeq(spaceId) { return minOver(db, spaceId, 'lastPushedSeq'); },

    // ── key wraps ───────────────────────────────────────────────────────────
    /**
     * UNVERIFIED (U-WRAPUPSERT): an upsert per row inside one transaction. `createMany` cannot
     * express "replace on conflict", and a rotation MUST be able to re-wrap an epoch it already
     * wrapped (ADR 002 §4.2 step 3 re-wraps open invites on every rotation).
     */
    async putKeyWraps(rows) {
      const clean = (rows || []).map((r) => normalizeRow('KeyWrap', r));
      if (clean.length === 0) return;
      await impl.tx(async () => {
        for (const r of clean) {
          await db.keyWrap.upsert({
            where: { spaceId_epoch_recipientId: { spaceId: r.spaceId, epoch: r.epoch, recipientId: r.recipientId } },
            create: r,
            update: { wrapped: r.wrapped },
          });
        }
      });
    },

    async getKeyWraps(spaceId, recipientId) {
      return (await db.keyWrap.findMany({ where: { spaceId, recipientId } })).map((w) => outRow('KeyWrap', w));
    },

    async deleteKeyWrapsForDevices(spaceId, recipientIds) {
      const ids = recipientIds || [];
      if (ids.length === 0) return 0;
      const r = await db.keyWrap.deleteMany({ where: { spaceId, recipientId: { in: ids } } });
      return r.count;
    },

    // ── invites ─────────────────────────────────────────────────────────────
    async putInvite(row) {
      const r = normalizeRow('Invite', row);
      await db.invite.upsert({ where: { id: r.id }, create: r, update: r });
    },

    async getInvite(id) { return outRow('Invite', await db.invite.findUnique({ where: { id } })); },

    /**
     * ATOMIC single-use — the one query in this file whose exact shape is quoted in ADR 002 §7.1.
     *
     * UNVERIFIED (U-CONSUME): `updateMany` with `usedAt: null` in the WHERE compiles to
     * `UPDATE "Invite" SET "usedAt" = $2 WHERE id = $1 AND "usedAt" IS NULL`, whose row count is
     * 1 for exactly one concurrent caller. This is the single most important atomicity claim in
     * the file: a lost race admits two members on one invite, and the admin sees one name.
     * The read that follows is safe only because the WHERE already committed the win.
     */
    async consumeInvite(id, at) {
      return impl.tx(async () => {
        const r = await db.invite.updateMany({
          where: { id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date(at) } },
          data: { usedAt: new Date(at) },
        });
        if (r.count !== 1) return null;
        return outRow('Invite', await db.invite.findUnique({ where: { id } }));
      });
    },

    async revokeInvite(id, at) {
      await db.invite.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(at) } });
    },

    async listOpenInvites(spaceId) {
      const found = await db.invite.findMany({
        where: { spaceId, usedAt: null, revokedAt: null, expiresAt: { gt: new Date(now()) } },
      });
      return found.map((i) => outRow('Invite', i));
    },

    /** D9 — the epoch and nothing else. There is no key material on an invite to refresh. */
    async refreshInvite(id, epoch) {
      await db.invite.updateMany({ where: { id }, data: { epoch } });
    },

    // ── pairing ─────────────────────────────────────────────────────────────
    /**
     * UNVERIFIED (U-BURN): the `burnedAt: null` guard is what makes the burn permanent. Without
     * it a replayed pair/offer re-creates the rendezvous and resets the 5-attempt budget, and
     * the security of a 60-bit code then rests on nothing.
     */
    async putPairSession(rid, patch, ttlMs) {
      const p = patch || {};
      for (const k of Object.keys(p)) {
        if (!PAIR_PATCH_COLUMNS.includes(k)) throw new StoreShapeError(`PairSession.${k} is not patchable`);
      }
      const clean = normalizeRow('PairSession', p, { partial: true });
      const t = now();
      await impl.tx(async () => {
        const cur = await db.pairSession.findUnique({ where: { rid } });
        if (cur && cur.burnedAt) return;                                     // permanent
        if (!cur || cur.expiresAt.getTime() <= t) {
          await db.pairSession.upsert({
            where: { rid },
            create: { rid, boxA: null, boxB: null, delivery: null, attempts: 0, expiresAt: new Date(t + ttlMs), burnedAt: null, ...clean },
            update: { boxA: null, boxB: null, delivery: null, attempts: 0, expiresAt: new Date(t + ttlMs), burnedAt: null, ...clean },
          });
          return;
        }
        if (Object.keys(clean).length > 0) await db.pairSession.update({ where: { rid }, data: clean });
      });
    },

    async getPairSession(rid) {
      const row = await db.pairSession.findUnique({ where: { rid } });
      if (!row || row.burnedAt || row.expiresAt.getTime() <= now()) return null;
      return outRow('PairSession', row);
    },

    /**
     * UNVERIFIED (U-BUMP): `{ increment: 1 }` compiles to `SET attempts = attempts + 1`, which is
     * atomic under concurrency. A read-modify-write here would lose increments and turn a
     * 5-guess budget into an unbounded one.
     * Returns MAX_SAFE_INTEGER on an unknown, expired or burned rid so callers fail closed.
     */
    async bumpPairAttempts(rid) {
      const t = now();
      const r = await db.pairSession.updateMany({
        where: { rid, burnedAt: null, expiresAt: { gt: new Date(t) } },
        data: { attempts: { increment: 1 } },
      });
      if (r.count !== 1) return Number.MAX_SAFE_INTEGER;
      const row = await db.pairSession.findUnique({ where: { rid } });
      return row ? row.attempts : Number.MAX_SAFE_INTEGER;
    },

    /** A TOMBSTONE, not a delete. Swept lazily once no live rid could collide with it. */
    async burnPairSession(rid) {
      const t = now();
      await db.pairSession.upsert({
        where: { rid },
        create: { rid, boxA: null, boxB: null, delivery: null, attempts: 0, expiresAt: new Date(t), burnedAt: new Date(t) },
        update: { boxA: null, boxB: null, delivery: null, burnedAt: new Date(t) },
      });
      await db.pairSession.deleteMany({ where: { burnedAt: { not: null }, expiresAt: { lt: new Date(t - BURN_TOMBSTONE_MS) } } });
    },

    // ── nonces and rate limits ──────────────────────────────────────────────
    /**
     * UNVERIFIED (U-NONCE): the INSERT is the claim. A concurrent duplicate raises P2002 and
     * becomes `false`, which is a replay. A SELECT-then-INSERT would let two concurrent requests
     * both see "absent" and both proceed — which is precisely a replayable request.
     * The sweep is lazy because Hobby has no cron (ADR 003 §10 weakness 2).
     */
    async claimNonce(deviceShort, nonce, ttlMs) {
      const t = now();
      await db.nonce.deleteMany({ where: { expiresAt: { lte: new Date(t) } } });
      try {
        await db.nonce.create({ data: { deviceShort, nonce, expiresAt: new Date(t + ttlMs) } });
        return true;
      } catch (err) {
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    /**
     * A tumbling window over RateBucket {key, count, windowStart} — see the note in
     * server/adapters/memory.js for why it is tumbling rather than sliding.
     *
     * UNVERIFIED (U-RATE): the whole read-modify-write must be one transaction, or a burst of
     * concurrent requests each reads `count` before any writes it and the limit admits N rather
     * than max. A limiter that is only correct when requests arrive one at a time is not a
     * limiter, and every limit in ADR 003 §6.1 rides on this one method.
     */
    async rateAllow(key, windowMs, max) {
      const t = now();
      return impl.tx(async () => {
        const b = await db.rateBucket.findUnique({ where: { key } });
        if (!b || t - b.windowStart.getTime() >= windowMs) {
          if (max < 1) return false;
          await db.rateBucket.upsert({
            where: { key },
            create: { key, count: 1, windowStart: new Date(t) },
            update: { count: 1, windowStart: new Date(t) },
          });
          return true;
        }
        if (b.count >= max) return false;
        await db.rateBucket.update({ where: { key }, data: { count: { increment: 1 } } });
        return true;
      });
    },
  };

  const store = {};
  for (const name of STORE_METHODS) store[name] = impl[name];
  return store;
}

async function minOver(db, spaceId, field) {
  const agg = await db.device.aggregate({
    where: { member: { spaceId }, revokedAt: null },
    _min: { [field]: true },
    _count: { _all: true },
  });
  // FAIL CLOSED. No devices at all, or a device that has never reported, must never read as
  // "everything is collectable". `_min` over an empty set is null, which becomes 0n.
  if (!agg || !agg._count || agg._count._all === 0) return 0n;
  const v = agg._min ? agg._min[field] : null;
  return v == null ? 0n : toBig(v);
}

/**
 * EVERY behavioural claim in this file that no test on this machine can settle, with the exact
 * Postgres or Prisma semantics it rests on and what breaks if the semantics differ.
 *
 * This export is not documentation. `tests/server/store-contract.test.js` asserts that it is
 * non-empty, that every entry names a method that exists on the store, and that every `U-` tag
 * used in a comment above appears here — so the honesty cannot rot into a stale comment block.
 * The day a machine with Postgres exists, running STORE_CONTRACT_CASES against `prismaStore`
 * settles every row at once.
 */
export const UNVERIFIED_CLAIMS = Object.freeze([
  { tag: 'U-TX', method: 'tx', claim: '$transaction(fn, {isolationLevel: Serializable}) rolls back every write on throw and re-throws.', breaks: 'A rotation that fails after inserting half its wraps leaves a space whose epoch says e+1 and whose key wraps cover nobody — every member locked out of their own board.' },
  { tag: 'U-TXNEST', method: 'tx', claim: 'A nested tx re-enters on the same client instead of opening a second transaction.', breaks: 'Deadlock against connection_limit=1: the outer transaction holds the only connection while the inner one waits for it.' },
  { tag: 'U-SEQ', method: 'reserveSeq', claim: 'UPDATE ... SET nextSeq = nextSeq + n RETURNING nextSeq takes a row lock for the transaction and returns the post-increment value.', breaks: 'Two concurrent pushes assign the same seq. The second overwrites the first in the primary key, and one family member\'s afternoon of edits is gone with a 200 OK.' },
  { tag: 'U-UPSERT', method: 'upsertOps', claim: 'The existing-opId SELECT and the counter bump are in one Serializable transaction, so a retried push burns no seq numbers.', breaks: 'Every retry advances the counter. Cursors still work, but the log grows holes and the "gapless" property in ADR 003 §3.3 is quietly false.' },
  { tag: 'U-P2002', method: 'createSpace', claim: 'Prisma surfaces a unique violation as err.code === "P2002" for every model in this schema.', breaks: 'A duplicate becomes an unhandled 500 instead of a defined error, and claimEpoch returns a throw instead of false — so a concurrent rotator sees a server error rather than 409 epoch_taken.' },
  { tag: 'U-EPOCH', method: 'claimEpoch', claim: 'The composite primary key @@id([spaceId, epoch]) resolves a rotation race first-writer-wins.', breaks: 'Two rotations both believe they own epoch e+1 and each wraps a different key to a different subset of devices. Half the family can read the new epoch, half cannot.' },
  { tag: 'U-CASCADE', method: 'deleteSpace', claim: 'onDelete: Cascade removes members, devices, ops, epochs, key wraps and invites when a space row is deleted.', breaks: 'Story 20.4 promises a purge. Rows survive, and the relay keeps ciphertext for a family that asked to be forgotten.' },
  { tag: 'U-CURSOR', method: 'listOps', claim: 'seq: { gt: cursor } with orderBy seq asc and take limit+1 paginates exactly, and BigInt comparison is numeric rather than lexical.', breaks: 'Lexical comparison makes seq 9 sort after seq 10 and a client silently skips ops.' },
  { tag: 'U-PURGE', method: 'deleteOpsByDevices', claim: '@@index([spaceId, deviceShort]) makes the 20.2 purge an index scan, and deleteMany returns an exact count.', breaks: 'A member removal in a space with a year of ops exceeds the 10 s function timeout, and the membership write commits without the purge.' },
  { tag: 'U-COLOR', method: 'addMember', claim: '@@unique([spaceId, colorRef]) is what enforces 15.3; colorFree is advisory.', breaks: 'Two members racing to join pick the same colour and the board legend has two identical swatches with no way to tell them apart.' },
  { tag: 'U-MONO', method: 'setLastSeenSeq', claim: 'updateMany with lastSeenSeq: { lt: seq } makes a stale ack a no-op rather than a rewind.', breaks: 'GC un-collects: a device rewinds the minimum and tombstones peers already dropped come back, resurrecting deleted entries.' },
  { tag: 'U-JOIN', method: 'listDevices', claim: 'where: { member: { spaceId } } is one join, not N+1.', breaks: 'The rotation coverage check and every pull pay a query per member; at eight members and a 45 s cadence that is the Hobby-tier connection budget.' },
  { tag: 'U-WRAPUPSERT', method: 'putKeyWraps', claim: 'upsert on the composite key replaces a wrap for an epoch already wrapped.', breaks: 'ADR 002 §4.2 step 3 re-wraps open invites on every rotation; without replace it raises a unique violation and the whole rotation aborts.' },
  { tag: 'U-CONSUME', method: 'consumeInvite', claim: 'updateMany with usedAt: null in the WHERE gives a row count of 1 to exactly one concurrent caller.', breaks: 'Two people redeem one invite. Both become members; the admin issued one invitation and sees two names, one of which they cannot account for.' },
  { tag: 'U-BURN', method: 'putPairSession', claim: 'The burnedAt guard makes a burn permanent against a replayed pair/offer.', breaks: 'The 5-attempt cap resets on demand. ADR 002 §6.4\'s honest analysis — "an online guessing budget is meaningless" — stops being true, and a 60-bit code faces unlimited guesses.' },
  { tag: 'U-BUMP', method: 'bumpPairAttempts', claim: '{ increment: 1 } is an atomic SET attempts = attempts + 1.', breaks: 'Concurrent failed decrypts lose increments and the budget never reaches 5.' },
  { tag: 'U-NONCE', method: 'claimNonce', claim: 'The INSERT itself is the claim; a concurrent duplicate raises P2002.', breaks: 'Two concurrent requests both see the nonce absent and both proceed — a replayed request is accepted, which is ADR 003 §2 step 3 defeated.' },
  { tag: 'U-RATE', method: 'rateAllow', claim: 'The read-modify-write runs in one transaction, so a burst admits at most max.', breaks: 'Every limit in ADR 003 §6.1 becomes advisory: 10 invite redemptions per IP per hour admits as many as arrive in the same millisecond.' },
  { tag: 'U-BYTES', method: 'getSpace', claim: 'Prisma returns Bytes columns as Buffer, which is a Uint8Array, so RULE 1 holds on the read side too.', breaks: 'An envelope comes back as a string, a handler concatenates it, and the padding and AAD binding are destroyed.' },
]);
