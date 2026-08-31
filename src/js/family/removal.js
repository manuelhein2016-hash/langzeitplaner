// src/js/family/removal.js — LZP-608.  REMOVAL, END TO END.
// Stories 20.2 and 20.5 · ADR 002 §4.1, §4.2, §4.3, §7.4 · ADR 001 §4.1, §4.2 · Addendum F20 §6.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE TICKET, AND THE FOUR THINGS IT PROMISES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Story 20.2, in full:
//
//   > "Removing a member deletes their shared/Belegt entries from all family boards and their
//   >  access — their private data on their own machine is untouched, because it was never ours."
//
// That is four separate promises, kept by four different mechanisms, and only one of them was
// built before this file:
//
//   1. **their access ends** — `POST /api/v1/members/remove`. One column write; every subsequent
//      request from that member's devices fails at ADR 003 §2's auth step 6. Instant, server-side,
//      and it does not wait for anybody's laptop. `family/adminpanel.js` already calls it and
//      `family/leavedelete.js` already confirms it. **This half was done.**
//   2. **their entries leave every family board** — the in-log `member.set{_alive:false}` op.
//      `core/authz.js` stage 2 admits it only from the sitting admin; folding it drops the member
//      from `currentMembers`; `core/entities.js:projectable` then refuses every foreign entry
//      whose owner is not in that set (`materialize.js:795` names 20.2 at the line). So the board
//      half is one op, and **it is the op nothing in this product authored.**
//   3. **they cannot read what comes next** — the epoch rotation ADR 002 §4.1 requires, wrapped to
//      every REMAINING member. `sync/keys.js#rotate('member.remove')` is the verb; **it had no
//      caller.**
//   4. **their own board is untouched** — kept by everything this file does NOT do. There is no
//      remote-wipe primitive in this product, there is no per-entity redaction endpoint (ADR 002
//      §6.3: "an endpoint that lets any member delete another member's ops from the relay is a
//      censorship primitive"), and nothing here reaches another person's Mac. That promise is
//      kept by construction, and the test that matters is the one that proves the removed
//      member's own board is byte-for-byte what it was.
//
// This module is 2 and 3, driven from the seam `adminpanel.js` left open at
// `ports.afterRemove` — which already receives the relay's body with `rotateRequired: true` in it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ORDER, AND WHY IT IS THIS ONE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//     rotate ──▶ author ──▶ publish ──▶ syncNow
//
// **ROTATE FIRST.** ADR 002 §4.2 is explicit about who performs it — *"the member whose action
// caused the rotation performs it … the admin on removal"* — and about when: it is the immediate
// consequence of the membership change, not a follow-up. Two concrete reasons it goes first here:
//
//   · it is the only half with a security consequence. If this pass dies half way, "rotated but
//     the boards do not know yet" is a cosmetic lag that the next removal attempt fixes;
//     "the boards know but the key did not change" is the state T2 exists to prevent.
//   · the relay has ALREADY removed the member when `afterRemove` runs, so the roster
//     `keys.js#rotate` reads no longer contains them. The rotation therefore excludes them by
//     reading the truth rather than by filtering a list — and the server's own `assertCoverage`
//     runs inside the rotation transaction and refuses a rotation that leaves a REMAINING member
//     out. Completeness is proved by the relay, not asserted here.
//
// **THE REMOVAL OP IS THEREFORE SEALED UNDER `e+1`**, the epoch the removed member does not hold
// and will never be wrapped. That is not a requirement — they cannot fetch it anyway, their auth
// is gone — it is simply what falling out of the right order looks like.
//
// **AND THE ADMIN'S OWN BOARD IS UPDATED BY THE SAME CODE AS EVERYBODY ELSE'S.** This file
// publishes the op and then calls `syncNow()`; the admin's own next pull fetches it back and
// `store.applyRemote` folds it through `foldAuthorized` exactly as it will on Mama's Mac and on
// Oma's. There is deliberately no local-append shortcut: a removal that took a different path on
// the admin's Mac than on every other Mac is a removal whose *only* untested path is the one the
// admin sees, and "it looked right on my machine" is how 20.2 would ship broken.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE REFUSES TO DECIDE  (report, do not decide)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// **THE ADMIN CHAIN MUST ALREADY EXIST, AND THIS MODULE WILL NOT MINT IT.**
// `core/authz.js` stage 2 admits `member.set{_alive:false}` on somebody else's record only from
// `adminAt(op.ts)`, and that admin is resolved ENTIRELY from the log — the genesis link
// `space.set{admin: <creator>, adminPrev: null}` that `core/ops.js`'s `claimAdmin` builds. Nothing
// in the shipped client calls it yet (see `REPORTED` at the foot of this file), so on a circle
// created by this build `store.familyAdmin().admin` is `null` and every removal op would be
// REJECTED by every peer, including the author's own Mac.
//
// The tempting fix — "mint a genesis link here, the admin is obviously me" — is refused, and the
// refusal is the point. `resolveChain` roots on `adminPrev === null ∧ act === admin` and decides
// rival roots by longest-chain-then-STAMP, so a link minted late beats one minted at creation.
// A module that mints a root on behalf of whoever happens to be clicking "Entfernen" would hand
// the seat — and with it ADR 001 §4.3's admin-unshare primitive over every member's entries — to
// anybody who can reach this code path. That is an authority decision, it belongs to circle
// CREATION and to the PO, and this file reports it instead: `REMOVAL_BLOCKERS.NO_ADMIN_CHAIN`,
// with the owner named in the copy the human is shown.
//
// **A PURGE AND A HOSTILE WITHHOLD ARE THE SAME EVENT TO A CLIENT** (round 10, R10-2/R10-4). The
// relay purges the removed member's ops, which breaks the chain permanently and benignly
// (ADR 003 §6.3) — and a relay that simply withheld those ops would look identical. Nothing here
// tries to tell them apart, nothing here claims the purge is verifiable, and the copy never says
// the entries were "deleted everywhere". It is an OPEN QUESTION and it is not this file's.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// AND THE LIMIT, IN CODE AS WELL AS IN COPY  (Addendum §6 · ADR 002 §7.4 · §8.1)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// **A removed member keeps every epoch key they held and every op they already pulled.** Rotation
// reaches forward and never backward. `tests/attack/crypto-relay-removed.test.js` asserts it from
// the adversary's side ("SUCCEEDED (by design, §8.1) — she keeps EVERYTHING she already held, for
// ever") and nothing in this module may contradict it.
//
// So `REMOVAL_COPY.honesty` IS `sync/keys.js`'s `ROTATION_HONESTY`, by identity and not by
// re-typing — one sentence, one home, and a test that asserts the two are the same object. The
// four forbidden phrases of ADR 002 §7.4 („gelöscht bei allen", „zurückgezogen", „niemand kann es
// mehr sehen", „live") appear nowhere in this file except in this paragraph, which is prose.

