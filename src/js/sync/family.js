// src/js/sync/family.js — THE FAMILY SYNC ENGINE.  LZP-608 · story 21.2 · ADR 002 §7.1, §4 ·
// ADR 003 §3, §4, §8 · ADR 006 §9 · PO decision D9.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A SECOND ENGINE AND NOT A FLAG ON THE FIRST ONE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `sync/personal.js` refuses an `fsp_` space at CONSTRUCTION:
//
//     "A psp_… id is required and an fsp_… id is a THROW, not a fallback: a personal sync engine
//      pointed at a family space would push the user's private board into the family stream,
//      which is the single worst thing this product could do."
//
// That refusal is **correct and is not loosened here.** Story 21.2 says no family key may ever
// apply to a personal entry, and the strongest available form of that is a constructor that
// cannot be pointed the wrong way. Adding `kind: 'family'` to `createPersonalSync` would have
// turned a structural refusal into a parameter, and a parameter has a default, and a default is
// how the worst thing this product could do becomes reachable by forgetting an argument.
//
// So there are TWO CONSTRUCTORS AND TWO REFUSALS, pointing in opposite directions:
//
//     createPersonalSync(psp_…)  ✔      createPersonalSync(fsp_…)  ✘ PersonalSyncError
//     createFamilySync(fsp_…)    ✔      createFamilySync(psp_…)    ✘ FamilySyncError
//
// and `tests/tier1/sync-family.test.js` §1 drives all four cells. Neither engine can be handed
// the other's space, and neither refusal has an escape hatch, an option or an override.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS SHARED, AND WHAT SHARING IT MEANS HERE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Everything that is not the scope decision is IMPORTED rather than re-implemented:
//
//   `sync/outbox.js`   `createParkingLot` — the durable, capped retention of SEALED envelopes,
//                      with its refuse-rather-than-drop rule and its shelf (P-8, R8-4).
//   `sync/cursor.js`   `createCursors` — the ONE write path that runs the commit first and
//                      persists only if it resolves (W1), and the durable chain anchor.
//   `sync/chain.js`    `createChainWitness` — ADR 002 §5.4, with its own memory so an honest
//                      re-serve is not reported as a hole (R8-1).
//   `sync/status.js`   `judgeSyncStatus` + `shelvedDetail` — the fold over the enumeration, so
//                      this engine can only ever RAISE a state and never lower one.
//   `sync/personal.js` **the PARK TAXONOMY itself** — `PARK_HANDLING`, `parkHandlingOf`,
//                      `CURABLE_PARKS`, `CURABLE_REFUSALS`, `MAX_DEFERRALS`, `LIMITS`, `CADENCE`.
//                      That import is the point: "what do I do with every reason the envelope
//                      layer can emit?" must have exactly ONE answer in this product, and a
//                      family engine with its own copy of the table is two answers waiting to
//                      disagree the day a seventh park reason lands.
//   `sync/keys.js`     ADR 002 §7.1 steps 4–6 — the delivery this engine drives on every sync.
//
// What is NOT shared is the one thing that must not be: the space gate, and the store seam that
// depends on it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE SEAM THIS ENGINE DOES NOT OWN, STATED HERE RATHER THAN DISCOVERED LATER
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `store.outbox()` is hard-filtered to the PERSONAL space (`op.space !== this._personalSpaceId`
// → skipped) and there is no `store.useFamilySpace()`, so **this build authors no family op at
// all**: `core/ops.js` refuses `pub.set`/`member.set`/`space.set` without `ctx.familySpaceId`, and
// nothing sets it. The outbound half of a family space is `core/project.js` +
// `family/sharing.js` + one store method, and those belong to E7.
//
// This engine therefore takes the outbox as a PORT with an empty default, and reports the fact
// through `diagnostics().outbound` rather than pretending. The whole push path below is real and
// is driven in `tests/tier1/sync-family.test.js` §4 against an injected outbox; the day E7's
// projection lands it is one property here and no new code.
//
// **REPORTED to `store.js`'s owner (and to E7):**
//   1. `store.useFamilySpace(fsp_…)` — `_familySpaceId` exists, is read by `_materializeCtx` and
//      the checkpoint, and has NO setter, so a family entry cannot render even once its op is in
//      the log (`core/materialize.js:791` — `if (!familySpaceId) break;`).
//   2. `store.outbox({ space })` — or a second derived reader — so a family op this device
//      authored is offered to this engine the way a personal one is offered to `personal.js`.
//   3. `member.set` in `core/ops.js`'s MUTATIONS table, so a member can publish their own
//      `dev.<short>` attestation into the family log. Until that exists, `core/authz.js` stage 0b
//      refuses every family op from every peer as `unattestedDevice` — which this engine handles
//      correctly (it is a CURABLE refusal and the store PARKS the line rather than dropping it),
//      but which nothing can ever cure. `family/membersui.js` already reports the same gap from
//      the other side, for `setProfile`.

import { sealOp, openOp } from '../crypto/envelope.js';
// ADR 004 §2.2 BARRIER 2. `crypto/envelope.js` REQUIRES it as `ctx.assertFamilyPatch` and refuses
// to seal a family `pub.set` without it — "a security check that is skipped when absent is not a
// security check". It is imported rather than injected because there is exactly one allowlist in
// this product and a port would be a place to hand it a second one.
import { assertFamilyPatch } from '../core/project.js';
import { spaceKindOf, isSpaceId } from '../crypto/spacekeys.js';
import { createParkingLot } from './outbox.js';
import { ENVELOPE_KEYS } from './protocol.js';
import { createChainWitness, CHAIN_FINDINGS } from './chain.js';
import { createCursors } from './cursor.js';
import { judgeSyncStatus, shelvedDetail } from './status.js';
import {
  LIMITS, CADENCE, PARK_HANDLING, parkHandlingOf, CURABLE_PARKS, CURABLE_REFUSALS, isCurable,
  MAX_DEFERRALS,
} from './personal.js';
import { createKeyDelivery, DELIVERY } from './keys.js';

export { LIMITS, CADENCE, PARK_HANDLING, parkHandlingOf, CURABLE_PARKS, CURABLE_REFUSALS, isCurable, MAX_DEFERRALS };
export { DELIVERY };

/** Four pages' worth of `seq → chain`, the same bound `personal.js` uses and for the same reason. */
const CHAIN_SEQ_MEMORY = 4 * LIMITS.opsPerPull;

export class FamilySyncError extends Error {
  /** @param {string} message @param {string} [kind] */
  constructor(message, kind = 'config') {
    super(message);
    this.name = 'FamilySyncError';
    this.kind = kind;
  }
}

/**
 * THE REFUSAL 21.2 TURNS ON, IN THE OTHER DIRECTION.
 *
 * `personal.js` refuses `fsp_` because a personal engine pointed at a family space would push the
 * private board into the family stream. This refuses `psp_` for the mirror reason, and it is not
 * merely symmetric bookkeeping: a family engine pointed at the personal space would drive
 * `keys.js`'s `deliver()` over `familyRecipients()` — every OTHER member's devices — and hand the
 * personal space key to the family. That is the same catastrophe from the other end, and the
 * crypto layer's barrier 2 would catch it (`personalRecipients` refuses a foreign device;
 * `admissibleSenders` refuses a `'family'`-branded recipient for a `psp_` id), which is exactly
 * why this refusal exists too: **a barrier nobody reaches is a barrier nobody tests.** The engine
 * seam says no first, in a sentence a developer can read.
 */
function assertFamilySpace(spaceId) {
  if (!isSpaceId(spaceId) || spaceKindOf(spaceId) !== 'family') {
    throw new FamilySyncError(
      `family sync: spaceId must be an fsp_… id; got ${JSON.stringify(spaceId)}. A personal space `
      + 'is not a fallback here — the two scopes are disjoint by construction (story 21.2, '
      + 'ADR 002 §3 barrier 2, §11 rule 10), and `createPersonalSync` refuses the mirror image of '
      + 'this call.');
  }
  return spaceId;
}

/** ADR 003 §3.3: seqs are decimal strings on the wire and BigInt-comparable, never Numbers. */
function toSeq(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]{1,19}$/.test(v)) return BigInt(v);
  return null;
}

