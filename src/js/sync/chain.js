// src/js/sync/chain.js — the chain witness.  LZP-501 · ADR 002 §5.4 · ADR 003 §3.1, §10.6.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE THING THIS FILE DETECTS, AND THE THREE SHAPES IT TAKES
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The relay cannot read a byte of a family's board — ADR 002 §5 makes sure of that — but it can
// still LIE BY OMISSION, and nothing else in this design would notice:
//
//   · WITHHOLD.  It serves Mac B every op except the one where Mama cancelled the appointment.
//                B's board is internally consistent, converges with itself, and is wrong.
//   · REORDER.   It serves the same ops in a different order. Merge outcomes do not depend on
//                `seq` (ADR 003 §3.3), so this is harmless to CONVERGENCE — and it is still
//                evidence that the log being served is not the log that was written.
//   · FORK.      It serves two different logs to two devices, indefinitely. Each device is
//                self-consistent. The family silently has two boards.
//
// `Op.chain = SHA-256(prevChain ‖ utf8(opId))` is a hash chain over the space's log, computed by
// the relay in seq order. Two independent checks fall out of it:
//
//   1. RECOMPUTE. A client that has pulled a contiguous run can recompute every `chain` it was
//      given. A withheld op, a reordered pair, or a fabricated row breaks the recomputation at
//      the first row that differs, and names it.
//   2. CROSS-CHECK. On push, every device sets `Envelope.wit` to the highest chain it had pulled
//      — so **every op a member authors commits to what that member had seen**. A peer that
//      recomputes the chain can ask: is this `wit` a value that ever appeared in MY chain? If it
//      is not, the relay served that device a log this device has never been shown. That is the
//      fork detector, and it is the half that a relay lying consistently to one device cannot
//      escape as long as the two devices ever exchange one op.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// SCOPE, STATED SO IT IS NOT OVERSOLD — AND ONE INTERACTION THE ADRs DO NOT MENTION
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// ADR 002 §5.4: "detection-only, best-effort, and it NEVER BLOCKS SYNC in v2 (a false positive
// that broke a family's board would be far worse than the attack)". So: nothing in this file
// throws, nothing in this file refuses an op, and `protocol.js classify()` deliberately does not
// read its output. Findings are diagnostics — the LZP-1003 self-audit and the sync error detail
// pane (ADR 002 §8.6).
//
// **THE INTERACTION, REPORTED RATHER THAN DISCOVERED LATER.** ADR 003 §6.3 has
// `POST /members/remove` and `/members/leave` **purge that member's `Op` rows** in the same
// transaction as the membership write (story 20.2). The chain is computed over ops in insertion
// order, so deleting rows makes every subsequent `chain` value **unrecomputable by anyone, for
// ever** — the surviving log no longer contains the opIds the hashes were taken over. After the
// first member removal in a family's life, check 1 above reports a mismatch on every pull, and
// check 2 reports every peer witness as unknown.
//
// Neither ADR says what a client should do about that, so this file decides, conservatively and
// visibly:
//
//   · a break is reported ONCE PER BREAK — deduped by `(kind, seq, served)`, not by "has anything
//     ever broken" — with `benignCause: 'member-purge'` named in it. Re-emitting the same hole on
//     every pull for the rest of the family's life would be an alarm nobody can silence, which is
//     how a real signal gets muted; suppressing every LATER break would be the detector switching
//     itself off, which is worse. Both mutants are pinned in `tests/tier1/sync-chain.test.js §5`;
//   · verification RESUMES from the new head — the client re-anchors on the row it just saw — so
//     a withheld op AFTER the purge is still caught. Detection degrades from "provable from
//     genesis" to "provable since the last anchor", which is the honest ceiling;
//   · nothing about it reaches `classify()`. See `protocol.js §6`.
//
// The alternative — treating a purge as an attack — would turn the one legitimate destructive
// operation in the product into a permanent red light. The cost is that a relay which withholds
// an op AND can convince a client a purge happened gets one free window. It cannot forge the
// re-anchor: the anchor is the chain value the relay itself served, and every op after it is
// still bound.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHO CALLS THIS, AND WHAT THE CALLER IS ALLOWED TO DO WITH THE ANSWER (round 9, 2026-08-29)
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `createChainWitness` had NO importer in `src/` for three rounds. Round 8 put the detector on the
// product path by importing `verifyChain` — the leaf below — into `sync/personal.js`, and then
// rebuilt, badly, the three things this wrapper already had:
//
//   · without `fresh`, the honest re-serve of a page whose cursor is held (F-6's first contact) was
//     verified against an anchor INSIDE it and reported as `seq jumped from 1 to 1` — finding R8-1;
//   · without the re-anchor and the dedupe, a member purge was re-derived as a fresh break on every
//     pull, and because round 8 also made a break a PERMANENT cursor hold, the space wedged and
//     every op above the hole was lost on an honest relay — finding R8-2, the failure this file's
//     own header predicted in the paragraph above.
//
// `pullNow` now calls `observe()`, and the rule about the answer is written on both sides so the
// two files cannot drift: **a finding is a diagnostic.** The caller may hold its cursor for the
// pull that DISCOVERS a break — one honest round trip for a relay that truncated a page — and it
// may not hold it after this witness has re-anchored, because a hole that cannot be filled is
// exactly what the one legitimate destructive operation in the product leaves behind. What the
// caller refuses unconditionally is a different claim entirely: a `nextCursor` past the last row
// served (ADR 003 §3.3), which is not this file's business.
//
// PURE. No clock, no randomness, no I/O. `subtle` is a port.