import { buildMutation } from '../core/ops.js';
import { isMemberId, memberKey } from '../core/entities.js';
import { sealOp } from '../crypto/envelope.js';
import { PATHS } from '../sync/protocol.js';
import { DELIVERY, ROTATION_HONESTY } from '../sync/keys.js';
import { store as liveStore } from '../store.js';
import { circleEngine } from './mount.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. VERDICTS AND BLOCKERS — every answer as data, never as a silent no-op
// ═════════════════════════════════════════════════════════════════════════════════════════════

export class RemovalError extends Error {
  /** @param {string} message @param {string} [kind] */
  constructor(message, kind = 'config') {
    super(message);
    this.name = 'RemovalError';
    this.kind = kind;
  }
}

/**
 * The outcome of one `afterRemove` pass. `DONE` is the only one that means both halves landed,
 * and every other value names which half did not — because a removal that half-happened and said
 * nothing is the failure mode this whole ticket is about.
 */
export const REMOVAL = Object.freeze({
  /** Rotated to `e+1` for every remaining member, and the removal op is on the relay. */
  DONE: 'done',
  /** The key half landed; the board half did not. `blockers` says why, in one word. */
  PARTIAL: 'partial',
  /** The relay reported the member was already out and asked for no rotation. Idempotent. */
  ALREADY: 'already',
  /** This Mac is in no Familienkreis, or in a different one from the body's. Nothing was done. */
  NOT_MINE: 'notMine',
  /** The relay could not be reached for the rotation. Nothing was published; retryable. */
  UNREACHABLE: 'unreachable',
});

/** Why a half did not happen. One value per cause, so a diagnostics pane can render it. */
export const REMOVAL_BLOCKERS = Object.freeze({
  /** No family engine is running on this Mac — nothing holds the ring or the transport. */
  NO_ENGINE: 'noEngine',
  /** This device holds no complete key ring, so it cannot rotate. Another member's Mac must. */
  NO_RING: 'noRing',
  /** The relay refused the rotation. Its body rides along in `rotation`. */
  ROTATION_REFUSED: 'rotationRefused',
  /**
   * `store.familyAdmin().admin === null` — the log carries no admin chain, so no member.set
   * removal is admissible from ANYBODY. See the header. Owner: `family/createjoin.js`.
   */
  NO_ADMIN_CHAIN: 'noAdminChain',
  /** The chain names somebody else. ADR 001 §4.2: only the sitting admin may remove. */
  NOT_THE_ADMIN: 'notTheAdmin',
  /** The op was built and sealed and the relay would not take it. Retryable. */
  PUBLISH_FAILED: 'publishFailed',
});

/**
 * ADR 002 §7.4's copy contract, for the moment AFTER the deed rather than before it.
 *
 * `leavedelete.js#LIFECYCLE_COPY.remove` owns the CONFIRMATION — what a person is told before
 * they press the button — and this owns the OUTCOME. They are two moments and two sentences, and
 * merging them would mean a confirmation that has to be written in the past tense.
 *
 * `honesty` is `ROTATION_HONESTY` **by identity**: `sync/keys.js` is where the sentence "what they
 * already pulled stays on their Mac" lives, and a second copy of it in a UI module is a second
 * copy to soften. `tests/fleet/e6-removal.test.js` §5a asserts the object identity, so a paste
 * reddens a row rather than passing review.
 */
