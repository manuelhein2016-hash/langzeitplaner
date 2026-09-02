// src/js/family/unshare.js — LZP-903.  THE ADMIN UNSHARE, END TO END.
// Story 18.3 · ADR 004 §5 (the admin-unshare transition row), §5.1, §5.3, §7 · ADR 001 §4.1,
// §4.3 stage 3a, §4.4 · ADR 002 §7.4 (the copy contract) · DESIGN-DECISIONS D7.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE STORY, AND THE THREE PROPERTIES IT IS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   > "As admin I can **unshare** any entry from the family space — it reverts to owner-private,
//   >  **it is never deleted** — so moderation is possible but non-destructive, and I still can't
//   >  read what was never shared."
//
// Three claims, and not one of them is kept by this file remembering to keep it:
//
//   1. **IT REVERTS.** The op is `core/project.js:adminUnshareOp`, whose patch is
//      `retractPatch(kind)` — `pub.level: 'privat'` plus an explicit `null` in every other
//      withdrawable register (INV-R4; omission is not withdrawal). ADR 004 §4.2 drops a `privat`
//      publication before it ever consults the tombstone, so the entry leaves every peer's board.
//
//   2. **IT IS NEVER DELETED.** The patch is `pub.*` only. There is no `_alive` in it, `pub.alive`
//      is NULLED rather than set `false`, and this Mac cannot address the owner's personal space
//      at all — `core/ops.js:spaceFor` sends a `note.set` to MY personal space, and the owner's
//      truth registers do not exist here to write. The entry survives on the owner's board, in
//      full, in their own category colour. What ends is its publication, and nothing else.
//
//   3. **I STILL CAN'T READ WHAT WAS NEVER SHARED.** `run()` takes an ENTITY KEY and nothing
//      else, and a Privat entry has no family entity key on this Mac to name (16.1 — a Privat
//      entry produces no family op at all, so no register, so no key). There is no browse, no
//      list of other people's entries, and no parameter through which content could enter.
//      Moderation reaches exactly as far as disclosure did, and no further.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE BLOCKER THIS TICKET INHERITED, AND WHERE IT WAS CLOSED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// E7 left 18.3 unsealable, and the sentence is worth keeping verbatim because it names the trap:
//
//   > "Barrier 4 reads `ctx.levelOf` from the entity's own `visibility` truth register, and an
//   >  admin unsharing SOMEONE ELSE'S entry has no such register — `store.familyLevelOf`
//   >  correctly answers `null`, and 'no authenticated level' is a refusal. `retractPatch(kind)`
//   >  produces the right bytes and no `levelOf` can authorise them."
//
// The trap is that the obvious fix — let the caller say `'privat'` — is finding S5 rebuilt, and
// S5 is the one that shipped a `pub.text` for an entry the register map called *belegt*. So the
// answer is not a level from anywhere: `crypto/envelope.js`'s **barrier-4 retraction clause**
// applies the LITERAL `'privat'` to a patch that can only be a withdrawal, and vouches for it
// with a SECOND authenticated source that is not the caller — `ctx.adminOf(space)`, the family
// space's `admin` register as resolved by the admin chain and folded by `foldAuthorized`. This
// file wires that port, and it wires it to `store.familyAdmin().admin` and to nothing else.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// AND IT IS NOT WHERE AUTHORITY IS DECIDED — D7, WHICH IS SETTLED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// LZP-901 asked for server-side validation that non-owners cannot mutate. The relay holds
// ciphertext and cannot know who owns what, so that check cannot exist. The ruling stands:
// **ownership is structural** — the family entity key carries the owner's MemberId, so there is
// nothing to forge and nothing to backdate (property P9) — every honest client applies the same
// **deterministic authorization fold**, and the server validates what it legitimately can see.
//
// For this file that has one concrete consequence, and it is the reason for the order below:
// **the admin's own Mac learns the outcome the way every other Mac learns it.** `run()` publishes
// and then calls `syncNow()`; the op comes back on the admin's own next pull and is folded through
// `store.applyRemote → foldAuthorized`, where `core/authz.js` stage 3a re-decides it from `op.ts`
// against the accepted chain. There is deliberately no local-append shortcut. A moderation that
// took a different path on the admin's Mac than on Mama's is a moderation whose only untested path
// is the one the admin can see — and "it looked right on my machine" is how 18.3 ships broken.
//
// A member who patches their client past every check in this file therefore emits an op every
// honest device REJECTS (`NOT_OWNER` at stage 3a), including their own. Enforcement is by
// convergence, not by gatekeeper.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE REFUSES TO DO
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// **IT NEVER BUILDS A FAMILY PATCH.** `sharing.js` says the same sentence for the owner's control
// and it is the same rule here: the bytes come from `core/project.js` and there is no second
// producer. A patch assembled in `family/` would have to be branded to be sealable, which means
// forging `Symbol.for('lzp/v2/family-patch')`. Nothing here does; `adminUnshareOp` is the door.
//
// **IT NEVER MINTS AN ADMIN CHAIN.** Same refusal as `removal.js`, same reason: `resolveChain`
// roots on `adminPrev === null ∧ act === admin`, so a link minted late beats one minted at
// creation, and a module that mints a root on behalf of whoever is clicking hands the seat — and
// with it this very primitive over every member's entries — to anybody who can reach this code
// path. It reports `UNSHARE_BLOCKERS.NO_ADMIN_CHAIN` instead. Owner: `family/createjoin.js`.
//
// **IT NEVER PURGES THE RELAY.** ADR 003 §6.3: an endpoint that lets any member delete another
// member's ops from the relay is a censorship primitive. The retraction is a NEW op at a NEWER
// stamp, and the old ops stay exactly where they are. That is also why the copy below can promise
// only the next sync, and says so.
//
// **IT NOTIFIES NOBODY.** Principle 9 / addendum §6: no „Papa hat deinen Eintrag entfernt", no
// marker, no counter. There is no op kind that could carry one (ADR 004 §7 — the eight kinds are
// the whole vocabulary), and the owner's side of this — `adminUnshareFollowUp` — is one silent
// `visibility` write. The four forbidden phrases of ADR 002 §7.4 („gelöscht bei allen",
// „zurückgezogen", „niemand kann es mehr sehen", „live") appear nowhere in this file except in
// this paragraph, which is prose, and `tests/tier1/unshare.test.js` sweeps every string it can
// produce, in both languages, to keep that true.

