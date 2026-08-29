// src/js/sync/client.js — the push/pull loop.  LZP-501 · stories 19.1, 19.2, 19.3, 19.6.
// ADR 003 §3, §8 · ADR 006 §9.1 · sync.contract.js §4.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CADENCE IS ARCHITECTURE, NOT TASTE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Vercel functions hold no persistent connections (addendum §3), so there is no socket to push
// down and there never will be one at this scale. What falls out is not a compromise, it is the
// shape of the product:
//
//   my changes  → pushed within seconds of the transaction that made them
//   your changes → arrive on a pull: on focus, on becoming visible, on coming online, and every
//                  45 s ± 15 s while the window is open
//
// Three consequences are acceptance criteria and not preferences:
//
//   · **THERE IS NO SYNC BUTTON AND NO MANUAL REFRESH ANYWHERE** (19.2). This module exports no
//     function whose name a menu item could bind to; `pushNow`/`pullNow` exist for the scheduler
//     and for tests, and the UI package is told, here, not to wire them to a control.
//   · **NEVER A SPINNER ON THE BOARD** (ADR 003 §8.3). The only status surface is one small,
//     still glyph in the toolbar, and `healthy` renders NOTHING AT ALL — F11's "silence is the
//     design" extends to the network.
//   · **NO UX COPY MAY PROMISE "LIVE"** (addendum §3, ADR 003 §10.3). Latency is at the mercy of
//     a serverless cold start. The German strings in §7 below are written to that rule.
//
// Jitter is re-randomised EVERY TICK, per device (Risk R3): eight family members woken by one
// shared trigger must not arrive at a Hobby-tier function together, and a jitter drawn once at
// start-up is a herd with a phase shift rather than a decorrelated fleet.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE OWNS, AND WHAT IT REFUSES TO OWN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// It owns: when to talk, what to send, what a reply means, and the order in which a pulled batch
// becomes durable. Everything else is a PORT — the transport (ADR 003 §8: bound to the real
// handlers in tests, so the fleet suite exercises the real client against the real server with no
// sockets), the clock, the scheduler, randomness, onlineness, the seal/open pair, the store.
//
// It refuses to own: the DOM (`tests/tier1/core-purity.test.js` scans this directory), any
// network primitive (`tests/tier1/network-scope.test.js` scans it again), the undo stacks
// (`onOps` goes to `store.applyRemote`, which NEVER touches undo/redo — rule U8), and re-minting
// a forked `opId`, which needs the plaintext and the clock and therefore belongs to `store.js`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ORDER THAT MAKES A CRASH SAFE (ADR 003 §3.3, ADR 006 §9.1 W1)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//     pull page ──► verify chain ──► open each envelope ──► fold (onOps) ──► PERSIST ──► cursor
//
// The cursor is the last thing that moves and it moves through `cursors.advance(…, commit)`,
// which runs the commit itself — there is no spelling of "advance the cursor" in this file that
// skips the fold and the persist. A crash anywhere before the last arrow re-pulls the page, and
// re-applying it is free (ADR 001 §6). A crash after it has nothing left to lose.
//
// The mirror on the way out: an envelope is durable in the outbox BEFORE it is ever pushed, and
// leaves only when the relay reports it in `accepted` or `duplicate` (ADR 003 §3.1).

import {
  PATHS, LIMITS, CADENCE, PROTOCOL,
  parseSeq, cmpSeq, ZERO_SEQ,
  readPullBody, readPushBody, interpret, checkProtocol, readProtocolHeaders,
  backoffMs, pullDelayMs, classify, pushBody, pullQuery,
  CLOCK_SKEW_LIMIT_MS,
} from './protocol.js';
import { createChainWitness } from './chain.js';
import { createOutbox, createParkingLot } from './outbox.js';
import { createCursors } from './cursor.js';

/** How many pages one pull cycle will walk before yielding to the scheduler (story 19.6). */
export const MAX_PAGES_PER_CYCLE = 200;
/** How many push batches one push cycle will send before yielding. */
export const MAX_BATCHES_PER_CYCLE = 50;
/** How many times a parked envelope is replayed before it stops being replayed every pull. */
export const PARK_REPLAY_TRIES = 64;

/**
 * Push errors that are about ONE ENVELOPE and not about this device's standing.
 *
 * ⚠ AN ADR AMBIGUITY, RESOLVED, AND IT MATTERS. ADR 003 §8.2 says "401/403/426 do not back off —
 * they stop the loop and set the status", which is right for the auth ladder: retrying against a
 * revoked device or a removed member is hammering a wall. But ADR 003 §3.1 gives `device_mismatch`
 * the status **403** as a *body* validation error — `e.dv !== auth.deviceShort` — and
 * `space_mismatch`/`future_epoch` the status 400. Treating a malformed envelope as "this device is
 * no longer allowed to sync" would silence a family's whole board for ever over one bad row.
 *
 * So the rule implemented is: **401/403 stop the loop UNLESS the body names one of these codes**,
 * in which case the item is dealt with and the loop continues. `bad_signature`, `device_revoked`,
 * `not_a_member`, `stale_request` and `replay` keep §8.2's behaviour exactly.
 */
