// src/js/sync/keys.js — ADR 002 §7.1 STEPS 4, 5 AND 6.  The half PO decision D9 rests on.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `docs/v2/E6-VERIFICATION.md` §5.2 measured the hole this file fills, and measured it as an
// ABSENCE rather than a defect:
//
//     client callers of GET  /api/v1/spaces/:id/keys    → NONE
//     client callers of POST /api/v1/spaces/:id/epoch   → NONE
//     client code that wraps the ring for a PEER device → NONE
//
// Mom redeems the invite, is immediately a member, and is told — truthfully, calmly, in one
// German line — that the shared entries appear by themselves as soon as another Mac in the circle
// next syncs. In that build no Mac ever would, because nothing anywhere was written to do it.
//
// This module is the thing that does it, and it is exactly three verbs:
//
//   `admit()`    STEPS 5–6 · fetch every wrap addressed to this device, verify WHO SENT each one
//                against the branded sender set, and admit the epochs into the ring. The
//                receiving half of ADR 002 §4.2 step 6 (finding S1).
//   `deliver()`  STEP 4 · a device that HOLDS the ring notices a recipient that provably does not
//                and hands the whole ring over — epochs 1..e+1, so the joiner sees the shared
//                history (A4, story 17.1, risk R11). **Any member device, never only the
//                admin's** — the ADR says so and D9's corrected text says why: a two-person
//                family would otherwise be blocked by one sleeping laptop.
//   `rotate()`   §4.1 · a membership change mints a new epoch so a removed member cannot read
//                what comes next (20.2, T2). It does NOT and CANNOT un-read what they already
//                hold; see `ROTATION_HONESTY` below, and the Addendum §6: *unsharing is not
//                unremembering.*
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS ONE MODULE AND NOT THREE, AND WHY IT IS IN `sync/` AND NOT IN `family/`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The three verbs share ONE piece of state that must not be computed twice: the **coverage
// proof** (§4 below) — which recipients this device can PROVE already hold the ring, and at which
// epoch. `admit` is where the epoch is learned, `deliver` is where the proof is consumed and
// extended, and `rotate` is where it is re-established. Splitting them would put the proof in a
// fourth place, and a coverage question with two answers is how a family ends up with a member
// whose board never fills in.
//
// It lives in `src/js/sync/` because it is I/O-free by the same rule the rest of that directory
// is (ADR 005 §2): the transport, the clock and the durable slot are all injected. It is not in
// `src/js/family/` because `family/` may touch `localStorage` and `document`, and the moment a
// key decision can read either, the decision is no longer testable as a pure function of what the
// relay said.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IT DELIBERATELY DOES NOT DO
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   · **It takes no role, no `isAdmin`, no admin id.** `crypto/spacekeys.js` refuses to grow one
//     and `tests/tier1/crypto-spacekeys.test.js` asserts no export of that module names one; this
//     file holds the same line one layer up, and `tests/tier1/sync-family.test.js` asserts it of
//     this file's exports too. Admission was authorized by the invite the admin issued and can
//     revoke. Delivery is not a second gate (ADR 002 §7.1 step 4).
//   · **It never invents a recipient.** Every recipient and every admissible sender comes from
//     `familyRecipients()` / `personalRecipients()` — barrier 2's two branded constructors — over
//     the relay's own member list, and every attestation in it is verified under its housing
//     member's `RK_sig` before a byte is wrapped to it or accepted from it.
//   · **It never uses `rotateSpace()`.** See `WHY NOT rotateSpace` at the rotation section: that
//     helper puts the new key into the ring BEFORE the POST, which is right for the failure it
//     was written against and catastrophic for the one this file actually meets — a losing racer
//     in a two-device family would hold a private epoch `e+1` that nobody else has, and
//     `KeyRing.put`'s first-write-wins would then REFUSE the real `e+1` for the life of the
//     install. Reported, not worked around silently.

import {
  familyRecipientsReport, personalRecipients, admissibleSenders, admitWraps,
  parseKeysResponse, buildRotation, rotationBody, createSpaceKey,
  spaceKindOf, isSpaceId, SPACE_KIND, FIRST_EPOCH, rotatesOn, recoveryRecipientId,
} from '../crypto/spacekeys.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Errors, verdicts and the honesty note
// ─────────────────────────────────────────────────────────────────────────────

export class KeyDeliveryError extends Error {
  /** @param {string} message @param {string} [kind] */
  constructor(message, kind = 'config') {
    super(message);
    this.name = 'KeyDeliveryError';
    this.kind = kind;
  }
}

/**
 * Every answer `deliver()` can give, as data. A verb with five silent no-ops is a verb nobody can
 * debug from a diagnostics pane, and D9's whole failure mode is *nothing happening quietly*.
 */