import { parseEntityKey } from '../core/entities.js';
import { adminUnshareOp, assertFamilyPatch } from '../core/project.js';
import { classifyUnsharePatch } from '../core/authz.js';
import { sealOp } from '../crypto/envelope.js';
import { PATHS } from '../sync/protocol.js';
import { TXT as SHARING_TXT } from './sharing.js';
import { store as liveStore } from '../store.js';
import { circleEngine } from './mount.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. VERDICTS, BLOCKERS AND COPY — every answer as data, never as a silent no-op
// ═════════════════════════════════════════════════════════════════════════════════════════════

export class UnshareError extends Error {
  /** @param {string} message @param {string} [kind] */
  constructor(message, kind = 'config') {
    super(message);
    this.name = 'UnshareError';
    this.kind = kind;
  }
}

/** The outcome of one `run()`. Every value but `DONE` names what did not happen. */
export const UNSHARE = Object.freeze({
  /** The retraction is on the relay and folded on this Mac. */
  DONE: 'done',
  /** Sealed and published, but this Mac has not folded it back yet. Retryable, and harmless. */
  PARTIAL: 'partial',
  /**
   * There is nothing published for this entity — it is already Privat, or it was never shared.
   * NOT an error: 18.3's "I still can't read what was never shared" is exactly this answer, and
   * a re-run of a moderation that already happened must be idempotent.
   */
  NOTHING_SHARED: 'nothingShared',
  /** This Mac is in no Familienkreis, or the key does not belong to its circle. */
  NOT_MINE: 'notMine',
  /** The relay could not be reached. Nothing was published; retryable. */
  UNREACHABLE: 'unreachable',
  /** A precondition this Mac cannot satisfy. `blockers` says which, in one word. */
  BLOCKED: 'blocked',
});

