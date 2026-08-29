// src/js/family/pairflow.js — LZP-505: the pairing flow, over the real rendezvous.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `crypto/pairing.js` is a pure state machine: nothing in it talks to anything, and that is what
// lets `tests/helpers/mitm.js` be a genuinely hostile relay rather than a mocked one.
// `family/pairingui.js` renders a `PairingView` handed to it by a flow and imports nothing from
// `crypto/` at all. This file is the flow between them — the relay round trips, the polling and
// the retry — and it is the ONLY place in the product where those two meet.
//
// It implements the port `pairingui.js` declares, verbatim:
//
//     { snapshot(): PairingView, subscribe(fn) -> unsubscribe,
//       start(role), submitCode(typed12), confirmMatch(bool), cancel() }
//
// The reference implementation in `tests/tier2/pairing-flow.dom.js` §2 proved the port was
// implementable. This is the same shape with three things the reference deliberately left out:
// a real transport, a real poll cadence, and what happens AFTER `receive()` — the step that
// turns a decrypted payload into a Mac that can actually sync.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE BEHAVIOUR A TEST CANNOT INFER, AND LZP-503 ASKED FOR IT BY NAME
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// **`start(role)` is idempotent for a live session.** `openPairingScreen()` calls it every time,
// deliberately — a screen showing a code no session minted is a screen showing a code that
// cannot work — so re-opening the screen must RESUME rather than mint a second offer under a
// second `rid`. Invisible in a single-screen test and fatal across two Macs, because the second
// `beginAsExisting()` would publish an offer at a rendezvous the other Mac is not watching.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THE JOINER POLLS AND THE OFFERER POLLS DIFFERENTLY
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `GET /api/v1/pair/:rid` charges an attempt against the 5-attempt budget for an ANONYMOUS read
// of a rendezvous that has not yet been answered (`server/core/handlers/pair.js` §2) — that is
// exactly the shape of an online guess. So:
//
//   · the OFFERER polls AUTHENTICATED (`role: 'offerer'`), which is never charged, and waits for
//     `boxB`;
//   · the JOINER reads ONCE, anonymously, to fetch `boxA` — one charge, which is the honest cost
//     of one attempt — and then polls for `delivery`, which is free because `boxB` exists by
//     then.
//
// Polling the offerer's own rendezvous on the anonymous path would burn the honest budget in
// five polls and pairing would fail for everyone.

import {
  createPairingSession, derivePairing, adoptPairedDevice, PAIRING, PAIR_STATE,
} from '../crypto/pairing.js';
import { ensureDeviceIdentity, ensureRecoveryIdentity, exportRawPublic } from '../crypto/identity.js';
import { createKeyRing } from '../crypto/spacekeys.js';
import { selfAttest } from '../platform/device-identity.js';
import { chooseKeyStore } from '../platform/keystore.js';
import { b64u, ub64 } from '../core/b64.js';

const TE = new TextEncoder();
const TD = new TextDecoder();

/** A box is `b64u(iv).b64u(ct)`; the relay wants opaque base64url. One encode, one decode. */
const boxOut = (box) => b64u(TE.encode(box));
const boxIn = (b64) => TD.decode(ub64(b64));

/**
 * THE POLL SCHEDULE, AND IT IS A BUDGET BEFORE IT IS A CADENCE — finding E5-5.
 *
 * `GET /api/v1/pair/:rid` is charged against `pairGetPerIpHour = 20` (ADR 002 §6.2, enforced in
 * `server/core/limits.js` as a `pre-auth` rule, so an AUTHENTICATED offerer read is charged too).
 * The rendezvous lives 180 s. **Two Macs of one household are one IP** — that is the ordinary
 * case, not the exotic one — so the twenty reads are shared between both ends of the pairing.
 *
 * A fixed 1 s poll spends the whole hour's budget in twenty seconds and the second Mac then gets
 * a 429 where it expected `box_A`. Measured, in exactly that shape, during the M1 demonstration.
 *
 * So the schedule is front-loaded and then backs off: a person types a twelve-character code in
 * about twenty seconds, which is where the responsiveness has to be, and after that the cost of
 * waiting is only that the SAS appears a few seconds late. Eleven reads cover the full 180 s TTL
 * and leave nine of the twenty for the joiner — enough for one `box_A` fetch, several delivery
 * polls, and a second attempt if the first pairing is abandoned.
 *
 * REPORTED, not worked around: a household that pairs a third device within the hour still runs
 * out. The right fix is on the relay — not charging the authenticated offerer's own read, which
 * is what `pair.js` §2 already argues for reads AFTER `box_B` exists — and it is not this file's
 * to make. See `docs/v2/FINDINGS.md` E5-5.
 */
