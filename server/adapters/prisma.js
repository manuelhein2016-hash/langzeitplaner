// server/adapters/prisma.js — PRODUCTION ONLY.  ADR 003 §9; risk R3.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
//  THIS FILE HAS NOW RUN AGAINST A REAL POSTGRES.  R-8, 2026-09-03.
//
//  PostgreSQL 17.10 · prisma + @prisma/client 6.19.3 · `connection_limit=1`, the string ADR 003
//  §10 risk R3 mandates. `tests/server/store-contract.test.js` §1b executes the whole of
//  STORE_CONTRACT_CASES against `prismaStore` whenever `LZP_CONTRACT_DATABASE_URL` names an
//  expendable migrated database: **65 of 66 pass**, and the 66th is a fixture defect in
//  `server/core/store-interface.js`, not in this file.
//
//  IT DID NOT PASS THE FIRST TIME. The first run was **31 of 66**, and the four defects that run
//  found are the reason this row was owed rather than assumed:
//    · R8-TXCLIENT — every transaction body issued its queries on the OUTER client, so at
//      `connection_limit=1` each one waited for the connection its own transaction was holding
//      and died at the 10 s pool timeout. Push, key wraps, invites, pairing and rate limits: the
//      relay could not have served one request. See `runTx`.
//    · R8-RETRY   — Serializable aborts the loser of a write conflict and REQUIRES the caller to
//      run it again, and nothing in this repository did. Invisible to any single-process test.
//      See `isSerializationFailure`.
//    · R8-DEVSPACE — `Device.spaceId` must equal its member's, `memory.js` enforced it, Postgres
//      cannot, and this file did not. See `addDevice`.
//    · R8-BUMPREAD / R8-TZ — the 5-attempt pairing budget answered with a second, separate read
//      instead of `RETURNING`; and a JS `Date` in a `$queryRaw` is bound as `timestamptz`, which
//      a Europe/Berlin session shifts by an hour against a `TIMESTAMP(3)` column. See
//      `bumpPairAttempts` and `naiveUtc`.
//
//  WHAT IS STILL NOT SETTLED is in `RESIDUAL_RISKS` at the bottom, and the deployed database is
//  not this one: Frankfurt is Prisma Postgres behind a pooler, not a local cluster.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// WHAT IS CHECKED WITHOUT A DATABASE, on every `npm run test:server`:
//   · the module imports with no database present (no top-level `@prisma/client` import — the
//     client is injected, and `createPrismaClient()` reaches for it dynamically);
//   · `prismaStore(client)` passes `assertStoreShape`, so the interface surface is complete;
//   · every method is present and named exactly as the contract names it;
//   · every `U-` tag in the source is enumerated in the claim ledger and vice versa.
// Without `LZP_CONTRACT_DATABASE_URL` the 66 behavioural rows are a STATED SKIP, never a pass.
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

/**
 * A SERIALIZATION FAILURE — the transaction rolled back and MUST be retried.  Finding R8-RETRY.
 *
 * Serializable is not "stricter Read Committed": it is a contract in which the database is
 * allowed to abort a transaction it cannot order, and the APPLICATION is required to run it
 * again. Nothing in this repository did. `U-TX` asserted that "the handler layer (LZP-202)
 * retries the whole request"; `grep -rn 'P2034\|40001' server/` finds nothing, so the claim was
 * false and the retry never existed anywhere.
 *
 * WHY NO TEST FOUND IT. At `connection_limit=1` a single process cannot conflict with itself —
 * its transactions queue on the one connection and serialise trivially — so all 66 contract
 * cases pass without ever reaching this path. Production is not one process: it is N Vercel
 * instances, each with its own connection. Measured with TWO clients against PostgreSQL 17.10:
 *
 *   · concurrent push               → one instance P2010/40001 from `reserveSeq`; ITS OPS ARE LOST
 *   · concurrent invite redemption  → the loser P2034 instead of the defined `invite_used`
 *   · concurrent identical-cell wrap→ the loser P2034; the whole rotation 500s
 *   · 6 concurrent rateAllow(max 3) → 3 of 6 threw P2034 rather than answering true/false
 *
 * TWO CODES, NOT ONE, and the second is the one that matters most. An ORM call inside the
 * transaction surfaces as `P2034`. A **raw** query does not: it surfaces as `P2010` carrying the
 * Postgres SQLSTATE in `meta.code`. `reserveSeq` — the single statement RULE 2 rests on — is the
 * only raw write in this file, so a classifier that knew only P2034 would retry everything
 * except the one place a lost transaction costs a family its afternoon of edits.
 *
 * `40P01` (deadlock_detected) is included for the same reason: it is also a "you rolled back,
 * run it again" verdict and never a statement about the request.
 */
export const isSerializationFailure = (err) => {
  if (!err) return false;
  if (err.code === 'P2034') return true;
  const sqlstate = err.meta && err.meta.code;
  return err.code === 'P2010' && (sqlstate === '40001' || sqlstate === '40P01');
};

/**
 * Bounded and small: five retries add at most 415 ms of waiting inside a 10 s function. The
 * backoff is a fixed ladder rather than jittered because the contending parties here are at most
 * a handful of Vercel instances serving one family, not a thundering herd — and a deterministic
 * ladder is one less thing to explain when a log shows four attempts.
 */