/** Why a run did not land. One value per cause, so a diagnostics pane can render it. */
export const UNSHARE_BLOCKERS = Object.freeze({
  /** No family engine on this Mac — nothing holds the ring or the transport. */
  NO_ENGINE: 'noEngine',
  /** The ring holds no key for this space, so nothing can be sealed. Never published in clear. */
  NO_KEY: 'noKey',
  /** `store.familyAdmin().admin === null` — no admin chain in the log. Owner: `createjoin.js`. */
  NO_ADMIN_CHAIN: 'noAdminChain',
  /** The chain names somebody else. ADR 001 §4.3 stage 3a: only the sitting admin's unshare. */
  NOT_THE_ADMIN: 'notTheAdmin',
  /** The argument is not an `fnote:`/`fbar:` key. There is nothing else this can address. */
  NOT_A_FAMILY_ENTITY: 'notAFamilyEntity',
  /** Sealed and refused by the relay. Retryable. */
  PUBLISH_FAILED: 'publishFailed',
});

/**
 * ADR 002 §7.4's copy contract for the moment after a moderation. German first, English second
 * (13.7). Every sentence is about what OTHERS will see, never about what the app did.
 *
 * `honesty` is `sharing.js:TXT.downgradeNote` **BY IDENTITY**, not by re-typing. That is §7.4's
 * required "first visibility downgrade" string, and an unshare is a visibility downgrade somebody
 * else performed — the same fact, the same one pull cycle (ADR 004 §5.3), the same honesty about
 * what was already seen (§11.2, retraction is client-cooperative). A second copy of it in this
 * file would be a second copy for somebody to soften; `tests/tier1/unshare.test.js` asserts the
 * object identity, so a paste reddens a row rather than passing review.
 */
