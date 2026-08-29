// src/js/sync/personal.js — LZP-502.  MY TWO MACS, MY WHOLE PRIVATE BOARD.
// Stories 19.4, 21.2, 19.1, 19.6 · ADR 003 §3, §8 · ADR 006 §9 · ADR 002 §5, §6 · ADR 001 §4, §7.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The personal space is the one milestone M1 demonstrates: the PO's desktop and laptop in daily
// sync of the WHOLE private board — including entries marked `privat` — end-to-end encrypted,
// with no family, no members, no invites and no governance anywhere in the path.
//
//   store.txn() ─▶ the log ─▶ store.outbox() ─▶ sealOp ─▶ POST /api/v1/ops
//                                                              │
//   store.applyRemote() ◀─ openOp ◀─ GET /api/v1/ops ◀──────────┘
//
// It owns four things and deliberately owns nothing else:
//
//   1. the OUTBOX — sealing the log's unacknowledged lines and pushing them (§8.1);
//   2. the INBOX — opening a pulled page and handing the plaintext to `store.applyRemote`;
//   3. the CURSOR — advanced only below the commit point (§3.3 and ADR 006 §9.1's W1);
//   4. the RETRACTION HAND-OFF — ADR 004 §3's publisher, which is the WP-3 obligation.
//
// It does NOT own the cadence table, the backoff ladder or the three-state indicator: those are
// ADR 003 §8.2/§8.3 and belong to LZP-504/505. `pushNow()`, `pullNow()` and `syncNow()` are the
// verbs such an engine drives, and `attach()` wires the one trigger that cannot live anywhere
// else — the debounced push after a transaction commits — because only this file knows how to
// seal and only the store knows when something changed.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// 21.2 — WHY NO FAMILY KEY CAN EVER APPLY HERE, AND WHY THIS FILE ADDS NO NEW RULE FOR IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// "My entire board, including private entries, syncs between MY devices only. No family key can
// ever apply." That property is already enforced twice underneath this file and it would be a
// mistake to re-derive it here:
//
//   · `KeyRing.get(space, epoch)` is keyed BY SPACE ID, and a `psp_…` id and an `fsp_…` id are
//     different keys of that map. A family key is not merely the wrong key for a personal
//     envelope — it is not reachable from a personal `sp` at all (ADR 002 §3 barrier 1: the two
//     scopes are DRAWN, not derived; possessing every family key reveals nothing about a
//     personal one because there is nothing to reveal).
//   · the AAD binds `sp`, so an envelope re-labelled from one space to the other fails its GCM
//     tag before a single plaintext byte exists (§5.1, barrier 3).
//
// So this file's contribution to 21.2 is negative work: it never widens the key lookup, never
// falls back to another epoch or another space on a decrypt failure, and refuses at construction
// if it is handed anything but a `psp_…` id. `assertPersonalSpace()` below is that refusal, and
// §21.2's test drives a family envelope at this door and asserts it never opens.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ADR 006 §9 — `board.json` IS THE TRUTH AND THE LOG IS HISTORY, ONCE A PEER EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §9 is the section written for this ticket, and it changes three things about a naive puller:
//
// **W1 — the cursor rides BELOW the commit point.** A peer op that `applyRemote` has folded but
// no `persistNow` has committed exists only in memory. It is not lost, because *the durable
// record of a peer's op is the SERVER, not the local log*, and the resume point is the cursor —
// so the cursor may never be ahead of `board.json`. `store.noteCursor()` is the only way to move
// one and it writes into the log, whose only route to disk is `_persistOps`, which runs strictly
// after `saveBoardText`. `advanceCursor()` below therefore folds, persists, and only then moves
// the cursor; a crash anywhere in that sequence re-fetches rather than skips, and the re-fetch is
// idempotent by `opId` (ADR 001 §6).
//
// **W2 — a quarantine is a RE-JOIN, not a silent convergence reset.** A device whose log was
// refused would otherwise rejoin at the bottom of the stamp order and lose every field contest
// and un-delete on its peers. `store` handles the stamps (ADR 006 §9.4's `'now'` re-derivation);
// what this file does is notice — `diagnostics().rejoin` — and let the outbox do the rest, which
// it does by construction: after a quarantine the log IS the spine, every line is unacknowledged,
// and so the whole personal projection is republished. That is W2, and it needs no special path.
//
// **GENESIS stamps are for upgrade day only.** Also the store's, and also visible from here: a
// re-join republishing at GENESIS would lose every contest it should win.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// F-6 — AN OP WHOSE ATTESTATION HAS NOT ARRIVED YET IS NOT DROPPED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// FINDINGS §3 item 4: "the ATTESTATION park reason, **or retain refused ops**. First contact
// loses data without it." `core/ops.js` has no `PARK_REASONS.ATTESTATION` (finding E3-3, and
// `core/ops.js` is not this ticket's file), so `oplog.park()` cannot be told the reason — which
// leaves the second half of the finding, and it is the better half anyway:
//
//   **the cursor is not advanced past an op this device could not yet apply.**
//
// That is not a workaround, it is §9.1 used for the thing §9.1 is about: the server is the
// durable record, so "retain it" and "do not tell the server I have consumed it" are the same
// statement, and the second one survives a quit while an in-memory park would not. Concretely:
//
//   · an envelope that parks on `attestation` or `epoch`, or an op the fold refuses with a reason
//     a later op can cure (`unattestedDevice`, `notMyDevice`), is DEFERRED;
//   · the cursor advances only to the last seq before the first deferred op, so the next pull
//     re-delivers it — in the same session it is retried from memory as well, which is what makes
//     a same-batch attestation work without a round trip;
//   · after `maxDeferrals` fruitless attempts it moves to QUARANTINE with a visible error and the
//     cursor is released past it. ADR 003 §8.2 is explicit that "a permanently rejected op must
//     never silently spin forever", and a cursor pinned for ever behind one op would block every
//     later op on the space — a worse failure than the one it was avoiding.
//
// A refusal nothing can cure (a bad shape, a foreign space, a `local`-space op) is TERMINAL and
// never holds the cursor: re-pulling it would produce the same answer for ever.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// PURITY (ADR 005 §2, `tests/helpers/purity.js` PURE_DIRS)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// This directory is DOM-free and I/O-free. There is no `fetch` here — the transport is a PORT,
// bound in production to `src/js/platform/net.js` (the only fetch in the product, story 21.5)
// and in tests directly to the real server handlers. There is no clock and no randomness either:
// `now` is injected, and every id and every iv is minted by `core/` or by `crypto/` from ports
// they were given. The store is injected too, so `src/js/store.js` — which is not in a pure
// directory — is never imported from here.