/** @returns {{status:number, headers:Object, json:any}} normalised, never throwing on shape. */
function normalizeResponse(res) {
  const status = res && Number.isInteger(res.status) ? res.status : 0;
  const headers = res && res.headers && typeof res.headers === 'object' ? res.headers : {};
  const json = res && 'json' in (res || {}) ? res.json : (res ? res.body : null);
  return { status, headers, json };
}

/**
 * The empty outbound half, named. See the header: `store.outbox()` cannot answer for a family
 * space and E7 owns the projection that will fill this in.
 */
const NO_OUTBOUND = Object.freeze({
  lines: () => [],
  ack: () => 0,
  owner: 'core/project.js + family/sharing.js + store.useFamilySpace() — E7',
});

/**
 * @typedef {Object} FamilySyncDeps
 * @property {Object} store            the live `store` — injected, never imported (purity)
 * @property {{request:Function}} transport
 * @property {Object} keyring          `createKeyRing()` — the FAMILY ring, never the personal one
 * @property {CryptoKey} sigPriv       this device's non-extractable `IK_sig` private key
 * @property {CryptoKey} kexPriv       this device's `IK_kex` private key — key delivery needs it
 * @property {string} spaceId          `fsp_…`
 * @property {{memberId:string, deviceId:string, deviceShort:string}} me
 * @property {(dv:string) => (Object|null)} attestationOf   `openOp`'s P1
 * @property {Object} [attestation]    MY own attestation, so `sealOp` mirrors the far-side gate
 * @property {() => number} now        injected clock — nothing here reads one
 * @property {{lines:Function, ack:Function}} [outbound]  the family outbox — see NO_OUTBOUND
 * @property {(ms:number, fn:Function) => any} [schedule] @property {(h:any)=>void} [unschedule]
 * @property {() => boolean} [isOnline] @property {(s:Object) => void} [onStatus]
 * @property {(r:Object) => void} [onKeys]  fired when the ring GREW — D9's waiting state clears here
 * @property {(members:Array) => (void|Promise<void>)} [onRoster]  every roster read — see `onRoster` below
 * @property {Object} [envelopeStore] @property {Object} [parkStore] @property {Object} [chainStore]
 * @property {Object} [coverStore] @property {Function} [saveKey]
 * @property {CryptoKey} [recoveryKexPriv]
 * @property {SubtleCrypto} [subtle] @property {(n:number)=>Uint8Array} [random]
 * @property {number} [maxDeferrals] @property {number} [pushDebounceMs]
 */

/**
 * @param {FamilySyncDeps} deps
 */