export const PAIR_POLL_SCHEDULE = Object.freeze([2000, 2000, 3000, 5000, 8000, 12000, 18000, 24000, 32000, 36000, 40000]);

/** Kept for a caller that wants the first interval. */
export const PAIR_POLL_MS = PAIR_POLL_SCHEDULE[0];

/**
 * A box that is well-formed and cannot open: 12 IV bytes, 18 ciphertext bytes, no valid tag.
 *
 * A relay with no rendezvous at that `rid` must be INDISTINGUISHABLE from a relay handing back a
 * tampered box — ADR 002 §6.2 counts failed opens and `openPairBox` is deliberately an oracle
 * for nothing. So the flow feeds the session a box rather than short-circuiting on a 404, and
 * the attempt counter comes down either way.
 */
const UNOPENABLE = 'AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB';

const EMPTY = Object.freeze({
  role: null, state: 'init', display: null, sas: null, selfShort: null, peerShort: null,
  attemptsRemaining: PAIRING.maxAttempts ?? 5, expiresAt: null, busy: false, errorCode: null,
});

const TERMINAL = ['delivered', 'received', 'refused', 'expired', 'burned', 'failed'];

/**
 * @param {Object} deps
 * @param {Object} deps.transport         `platform/net.js`'s Transport port (signed; offerer)
 * @param {Object} deps.anonTransport     the ANONYMOUS transport (joiner; ADR 002 §6.3 step 4)
 * @param {Object|null} deps.identity     the EXISTING device's identity (null on the new Mac)
 * @param {Object|null} deps.recovery     the member's recovery pair (existing Mac only)
 * @param {Object|null} deps.keyring      what `deliver()` sends (existing Mac only)
 * @param {string} deps.spaceId           `psp_…`
 * @param {string|null} deps.selfShort
 * @param {() => number} deps.now
 * @param {(ms:number, fn:Function) => any} deps.schedule
 * @param {(h:any) => void} deps.unschedule
 * @param {string} deps.today             'YYYY-MM-DD' — nothing under crypto/ reads a clock
 * @param {(result:Object) => Promise<void>} [deps.onPaired]  what to do with a completed pairing
 * @param {Function} [deps.warn]
 */