import { b64u, ub64, CodecError } from '../core/b64.js';
import { cmpSeq, parseSeq, ZERO_SEQ } from './protocol.js';

const TE = new TextEncoder();

/** How many past chain values one space keeps for the witness cross-check. */
export const WITNESS_MEMORY = 4096;

/** Every finding kind this module can emit. A caller may enumerate them; nothing else may. */
export const CHAIN_FINDINGS = Object.freeze({
  /** The recomputed chain does not equal the one the relay served. Withheld / reordered / forged. */
  MISMATCH: 'mismatch',
  /** `seq` is not contiguous with what we hold. §3.3 says the counter is gapless per space. */
  GAP: 'gap',
  /** A peer's `wit` names a chain value this device has never been served. A fork. */
  UNKNOWN_WITNESS: 'unknownWitness',
  /** A `wit` we cannot judge because our own chain does not reach back that far. Not evidence. */
  UNVERIFIABLE_WITNESS: 'unverifiableWitness',
  /** A row we could not decode at all — a b64u `chain` that is not base64url. */
  UNREADABLE: 'unreadable',
});

/**
 * `chain_n = SHA-256(chain_{n-1} ‖ utf8(opId_n))`, byte-identical to
 * `server/core/handlers/ops.js chainAfter`.
 *
 * `prev` is `null` for the first op a space ever holds — the relay starts from
 * `Space.headChain === null` and hashes the opId alone, NOT a 32-byte zero block. Getting that
 * wrong makes every chain in the space off by the first link and the mismatch looks like an
 * attack, which is the worst possible false positive for a detector.
 *
 * `opId` enters as its canonical ASCII spelling; that is the other reason `OP_ID_RE` is strict on
 * both sides — two spellings of one id would be two different chains over one log.
 *
 * @param {Uint8Array|null} prev
 * @param {string} opId
 * @param {{subtle?:SubtleCrypto}} ports
 * @returns {Promise<Uint8Array>} 32 bytes
 */
export async function chainAfter(prev, opId, ports) {
  const subtle = subtleOf(ports);
  const id = TE.encode(opId);
  const buf = new Uint8Array((prev ? prev.length : 0) + id.length);
  if (prev) buf.set(prev, 0);
  buf.set(id, prev ? prev.length : 0);
  return new Uint8Array(await subtle.digest('SHA-256', buf));
}

function subtleOf(ports) {
  const s = (ports && ports.subtle) || (globalThis.crypto && globalThis.crypto.subtle);
  if (!s || typeof s.digest !== 'function') {
    throw new Error('chain: a SubtleCrypto with digest() is required — inject `subtle`');
  }
  return s;
}