import { sealOp, openOp, ENVELOPE_PARK } from '../crypto/envelope.js';
import { spaceKindOf, isSpaceId } from '../crypto/spacekeys.js';

// ─────────────────────────────────────────────────────────────────────────────
// The protocol numbers, from `docs/v2/contracts/sync.contract.js` §0 (ADR 003 §4, §6.1, §8.2).
//
// They are RESTATED rather than imported: `docs/` is not shippable source, and the purity gate's
// one-way import rule (`tests/helpers/purity.js` ALLOWED_IMPORT_TARGETS) confines this directory
// to `src/js/sync`, `src/js/crypto` and `src/js/core`. `tests/tier1/sync-personal.test.js`
// asserts every value here against the contract file, so the copy cannot drift from the source
// of truth without a red test. **If LZP-501 lands a shared `src/js/sync/` constants module,
// these should move into it and this block should be deleted, not duplicated.**
// ─────────────────────────────────────────────────────────────────────────────

/** ADR 003 §6.1's caps. */
export const LIMITS = Object.freeze({
  opsPerPush: 200,
  bytesPerEnvelope: 64 * 1024,
  bytesPerRequest: 4 * 1024 * 1024,
  opsPerPull: 500,
});

/** ADR 003 §8.2's cadence. This file uses only `pushDebounceMs`; the rest is LZP-504's. */
export const CADENCE = Object.freeze({
  pushDebounceMs: 2000,
  pullVisibleMs: 45000,
  pullJitterMs: 15000,
  pullHiddenMs: 600000,
  backoffBaseMs: 2000,
  backoffMaxMs: 300000,
  pendingAfterMs: 20000,
  statusDebounceMs: 2000,
});

// ─────────────────────────────────────────────────────────────────────────────
// 0. Errors and the refusal taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export class PersonalSyncError extends Error {
  /** @param {string} message @param {string} [kind] */
  constructor(message, kind = 'config') {
    super(message);
    this.name = 'PersonalSyncError';
    this.kind = kind;
  }
}

/**
 * The park reasons a LATER op or a later key fetch can cure. An envelope parked for one of these
 * is deferred and re-tried; anything else is terminal.
 *
 * `ATTESTATION` — the peer's device attestation has not arrived yet. This is F-6's whole case.
 * `EPOCH`       — sealed under a key epoch this ring does not hold. ADR 002 §4.4: a member
 *                 offline across three rotations needs every epoch spanning the ops they have
 *                 not read, so the fix is a key fetch, not a re-pull — but holding the cursor is
 *                 still right, because the ops themselves must still be there when it lands.
 */
export const CURABLE_PARKS = Object.freeze([ENVELOPE_PARK.ATTESTATION, ENVELOPE_PARK.EPOCH]);

/**
 * The `foldAuthorized` rejection codes a later op can cure — i.e. the ones that are a statement
 * about WHAT HAS ARRIVED SO FAR rather than about the op itself.
 *
 * Both of them are the personal-space device gate (`core/authz.js` stage 0b). `notMyDevice` is
 * the M1 case exactly: my second Mac's op, arriving before this Mac has learned that the device
 * is mine. `unattestedDevice` is its family-space twin and is here for the same reason.
 * Everything else — `shape`, `notMyAct`, `writeOnce`, `notOwner`, … — is a property of the op
 * and re-pulling it a thousand times produces the same verdict.
 */
export const CURABLE_REFUSALS = Object.freeze(['notMyDevice', 'unattestedDevice']);

/** @param {string} reason @returns {boolean} */
export const isCurable = (reason) => CURABLE_PARKS.includes(reason) || CURABLE_REFUSALS.includes(reason);