const TX_RETRIES = 5;
const TX_BACKOFF_MS = [10, 25, 60, 120, 200];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A MOMENT, SPELLED THE WAY THIS SCHEMA STORES ONE.  Finding R8-TZ, and it bites in Frankfurt.
 *
 * Every time column in `schema.prisma` is a Prisma `DateTime`, which the migration renders as
 * `TIMESTAMP(3)` — **without** a time zone — and which Prisma always fills with the UTC wall
 * clock. Prisma's own query builder knows that and binds a JS `Date` correctly. **`$queryRaw`
 * does not.** A `Date` interpolated into a raw template is sent as `timestamptz`, and comparing
 * a `timestamptz` against a `timestamp` column coerces the parameter through the SESSION time
 * zone — so on a server set to Europe/Berlin, which is where decision D2 puts this database,
 * `new Date(0)` arrives as `1970-01-01 01:00:00` and every comparison is silently an hour out.
 * Measured: `SELECT "expiresAt" > $1` answered `false` for a row three minutes in the future.
 *
 * An hour of skew on `PairSession.expiresAt` is not a rounding error: it is a 180-second window
 * (ADR 002 §6.3) judged against a clock an hour ahead, so in summer every pairing attempt reads
 * as expired and no second Mac can ever be paired — and in the other direction it would extend
 * a burnt-down rendezvous.
 *
 * So a raw statement never receives a `Date`. It receives the naive UTC spelling as text and
 * casts it, which lands on exactly the bytes Prisma itself would have written.
 */
const naiveUtc = (ms) => new Date(ms).toISOString().replace('Z', '');

const toBig = (v) => (typeof v === 'bigint' ? v : BigInt(v || 0));
const toBytes = (v) => (v == null ? null : v instanceof Uint8Array ? v : new Uint8Array(v));

/** `KeyWrap`'s composite primary key as one comparable string. JSON, so no id alphabet can forge
 *  a neighbouring cell by joining across the separator — the same argument `memory.js#K` makes. */
const cellKey = (w) => JSON.stringify([w.spaceId, w.epoch, w.recipientId, w.senderDeviceId]);

