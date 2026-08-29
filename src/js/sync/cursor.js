// src/js/sync/cursor.js — per-space cursors, and the one invariant that makes them safe.
// LZP-501 · ADR 003 §3.3 · ADR 006 §9.1 (W1) · sync.contract.js §3.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY A CURSOR IS THE MOST DANGEROUS NUMBER IN THE PRODUCT
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Everything else in this system is idempotent and forgiving. Ops merge by set union; a duplicate
// costs nothing (ADR 001 §6); a re-push is answered `duplicate` and returns 200; a device three
// weeks offline is "a large op set arriving late". There is exactly one value whose corruption
// is silent, permanent and one-sided, and it is this one:
//
//   > A cursor that advances past an op the client did not receive loses that op permanently and
//   > quietly, on one device, and no test of the happy path finds it.
//                                              — server/core/handlers/ops.js, on `nextCursor`
//
// The relay half of that rule is enforced in `pullOps`. This file is the client half, and it has
// three jobs, all of them refusals:
//
//   1. **NEVER ADVANCE BEFORE THE BATCH IS DURABLE.** ADR 003 §3.3: the cursor advances "only
//      after the batch has been decrypted, folded into the registers AND PERSISTED. A crash
//      mid-pull re-fetches rather than skips." That is a rule about ORDER, and a rule about order
//      that lives in a comment is a rule that survives until the next refactor. So `advance()`
//      takes the commit as an ARGUMENT and runs it: there is no way to spell "persist the cursor"
//      that does not first run the thing the cursor is a promise about. See `advance`.
//
//   2. **NEVER GO BACKWARDS, NEVER GO SIDEWAYS.** A cursor is monotone per space. A regression
//      re-delivers ops, which is merely wasteful; accepting a non-canonical spelling (`'007'`,
//      `' 7'`) is worse, because the persisted value then has more than one form and comparing
//      two of them stops being decidable by string equality — the same reason `server/core/auth.js`
//      refuses a non-canonical nonce.
//
//   3. **W1 — THE CURSOR MAY NEVER BE AHEAD OF `board.json`.** ADR 006 §9.1 states it as an
//      invariant and says it "must be asserted, so that a future sync engine cannot break it by
//      persisting a cursor through some other file". This file is that future sync engine. It
//      persists through ONE injected port, and that port is meant to be `checkpoint().cursors`,
//      written after `board.json` in the same persist (ADR 006 R5). It has no other way to write.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT A CURSOR RECORD HOLDS, AND WHY THE CHAIN HEAD IS IN IT
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
//   { seq: '10432', chain: '9fA2…', fromGenesis: true }
//
// `chain` is the chain witness's head (`chain.js`). It lives here rather than in its own file
// because it answers the same question the cursor does — *"where was I in this space's log?"* —
// and two persisted answers to one question is how they drift apart. A restart that restored the
// cursor but not the head would silently lose the ability to verify the very next page.
//
// PURE. No clock, no randomness, no I/O — `storage` is a port. `src/js/sync/` may not import
// `src/js/storage.js` (ADR 005 §2's import direction), which is the good kind of constraint here:
// this module cannot reach the disk on its own even by accident.

import { parseSeq, cmpSeq, ZERO_SEQ } from './protocol.js';

/**
 * @typedef {Object} CursorStore
 * @property {() => Promise<Object|null>} loadCursors
 * @property {(all:Object) => Promise<void>} saveCursors
 *
 * WP-8 / the store binds this to `checkpoint().cursors` — written AFTER `board.json` in the same
 * persist, which is what makes W1 hold automatically (ADR 006 §9.1, R5). **Reported as an
 * obligation on `src/js/store.js`**, which is not this work package's file: `checkpoint()` must
 * carry a `cursors` key and `storage.saveCheckpoint` must be the only writer of it. Until that
 * lands the client runs against an in-memory store and the invariant is vacuous — which is the
 * loud, correct symptom of an unfinished seam, and `diagnostics().cursors.durable` says so.
 */