/** How many pulls an op may be deferred before it is quarantined instead (ADR 003 §8.2). */
export const MAX_DEFERRALS = 5;

// ─────────────────────────────────────────────────────────────────────────────
// 1. The publication port — ADR 004 §3, and the WP-3 obligation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The publisher `store.setPublisher()` installs.
 *
 * **WHY THIS EXISTS AT ALL IN A TICKET WITH NO FAMILY IN IT.** `store.replaceAll()` — import
 * (11.3) and snapshot restore (11.5) — goes through `planReplaceAll`, never through the short
 * `replaceAllOps` entry point, precisely because only the PLAN carries `plan.retractions`: the
 * family-visible entries whose personal truth the replacement just tombstoned. Nothing in
 * `core/` runs after the transaction lands, so a `retractions` list dropped at this seam cannot
 * be recovered anywhere, and the consequence is story 16.5's: an imported board leaves entries
 * live on the other device.
 *
 * At M1 there is no family space, so there is nothing to send — and that is exactly the case in
 * which the list is most likely to be quietly thrown away. It is therefore RECORDED, reported
 * through `store.diagnostics().sync.pendingRetractions`, and handed on unchanged the day a
 * family space exists. `drain()` is the seam WP-6 takes it from.
 *
 * @param {{familySpaceId?:string|null, onRetract?:(keys:string[]) => void}} [opts]
 */
export function createPersonalPublisher(opts = {}) {
  const pending = [];
  const reshares = [];
  return {
    familySpaceId: opts.familySpaceId ?? null,
    pendingRetractions: pending,
    pendingReshares: reshares,
    retract(keys) {
      if (!keys || !keys.length) return;
      for (const k of keys) if (typeof k === 'string' && !pending.includes(k)) pending.push(k);
      if (typeof opts.onRetract === 'function') opts.onRetract(pending.slice());
    },
    askToReshare(list) {
      // NOTHING is re-shared without the user saying so (ADR 004 §3, story 16.5). This records a
      // question to ask, never an action to take.
      if (!list || !list.length) return;
      for (const e of list) reshares.push(e);
    },
    derivePublication() { return []; },
    enqueue() {},
    /** Take the recorded list, leaving the publisher empty. @returns {string[]} */
    drain() { return pending.splice(0, pending.length); },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Small helpers — all total, none of them reaching for a global
// ─────────────────────────────────────────────────────────────────────────────

/** ADR 003 §3.3: seqs are decimal strings on the wire and BigInt-comparable, never Numbers. */
function toSeq(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]{1,19}$/.test(v)) return BigInt(v);
  return null;
}

/**
 * The one refusal 21.2 turns on. A `psp_…` id is required and an `fsp_…` id is a THROW, not a
 * fallback: a personal sync engine pointed at a family space would push the user's private board
 * into the family stream, which is the single worst thing this product could do.
 */
function assertPersonalSpace(spaceId) {
  // `isSpaceId` first: `spaceKindOf` THROWS on anything it cannot classify (deliberately — both
  // branches of a wrong guess are catastrophic), and this refusal wants to name the caller.
  if (!isSpaceId(spaceId) || spaceKindOf(spaceId) !== 'personal') {
    throw new PersonalSyncError(
      `personal sync: spaceId must be a psp_… id; got ${JSON.stringify(spaceId)}. A family space `
      + 'is not a fallback here (story 21.2).');
  }
  return spaceId;
}

