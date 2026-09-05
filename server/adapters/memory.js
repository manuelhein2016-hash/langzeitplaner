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
  normalizeReportInput, reportExpired,
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

/** Byte equality. Not constant-time on purpose: both operands are the relay's own rows, and
 *  there is no secret here to leak — a wrap is ciphertext the relay may not open and may compare. */
function sameBytes(a, b) {
  if (a === b) return true;
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Is this incoming wrap the row the store already holds? The sender is compared as well as the
 * bytes even though it is part of the cell key, so this stays a total statement about the row
 * rather than one that silently depends on how it was looked up: ADR 002 §4.2 step 6 makes the
 * receiver derive its KEK against the SENDER's key, so identical bytes under a different
 * depositor are a different row and open under a different key. Used by `putKeyWraps`'
 * write-once rule (findings T5-K3, T5-K1).
 */
function sameWrap(held, incoming) {
  return held.senderDeviceId === incoming.senderDeviceId && sameBytes(held.wrapped, incoming.wrapped);
}

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
    keyWraps: new Map(),    // spaceId\0epoch\0recipientId\0senderDeviceId -> KeyWrapRow
    invites: new Map(),     // id -> InviteRow
    pairs: new Map(),       // rid -> PairSessionRow
    nonces: new Map(),      // deviceShort\0nonce -> expiresAtMs (number)
    rates: new Map(),       // key -> {count, windowStart}
    // LZP-1009 second pass. A FLAT map keyed by report id — no space index, no member index, and
    // deliberately not reachable from `state.spaces`: `deleteSpace`'s cascade below walks named
    // collections, and this one is not among them because a report belongs to no circle. There is
    // no key here a board could be joined on.
    reports: new Map(),     // id -> ReportRow
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
      // `Device.spaceId` is DERIVED from `Member.spaceId` and this is what keeps it derived.
      // A row where the two disagree would put the `@@unique([spaceId, deviceShort])` guard on a
      // namespace nobody is in, and `getDeviceByShort(spaceId, …)` and `listDevices(spaceId)`
      // would answer different questions about the same machine. Postgres cannot express this
      // (it is a cross-row invariant); it is stated here and carried as U-DEVSPACE in prisma.js.
      const owner = state.members.get(r.memberId);
      if (!owner) throw new StoreShapeError(`device ${r.id} names member ${r.memberId}, which does not exist`);
      if (owner.spaceId !== r.spaceId) {
        throw new StoreShapeError(
          `Device.spaceId (${r.spaceId}) must equal its member's spaceId (${owner.spaceId}) — the short's namespace is the space`);
      }
      // ONE SHORT, ONE ROW, PER SPACE — round 10 item 8. It used to be per RELAY, which blocked
      // the product (E2-203-1) and turned a key-derived identity into a name any member of your
      // circle could claim first. See server/prisma/schema.prisma's Device note.
      for (const other of state.devices.values()) {
        if (other.spaceId === r.spaceId && other.deviceShort === r.deviceShort) {
          throw new StoreShapeError(`deviceShort ${r.deviceShort} is already registered in ${r.spaceId}`);
        }
      }
      if (typeof r.lastSeenSeq !== 'bigint' || typeof r.lastPushedSeq !== 'bigint') {
        throw new StoreShapeError('Device.lastSeenSeq and lastPushedSeq must be bigints');
      }
      state.devices.set(r.id, r);
    },

    getDevice(deviceId) { return copy(state.devices.get(deviceId) || null); },

    getDeviceByShort(spaceId, deviceShort) {
      for (const d of state.devices.values()) {
        if (d.spaceId === spaceId && d.deviceShort === deviceShort) return copy(d);
      }
      return null;
    },

    /** Every space's row for this short. Auth's only, on the routes that name no space. */
    listDevicesByShort(deviceShort) {
      return copies([...state.devices.values()].filter((d) => d.deviceShort === deviceShort));
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

    // Both setters are keyed on (spaceId, deviceShort) and not on the short alone: since round
    // 10 one Mac has a row per circle, each with its own cursor, and both cursors gate tombstone
    // GC. A short-only setter would let a busy Familienkreis fast-forward the personal space's
    // read cursor past tombstones that Mac had never pulled. Contract case C32b.
    setLastSeenSeq(spaceId, deviceShort, seq) {
      for (const d of state.devices.values()) {
        if (d.spaceId !== spaceId || d.deviceShort !== deviceShort) continue;
        if (seq > d.lastSeenSeq) d.lastSeenSeq = seq;   // monotone: a stale ack never rewinds it
        return;
      }
    },

    setLastPushedSeq(spaceId, deviceShort, seq) {
      for (const d of state.devices.values()) {
        if (d.spaceId !== spaceId || d.deviceShort !== deviceShort) continue;
        if (seq > d.lastPushedSeq) d.lastPushedSeq = seq;
        return;
      }
    },

    minLastSeenSeq(spaceId) { return minOver(spaceId, 'lastSeenSeq'); },
    minLastPushedSeq(spaceId) { return minOver(spaceId, 'lastPushedSeq'); },

    // key wraps ────────────────────────────────────────────────────────────
    /**
     * **WRITE-ONCE, per (spaceId, epoch, recipientId, senderDeviceId).**  Findings T5-K3 + T5-K1.
     *
     * This was `state.keyWraps.set(...)` — an upsert — and that one line was the family's key
     * history handed to whoever asked last. `POST /spaces/:id/epoch` admits any current member
     * (ADR 002 §4.2, decision D9: "any member device, not only the admin's"), and a rotation
     * names wraps for epochs 1..e+1. So an ordinary member could deposit bytes of her own
     * choosing over EVERY row of every recipient for every epoch below her own, and the relay —
     * which cannot open a wrap and must not try — recorded it as coverage.
     *
     * The loss is not visible to anybody who is online: a member's ring lives in her own
     * `localStorage`. The victims are the readers who have only the relay left — every future
     * joiner, every device paired in tomorrow, and ADR 002 §7.3's A2 recovery, which is the only
     * path that survives losing every device. And no honest client could notice: `rotateTo`
     * builds its wrap set from its own ring and posts it, and no route answers "what is already
     * there?".
     *
     * ── THE CELL, AND WHY THE DEPOSITOR IS PART OF IT ────────────────────────────────────────
     *
     * The cell is `(spaceId, epoch, recipientId, senderDeviceId)`. The sender was added during
     * integration, and it is what makes ONE rule close BOTH findings instead of trading them:
     *
     *   · Without the sender, "first writer wins" hands the cell to whoever arrives first —
     *     which for a JOINER is whoever rotates while she is still catching up. Her cells for
     *     epochs 1..e are all empty when she appears, so a hostile member fills them with
     *     garbage, every honest re-delivery for those epochs is refused by the store for ever,
     *     and she is permanently denied the shared history. Measured: she ended holding `[4]`
     *     and no history, the board never rendered „Omas Geburtstag", and her ops quarantined.
     *     That is T5-K1's residual, and it is a denial the relay itself enforces.
     *
     *   · With the sender, the honest wrap and the junk COEXIST. Eve still cannot move one byte
     *     anybody else deposited — a different depositor is a different row, so T5-K3 is closed
     *     by construction rather than by refusal — and the receiving side already handles the
     *     rest: `admitWraps` walks a recipient's rows, counts the one that will not open as
     *     `refused`, and admits the one that does. `assertCoverage` folds a recipient's rows
     *     into a Set of EPOCH NUMBERS before it counts, so duplicates cannot inflate coverage.
     *
     * ── THE RULE ─────────────────────────────────────────────────────────────────────────────
     *   · the cell is EMPTY   → the row lands.                                        (stored)
     *   · the cell is FULL and the incoming row is byte-for-byte the stored one → nothing
     *     happens and nobody is told off. An idempotent re-post.                         (kept)
     *   · the cell is FULL and the incoming row DIFFERS → the incoming row is REFUSED and the
     *     stored row stands.                                                          (refused)
     *
     * Because the sender is part of the cell, a `refused` row is now always THIS depositor
     * re-wrapping ITS OWN earlier cell with a fresh salt and IV — which every honest rotation
     * after the first does, for every epoch below its own. `refused` is therefore ORDINARY
     * ACCOUNTING and never an abuse signal; it was never one under the narrower cell either,
     * for exactly the same reason. Nothing may read it as "somebody attacked a cell".
     *
     * ── WHY A REFUSED ROW IS NOT A THROWN REQUEST, WHICH IS THE HARDER HALF ──────────────────
     *
     * A write-once rule that aborts the whole POST would be a denial of its own, and a total one.
     * `wrapSpaceKey` draws a fresh 32-byte salt and a fresh 12-byte IV per wrap, so re-wrapping
     * an epoch NEVER reproduces its bytes. `buildRotation` re-wraps 1..e+1 on every rotation
     * (`wrapRingToRecipients` refuses to build a partial ring — A4, story 17.1). Therefore EVERY
     * honest rotation after the first arrives carrying differing bytes for every already-filled
     * cell. Throwing would 500 the first rotation of every family on earth; refusing the row and
     * keeping the request turns those cells into no-ops and leaves the coverage check — which
     * counts rows, not bytes — passing exactly as before.
     *
     * The three honest re-posts this was checked against, all of them now no-ops:
     *   · a RETRIED rotation whose response was lost — same epoch, `409 epoch_taken` on the
     *     second try, and its 1..e cells refused rather than rewritten;
     *   · a DUPLICATE delivery — two member devices each handing the same joiner the same ring;
     *   · a RACE — both members deliver at e+1. The loser's whole transaction rolls back anyway,
     *     and on the way there its 1..e rows do not disturb the winner's.
     *
     * The counts are returned rather than swallowed so that a caller which wants to surface
     * "somebody tried to rewrite N wraps" has the number. Nothing reads it yet; see the note to
     * `server/core/handlers/spaces.js`'s owner in this pass's report.
     *
     * ── WHAT WRITE-ONCE COSTS, STATED PLAINLY ────────────────────────────────────────────────
     *
     * Not the healing path: a live sender re-delivering an epoch a since-revoked device
     * deposited writes its OWN row beside the stale one, and the recipient opens the one that
     * opens. C61 asserts exactly that. What it costs instead is ROWS. A recipient's cell for one
     * epoch can hold one row per depositing device, so a member who wants to waste storage can
     * deposit a junk row per (epoch, recipient) on every rotation she wins.
     *
     * That is bounded and attributable rather than free: `putKeyWraps` is reachable only from
     * `POST /spaces` (creation, two recipients) and `rotateEpoch`, a rotation carries at most
     * `MAX_WRAPS` = 1024 rows, and each one burns an epoch it must win a 409 race for and spends
     * a rate-limit budget under a signed device identity. It is the same shape of cost as the
     * N attributable removals in `e6-attack-removed` §1e-ii — visible, chargeable, and not a
     * silent loss of anybody's data, which is what both alternatives were.
     *
     * @param {Array<Object>} rows
     * @returns {{stored:number, kept:number, refused:number}}
     */
    putKeyWraps(rows) {
      // Validate the whole batch first: a rotation is one transaction, and half a set of wraps
      // is exactly the incomplete coverage ADR 002 §4.2 exists to prevent.
      const clean = (rows || []).map((raw) => normalizeRow('KeyWrap', raw));
      let stored = 0; let kept = 0; let refused = 0;
      for (const r of clean) {
        const key = K(r.spaceId, String(r.epoch), r.recipientId, r.senderDeviceId);
        const held = state.keyWraps.get(key);
        if (!held) { state.keyWraps.set(key, r); stored++; continue; }
        if (sameWrap(held, r)) { kept++; continue; }
        refused++;
      }
      return { stored, kept, refused };
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

    // reports ─────────────────────────────────────────────────────────────
    // LZP-1009 second pass. Four methods that name no space, over a table that has no space
    // column — see `store-interface.js` REPORTS. Nothing in this block reads `state.spaces`,
    // `state.ops` or `state.members`, and nothing in the rest of this file reads `state.reports`.
    // That mutual ignorance is the guarantee; the tests that hold it are C64 and blindness §9.

    putReport(input) {
      const t = now();
      sweepReports(t);
      const row = normalizeReportInput(input, t);
      // REFUSED, never overwritten. The id is what the admin view's „Löschen" addresses, so a
      // second write under a live id would change the sentence he is looking at.
      if (state.reports.has(row.id)) throw new StoreShapeError(`report ${row.id} already exists`);
      state.reports.set(row.id, row);
      return copy(row);
    },

    listReports(limit) {
      const t = now();
      sweepReports(t);                                   // the READ-path sweep: Hobby has no cron
      const cap = Math.max(0, Number(limit) || 0);
      const live = [...state.reports.values()].filter((r) => !reportExpired(r, t));
      // Newest first, and `id` breaks a tie inside one millisecond so the order is total rather
      // than insertion-dependent — two adapters that disagree about "newest" are two adapters.
      live.sort((a, b) => (b.receivedAt.getTime() - a.receivedAt.getTime()) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      return copies(live.slice(0, cap));
    },

    /** null for unknown AND for expired — indistinguishable, and it does NOT sweep. */
    getReport(id) {
      const row = state.reports.get(id);
      if (!row || reportExpired(row, now())) return null;
      return copy(row);
    },

    /** Idempotent: true when a row went, false when there was nothing to remove. Never a throw. */
    deleteReport(id) {
      return state.reports.delete(id);
    },
  };

  /** The 90-day sweep. Lazy, on put and on list (ADR 003 §10 weakness 2 — Hobby has no cron). */
  function sweepReports(t) {
    for (const [id, row] of [...state.reports]) if (reportExpired(row, t)) state.reports.delete(id);
  }

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
    // `getReport` reads one row and writes nothing. `listReports` is NOT here on purpose: it
    // sweeps, and the sweep is the whole reason the read path exists as a retention mechanism.
    'getReport',
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