/** base64url → bytes, or `null`. Never throws: every input here is relay data. */
function bytesOf(s) {
  if (typeof s !== 'string' || s === '') return null;
  try {
    return ub64(s);
  } catch (e) {
    if (e instanceof CodecError) return null;
    throw e;
  }
}

/**
 * Verify one contiguous run of rows against a known anchor.
 *
 * This is `sync.contract.js §3`'s `verifyChain(ops, lastChain)`, with a `ports` argument the
 * contract's signature omits — SHA-256 is `subtle.digest`, which is async and which
 * `src/js/sync/` may not reach through a global (the purity gate forbids it and a test needs to
 * inject one anyway). **Reported as a contract amendment**: `verifyChain(ops, lastChain, ports)`
 * returning a Promise.
 *
 * @param {Array<{seq:string, chain:string, env:{oid:string}}>} rows ascending, contiguous
 * @param {{seq:string, chain:string}|null} anchor the last row this device had verified, or null
 *        to verify from the space's genesis
 * @param {{subtle?:SubtleCrypto}} [ports]
 * @returns {Promise<{ok:boolean, findings:Array, head:{seq:string, chain:string}|null,
 *                    chains:string[]}>}
 */
export async function verifyChain(rows, anchor, ports = {}) {
  const findings = [];
  const chains = [];
  let prev = null;
  let prevSeq = null;

  if (anchor) {
    prev = bytesOf(anchor.chain);
    prevSeq = parseSeq(anchor.seq);
    if (prev === null || prevSeq === null) {
      // An anchor we cannot decode is a bug in our own persistence, not evidence about the relay.
      // Verify from the first row instead of accusing anybody.
      findings.push({
        kind: CHAIN_FINDINGS.UNREADABLE,
        detail: `the stored chain anchor at seq ${anchor.seq} is not readable; verification `
              + 're-anchors on the next row rather than reporting a fork this device cannot prove',
      });
      prev = null;
      prevSeq = null;
      return { ok: false, findings, head: headOf(rows), chains: chainsOf(rows) };
    }
  }

  let ok = true;
  for (const row of rows) {
    const seq = parseSeq(row.seq);
    const declared = bytesOf(row.chain);
    if (seq === null || declared === null) {
      findings.push({ kind: CHAIN_FINDINGS.UNREADABLE, seq: row.seq, detail: 'the chain value is not base64url' });
      ok = false;
      prev = null;
      prevSeq = seq;
      continue;
    }
    // §3.3: `seq` is a per-space, GAPLESS, monotone counter. A hole is a withheld op or a purge.
    if (prevSeq !== null && seq !== prevSeq + 1n) {
      findings.push({
        kind: CHAIN_FINDINGS.GAP,
        seq: row.seq,
        from: String(prevSeq),
        detail: `seq jumped from ${prevSeq} to ${seq}; ADR 003 §3.3 makes the counter gapless per `
              + 'space, so the missing rows were withheld, or purged by a member removal (ADR 003 §6.3)',
        benignCause: 'member-purge',
      });
      ok = false;
      prev = null;                       // cannot recompute across a hole; re-anchor below
    }
    if (prev !== null || prevSeq === null) {
      const want = await chainAfter(prev, row.env.oid, ports);
      if (!sameBytes(want, declared)) {
        findings.push({
          kind: CHAIN_FINDINGS.MISMATCH,
          seq: row.seq,
          oid: row.env.oid,
          expected: b64u(want),
          served: row.chain,
          detail: 'the chain the relay served for this op is not SHA-256(previous ‖ opId). An op '
                + 'was withheld, the order was changed, or the row was fabricated (ADR 002 §5.4). '
                + 'A member removal purges op rows and produces the same symptom (ADR 003 §6.3).',
          benignCause: 'member-purge',
        });
        ok = false;
      }
    }
    prev = declared;                     // re-anchor on what was served, so the NEXT link is checked
    prevSeq = seq;
    chains.push(row.chain);
  }

  return { ok, findings, head: headOf(rows), chains };
}