export const REMOVAL_COPY = Object.freeze({
  /** Both halves landed. It says what ended and, in the same breath, what did not. */
  done: Object.freeze({
    de: (name) => `${name} ist nicht mehr im Kreis. Ab jetzt sieht ${name} nichts Neues mehr.`,
    en: (name) => `${name} is no longer in the circle. From now on ${name} sees nothing new.`,
  }),
  /** Addendum §6, quoted from ONE place. Never omitted, in either language. */
  honesty: ROTATION_HONESTY,
  /**
   * The rotation landed and the boards do not know yet. It must not read like a success and must
   * not read like a disaster: the person IS out, on the server, this second.
   */
  partial: Object.freeze({
    de: (name) => `${name} hat keinen Zugang mehr zum Kreis, und der Schlüssel des Kreises ist `
      + `gewechselt. Auf den Boards der anderen stehen die Einträge von ${name} noch — das holt `
      + 'dieser Mac beim nächsten Versuch nach.',
    en: (name) => `${name} has no access to the circle any more and the circle's key has been `
      + `changed. ${name}'s entries are still on the other boards — this Mac will catch that up `
      + 'on the next attempt.',
  }),
  /**
   * The one blocker a human can do nothing about, said without jargon and without blame. It names
   * the fact, not the module.
   */
  noAdminChain: Object.freeze({
    de: 'Dieser Kreis hat im Verlauf noch keinen eingetragenen Verwalter, deshalb können die '
      + 'anderen Macs die Entfernung nicht übernehmen. Der Zugang ist trotzdem beendet.',
    en: 'This circle has no admin recorded in its history yet, so the other Macs cannot take the '
      + 'removal over. Access has ended all the same.',
  }),
  notTheAdmin: Object.freeze({
    de: 'Der Verlauf dieses Kreises nennt jemand anderen als Verwalter. Die Entfernung auf den '
      + 'Boards muss von dort kommen.',
    en: "This circle's history names somebody else as admin. The removal on the boards has to "
      + 'come from there.',
  }),
  noRing: Object.freeze({
    de: 'Dieser Mac hat die Schlüssel des Kreises noch nicht vollständig. Der nächste Mac aus dem '
      + 'Kreis, der synchronisiert, wechselt den Schlüssel.',
    en: "This Mac does not hold the circle's keys in full yet. The next Mac in the circle to sync "
      + 'changes the key.',
  }),
  unreachable: Object.freeze({
    de: 'Der Server ist gerade nicht erreichbar. Der Zugang ist beendet; der Schlüsselwechsel '
      + 'passiert beim nächsten Abgleich.',
    en: 'The server cannot be reached right now. Access has ended; the key change happens at the '
      + 'next sync.',
  }),
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE PURE HALF — membership out of a register map
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ADR 001 §4.2's definition of "who is in this circle", read off a folded register map.
 *
 * `{ m : member:m exists ∧ _alive !== false }`, which is `core/authz.js:1047` and
 * `store.js#_memberCtx` word for word — and it is legitimate to read it here for the same reason
 * it is legitimate there: `applyRemote` gates every remote op on `foldAuthorized` before anything
 * reaches the log, so `store.registers()` IS the authorized fold.
 *
 * It exists as an exported function because this module has to answer one question the store's
 * projection cannot be asked from outside — *did the removal actually land in the fold?* — and
 * because a test that wants to assert "Mama is gone from the membership" should not have to
 * re-derive §4.2 and risk deriving it differently.
 *
 * An absent `_alive` is NOT a removal. ADR 001 §5 step 3: meaning is never inferred from absence,
 * and a member record carrying nothing but a `dev.*` attestation is a member.
 *
 * @param {Map} regs a RegisterMap — `store.registers()`
 * @returns {{current:Set<string>, removed:Set<string>}}
 */
export function membershipOf(regs) {
  const current = new Set();
  const removed = new Set();
  if (!regs || typeof regs.keys !== 'function') return { current, removed };
  for (const key of regs.keys()) {
    if (typeof key !== 'string' || !key.startsWith('member:')) continue;
    const id = key.slice('member:'.length);
    if (!isMemberId(id)) continue;
    const cells = regs.get(key);
    const cell = cells && typeof cells.get === 'function' ? cells.get('_alive') : undefined;
    if (cell !== undefined && cell.value === false) removed.add(id);
    else current.add(id);
  }
  return { current, removed };
}

/**
 * The patch a removal is, and the ONLY patch it may be.
 *
 * `core/authz.js` stage 2 admits an admin's write to somebody else's member record if and only if
 * `Object.keys(op.f)` is exactly `['_alive']` — `onlyAlive` in that file. One extra field and the
 * op is not "a removal by the admin", it is "an admin writing to another member's record", which
 * is REJECTED outright and permanently by every peer.
 *
 * It is a frozen constant rather than an object literal at the call site because that rejection
 * is silent on the authoring Mac: the op would be built, sealed, accepted by the relay, pulled by
 * everybody, and dropped by all of them. Nothing would report it except a member list that never
 * changed.
 */
export const REMOVAL_PATCH = Object.freeze({ _alive: false });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE ENGINE
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** `{de, en}` → whichever the app is speaking. Injected, so nothing here imports `i18n.js`. */
const pick = (pair, lang) => (lang === 'en' ? pair.en : pair.de);

/** The relay's answer, normalised, never throwing on shape. */
function normalize(res) {
  const status = res && Number.isInteger(res.status) ? res.status : 0;
  const json = res && 'json' in (res || {}) ? res.json : (res ? res.body : null);
  return { status, json };
}

/**
 * @typedef {Object} RemovalDeps
 * @property {Object} [engine]     what `family/mount.js#circleEngine()` returns; defaults to it
 * @property {Object} [store]      the live store; defaults to the engine's
 * @property {(space:string) => string} [witnessOf]  `Envelope.wit` — see `publishRemoval`
 * @property {(m:string) => void} [warn]
 * @property {'de'|'en'} [lang]
 */

/**
 * Build a removal driver.
 *
 * Everything it needs is already assembled by `startFamilyEngine`: the transport signed by this
 * Mac's device key, the FAMILY key ring, the durable identity and the sync engine whose
 * `keys` handle is ADR 002 §7.1 steps 4-6. Nothing is re-opened, re-armed or re-derived here —
 * a second transport or a second ring would be a second answer to "which circle is this".
 *
 * @param {RemovalDeps} [deps]
 */
export function createRemoval(deps = {}) {
  const engine = deps.engine !== undefined ? deps.engine : circleEngine();
  // The live store by default, injectable for a test that drives two Macs in one process. It is
  // the SAME object `adminpanel.js` writes settings through, so there is no second view of the log.
  const store = deps.store || liveStore;
  const lang = deps.lang === 'en' ? 'en' : 'de';
  const warn = typeof deps.warn === 'function' ? deps.warn : (m) => console.warn(m);
  // ADR 002 §5.1 — `Envelope.wit`. The engine now EXPOSES its chain head (`sync.witness(space)`),
  // so the default is the real one rather than `''`. That closes the gap this file reported: an
  // op published with `wit: ''` is one `chain.js#observe` SKIPS ("`''` on the first push"), so
  // every removal used to commit to no chain value and sat outside §5.4's fork detector.
  //
  // Still a port, and still falling back to `''`: an engine built before the reader existed, or a
  // test driving `run()` with a stub, must publish rather than throw. `''` is the honest "no
  // commitment", never a wrong one.
  const witnessOf = typeof deps.witnessOf === 'function'
    ? deps.witnessOf
    : (space) => {
      try {
        return typeof engine?.sync?.witness === 'function' ? (engine.sync.witness(space) || '') : '';
      } catch { return ''; }
    };

  const stats = {
    runs: 0, rotations: 0, published: 0, lastVerdict: null, lastBlockers: [], lastError: null,
  };

  /**
   * ADR 002 §7.1 step 4's own vocabulary, one layer up: a verdict object, always the same shape,
   * so no caller has to tell an exception from an outcome.
   */
  const report = (verdict, over = {}) => Object.freeze({
    verdict,
    memberId: over.memberId ?? null,
    spaceId: over.spaceId ?? null,
    rotation: over.rotation ?? null,
    published: over.published ?? null,
    blockers: Object.freeze([...(over.blockers || [])]),
    /** What to say to the human. Always includes the honesty line; see `REMOVAL_COPY`. */
    say: Object.freeze([...(over.say || [])]),
    detail: over.detail ?? null,
  });

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   * THE PUBLISH PATH, AND WHY IT IS HERE RATHER THAN IN THE ENGINE'S OUTBOX.
   * ═══════════════════════════════════════════════════════════════════════════════════════════
   *
   * The right home for this is `sync/family.js#pushNow`, over the outbox: it has the sealed-
   * envelope cache that makes a 409 survivable, the quarantine that stops an unsealable op being
   * retried for ever, and the chain witness that makes ADR 002 §5.4's fork detector work.
   *
   * It is not there today because of exactly one missing line, and this is the report rather than
   * a workaround pretending to be a design:
   *
   *   · `store.useFamilySpace()`, `store.familyOutbox()` and `store.familyOutbound()` all EXIST.
   *   · `family/engine.js#startFamilyEngine` does not call the first and does not pass the third
   *     to `createFamilySync`, so the running engine's `outbound` is `NO_OUTBOUND` and
   *     `diagnostics().outbound.wired` is `false`.
   *
   * So this seals ONE op with the shipped `sealOp` and posts it to the shipped `PATHS.ops` with
   * the shipped body shape. The two things it does NOT get, named so neither is discovered later:
   *
   *   1. **the witness.** `Envelope.wit` is the chain head this device has pulled, and the engine
   *      keeps it privately (`sync/chain.js#witness`). `witnessOf` is a port with `''` as its
   *      default — which `chain.js#observe` skips rather than misreads ("`''` on the first push",
   *      ADR 002 §5.1) — so the removal op commits to nothing. That is one op per removal with no
   *      fork commitment, and it is a REPORT: `sync/family.js` should expose `witness(space)` or,
   *      better, take a lifecycle line on its own outbox.
   *   2. **the 409 cache.** A `forked_op_id` here is reported and not retried, because the op id
   *      is freshly minted and a fork on it means something is very wrong.
   */
  async function publishRemoval(op, spaceId) {
    const ring = engine.keyring;
    const epoch = typeof ring?.currentEpoch === 'function' ? ring.currentEpoch(spaceId) : 0;
    if (!epoch) {
      throw new RemovalError(
        `removal: the key ring holds no key for ${spaceId}. Nothing is published unencrypted, `
        + 'ever (ADR 002 §5.2).', 'key');
    }
    const env = await sealOp(op, ring, engine.armed.identity.devSig.privateKey, {
      v: 1,
      sp: spaceId,
      ep: epoch,
      dv: engine.armed.forStore.deviceShort,
      oid: op.id,
      wit: witnessOf(spaceId),
    }, engine.armed.myAttestation ? { attestation: engine.armed.myAttestation } : {});

    const res = normalize(await engine.transport.request('POST', PATHS.ops, {}, {
      space: spaceId,
      ackSeq: typeof store.cursor === 'function' ? store.cursor(spaceId) : '0',
      ops: [env],
      drained: true,
    }, {}));
    if (res.status !== 200) {
      const error = res.json && typeof res.json.error === 'string' ? res.json.error : String(res.status);
      return { ok: false, opId: op.id, status: res.status, error, seq: null };
    }
    const body = res.json || {};
    const rows = [...(body.accepted || []), ...(body.duplicate || [])];
    const mine = rows.find((a) => a && a.oid === op.id) || null;
    return { ok: !!mine, opId: op.id, status: 200, error: mine ? null : 'not_acked', seq: mine ? String(mine.seq) : null };
  }

  /**
   * ADR 002 §4.1 — the rotation. `keys.rotate` is the shipped verb and this adds nothing to it
   * except a reading of its verdict, because a `RACED` is a success and a `COVERED` cannot happen
   * for `member.remove` (the event's row says `rotate: true`).
   */
  async function rotate() {
    const r = await engine.sync.keys.rotate('member.remove');
    if (r.verdict === DELIVERY.DELIVERED || r.verdict === DELIVERY.RACED) {
      stats.rotations += 1;
      return { ok: true, ...r };
    }
    return { ok: false, ...r };
  }

  /**
   * ONE PASS. Idempotent by construction at every step: the relay's removal is idempotent, a
   * second rotation costs one epoch and no key, and `member.set{_alive:false}` is a register write
   * whose second application changes nothing.
   *
   * @param {Object} relayBody the body of `POST /api/v1/members/remove`, verbatim
   * @returns {Promise<Object>} the report; never throws for an ordinary failure
   */
  async function run(relayBody) {
    stats.runs += 1;
    const body = relayBody && typeof relayBody === 'object' ? relayBody : {};
    const memberId = typeof body.memberId === 'string' ? body.memberId : null;
    const spaceId = typeof body.spaceId === 'string' ? body.spaceId : null;

    if (!isMemberId(memberId) || typeof spaceId !== 'string' || !spaceId.startsWith('fsp_')) {
      throw new RemovalError(
        'removal: `afterRemove` takes the body of POST /api/v1/members/remove verbatim — it must '
        + `carry an fsp_ spaceId and a mem_ memberId, got ${JSON.stringify({ spaceId, memberId })}.`,
        'shape');
    }

    if (!engine || !engine.sync || !engine.keyring || !engine.transport || !engine.armed) {
      // A Mac whose circle engine did not start still removed the member on the relay — their
      // access is already gone. What is missing is the key ring, so nothing here can be done.
      stats.lastVerdict = REMOVAL.NOT_MINE;
      warn('[removal] the member was removed on the server, but this Mac has no running family '
        + 'engine, so the epoch rotation ADR 002 §4.1 requires did not happen here. Another '
        + "member's Mac performs it on its next ordinary sync.");
      return report(REMOVAL.NOT_MINE, {
        memberId, spaceId, blockers: [REMOVAL_BLOCKERS.NO_ENGINE],
        say: [pick(REMOVAL_COPY.noRing, lang), pick(REMOVAL_COPY.honesty, lang)],
      });
    }
    if (engine.circle.spaceId !== spaceId) {
      throw new RemovalError(
        `removal: this Mac's Familienkreis is ${engine.circle.spaceId} and the removal names `
        + `${spaceId}. Addendum 20.6 — one circle per install; refusing to rotate the wrong one.`,
        'space');
    }
    if (memberId === engine.circle.memberId) {
      throw new RemovalError(
        'removal: removing yourself is `POST /api/v1/members/leave` (story 20.3), which has its '
        + 'own copy and its own consequences. The relay refuses it here too (`use_leave`).',
        'shape');
    }

    const blockers = [];
    const say = [];

    // ── 1 · THE KEY HALF ──────────────────────────────────────────────────────────────────────
    let rotation = null;
    if (body.rotateRequired === false) {
      // The relay says nobody's read access changed (a member who was already out). Rotating
      // anyway would burn an epoch for nothing and would be this client disagreeing with the one
      // party that can count the wraps.
      rotation = { ok: true, verdict: DELIVERY.COVERED, epoch: null, skipped: 'not_required' };
    } else {
      rotation = await rotate();
      if (!rotation.ok) {
        // Two causes, two sentences. `NO_RING` is "this Mac cannot do it and another one will";
        // everything else is "the relay said no or could not be asked", which the next attempt
        // retries. Neither is an error the person did anything about.
        const noRing = rotation.verdict === DELIVERY.NO_RING;
        blockers.push(noRing ? REMOVAL_BLOCKERS.NO_RING : REMOVAL_BLOCKERS.ROTATION_REFUSED);
        say.push(pick(noRing ? REMOVAL_COPY.noRing : REMOVAL_COPY.unreachable, lang));
        stats.lastError = { at: 'rotate', verdict: rotation.verdict, error: rotation.error ?? null };
        warn('[removal] the epoch rotation ADR 002 §4.1 requires after a removal did not land '
          + `(${rotation.verdict}${rotation.error ? `: ${rotation.error}` : ''}). The member's `
          + 'access is already gone; the rotation is retried by the next member device to notice.');
        // No ring, no seal — and with an unreachable relay there is nothing to publish to either.
        stats.lastVerdict = rotation.verdict === DELIVERY.UNREACHABLE ? REMOVAL.UNREACHABLE : REMOVAL.PARTIAL;
        stats.lastBlockers = blockers.slice();
        return report(stats.lastVerdict, {
          memberId, spaceId, rotation, blockers,
          say: [...say, pick(REMOVAL_COPY.honesty, lang)],
        });
      }
    }

    // ── 2 · THE BOARD HALF ────────────────────────────────────────────────────────────────────
    //
    // `store.useFamilySpace()` is idempotent and is documented as callable after `init()` — "a
    // Mac can be in a Familienkreis without ever having opted into own-device sync" — so calling
    // it here is safe. It is nevertheless the WRONG HOME: it belongs in `startFamilyEngine`, next
    // to the engine it arms, and is reported as such below. Without it `core/ops.js:spaceFor`
    // refuses to address a family op at any space and this half cannot begin.
    if (!store || typeof store.familyAdmin !== 'function' || typeof store.registers !== 'function') {
      throw new RemovalError(
        'removal: `store` is required — the removal op is authored into this Mac\'s own log and '
        + 'the admin chain is read from it (ADR 001 §4.1).', 'config');
    }
    if (store.familySpaceId() === null) store.useFamilySpace(spaceId);

    const seat = store.familyAdmin();
    if (seat.admin === null) {
      blockers.push(REMOVAL_BLOCKERS.NO_ADMIN_CHAIN);
      say.push(pick(REMOVAL_COPY.noAdminChain, lang));
      warn('[removal] this circle has no admin chain in its log, so `member.set{_alive:false}` '
        + 'would be rejected by every peer (core/authz.js stage 2). The genesis link is '
        + '`core/ops.js`\'s `claimAdmin` and `family/createjoin.js` must emit it when a circle is '
        + 'created — LZP-608 reports this; it does not mint a rival root.');
    } else if (!seat.isMe) {
      blockers.push(REMOVAL_BLOCKERS.NOT_THE_ADMIN);
      say.push(pick(REMOVAL_COPY.notTheAdmin, lang));
      warn(`[removal] the log names ${seat.admin} as admin and this Mac is `
        + `${engine.circle.memberId}. ADR 001 §4.2: only the sitting admin's removal op is `
        + 'admitted. Nothing was published.');
    }

    let published = null;
    if (blockers.length === 0) {
      // **THE SHIPPED MUTATION, NOT THE BARE CONSTRUCTOR.** `core/ops.js` grew `removeMember`
      // (row 28) and it carries two guards this file must not re-implement: `mustBeSittingAdmin`
      // over the folded `space:` register, and a refusal of `memberId === ctx.act` — because
      // removing YOURSELF is 20.3's `POST /members/leave`, and a `member.set{_alive:false}`
      // against my own record would be admitted by authz stage 2's SELF branch and leave the
      // membership row, the device row and the key wraps alive on the relay.
      //
      // `buildMutation` and not `store.apply`: this file publishes the op itself so it can order
      // the rotation BEFORE it (see `run()`), and the admin's own Mac then folds it back through
      // `applyRemote → foldAuthorized`, the same path Oma's uses. `store.apply` would append it
      // locally and hand it to the outbox, which is the better home the day the ORDER moves into
      // the engine — reported at the foot of this file.
      const ctx = store._ctx();
      const [op] = buildMutation('removeMember', ctx, { memberId });
      // The shape gate, restated where it is cheap: `authz.js` stage 2's `onlyAlive` is
      // `names.length === 1 && names[0] === '_alive'`, and an op that misses it is dropped by
      // every peer in silence. Asserting it here turns that into a throw on the author's Mac.
      const names = Object.keys(op.f);
      if (names.length !== 1 || names[0] !== '_alive' || op.f._alive !== false) {
        throw new RemovalError(
          `removal: a removal op must carry exactly {_alive:false}, got ${JSON.stringify(op.f)} — `
          + 'anything else is "an admin writing to another member\'s record", which ADR 001 §4.2 '
          + 'rejects on every peer.', 'shape');
      }
      if (op.e !== memberKey(memberId)) {
        throw new RemovalError(`removal: the op addresses ${op.e}, not ${memberKey(memberId)}`, 'shape');
      }
      try {
        published = await publishRemoval(op, spaceId);
      } catch (e) {
        published = { ok: false, opId: op.id, status: 0, error: e.message, seq: null };
      }
      if (published.ok) stats.published += 1;
      else {
        blockers.push(REMOVAL_BLOCKERS.PUBLISH_FAILED);
        say.push(pick(REMOVAL_COPY.partial, lang)(nameFor(memberId)));
        warn(`[removal] the removal op could not be published (${published.error}). The member's `
          + 'access is already gone and the key has rotated; the boards catch up when this is '
          + 'retried.');
      }
    }

    // ── 3 · SETTLE ────────────────────────────────────────────────────────────────────────────
    //
    // The admin's own Mac folds the op back through the SAME path every peer uses. See the
    // header: there is no local-append shortcut, deliberately.
    let folded = false;
    try {
      await engine.sync.syncNow();
      folded = membershipOf(store.registers()).removed.has(memberId);
    } catch (e) {
      // A failed settle is a lag, not a loss: the op is on the relay and the next cadence tick
      // fetches it. It must not turn a completed removal into an error on screen.
      warn(`[removal] the settling sync did not complete (${e && e.message}); the removal is on `
        + 'the relay and lands on this Mac at the next ordinary sync.');
    }

    const ok = blockers.length === 0 && published !== null && published.ok;
    const verdict = ok
      ? (body.alreadyRemoved === true && body.rotateRequired === false ? REMOVAL.ALREADY : REMOVAL.DONE)
      : REMOVAL.PARTIAL;
    stats.lastVerdict = verdict;
    stats.lastBlockers = blockers.slice();

    const lines = ok ? [pick(REMOVAL_COPY.done, lang)(nameFor(memberId))] : say;
    return report(verdict, {
      memberId,
      spaceId,
      rotation,
      published,
      blockers,
      // Addendum §6 is the LAST line of every outcome, success included. A removal that reports
      // only its success is a removal that lets a person believe more than happened.
      say: [...lines, pick(REMOVAL_COPY.honesty, lang)],
      detail: folded ? 'the removal is folded on this Mac' : null,
    });
  }

  /**
   * The removed member's display name, when this Mac happens to know it, and their id otherwise.
   * It is never fetched: the copy is shown at the moment the member row is already on screen, and
   * a network round trip to decorate a sentence is a network round trip nobody asked for.
   */
  function nameFor(memberId) {
    try {
      const cells = store.registers().get(memberKey(memberId));
      const cell = cells && cells.get('displayName');
      if (cell && typeof cell.value === 'string' && cell.value !== '') return cell.value;
    } catch { /* a name is a decoration; its absence is not an error */ }
    return memberId;
  }

  return {
    run,
    membershipOf: () => membershipOf(store && typeof store.registers === 'function' ? store.registers() : new Map()),
    diagnostics: () => ({
      wired: !!(engine && engine.sync),
      spaceId: engine && engine.circle ? engine.circle.spaceId : null,
      /** The one line that is missing upstream; see `publishRemoval`. */
      outboundWired: !!(engine && engine.sync && engine.sync.diagnostics
        && engine.sync.diagnostics().outbound && engine.sync.diagnostics().outbound.wired),
      /** `false` means the removal op commits to no chain value — see `publishRemoval`. */
      witnessWired: typeof deps.witnessOf === 'function' || typeof engine?.sync?.witness === 'function',
      ...stats,
      lastBlockers: stats.lastBlockers.slice(),
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE PORT — what `adminpanel.js` hands `ports.afterRemove`
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * LZP-608's seat, filled.
 *
 * `family/adminpanel.js#createAdminPort().removeMember()` calls this with the relay's body,
 * `rotateRequired` included. It is a free function rather than a mounted singleton because the
 * admin panel is re-armed on every settings mount (`initAdminPanel()` with no arguments) and a
 * removal driver that outlived a circle change would hold a stale engine.
 *
 * It never throws for an ordinary failure — an exception here would surface as
 * `leavedelete.js#confirmLifecycle`'s generic „Das hat nicht geklappt", which would be false: the
 * member IS removed, the relay said so, and the copy must not take that back.
 *
 * @param {Object} relayBody the body of `POST /api/v1/members/remove`
 * @param {RemovalDeps} [deps]
 */
export async function afterRemove(relayBody, deps = {}) {
  const driver = createRemoval(deps);
  try {
    return await driver.run(relayBody);
  } catch (e) {
    if (!(e instanceof RemovalError)) throw e;
    // A `RemovalError` is a programmer-visible refusal (a wrong space, a self-removal, an
    // unsealable op). It is loud in the console and calm on screen.
    console.warn(`[removal] ${e.message}`);
    return Object.freeze({
      verdict: REMOVAL.PARTIAL,
      memberId: relayBody && relayBody.memberId ? relayBody.memberId : null,
      spaceId: relayBody && relayBody.spaceId ? relayBody.spaceId : null,
      rotation: null,
      published: null,
      blockers: Object.freeze([REMOVAL_BLOCKERS.NO_ENGINE]),
      say: Object.freeze([
        (deps.lang === 'en' ? REMOVAL_COPY.unreachable.en : REMOVAL_COPY.unreachable.de),
        (deps.lang === 'en' ? ROTATION_HONESTY.en : ROTATION_HONESTY.de),
      ]),
      detail: e.message,
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// REPORTED — what another owner must land, and what each one costs while it is open
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// 1. **`family/createjoin.js` — `store.apply('claimAdmin')` when a circle is created.**
//    `core/ops.js`'s own docblock for that row says it: "Until this op exists, `adminAtIn` answers
//    `null` for every stamp — so on a circle created by this build 20.1's rename and 20.2's member
//    removal are inadmissible from everybody, including the creator." It is the ROOT of this
//    ticket's board half. Cost while open: `REMOVAL_BLOCKERS.NO_ADMIN_CHAIN` on every removal.
//
// 2. **`family/engine.js#startFamilyEngine` — `store.useFamilySpace(circle.spaceId)` and
//    `outbound: store.familyOutbound()`.** Both methods exist on the store and neither has a
//    caller. The first is what lets any family op be authored at all (this file calls it
//    defensively; that is a splint, not the joint). The second is what puts a family op on the
//    engine's own push path, with its sealed-envelope cache, its quarantine and — see
//    `publishRemoval` — its CHAIN WITNESS. Cost while open: one op per removal published with
//    `wit: ''`, and every other family op unshareable.
//
// 3. **`core/ops.js` — a `removeMember` row in `MUTATIONS`.** `setMyProfile`, `attestMyDevice`,
//    `renameSpace`, `claimAdmin` and `transferAdmin` are all there; the one op ADR 001 §4.2's
//    removal branch exists for is not, so `store.apply('removeMember', {memberId})` throws
//    `unknown mutation` and this file builds the op with the exported `memberSet` constructor over
//    `store._ctx()` instead. The row is four lines and wants exactly two guards:
//    `mustBeSittingAdmin(ctx, 'removeMember')` and a refusal of `memberId === ctx.act` (that is
//    20.3's `leaveCircle`, a different story with different copy). Cost while open: the removal op
//    does not go through the store's own commit, so it reaches this Mac's log by being pulled back
//    rather than by being appended — which is the same path every peer uses and is therefore a
//    smaller cost than it sounds, but it also means the op is not in `store.familyOutbox()` and a
//    failed publish is not automatically retried.
//
// 4. **`sync/family.js` — expose the chain witness, or take a lifecycle line.** See
//    `publishRemoval`. Either `witness(space)` on the returned object, or a `publishOne(op)` that
//    rides the whole push path. The second is better and is one function.
//
// 5. **`store.js#diffCollection` — SKIP A FOREIGN ENTRY. This one is a live crash, not a gap.**
//    `diffCollection` calls `cellsInLog(ctx.regs, spec.kind, entry.id)` for EVERY entry of the
//    projected board, and `KEY_OF.note` is `noteKey`. A foreign entry's `id` is its whole entity
//    key by design — `materialize.js#foreignCandidate`: "v1's `id` is the token that addresses an
//    entry in the state arrays, and for a foreign entry that token IS the key" — so the first
//    `persistNow()` on any board carrying a peer's shared entry throws
//    `EntityKeyError: localKey: bad note id "fnote:mem_…/…"`, out of `store._adopt()`, out of
//    `sync/family.js#pullNow`. It became reachable the moment `store.useFamilySpace()` landed and
//    it will hit E7's rendering work head-on. The fix is one line — `if (e.isForeign === true)
//    continue;` at the top of `diffCollection`'s pass 1, because a foreign entry is not this
//    device's to author and can never appear in a diff of what this device did. Measured, with a
//    stack, by `tests/fleet/e6-removal.test.js`; that file works around it by composing the
//    projection itself (`boardOf`) and says so at both call sites.
//
// 6. **OPEN, PO — R10-2/R10-4.** A purge and a hostile withhold are field-for-field identical to a
//    client, so no client can tell a legitimate removal from censorship. This file neither closes
//    that nor pretends to: it never claims the purge happened, and `chain.js` already reports the
//    break as `UNVERIFIABLE_WITNESS` rather than as a fork. Reported, not decided.