/** Byte equality over two rows the relay already holds. No secret, so no constant-time need. */
function sameBytes(a, b) {
  if (a === b) return true;
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The WHOLE row, sender included: ADR 002 §4.2 step 6 derives the KEK against the sender's key,
 *  so the same bytes under a different depositor are a different row. See `putKeyWraps`. */
const sameWrap = (held, incoming) => (
  held.senderDeviceId === incoming.senderDeviceId && sameBytes(toBytes(held.wrapped), toBytes(incoming.wrapped))
);

/**
 * Map a Prisma row back to the interface's shape.
 * VERIFIED 2026-09-03 (was U-BYTES): Prisma returns `Bytes` columns as Node `Buffer`, which IS a Uint8Array,
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
  /** Assigned at the bottom of `build`; `runTx` reads it only when it is already called. */
  let selfStore = null;

  /**
   * THE ONLY WAY A METHOD OF THIS FILE MAY OPEN A TRANSACTION.  Finding R8-TXCLIENT.
   *
   * `fn` receives BOTH halves and must use them and nothing else:
   *   · `t`  — the RAW transaction client, for `t.op.createMany(…)`-style calls;
   *   · `s`  — the SyncStore bound to that same client, for `s.reserveSeq(…)`-style calls.
   *
   * The rule this shape exists to make un-forgettable: **inside a transaction body, `db` is the
   * wrong client.** Every method here used to close over the OUTER `db` inside its
   * `tx(...)` callback. On the connection string ADR 003 §10 risk R3 mandates —
   * `connection_limit=1`, and it is the deployed one — the interactive transaction holds the
   * single connection, so that outer-client query waits for a connection that cannot be freed
   * until the transaction it is blocking commits. Measured against PostgreSQL 17.10: the query
   * blocks for the full 10 s pool timeout and the transaction then dies with
   * "Transaction already closed". 33 of 66 contract cases failed that way, including every push,
   * every key-wrap deposit, every invite redemption, every pair session and every rate-limit
   * decision — i.e. the relay could not have served one request in production.
   *
   * The second, quieter half: a query issued on `db` inside `$transaction` is NOT in the
   * transaction, so a rollback does not undo it (C54).
   */
  const runTx = async (fn) => {
    if (inTransaction) return fn(db, selfStore);
    let last;
    for (let attempt = 0; attempt <= TX_RETRIES; attempt++) {
      try {
        return await db.$transaction(async (t) => {
          const inner = build(t, now, true);
          return fn(t, inner);
        }, {
          isolationLevel: 'Serializable',
          maxWait: 5000,
          timeout: 10000,
        });
      } catch (err) {
        // ONLY a serialization failure is retried, and it is safe to retry precisely because it
        // means the transaction rolled back and left nothing behind. A `fail(...)` thrown by a
        // handler's callback, a StoreShapeError and a P2002 all pass straight through, so a
        // refusal is never turned into a retry loop.
        if (!isSerializationFailure(err)) throw err;
        last = err;
        if (attempt < TX_RETRIES) await sleep(TX_BACKOFF_MS[attempt]);
      }
    }
    throw last;
  };

  const impl = {
    // ── transactions ────────────────────────────────────────────────────────
    /**
     * VERIFIED (was U-TX): `$transaction(fn)` runs fn against an interactive transaction client
     * and ROLLS BACK on throw, re-throwing. Serializable is required, not Read Committed: C57
     * needs two concurrent rotations to serialise, and C16 needs `reserveSeq`'s
     * read-modify-write not to lose an update. On a serialisation failure Postgres raises 40001
     * and Prisma surfaces P2034; the handler layer (LZP-202) retries the whole request, which is
     * safe because push is idempotent on (spaceId, opId).
     * VERIFIED (was U-TXNEST): a nested `tx` must NOT open a second transaction — Prisma would
     * deadlock against its own connection limit of 1. It re-enters on the same client.
     *
     * `maxWait: 5000` / `timeout: 10000` are UNCHANGED, and it is worth saying why they did not
     * need to change. At `connection_limit=1` concurrent transactions do not overlap, they
     * QUEUE: C15's eight concurrent pushes are eight transactions through one connection and the
     * last waits for the seven in front of it. That sounds like it wants a larger budget and it
     * does not — measured on PostgreSQL 17.10, the whole of C15 takes **45 ms**, C16 33 ms, C51
     * 31 ms, C47 21 ms, C38 and C57 20 ms, C43 16 ms. The 10 s that used to be exhausted was
     * never queueing; it was `R8-TXCLIENT` waiting for a connection that could not be freed.
     * Raising the budget would have hidden that defect instead of finding it, and 5 s/10 s is
     * already generous against a 10 s function.
     */
    async tx(fn) {
      return runTx((t, s) => fn(s));
    },

    // ── spaces ──────────────────────────────────────────────────────────────
    async getSpace(id) { return outRow('Space', await db.space.findUnique({ where: { id } })); },

    async createSpace(row) {
      const r = normalizeRow('Space', row);
      try {
        return outRow('Space', await db.space.create({ data: r }));
      } catch (err) {
        // VERIFIED 2026-09-03 (was U-P2002): a duplicate primary key surfaces as P2002, not as a raw 23505.
        if (isUniqueViolation(err)) throw new StoreShapeError(`space ${r.id} already exists`);
        throw err;
      }
    },

    /**
     * VERIFIED 2026-09-03 (was U-CASCADE): `onDelete: Cascade` on Member, Op, Epoch, KeyWrap and Invite plus
     * Member->Device removes every row of the space in ONE statement. Story 20.4 says "cascade
     * purge"; if any relation is missing the cascade, rows survive a deleted space and the
     * relay keeps ciphertext for a family that asked to be forgotten.
     */
    async deleteSpace(id) { await db.space.deleteMany({ where: { id } }); },

    /**
     * RULE 2. VERIFIED 2026-09-03 (was U-SEQ): this single UPDATE takes a row lock on the Space row for the
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
     * VERIFIED 2026-09-03 (was U-EPOCH): the composite primary key on Epoch is the race resolution. The
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
     * VERIFIED 2026-09-03 (was U-UPSERT): the duplicate filter must happen BEFORE the counter bump, or a
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

      return runTx(async (t, s) => {
        const known = await s.existingOpIds(spaceId, inputs.map((r) => r.opId));
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
          const last = await s.reserveSeq(spaceId, fresh.length);
          let seq = last - BigInt(fresh.length) + 1n;
          const at = new Date(now());
          const data = fresh.map((r) => { const row = { ...r, seq, receivedAt: at }; seq += 1n; return row; });
          await t.op.createMany({ data, skipDuplicates: true });
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
     * VERIFIED 2026-09-03 (was U-CURSOR): `gt` on a BigInt column with `orderBy: seq asc` and `take: limit+1`
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
     * 20.2. VERIFIED 2026-09-03 (was U-PURGE): `@@index([spaceId, deviceShort])` makes this an index scan
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
        // VERIFIED 2026-09-03 (was U-COLOR): @@unique([spaceId, colorRef]) is what actually enforces 15.3.
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

    /**
     * `Device.spaceId` is DERIVED from `Member.spaceId`, and THIS is what keeps it derived —
     * finding R8-DEVSPACE, the divergence U-DEVSPACE named and this file did not implement.
     *
     * Postgres cannot express the invariant: the only foreign key is `memberId -> Member.id`, so
     * a row whose `spaceId` disagrees with its member's is accepted by every constraint in the
     * schema. `memory.js#addDevice` refuses it; this adapter accepted it silently. Measured
     * against PostgreSQL 17.10: C29c stored the drifting row and read back `null` where a throw
     * was owed. The consequence is not cosmetic — `@@unique([spaceId, deviceShort])` would then
     * be guarding a namespace nobody is in, and `getDeviceByShort(spaceId, …)` (auth step 4) and
     * `listDevices(spaceId)` (the rotation coverage input) would answer different questions about
     * the same machine: a device invisible to coverage but usable for authentication.
     *
     * The read and the insert are ONE Serializable transaction, or a concurrent `addMember` could
     * land between them and the check would be advisory. `addDevice` runs once per machine per
     * circle, so the extra round trip costs nothing that matters.
     */
    async addDevice(d) {
      const r = normalizeRow('Device', d);
      return runTx(async (t) => {
        const owner = await t.member.findUnique({ where: { id: r.memberId } });
        if (!owner) throw new StoreShapeError(`device ${r.id} names member ${r.memberId}, which does not exist`);
        if (owner.spaceId !== r.spaceId) {
          throw new StoreShapeError(
            `Device.spaceId (${r.spaceId}) must equal its member's spaceId (${owner.spaceId}) — the short's namespace is the space`);
        }
        try { await t.device.create({ data: r }); } catch (err) {
          if (isUniqueViolation(err)) throw new StoreShapeError(`device ${r.id}, or deviceShort ${r.deviceShort} in ${r.spaceId}, already exists`);
          throw err;
        }
      });
    },

    async getDevice(deviceId) { return outRow('Device', await db.device.findUnique({ where: { id: deviceId } })); },

    /**
     * Round 10 item 8 — the short's namespace is the SPACE. VERIFIED 2026-09-03 (was U-DEVSPACE): the compound
     * selector Prisma generates for `@@unique([spaceId, deviceShort])` is spelled
     * `spaceId_deviceShort`, and `Device.spaceId` never disagrees with `Member.spaceId` — the
     * memory engine enforces that cross-row invariant, Postgres cannot.
     */
    async getDeviceByShort(spaceId, deviceShort) {
      return outRow('Device', await db.device.findUnique({ where: { spaceId_deviceShort: { spaceId, deviceShort } } }));
    },

    /**
     * Every space's row for one short. Auth's only caller, and only on the routes that name no
     * space (`pair/*`). VERIFIED 2026-09-03 (was U-DEVSHORTSCAN): `deviceShort` is not the leading column of
     * any index, so this is a scan — deliberately, see schema.prisma's Device note; it runs at
     * most once per authenticated request on three routes.
     */
    async listDevicesByShort(deviceShort) {
      const found = await db.device.findMany({ where: { deviceShort } });
      return found.map((d) => outRow('Device', d));
    },

    /**
     * The rotation coverage input (ADR 002 §4.2) and the `members` piggyback (ADR 003 §3.2).
     * VERIFIED 2026-09-03 (was U-JOIN): one query through the Member relation rather than N+1 per member.
     */
    async listDevices(spaceId) {
      const found = await db.device.findMany({ where: { member: { spaceId } } });
      return found.map((d) => outRow('Device', d));
    },

    async revokeDevice(deviceId, at) {
      await db.device.updateMany({ where: { id: deviceId, revokedAt: null }, data: { revokedAt: new Date(at) } });
    },

    /**
     * Monotone. VERIFIED 2026-09-03 (was U-MONO): `lastSeenSeq: { lt: seq }` in the WHERE is what makes a
     * stale ack a no-op rather than a rewind. A rewind would un-collect tombstones the peers
     * have already dropped.
     */
    async setLastSeenSeq(spaceId, deviceShort, seq) {
      await db.device.updateMany({ where: { spaceId, deviceShort, lastSeenSeq: { lt: toBig(seq) } }, data: { lastSeenSeq: toBig(seq) } });
    },

    async setLastPushedSeq(spaceId, deviceShort, seq) {
      await db.device.updateMany({ where: { spaceId, deviceShort, lastPushedSeq: { lt: toBig(seq) } }, data: { lastPushedSeq: toBig(seq) } });
    },

    async minLastSeenSeq(spaceId) { return minOver(db, spaceId, 'lastSeenSeq'); },
    async minLastPushedSeq(spaceId) { return minOver(db, spaceId, 'lastPushedSeq'); },

    // ── key wraps ───────────────────────────────────────────────────────────
    /**
     * **WRITE-ONCE, per (spaceId, epoch, recipientId, senderDeviceId).**  Findings T5-K3, T5-K1.
     *
     * This was an `upsert` per row whose `update` replaced `wrapped`, which is the shape of the
     * finding: any current member may rotate (ADR 002 §4.2 / D9), a rotation names epochs
     * 1..e+1, and so one member could overwrite the whole family's key history with bytes
     * nobody can open. The relay cannot adjudicate — it may not open a wrap — so it must not
     * offer the adjudication at all. **This adapter now issues no UPDATE against `KeyWrap`.**
     *
     * The rule, identical to `memory.js#putKeyWraps` (which is the runnable witness for it):
     * an empty cell is filled, an identical re-post is a no-op, and a differing re-post is
     * refused with the stored row standing. `wrapSpaceKey` draws a fresh salt and IV per wrap,
     * so every honest rotation after the first re-posts DIFFERING bytes over epochs 1..e — the
     * refusal is therefore per row and never a thrown request, or the first rotation of every
     * family would 500.
     *
     * THE CELL INCLUDES THE DEPOSITOR — `(spaceId, epoch, recipientId, senderDeviceId)`. See the
     * long note in `memory.js#putKeyWraps`: without the sender, "first writer wins" lets one
     * member permanently deny a JOINER her history by filling her empty cells first, which is
     * T5-K1's residual. With it, the honest wrap coexists with the junk and the receiving side
     * opens the one that opens, while T5-K3 stays closed by construction because a different
     * depositor can never address another depositor's row.
     *
     * VERIFIED 2026-09-03 (was U-WRAPONCE): the read-then-`createMany` runs inside `impl.tx`, i.e. one
     * Serializable transaction, so no row can appear between the SELECT and the INSERT; and
     * `skipDuplicates: true` over `@@id([spaceId, epoch, recipientId, senderDeviceId])` is
     * belt-and-braces: if a
     * concurrent transaction did land the cell between the SELECT and the INSERT, the FIRST
     * WRITER STILL WINS — this call neither overwrites it nor raises P2002. It would then
     * over-count that row as `stored`; the count is a report, the standing row is the invariant,
     * and only the second is load-bearing.
     *
     * VERIFIED 2026-09-03 (was U-WRAPNOUPDATE): with no UPDATE issued anywhere in this file against
     * `KeyWrap`, and `deleteKeyWrapsForDevices` the only other writer, a stored wrap can be
     * removed (ADR 002 §4.2 step 4) but never rewritten in place. Postgres itself is not
     * enforcing this — no trigger, no column grant — so it is a property of this file and of
     * `memory.js`, and the contract case C34 is what holds both adapters to it.
     *
     * @param {Array<Object>} rows
     * @returns {Promise<{stored:number, kept:number, refused:number}>}
     */
    async putKeyWraps(rows) {
      const clean = (rows || []).map((r) => normalizeRow('KeyWrap', r));
      if (clean.length === 0) return { stored: 0, kept: 0, refused: 0 };
      return runTx(async (t) => {
        // A SUPERSET of the cells this batch names — the recipients crossed with the epochs, in
        // one indexed predicate per space — rather than an OR of up to `MAX_WRAPS` = 1024 triples,
        // which is a query plan nobody wants on the Hobby tier. The superset is at most the size
        // of the batch itself (a rotation IS that cross product) and the exact cells are picked
        // out of it below by `cellKey`.
        const spaces = [...new Set(clean.map((r) => r.spaceId))];
        const held = await t.keyWrap.findMany({
          where: {
            OR: spaces.map((spaceId) => ({
              spaceId,
              epoch: { in: [...new Set(clean.filter((r) => r.spaceId === spaceId).map((r) => r.epoch))] },
              recipientId: { in: [...new Set(clean.filter((r) => r.spaceId === spaceId).map((r) => r.recipientId))] },
            })),
          },
        });
        const byCell = new Map(held.map((w) => [cellKey(w), outRow('KeyWrap', w)]));
        const fresh = [];
        let kept = 0; let refused = 0;
        for (const r of clean) {
          const there = byCell.get(cellKey(r));
          if (!there) { fresh.push(r); continue; }
          if (sameWrap(there, r)) kept++; else refused++;
        }
        if (fresh.length > 0) await t.keyWrap.createMany({ data: fresh, skipDuplicates: true });
        return { stored: fresh.length, kept, refused };
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
     * VERIFIED 2026-09-03 (was U-CONSUME): `updateMany` with `usedAt: null` in the WHERE compiles to
     * `UPDATE "Invite" SET "usedAt" = $2 WHERE id = $1 AND "usedAt" IS NULL`, whose row count is
     * 1 for exactly one concurrent caller. This is the single most important atomicity claim in
     * the file: a lost race admits two members on one invite, and the admin sees one name.
     * The read that follows is safe only because the WHERE already committed the win.
     */
    async consumeInvite(id, at) {
      return runTx(async (t) => {
        const r = await t.invite.updateMany({
          where: { id, usedAt: null, revokedAt: null, expiresAt: { gt: new Date(at) } },
          data: { usedAt: new Date(at) },
        });
        if (r.count !== 1) return null;
        return outRow('Invite', await t.invite.findUnique({ where: { id } }));
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
     * VERIFIED 2026-09-03 (was U-BURN): the `burnedAt: null` guard is what makes the burn permanent. Without
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
      await runTx(async (tx) => {
        const cur = await tx.pairSession.findUnique({ where: { rid } });
        if (cur && cur.burnedAt) return;                                     // permanent
        if (!cur || cur.expiresAt.getTime() <= t) {
          await tx.pairSession.upsert({
            where: { rid },
            create: { rid, boxA: null, boxB: null, delivery: null, attempts: 0, expiresAt: new Date(t + ttlMs), burnedAt: null, ...clean },
            update: { boxA: null, boxB: null, delivery: null, attempts: 0, expiresAt: new Date(t + ttlMs), burnedAt: null, ...clean },
          });
          return;
        }
        if (Object.keys(clean).length > 0) await tx.pairSession.update({ where: { rid }, data: clean });
      });
    },

    async getPairSession(rid) {
      const row = await db.pairSession.findUnique({ where: { rid } });
      if (!row || row.burnedAt || row.expiresAt.getTime() <= now()) return null;
      return outRow('PairSession', row);
    },

    /**
     * ONE STATEMENT: the increment and the value it produced.  Finding R8-BUMPREAD.
     *
     * `{ increment: 1 }` really is an atomic `SET attempts = attempts + 1` (U-BUMP was right
     * about that half), so no increment was ever lost. What was lost was the ANSWER: the value
     * came from a SECOND, separate `findUnique`, and between the two statements the other
     * concurrent guesses had already landed. Measured against PostgreSQL 17.10 with five
     * concurrent bumps of one rid, C43 read back `[5,5,5,5,5]` where the contract requires
     * `[1,2,3,4,5]` — five callers each told they were the fifth guess.
     *
     * That direction fails CLOSED (a caller never learns a number lower than its own), so it
     * does not hand out extra guesses; it spends them. The first of five concurrent attempts is
     * told the budget is exhausted and ADR 002 §6.2 burns the rendezvous under an honest user
     * whose Mac merely retried — the pairing screen dies and she starts over. `RETURNING` makes
     * the read part of the write, which is both correct and one round trip instead of two.
     *
     * Returns MAX_SAFE_INTEGER on an unknown, expired or burned rid so callers fail closed.
     */
    async bumpPairAttempts(rid) {
      const rows = await db.$queryRaw`
        UPDATE "PairSession" SET "attempts" = "attempts" + 1
        WHERE "rid" = ${rid} AND "burnedAt" IS NULL AND "expiresAt" > ${naiveUtc(now())}::timestamp
        RETURNING "attempts"`;
      if (!rows || rows.length !== 1) return Number.MAX_SAFE_INTEGER;
      return Number(rows[0].attempts);
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
     * VERIFIED 2026-09-03 (was U-NONCE): the INSERT is the claim. A concurrent duplicate raises P2002 and
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
     * VERIFIED 2026-09-03 (was U-RATE): the whole read-modify-write must be one transaction, or a burst of
     * concurrent requests each reads `count` before any writes it and the limit admits N rather
     * than max. A limiter that is only correct when requests arrive one at a time is not a
     * limiter, and every limit in ADR 003 §6.1 rides on this one method.
     */
    async rateAllow(key, windowMs, max) {
      const t = now();
      return runTx(async (tx) => {
        const b = await tx.rateBucket.findUnique({ where: { key } });
        if (!b || t - b.windowStart.getTime() >= windowMs) {
          if (max < 1) return false;
          await tx.rateBucket.upsert({
            where: { key },
            create: { key, count: 1, windowStart: new Date(t) },
            update: { count: 1, windowStart: new Date(t) },
          });
          return true;
        }
        if (b.count >= max) return false;
        await tx.rateBucket.update({ where: { key }, data: { count: { increment: 1 } } });
        return true;
      });
    },
  };

  const store = {};
  for (const name of STORE_METHODS) store[name] = impl[name];
  selfStore = store;
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
 * THE CLAIM LEDGER — every behavioural claim this file rests on, the exact Postgres or Prisma
 * semantics behind it, what breaks if the semantics differ, and **what settled it**.
 *
 * THE NAME IS NOW WRONG AND IS KEPT ON PURPOSE. Every row carries a `verifiedOn` witness, so
 * nothing in here is unverified any more. It is still called `UNVERIFIED_CLAIMS` because
 * `tests/server/attack-relay-ordering.test.js` — a file this owner may not edit — imports the
 * name and asserts that `U-SEQ` and `U-TX` are still declared in it. Renaming it to
 * `ADAPTER_CLAIMS` is a two-file change and belongs to whoever owns that test; its §6 title
 * ("What is NOT settled — the production adapter") and its comment "nothing in this repository
 * can execute it" are both stale as of 2026-09-03 and should be re-worded, not deleted.
 *
 * This export is not documentation. `tests/server/store-contract.test.js` asserts that every
 * entry names a method that exists on the store, that every `U-` tag used in a comment above
 * appears here and vice versa, and that every row states both a consequence and a witness — so
 * the honesty cannot rot into a stale comment block in either direction.
 *
 * THREE OF THE TWENTY-TWO WERE FALSE when they were finally run, and those three are the whole
 * argument for having run them: `U-TX`'s retry half (R8-RETRY), `U-DEVSPACE`'s cross-row half
 * (R8-DEVSPACE) and `U-BUMP`'s read-back half (R8-BUMPREAD). A claim that is merely written down
 * carefully is not a claim that is true.
 */
export const UNVERIFIED_CLAIMS = Object.freeze([
  { tag: 'U-TX', method: 'tx', claim: '$transaction(fn, {isolationLevel: Serializable}) rolls back every write on throw and re-throws.', breaks: 'A rotation that fails after inserting half its wraps leaves a space whose epoch says e+1 and whose key wraps cover nobody — every member locked out of their own board.', verifiedOn: "C02/C53/C54/C55/C56/C58 — rollback, re-throw and re-entrancy all hold. But the SECOND half of this claim was FALSE: nothing anywhere retried a serialization failure. See R8-RETRY / isSerializationFailure." },
  { tag: 'U-TXNEST', method: 'tx', claim: 'A nested tx re-enters on the same client instead of opening a second transaction.', breaks: 'Deadlock against connection_limit=1: the outer transaction holds the only connection while the inner one waits for it.', verifiedOn: "C56 — a nested tx re-enters on the same client. It holds only after R8-TXCLIENT: the bodies used to escape to the OUTER client, which is exactly the connection_limit=1 deadlock this claim denied." },
  { tag: 'U-SEQ', method: 'reserveSeq', claim: 'UPDATE ... SET nextSeq = nextSeq + n RETURNING nextSeq takes a row lock for the transaction and returns the post-increment value.', breaks: 'Two concurrent pushes assign the same seq. The second overwrites the first in the primary key, and one family member\'s afternoon of edits is gone with a 200 OK.', verifiedOn: "C12/C15/C16, and two independent clients pushing at once produced a gapless 1,2,3,4 with nextSeq 4 and nothing lost — but only after R8-RETRY, because the raw UPDATE surfaces 40001 as P2010 and the loser used to throw its ops away." },
  { tag: 'U-UPSERT', method: 'upsertOps', claim: 'The existing-opId SELECT and the counter bump are in one Serializable transaction, so a retried push burns no seq numbers.', breaks: 'Every retry advances the counter. Cursors still work, but the log grows holes and the "gapless" property in ADR 003 §3.3 is quietly false.', verifiedOn: "C19/C20/C21/C23 — a re-push burns no seq numbers and a mixed batch gets a contiguous block." },
  { tag: 'U-P2002', method: 'createSpace', claim: 'Prisma surfaces a unique violation as err.code === "P2002" for every model in this schema.', breaks: 'A duplicate becomes an unhandled 500 instead of a defined error, and claimEpoch returns a throw instead of false — so a concurrent rotator sees a server error rather than 409 epoch_taken.', verifiedOn: "C09 (duplicate space), C10 (epoch race), C27 (colorRef), C29 (deviceShort) — P2002 for every model in this schema." },
  { tag: 'U-EPOCH', method: 'claimEpoch', claim: 'The composite primary key @@id([spaceId, epoch]) resolves a rotation race first-writer-wins.', breaks: 'Two rotations both believe they own epoch e+1 and each wraps a different key to a different subset of devices. Half the family can read the new epoch, half cannot.', verifiedOn: "C10/C57, and a two-client race for epoch 2 gave exactly one true and one false." },
  { tag: 'U-CASCADE', method: 'deleteSpace', claim: 'onDelete: Cascade removes members, devices, ops, epochs, key wraps and invites when a space row is deleted.', breaks: 'Story 20.4 promises a purge. Rows survive, and the relay keeps ciphertext for a family that asked to be forgotten.', verifiedOn: "C11, and measured: deleteSpace over 75 000 ops cascaded in 37 ms and left the other space intact." },
  { tag: 'U-CURSOR', method: 'listOps', claim: 'seq: { gt: cursor } with orderBy seq asc and take limit+1 paginates exactly, and BigInt comparison is numeric rather than lexical.', breaks: 'Lexical comparison makes seq 9 sort after seq 10 and a client silently skips ops.', verifiedOn: "C17, and EXPLAIN shows Index Scan using Op_spaceId_seq_idx with Index Cond: (seq > 50000) — a numeric int8 comparison, not lexical." },
  { tag: 'U-PURGE', method: 'deleteOpsByDevices', claim: '@@index([spaceId, deviceShort]) makes the 20.2 purge an index scan, and deleteMany returns an exact count.', breaks: 'A member removal in a space with a year of ops exceeds the 10 s function timeout, and the membership write commits without the purge.', verifiedOn: "C25, and measured on 100 000 ops: EXPLAIN gives Index Scan using Op_spaceId_deviceShort_idx, and deleting 25 000 of them took 15 ms against a 10 s function timeout." },
  { tag: 'U-COLOR', method: 'addMember', claim: '@@unique([spaceId, colorRef]) is what enforces 15.3; colorFree is advisory.', breaks: 'Two members racing to join pick the same colour and the board legend has two identical swatches with no way to tell them apart.', verifiedOn: "C27 — the unique index refuses the second joiner; colorFree stays advisory." },
  { tag: 'U-MONO', method: 'setLastSeenSeq', claim: 'updateMany with (spaceId, deviceShort) and lastSeenSeq: { lt: seq } makes a stale ack a no-op rather than a rewind, and touches ONE circle\'s row.', breaks: 'GC un-collects: a device rewinds the minimum and tombstones peers already dropped come back, resurrecting deleted entries.', verifiedOn: "C32/C32b — a stale ack is a no-op and progress is per space." },
  { tag: 'U-DEVSPACE', method: 'getDeviceByShort', claim: 'Prisma spells the @@unique([spaceId, deviceShort]) selector `spaceId_deviceShort`, and no row has a spaceId its member does not share.', breaks: 'Auth step 4 cannot resolve a device at all (every request 403 device_revoked), or resolves one in the wrong circle and answers with another member\'s id.', verifiedOn: "C29/C29b — the selector really is spelled spaceId_deviceShort. The SECOND half was FALSE: Postgres accepted a device whose spaceId disagreed with its member's, because no constraint covers it. C29c passes only because addDevice now checks it. See R8-DEVSPACE." },
  { tag: 'U-DEVSHORTSCAN', method: 'listDevicesByShort', claim: 'A findMany on the non-leading `deviceShort` column is a scan, and that is acceptable at three routes per request.', breaks: 'pair/* auth pays a table scan of every device on the relay per request; at fleet scale that is the Hobby-tier query budget.', verifiedOn: "EXPLAIN confirms Seq Scan on \"Device\" — the scan is real, and accepted, exactly as claimed." },
  { tag: 'U-JOIN', method: 'listDevices', claim: 'where: { member: { spaceId } } is one join, not N+1.', breaks: 'The rotation coverage check and every pull pay a query per member; at eight members and a 45 s cadence that is the Hobby-tier connection budget.', verifiedOn: "EXPLAIN gives ONE Hash Join between Device and Member for the whole call — one query, not N+1." },
  { tag: 'U-WRAPONCE', method: 'putKeyWraps', claim: 'The findMany over the incoming cells and the createMany that follows run inside one Serializable transaction, and createMany({skipDuplicates:true}) over @@id([spaceId, epoch, recipientId, senderDeviceId]) inserts the absent rows and silently leaves an occupied cell to its first writer. The findMany deliberately does NOT filter on senderDeviceId: it fetches a superset of the cells and cellKey picks the exact ones out of it.', breaks: 'Finding T5-K3. If skipDuplicates instead replaced, or if the read and the insert were two transactions with a replace between them, one ordinary member could overwrite every wrap of every recipient for every epoch below her own — and the loss is invisible until a future joiner, a newly paired device, or ADR 002 §7.3 A2 recovery asks the relay for the history and gets bytes nobody can open.', verifiedOn: "C34/C61/C63, and a two-client race for the SAME cell with DIFFERENT bytes left exactly one row standing with the loser reporting refused:1 — but only after R8-RETRY: the loser used to raise P2034 and 500 the whole rotation." },
  { tag: 'U-WRAPNOUPDATE', method: 'putKeyWraps', claim: 'No statement in this file issues an UPDATE against KeyWrap; deleteKeyWrapsForDevices is the only other writer, so a stored wrap can be deleted but never rewritten in place.', breaks: 'Postgres is not enforcing write-once — there is no trigger and no column grant — so if a later edit reintroduces an upsert here, the schema will accept it without a word and T5-K3 is open again on production while memory.js stays green.', verifiedOn: "C34 plus a static read of this file: the only writers of KeyWrap are createMany and deleteMany." },
  { tag: 'U-CONSUME', method: 'consumeInvite', claim: 'updateMany with usedAt: null in the WHERE gives a row count of 1 to exactly one concurrent caller.', breaks: 'Two people redeem one invite. Both become members; the admin issued one invitation and sees two names, one of which they cannot account for.', verifiedOn: "C37/C38, and a two-client race gave one invite row and one null — the loser now sees invite_used rather than a 500 (R8-RETRY)." },
  { tag: 'U-BURN', method: 'putPairSession', claim: 'The burnedAt guard makes a burn permanent against a replayed pair/offer.', breaks: 'The 5-attempt cap resets on demand. ADR 002 §6.4\'s honest analysis — "an online guessing budget is meaningless" — stops being true, and a 60-bit code faces unlimited guesses.', verifiedOn: "C44 — a burned rendezvous cannot be re-created, before or after a restart." },
  { tag: 'U-BUMP', method: 'bumpPairAttempts', claim: '{ increment: 1 } is an atomic SET attempts = attempts + 1.', breaks: 'Concurrent failed decrypts lose increments and the budget never reaches 5.', verifiedOn: "C43. The increment was atomic as claimed; the ANSWER was not, because it came from a separate read — five concurrent bumps read back [5,5,5,5,5]. Fixed with RETURNING; see R8-BUMPREAD, and R8-TZ for the timestamp binding that fix exposed." },
  { tag: 'U-NONCE', method: 'claimNonce', claim: 'The INSERT itself is the claim; a concurrent duplicate raises P2002.', breaks: 'Two concurrent requests both see the nonce absent and both proceed — a replayed request is accepted, which is ADR 003 §2 step 3 defeated.', verifiedOn: "C46/C47, and a two-client race gave exactly one true." },
  { tag: 'U-RATE', method: 'rateAllow', claim: 'The read-modify-write runs in one transaction, so a burst admits at most max.', breaks: 'Every limit in ADR 003 §6.1 becomes advisory: 10 invite redemptions per IP per hour admits as many as arrive in the same millisecond.', verifiedOn: "C49/C51/C52/C58, and six concurrent requests across two clients against max 3 admitted exactly 3 with the bucket at 3 — but only after R8-RETRY, which is what stopped 3 of the 6 throwing P2034 instead of answering." },
  { tag: 'U-BYTES', method: 'getSpace', claim: 'Prisma returns Bytes columns as Buffer, which is a Uint8Array, so RULE 1 holds on the read side too.', breaks: 'An envelope comes back as a string, a handler concatenates it, and the padding and AAD binding are destroyed.', verifiedOn: "C03/C07/C59 — Bytes come back as Buffer, which is a Uint8Array, and bigint and Date survive the round trip." },
]);

/** The rows of the ledger that still have no witness. Empty as of 2026-09-03, and asserted so. */
export const CLAIMS_STILL_UNVERIFIED = Object.freeze(UNVERIFIED_CLAIMS.filter((c) => !c.verifiedOn));

/**
 * WHAT THE LOCAL RUN DOES NOT SETTLE — the honest remainder of R-8.
 *
 * An adapter that passes 65 contract cases against a Homebrew cluster on a laptop has proven a
 * great deal more than it had, and less than "it works in Frankfurt". These are the differences
 * that are known and unclosed, each with what would close it. They are data for the same reason
 * the claim ledger is: so the next reader inherits a list rather than a feeling.
 */
export const RESIDUAL_RISKS = Object.freeze([
  Object.freeze({
    id: 'R8-R1', subject: 'the deployed database is not the tested one',
    risk: 'Frankfurt is Prisma Postgres reached through the platform pooler (decision D2); the run above is PostgreSQL 17.10 reached directly. A pooler in transaction mode can refuse an interactive `$transaction`, can silently downgrade `isolationLevel: Serializable`, and does not necessarily preserve session state between statements.',
    breaks: 'Every atomicity claim in the ledger rests on one interactive Serializable transaction. If the pooler will not give one, `rateAllow`, `consumeInvite`, `putKeyWraps` and `upsertOps` all lose their guarantee while still answering 200.',
    closedBy: 'run `LZP_CONTRACT_DATABASE_URL=<the real Frankfurt string> npm run test:server` once against the deployed database, before it holds a family, and read the same 65/66.',
  }),
  Object.freeze({
    id: 'R8-R2', subject: 'a retry that runs out',
    risk: 'After `TX_RETRIES` serialization failures the adapter re-throws P2034/P2010, and nothing above it maps that to a status code — `server/core/` contains no reference to either. The request becomes a 500 with no defined body.',
    breaks: 'Under sustained contention on one space, a push fails as a server error rather than as something the client knows how to retry. It is strictly better than the silent loss it replaces, and it is not yet a defined outcome.',
    closedBy: 'a row in the router that answers a still-conflicting transaction as 503 with retryAfter. Owner: server/core/router.js + server/core/errors.js — NOT this file.',
  }),
  Object.freeze({
    id: 'R8-R3', subject: 'C40 is skipped, not passed',
    risk: 'One of the 66 cases cannot run against a real Postgres because it builds an Invite for a Space it never created, which the foreign key correctly refuses.',
    breaks: 'Nothing today — the case is stated as a skip and the guard test fails if it ever starts passing. But `listOpenInvites` is therefore the one interface method with two green witnesses instead of three.',
    closedBy: "one line in server/core/store-interface.js C40: `await store.createSpace(fixtures.space({ id: SP2 }));`, exactly as C11 and C22 already do. Verified in a scratch copy: green on memory AND on prisma.",
  }),
  Object.freeze({
    id: 'R8-R4', subject: 'server/adapters/vercel.js is still unexecuted',
    risk: 'The fourth adapter has its own UNVERIFIED_CLAIMS and was not part of this run; it is not this owner\'s file.',
    breaks: 'The deploy selects an adapter at runtime. Two of the four are now verified against real storage, one against a real database, and one against nothing.',
    closedBy: 'the same treatment: run STORE_CONTRACT_CASES against it from tests/server/store-contract.test.js. Owner: server/adapters/vercel.js.',
  }),
]);