/** An in-memory store, for tests and for the seam before the store wires the real one. */
export function memoryCursorStore(initial) {
  let held = initial ? JSON.parse(JSON.stringify(initial)) : {};
  return {
    durable: false,
    async loadCursors() { return JSON.parse(JSON.stringify(held)); },
    async saveCursors(all) { held = JSON.parse(JSON.stringify(all)); },
  };
}

/**
 * @param {{storage:CursorStore, warn?:(m:string)=>void}} ports
 */
export function createCursors(ports = {}) {
  const storage = ports.storage || memoryCursorStore();
  const warn = typeof ports.warn === 'function' ? ports.warn : () => {};
  /** @type {Map<string, {seq:string, chain:string, fromGenesis:boolean}>} */
  const cur = new Map();
  let loaded = false;

  const blank = () => ({ seq: ZERO_SEQ, chain: '', fromGenesis: false });

  /** A persisted record, read as hostile input: it may have been hand-edited or truncated. */
  const readRecord = (space, raw) => {
    if (raw === null || raw === undefined) return null;
    // Tolerated shorthand: a bare seq string or number, which is what a hand-written file or an
    // older build would carry. It restores the cursor and forgoes the chain head — losing
    // verification is the right degradation; losing the cursor would re-pull the world.
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint') {
      const s = parseSeq(typeof raw === 'string' ? raw : String(raw));
      if (s === null) {
        warn(`cursor: the stored cursor for ${space} (${JSON.stringify(raw)}) is not a seq; starting from 0`);
        return null;
      }
      return { seq: String(s), chain: '', fromGenesis: false };
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      warn(`cursor: the stored cursor for ${space} is not a record; starting from 0`);
      return null;
    }
    const s = parseSeq(raw.seq);
    if (s === null) {
      warn(`cursor: the stored cursor for ${space} has no readable seq; starting from 0`);
      return null;
    }
    const chain = typeof raw.chain === 'string' ? raw.chain : '';
    return { seq: String(s), chain, fromGenesis: raw.fromGenesis === true };
  };

  const api = {
    /** Hydrate from the store. Idempotent; a second call re-reads. */
    async load() {
      let all = null;
      try {
        all = await storage.loadCursors();
      } catch (e) {
        // A cursor store that cannot be read is NOT a reason to refuse to sync. Starting from 0
        // re-pulls the space, which is idempotent by `opId` and costs bandwidth and nothing else.
        // Refusing to start would be the one outcome that loses the user something.
        warn(`cursor: the cursor store could not be read (${e && e.name}: ${e && e.message}); every space starts from 0`);
      }
      cur.clear();
      if (all && typeof all === 'object' && !Array.isArray(all)) {
        for (const space of Object.keys(all)) {
          const rec = readRecord(space, all[space]);
          if (rec) cur.set(space, rec);
        }
      }
      loaded = true;
      return api.snapshot();
    },

    /** Whether `load()` has run. A client that pulls before it has is pulling from 0 blindly. */
    get loaded() { return loaded; },

    /** The seq to pass as `since`. `'0'` for a space never pulled. */
    get(space) { return (cur.get(space) || blank()).seq; },

    /** `{seq, chain}` for the chain witness, or `null` before the first page. */
    head(space) {
      const r = cur.get(space);
      if (!r || r.chain === '') return null;
      return { seq: r.seq, chain: r.chain };
    },

    /** Did this device's chain knowledge for `space` start at genesis? (see `chain.js`) */
    fromGenesis(space) { return (cur.get(space) || blank()).fromGenesis; },

    /** Every space with a cursor. */
    spaces() { return [...cur.keys()]; },

    /**
     * THE ONE WRITE PATH. ADR 003 §3.3's ordering, made structural.
     *
     * `commit` is the work the cursor is a promise about: decrypt, fold, persist. It runs FIRST,
     * and the cursor moves only if it resolves. If it throws, the cursor stays where it was and
     * the throw is re-raised — the batch is re-pulled next cycle and re-applied, which is free
     * (ADR 001 §6's idempotent fold) and is the whole reason "at-least-once is sufficient".
     *
     * There is deliberately no `set(space, seq)` that skips the commit. `sync.contract.js §3`
     * declares `set(space, seq)`; implementing it would be implementing the exact hazard this
     * module exists to prevent, so the contract's `set` is **narrowed to `advance`** and the
     * change is reported. A caller with genuinely nothing to commit passes `async () => {}` and
     * has said so out loud.
     *
     * @param {string} space
     * @param {string} seq the new cursor — the seq of the last op ACTUALLY RECEIVED
     * @param {{seq:string, chain:string}|null} head the chain head to persist beside it
     * @param {() => Promise<void>} commit
     * @param {{fromGenesis?:boolean}} [opts]
     * @returns {Promise<boolean>} true when the cursor moved
     */
    async advance(space, seq, head, commit, opts = {}) {
      const next = parseSeq(seq);
      if (next === null) {
        warn(`cursor: refusing to advance ${space} to ${JSON.stringify(seq)} — that is not a seq`);
        return false;
      }
      const prev = cur.get(space) || blank();
      const dir = cmpSeq(String(next), prev.seq);
      if (dir === -1) {
        // Not fatal and not silent. The relay is untrusted, so a lower cursor is either a lying
        // `nextCursor` (which `protocol.js readPullBody` already clamps) or our own bug.
        warn(`cursor: refusing to move ${space} BACKWARDS from ${prev.seq} to ${next}; `
           + 'a cursor is monotone per space (ADR 003 §3.3)');
        return false;
      }

      if (typeof commit !== 'function') {
        throw new TypeError('cursor.advance: `commit` is required — the cursor may only move after '
          + 'the batch it names has been folded AND persisted (ADR 003 §3.3, ADR 006 §9.1 W1)');
      }
      await commit();                                   // ← ORDER. The whole file is about this line.

      const rec = {
        seq: String(next),
        chain: head && typeof head.chain === 'string' ? head.chain : prev.chain,
        fromGenesis: opts.fromGenesis === true ? true : prev.fromGenesis,
      };
      cur.set(space, rec);
      try {
        await storage.saveCursors(api.snapshot());
      } catch (e) {
        // The cursor moved in memory but not on disk. That is the SAFE direction: the next launch
        // re-pulls from the older cursor and re-applies idempotently. The opposite — persisting a
        // cursor whose batch was not committed — is the loss this module exists to prevent, and it
        // is unreachable because `commit` ran above.
        cur.set(space, prev);
        warn(`cursor: ${space} could not be persisted at ${rec.seq} (${e && e.name}: ${e && e.message}); `
           + 'it stays at ' + prev.seq + ' and the batch will be re-pulled');
        return false;
      }
      return dir !== 0;
    },

    /**
     * Forget a space entirely — the space was deleted (20.4) or this member left (20.3). The next
     * pull of a space with this id would start from 0, which is correct: a re-created space id is
     * a different log.
     */
    async forget(space) {
      if (!cur.has(space)) return false;
      cur.delete(space);
      try {
        await storage.saveCursors(api.snapshot());
      } catch (e) {
        warn(`cursor: ${space} was forgotten in memory but the store refused (${e && e.message})`);
      }
      return true;
    },

    /** The persisted shape: `{[spaceId]: {seq, chain, fromGenesis}}`. A deep copy. */
    snapshot() {
      const out = {};
      for (const [space, rec] of cur) out[space] = { ...rec };
      return out;
    },

    /** For `store.diagnostics()`. No key material and no ciphertext — seqs and a hash. */
    diagnostics() {
      return {
        loaded,
        durable: storage.durable !== false,
        spaces: api.snapshot(),
      };
    },
  };

  return api;
}
