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
// record** (§4 below) — the recipients this device has ITSELF handed the whole ring to. `admit`
// is where the epoch is learned, `deliver` is where the record is read, and `rotate` is where it
// is written. Splitting them would put the record in a fourth place, and a coverage question with
// two answers is how a family ends up with a member whose board never fills in.
//
// It is a record of what THIS DEVICE DID and never an inference from what the relay reports, and
// that distinction is finding **T5-K1** — the one hole in this file a hostile member could open
// and hold open for ever. §4 has the whole of it.
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
 * @property {{load:Function, save:Function}} [coverStore]  the coverage record, across launches
 * @property {(r:Object) => void} [onAdmit]  fired once per `admit()` that changed the ring AND
 *                                          left it WHOLE — D9's waiting state clears on coverage,
 *                                          never on an epoch count (finding T5-K2)
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

  // ── §4 · THE COVERAGE RECORD ────────────────────────────────────────────────────────────────
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
  // ═══ WHAT THIS SECTION USED TO CLAIM, AND WHY IT WAS FALSE — finding T5-K1 ═══════════════════
  //
  // It used to read the relay's coverage check as a statement about KEYS, in these words:
  //
  //     "coverage is not a hope about other clients — it is a server-enforced invariant, and
  //      observing that an epoch EXISTS is observing that it held."
  //
  // `server/core/handlers/spaces.js#assertCoverage` counts `(recipientId, epoch)` ROWS. It cannot
  // open a wrap and must not try, so an epoch EXISTS as soon as the rows exist — whatever is in
  // them. ADR 002 §4.2's "two server-enforced checks" now says that in the ADR too, and
  // `assertCoverage`'s own docblock says it at the place where the counting happens.
  //
  // The red team spent one ordinary member's ordinary API access on the gap. Eve rotates first,
  // with genuine wraps for herself and for Papa and **well-formed garbage for the joiner**. The
  // relay takes it: every required row exists. Papa's honest delivery then loses the race, reads
  // `409 epoch_taken` as *"their wraps cover the same recipients"*, and writes a DURABLE record
  // saying the joiner holds a ring she cannot open. From that moment no honest device in the
  // family delivers to her again: empty board, no warning, no error state, for the life of the
  // install. Deleting the `RACED` branch's claim did not help — `observe()`'s inference (*"the
  // epoch bumped, so everyone I saw at the old epoch is covered"*) wrote the same false record one
  // tick later, from the other end.
  //
  //     THE ROOT: AN EPOCH BUMP IS NOT EVIDENCE THAT THE BUMP DELIVERED A USABLE KEY.
  //
  // Everything above the line — the inference, the two slots, the "a recipient that appears in the
  // SAME response is deliberately not proven" refinement — was a careful derivation from a premise
  // that is not true. It is deleted rather than tightened.
  //
  // ═══ WHAT IT CLAIMS NOW — THREE SOURCES, EACH ABOUT KEYS ════════════════════════════════════
  //
  // A recipient is covered when, and only when, one of these is true. Each is a fact about a KEY
  // somebody demonstrably held, and none of them is an inference from an epoch number.
  //
  //   1. **I DELIVERED TO IT.** This device itself wrapped the whole ring `1..e` to it and the
  //      relay accepted the rotation. `recordDelivery()` is the only writer, it is called from
  //      exactly one place — the `200` arm of `rotateTo` — and `observe()` now only ever REMOVES
  //      ids.
  //   2. **IT DELIVERED TO ME.** `ring.originOf(space, epoch)` names the device whose wrap this
  //      device OPENED to get that epoch's key (`how: 'admitted'`, finding S1's provenance). A
  //      wrap only opens when the KEK derived against that device's own verified `IK_kex` public
  //      key produces a valid AEAD tag, so a device named there **provably held that key**. If it
  //      handed me every epoch of `1..e`, it holds the whole ring and is owed nothing. This is
  //      the ordinary D9 flow read backwards: the joiner does not re-deliver to the member who
  //      just delivered to her.
  //   3. **IT IS ME.** Gate 2 of `deliver()` measured it — this pass does not get as far as the
  //      coverage question unless `ring.covers(spaceId, at)`.
  //
  // Not an epoch bump. Not a lost race. Not a roster that stopped changing. Note what source 2 is
  // NOT: it is a statement about the SENDER of a wrap, never about its other recipients. Eve's
  // genuine wrap to Papa proves Eve holds the key; it proves exactly nothing about the joiner Eve
  // wrapped garbage to, which is the whole of T5-K1 and the reason the epoch bump could not be
  // read as coverage in the first place. A relay that mis-stamps a sender cannot manufacture a
  // witness either: the KEK is derived against the STAMPED device's public key, so a lie there
  // produces a refusal (§4.2 step 6's "what the relay can do with it, exactly: lie").
  //
  // WHY THAT IS STILL QUIET, WHICH IS THE HALF THAT IS EASY TO GET WRONG. The record is a SET OF
  // RECIPIENTS and not a claim pinned to one epoch, so a rotation performed by somebody else does
  // not invalidate it. If the record were epoch-keyed — "everyone I delivered to, AT epoch e" —
  // then every honest rotation by any device would stale every other device's record, and three
  // Macs would climb the epoch ladder against each other for ever, on the honest path, with
  // nobody attacking. That is the false-"uncovered" failure at the top of this section, and it is
  // the one a fix for T5-K1 walks into. So the epoch in the record is diagnostics; the ids are the
  // record.
  //
  // WHAT IT COSTS. A device with no record — a fresh install, a cleared `localStorage`, a Mac
  // paired in yesterday, or a record written by a build from before this fix — delivers once, and
  // once per recipient it has never delivered to. That is bounded by the size of the family, it
  // converges (the rotation it performs is what fills the record in), and ADR 002 §4.1 rotates on
  // a device joining a space anyway. It is the same cost the previous design paid; the difference
  // is that this one pays it against a claim that is true.
  //
  // WHAT IT STILL DOES NOT BUY, WRITTEN DOWN RATHER THAN HOPED OVER (ADR 002 §8.5, residual
  // "member-driven denial of key delivery"). This device can prove what it delivered. It cannot
  // prove that an epoch minted by SOMEBODY ELSE reached a peer in openable form — no route tells
  // it, and none can without telling the relay the same thing. So a member who rotates with junk
  // wraps for a peer still holds that peer at a stale epoch until some device delivers again.
  // What changed is that the denial is no longer PERMANENT and no longer SILENT: the joiner is
  // covered by nobody's record, so the first honest tick hands her the whole ring, and while she
  // is held short her own Mac says so — `keysPending` stays true because it is now answered from
  // her RING (see `ringIsWhole`), her ops park, and the ladder ends in a visible error. Closing
  // the residual needs a route by which a member can say "I cannot open epoch e". Owner: ADR 003
  // and `server/core/handlers/keys.js`. Reported, not worked around silently.

  /**
   * The recipients THIS DEVICE has itself wrapped the whole ring to, with the epoch of the last
   * such delivery. **The ids are the record; the epoch is diagnostics** — see above.
   * @type {{epoch:number, ids:string[]}|null}
   */
  let delivered = null;
  /**
   * The last roster reading. **DIAGNOSTICS ONLY.** It is never promoted into `delivered`, and the
   * absence of that promotion is finding T5-K1's fix; `tests/fleet/e6-attack-keydelivery.test.js`
   * §1b pins it against the exact scenario that exploited it.
   * @type {{epoch:number, ids:string[]}|null}
   */
  let seen = null;
  let proofLoaded = false;

  /**
   * The durable record's version, and it is a version rather than a shape check on purpose.
   *
   * A v1 record could name a recipient this device never delivered to — that is finding T5-K1 —
   * so it is exactly the record an upgraded install must NOT read. Reading it would carry the
   * defect across the update, on the one device the attack had already succeeded against, and
   * nothing in the shape distinguishes a poisoned record from an honest one. Refusing it costs
   * one rotation.
   */
  const COVER_RECORD_V = 2;

  async function loadProof() {
    if (proofLoaded) return;
    proofLoaded = true;
    if (!d.coverStore || typeof d.coverStore.load !== 'function') return;
    try {
      const raw = await d.coverStore.load(spaceId);
      if (raw && raw.v !== COVER_RECORD_V) {
        warn(`keys: the coverage record for ${spaceId} was written by a build whose record could `
          + 'name a recipient this device never delivered to (finding T5-K1). It is discarded; '
          + 'this device delivers the ring once more than it had to.');
        return;
      }
      if (raw && isEpoch(raw.epoch) && Array.isArray(raw.ids)) {
        delivered = { epoch: raw.epoch, ids: raw.ids.filter((x) => typeof x === 'string') };
      }
      if (raw && raw.seen && isEpoch(raw.seen.epoch) && Array.isArray(raw.seen.ids)) {
        seen = { epoch: raw.seen.epoch, ids: raw.seen.ids.filter((x) => typeof x === 'string') };
      }
    } catch (e) {
      // A record that cannot be read costs one extra rotation, never a lost key. Warn, continue.
      warn(`keys: the coverage record could not be read (${e && e.message}); this device will re-deliver once`);
    }
  }

  async function saveProof() {
    if (!d.coverStore || typeof d.coverStore.save !== 'function') return;
    try {
      await d.coverStore.save(spaceId,
        { v: COVER_RECORD_V, ...(delivered || { epoch: 0, ids: [] }), seen });
    } catch { /* the next launch re-delivers once; that is the whole cost */ }
  }

  /**
   * Fold one roster reading in. It can only ever **shrink** the delivery record — that is the
   * whole of its authority, and the difference between this function and the one T5-K1 exploited.
   *
   * A recipient that has left the roster is dropped, so a device id that comes BACK (a revoked
   * device re-adopted, whose wraps the relay deleted in the same transaction — ADR 002 §4.2
   * step 4) is a recipient this device has not delivered to, and is delivered to again.
   *
   * @param {number} epoch the `currentEpoch` THIS RESPONSE carried
   * @param {string[]} ids the recipient ids THIS RESPONSE carried
   */
  function observe(epoch, ids) {
    const fresh = [...new Set(ids)].sort();
    if (delivered !== null) {
      const here = new Set(fresh);
      const kept = delivered.ids.filter((id) => here.has(id));
      if (kept.length !== delivered.ids.length) delivered = { epoch: delivered.epoch, ids: kept };
    }
    if (!isEpoch(epoch)) return;
    seen = { epoch, ids: fresh };
  }

  /**
   * Source 2 of §4: the devices that **handed this device every epoch of `1..at`**, read off the
   * provenance `admitWraps` stamped into the ring. A device that could wrap epoch `e` held epoch
   * `e`; a device that wrapped all of `1..at` holds the whole ring and is owed no delivery.
   *
   * The whole ring and not a majority of it: a device that gave me epochs 1 and 2 while somebody
   * else gave me 3 is a device I know nothing about at epoch 3, and the cost of being wrong is
   * D9's silent empty board. Being unsure costs one rotation.
   *
   * @param {number} at @returns {Set<string>}
   */
  function ringWitnesses(at) {
    const out = new Set();
    if (typeof ring.originOf !== 'function') return out;
    /** @type {Map<string, number>} deviceId → how many of `1..at` it handed to this device */
    const gave = new Map();
    for (let e = FIRST_EPOCH; e <= at; e++) {
      const o = ring.originOf(spaceId, e);
      if (!o || o.how !== 'admitted' || typeof o.deviceId !== 'string' || o.deviceId === '') continue;
      gave.set(o.deviceId, (gave.get(o.deviceId) || 0) + 1);
    }
    const need = at - FIRST_EPOCH + 1;
    for (const [id, n] of gave) if (n >= need) out.add(id);
    return out;
  }

  /**
   * Ids in the current roster that none of §4's three sources covers. The ONE input to `deliver()`
   * gate 3, and the only place the three are combined.
   *
   * @param {number} at the epoch the roster reported @param {string[]} ids the roster's recipients
   */
  function uncovered(at, ids) {
    const held = new Set(delivered !== null ? delivered.ids : []);   // 1 · I delivered to it
    for (const id of ringWitnesses(at)) held.add(id);                // 2 · it delivered to me
    held.add(me.deviceId);                                           // 3 · it is me
    return ids.filter((id) => !held.has(id)).sort();
  }

  /**
   * THE ONLY WRITER THAT ADDS ANYTHING. Called from one place: the `200` arm of `rotateTo`, i.e.
   * after a rotation THIS DEVICE built out of its OWN ring and the relay accepted. `rotateTo`
   * wraps epochs `1..next` to every recipient in the roster, not only to the uncovered ones, so
   * the ids recorded are the ids wrapped to.
   */
  function recordDelivery(epoch, ids) {
    delivered = { epoch, ids: [...new Set(ids)].sort() };
    seen = { epoch, ids: delivered.ids };
  }

  /**
   * **D9's fact, answered from THIS DEVICE'S RING** — finding T5-K2.
   *
   * It used to be `parseKeysResponse().keysPending`, which is the relay's answer, and the relay
   * answers it by counting rows (`handlers/keys.js`, the same count as `assertCoverage`). So a
   * joiner handed a genuine wrap for the newest epoch and garbage for every older one was told
   * her keys had arrived, on a device that could not open one thing published before she joined:
   * an empty board, the waiting sentence withdrawn, and nothing in an error state.
   *
   * `ring.covers()` is the question actually being asked and it was three lines away. The ring is
   * whole when it holds every epoch `1..currentEpoch` — which is the same "1..e" ADR 002 §7.1
   * step 5 requires of the wrap set, checked where it can be checked with the keys in hand.
   */
  function ringIsWhole() {
    const at = stats.currentEpoch;
    return isEpoch(at) && ring.covers(spaceId, at);
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
    /** Admissions that grew the ring and still left it short of `1..currentEpoch` (T5-K2). */
    partialAdmits: 0,
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
    stats.currentEpoch = parsed.currentEpoch ?? list.currentEpoch;
    // `parsed.keysPending` is deliberately NOT stored here. It is the relay's row count and this
    // device holds the keys; `ringIsWhole()` below is the same question asked of the ring, after
    // the admission, which is the only place it can be answered honestly (finding T5-K2).
    //
    // The roster and the epoch, folded in BEFORE anything is wrapped or admitted, so a `deliver()`
    // in the same pass reads a record that has already dropped anybody who left the roster.
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

    // ── D9'S WAITING STATE IS A QUESTION ABOUT COVERAGE, NOT ABOUT ARRIVALS — finding T5-K2 ──
    //
    // `onAdmit` used to fire on `admitted.length > 0`, and `sync/family.js` turns it into
    // `onKeys({keysPending:false})` — the one place the calm German sentence is withdrawn. A
    // joiner handed a genuine wrap for the newest epoch and garbage for every older one therefore
    // had the sentence withdrawn on a ring of ONE epoch: no history, no error, nothing anywhere
    // saying a key was missing. `ring.covers()` is the question and it was three lines away.
    //
    // A ring that GREW but is still short is not an error either — it is the ordinary state of a
    // device that admitted mid-rotation — so it is not warned about on the first pass. It is
    // COUNTED, so `diagnostics()` can say how long a device has been arriving without finishing.
    const whole = ringIsWhole();
    stats.keysPending = !whole;
    if (!whole && admitted.length) stats.partialAdmits += 1;

    if (admitted.length) {
      for (const epoch of admitted) {
        if (typeof d.saveKey === 'function') {
          try { await d.saveKey(epoch, ring.get(spaceId, epoch)); }
          catch (e) { warn(`keys: epoch ${epoch} was admitted but could not be stored (${e && e.message}); it will be re-fetched`); }
        }
      }
      if (whole && typeof d.onAdmit === 'function') {
        try { d.onAdmit({ spaceId, admitted, currentEpoch: stats.currentEpoch }); }
        catch { /* a listener that throws may not cost a key */ }
      }
    }
    await saveProof();

    return {
      ok: true,
      admitted,
      keysPending: stats.keysPending,
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
   *   3. there must be a recipient §4's three sources do not cover. This is the gate that keeps a
   *      settled family silent — the steady state is `COVERED`, on every poll, for ever — and §4
   *      is the argument for why it is sound as well as quiet.
   *   4. the rotation must be ACCEPTED. A racer that lost gets `409 epoch_taken` or
   *      `400 not_next`, which is one piece of news and one only: **somebody else bumped the
   *      epoch.** It is NOT news that their wraps opened for anybody, so this pass records
   *      nothing and stops, and the next tick asks the same question again (finding T5-K1).
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
      // The relay took a rotation THIS DEVICE built out of ITS OWN ring, wrapping epochs 1..next
      // to every recipient in `recipients`. That is the one fact §4's record is made of, and it
      // is written down before anything else happens.
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
      recordDelivery(next, ids);
      await saveProof();
      stats.rotations += 1;
      stats.deliveries += 1;
      stats.currentEpoch = next;
      stats.lastDelivery = DELIVERY.DELIVERED;
      // Gated on coverage for the same reason `admit()` is (T5-K2). It is true by construction
      // here — `deliver()` and `rotate()` both refuse unless this device covers 1..at, and `next`
      // is `at + 1` — so the gate costs nothing and cannot be the one door left open.
      if (ringIsWhole() && typeof d.onAdmit === 'function') {
        try { d.onAdmit({ spaceId, admitted: [next], currentEpoch: next }); }
        catch { /* as above */ }
      }
      // ── WHY THERE IS NO WARNING HERE ANY MORE, AND WHY THAT IS THE FIX AND NOT ITS LOSS ───
      //
      // This raised "the relay kept N wrap cell(s) somebody else had already filled — those
      // epochs were NOT re-delivered". It was true while a `KeyWrap` cell was
      // `(space, epoch, recipient)`: whoever wrote first owned the cell, so a joiner's history
      // could be claimed by a hostile member and this device's honest backfill was refused by
      // the relay with nothing to show for it.
      //
      // The cell now includes the DEPOSITOR, so this device's backfill rows ALWAYS land — they
      // are its own rows, and nobody else can address them. `wrapsRefused` consequently counts
      // only this device re-wrapping ITS OWN earlier cells with a fresh salt and IV, which is
      // what every rotation after the first does for every epoch below its own. Warning on it
      // would fire on every honest rotation for ever, and a warning that is always on is a
      // warning nobody reads. The count is still reported, as accounting, in `detail`.
      const refusedCells = Number(res.json && res.json.wrapsRefused) || 0;
      return verdict(DELIVERY.DELIVERED, next, ids, owed, 200, null,
        `${why}: ${rotation.wraps.length} wraps for epochs 1..${next}`
        + (refusedCells > 0
          ? `, ${refusedCells} of them this device's own earlier cells, re-wrapped and refused`
          : ''));
    }

    const code = errorOf(res);
    if (code === 'epoch_taken' || (code === 'bad_request' && res.json && res.json.reason === 'not_next')) {
      // SOMEBODY ELSE GOT THERE FIRST, which is the designed outcome of "any member device"
      // rather than a failure. Nothing is retried here, because retrying at `e+2` would be two
      // devices climbing the epoch ladder against each other; the next `admit()` fetches the
      // epoch and the next `deliver()` asks the coverage question again.
      //
      // ⚠ **THIS BRANCH RECORDS NOTHING, AND THAT IS FINDING T5-K1's FIX AT THE POINT OF ENTRY.**
      // It used to read the 409 as *"their rotation passed the same coverage check over the same
      // rows, so the recipients this device was worried about are covered by their wraps"*. The
      // relay's check counts rows (ADR 002 §4.2), so what the 409 actually says is that somebody
      // deposited the required NUMBER of rows — for the joiner, 156 bytes of anything at all. The
      // winner of the race is the adversary in ADR 002 §0's own table, and this device was
      // recording her word as its own proof, durably, once, for ever.
      //
      // What it does instead: observe the new epoch (diagnostics), keep the record it earned, and
      // owe the joiner the same delivery it owed her a moment ago. The very next tick pays it.
      const at = isEpoch(res.json && res.json.currentEpoch) ? res.json.currentEpoch : next;
      observe(at, ids);
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
    /**
     * The record, read-only, so a diagnostics pane can show why a device is or is not delivering.
     *
     * `proof` keeps its name because that is what it is used as, and `source` states what it is a
     * proof OF: this device's own deliveries, and nothing anybody else did (§4, finding T5-K1).
     * `seen` is the last roster reading and proves nothing at all — it is here so that a pane can
     * show the two side by side, which is what makes a stalled delivery legible.
     */
    coverage: () => ({
      proof: delivered ? { epoch: delivered.epoch, ids: [...delivered.ids] } : null,
      source: 'self-delivery',
      seen: seen ? { epoch: seen.epoch, ids: [...seen.ids] } : null,
      durable: !!(d.coverStore && typeof d.coverStore.save === 'function'),
    }),
    diagnostics: () => ({
      spaceId,
      kind,
      epochs: ring.epochs(spaceId),
      currentEpoch: stats.currentEpoch,
      keysPending: stats.keysPending,
      coverage: delivered ? { epoch: delivered.epoch, count: delivered.ids.length } : null,
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