export const UNSHARE_COPY = Object.freeze({
  /** The deed, in the past tense, naming only what changed: the entry is out of the family space. */
  done: Object.freeze({
    de: 'Der Eintrag ist nicht mehr im Familienkreis. Er gehört weiter der Person, die ihn '
      + 'angelegt hat, und steht unverändert auf ihrem Board.',
    en: 'The entry is no longer in the family circle. It still belongs to the person who created '
      + 'it, and stands unchanged on their board.',
  }),
  /** §7.4's required downgrade sentence, by identity. Never omitted, in either language. */
  honesty: SHARING_TXT.downgradeNote,
  /**
   * Nothing to do, said without implying a failure and without implying an insight. It must NOT
   * say "there is no such entry" — that would answer a question about somebody's private board.
   */
  nothingShared: Object.freeze({
    de: 'Zu diesem Eintrag steht nichts im Familienkreis. Es gibt hier nichts zu entfernen.',
    en: 'Nothing about this entry is in the family circle. There is nothing here to take out.',
  }),
  /** Published, not yet folded here. The other boards are already on their way. */
  partial: Object.freeze({
    de: 'Der Eintrag ist aus dem Familienkreis genommen. Auf diesem Mac steht er noch — das holt '
      + 'der nächste Abgleich nach.',
    en: 'The entry has been taken out of the family circle. It is still on this Mac; the next '
      + 'sync catches that up.',
  }),
  noAdminChain: Object.freeze({
    de: 'Dieser Kreis hat im Verlauf noch keinen eingetragenen Verwalter, deshalb übernehmen die '
      + 'anderen Macs die Änderung nicht. Es wurde nichts gesendet.',
    en: 'This circle has no admin recorded in its history yet, so the other Macs would not take '
      + 'the change over. Nothing was sent.',
  }),
  notTheAdmin: Object.freeze({
    de: 'Der Verlauf dieses Kreises nennt jemand anderen als Verwalter. Diese Änderung muss von '
      + 'dort kommen.',
    en: "This circle's history names somebody else as admin. This change has to come from there.",
  }),
  noKey: Object.freeze({
    de: 'Dieser Mac hat den Schlüssel des Kreises noch nicht. Sobald er da ist, geht es.',
    en: "This Mac does not hold the circle's key yet. Once it arrives, this works.",
  }),
  unreachable: Object.freeze({
    de: 'Der Server ist gerade nicht erreichbar. Beim nächsten Abgleich noch einmal versuchen.',
    en: 'The server cannot be reached right now. Try again at the next sync.',
  }),
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE PURE HALF — is there anything published for this entity, and may I act?
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** One folded register value, or `undefined`. Reads only; never throws on a shape. */
function folded(regs, entityKey, name) {
  if (!regs || typeof regs.get !== 'function') return undefined;
  let cells;
  try { cells = regs.get(entityKey); } catch { return undefined; }
  if (!cells || typeof cells.get !== 'function') return undefined;
  const cell = cells.get(name);
  return cell === undefined || cell === null ? undefined : cell.value;
}

/**
 * WHAT THE FAMILY CURRENTLY HOLDS FOR ONE ENTITY, and therefore whether there is anything to
 * unshare — read off the folded register map and from nothing else.
 *
 * ⚠ THE ANSWER IS `pub.level`, THE PUBLISHED LEVEL, AND HERE THAT IS THE RIGHT REGISTER. It is
 * the wrong one at the seal seam (finding S5: it is the level a transition is moving away FROM),
 * and it is the right one for exactly this question, which is not "what may be sealed" but "what
 * do the others currently see". An admin has no `visibility` truth register for somebody else's
 * entry and must never be given a way to want one.
 *
 * `'privat'` and absent are the SAME answer to a caller — "nothing is published" — and they are
 * deliberately not distinguished in the return value. Telling them apart would let the admin's UI
 * say "this was shared once", which is a level history, which is Principle 9's own prohibition
 * (ADR 004 §7.1: a Belegt block downgraded from Geteilt renders identically to one that was
 * always Belegt).
 *
 * @param {Map} regs a RegisterMap — `store.registers()`
 * @param {string} entityKey an `fnote:`/`fbar:` key
 * @returns {{shared:boolean, level:'belegt'|'geteilt'|null, kind:string|null, owner:string|null, uuid:string|null}}
 */
export function publishedState(regs, entityKey) {
  const blank = { shared: false, level: null, kind: null, owner: null, uuid: null };
  const parsed = parseEntityKey(entityKey);
  if (!parsed || (parsed.kind !== 'fnote' && parsed.kind !== 'fbar')) return blank;
  const level = folded(regs, entityKey, 'pub.level');
  const shared = level === 'belegt' || level === 'geteilt';
  return {
    shared,
    level: shared ? level : null,
    kind: parsed.kind,
    owner: parsed.owner,
    uuid: parsed.id,
  };
}

/**
 * THE WHOLE DECISION, AS A PURE FUNCTION. No transport, no crypto, no clock — so a test can walk
 * every reachable verdict without a relay, and so the driver below has no second opinion.
 *
 * @param {Object} input
 * @param {Map} input.regs               `store.registers()` — the AUTHORIZED fold
 * @param {string} input.entityKey       the entity to unshare
 * @param {string|null} input.spaceId    this Mac's family space, or `null` for solo
 * @param {{admin:string|null, isMe:boolean}} input.seat  `store.familyAdmin()`
 * @param {boolean} [input.hasKey=true]  does the ring hold a key for the space
 * @returns {Readonly<{verdict:string, blockers:string[], target:Object|null}>}
 */
export function planUnshare(input) {
  const i = input && typeof input === 'object' ? input : {};
  const blockers = [];
  const done = (verdict, target = null) =>
    Object.freeze({ verdict, blockers: Object.freeze(blockers.slice()), target });

  if (i.spaceId === null || i.spaceId === undefined) return done(UNSHARE.NOT_MINE);

  const state = publishedState(i.regs, i.entityKey);
  if (state.kind === null) {
    blockers.push(UNSHARE_BLOCKERS.NOT_A_FAMILY_ENTITY);
    return done(UNSHARE.BLOCKED);
  }

  // ORDER MATTERS, AND THIS IS THE ORDER: "is anything published?" is asked BEFORE "am I the
  // admin?". An entry nobody shared is nothing to moderate whoever is asking, and answering
  // `notTheAdmin` first would make the refusal itself report that something IS published there —
  // a one-bit read of somebody's private board, granted by an error message (Principle 9).
  if (!state.shared) return done(UNSHARE.NOTHING_SHARED, state);

  const seat = i.seat && typeof i.seat === 'object' ? i.seat : { admin: null, isMe: false };
  if (seat.admin === null || seat.admin === undefined) blockers.push(UNSHARE_BLOCKERS.NO_ADMIN_CHAIN);
  else if (seat.isMe !== true) blockers.push(UNSHARE_BLOCKERS.NOT_THE_ADMIN);
  if (i.hasKey === false) blockers.push(UNSHARE_BLOCKERS.NO_KEY);

  return done(blockers.length ? UNSHARE.BLOCKED : UNSHARE.DONE, state);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE DRIVER
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
 * @typedef {Object} UnshareDeps
 * @property {Object} [engine]  what `family/mount.js#circleEngine()` returns; defaults to it
 * @property {Object} [store]   the live store; defaults to it
 * @property {(space:string) => string} [witnessOf]  `Envelope.wit` — the engine's chain head
 * @property {(m:string) => void} [warn]
 * @property {'de'|'en'} [lang]
 */

/**
 * Build an unshare driver. Everything it needs is already assembled by `startFamilyEngine`; a
 * second transport or a second ring would be a second answer to "which circle is this".
 * @param {UnshareDeps} [deps]
 */
export function createUnshare(deps = {}) {
  const engine = deps.engine !== undefined ? deps.engine : circleEngine();
  const store = deps.store || liveStore;
  const lang = deps.lang === 'en' ? 'en' : 'de';
  const warn = typeof deps.warn === 'function' ? deps.warn : (m) => console.warn(m);
  // `''` is the honest "no commitment" for an engine built before `sync.witness` existed —
  // never a wrong one. Same fallback, same reasoning, as `removal.js`.
  const witnessOf = typeof deps.witnessOf === 'function'
    ? deps.witnessOf
    : (space) => {
      try {
        return engine && engine.sync && typeof engine.sync.witness === 'function'
          ? engine.sync.witness(space) : '';
      } catch { return ''; }
    };

  const stats = { runs: 0, published: 0, lastVerdict: null, lastBlockers: [] };

  /**
   * BARRIER 4's SECOND AUTHENTICATED SOURCE, resolved here and nowhere else.
   *
   * `crypto/envelope.js`'s retraction clause consults it only when `ctx.levelOf` has no answer
   * AND the patch is a pure withdrawal, and it answers an IDENTITY, never a level. It is wired to
   * the folded `space:<id>` → `admin` register — the admin chain that `core/authz.js` resolved and
   * `foldAuthorized` admitted — because that is the same fold that authenticates `levelOf`'s truth
   * register on the main path. Wiring it to a UI flag, to `deps`, or to the relay's opinion is the
   * mis-wiring the port exists to make impossible, and it would be S5 rebuilt one register over.
   */
  function adminOf(spaceId) {
    if (typeof store.familyAdmin !== 'function') {
      throw new UnshareError(
        'unshare: this store has no `familyAdmin()`. ADR 004 §2.2 barrier 4\'s retraction clause '
        + 'requires the seat to be read from the folded admin chain (ADR 001 §4.1), and '
        + '`src/js/store.js` owns that reader. Nothing is sealed from a guess.', 'config');
    }
    const seat = store.familyAdmin();
    if (!seat || seat.spaceId !== spaceId) return null;      // a different circle has no seat here
    return seat.admin;
  }

  /**
   * Seal one retraction and hand it to the relay. The two ADR 004 §2.2 ports the engine injects
   * are injected here too, from the SAME two shipped functions, plus the retraction clause's.
   */
  async function publishUnshare(op, spaceId) {
    const ring = engine && engine.keyring;
    const epoch = typeof ring?.currentEpoch === 'function' ? ring.currentEpoch(spaceId) : 0;
    if (!epoch) {
      throw new UnshareError(
        `unshare: the key ring holds no key for ${spaceId}. Nothing is published unencrypted, `
        + 'ever (ADR 002 §5.2).', 'key');
    }
    const env = await sealOp(op, ring, engine.armed.identity.devSig.privateKey, {
      v: 1,
      sp: spaceId,
      ep: epoch,
      dv: engine.armed.forStore.deviceShort,
      oid: op.id,
      wit: witnessOf(spaceId),
    }, {
      assertFamilyPatch,
      levelOf: (e) => (typeof store.familyLevelOf === 'function' ? store.familyLevelOf(e) : null),
      adminOf,
      ...(engine.armed.myAttestation ? { attestation: engine.armed.myAttestation } : {}),
    });

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
    return {
      ok: !!mine, opId: op.id, status: 200,
      error: mine ? null : 'not_acked', seq: mine ? String(mine.seq) : null,
    };
  }

  const report = (verdict, extra) => Object.freeze({ verdict, ...extra });

  return {
    stats,
    /** Exposed so a diagnostics pane and a test read the SAME seat this driver seals from. */
    adminOf,
    planFor(entityKey) {
      const spaceId = typeof store.familySpaceId === 'function' ? store.familySpaceId() : null;
      // A ring with no epoch for THIS space is `NO_KEY`, never a throw and never a silent seal:
      // nothing is published unencrypted, ever (ADR 002 §5.2). Solo mode never asks.
      let hasKey = true;
      if (spaceId !== null) {
        hasKey = !!(engine && engine.keyring && typeof engine.keyring.currentEpoch === 'function'
          && engine.keyring.currentEpoch(spaceId));
      }
      return planUnshare({
        regs: typeof store.registers === 'function' ? store.registers() : null,
        entityKey,
        spaceId,
        seat: typeof store.familyAdmin === 'function' ? store.familyAdmin() : null,
        hasKey,
      });
    },

    /**
     * Unshare ONE entry. Takes an entity key and nothing else — see property 3 in the header.
     *
     *     plan ──▶ author ──▶ seal+publish ──▶ syncNow
     *
     * @param {string} entityKey `fnote:<memberId>/<uuid>` or `fbar:…`
     * @returns {Promise<Readonly<Object>>}
     */
    async run(entityKey) {
      stats.runs += 1;
      if (!engine) {
        stats.lastVerdict = UNSHARE.BLOCKED;
        stats.lastBlockers = [UNSHARE_BLOCKERS.NO_ENGINE];
        return report(UNSHARE.BLOCKED, {
          entityKey, blockers: [UNSHARE_BLOCKERS.NO_ENGINE], published: null,
          say: [pick(UNSHARE_COPY.unreachable, lang)],
        });
      }
      const spaceId = typeof store.familySpaceId === 'function' ? store.familySpaceId() : null;
      const plan = this.planFor(entityKey);
      stats.lastVerdict = plan.verdict;
      stats.lastBlockers = plan.blockers.slice();

      if (plan.verdict === UNSHARE.NOT_MINE) {
        return report(UNSHARE.NOT_MINE, {
          entityKey, blockers: [], published: null, say: [pick(UNSHARE_COPY.unreachable, lang)],
        });
      }
      if (plan.verdict === UNSHARE.NOTHING_SHARED) {
        // 18.3's last clause, as a code path: there is nothing here, and the answer says nothing
        // about whether an entry exists on somebody's board.
        return report(UNSHARE.NOTHING_SHARED, {
          entityKey, blockers: [], published: null, say: [pick(UNSHARE_COPY.nothingShared, lang)],
        });
      }
      if (plan.verdict === UNSHARE.BLOCKED) {
        const say = [];
        for (const b of plan.blockers) {
          if (b === UNSHARE_BLOCKERS.NO_ADMIN_CHAIN) say.push(pick(UNSHARE_COPY.noAdminChain, lang));
          else if (b === UNSHARE_BLOCKERS.NOT_THE_ADMIN) say.push(pick(UNSHARE_COPY.notTheAdmin, lang));
          else if (b === UNSHARE_BLOCKERS.NO_KEY) say.push(pick(UNSHARE_COPY.noKey, lang));
        }
        if (plan.blockers.includes(UNSHARE_BLOCKERS.NO_ADMIN_CHAIN)) {
          warn('[unshare] this circle has no admin chain in its log, so a `pub.set` retraction on '
            + 'another member\'s entity would be rejected by every peer (core/authz.js stage 3a). '
            + 'The genesis link is `core/ops.js`\'s `claimAdmin` and `family/createjoin.js` must '
            + 'emit it at circle creation. Nothing was published, and nothing here mints a root.');
        }
        return report(UNSHARE.BLOCKED, {
          entityKey, blockers: plan.blockers.slice(), published: null,
          say: say.length ? say : [pick(UNSHARE_COPY.unreachable, lang)],
        });
      }

      // ── AUTHOR ──────────────────────────────────────────────────────────────────────────────
      // The bytes come from `core/project.js` and from nowhere else. This file assembles no patch.
      const op = adminUnshareOp(store._ctx(), {
        kind: plan.target.kind, owner: plan.target.owner, uuid: plan.target.uuid,
      });

      // THE SHAPE GATE, RESTATED WHERE IT IS CHEAP. `core/authz.js` stage 3a admits an admin's
      // write to another member's entity only if `classifyUnsharePatch` reads it as an unshare;
      // 'skew' is PARKED and 'no' is REJECTED, both silently, on every peer. Asserting it on the
      // author's Mac turns "the admin pressed it and nothing ever happened" into a throw here.
      const verdict = classifyUnsharePatch(plan.target.kind, op.f);
      if (verdict !== 'unshare') {
        throw new UnshareError(
          `unshare: the retraction this build produced classifies as ${JSON.stringify(verdict)}, not `
          + '"unshare". Every peer would park or reject it in silence (ADR 001 §4.3 stage 3a). '
          + `Patch: ${JSON.stringify(op.f)}`, 'shape');
      }
      if (op.e !== entityKey) {
        throw new UnshareError(
          `unshare: the op addresses ${op.e}, not ${entityKey}`, 'shape');
      }

      let published;
      try {
        published = await publishUnshare(op, spaceId);
      } catch (e) {
        stats.lastVerdict = UNSHARE.UNREACHABLE;
        return report(UNSHARE.UNREACHABLE, {
          entityKey, blockers: [], published: null,
          say: [pick(UNSHARE_COPY.unreachable, lang)],
          detail: e && e.message ? String(e.message) : null,
        });
      }
      if (!published.ok) {
        stats.lastVerdict = UNSHARE.BLOCKED;
        stats.lastBlockers = [UNSHARE_BLOCKERS.PUBLISH_FAILED];
        warn(`[unshare] the retraction could not be published (${published.error}). Nothing on any `
          + 'board has changed; this is retryable.');
        return report(UNSHARE.BLOCKED, {
          entityKey, blockers: [UNSHARE_BLOCKERS.PUBLISH_FAILED], published,
          say: [pick(UNSHARE_COPY.unreachable, lang)],
        });
      }
      stats.published += 1;

      // ── SETTLE ──────────────────────────────────────────────────────────────────────────────
      // The admin's own Mac folds it back through the SAME path every peer uses. See the header:
      // there is no local-append shortcut, deliberately.
      let landed = false;
      try {
        if (engine.sync && typeof engine.sync.syncNow === 'function') await engine.sync.syncNow();
        landed = !publishedState(store.registers(), entityKey).shared;
      } catch (e) {
        warn(`[unshare] the settling sync did not complete (${e && e.message}); the retraction is `
          + 'on the relay and lands on this Mac at the next ordinary sync.');
      }

      const ok = landed;
      stats.lastVerdict = ok ? UNSHARE.DONE : UNSHARE.PARTIAL;
      return report(ok ? UNSHARE.DONE : UNSHARE.PARTIAL, {
        entityKey,
        blockers: [],
        published,
        // ADR 002 §7.4's downgrade sentence is the LAST line of every landed outcome. A moderation
        // that reports only its success is one that lets a person believe more than happened.
        say: [pick(ok ? UNSHARE_COPY.done : UNSHARE_COPY.partial, lang), pick(UNSHARE_COPY.honesty, lang)],
      });
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// REPORTED — owed by other work packages, so it is written down rather than half-built here
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// 1. **THE OWNER'S FOLLOW-UP HAS NO CALLER** and 18.3's "it reverts" is only true until the owner
//    next touches the entry without it. `core/project.js:adminUnshareFollowUp(regs, ctx)` is
//    built, pure and tested (`tests/tier1/unshare.test.js` §5); what is missing is one call from
//    the RECEIVING side — `store.applyRemote`, after `foldAuthorized`, committing its ops as an
//    ordinary transaction. Owner: `src/js/store.js` (WP-10 / whoever owns the inbox).
//    Measured symptom without it: the owner's `visibility` truth register still says `geteilt`
//    while the family holds `privat`, so `derivePublication` re-publishes the whole Geteilt patch
//    on the owner's very NEXT keystroke and the moderation is silently undone.
//
// 2. **NO UI CALLS THIS.** `family/adminpanel.js` is the moderation console (its header already
//    says a "Entfernen" button beside each member is all it shows) and `family/mount.js` is what
//    installs family surfaces into the solo graph — neither is this work package's file. The seam
//    is `createUnshare().run(entityKey)`, and the entity key is exactly what a foreign entry's
//    popover already knows. There is deliberately no browse-other-people's-entries affordance to
//    build: an admin can only name what the family already holds.
//
// 3. **`family/createjoin.js` must emit the genesis admin link at circle creation** — the same
//    dependency `removal.js` reports, and the reason `UNSHARE_BLOCKERS.NO_ADMIN_CHAIN` exists.