/** @returns {{status:number, headers:Object, json:any}} normalised, never throwing on shape. */
function normalizeResponse(res) {
  const status = res && Number.isInteger(res.status) ? res.status : 0;
  const headers = res && res.headers && typeof res.headers === 'object' ? res.headers : {};
  const json = res && 'json' in (res || {}) ? res.json : (res ? res.body : null);
  return { status, headers, json };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PersonalSyncDeps
 * @property {Object} store            the live `store` — injected, never imported (purity)
 * @property {{request:(m:string,p:string,q:Object,b:any,h:Object)=>Promise<Object>}} transport
 * @property {Object} keyring          `createKeyRing()` — holds the PSK for THIS space only
 * @property {CryptoKey} sigPriv       this device's non-extractable `IK_sig` private key
 * @property {string} spaceId          `psp_…`
 * @property {string} deviceShort      mine; must equal `store`'s, and it is checked
 * @property {(dv:string) => (Object|null)} attestationOf
 *           `openOp`'s P1 — the partial function from a device short to its verified attestation.
 *           A PORT, and it must be: see §5 of this file's notes for where M1's answer comes from.
 * @property {Object} [attestation]    MY own attestation, so `sealOp` can mirror the far-side gate
 * @property {() => number} now        injected clock — nothing here reads one
 * @property {(ms:number, fn:Function) => any} [schedule]    injected; no setTimeout in sync/
 * @property {(h:any) => void} [unschedule]
 * @property {() => boolean} [isOnline]
 * @property {(s:Object) => void} [onStatus]
 * @property {SubtleCrypto} [subtle] @property {(n:number)=>Uint8Array} [random]
 * @property {number} [maxDeferrals]
 * @property {number} [pushDebounceMs]
 */

/**
 * @param {PersonalSyncDeps} deps
 */
export function createPersonalSync(deps) {
  const d = deps || {};
  const store = d.store;
  const transport = d.transport;
  const spaceId = assertPersonalSpace(d.spaceId);

  if (!store || typeof store.outbox !== 'function' || typeof store.applyRemote !== 'function') {
    throw new PersonalSyncError('personal sync: `store` must be the LZP store (outbox/applyRemote/noteCursor)');
  }
  if (!transport || typeof transport.request !== 'function') {
    throw new PersonalSyncError('personal sync: `transport` must implement request(method, path, query, body, headers)');
  }
  if (typeof d.now !== 'function') {
    throw new PersonalSyncError('personal sync: `now` is an injected port — src/js/sync/ reads no clock');
  }
  if (typeof d.attestationOf !== 'function') {
    // FAIL CLOSED. `openOp` refuses a missing `attestationOf` too, but by then the caller has
    // already built a keyring and a transport and believes it is syncing.
    throw new PersonalSyncError(
      'personal sync: `attestationOf` is required — it is openOp\'s P1 and the ONLY source of the '
      + 'verification key (ADR 002 §5.2.1). Without it every peer envelope parks, permanently.');
  }
  if (store.personalSpaceId && store.personalSpaceId() !== spaceId) {
    throw new PersonalSyncError(
      `personal sync: the store writes into ${JSON.stringify(store.personalSpaceId())} but this engine `
      + `was pointed at ${JSON.stringify(spaceId)}. Call store.usePersonalSpace() before init().`);
  }
  if (d.deviceShort && store._short && d.deviceShort !== store._short) {
    // ADR 002 §5.2.2 check 4: `devOf(op.ts) === env.dv`. If these two disagree, EVERY envelope
    // this device seals is one no peer will ever open — and the failure is remote and silent.
    throw new PersonalSyncError(
      `personal sync: deviceShort ${JSON.stringify(d.deviceShort)} is not the short this store stamps `
      + `with (${JSON.stringify(store._short)}). Every envelope would fail §5.2.2 check 4 on the peer.`);
  }

  const deviceShort = d.deviceShort ?? store._short;
  const maxDeferrals = Number.isSafeInteger(d.maxDeferrals) && d.maxDeferrals > 0 ? d.maxDeferrals : MAX_DEFERRALS;
  const pushDebounceMs = Number.isSafeInteger(d.pushDebounceMs) && d.pushDebounceMs >= 0
    ? d.pushDebounceMs : CADENCE.pushDebounceMs;
  const ports = { subtle: d.subtle, random: d.random };
  const isOnline = typeof d.isOnline === 'function' ? d.isOnline : () => true;

  /**
   * SEALED ENVELOPES, CACHED BY opId — and this cache is a CORRECTNESS requirement, not a
   * performance one.
   *
   * `server/core/handlers/ops.js` compares the STORED bytes on a re-push and answers
   * `409 forked_op_id` when they differ. A fresh `iv` and a non-deterministic ECDSA signature
   * mean a RE-SEAL of the same op differs in bytes every time, so ADR 003 §8.1's "the outbox
   * holds SEALED envelopes" is load-bearing rather than descriptive: a client that re-seals on
   * retry sees a 409 on every retry.
   *
   * ⚠ **AN ADR CONTRADICTION, RESOLVED HERE AND ESCALATED — do not "simplify" this away.**
   * ADR 003 §8.1 says the outbox IS "`ops.jsonl` lines whose seq is unset, i.e. sealed envelopes
   * not yet acknowledged". ADR 006 §9.2 and `store.js:_uncommittedTailLines` say `ops.jsonl`
   * holds PLAINTEXT op lines — and they are right to, because the log is what `board.json` is
   * reconciled against and a checkpoint of ciphertext would fold nothing. So the two documents
   * disagree about what the outbox is made of, and the disagreement is only visible at the one
   * moment it matters: **a relaunch with a non-empty outbox.** Without somewhere to keep the
   * sealed bytes, the ops are re-derived from the log, re-sealed with a fresh iv, and refused
   * `409 forked_op_id` — permanently, for every op queued when the app was last quit, which is
   * the ordinary case for a laptop closed on a train (19.1).
   *
   * `envelopeStore` is the seam that closes it: an injected `{load(spaceId), save(spaceId, envs)}`
   * port, because `src/js/sync/` is I/O-free (ADR 005 §2) and `src/js/storage.js` belongs to
   * another owner. Absent, the cache is per-session and the 409 path below is what stands between
   * the user and a wedged outbox. **Reported to WP-3: `storage.js` needs one slot for this, and
   * ADR 003 §8.1 needs one sentence saying which file the envelopes live in.**
   * @type {Map<string, Object>}
   */
  const sealed = new Map();
  let sealedLoaded = false;

  async function loadSealed() {
    if (sealedLoaded) return;
    sealedLoaded = true;
    if (!d.envelopeStore || typeof d.envelopeStore.load !== 'function') return;
    try {
      const rows = await d.envelopeStore.load(spaceId);
      for (const env of rows || []) if (env && typeof env.oid === 'string') sealed.set(env.oid, env);
    } catch (e) {
      // A cache that cannot be read costs a re-seal, never a lost op. It is a warning, not a stop.
      if (typeof store._warn === 'function') store._warn(`sync: the sealed outbox could not be read (${e.message})`);
    }
  }

  /** The cache holds exactly what the outbox still owes. See the call site for why. */
  function pruneSealed() {
    const live = new Set(store.outbox().map((l) => l.op.id));
    for (const oid of [...sealed.keys()]) if (!live.has(oid)) sealed.delete(oid);
  }

  async function saveSealed() {
    if (!d.envelopeStore || typeof d.envelopeStore.save !== 'function') return;
    try { await d.envelopeStore.save(spaceId, [...sealed.values()]); }
    catch { /* the same trade as above, in the other direction */ }
  }

  /** Ops pulled but not yet applicable — F-6. @type {Map<string, {env:Object, seq:bigint, tries:number, why:string}>} */
  const deferred = new Map();
  /** Terminally refused, with a visible error (ADR 003 §8.2). @type {Map<string, {seq:string, reason:string}>} */
  const quarantined = new Map();

  const stats = {
    pushes: 0, pulls: 0, opsPushed: 0, opsApplied: 0, opsDeferred: 0, opsQuarantined: 0,
    lastPullAt: null, lastPushAt: null, consecutiveFailures: 0, lastError: null,
    rejoin: false, protocol: null,
  };

  let attached = false;
  let unsubscribe = null;
  let pushTimer = null;
  let running = null;

  // ── sealing ────────────────────────────────────────────────────────────────

  /**
   * Seal one outbox line. The header is AUTHENTICATED, not derived — `sealOp` checks every field
   * against the op rather than rewriting either, so a disagreement is a local throw instead of a
   * remote, permanent, silent failure to open.
   *
   * `wit: ''` is the honest value: ADR 002 §5.4's chain witness is computed by the RELAY and is
   * diagnostic-only, and §5.1 allows `''`. Inventing one here would put a value in the AAD that
   * nothing can check.
   */
  async function sealLine(op) {
    const cached = sealed.get(op.id);
    if (cached) return cached;
    const epoch = typeof d.keyring?.currentEpoch === 'function' ? d.keyring.currentEpoch(spaceId) : 0;
    if (!epoch) {
      throw new PersonalSyncError(
        `personal sync: the key ring holds no key for ${spaceId}. Nothing is pushed unencrypted, ever.`,
        'key');
    }
    const env = await sealOp(op, d.keyring, d.sigPriv, {
      v: 1, sp: spaceId, ep: epoch, dv: deviceShort, oid: op.id, wit: '',
    }, { ...ports, ...(d.attestation ? { attestation: d.attestation } : {}) });
    sealed.set(op.id, env);
    return env;
  }

  // ── push ───────────────────────────────────────────────────────────────────

  /**
   * Drain the outbox in `LIMITS.opsPerPush` batches (§3.1, §6.1).
   *
   * `accepted` and `duplicate` are treated IDENTICALLY — both mean "the server has it" — which is
   * what makes at-least-once delivery sufficient and exactly-once unnecessary (§3.1). Everything
   * either list names is handed to `store.ackPushed`, which records the seq in the log, which
   * rides in `checkpoint().seqs`, which is what stops the op being offered again after a
   * relaunch.
   *
   * @returns {Promise<{pushed:number, batches:number}>}
   */
  async function pushNow() {
    if (store.personalSpaceId && store.personalSpaceId() === null) return { pushed: 0, batches: 0 };
    // FINDING E5-3 — the lower verb answers the same way the higher one does.
    //
    // `syncNow()` consults `isOnline()` first and returns `{skipped:'offline'}` (ADR 003 §8.2:
    // "offline → stop scheduling and queue in ops.jsonl"). `pushNow()` did not, so a caller that
    // reached for the lower verb — the debounce timer at `bump()`, `flush()` on pagehide, or a
    // test — got a REJECTED PROMISE where the higher one got a value, and the rejection was a
    // `NetError('transport')` raised from inside the transport rather than a decision this layer
    // made. Two verbs, two answers to one question, and the one that fires on every quit was the
    // one that threw. The queue is intact either way; what differs is whether the caller has to
    // know that.
    if (!isOnline()) { emitStatus(); return { pushed: 0, batches: 0, skipped: 'offline' }; }
    await loadSealed();
    let pushed = 0;
    let batches = 0;
    for (;;) {
      const lines = store.outbox({ limit: LIMITS.opsPerPush });
      if (!lines.length) break;

      const envelopes = [];
      const oids = [];
      for (const line of lines) {
        // A quarantined op stays in the LOG and on the BOARD — nothing is ever deleted for a
        // transport failure (principle 6) — but it is never offered again. Without this the
        // outbox, which is derived from the log and so cannot "remove" anything, would re-offer a
        // permanently refused op on every push for the life of the install.
        if (quarantined.has(line.op.id)) continue;
        let env;
        try {
          env = await sealLine(line.op);
        } catch (e) {
          // An op THIS BUILD would refuse to seal is one no peer could ever open. It is
          // quarantined rather than retried for ever — and it stays in the log and on screen,
          // because a board entry is never deleted for a transport failure (principle 6).
          quarantined.set(line.op.id, { seq: null, reason: `seal: ${e.message}` });
          stats.opsQuarantined += 1;
          if (typeof store._warn === 'function') {
            store._warn(`sync: an op could not be sealed and will not be uploaded (${e.message}). `
              + 'It is still on your board and still in board.json.');
          }
          continue;
        }
        envelopes.push(env);
        oids.push(line.op.id);
      }
      if (!envelopes.length) break;
      // Durable BEFORE the push, never after: an envelope that reached the relay and whose bytes
      // this device then forgot is exactly the 409 above.
      await saveSealed();

      const res = normalizeResponse(await transport.request('POST', '/api/v1/ops', {}, {
        space: spaceId,
        ackSeq: store.cursor(spaceId),
        ops: envelopes,
        // ADR 001 §7.3 condition 3 / server E2-202-E: "the outbox was empty at this moment" is a
        // claim only the client can make, and getting it wrong resurrects deleted entries. It is
        // therefore made only when this batch is the last one.
        drained: envelopes.length < LIMITS.opsPerPush,
      }, {}));

      noteProtocol(res);
      if (res.status !== 200) {
        stats.consecutiveFailures += 1;
        stats.lastError = errorOf(res);
        if (res.status === 409) {
          // `forked_op_id` — the relay already holds DIFFERENT BYTES under one of these ids.
          //
          // ADR 003 §3.1 tells the client to treat this as local corruption and re-mint with a
          // fresh opId. This engine cannot re-mint: the op is in the log, `core/ops.js` owns op
          // identity, and an op's id is inside the ciphertext its peers have already read. So the
          // damage is BOUNDED instead: only the named `oid` is quarantined (the response carries
          // it), the rest of the batch is retried on the next push, and the user is told in a
          // sentence that is true — the board is unchanged and the entry is still there.
          //
          // The one benign cause of this is a re-seal after a relaunch (see `sealed` above), and
          // it is why `envelopeStore` exists. If this ever fires in the field WITH an
          // `envelopeStore` wired, it is the malicious case ADR 003 §3.1 is about.
          const forked = res.json && typeof res.json.oid === 'string' ? [res.json.oid] : oids;
          for (const id of forked) quarantined.set(id, { seq: null, reason: 'forked_op_id' });
          stats.opsQuarantined += forked.length;
          if (typeof store._warn === 'function') {
            store._warn('sync: the relay already holds a different change under one of these ids '
              + '(forked_op_id). Nothing was uploaded and your board is unchanged.');
          }
        }
        emitStatus();
        return { pushed, batches };
      }

      const body = res.json || {};
      const acks = [...(body.accepted || []), ...(body.duplicate || [])]
        .filter((a) => a && typeof a.oid === 'string' && toSeq(a.seq) !== null);
      store.ackPushed(acks);
      // THE CACHE IS PRUNED AGAINST THE OUTBOX, NOT AGAINST THE ACK LIST — and the difference is
      // a real failure mode. ADR 003 §8.1: "an entry is removed only after the server reports it
      // in `accepted` OR `duplicate`". Deleting on the ack LIST assumes the store took the ack;
      // if it did not (a full disk, a refused seq, a crash between the two), the op stays in the
      // outbox with its seal thrown away, and the very next push re-seals it into a 409. Deriving
      // the cache from the outbox makes it self-healing: it holds exactly what is still owed.
      pruneSealed();
      await saveSealed();
      pushed += acks.length;
      batches += 1;
      stats.opsPushed += acks.length;
      stats.consecutiveFailures = 0;
      stats.lastError = null;
      stats.lastPushAt = d.now();

      // No progress means the server accepted nothing this device can retire. Stopping is the
      // only safe answer: looping would be an infinite push of the same batch.
      if (!acks.length) break;
      if (envelopes.length < LIMITS.opsPerPush) break;
    }
    stats.pushes += batches;
    emitStatus();
    return { pushed, batches };
  }

  // ── pull ───────────────────────────────────────────────────────────────────

  /**
   * One pull pass: fetch from the cursor, open, fold, persist, then advance.
   *
   * THE ORDER IS THE INVARIANT (ADR 003 §3.3 + ADR 006 §9.1 W1) and it is:
   *
   *    open ──▶ store.applyRemote ──▶ await store.persistNow() ──▶ store.noteCursor
   *
   * A crash before `persistNow` loses the fold and the cursor together — the ops are re-pulled.
   * A crash between `saveBoardText` and the checkpoint inside `persistNow` keeps the CONTENT
   * (board.json is the commit point) and loses the cursor — the ops are re-pulled and are
   * idempotent by `opId`. There is no ordering of these three that loses an op, and there is
   * exactly one that never leaves the cursor ahead of the board. This is it.
   *
   * @returns {Promise<{applied:number, deferred:number, cursor:string, hasMore:boolean}>}
   */
  async function pullNow() {
    const since = store.cursor(spaceId);
    const res = normalizeResponse(await transport.request('GET', '/api/v1/ops', {
      space: spaceId, since, limit: String(LIMITS.opsPerPull),
    }, null, {}));
    noteProtocol(res);
    if (res.status !== 200) {
      stats.consecutiveFailures += 1;
      stats.lastError = errorOf(res);
      emitStatus();
      return { applied: 0, deferred: deferred.size, cursor: since, hasMore: false };
    }
    stats.consecutiveFailures = 0;
    stats.lastError = null;
    stats.pulls += 1;
    stats.lastPullAt = d.now();

    const body = res.json || {};
    const page = Array.isArray(body.ops) ? body.ops : [];

    // ── the re-try set comes FIRST, and in seq order ─────────────────────────
    // A deferred envelope and a fresh one are the same kind of thing; merging them here means the
    // F-6 case where the attestation arrives in a LATER page is handled by exactly the code that
    // handles the same-batch case, rather than by a second path nobody exercises.
    /** @type {Array<{env:Object, seq:bigint, retry:boolean}>} */
    const work = [];
    for (const [, held] of deferred) work.push({ env: held.env, seq: held.seq, retry: true });
    for (const e of page) {
      const seq = toSeq(e && e.seq);
      if (seq === null) continue;                      // a row the relay could not frame; never silent
      if (deferred.has(e.oid) || quarantined.has(e.oid)) continue;
      work.push({ env: e, seq, retry: false });
    }
    work.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

    const opened = [];
    const seqs = Object.create(null);
    /** seq → why it is held. The cursor stops BELOW the smallest of these. */
    const holds = new Map();

    for (const item of work) {
      let out;
      try {
        out = await openOp(item.env, d.keyring, d.attestationOf, ports);
      } catch (e) {
        // A protocol violation — P2, P3, a failed AEAD, a non-canonical plaintext. `openOp`
        // throws only on those, and every one of them is FINAL: the bytes are what they are, and
        // re-pulling them cannot change the answer. Quarantine, report, and let the cursor past.
        terminal(item, `envelope: ${e.message}`);
        continue;
      }
      if (out && out.parked) {
        if (CURABLE_PARKS.includes(out.reason)) defer(item, out.reason);
        else terminal(item, `parked: ${out.reason}`);
        continue;
      }
      const op = out && out.op ? out.op : out;
      if (!op || typeof op !== 'object' || typeof op.id !== 'string') {
        terminal(item, 'openOp returned no op');
        continue;
      }
      opened.push({ op, item });
      seqs[op.id] = String(item.seq);
    }

    let applied = [];
    if (opened.length) {
      const r = store.applyRemote(opened.map((o) => o.op), { seqs });
      applied = Array.isArray(r?.applied) ? r.applied : [];
      const byId = new Map(opened.map((o) => [o.op.id, o.item]));
      for (const ref of (r?.refused || [])) {
        const item = byId.get(ref.id);
        if (!item) continue;
        if (isCurable(ref.reason)) defer(item, ref.reason);
        else terminal(item, `refused: ${ref.reason}`);
      }
      // Anything that WAS applied leaves the deferral set — including one that had been held for
      // several pulls, which is the F-6 cure landing.
      for (const id of applied) deferred.delete(id);
      stats.opsApplied += applied.length;
    }

    // ── W1: persist BEFORE the cursor moves ──────────────────────────────────
    if (applied.length) await store.persistNow();

    // ── the commit point: the last seq with nothing held at or below it ───────
    let commit = toSeq(since) ?? 0n;
    const floor = holds.size ? [...holds.keys()].reduce((a, b) => (a < b ? a : b)) : null;
    for (const item of work) {
      if (floor !== null && item.seq >= floor) break;
      if (item.seq > commit) commit = item.seq;
    }
    const nextCursor = toSeq(body.nextCursor);
    if (floor === null && nextCursor !== null && nextCursor > commit) commit = nextCursor;
    if (commit > (toSeq(since) ?? 0n)) store.noteCursor(spaceId, String(commit));

    emitStatus();
    return {
      applied: applied.length,
      deferred: deferred.size,
      cursor: store.cursor(spaceId),
      hasMore: body.hasMore === true,
    };

    function defer(item, why) {
      const oid = item.env.oid;
      const prev = deferred.get(oid);
      const tries = (prev ? prev.tries : 0) + 1;
      if (tries > maxDeferrals) {
        deferred.delete(oid);
        terminal(item, `still ${why} after ${maxDeferrals} attempts`);
        return;
      }
      deferred.set(oid, { env: item.env, seq: item.seq, tries, why });
      holds.set(item.seq, why);
      if (!prev) stats.opsDeferred += 1;
    }

    function terminal(item, reason) {
      const oid = item.env && item.env.oid;
      if (typeof oid === 'string') {
        deferred.delete(oid);
        quarantined.set(oid, { seq: String(item.seq), reason });
      }
      stats.opsQuarantined += 1;
      if (typeof store._warn === 'function') {
        store._warn(`sync: one change from your other Mac could not be applied (${reason}). `
          + 'It is not lost on the device that made it; nothing here was changed.');
      }
    }
  }

  /** Pull, then push — the order ADR 003 §8.2 gives for coming back online. */
  async function syncNow() {
    if (running) return running;
    running = (async () => {
      if (!isOnline()) { emitStatus(); return { skipped: 'offline' }; }
      let guard = 0;
      let more = true;
      while (more && guard < 64) {
        guard += 1;
        // eslint-disable-next-line no-await-in-loop
        const r = await pullNow();
        more = r.hasMore;
      }
      await pushNow();
      return { ok: true };
    })().finally(() => { running = null; });
    return running;
  }

  // ── status ─────────────────────────────────────────────────────────────────

  function errorOf(res) {
    const code = res.json && typeof res.json.error === 'string' ? res.json.error : null;
    return { status: res.status, error: code };
  }

  /** ADR 003 §4 — every response carries the window, so a client learns about a gate early. */
  function noteProtocol(res) {
    const h = res.headers || {};
    const min = h['x-lzp-min-protocol'] ?? h['X-LZP-Min-Protocol'];
    const max = h['x-lzp-protocol'] ?? h['X-LZP-Protocol'];
    if (min !== undefined || max !== undefined) stats.protocol = { min: Number(min), max: Number(max) };
  }

  /**
   * ADR 003 §8.3's three states. `healthy` is NOTHING AT ALL in the UI — F11's "silence is the
   * design" extends to the network — so this returns the state and never a message for it.
   */
  function status() {
    const pending = store.outboxSize ? store.outboxSize() : 0;
    let state = 'healthy';
    let errorKind = null;
    if (quarantined.size) { state = 'error'; errorKind = 'quarantine'; }
    else if (stats.consecutiveFailures >= 5) { state = 'error'; errorKind = 'offline'; }
    else if (stats.lastError && [401, 403].includes(stats.lastError.status)) { state = 'error'; errorKind = 'auth'; }
    else if (stats.lastError && stats.lastError.status === 426) { state = 'error'; errorKind = 'protocol'; }
    else if (pending > 0 || !isOnline() || stats.consecutiveFailures > 0) state = 'pending';
    return {
      state,
      pendingOps: pending,
      deferredOps: deferred.size,
      consecutiveFailures: stats.consecutiveFailures,
      lastPullAt: stats.lastPullAt,
      errorKind,
      detail: null,
    };
  }

  function emitStatus() {
    if (typeof d.onStatus === 'function') d.onStatus(status());
  }

  // ── attach ─────────────────────────────────────────────────────────────────

  /**
   * The one trigger that belongs to this file: a committed transaction schedules a push.
   *
   * `store.subscribe` fires SYNCHRONOUSLY inside `_commit`, right after `emit()`. The seal must
   * not happen there — ADR 001 §0.9 and `store.js` header note 2: `txn → apply → project → emit`
   * is strictly synchronous because `interact.js:317` asks the DOM for the new bar's label
   * element the instant the call returns, and an `await` above `emit()` silently breaks bar-label
   * editing. So the listener does nothing but arm a timer, through the injected `schedule`.
   *
   * `'remote'` and `'init'` are deliberately not triggers: the first is this engine's own fold
   * coming back round, and the second is a launch, where the caller decides when to start.
   */
  function attach() {
    if (attached) return () => {};
    attached = true;
    unsubscribe = store.subscribe((_state, reason) => {
      if (reason === 'remote' || reason === 'init' || reason === 'settings') return;
      schedulePush();
    });
    stats.rejoin = !!(store.diagnostics && store.diagnostics().sync?.rejoin);
    emitStatus();
    return detach;
  }

  function schedulePush() {
    if (typeof d.schedule !== 'function') return;
    if (pushTimer !== null && typeof d.unschedule === 'function') d.unschedule(pushTimer);
    pushTimer = d.schedule(pushDebounceMs, () => { pushTimer = null; pushNow().catch(() => {}); });
  }

  function detach() {
    if (!attached) return;
    attached = false;
    if (unsubscribe) unsubscribe();
    unsubscribe = null;
    if (pushTimer !== null && typeof d.unschedule === 'function') d.unschedule(pushTimer);
    pushTimer = null;
  }

  /**
   * FORCE-FLUSH (ADR 003 §8.2's `pagehide` row). It cannot be synchronous — sealing is
   * WebCrypto — so what it guarantees is that the BOARD is on disk, which is the commit point
   * (ADR 006 R5) and the thing that must not be lost. The envelopes are re-derived from the log
   * on the next launch, because the outbox is a projection of the log and the log is persisted
   * below the board.
   */
  async function flush() {
    if (typeof store.flushSync === 'function') store.flushSync();
    return pushNow();
  }

  return {
    spaceId,
    attach,
    detach,
    pushNow,
    pullNow,
    syncNow,
    flush,
    status,
    /** The ops this engine is holding, and why. F-6's visible half. */
    deferredOps: () => [...deferred.entries()].map(([oid, v]) => ({ oid, seq: String(v.seq), tries: v.tries, why: v.why })),
    quarantined: () => [...quarantined.entries()].map(([oid, v]) => ({ oid, ...v })),
    diagnostics: () => ({
      spaceId,
      deviceShort,
      cursor: store.cursor(spaceId),
      outbox: store.outboxSize ? store.outboxSize() : 0,
      sealedCached: sealed.size,
      deferred: deferred.size,
      quarantined: quarantined.size,
      rejoin: stats.rejoin,
      protocol: stats.protocol,
      ...stats,
    }),
  };
}