export const DELIVERY = Object.freeze({
  /** Every recipient in the roster is provably covered. The steady state, and the quiet one. */
  COVERED: 'covered',
  /** Wraps for epochs 1..e+1 were built for everyone and the relay took them. */
  DELIVERED: 'delivered',
  /** This device holds no complete ring, so it has nothing to hand over. A joiner, waiting. */
  NO_RING: 'noRing',
  /** Somebody else rotated first. Their wraps cover the same recipients; nothing more is owed. */
  RACED: 'raced',
  /** The relay refused the rotation. Reported with its body — never retried in a loop. */
  REFUSED: 'refused',
  /** The roster could not be read. Not an error the user needs: the next sync asks again. */
  UNREACHABLE: 'unreachable',
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT A ROTATION DOES AND WHAT IT CANNOT DO — story 20.2, ADR 002 §4, Addendum §6.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * This constant exists so that the honest sentence is in the CODE and not only in the copy, and
 * so a UI writing that sentence has one place to read it from rather than inventing a second.
 *
 *   `cutsOff`   everything sealed under epoch `e+1` and after. The removed member is not a
 *               recipient of the new key, the relay deletes every wrap they hold for EVERY epoch
 *               in the same transaction (§4.2 step 4), and no honest device will ever wrap to
 *               them again.
 *   `cannotUndo` **every op they already hold.** They pulled it, they opened it, it is on their
 *               disk. No epoch bump reaches backwards into another person's Mac. Saying otherwise
 *               in the UI would be a promise the mathematics does not make, and the Addendum says
 *               it in four words: *unsharing is not unremembering.*
 *
 * `tests/tier1/sync-family.test.js` asserts that these two sentences are both present and that
 * the second one is not softened, because the temptation to soften it is what turns a true
 * product into a lying one.
 */
export const ROTATION_HONESTY = Object.freeze({
  cutsOff: 'every op sealed from the new epoch onward',
  cannotUndo: 'every op they have already pulled and opened is on their Mac and stays there',
  de: 'Ab jetzt sieht diese Person nichts Neues mehr. Was sie bis heute schon geladen hat, '
    + 'bleibt auf ihrem Mac — das lässt sich nicht zurückholen.',
  en: 'From now on this person sees nothing new. What they already downloaded stays on their '
    + 'Mac — that cannot be taken back.',
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Small total helpers
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {{status:number, json:any}} normalised, never throwing on shape. */
function normalize(res) {
  const status = res && Number.isInteger(res.status) ? res.status : 0;
  const json = res && 'json' in (res || {}) ? res.json : (res ? res.body : null);
  return { status, json };
}

const errorOf = (r) => (r.json && typeof r.json.error === 'string' ? r.json.error : null);

/** ADR 002 §4.4: an epoch is a positive safe integer, and anything else is not one. */
const isEpoch = (n) => Number.isSafeInteger(n) && n >= FIRST_EPOCH;

// ─────────────────────────────────────────────────────────────────────────────
// 2. The engine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} KeyDeliveryDeps
 * @property {{request:Function}} transport
 * @property {string} spaceId               `fsp_…` or `psp_…` — the KIND decides the two
 *                                          constructors, and nothing else in here branches on it
 * @property {Object} ring                  `createKeyRing()`
 * @property {CryptoKey} myKexPriv          this device's `IK_kex` private key
 * @property {{memberId:string, deviceId:string, deviceShort:string}} me
 * @property {CryptoKey} [myRecoveryKexPriv] `RK_kex` — opens the `rec_<memberId>` rows (§7.3 A2)
 * @property {() => number} now             injected; `src/js/sync/` reads no clock
 * @property {(m:string) => void} [warn]
 * @property {(epoch:number, key:CryptoKey) => Promise<void>|void} [saveKey]  durable custody
 * @property {{load:Function, save:Function}} [coverStore]  the coverage proof, across launches
 * @property {(r:Object) => void} [onAdmit]  fired once per `admit()` that changed the ring
 * @property {Object} [personalIdentity]    what `personalRecipients()` needs, for a `psp_` space
 * @property {SubtleCrypto} [subtle] @property {(n:number)=>Uint8Array} [random]
 */

/**
 * @param {KeyDeliveryDeps} deps
 */
export function createKeyDelivery(deps) {
  const d = deps || {};
  const { spaceId } = d;
  if (!isSpaceId(spaceId)) {
    throw new KeyDeliveryError(`key delivery: spaceId must be a psp_… or fsp_… id, got ${JSON.stringify(spaceId)}`);
  }
  const kind = spaceKindOf(spaceId);
  if (!d.transport || typeof d.transport.request !== 'function') {
    throw new KeyDeliveryError('key delivery: `transport` must implement request(method, path, query, body, headers)');
  }
  if (!d.ring || typeof d.ring.currentEpoch !== 'function' || typeof d.ring.put !== 'function') {
    throw new KeyDeliveryError('key delivery: `ring` must be a KeyRing from crypto/spacekeys.js');
  }
  if (!d.myKexPriv) {
    throw new KeyDeliveryError('key delivery: `myKexPriv` is required — a wrap is opened with this device\'s IK_kex');
  }
  const me = d.me || {};
  for (const f of ['memberId', 'deviceId', 'deviceShort']) {
    if (typeof me[f] !== 'string' || me[f] === '') {
      throw new KeyDeliveryError(`key delivery: me.${f} is required — a recipient is addressed by deviceId (E2E3-1)`);
    }
  }
  if (typeof d.now !== 'function') {
    throw new KeyDeliveryError('key delivery: `now` is an injected port — src/js/sync/ reads no clock');
  }

  const ring = d.ring;
  const ports = { subtle: d.subtle, random: d.random };
  const warn = typeof d.warn === 'function' ? d.warn : () => {};

  // ── §4 · THE COVERAGE PROOF ─────────────────────────────────────────────────────────────────
  //
  // THE QUESTION THIS ANSWERS, AND WHY THE RELAY CANNOT BE ASKED IT.
  //
  // `deliver()` has to decide "is there a recipient here who does not hold the ring?" and there
  // is no route that answers it: `GET /spaces/:id/keys` returns MY OWN wraps and nobody else's,
  // deliberately — a route that told any member which of the others were still waiting would be a
  // route that told a relay-side observer the same thing. So the answer has to be DERIVED, and
  // the derivation has to be SOUND, because both errors are bad in different ways: a false
  // "covered" leaves Mom's board empty for ever (D9's exact failure), and a false "uncovered"
  // makes every device in the family rotate on every poll.
  //
  // THE ONE FACT THAT MAKES IT DERIVABLE. `server/core/handlers/spaces.js` runs `assertCoverage`
  // INSIDE the rotation transaction, against the member and device rows as they stand AT COMMIT
  // TIME, and it refuses the rotation unless every required recipient holds every epoch `1..e`.
  // So coverage is not a hope about other clients — it is a server-enforced invariant, and
  // observing that an epoch EXISTS is observing that it held.
  //
  // THE INFERENCE, STATED PRECISELY:
  //
  //     If I read the roster R at a moment when the space was at epoch E,
  //     and I later read that the space is at epoch E' > E,
  //     then the rotation that produced E' committed AFTER my read,
  //     so every recipient in R existed at its commit,
  //     so every recipient in R holds epochs 1..E'.
  //
  // That is why two slots are kept rather than one. `seen` is the roster read BEFORE a bump;
  // `proof` is what a bump turns it into. A recipient that appears in the SAME response as the
  // new epoch is deliberately NOT proven — it may have joined a millisecond after the rotation
  // committed, which is exactly the case a one-slot design gets wrong and never notices.
  //
  // WHAT IT COSTS WHEN IT HAS NOTHING. A device with no persisted proof — a fresh install, a
  // cleared `localStorage`, a Mac paired in yesterday — cannot prove anything about anybody, so
  // its first successful sync rotates once. That is not a regression: ADR 002 §4.1 rotates on a
  // device joining a space anyway. It happens ONCE per device, because the rotation it performs
  // is itself the proof, and it is written down.
  /** @type {{epoch:number, ids:string[]}|null} */
  let seen = null;
  /** @type {{epoch:number, ids:string[]}|null} */
  let proof = null;
  let proofLoaded = false;

  async function loadProof() {
    if (proofLoaded) return;
    proofLoaded = true;
    if (!d.coverStore || typeof d.coverStore.load !== 'function') return;
    try {
      const raw = await d.coverStore.load(spaceId);
      if (raw && isEpoch(raw.epoch) && Array.isArray(raw.ids)) {
        proof = { epoch: raw.epoch, ids: raw.ids.filter((x) => typeof x === 'string') };
      }
      if (raw && raw.seen && isEpoch(raw.seen.epoch) && Array.isArray(raw.seen.ids)) {
        seen = { epoch: raw.seen.epoch, ids: raw.seen.ids.filter((x) => typeof x === 'string') };
      }
    } catch (e) {
      // A proof that cannot be read costs one extra rotation, never a lost key. Warn, continue.
      warn(`keys: the coverage record could not be read (${e && e.message}); this device will re-deliver once`);
    }
  }

  async function saveProof() {
    if (!d.coverStore || typeof d.coverStore.save !== 'function') return;
    try { await d.coverStore.save(spaceId, { ...(proof || { epoch: 0, ids: [] }), seen }); }
    catch { /* the next launch re-delivers once; that is the whole cost */ }
  }

  /**
   * Fold one roster reading into the two slots. Pure except for the two `let`s it owns.
   * @param {number} epoch the `currentEpoch` THIS RESPONSE carried
   * @param {string[]} ids the recipient ids THIS RESPONSE carried
   */
  function observe(epoch, ids) {
    if (!isEpoch(epoch)) return;
    if (seen !== null && epoch > seen.epoch) {
      // The bump happened after `seen` was read — see the inference above. Everything in that
      // snapshot is now covered, and the ids in THIS response are not (they may be newer).
      proof = { epoch, ids: [...new Set(seen.ids)].sort() };
    }
    seen = { epoch, ids: [...new Set(ids)].sort() };
  }

  /** Ids in the current roster this device cannot prove hold the ring. */
  function uncovered(epoch, ids) {
    const held = proof !== null && proof.epoch === epoch ? new Set(proof.ids) : new Set();
    return ids.filter((id) => !held.has(id)).sort();
  }

  /** A rotation I performed is a proof about exactly the recipients I wrapped to. */
  function proveMine(epoch, ids) {
    proof = { epoch, ids: [...new Set(ids)].sort() };
    seen = { epoch, ids: proof.ids };
  }

  // ── the roster ──────────────────────────────────────────────────────────────────────────────

  /**
   * `GET /api/v1/spaces/:id/members` — ADR 002 §4.2 step 6's bootstrap roster, and the ONE input
   * both halves of this file take.
   *
   * ⚠ **IT IS RELAY COORDINATION DATA AND IT IS TREATED AS SUCH.** The ADR is explicit that a
   * device's first family sync holds no epoch key, so it cannot fold the family stream and its
   * roster cannot come from the log. Everything that MATTERS in it is self-checking: every device
   * attestation is verified under its housing member's `recoveryPubSig` inside
   * `familyRecipients()`/`admissibleSenders()`, so a relay that wants an admission has to invent a
   * whole MEMBER — which appears in the member list (15.4) as somebody nobody invited. That is
   * ADR 002 §8.5's already-accepted, UI-surfaceable phantom member. It is not nothing, and it is
   * not this file's to close: §4.2 step 6's own "bootstrap residual" paragraph owns it.
   */
  async function roster() {
    const res = normalize(await d.transport.request(
      'GET', `/api/v1/spaces/${spaceId}/members`, undefined, undefined, {}));
    if (res.status !== 200 || !res.json) {
      return { ok: false, status: res.status, error: errorOf(res), members: [], currentEpoch: null };
    }
    const members = Array.isArray(res.json.members) ? res.json.members : [];
    const currentEpoch = isEpoch(res.json.currentEpoch) ? res.json.currentEpoch : null;
    // ── THE ROSTER IS ALSO THE ATTESTATION SOURCE, AND IT IS THE ONLY FRESH ONE ────────────────
    //
    // ADR 002 §4.2 step 6 makes this response the source of the SENDER SET; it is equally the
    // source of `openOp`'s P1 table (deviceShort → attestation) and of `foldAuthorized` stage
    // 0a's `attestOpen`. Both of those used to be seeded ONCE, at engine start.
    //
    // Measured, three Macs: Papa's engine started when he was alone. Mama joined afterwards, and
    // her ops parked on P1 (`attestation`) on his Mac **for the rest of the launch** — he had no
    // attestation for a device that did not exist when he last looked. A member who joins while
    // somebody's app is open is the normal case, not an edge one, so a table refreshed only at
    // launch is a table that is wrong exactly when it matters.
    //
    // It hangs off `roster()` rather than off `admit()` so that `deliver()` and `rotate()` — which
    // read the roster too — refresh it as well, and so there is no second GET.
    if (typeof d.onRoster === 'function') {
      try { await d.onRoster(members); }
      catch { /* a table that could not be rebuilt leaves the previous one standing (fail-safe) */ }
    }
    return { ok: true, status: 200, error: null, members, currentEpoch };
  }

  /**
   * The roster → the branded `Recipient[]`, through barrier 2's constructors and NO OTHER PATH.
   *
   * A `psp_` space reads MY OWN identity instead, because `personalRecipients()` refuses a device
   * whose `memberId` is not mine — which is what makes "a family list can never be wrapped into
   * the personal space" a refusal rather than a convention (ADR 002 §11 rule 10).
   */
  function recipientsFrom(members) {
    if (kind === SPACE_KIND.FAMILY) return familyRecipientsReport(members);
    if (!d.personalIdentity) {
      throw new KeyDeliveryError(
        `key delivery: ${spaceId} is a PERSONAL space, so the recipient list is my own identity `
        + 'and not a relay roster. Pass `personalIdentity` (ADR 002 §3 barrier 2, §11 rule 10).');
    }
    return { recipients: personalRecipients(d.personalIdentity), removed: [], missingRecoveryKex: [] };
  }

  // ── STEPS 5 AND 6 · admit ───────────────────────────────────────────────────────────────────

  const stats = {
    admits: 0, admittedEpochs: 0, deliveries: 0, rotations: 0, refusedRows: 0, unauthorizedRows: 0,
    lastError: null, lastDelivery: null, keysPending: true, currentEpoch: null,
    /** Finding E2E3-8's price, per member, surfaced rather than swallowed. See `deliver()`. */
    missingRecoveryKex: [],
  };

  /**
   * ADR 002 §7.1 steps 5 and 6, and §4.2 step 6 — **the receiving side of the check**.
   *
   * THE ORDER HERE IS THE WHOLE OF FINDING S1'S FIX AND IT IS NOT REARRANGEABLE:
   *
   *   1. the ROSTER, so there is a set of devices this space may accept a key FROM at all;
   *   2. `admissibleSenders()`, which runs every one of them through the WRAPPING side's own
   *      `recipientProblem()` — brand, attestation, `att.kexPubRaw === kexPubRaw` — and indexes
   *      the `CryptoKey`s IT imported;
   *   3. only then `admitWraps`, where `row.senderKexPubRaw` is an INDEX into that set. The row
   *      selects a sender; it can never supply one, and no byte the relay sent reaches
   *      `deriveBits`.
   *
   * The `rec_<memberId>` rows are split out and opened with `RK_kex` when this device holds it
   * (ADR 002 §7.3 step 6 — the A2 path, the only one that survives losing every device). Without
   * it they are left alone rather than thrown at the device key, because a wrap that will not
   * open is counted as `refused` and a permanently-refused row on every poll is an alarm that
   * means nothing.
   *
   * @returns {Promise<{ok:boolean, admitted:number[], keysPending:boolean, currentEpoch:number|null,
   *                    refused:number, unauthorized:number, dropped:number, status:number,
   *                    error:string|null}>}
   */
  async function admit() {
    await loadProof();
    const list = await roster();
    if (!list.ok) {
      stats.lastError = { at: 'members', status: list.status, error: list.error };
      return {
        ok: false, admitted: [], keysPending: stats.keysPending, currentEpoch: stats.currentEpoch,
        refused: 0, unauthorized: 0, dropped: 0, status: list.status, error: list.error,
      };
    }

    const res = normalize(await d.transport.request(
      'GET', `/api/v1/spaces/${spaceId}/keys`, undefined, undefined, {}));
    if (res.status !== 200) {
      stats.lastError = { at: 'keys', status: res.status, error: errorOf(res) };
      return {
        ok: false, admitted: [], keysPending: stats.keysPending, currentEpoch: list.currentEpoch,
        refused: 0, unauthorized: 0, dropped: 0, status: res.status, error: errorOf(res),
      };
    }

    const parsed = parseKeysResponse(res.json);
    stats.keysPending = parsed.keysPending;
    stats.currentEpoch = parsed.currentEpoch ?? list.currentEpoch;
    // The roster and the epoch, folded into the proof BEFORE anything is wrapped or admitted, so
    // a `deliver()` in the same pass reads a proof that includes this observation.
    const report = recipientsFrom(list.members);
    observe(list.currentEpoch ?? parsed.currentEpoch, report.recipients.map((r) => r.deviceId));

    const senders = await admissibleSenders(report.recipients, spaceId, ports);

    const mine = [];
    const recovery = [];
    for (const row of parsed.rows) {
      if (row.recipientId === recoveryRecipientId(me.memberId)) recovery.push(row);
      else mine.push(row);
    }

    const out = await admitWraps(ring, mine, {
      ...ports, spaceId, myKexPriv: d.myKexPriv, senders,
    });
    let admitted = out.admitted;
    let refused = out.refused;
    let unauthorized = out.unauthorized;

    if (recovery.length && d.myRecoveryKexPriv) {
      const rec = await admitWraps(ring, recovery, {
        ...ports, spaceId, myKexPriv: d.myRecoveryKexPriv, senders,
      });
      admitted = [...new Set([...admitted, ...rec.admitted])].sort((a, b) => a - b);
      refused += rec.refused;
      unauthorized += rec.unauthorized;
    }

    stats.admits += 1;
    stats.admittedEpochs += admitted.length;
    stats.refusedRows += refused;
    stats.unauthorizedRows += unauthorized;
    if (unauthorized > 0) {
      // "A stranger tried to give me a key" is a security event and "a wrap did not open" is not.
      // It is REPORTED and never fatal: the ops stay parked, which is the correct state (§4.4).
      warn(`keys: ${unauthorized} wrap row(s) for ${spaceId} named a sender this space does not `
        + 'admit. They were refused before any key was derived (ADR 002 §4.2 step 6, finding S1).');
    }

    if (admitted.length) {
      for (const epoch of admitted) {
        if (typeof d.saveKey === 'function') {
          try { await d.saveKey(epoch, ring.get(spaceId, epoch)); }
          catch (e) { warn(`keys: epoch ${epoch} was admitted but could not be stored (${e && e.message}); it will be re-fetched`); }
        }
      }
      if (typeof d.onAdmit === 'function') {
        try { d.onAdmit({ spaceId, admitted, currentEpoch: stats.currentEpoch }); }
        catch { /* a listener that throws may not cost a key */ }
      }
    }
    await saveProof();

    return {
      ok: true,
      admitted,
      keysPending: parsed.keysPending,
      currentEpoch: stats.currentEpoch,
      refused,
      unauthorized,
      dropped: parsed.dropped,
      status: 200,
      error: null,
    };
  }

  // ── STEP 4 · deliver ────────────────────────────────────────────────────────────────────────

  /**
   * ADR 002 §7.1 step 4 — **any existing member device wraps the current ring to a member who
   * does not hold it, on its next ordinary sync.**
   *
   * The four gates, in the order they are cheapest to answer:
   *
   *   1. the ROSTER must read. Unreachable is not an error worth a sentence (19.3) — the next
   *      poll asks again.
   *   2. this device must HOLD THE WHOLE RING `1..E`. A joiner between §7.1 steps 2 and 6 holds
   *      nothing and must not try: `wrapRingToRecipients` would throw by design rather than build
   *      a partial ring, and a device that cannot deliver is the one WAITING for delivery.
   *   3. there must be an UNCOVERED recipient (§4 above). This is the gate that keeps a settled
   *      family silent — the steady state is `COVERED`, on every poll, for ever.
   *   4. the rotation must be ACCEPTED. A racer that lost gets `409 epoch_taken` or
   *      `400 not_next`, which are both the same news — somebody else did it, and their wraps
   *      cover the same recipients — so the proof is re-derived and this pass stops.
   *
   * WHY THE DELIVERY IS A ROTATION AND NOT A BARE WRAP PUSH. There is no route that deposits a
   * wrap outside space creation and epoch rotation, and there should not be: a route that let any
   * member add a `KeyWrap` row for an existing epoch would be a route that let any member add a
   * key row for a recipient of their choosing, with no coverage check and no epoch bump to make
   * it visible. ADR 002 §4.1 already REQUIRES a rotation when a member joins ("so a leaked,
   * already-redeemed invite yields a superseded key"), and `POST /spaces/:id/epoch` carries wraps
   * for epochs `1..e+1` in one transaction. So the mechanism the ADR specifies for §4.1 IS the
   * delivery mechanism for §7.1 step 4, and building a second one would have been building a
   * weaker one.
   *
   * @param {{reason?:string}} [opts]
   * @returns {Promise<{verdict:string, epoch:number|null, recipients:string[], uncovered:string[],
   *                    status:number|null, error:string|null, detail:string|null}>}
   */
  async function deliver(opts = {}) {
    await loadProof();
    const list = await roster();
    if (!list.ok) {
      stats.lastDelivery = DELIVERY.UNREACHABLE;
      return verdict(DELIVERY.UNREACHABLE, null, [], [], list.status, list.error, null);
    }
    const at = list.currentEpoch;
    const report = recipientsFrom(list.members);
    const ids = report.recipients.map((r) => r.deviceId);
    observe(at, ids);
    await saveProof();

    if (report.missingRecoveryKex.length && kind === SPACE_KIND.FAMILY) {
      // Finding E2E3-8's price, surfaced rather than swallowed: those members have no wrap to
      // their recovery key, so §7.3's A2 recovery of the FAMILY space waits for somebody else's
      // next rotation. `familyRecipients()`'s header is the argument for why that is the right
      // side of the trade; this line is what stops it being invisible.
      stats.missingRecoveryKex = report.missingRecoveryKex.slice();
    }

    if (!isEpoch(at)) {
      return verdict(DELIVERY.UNREACHABLE, null, ids, [], list.status, 'no_epoch', null);
    }
    if (!ring.covers(spaceId, at)) {
      // The joiner's own state, named. `missing` is what the waiting screen is about.
      return verdict(DELIVERY.NO_RING, at, ids, [], null, null,
        `this device holds epochs [${ring.epochs(spaceId).join(', ')}] of 1..${at}`);
    }
    const owed = uncovered(at, ids);
    if (owed.length === 0) return verdict(DELIVERY.COVERED, at, ids, [], null, null, null);

    return rotateTo(at + 1, report.recipients, ids, owed, opts.reason || 'delivery');
  }

  // ── §4.1 · rotate ───────────────────────────────────────────────────────────────────────────

  /**
   * A membership change mints a new epoch (ADR 002 §4.1, story 20.2, T2).
   *
   * `rotatesOn(event)` is the table and it **THROWS on an unlisted event** — a name nobody wrote
   * down must not default to "no rotation", which is a silent security downgrade no test would
   * notice. It also refuses an event whose space kind is not this one: `device.pair` rotates the
   * PERSONAL space and `member.remove` the FAMILY one, and a caller that mixes them up is asking
   * for the wrong key to be replaced.
   *
   * @param {string} event one of `ROTATION_TRIGGERS`
   */
  async function rotate(event) {
    await loadProof();
    const row = rotatesOn(event);
    if (!row.rotate) {
      return verdict(DELIVERY.COVERED, stats.currentEpoch, [], [], null, null,
        `${event} does not rotate: ${row.why}`);
    }
    if (row.space !== kind) {
      throw new KeyDeliveryError(
        `key delivery: ${JSON.stringify(event)} rotates the ${row.space} space (ADR 002 §4.1) and `
        + `this delivery is bound to ${spaceId}, which is ${kind}. The two scopes are disjoint.`);
    }
    const list = await roster();
    if (!list.ok) return verdict(DELIVERY.UNREACHABLE, null, [], [], list.status, list.error, null);
    const at = list.currentEpoch;
    const report = recipientsFrom(list.members);
    const ids = report.recipients.map((r) => r.deviceId);
    observe(at, ids);
    if (!isEpoch(at)) return verdict(DELIVERY.UNREACHABLE, null, ids, [], list.status, 'no_epoch', null);
    if (!ring.covers(spaceId, at)) {
      return verdict(DELIVERY.NO_RING, at, ids, ids, null, null,
        'a device that does not hold the ring cannot rotate it — ask a device that does');
    }
    return rotateTo(at + 1, report.recipients, ids, ids, event);
  }

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   * THE ROTATION ITSELF — and **WHY NOT `rotateSpace()`**, which is a real finding, not a style.
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   *
   * `crypto/spacekeys.js` ships `rotateSpace({ring, …})`, whose docblock argues — correctly, for
   * the failure it has in mind — that the new key must enter the ring BEFORE the wraps are built,
   * so "a rotation that fails half way leaves a device that can still read what it just sealed".
   *
   * That ordering is **wrong for the failure this file actually meets**, and the difference is a
   * permanent lockout rather than a lost afternoon. `POST /spaces/:id/epoch` is first-writer-wins
   * (`@@unique([spaceId, epoch])`), and a two-device family under D9 has BOTH devices trying to
   * deliver to the same joiner — that is the point of "any member device, not only the admin's",
   * so the race is the DESIGNED case and not an edge. The loser gets `409 epoch_taken` with a
   * private `FSK_{e+1}` already in its ring, and `KeyRing.put` is first-write-wins too: when the
   * winner's real `e+1` arrives through `GET /keys`, `admitWraps` sees an occupied slot, counts a
   * `duplicate`, and this device can never open an op sealed under the epoch the rest of its
   * family is using. For ever, silently, on the honest path.
   *
   * So the order here is **mint → build → POST → put**, and the failure it trades into is
   * recoverable by construction: a crash between the POST and the local `put` loses a key whose
   * wrap is addressed to THIS DEVICE and sitting on the relay, so the very next `admit()` fetches
   * it back. Nothing was sealed under it in between — this device does not seal into an epoch it
   * has not stored.
   *
   * **REPORTED to `crypto/spacekeys.js`'s owner:** `rotateSpace()` cannot be used by any caller
   * that can lose a race, which is every family caller. Either it grows a rollback (`ring.drop`
   * does not exist, deliberately — a ring that can forget an epoch can forget the history), or it
   * is documented as the SOLO-ROTATOR helper it actually is. This file does not call it and says
   * why rather than quietly not calling it.
   */
  async function rotateTo(next, recipients, ids, owed, why) {
    const keys = new Map(ring.keysByEpoch(spaceId));
    const key = await createSpaceKey(ports);
    keys.set(next, key);

    let rotation;
    try {
      rotation = await buildRotation(spaceId, next, keys, d.myKexPriv, recipients, [], ports);
    } catch (e) {
      // `wrapRingToRecipients` refuses to build a partial ring, and `assertRecipients` refuses a
      // recipient whose attestation does not verify. Both are REFUSALS on this device, with the
      // key material still here, and both are exactly what should stop a delivery.
      stats.lastDelivery = DELIVERY.REFUSED;
      return verdict(DELIVERY.REFUSED, next, ids, owed, null, 'build_failed', e.message);
    }

    const res = normalize(await d.transport.request(
      'POST', `/api/v1/spaces/${spaceId}/epoch`, undefined, rotationBody(rotation), {}));

    if (res.status === 200) {
      // The relay took it, so the coverage check passed: every required recipient now holds
      // 1..next. THAT is the proof, and it is written down before anything else happens.
      if (!ring.put(spaceId, next, key)) {
        // Unreachable on an honest path — `next` is `ring.currentEpoch + 1` by construction — and
        // it is not silently ignored: a refused put means this device is about to seal into an
        // epoch it did not store.
        warn(`keys: the ring already held ${spaceId} epoch ${next}; the rotation this device just `
          + 'published is not the key it holds. Re-fetching.');
      } else if (typeof d.saveKey === 'function') {
        try { await d.saveKey(next, key); }
        catch (e) { warn(`keys: epoch ${next} was published but could not be stored (${e && e.message}); it will be re-fetched from the relay`); }
      }
      proveMine(next, ids);
      await saveProof();
      stats.rotations += 1;
      stats.deliveries += 1;
      stats.currentEpoch = next;
      stats.lastDelivery = DELIVERY.DELIVERED;
      if (typeof d.onAdmit === 'function') {
        try { d.onAdmit({ spaceId, admitted: [next], currentEpoch: next }); }
        catch { /* as above */ }
      }
      return verdict(DELIVERY.DELIVERED, next, ids, owed, 200, null, `${why}: ${rotation.wraps.length} wraps for epochs 1..${next}`);
    }

    const code = errorOf(res);
    if (code === 'epoch_taken' || (code === 'bad_request' && res.json && res.json.reason === 'not_next')) {
      // SOMEBODY ELSE GOT THERE FIRST, which is the designed outcome of "any member device"
      // rather than a failure. Their rotation passed the same coverage check over the same rows,
      // so the recipients this device was worried about are covered by their wraps. The next
      // `admit()` fetches the epoch; nothing is retried here, because retrying at `e+2` would be
      // two devices climbing the epoch ladder against each other.
      const at = isEpoch(res.json && res.json.currentEpoch) ? res.json.currentEpoch : next;
      proveMine(at, [...new Set([...ids, ...owed])]);
      await saveProof();
      stats.lastDelivery = DELIVERY.RACED;
      return verdict(DELIVERY.RACED, at, ids, owed, res.status, code, 'another member device rotated first');
    }

    stats.lastDelivery = DELIVERY.REFUSED;
    stats.lastError = { at: 'epoch', status: res.status, error: code };
    warn(`keys: the relay refused this device's key delivery for ${spaceId} (${res.status} ${code}). `
      + 'Nothing was published and the ring is unchanged; the next sync tries again.');
    return verdict(DELIVERY.REFUSED, next, ids, owed, res.status, code,
      res.json && res.json.missingCount ? `incomplete coverage: ${res.json.missingCount} missing` : null);
  }

  function verdict(v, epoch, recipients, owed, status, error, detail) {
    return { verdict: v, epoch, recipients, uncovered: owed, status, error, detail };
  }

  return {
    spaceId,
    kind,
    admit,
    deliver,
    rotate,
    roster,
    /** The proof, read-only, so a diagnostics pane can show why a device is or is not delivering. */
    coverage: () => ({
      proof: proof ? { epoch: proof.epoch, ids: [...proof.ids] } : null,
      seen: seen ? { epoch: seen.epoch, ids: [...seen.ids] } : null,
      durable: !!(d.coverStore && typeof d.coverStore.save === 'function'),
    }),
    diagnostics: () => ({
      spaceId,
      kind,
      epochs: ring.epochs(spaceId),
      currentEpoch: stats.currentEpoch,
      keysPending: stats.keysPending,
      coverage: proof ? { epoch: proof.epoch, count: proof.ids.length } : null,
      ...stats,
    }),
  };
}

/**
 * The recipient ids a space's roster names, without building a single `Recipient`.
 *
 * `membersui.js` and the waiting screen both want to say how many devices are in the circle, and
 * neither should have to run five attestation verifications to count to three. It is deliberately
 * NOT a shortcut into `deliver()`: nothing here is verified, so nothing here may decide anything.
 *
 * @param {Array<Object>} members
 * @returns {string[]}
 */
export function rosterDeviceIds(members) {
  const out = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.removedAt !== undefined && m.removedAt !== null) continue;
    for (const dev of Array.isArray(m.devices) ? m.devices : []) {
      if (!dev || typeof dev.deviceId !== 'string') continue;
      if (dev.revokedAt !== undefined && dev.revokedAt !== null) continue;
      out.add(dev.deviceId);
    }
  }
  return [...out].sort();
}