export function createFamilySync(deps) {
  const d = deps || {};
  const store = d.store;
  const transport = d.transport;
  const spaceId = assertFamilySpace(d.spaceId);

  if (!store || typeof store.applyRemote !== 'function' || typeof store.cursor !== 'function') {
    throw new FamilySyncError('family sync: `store` must be the LZP store (applyRemote/cursor/noteCursor)');
  }
  if (!transport || typeof transport.request !== 'function') {
    throw new FamilySyncError('family sync: `transport` must implement request(method, path, query, body, headers)');
  }
  if (typeof d.now !== 'function') {
    throw new FamilySyncError('family sync: `now` is an injected port — src/js/sync/ reads no clock');
  }
  if (typeof d.attestationOf !== 'function') {
    // FAIL CLOSED, exactly as the personal engine does. Without it every peer envelope parks on
    // P1 for ever — and in a FAMILY space that is every envelope, because every author is a peer.
    throw new FamilySyncError(
      'family sync: `attestationOf` is required — it is openOp\'s P1 and the ONLY source of the '
      + 'verification key (ADR 002 §5.2.1). Without it every family envelope parks, permanently.');
  }
  const me = d.me || {};
  for (const f of ['memberId', 'deviceId', 'deviceShort']) {
    if (typeof me[f] !== 'string' || me[f] === '') {
      throw new FamilySyncError(`family sync: me.${f} is required`);
    }
  }
  if (store._short && me.deviceShort !== store._short) {
    // ADR 002 §5.2.2 check 4. Two shorts in one process is an envelope no peer will ever open,
    // and the failure is remote and silent.
    throw new FamilySyncError(
      `family sync: me.deviceShort ${JSON.stringify(me.deviceShort)} is not the short this store `
      + `stamps with (${JSON.stringify(store._short)}). Every envelope would fail §5.2.2 check 4.`);
  }

  const deviceShort = me.deviceShort;
  const maxDeferrals = Number.isSafeInteger(d.maxDeferrals) && d.maxDeferrals > 0 ? d.maxDeferrals : MAX_DEFERRALS;
  const pushDebounceMs = Number.isSafeInteger(d.pushDebounceMs) && d.pushDebounceMs >= 0
    ? d.pushDebounceMs : CADENCE.pushDebounceMs;
  const ports = { subtle: d.subtle, random: d.random };
  const isOnline = typeof d.isOnline === 'function' ? d.isOnline : () => true;
  const outbound = d.outbound && typeof d.outbound.lines === 'function' ? d.outbound : NO_OUTBOUND;
  const warn = (m) => { if (typeof store._warn === 'function') store._warn(m); };

  // ── ADR 002 §7.1 STEPS 4–6, as a collaborator this engine drives ────────────────────────────
  //
  // It is CONSTRUCTED here rather than injected, and that is the two-scope seam again: a key
  // delivery bound to a different space than the engine is exactly the mix-up 21.2 forbids, so
  // there is no argument that could carry one.
  const keys = createKeyDelivery({
    transport,
    spaceId,
    ring: d.keyring,
    myKexPriv: d.kexPriv,
    myRecoveryKexPriv: d.recoveryKexPriv,
    /**
     * ADR 002 §4.2 step 6's roster, forwarded to whoever owns the attestation tables.
     *
     * This engine does not own them: `openOp`'s P1 (`attestationOf`) and `foldAuthorized` stage
     * 0a (`store.setAttestOpen`) are both built from `recoveryPubSig` + the device blobs, which
     * live in `family/engine.js`. What this engine owns is the fact that the roster was JUST
     * READ — on every admit, every delivery and every rotation — and passing that on is what
     * stops a member who joined after launch from being unattested until the next relaunch.
     */
    onRoster: d.onRoster,
    me,
    now: d.now,
    warn,
    saveKey: d.saveKey,
    coverStore: d.coverStore,
    subtle: d.subtle,
    random: d.random,
    onAdmit: (r) => {
      // D9's WAITING STATE CLEARS ITSELF, HERE, AND NOWHERE ELSE.
      //
      // Mom's board says "the shared entries appear by themselves as soon as another Mac in the
      // circle next syncs". This is that moment: the ring grew, so the sentence has come true and
      // the screen that states it has nothing left to say. It fires on a KEY ARRIVAL and not on a
      // successful HTTP call, because a 200 that admitted nothing is still the waiting state.
      ringGrew = true;
      if (typeof d.onKeys === 'function') {
        try { d.onKeys({ ...r, keysPending: false }); }
        catch { /* a listener that throws may not cost a sync */ }
      }
    },
  });

  /** Set by `onAdmit`; consumed by `syncNow` to re-pull in the SAME pass. See `syncNow`. */
  let ringGrew = false;

  // ── the machinery, shared with the personal engine module for module ────────────────────────

  /** @type {Map<string, Object>} sealed envelopes by opId — a 409 defence, not a cache (§8.1). */
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
      warn(`family sync: the sealed outbox could not be read (${e.message})`);
    }
  }
  function pruneSealed() {
    const live = new Set(outbound.lines({ limit: Infinity }).map((l) => l.op.id));
    for (const oid of [...sealed.keys()]) if (!live.has(oid)) sealed.delete(oid);
  }
  async function saveSealed() {
    if (!d.envelopeStore || typeof d.envelopeStore.save !== 'function') return;
    try { await d.envelopeStore.save(spaceId, [...sealed.values()]); }
    catch { /* a cache that cannot be written costs a re-seal, never a lost op */ }
  }

  const lot = createParkingLot({
    storage: d.parkStore && typeof d.parkStore.loadRecords === 'function' ? d.parkStore : undefined,
    now: () => d.now(),
    warn,
  });
  const cursors = createCursors({
    storage: d.chainStore && typeof d.chainStore.loadCursors === 'function' ? d.chainStore : undefined,
    warn,
  });
  const witness = createChainWitness(ports);

  /** @type {Map<string, {env:Object, seq:bigint, tries:number, why:string, curedBy:string, dormant:boolean}>} */
  const deferred = new Map();
  /** @type {Map<string, {seq:string|null, reason:string}>} */
  const quarantined = new Map();
  const warnedParks = new Set();
  const warnedChain = new Set();
  /** @type {Map<string,string>} seq → the chain the relay served for THAT seq (R8-1b). */
  const chainBySeq = new Map();
  /** @type {Set<string>} seqs a chain finding said this device was owed, still unserved. */
  const chainOwed = new Set();
  let lotLoaded = false;

  async function loadLot() {
    if (lotLoaded) return;
    lotLoaded = true;
    try { await lot.load(); } catch { /* the lot warns for itself */ }
    try {
      await cursors.load();
      witness.restore(spaceId, cursors.head(spaceId), cursors.fromGenesis(spaceId));
    } catch { /* with no anchor this session re-anchors on its first page */ }
    for (const row of lot.parked(spaceId)) {
      if (deferred.has(row.oid)) continue;
      const seq = toSeq(row.seq);
      if (seq === null) continue;
      deferred.set(row.oid, {
        env: row.env,
        seq,
        tries: Number.isInteger(row.tries) ? row.tries : 0,
        why: row.reason,
        curedBy: parkHandlingOf(row.reason).curedBy,
        dormant: false,
      });
    }
  }

  const stats = {
    pushes: 0, pulls: 0, opsPushed: 0, opsApplied: 0, opsDeferred: 0, opsQuarantined: 0, opsHeldForKey: 0,
    lastPullAt: null, lastPushAt: null, consecutiveFailures: 0, lastError: null, protocol: null,
    keyPasses: 0, deliveries: 0,
  };

  let attached = false;
  let unsubscribe = null;
  let pushTimer = null;
  let running = null;

  // ── sealing ─────────────────────────────────────────────────────────────────────────────────

  /**
   * Seal one family op. Identical in shape to the personal engine's — the header is
   * AUTHENTICATED rather than derived, `wit` is the highest chain value THIS device has been
   * served, and the bytes are frozen once sealed because the relay answers `409 forked_op_id`
   * when a re-push differs in any authenticated field.
   *
   * The one family-specific line is the epoch: `keyring.currentEpoch(spaceId)` is the FAMILY
   * ring's, and a device with no family key seals nothing at all rather than falling back to
   * anything. There is no fallback to fall back to — 21.2.
   */
  async function sealLine(op) {
    const cached = sealed.get(op.id);
    if (cached) return cached;
    const epoch = typeof d.keyring?.currentEpoch === 'function' ? d.keyring.currentEpoch(spaceId) : 0;
    if (!epoch) {
      throw new FamilySyncError(
        `family sync: the key ring holds no key for ${spaceId}. Nothing is pushed unencrypted, ever. `
        + 'This device is still waiting for another member Mac to deliver the ring (ADR 002 §7.1 '
        + 'step 4, PO decision D9).',
        'key');
    }
    const env = await sealOp(op, d.keyring, d.sigPriv, {
      v: 1, sp: spaceId, ep: epoch, dv: deviceShort, oid: op.id, wit: witness.witness(spaceId),
    }, {
      ...ports,
      ...(d.attestation ? { attestation: d.attestation } : {}),
      // ── ADR 004 §2.2, barriers 2 and 4 — WITHOUT THESE THE ENGINE SEALS NO SHARED ENTRY ─────
      //
      // Measured, and it is why they are here rather than in a follow-up: `sealOp` refuses a
      // family `pub.set` outright when either is absent, so every shared entry this device
      // authored was quarantined with `seal: sealOp: no ctx.levelOf` — the push path was real,
      // the outbox was real, and 18.1 still shared nothing. The two together are the whole of
      // "plaintext leaves a device through exactly one function".
      assertFamilyPatch,
      levelOf,
    });
    sealed.set(op.id, env);
    return env;
  }

  /**
   * BARRIER 4's source, resolved ONCE at construction rather than per op.
   *
   * `store.familyLevelOf` reads the entity's own `visibility` truth register (ADR 004 §2.2 as
   * amended by finding S5). A store that predates it would make every `pub.set` unsealable — so
   * the absence is reported here, by name, with the file that owns the seam, instead of surfacing
   * three layers down as a `RedactionError` about a missing callback.
   */
  function levelOf(entityKey) {
    if (typeof store.familyLevelOf !== 'function') {
      throw new FamilySyncError(
        'family sync: this store has no `familyLevelOf(entityKey)`. ADR 004 §2.2 barrier 4 requires '
        + 'the seal level to be re-derived from the entity\'s own `visibility` truth register, and '
        + '`src/js/store.js` owns that reader. Nothing is sealed from a guess.', 'config');
    }
    return store.familyLevelOf(entityKey);
  }

  // ── push ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Drain the family outbox in `LIMITS.opsPerPush` batches (ADR 003 §3.1, §6.1).
   *
   * With `NO_OUTBOUND` this is a no-op that returns `{pushed:0, batches:0}` on the first line,
   * which is the honest answer for a build whose family projection does not exist yet. Every
   * other line is the real path and is driven by `tests/tier1/sync-family.test.js` §4.
   */
  async function pushNow() {
    if (!isOnline()) { emitStatus(); return { pushed: 0, batches: 0, skipped: 'offline' }; }
    await loadSealed();
    let pushed = 0;
    let batches = 0;
    for (;;) {
      const lines = outbound.lines({ limit: LIMITS.opsPerPush });
      if (!lines.length) break;

      const envelopes = [];
      const oids = [];
      for (const line of lines) {
        if (quarantined.has(line.op.id)) continue;
        let env;
        try {
          env = await sealLine(line.op);
        } catch (e) {
          // ══════════════════════════════════════════════════════════════════════════════════════
          // "NO KEY YET" IS D9'S WINDOW, NOT A DEFECT IN THE OP — AND QUARANTINING IT WAS A BUG.
          // ══════════════════════════════════════════════════════════════════════════════════════
          //
          // Measured on a real join: Mama's Mac authors `attestMyDevice` + `setMyProfile` the
          // moment she is admitted (`createjoin.js#adoptCircleIntoLog`), and at that moment she
          // holds no epoch key — that IS the state D9 designs for. `sealLine` throws `kind:'key'`,
          // this catch quarantined both ops, and a quarantine has NO CURE. So the two ops that
          // tell the family who she is were destroyed by the very window the product exists to
          // make survivable: her name and her device attestation would never have been published,
          // and every op she ever authored afterwards would have parked on every peer as
          // `unattestedDevice`, permanently.
          //
          // The distinction is whether the failure can be cured by something that has not happened
          // yet. A key that has not arrived is cured by the next member Mac's delivery (§7.1 step
          // 4) — so the line is LEFT IN THE OUTBOX, untouched, and the next push tries again. An
          // op this build would refuse on its SHAPE is cured by nothing and is quarantined, which
          // is the case this catch was written for.
          if (e instanceof FamilySyncError && e.kind === 'key') {
            stats.opsHeldForKey = (stats.opsHeldForKey || 0) + 1;
            break;                             // the whole batch waits; order in the log is kept
          }
          // An op THIS BUILD would refuse to seal is one no peer could open. It is quarantined
          // rather than retried for ever — and it stays in the log and on screen, because a board
          // entry is never deleted for a transport failure (principle 6).
          quarantined.set(line.op.id, { seq: null, reason: `seal: ${e.message}` });
          stats.opsQuarantined += 1;
          warn(`family sync: an entry could not be shared (${e.message}). It is still on your board.`);
          continue;
        }
        envelopes.push(env);
        oids.push(line.op.id);
      }
      if (!envelopes.length) break;
      await saveSealed();                            // durable BEFORE the push, never after

      const res = normalizeResponse(await transport.request('POST', '/api/v1/ops', {}, {
        space: spaceId,
        ackSeq: store.cursor(spaceId),
        ops: envelopes,
        drained: envelopes.length < LIMITS.opsPerPush,
      }, {}));

      noteProtocol(res);
      if (res.status !== 200) {
        stats.consecutiveFailures += 1;
        stats.lastError = errorOf(res);
        if (res.status === 409) {
          const forked = res.json && typeof res.json.oid === 'string' ? [res.json.oid] : oids;
          for (const id of forked) quarantined.set(id, { seq: null, reason: 'forked_op_id' });
          stats.opsQuarantined += forked.length;
          warn('family sync: the relay already holds a different change under one of these ids '
            + '(forked_op_id). Nothing was uploaded and your board is unchanged.');
        }
        emitStatus();
        return { pushed, batches };
      }

      const body = res.json || {};
      const acks = [...(body.accepted || []), ...(body.duplicate || [])]
        .filter((a) => a && typeof a.oid === 'string' && toSeq(a.seq) !== null);
      outbound.ack(acks);
      pruneSealed();                                  // against the OUTBOX, not the ack list
      await saveSealed();
      pushed += acks.length;
      batches += 1;
      stats.opsPushed += acks.length;
      stats.consecutiveFailures = 0;
      stats.lastError = null;
      stats.lastPushAt = d.now();
      if (!acks.length) break;
      if (envelopes.length < LIMITS.opsPerPush) break;
    }
    stats.pushes += batches;
    emitStatus();
    return { pushed, batches };
  }

  // ── pull ────────────────────────────────────────────────────────────────────────────────────

  /**
   * One pull pass over the family stream.
   *
   * THE ORDER IS THE INVARIANT (ADR 003 §3.3 + ADR 006 §9.1 W1) and it is the same one the
   * personal engine keeps, for the same reasons:
   *
   *     open ──▶ store.applyRemote ──▶ await store.persistNow() ──▶ store.noteCursor
   *
   * `store.cursor(spaceId)` and `store.noteCursor(spaceId, …)` already take a space, and
   * `store.applyRemote` already admits a family op (its space filter refuses only the `local`
   * space and a FOREIGN personal one), so the inbound half needs no store change at all — which
   * is why D9's content half is reachable from here and the outbound half is not.
   *
   * @returns {Promise<{applied:number, deferred:number, cursor:string, hasMore:boolean}>}
   */
  async function pullNow() {
    await loadLot();
    // R10-9d — a new pull, so the lot's "still cannot open this" marks start empty.
    await lot.release(spaceId, []);
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

    // ── ADR 002 §5.4 — the relay's own claims must add up ────────────────────
    // `wit` and `dv` are relay data and are copied WITHOUT validation on purpose (R10-1):
    // `chain.js` treats a `wit` it cannot place as a FINDING, never as a throw.
    const rows = [];
    for (const e of page) {
      if (e && typeof e.oid === 'string' && e.seq !== undefined) {
        rows.push({ seq: String(e.seq), chain: e.chain, env: { oid: e.oid, wit: e.wit, dv: e.dv } });
      }
    }
    if (witness.head(spaceId) === null && rows.length && (toSeq(since) ?? 0n) !== 0n) {
      // No head and a page that does not start at genesis: RESTORE on the first row rather than
      // accuse an honest relay of forging a chain this device has no anchor for, and withhold the
      // right to call an unknown witness a fork (`fromGenesis: false`).
      witness.restore(spaceId, { seq: rows[0].seq, chain: rows[0].chain }, false);
    }
    const headBefore = witness.head(spaceId);
    const chainHoles = [];
    let found = [];
    try {
      found = await witness.observe(spaceId, rows);
    } catch (err) {
      found = [{ kind: 'unreadable', detail: `${err.name}: ${err.message}` }];
    }
    const headAfter = witness.head(spaceId);
    const foldedFresh = headAfter !== null
      && (headBefore === null || (toSeq(headAfter.seq) ?? 0n) > (toSeq(headBefore.seq) ?? 0n));
    let owedFilled = false;
    for (const r of rows) if (chainOwed.delete(r.seq)) owedFilled = true;
    // R10-1b — a finding that says "not evidence" may not be read as evidence.
    const evidence = found.filter((f) => f && f.kind !== CHAIN_FINDINGS.UNVERIFIABLE_WITNESS);
    const chainVerified = (foldedFresh || owedFilled) && evidence.length === 0;
    if (evidence.length) noteChain('chain', found);

    const genesisPage = headBefore === null && rows.length > 0;
    for (const fi of found) {
      const from = fi && fi.from !== undefined ? toSeq(fi.from) : null;
      if (from !== null) {
        chainHoles.push(from + 1n);
        chainOwed.add(String(from + 1n));
        while (chainOwed.size > CHAIN_SEQ_MEMORY) chainOwed.delete(chainOwed.values().next().value);
        continue;
      }
      // R10-2b — the GENESIS page is defended the way every later page is, and in a family space
      // that is the page EVERY new member makes first (D9's whole population).
      if (!genesisPage || fi.kind !== CHAIN_FINDINGS.MISMATCH) continue;
      const brokeAt = toSeq(fi.seq);
      if (brokeAt === null || String(fi.seq) !== String(rows[0].seq)) continue;
      chainHoles.push(brokeAt);
    }
    for (const r of rows) {
      if (typeof r.chain === 'string' && r.chain !== '') chainBySeq.set(r.seq, r.chain);
    }
    while (chainBySeq.size > CHAIN_SEQ_MEMORY) chainBySeq.delete(chainBySeq.keys().next().value);

    // The PAGE CLAIM: `nextCursor` may not run past the last row the relay actually served.
    const served = rows.length ? toSeq(rows[rows.length - 1].seq) : null;
    const claimed = toSeq(body.nextCursor);
    const claimFloor = served === null ? (toSeq(since) ?? 0n) : served;
    const claimSound = claimed === null || claimed <= claimFloor;
    if (!claimSound) {
      chainHoles.push(claimFloor + 1n);
      noteChain('withheld', [{
        kind: 'withheld',
        seq: String(body.nextCursor),
        from: String(claimFloor),
        detail: `the relay served ${rows.length} row(s) up to seq ${claimFloor} and asked this `
          + `device to move its cursor to ${body.nextCursor}.`,
        benignCause: 'member-purge',
      }]);
    }
    if (chainVerified && claimSound && 'syncChain' in store) store.syncChain = null;

    // ── the re-try set comes FIRST, and in seq order ─────────────────────────
    /** @type {Array<{env:Object, seq:bigint, retry:boolean}>} */
    const work = [];
    for (const [, held] of deferred) {
      if (held.dormant) continue;
      work.push({ env: held.env, seq: held.seq, retry: true });
    }
    for (const e of page) {
      const seq = toSeq(e && e.seq);
      if (seq === null) continue;
      if (deferred.has(e.oid) || quarantined.has(e.oid)) continue;
      work.push({ env: e, seq, retry: false });
    }
    work.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));

    const opened = [];
    const seqs = Object.create(null);
    /** seq → why it is held. The cursor stops BELOW the smallest of these. */
    const holds = new Map();
    const toPark = [];
    const toRefuse = [];
    for (const chainHole of chainHoles) holds.set(chainHole, 'withheld');

    for (const item of work) {
      let out;
      try {
        out = await openOp(item.env, d.keyring, d.attestationOf, ports);
      } catch (e) {
        terminal(item, `envelope: ${e.message}`);
        continue;
      }
      if (out && out.status === 'park') {
        // ⚠ `ENVELOPE_PARK.EPOCH` IS THE ORDINARY FIRST CONTACT IN A FAMILY SPACE, not an edge.
        // A joiner between §7.1 steps 2 and 6 parks EVERY op on it, by design, and the cure is a
        // key fetch rather than a re-pull — which is why `syncNow` runs `keys.admit()` first and
        // re-pulls when the ring grew. `PARK_HANDLING` already says `curedBy: 'session'` for it,
        // so no new rule is added here: the shared table is simply correct about the family case.
        parked(item, out.parkReason);
        continue;
      }
      const op = out && out.status === 'opened' ? out.op : (out && out.op ? out.op : out);
      if (!op || typeof op !== 'object' || typeof op.id !== 'string') {
        parked(item, 'unreadableOutcome');
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
      const answered = new Set(applied);
      for (const ref of (r?.refused || [])) {
        if (ref && typeof ref.id === 'string') answered.add(ref.id);
        const item = byId.get(ref.id);
        if (!item) continue;
        // `unattestedDevice` is the family twin of M1's `notMyDevice` and it is CURABLE: the
        // author's `member.set{dev.*}` can arrive in a later page. The store has ALSO parked the
        // line (`applyRemote`'s F-6 branch), so there are two independent copies of the hold and
        // `store.unparkAttested()` below is what re-judges the second one.
        if (isCurable(ref.reason)) defer(item, ref.reason);
        else terminal(item, `refused: ${ref.reason}`);
      }
      for (const o of opened) if (!answered.has(o.op.id)) defer(o.item, 'notReported');
      for (const id of applied) deferred.delete(id);
      stats.opsApplied += applied.length;
      for (const id of applied) quarantined.delete(id);
      if (applied.length && typeof store.retractSyncRefusal === 'function') {
        try { store.retractSyncRefusal(applied); } catch { /* diagnostics may never break a pull */ }
      }
    }

    // ── the durable park is written BEFORE the cursor moves ──────────────────
    for (const p of toPark) {
      let kept = true;
      try { kept = await lot.park(spaceId, p.env, String(p.seq), p.reason); }
      catch { kept = false; }
      if (!kept) holds.set(p.seq, `park-full:${p.reason}`);
    }
    for (const r of toRefuse) {
      try { await lot.refuse(spaceId, [r.oid]); } catch { /* next pull */ }
    }

    // ── W1: persist BEFORE the cursor moves ──────────────────────────────────
    if (applied.length) await store.persistNow();
    if (applied.length) { try { await lot.release(spaceId, applied); } catch { /* next pull */ } }

    let commit = toSeq(since) ?? 0n;
    const floor = holds.size ? [...holds.keys()].reduce((a, b) => (a < b ? a : b)) : null;
    for (const item of work) {
      if (floor !== null && item.seq >= floor) break;
      if (item.seq > commit) commit = item.seq;
    }
    const nextCursor = toSeq(body.nextCursor);
    if (floor === null && claimSound && nextCursor !== null && nextCursor > commit) commit = nextCursor;

    const at = toSeq(since) ?? 0n;
    const fromGenesisNow = witness.snapshot()[spaceId]?.fromGenesis === true;
    if (commit > at || cursors.fromGenesis(spaceId) !== fromGenesisNow) {
      const anchorAt = chainBySeq.get(String(commit)) ?? '';
      const record = commit > at || anchorAt !== '' ? { seq: String(commit), chain: anchorAt } : null;
      await cursors.advance(
        spaceId, String(commit), record,
        async () => { store.noteCursor(spaceId, String(commit)); },
        { fromGenesis: fromGenesisNow },
      );
    }

    // ── L-3 · THE REAPER, ON THE ORDINARY SCHEDULE ───────────────────────────
    //
    // Round 8's L-3 in one sentence: `store.unparkAttested()` exists and nothing called it except
    // `family/mount.js` on the adoption of a peer, so a hold whose cure arrived by ANY other route
    // was never looked at again. In a FAMILY space that is not a corner — it is the main road.
    // Every peer's ops are refused as `unattestedDevice` until that member's own
    // `member.set{dev.*}` has been folded, and once the ladder has released the cursor the parked
    // LINE is the only copy this Mac can reach. This is the call that re-judges it.
    if (typeof store.unparkAttested === 'function') {
      let promoted = [];
      try { promoted = store.unparkAttested() || []; }
      catch { /* the store warns; a reaper may not break a pull */ }
      if (promoted.length) {
        // W1 again: the cursor is ALREADY past these ops, so a quit inside `unparkAttested`'s
        // debounced persist would leave the board without the entry and the cursor beyond it.
        await store.persistNow();
        if (Array.isArray(store.syncRefusals) && store.syncRefusals.length) {
          const landed = new Set(promoted);
          const kept = store.syncRefusals.filter((r) => !landed.has(r && r.oid));
          if (kept.length !== store.syncRefusals.length) {
            store.syncRefusals.length = 0;
            for (const r of kept) store.syncRefusals.push(r);
            await store.persistNow();
          }
        }
      }
    }

    emitStatus();
    return {
      applied: applied.length,
      deferred: deferred.size,
      cursor: store.cursor(spaceId),
      hasMore: body.hasMore === true,
    };

    function parked(item, parkReason) {
      const h = parkHandlingOf(parkReason);
      if (!h.known && !warnedParks.has(parkReason)) {
        warnedParks.add(parkReason);
        warn(`family sync: a change from the Familienkreis is being held for a reason this version `
          + `does not recognise (${parkReason}). It is kept, not discarded.`);
      }
      toPark.push({ env: envelopeOnly(item.env), seq: item.seq, reason: parkReason });
      defer(item, parkReason, h.curedBy);
    }

    function defer(item, why, curedBy = 'session') {
      const oid = keyOf(item);
      const prev = deferred.get(oid);
      const tries = (prev ? prev.tries : 0) + 1;
      const dormant = curedBy === 'update' && lot.diagnostics().durable === true;
      if (!dormant && tries > maxDeferrals) {
        deferred.delete(oid);
        terminal(item, `still ${why} after ${maxDeferrals} attempts`);
        return;
      }
      deferred.set(oid, { env: item.env, seq: item.seq, tries, why, curedBy, dormant });
      if (!dormant) holds.set(item.seq, why);
      if (!prev) stats.opsDeferred += 1;
    }

    function terminal(item, reason) {
      const oid = keyOf(item);
      deferred.delete(oid);
      // R8-4 — "not replayed" is not "destroyed". `refuse()` shelves the bytes; the next launch
      // gives them `PARK_REVIVALS` more chances, and the refusal below is retracted if one lands.
      toRefuse.push({ oid, reason });
      quarantined.set(oid, { seq: String(item.seq), reason });
      stats.opsQuarantined += 1;
      if (Array.isArray(store.syncRefusals)) {
        store.syncRefusals.push({ oid, seq: String(item.seq), reason, at: d.now() });
      }
      warn(`family sync: one change from the Familienkreis could not be applied (${reason}). `
        + 'It is not lost on the Mac that made it; nothing here was changed.');
    }

    function keyOf(item) {
      const oid = item.env && item.env.oid;
      return typeof oid === 'string' && oid !== '' ? oid : `seq:${String(item.seq)}`;
    }

    function envelopeOnly(env) {
      const out = {};
      for (const k of ENVELOPE_KEYS) out[k] = env ? env[k] : undefined;
      return out;
    }

    function noteChain(kind, findings) {
      if (!('syncChain' in store)) return;
      store.syncChain = { ok: false, kind, findings: findings || [], at: d.now() };
      if (warnedChain.has(kind)) return;
      warnedChain.add(kind);
      warn(kind === 'withheld'
        ? 'sync: the server\'s record of this shared board does not add up — it asked this device '
          + 'to skip over changes it never sent (ADR 002 §5.4). Nothing was accepted on its word; '
          + 'the cursor is held, so those changes are still owed.'
        : 'sync: this device can no longer check the server\'s record of this shared board against '
          + 'itself. If somebody was removed from the circle, that is expected and nothing is '
          + 'wrong: their changes were deleted with them. Syncing continues either way.');
    }
  }

  // ── the pass ────────────────────────────────────────────────────────────────────────────────

  /**
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   * ONE ORDINARY SYNC — and this ORDER is the whole of D9 part 4.
   * ═════════════════════════════════════════════════════════════════════════════════════════════
   *
   *   1. `keys.admit()`   STEPS 5–6. Ask for the wraps addressed to me. On the joiner's Mac this
   *                       is where the ring arrives; on everybody else's it is a 200 that admits
   *                       nothing and costs one request.
   *   2. PULL, to the end of the stream.
   *   3. a SECOND sweep, only if the ring grew AND something is still held for want of an epoch.
   *   4. `keys.deliver()` STEP 4. Any member device that holds the ring hands it to a recipient
   *      that provably does not. Quiet in the steady state; see `keys.js` §4.
   *   5. PUSH.
   *
   * **STEP 1 IS FIRST, AND THAT ORDER IS WHAT MAKES D9'S WAITING STATE CLEAR ITSELF.** Not a
   * retry, not a second pass, not a notification: the key arrives BEFORE the envelopes are opened,
   * so on the very sync where the ring lands, the ops parked on `ENVELOPE_PARK.EPOCH` — held in
   * `deferred`, retained in the durable lot, with the cursor held below them — are handed to
   * `openOp` with a ring that now has the key, and the board fills in inside the same pass. Put
   * the key pass after the pull instead and everything still works, one poll later; "one poll
   * later" is 45 seconds of a person watching a board that was promised it would fill in by
   * itself, which is the difference between a designed waiting state and a broken one.
   *
   * **STEP 3 IS A BACKSTOP AND IS LABELLED AS ONE.** With step 1 first it does not normally fire —
   * measured: `tests/tier1/sync-family.test.js` §3d asserts the op lands with `recovered === 0`.
   * Its condition is narrow on purpose (`ringGrew` AND an epoch-hold survived the pull), so it
   * costs nothing on the ordinary path and covers the one case the order alone does not: a ring
   * that grows from `saveKey`/`loadLot` racing a pull, where the first sweep saw the old ring.
   * Reverting it kills no test today; the CLAIM is what is pinned, by §3d's `recovered` reading.
   *
   * Delivery is AFTER the pull rather than before it because the roster read in step 4 should be
   * the freshest one available when the decision to rotate is made, and because a device that has
   * just admitted the ring in step 1 is then able to deliver it onward in the same pass — which
   * is what makes a three-person family converge in two polls instead of three.
   */
  async function syncNow() {
    if (running) return running;
    running = (async () => {
      if (!isOnline()) { emitStatus(); return { skipped: 'offline' }; }
      ringGrew = false;
      let admitted = null;
      try {
        admitted = await keys.admit();
        stats.keyPasses += 1;
      } catch (e) {
        // A key pass that throws must not take the sync with it: the ops are still there and the
        // cursor is still honest. It is reported and the pull runs anyway, which is what keeps a
        // relay that mangles ONE endpoint from wedging the whole space.
        warn(`family sync: the key exchange did not complete (${e.message}). Syncing continues; `
          + 'entries that need a key stay held rather than lost.');
        stats.lastError = { status: 0, error: 'keys' };
      }

      let guard = 0;
      let more = true;
      let applied = 0;
      while (more && guard < 64) {
        guard += 1;
        // eslint-disable-next-line no-await-in-loop
        const r = await pullNow();
        applied += r.applied;
        more = r.hasMore;
      }
      // The backstop of step 3. Bounded to ONE extra sweep: the ring cannot grow again inside it,
      // because nothing in `pullNow` fetches a key. Guarded on an epoch-hold actually surviving,
      // so an ordinary pass makes no second round trip.
      let recovered = 0;
      const stillWaiting = [...deferred.values()].some((h) => h.why === 'epoch');
      if (ringGrew && stillWaiting) {
        let g2 = 0;
        let more2 = true;
        while (more2 && g2 < 64) {
          g2 += 1;
          // eslint-disable-next-line no-await-in-loop
          const r = await pullNow();
          recovered += r.applied;
          more2 = r.hasMore;
        }
      }

      let delivery = null;
      try {
        delivery = await keys.deliver();
        if (delivery.verdict === DELIVERY.DELIVERED) stats.deliveries += 1;
      } catch (e) {
        warn(`family sync: this device could not hand the shared keys to a new member (${e.message}).`);
      }

      const pushed = await pushNow();
      return { ok: true, admitted, delivery, recovered, applied, pushed: pushed.pushed };
    })().finally(() => { running = null; });
    return running;
  }

  // ── status ──────────────────────────────────────────────────────────────────────────────────

  function errorOf(res) {
    const code = res.json && typeof res.json.error === 'string' ? res.json.error : null;
    return { status: res.status, error: code };
  }

  function noteProtocol(res) {
    const h = res.headers || {};
    const min = h['x-lzp-min-protocol'] ?? h['X-LZP-Min-Protocol'];
    const max = h['x-lzp-protocol'] ?? h['X-LZP-Protocol'];
    if (min !== undefined || max !== undefined) stats.protocol = { min: Number(min), max: Number(max) };
  }

  /**
   * ADR 003 §8.3's three states, plus the one state only a family space has.
   *
   * **A DEVICE WAITING FOR THE RING IS `pending`, NEVER `error`** — D9 says so in as many words
   * ("never render as an error, a failure, or a retry prompt"), and it is also simply true:
   * nothing has failed, a member device will deliver, and the ops are held rather than lost. It
   * reaches the caller as `keysPending` so a screen can say the calm sentence, and it raises the
   * three-state ladder no higher than `pending`.
   */
  function status() {
    const pending = outbound.lines({ limit: Infinity }).length;
    const kd = keys.diagnostics();
    const waiting = kd.keysPending === true || (d.keyring && d.keyring.currentEpoch(spaceId) === 0);
    let state = 'healthy';
    let errorKind = null;
    if (quarantined.size) { state = 'error'; errorKind = 'quarantine'; }
    else if (stats.consecutiveFailures >= 5) { state = 'error'; errorKind = 'offline'; }
    else if (stats.lastError && [401, 403].includes(stats.lastError.status)) { state = 'error'; errorKind = 'auth'; }
    else if (stats.lastError && stats.lastError.status === 426) { state = 'error'; errorKind = 'protocol'; }
    else if (pending > 0 || deferred.size > 0 || waiting || !isOnline() || stats.consecutiveFailures > 0) {
      state = 'pending';
    }

    const judged = judgeSyncStatus({
      engine: {
        state, pendingOps: pending, consecutiveFailures: stats.consecutiveFailures,
        lastPullAt: stats.lastPullAt, errorKind, detail: null,
      },
      diagnostics: typeof store.diagnostics === 'function' ? store.diagnostics() : null,
      held: lotLoaded ? shelvedDetail(lot, [spaceId]) : null,
    });
    return {
      ...judged,
      deferredOps: deferred.size,
      // D9's fact, carried where a screen can read it without importing this module's internals.
      keysPending: waiting,
      epochs: d.keyring ? d.keyring.epochs(spaceId) : [],
    };
  }

  function emitStatus() {
    if (typeof d.onStatus === 'function') d.onStatus(status());
  }

  // ── attach ──────────────────────────────────────────────────────────────────────────────────

  function attach() {
    if (attached) return () => {};
    attached = true;
    unsubscribe = store.subscribe((_state, reason) => {
      if (reason === 'remote' || reason === 'init' || reason === 'settings') return;
      schedulePush();
    });
    emitStatus();
    loadLot()
      .then(() => { if (attached) emitStatus(); })
      .catch(() => {});
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

  async function flush() {
    if (typeof store.flushSync === 'function') store.flushSync();
    return pushNow();
  }

  return {
    spaceId,
    kind: 'family',
    attach,
    detach,
    pushNow,
    pullNow,
    syncNow,
    flush,
    status,
    /** ADR 002 §7.1 steps 4–6, exposed so an admin panel can drive a removal's rotation (20.2). */
    keys,
    /**
     * **ADR 002 §5.1 — `Envelope.wit`, the chain head this device has actually pulled.**
     *
     * Exposed because a caller that seals an op OUTSIDE `pushNow` (today: `family/removal.js`,
     * which posts the removal op on its own so it can order the rotation before it) would
     * otherwise have to publish `wit: ''`. `chain.js#observe` SKIPS `''` rather than misreading
     * it — correct for a genuine first push — so the effect is not a wrong commitment but no
     * commitment: one op per removal outside §5.4's fork detector. One reader closes that.
     *
     * It is a READ. Nothing here advances the witness; only `pullNow` does, from bytes the relay
     * actually served.
     * @param {string} [space] defaults to this engine's own space — the only one it can answer for
     */
    witness: (space) => witness.witness(space === undefined ? spaceId : assertFamilySpace(space)),
    deferredOps: () => [...deferred.entries()].map(([oid, v]) => ({
      oid, seq: String(v.seq), tries: v.tries, why: v.why, curedBy: v.curedBy ?? 'session',
    })),
    quarantined: () => [...quarantined.entries()].map(([oid, v]) => ({ oid, ...v })),
    heldEnvelopes: async () => { await loadLot(); return lot.parked(spaceId); },
    diagnostics: () => ({
      spaceId,
      kind: 'family',
      deviceShort,
      cursor: store.cursor(spaceId),
      epochs: d.keyring ? d.keyring.epochs(spaceId) : [],
      sealedCached: sealed.size,
      deferred: deferred.size,
      quarantined: quarantined.size,
      park: lot.diagnostics(),
      protocol: stats.protocol,
      /**
       * ⚠ THE HALF THIS ENGINE DOES NOT OWN, REPORTED RATHER THAN HIDDEN. `wired: false` means
       * the family OUTBOX port was never supplied, so this device shares nothing — not because
       * sharing failed, but because `store.outbox()` cannot answer for a family space and
       * `core/ops.js` refuses to author a family op without `ctx.familySpaceId`. See the header.
       */
      outbound: { wired: outbound !== NO_OUTBOUND, owner: NO_OUTBOUND.owner, pending: outbound.lines({ limit: Infinity }).length },
      keys: keys.diagnostics(),
      coverage: keys.coverage(),
      ...stats,
    }),
  };
}