function headOf(rows) {
  if (!rows || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return { seq: String(last.seq), chain: last.chain };
}

function chainsOf(rows) {
  return (rows || []).map((r) => r.chain).filter((c) => typeof c === 'string' && c !== '');
}

function sameBytes(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/**
 * The stateful witness one sync client keeps, one entry per space.
 *
 * It holds three things and nothing else: the verified head (`{seq, chain}`), a bounded memory of
 * chain values for the `wit` cross-check, and a `broken` flag so a permanent, benign break — the
 * member purge above — is reported once rather than every 45 seconds for ever.
 *
 * @param {{subtle?:SubtleCrypto, memory?:number}} [ports]
 */
export function createChainWitness(ports = {}) {
  const memory = Number.isInteger(ports.memory) && ports.memory > 0 ? ports.memory : WITNESS_MEMORY;
  /** @type {Map<string, {head:{seq,chain}|null, seen:Set<string>, order:string[], fromGenesis:boolean, broken:boolean}>} */
  const spaces = new Map();

  const slot = (space) => {
    let s = spaces.get(space);
    if (!s) {
      s = { head: null, seen: new Set(), order: [], reported: new Set(), fromGenesis: false, broken: false };
      spaces.set(space, s);
    }
    return s;
  };

  const remember = (s, chain) => {
    if (typeof chain !== 'string' || chain === '' || s.seen.has(chain)) return;
    s.seen.add(chain);
    s.order.push(chain);
    while (s.order.length > memory) s.seen.delete(s.order.shift());
  };

  return {
    /**
     * Re-establish state after a restart. The client persists the head next to the cursor
     * (`cursor.js`), because the two answer the same question — "where was I?" — and persisting
     * them apart is how they drift.
     *
     * `fromGenesis` says whether this device's chain knowledge is complete back to seq 1. Only a
     * device that pulled from `since = 0` in this process, or restored a head it had built that
     * way, can answer a `wit` cross-check with "I have never seen that". A device restored from a
     * cursor alone reports `unverifiableWitness` instead of accusing the relay of a fork it
     * cannot prove.
     *
     * **THE SECOND, LEGITIMATE CALLER: A MID-STREAM RE-ENTRY.** A client resuming at seq 40 with
     * no stored head must not verify from genesis — `SHA-256(∅ ‖ oid₄₀)` cannot match, and
     * reporting that as a fork accuses an honest relay on the first pull after an upgrade or a
     * failed anchor write. Such a client `restore()`s THE FIRST ROW OF THE PAGE, with
     * `fromGenesis: false`, and the links after it are checked. That is the same decision this
     * file already makes for an anchor it cannot decode ("re-anchor on the next row rather than
     * reporting a fork this device cannot prove"), one layer up, and it costs exactly the one row
     * this device has no evidence about. It is a re-entry point, not a claim: `false` is what
     * stops the restored head from being read as proof of anything.
     */
    restore(space, head, fromGenesis) {
      const s = slot(space);
      if (head && typeof head.chain === 'string' && head.chain !== '' && parseSeq(head.seq) !== null) {
        s.head = { seq: String(head.seq), chain: head.chain };
        remember(s, head.chain);
      }
      s.fromGenesis = fromGenesis === true;
    },

    /** `{seq, chain}` or null. */
    head(space) { return slot(space).head; },

    /**
     * The value to put in `Envelope.wit` on the next push for this space: the highest chain this
     * device has pulled. `''` before the first pull (ADR 002 §5.1 — "`''` on the first push").
     *
     * **This is what makes the fork detector work at all**, and it is one line. Every op this
     * device authors commits to what this device had seen; drop it, or send a constant, and a
     * relay serving two divergent logs is undetectable by anyone.
     */
    witness(space) {
      const h = slot(space).head;
      return h ? h.chain : '';
    },

    /** Has anything permanently broken verification for this space? */
    broken(space) { return slot(space).broken; },

    /**
     * Fold one pull page in. Returns the findings for THIS page — never throws, never refuses.
     *
     * @param {string} space
     * @param {Array<{seq:string, chain:string, env:{oid:string, wit:string, dv:string}}>} rows
     * @returns {Promise<Array>} findings
     */
    async observe(space, rows) {
      const s = slot(space);
      if (!Array.isArray(rows) || rows.length === 0) return [];

      // ROWS AT OR BELOW THE HEAD ARE ALREADY FOLDED. A client normally never re-pulls below its
      // cursor, but a rewound cursor, a crash mid-pull or a re-observation of one page must not
      // manufacture a break: verifying an old row against a `null` anchor would report a mismatch
      // that says nothing about the relay and everything about the caller.
      const fresh = s.head
        ? rows.filter((r) => cmpSeq(r.seq, s.head.seq) === 1)
        : rows.slice();
      if (fresh.length === 0) return [];

      const first = parseSeq(fresh[0].seq);
      // Pulling from genesis is what earns the right to call an unknown witness a fork.
      if (s.head === null && first === 1n) s.fromGenesis = true;

      const anchor = s.head && cmpSeq(s.head.seq, fresh[0].seq) === -1 ? s.head : null;
      const res = await verifyChain(fresh, anchor, ports);

      // DEDUPE BY THE BREAK ITSELF, NOT BY "HAS ANYTHING EVER BROKEN".
      //
      // The first draft of this suppressed every mismatch once `broken` was set, so that a member
      // purge — which breaks the chain permanently and benignly (ADR 003 §6.3) — did not raise an
      // alarm on every pull for the rest of the family's life. It also meant a REAL withheld op
      // after that purge was never reported again, which is the detector switching itself off.
      // `tests/tier1/sync-chain.test.js §5` is that mutant, kept as a test.
      //
      // A finding is identified by `(kind, seq, served)`. The same break re-observed is silent;
      // a break at a new row is reported, however many came before it.
      const out = [];
      for (const f of res.findings) {
        const key = `${f.kind}|${f.seq || ''}|${f.served || ''}|${f.from || ''}`;
        if (s.reported.has(key)) continue;
        s.reported.add(key);
        while (s.reported.size > memory) s.reported.delete(s.reported.values().next().value);
        out.push({ ...f, space });
      }
      if (!res.ok) {
        // Once broken, verification is "since the last anchor" rather than "from genesis", and a
        // witness this device cannot place is no longer evidence of anything.
        s.broken = true;
        s.fromGenesis = false;
      }
      for (const c of res.chains) remember(s, c);
      if (res.head) s.head = res.head;

      // The cross-check. A peer's `wit` is the chain IT had pulled; if this device's own chain is
      // complete and has never contained that value, the relay served the two devices different
      // logs. Ops this device authored are skipped: their `wit` is our own and proves nothing.
      for (const row of fresh) {
        const wit = row.env && row.env.wit;
        if (typeof wit !== 'string' || wit === '') continue;
        if (s.seen.has(wit)) continue;
        out.push({
          kind: s.fromGenesis ? CHAIN_FINDINGS.UNKNOWN_WITNESS : CHAIN_FINDINGS.UNVERIFIABLE_WITNESS,
          space,
          seq: String(row.seq),
          oid: row.env.oid,
          dv: row.env.dv,
          wit,
          detail: s.fromGenesis
            ? 'a peer authored this op committing to a chain value this device has never been '
              + 'served. The relay showed the two devices different logs (ADR 002 §5.4 fork).'
            : 'a peer committed to a chain value outside this device\'s own chain window. Not '
              + 'evidence: this device has not pulled from genesis in this session.',
        });
      }
      return out;
    },

    /** Everything, for the LZP-1003 self-audit. No key material, no ciphertext. */
    snapshot() {
      const out = {};
      for (const [space, s] of spaces) {
        out[space] = {
          head: s.head ? { ...s.head } : null,
          fromGenesis: s.fromGenesis,
          broken: s.broken,
          remembered: s.order.length,
        };
      }
      return out;
    },
  };
}

export { ZERO_SEQ };