const ITEM_LEVEL_PUSH_CODES = Object.freeze(['device_mismatch', 'space_mismatch', 'forked_op_id']);

/**
 * `future_epoch` is NOT terminal for the item.
 *
 * It means this device sealed under an epoch the relay has not been told about yet — which is
 * exactly the window ADR 002 §4.2's rotation opens: the epoch is claimed on the relay by a
 * separate request, and a push that overtakes it is early, not wrong. Quarantining would throw
 * away a real edit for losing a race with our own rotation. It backs off instead, and after
 * `FUTURE_EPOCH_PATIENCE` cycles it is quarantined so it cannot spin for ever (§8.2's last rule).
 */
const FUTURE_EPOCH_PATIENCE = 20;

const GERMAN = Object.freeze({
  pending: 'Änderungen werden übertragen, sobald du online bist.',
  offline: 'Dieser Mac ist gerade offline. Alles, was du änderst, wird gespeichert und später übertragen.',
  auth: 'Dieser Mac darf nicht mehr mit dem Familienkreis synchronisieren. Öffne Einstellungen → Familie.',
  protocol: 'Diese Version des Kalenders ist zu alt für den Familienkreis. Der Kalender arbeitet '
          + 'auf diesem Mac ganz normal weiter; das Update bringt die Verbindung zurück.',
  quarantine: 'Eine Änderung konnte nicht übertragen werden. Sie ist auf diesem Mac gespeichert, '
            + 'aber noch nicht bei den anderen. Öffne Einstellungen → Familie.',
  decrypt: 'Eine empfangene Änderung konnte nicht gelesen werden und wurde nicht übernommen.',
  clockSkew: 'Die Uhrzeit dieses Macs weicht stark von der des Servers ab. Stelle Datum und '
           + 'Uhrzeit auf „automatisch", sonst können Änderungen in der falschen Reihenfolge landen.',
  stalled: 'Neue Änderungen warten auf einen Schlüssel oder auf ein noch unbekanntes Gerät. Es '
         + 'geht nichts verloren; die Übertragung setzt sich fort, sobald beides da ist.',
});

/**
 * @typedef {Object} SyncDeps
 * @property {{request:(m:string,p:string,q:Object,b:any,h:Object)=>Promise<Object>}} transport
 *           a PORT (`platform/net.js`'s, or the loopback bound to the real handlers in tests)
 * @property {{personal?:string|null, family?:string|null}} spaces
 * @property {{now:() => number}} clock
 * @property {(ms:number, fn:Function) => any} schedule
 * @property {(h:any) => void} [unschedule]
 * @property {() => number} random               a float in [0,1)
 * @property {() => boolean} [isOnline]
 * @property {() => boolean} [isVisible]
 * @property {(env:Object) => Promise<{status:'opened'|'park', op?:Object, parkReason?:string,
 *            reason?:string}>} open             `crypto/envelope.js openOp`, bound to the keyring
 *                                               and to `AuthzResult.attestationOf`
 * @property {(ops:Object[]) => void} onOps      → `store.applyRemote`. NEVER touches undo/redo.
 * @property {() => Promise<void>} [persist]     → `store.persistNow`. Runs BEFORE the cursor moves.
 * @property {(s:Object) => void} [onStatus]
 * @property {(space:string, members:Object[]) => void} [onMembers]
 * @property {(space:string, epoch:number) => void} [onEpoch]
 * @property {(findings:Object[]) => void} [onFindings]   chain diagnostics; never blocks
 * @property {(q:Object) => void} [onQuarantine]
 * @property {(m:string) => void} [warn]
 * @property {Object} [outbox] @property {Object} [parking]
 * @property {Object} [cursors] @property {Object} [witness]
 * @property {Object} [cadence]
 */

/**
 * @param {SyncDeps} deps
 */