export function createPairingFlow(deps) {
  const d = deps || {};
  let session = null;
  let rid = null;
  let poll = null;
  let view = EMPTY;
  const subs = new Set();

  const ports = { now: d.now };

  const set = (patch) => {
    view = Object.freeze({ ...view, ...patch });
    // A screen that throws is a screen bug, not a protocol failure. The session must not end
    // because a render did.
    for (const f of [...subs]) { try { f(view); } catch { /* not a flow error */ } }
  };

  const sync = () => {
    if (!session) return;
    set({
      state: session.state(),
      role: session.role(),
      sas: session.sas(),
      attemptsRemaining: session.attemptsRemaining(),
      peerShort: session.peer()?.deviceShort ?? view.peerShort,
    });
  };

  const guard = async (fn) => {
    set({ busy: true, errorCode: null });
    try {
      await fn();
      set({ busy: false });
      sync();
    } catch (e) {
      set({ busy: false, errorCode: (e && e.code) || 'unknown' });
      sync();
      if (typeof d.warn === 'function') d.warn(`pairing: ${(e && e.message) || e}`);
    }
  };

  // ── the relay ──────────────────────────────────────────────────────────────

  /**
   * Two transports, and which one is used is a property of the ROLE, not of a flag at the call
   * site. `net.js`'s anonymous transport has no `sign` port and no `deviceShort`, so the joiner
   * structurally cannot present the credentials that would turn its read into a 401 — see
   * `optionalAuth` in `server/core/handlers/pair.js`.
   */
  function get(theRid, { authenticated }) {
    const t = authenticated ? d.transport : d.anonTransport;
    if (!t) {
      return Promise.reject(Object.assign(
        new Error(`pairing: no ${authenticated ? 'authenticated' : 'anonymous'} transport`), { code: 'config' }));
    }
    return t.request('GET', `/api/v1/pair/${theRid}`, undefined, undefined, {});
  }

  function stopPoll() {
    if (poll !== null && typeof d.unschedule === 'function') d.unschedule(poll);
    poll = null;
  }

  let pollStep = 0;

  function armPoll(fn) {
    stopPoll();
    const wait = PAIR_POLL_SCHEDULE[Math.min(pollStep, PAIR_POLL_SCHEDULE.length - 1)];
    pollStep += 1;
    poll = d.schedule(wait, async () => {
      poll = null;
      let again = true;
      try { again = await fn(); } catch { again = true; }
      if (again && !TERMINAL.includes(view.state)) armPoll(fn);
    });
  }

  /** The offerer waits for `boxB`, authenticated so the read is never charged. */
  async function pollForAnswer() {
    if (!session || session.state() !== PAIR_STATE.offered) return false;
    const res = await get(rid, { authenticated: true });
    if (res.status !== 200 || !res.json || !res.json.boxB) return true;
    await guard(async () => {
      const r = await session.confirmExisting(boxIn(res.json.boxB));
      set({ peerShort: r.peer.deviceShort });
    });
    return false;
  }

  /** The joiner waits for `delivery`. Free: `boxB` exists, so nothing is charged. */
  async function pollForDelivery() {
    if (!session || session.state() !== PAIR_STATE.confirmed) return true;
    const res = await get(rid, { authenticated: false });
    if (res.status !== 200 || !res.json || !res.json.delivery) return true;
    await guard(async () => {
      const restored = await session.receive(boxIn(res.json.delivery));
      await finishAsNewDevice(restored);
    });
    return false;
  }

  // ── what happens after `receive()` — ADR 002 §6.3 step 8 ───────────────────

  /**
   * The new Mac becomes a device of the existing member.
   *
   * `adoptPairedDevice` writes the three key-store records `ensureDeviceIdentity` reads, so the
   * identity is durable from this Mac's very first launch. Re-opening it through the SHIPPED
   * entry points rather than trusting the return value is the anti-drift discipline
   * `crypto-pairing.test.js` applies, and it matters most here: if the two disagree, this Mac
   * seals under one identity and authenticates under another, and the failure is remote.
   */
  async function finishAsNewDevice(restored) {
    const personal = restored && restored.personal;
    if (!personal || !(personal.epochs instanceof Map)) {
      throw Object.assign(new Error('pairing: the payload carried no personal key ring'), { code: 'payload' });
    }
    if (d.spaceId && personal.spaceId !== d.spaceId) {
      // A payload naming another space is REFUSED rather than merged: a Mac paired into the
      // wrong space would sync silently to nothing.
      throw Object.assign(
        new Error(`pairing: the payload names ${personal.spaceId}, not ${d.spaceId}`), { code: 'space' });
    }

    const { store: ks } = chooseKeyStore({ invoke: d.invoke });
    await adoptPairedDevice(ks, restored, session.newDeviceKeys(), { createdAt: d.today });
    const identity = await ensureDeviceIdentity(ks, restored.memberId, {});
    const recovery = await ensureRecoveryIdentity(ks, restored.memberId, {});
    const mine = await selfAttest(
      ks,
      { memberId: identity.memberId, deviceId: identity.deviceId, deviceShort: identity.deviceShort },
      recovery.recSig.privateKey,
      { createdAt: d.today },
    );

    const ring = createKeyRing();
    const epochs = [];
    for (const [e, k] of personal.epochs) {
      ring.put(personal.spaceId, Number(e), k);
      epochs.push([Number(e), k]);
    }

    if (typeof d.onPaired === 'function') {
      await d.onPaired({
        role: 'new',
        spaceId: personal.spaceId,
        memberId: restored.memberId,
        identity,
        recovery,
        attestation: mine.attestation,
        blob: mine.blob,
        peer: session.peer(),
        ring,
        epochs,
      });
    }
  }

  // ── the port ───────────────────────────────────────────────────────────────

  return {
    snapshot: () => view,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
    session: () => session,

    async start(role) {
      // IDEMPOTENT FOR A LIVE SESSION — see the header. This is the whole of it.
      if (session && !TERMINAL.includes(session.state())) { sync(); return; }
      session = createPairingSession(
        role === 'existing' ? { ...d.identity, recSig: d.recovery.recSig, recKex: d.recovery.recKex } : null,
        role === 'existing' ? d.keyring : null,
        ports,
      );
      set({ ...EMPTY, role, selfShort: d.selfShort ?? null });
      if (role !== 'existing') { sync(); return; }
      await guard(async () => {
        const r = await session.beginAsExisting();
        rid = r.rid;
        const res = await d.transport.request('POST', '/api/v1/pair/offer', undefined, {
          rid, boxA: boxOut(r.boxA),
        });
        if (res.status !== 200) {
          throw Object.assign(new Error(`pair/offer → ${res.status}`), { code: 'relay' });
        }
        set({ display: r.display, expiresAt: d.now() + PAIRING.ttlMs });
      });
      if (view.errorCode === null) { pollStep = 0; armPoll(pollForAnswer); }
    },

    async submitCode(typed) {
      await guard(async () => {
        const derived = await derivePairing(typed, ports);
        const res = await get(derived.rid, { authenticated: false });
        const boxA = res.status === 200 && res.json && res.json.boxA ? boxIn(res.json.boxA) : UNOPENABLE;
        const r = await session.answerAsNew(typed, boxA);
        rid = r.rid;
        set({ peerShort: r.peer.deviceShort });
        // ANONYMOUS, and it has to be: at step 5 this Mac's keys exist only inside the session.
        const post = await d.anonTransport.request('POST', '/api/v1/pair/answer', undefined, {
          rid, boxB: boxOut(r.boxB),
        });
        if (post.status !== 200) {
          throw Object.assign(new Error(`pair/answer → ${post.status}`), { code: 'relay' });
        }
        await session.confirmNew();
      });
    },

    async confirmMatch(ok) {
      await guard(async () => {
        session.confirmSasMatch(ok);
        if (session.state() !== PAIR_STATE.confirmed) { stopPoll(); return; }
        if (session.role() === 'existing') {
          const blob = await session.deliver();
          const res = await d.transport.request('POST', '/api/v1/pair/deliver', undefined, {
            rid, delivery: boxOut(blob),
          });
          if (res.status !== 200) {
            throw Object.assign(new Error(`pair/deliver → ${res.status}`), { code: 'relay' });
          }
          stopPoll();
          if (typeof d.onPaired === 'function') {
            // The EXISTING Mac's half of the attestation hop: it holds the peer's four public
            // fields off the SAS-authenticated channel and the member's own recovery key, so it
            // can vouch for the new device without anything crossing the relay. See engine.js.
            await d.onPaired({ role: 'existing', peer: session.peer(), spaceId: d.spaceId });
          }
        } else {
          pollStep = 0;
          armPoll(pollForDelivery);
        }
      });
    },

    async cancel() {
      stopPoll();
      // Idempotent by contract: a session that never started, or has already ended, has nothing
      // to refuse. „Später" is not a state this protocol has — a cancel is a REFUSAL.
      try { if (session && session.state() === PAIR_STATE.sas) session.confirmSasMatch(false); }
      catch { /* terminal already */ }
      set({ state: session ? session.state() : 'failed' });
    },
  };
}

export { PAIRING, PAIR_STATE };