export function createSyncClient(deps) {
  const d = deps || {};
  if (!d.transport || typeof d.transport.request !== 'function') {
    throw new TypeError('createSyncClient: `transport` is a required port with request(method, path, query, body, headers)');
  }
  if (typeof d.schedule !== 'function') {
    throw new TypeError('createSyncClient: `schedule(ms, fn)` is required — src/js/sync/ may not use a timer of its own');
  }
  if (!d.clock || typeof d.clock.now !== 'function') {
    throw new TypeError('createSyncClient: `clock.now()` is required — src/js/sync/ may not read the wall clock');
  }
  if (typeof d.open !== 'function') {
    // Fail closed. Nothing may be applied that has not passed `openOp` (ADR 002 §4.5's obligation
    // on WP-8, characterized as M-I5b): a client that could apply an envelope it never opened is
    // a client that could append a `member.set{dev.*}` nobody proved.
    throw new TypeError('createSyncClient: `open(envelope)` is required — nothing may be applied '
      + 'that has not passed openOp (ADR 002 §5.2, FINDINGS §4.5)');
  }
  if (typeof d.onOps !== 'function') {
    throw new TypeError('createSyncClient: `onOps(ops)` is required — it is store.applyRemote');
  }

  const cadence = { ...CADENCE, ...(d.cadence || {}) };
  const now = () => d.clock.now();
  const unschedule = typeof d.unschedule === 'function' ? d.unschedule : () => {};
  const random = typeof d.random === 'function' ? d.random : () => 0.5;
  const isOnline = typeof d.isOnline === 'function' ? d.isOnline : () => true;
  const isVisible = typeof d.isVisible === 'function' ? d.isVisible : () => true;
  const warn = typeof d.warn === 'function' ? d.warn : () => {};
  const persist = typeof d.persist === 'function' ? d.persist : async () => {};
  const emitStatus = typeof d.onStatus === 'function' ? d.onStatus : () => {};
  const onMembers = typeof d.onMembers === 'function' ? d.onMembers : () => {};
  const onEpoch = typeof d.onEpoch === 'function' ? d.onEpoch : () => {};
  const onFindings = typeof d.onFindings === 'function' ? d.onFindings : () => {};
  const onQuarantine = typeof d.onQuarantine === 'function' ? d.onQuarantine : () => {};

  const outbox = d.outbox || createOutbox({ now, warn });
  const parking = d.parking || createParkingLot({ now, warn });
  const cursors = d.cursors || createCursors({ warn });
  const witness = d.witness || createChainWitness({});

  // ── state ──────────────────────────────────────────────────────────────────────────────────
  let running = false;
  let generation = 0;                 // bumped by stop(); every callback checks it
  let pullTimer = null;
  let pushTimer = null;
  let statusTimer = null;
  let inPull = null;                  // the in-flight promise, so two triggers do not overlap
  let inPush = null;

  let consecutiveFailures = 0;
  let lastPullAt = null;
  let lastPushAt = null;
  let errorKind = null;               // 'offline'|'auth'|'protocol'|'quarantine'|'decrypt'|'clockSkew'|'stalled'
  let stopped = false;                // 401/403/426 — the loop does not schedule again
  let clockSkewMs = 0;
  let decryptFailures = 0;
  let lastState = null;
  let pendingRetryMs = null;
  const chainFindings = [];
  /** Per-space push tactics: probe one at a time after an unattributed 4xx; epoch patience. */
  const tactics = new Map();

  const tacticsFor = (space) => {
    let t = tactics.get(space);
    if (!t) { t = { probeOne: false, futureEpoch: 0 }; tactics.set(space, t); }
    return t;
  };

  /** The configured spaces, in a fixed order so behaviour is reproducible. */
  const spaceList = () => {
    const s = d.spaces || {};
    return [s.personal, s.family].filter((x) => typeof x === 'string' && x !== '');
  };

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 1. Status (ADR 003 §8.3)
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  function rawStatus() {
    const q = outbox.quarantined();
    return {
      pendingOps: outbox.size(),
      pendingSinceMs: outbox.oldest(),
      online: isOnline(),
      consecutiveFailures,
      lastPullAt,
      now: now(),
      quarantined: q.length,
      errorKind,
      clockSkewMs,
    };
  }

  function detailFor(state, raw) {
    if (state === 'healthy') return null;
    if (errorKind === 'auth') return GERMAN.auth;
    if (errorKind === 'protocol') return GERMAN.protocol;
    if (errorKind === 'decrypt') return GERMAN.decrypt;
    if (errorKind === 'stalled') return GERMAN.stalled;
    if (raw.quarantined > 0) return GERMAN.quarantine;
    if (Math.abs(clockSkewMs) > CLOCK_SKEW_LIMIT_MS) return GERMAN.clockSkew;
    if (!raw.online) return GERMAN.offline;
    return GERMAN.pending;
  }

  function status() {
    const raw = rawStatus();
    const state = classify(raw);
    return {
      state,
      pendingOps: raw.pendingOps,
      consecutiveFailures,
      lastPullAt,
      lastPushAt,
      errorKind: state === 'healthy' ? null : (errorKind || (raw.quarantined > 0 ? 'quarantine' : (!raw.online ? 'offline' : null))),
      detail: detailFor(state, raw),
      quarantined: outbox.quarantined(),
      parked: parking.size(),
      stalled: parking.overflowed > 0,
      chain: witness.snapshot(),
      chainFindings: chainFindings.slice(-32),
      clockSkewMs,
      decryptFailures,
      running,
      stopped,
      nextRetryMs: pendingRetryMs,
    };
  }

  /**
   * Transitions are debounced by 2 s (ADR 003 §8.3) so a normal push — which makes the outbox
   * non-empty and empty again within a second — does not flicker the indicator. The FIRST status
   * of a session is emitted immediately: there is nothing to flicker against yet, and a listener
   * that never hears anything cannot render "nothing at all" deliberately.
   */
  function touchStatus(immediate) {
    const state = classify(rawStatus());
    if (state === lastState && !immediate) return;
    if (immediate || lastState === null) {
      if (statusTimer !== null) { unschedule(statusTimer); statusTimer = null; }
      lastState = state;
      emitStatus(status());
      return;
    }
    if (statusTimer !== null) return;
    const g = generation;
    statusTimer = d.schedule(cadence.statusDebounceMs, () => {
      statusTimer = null;
      if (g !== generation) return;
      const settled = classify(rawStatus());
      if (settled === lastState) return;
      lastState = settled;
      emitStatus(status());
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 2. Failure accounting and scheduling
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  function succeeded() {
    // "reset on the first 2xx" (ADR 003 §8.2). One good answer clears the whole ladder — not a
    // decrement, which would keep a device that fails one request in ten permanently backing off.
    consecutiveFailures = 0;
    pendingRetryMs = null;
    if (errorKind === 'offline') errorKind = null;
  }

  function failed(kind) {
    consecutiveFailures++;
    if (kind) errorKind = kind;
  }

  /** 401/403/426 — stop, do not back off, say why (ADR 003 §8.2). */
  function stopLoop(kind, why) {
    stopped = true;
    errorKind = kind;
    clearTimers();
    warn(`sync: the loop has stopped — ${why}. The app keeps working fully offline (19.1).`);
    touchStatus(true);
  }

  function clearTimers() {
    if (pullTimer !== null) { unschedule(pullTimer); pullTimer = null; }
    if (pushTimer !== null) { unschedule(pushTimer); pushTimer = null; }
  }

  function schedulePull(ms) {
    if (!running || stopped) return;
    if (pullTimer !== null) unschedule(pullTimer);
    const delay = Number.isFinite(ms) ? ms : nextPullDelay();
    const g = generation;
    pullTimer = d.schedule(delay, () => {
      pullTimer = null;
      if (g !== generation || !running || stopped) return;
      void pullNow().then(() => { if (g === generation) schedulePull(); });
    });
  }

  function nextPullDelay() {
    if (consecutiveFailures > 0) {
      const ms = pendingRetryMs !== null ? pendingRetryMs : backoffMs(consecutiveFailures, random, cadence);
      pendingRetryMs = null;
      return ms;
    }
    // Offline is not an error and it is not a reason to hammer: §8.2 says stop scheduling and
    // queue. The `online` event brings the loop back; the slow tick is a belt-and-braces poll for
    // a runtime where that event never arrives.
    if (!isOnline()) return cadence.pullHiddenMs;
    return pullDelayMs(isVisible(), random, cadence);
  }

  /** A transaction committed: debounce 2 s, then push (ADR 003 §8.2 row 1). */
  function schedulePush() {
    if (!running || stopped) return;
    if (pushTimer !== null) return;                    // already pending — debounce, not throttle
    const g = generation;
    pushTimer = d.schedule(cadence.pushDebounceMs, () => {
      pushTimer = null;
      if (g !== generation || !running || stopped) return;
      void pushNow();
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 3. One request
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /**
   * Every response passes the version gate first (ADR 003 §4) and every response updates the
   * clock-skew reading. `X-LZP-Min-Protocol` rides on all of them, including errors, so a client
   * learns about a coming gate BEFORE it is enforced (22.4's quiet hint).
   */
  async function call(method, path, query, body) {
    let res;
    try {
      res = await d.transport.request(method, path, query, body, {});
    } catch (e) {
      // A transport error is indistinguishable from being offline, and both are `retry`.
      // `NetError.kind` narrows it for the diagnostic only — nothing branches on the string.
      const kind = e && typeof e.kind === 'string' ? e.kind : 'transport';
      return { ok: false, transportError: kind, error: e, verdict: { kind: 'retry', code: null, retryAfterMs: null, errorKind: kind === 'offline' ? 'offline' : null, forkedOid: null } };
    }

    const gate = checkProtocol(res);
    if (!gate.ok) {
      return { ok: false, res, protocol: gate, verdict: { kind: 'stop', code: gate.kind, retryAfterMs: null, errorKind: 'protocol', forkedOid: null } };
    }
    const hdrs = readProtocolHeaders(res);
    if (hdrs.minProto !== null && hdrs.minProto > PROTOCOL) {
      // Not yet enforced — the server still answered. This is 22.4's „Update verfügbar" hint.
      warn(`sync: the relay now requires protocol ${hdrs.minProto}; this build speaks ${PROTOCOL}. `
         + 'An update is available and sync will stop working without it.');
    }
    const verdict = interpret(res);
    return { ok: verdict.kind === 'ok', res, verdict };
  }

  /** `serverTime` against our own clock — ADR 003 §8.3's skew row. */
  function noteServerTime(t) {
    if (!Number.isFinite(t) || t <= 0) return;
    clockSkewMs = now() - t;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 4. PULL
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  /**
   * One pull cycle over every configured space.
   *
   * Two triggers may race — the timer and a `focus` — so the in-flight promise is shared rather
   * than a second cycle started. Two concurrent pulls of one space would both advance the cursor
   * from the same `since` and the later one would move it backwards, which `cursors.advance`
   * refuses; sharing the promise means the refusal never has to happen.
   */
  function pullNow() {
    if (inPull) return inPull;
    inPull = (async () => {
      try {
        for (const space of spaceList()) {
          if (stopped) break;
          try {
            await pullSpace(space);
          } catch (e) {
            // A throw out of a pull is almost always the COMMIT throwing — `store.applyRemote`
            // refusing, or `persistNow` failing on a full disk. The cursor did not move
            // (`cursors.advance` re-raises after leaving it alone), so the batch is re-pulled and
            // re-applied idempotently. Letting it escape would kill the scheduler's promise chain
            // and silently stop the loop, which is the one outcome worse than a failed pull.
            failed(null);
            warn(`sync: the pull of ${space} could not be committed (${e && e.name}: ${e && e.message}); `
               + 'the cursor did not move and the batch will be pulled again.');
          }
        }
      } finally {
        inPull = null;
        touchStatus();
      }
    })();
    return inPull;
  }

  async function pullSpace(space) {
    if (!isOnline()) { errorKind = 'offline'; return; }
    let pages = 0;
    let more = true;
    while (more && pages < MAX_PAGES_PER_CYCLE && !stopped) {
      pages++;
      const since = cursors.get(space);
      const out = await call('GET', PATHS.ops, pullQuery(space, since, LIMITS.opsPerPull), undefined);

      if (!out.ok) {
        handleFailure(out.verdict, `pull ${space}`);
        return;
      }
      noteServerTime(out.res.json && out.res.json.serverTime);
      const read = readPullBody(out.res, since);
      if (!read.ok) {
        // A body we cannot read is not a reason to advance anything. It is counted as a failure so
        // the backoff applies, and it is reported: a relay answering nonsense is either broken or
        // hostile, and both need saying.
        failed(null);
        warn(`sync: the relay's answer to a pull of ${space} was refused — ${read.why}. The cursor `
           + `stays at ${since} and nothing was applied.`);
        return;
      }
      if (read.cursorLie) {
        // `readPullBody` has already clamped the cursor to the last row actually returned. The
        // relay claiming otherwise is exactly the silent-skip hazard `pullOps` documents from the
        // other side, so it is reported rather than shrugged at.
        warn(`sync: ${read.cursorLie}. The cursor was clamped to the last op received; nothing was skipped.`);
      }

      succeeded();
      lastPullAt = now();
      onEpoch(space, read.currentEpoch);
      if (read.members.length) onMembers(space, read.members);

      // ── the chain witness. Diagnostic-only; it never blocks and never refuses a row. ────────
      try {
        const found = await witness.observe(space, read.ops);
        if (found.length) {
          chainFindings.push(...found);
          onFindings(found);
          for (const f of found) warn(`sync: chain witness — ${f.kind} in ${space} at seq ${f.seq || '?'}: ${f.detail}`);
        }
      } catch (e) {
        warn(`sync: the chain witness could not run (${e && e.message}); sync is unaffected (ADR 002 §5.4)`);
      }

      // ── open, park, or refuse — and decide how far the cursor may move ─────────────────────
      const opened = [];
      let cursorTo = since;
      let head = witness.head(space);
      let stalled = false;

      for (const row of read.ops) {
        let verdict;
        try {
          verdict = await d.open(row.env);
        } catch (e) {
          // A hard failure from `openOp` — P2, P3 or one of the five identity checks. ADR 002
          // §5.2.2: those are PROTOCOL VIOLATIONS, not delivery skew. The op is refused, locally
          // and loudly, and the cursor DOES move past it: a spliced or re-attributed envelope is
          // not something to come back for.
          decryptFailures++;
          errorKind = 'decrypt';
          warn(`sync: an envelope at seq ${row.seq} in ${space} was refused — ${e && e.message}`);
          cursorTo = row.seq;
          head = { seq: row.seq, chain: row.chain };
          continue;
        }
        if (verdict && verdict.status === 'opened') {
          opened.push(verdict.op);
          cursorTo = row.seq;
          head = { seq: row.seq, chain: row.chain };
          continue;
        }
        // A park. The SEALED envelope is retained, unopened (ADR 002 §5.2.1 correction 1, F-6).
        const took = await parking.park(space, row.env, row.seq, (verdict && verdict.parkReason) || 'unknown');
        if (!took) {
          // The lot is full. Everything from here on stays on the relay: the cursor does not move
          // past this row, so nothing is lost and the stall is visible. See `outbox.js park()`.
          stalled = true;
          errorKind = 'stalled';
          break;
        }
        cursorTo = row.seq;
        head = { seq: row.seq, chain: row.chain };
      }

      // ── replay the lot: an attestation or a key in THIS page may unlock an older envelope ───
      opened.push(...await replayParked(space));

      // ── fold, persist, THEN move the cursor. The order is the whole of §3.3 and W1. ─────────
      const fromGenesis = cmpSeq(since, ZERO_SEQ) === 0 || cursors.fromGenesis(space);
      await cursors.advance(space, cursorTo, head, async () => {
        if (opened.length) d.onOps(opened);
        await persist();
      }, { fromGenesis });

      more = read.hasMore && !stalled;
      if (stalled) break;
    }
    if (more && pages >= MAX_PAGES_PER_CYCLE) {
      // 19.6 — three weeks offline across a month roll. It is "a large op set arriving late", and
      // it is handled by coming back on the next tick rather than by a special case.
      warn(`sync: ${space} still has more to catch up on; it continues on the next pull.`);
      schedulePull(0);
    }
  }

  /**
   * Re-open everything parked for a space. Called after every page, because the thing that
   * unblocks a parked envelope — a `member.set{dev.*}` attestation, or a key epoch that arrived
   * through the keys endpoint — is exactly what a page may have just delivered.
   *
   * An envelope that has been replayed `PARK_REPLAY_TRIES` times is left in the lot but stops
   * being retried every pull: after sixty-four attempts the thing it is waiting for is not coming
   * this session, and re-decrypting it 500 times an hour is a cost with no chance of a benefit.
   * It is retried again after a restart, which is when a new key ring is loaded.
   */
  async function replayParked(space) {
    const out = [];
    const rows = parking.parked(space);
    if (!rows.length) return out;
    const freed = [];
    const stillStuck = [];
    for (const r of rows) {
      if (r.tries >= PARK_REPLAY_TRIES) continue;
      let verdict;
      try {
        verdict = await d.open(r.env);
      } catch (e) {
        // It opened far enough to fail a hard check. It will never open. Releasing it is right:
        // holding a permanently-invalid envelope for ever is the same unbounded growth the cap
        // exists to prevent, and there is nothing to come back for.
        decryptFailures++;
        errorKind = 'decrypt';
        warn(`sync: a parked envelope ${r.oid} in ${space} was refused on replay — ${e && e.message}`);
        freed.push(r.oid);
        continue;
      }
      if (verdict && verdict.status === 'opened') { out.push(verdict.op); freed.push(r.oid); continue; }
      stillStuck.push(r.oid);
    }
    if (freed.length) await parking.release(space, freed);
    if (stillStuck.length) await parking.touch(space, stillStuck);
    return out;
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 5. PUSH
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  function pushNow() {
    if (inPush) return inPush;
    inPush = (async () => {
      try {
        for (const space of spaceList()) {
          if (stopped) break;
          if (outbox.size(space) === 0) continue;
          try {
            await pushSpace(space);
          } catch (e) {
            failed(null);
            warn(`sync: the push into ${space} failed unexpectedly (${e && e.name}: ${e && e.message}); `
               + 'nothing was acknowledged, so every op stays queued.');
          }
        }
      } finally {
        inPush = null;
        touchStatus();
      }
    })();
    return inPush;
  }

  async function pushSpace(space) {
    if (!isOnline()) { errorKind = 'offline'; return; }
    const t = tacticsFor(space);
    let batches = 0;

    while (outbox.size(space) > 0 && batches < MAX_BATCHES_PER_CYCLE && !stopped) {
      batches++;
      const n = t.probeOne ? 1 : LIMITS.opsPerPush;
      const ops = outbox.peek(space, n);
      if (!ops.length) break;

      // `drained` is TRUTHFUL or absent. It is `true` only when this batch is the whole queue, so
      // the claim "this device has pushed everything it had authored" is exactly what the relay
      // records. Guessing it — say, from the highest seq of the batch — resurrects deleted entries
      // (ADR 001 §7.3 condition 3, `server/core/handlers/ops.js`'s E2-202-E note). An op minted
      // DURING the flight is a new write above the recorded high-water, not an old unpushed one,
      // so it is outside the hazard.
      const drained = outbox.size(space) === ops.length;
      const body = pushBody({ space, ackSeq: cursors.get(space), ops, drained });

      const out = await call('POST', PATHS.ops, undefined, body);
      if (!out.ok) {
        const handled = await handlePushFailure(space, out.verdict, ops, t);
        if (!handled) return;
        continue;
      }

      noteServerTime(out.res.json && out.res.json.serverTime);
      const read = readPushBody(out.res);
      if (!read.ok) {
        failed(null);
        warn(`sync: the relay's answer to a push into ${space} was refused — ${read.why}. `
           + 'Nothing was acknowledged, so every op stays queued and is retried.');
        return;
      }
      succeeded();
      lastPushAt = now();
      t.probeOne = false;
      t.futureEpoch = 0;

      // `accepted` and `duplicate` are one list. Both mean "the relay has it" (ADR 003 §3.1).
      await outbox.ack(space, read.held.map((r) => r.oid));

      // A receipt that names nothing we sent is a relay answering about someone else's batch. Not
      // fatal — the ops stay queued and are retried — but it must not pass silently.
      if (read.held.length === 0 && ops.length > 0) {
        warn(`sync: the relay acknowledged none of the ${ops.length} ops pushed into ${space}. `
           + 'They stay queued.');
        return;
      }
      touchStatus();
    }
  }

  /**
   * @returns {Promise<boolean>} true when the loop may continue with the next batch
   */
  async function handlePushFailure(space, verdict, ops, t) {
    const code = verdict.code;

    // The item-level 4xx, including the 403 that is really a body error (see ITEM_LEVEL_PUSH_CODES).
    if (verdict.kind === 'reject' || (verdict.kind === 'stop' && ITEM_LEVEL_PUSH_CODES.includes(code))) {
      if (code === 'future_epoch') {
        t.futureEpoch++;
        if (t.futureEpoch <= FUTURE_EPOCH_PATIENCE) {
          failed(null);
          warn(`sync: ${space} rejected a batch as future_epoch (${t.futureEpoch}/${FUTURE_EPOCH_PATIENCE}); `
             + 'the rotation this device sealed under has not reached the relay yet. Retrying.');
          return false;
        }
        // Fall through to quarantine: it has spun long enough.
      }
      if (code === 'forked_op_id' && verdict.forkedOid) {
        await quarantine(space, verdict.forkedOid,
          'the relay holds a different envelope under this opId (409 forked_op_id). ADR 003 §3.1: '
          + 'this is local corruption and the op must be RE-MINTED with a fresh opId — which only '
          + 'the store can do, because only the store holds the plaintext.');
        return true;                                   // the rest of the batch is fine; carry on
      }
      if (ops.length > 1 && !t.probeOne) {
        // The relay refused the batch without naming a row. Isolate: the next batch is one op, so
        // a single bad envelope cannot hold a three-week queue hostage behind it.
        t.probeOne = true;
        warn(`sync: ${space} refused a batch of ${ops.length} with ${code || 'no code'}; retrying one at a time to find the offender.`);
        return true;
      }
      await quarantine(space, ops[0].oid, `the relay refused it permanently (${code || 'no code'})`);
      t.probeOne = false;
      return true;
    }

    if (verdict.kind === 'stop') {
      stopLoop(verdict.errorKind || 'auth', `the relay answered ${code || 'a 4xx'} for a push into ${space}`);
      return false;
    }
    if (verdict.kind === 'rate') {
      failed(null);
      pendingRetryMs = verdict.retryAfterMs !== null ? verdict.retryAfterMs : backoffMs(consecutiveFailures, random, cadence);
      warn(`sync: the relay is rate-limiting this device; the next attempt is in ${pendingRetryMs} ms.`);
      return false;
    }
    failed(verdict.errorKind);
    return false;
  }

  async function quarantine(space, oid, reason) {
    const did = await outbox.quarantine(space, oid, reason);
    if (did) {
      errorKind = 'quarantine';
      onQuarantine({ space, oid, reason });
      touchStatus(true);
    }
  }

  function handleFailure(verdict, what) {
    if (verdict.kind === 'stop') {
      stopLoop(verdict.errorKind || 'auth', `the relay answered ${verdict.code || 'a 4xx'} for ${what}`);
      return;
    }
    if (verdict.kind === 'rate') {
      failed(null);
      pendingRetryMs = verdict.retryAfterMs !== null ? verdict.retryAfterMs : backoffMs(consecutiveFailures, random, cadence);
      return;
    }
    if (verdict.kind === 'reject') {
      // A 4xx on a PULL is not about one item — there is no item. Backing off is the only sane
      // response, and the code is reported so it is not invisible.
      failed(null);
      warn(`sync: ${what} was refused with ${verdict.code || 'a 4xx'}; backing off.`);
      return;
    }
    failed(verdict.errorKind);
  }

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 6. The public surface
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  const api = {
    /** Hydrate the three durable stores. Safe to call twice. */
    async load() {
      await outbox.load();
      await parking.load();
      await cursors.load();
      for (const space of spaceList()) {
        witness.restore(space, cursors.head(space), cursors.fromGenesis(space));
      }
      touchStatus(true);
      return api;
    },

    start() {
      if (running) return api;
      running = true;
      stopped = false;
      generation++;
      touchStatus(true);
      // The first pull is immediate: a window that has just opened is exactly the "on focus"
      // trigger, and waiting 45 s to show a peer's change that arrived overnight is the thing
      // 19.2 is about.
      void pullNow().then(() => schedulePull());
      if (outbox.size() > 0) schedulePush();
      return api;
    },

    stop() {
      running = false;
      generation++;                              // every in-flight callback becomes a no-op
      clearTimers();
      if (statusTimer !== null) { unschedule(statusTimer); statusTimer = null; }
      return api;
    },

    /**
     * A transaction committed and the microtask sealed its ops (ADR 001 §0.9 — after `emit()`,
     * never before). Durable first, network second: `enqueue` persists, and only then is a push
     * scheduled. A crash between the two costs a delay, not an op.
     */
    async queue(space, envelopes) {
      const r = await outbox.enqueue(space, envelopes);
      if (r.queued > 0) {
        schedulePush();
        touchStatus();
      }
      return r;
    },

    /** For the scheduler and for tests. **Not for a menu item** — 19.2 forbids a manual refresh. */
    pushNow,
    pullNow,

    /**
     * `pagehide` (ADR 003 §8.2's last row): force-flush the outbox.
     *
     * ⚠ AN ADR AMBIGUITY, RESOLVED HONESTLY. §8.2 says to flush "through the same path
     * `store.flushSync()` already uses", and `flushSync` is SYNCHRONOUS because it runs inside a
     * `pagehide` handler where the process may not survive an `await`. A network request cannot be
     * synchronous in any engine. So the two halves are separated and only one of them is promised:
     *
     *   · DURABILITY IS GUARANTEED — the envelope was persisted by `queue()` at seal time, long
     *     before this. Nothing is lost by quitting, which is the property 19.1 actually needs.
     *   · DELIVERY IS BEST-EFFORT — this starts a push and does not wait for it. If the window
     *     dies first, the ops go out on the next launch.
     *
     * Reported as a documentation fix rather than implemented as a promise this layer cannot keep.
     */
    flush() {
      if (!running || stopped) return null;
      return pushNow();
    },

    /** `focus` · `visibilitychange → visible` · `online` — pull every configured space now. */
    wake(reason) {
      if (!running || stopped) return null;
      if (reason === 'online') succeeded();
      const p = pullNow();
      void p.then(() => { schedulePull(); if (outbox.size() > 0) void pushNow(); });
      return p;
    },

    /** `visibilitychange → hidden`. The pull tick slows to 10 min; the push cadence is unchanged. */
    sleep() {
      if (!running || stopped) return;
      schedulePull(cadence.pullHiddenMs);
    },

    status,

    /** Everything for `store.diagnostics()` and the LZP-1003 self-audit. No key material. */
    diagnostics() {
      return {
        running,
        stopped,
        spaces: spaceList(),
        cursors: cursors.diagnostics(),
        outbox: outbox.diagnostics(),
        parking: parking.diagnostics(),
        chain: witness.snapshot(),
        consecutiveFailures,
        clockSkewMs,
        decryptFailures,
        status: status().state,
      };
    },

    /** The parts, for a caller that built its own. */
    parts: { outbox, parking, cursors, witness },
  };

  return api;
}

export { GERMAN as SYNC_COPY, ITEM_LEVEL_PUSH_CODES, FUTURE_EPOCH_PATIENCE };
