// src/js/core/authz.js — the staged authorization fold.
// ADR 001 §4 (§4.0 attestation · §4.1 admin chain · §4.2 membership · §4.3 content · §4.4
// ownership) · ADR 002 §2.3, §5.1 · ADR 004 §5, §8 · ops.contract.js §4.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PROPERTY THIS FILE EXISTS TO PRESERVE
//
// Admissibility is a function of the SET of ops, never of the enumeration. If it were not,
// convergence would die: whether Mama may write `pub.text` depends on `pub.coEdit`, which is
// itself a register that may change, so a single streaming fold would admit her op on the device
// that happened to see the co-edit grant first and reject it on the device that saw the
// revocation first. Two devices, same ops, different boards. That is the failure the staged fold
// exists to make impossible, and ADR 001 §6.4 is the proof:
//
//   Every stage is a fold over the same immutable set, and reads only the FINAL values of
//   earlier stages. Never its own. Never a later one.
//
// The stages, in order, and what each may read:
//
//   0a  attestation registers   `member:<M>` → `dev.<short>`. SELF-AUTHORIZING: admissible from
//                               `op.act === M` alone, because requiring an attested device to
//                               author an attestation is an infinite regress. Signature check is
//                               injected (`ctx.attestVerify`).
//   0b  device gate             every other op: `op.dev` must be an attested device of `op.act`
//                               (family), or a device of mine (personal/local, §4.0's "checked
//                               against the local device set").
//   1   admin chain             `space.set{admin, adminPrev}` links only. Reads stage 0.
//   2   membership              `member.set{displayName,colorRef,_alive,_born}`. Reads 0 and 1.
//   3a  governing pub fields    `pub.level`, `pub.coEdit`, `pub.alive`, `_born`. Reads 0 and 1.
//   3b  content pub fields      Reads 0, 1, 2 and the FINAL 3a registers.
//
// A stage-3b op's admissibility therefore depends on the *final* `pub.coEdit` / `pub.level`,
// which means revoking co-edit retroactively withdraws every co-editor write to that entity.
// That is not an accident of this implementation — it is what "reading only the final values"
// means, and it is the only reading that converges. It is called out again at stage 3b.
//
// ─────────────────────────────────────────────────────────────────────────────
// OWNERSHIP IS STRUCTURAL (ADR 001 §4.4, §12.3 — risk R10)
//
// There is no `owner` register and no code path in this file that resolves one. The owner of a
// family entity is the `<memberId>` segment of its key, read by `ownerOfEntity()`, and that key
// is what the ciphertext is bound to (ADR 002 §5.2). Every reviewed v2 proposal resolved
// ownership as "the author of the write with the smallest stamp"; stamps have no lower bound, so
// one line of modified client emitting an owner write at `ms = 0` would have taken over any
// entity in the family. Here there is nothing to backdate: no sequence of ops, at any stamp,
// changes `ownerOfEntity(e)`, because no op can rewrite `e`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE `writeOnce` IS ENFORCED, AND WHY IT IS HERE
//
// The LWW join is `registers.js` and this module does not own a second copy of it: one join,
// one `≺`, one tiebreak. `registers.js` implements plain max-by-`≺` for every field, including
// the two the FIELDS table marks `writeOnce`.
//
// For `dev.*` that is not good enough, and ADR 001 §4.0 already says where the rule lives:
// "`dev.*` registers are **write-once** and admissible only from `op.act === memberId`" — an
// ADMISSIBILITY property, i.e. this file's job. So stage 0a admits, for each `dev.<short>`
// register, only the minimal write under (stamp, opId), and rejects every later claim outright.
// A device attestation that could be REPLACED at a greater stamp is precisely the key-injection
// hole ADR 002 §2.3 exists to close: swap the blob, and the family key gets wrapped to your
// hardware on the next rotation.
//
// `_born` is NOT enforced here. It rides along inside ops that also carry content
// (`bar.set{_born, startDate, endDate, …}`), so rejecting the whole op for a second `_born`
// would drop a legitimate write, and stripping the field would make ops non-atomic. The
// practical exposure is nil — `createdAt` is `min` over ALL of an entity's register stamps
// (ADR 001 §1.4, `registers.js:createdAt`), so it does not move even if the `_born` register
// does, and only the entity's own owner can write it at all. Reported as a gap in
// `registers.js` rather than papered over here.

import { cmp } from './stamp.js';
import { canonicalJSON, utf8Decode } from './canon.js';
import { ub64 } from './b64.js';
import { isDeviceShort } from './ids.js';
import {
  parseEntityKey, ownerOfEntity, spaceKey, isMemberId, isDeviceId, isOpId,
} from './entities.js';
import { fieldSpec, fieldsOf, classifyOp, spaceClassOf, isPubField, PARK_REASONS } from './ops.js';
// THE join. ADR 005 §1.1 puts `applyOp` / `emptyRegisters` in `registers.js`; there is exactly
// one implementation of `≺` in the product and this file uses it rather than carrying a rival.
import { emptyRegisters, applyOp, cmpWrites, getRegister, getValue } from './registers.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Errors, reason codes, stage names
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown for a caller mistake — never for peer data, which is classified, not thrown on. */
export class AuthzError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthzError';
  }
}

/** The four stages of ADR 001 §4, in evaluation order. */
export const STAGES = Object.freeze(['attestation', 'adminChain', 'membership', 'content']);

/**
 * Why an op was NOT admitted. A rejection is final for this op set; a PARK (see `ops.js`
 * `PARK_REASONS`) is not — a parked op is retained and re-evaluated later.
 *
 * Envelope splicing (ADR 002 §5.1 — two DIFFERENT bodies under one opId) is deliberately NOT a
 * reason code: one of the two bodies IS admitted, content-addressably, so the id is reported on
 * `AuthzResult.splicedIds` instead of being counted as a rejection.
 */
export const REJECT_REASONS = Object.freeze({
  /** `validateOp` refused the shape: a protocol violation, not version skew. */
  SHAPE: 'shape',
  /** A `space.set` addressing a space entity other than its own `op.space`. */
  SPACE_MISMATCH: 'spaceMismatch',
  /** A personal- or local-space op authored by somebody who is not me. */
  NOT_MY_ACT: 'notMyAct',
  /** A personal- or local-space op from a device outside my local device set. */
  NOT_MY_DEVICE: 'notMyDevice',
  /** `op.dev` is not an attested device of `op.act` (stage 0b). */
  UNATTESTED_DEVICE: 'unattestedDevice',
  /** A `dev.*` register whose blob does not parse, does not verify, or names another member. */
  BAD_ATTESTATION: 'badAttestation',
  /** A `member.set` mixing `dev.*` registers with ordinary member fields. */
  MIXED_MEMBER_PATCH: 'mixedMemberPatch',
  /** A second claim on a write-once `dev.<short>` register (ADR 001 §4.0, ADR 002 §2.3). */
  WRITE_ONCE: 'writeOnce',
  /** A `member.set` on somebody else's record (§4.2: self-edit, no admin involvement). */
  NOT_SELF: 'notSelf',
  /** Not the admin at `op.ts` — for `space.set{name,epoch}` and for member removal. */
  NOT_ADMIN: 'notAdmin',
  /** A `space.set` carrying `admin` that is not a valid link of the accepted chain (§4.1). */
  BAD_ADMIN_LINK: 'badAdminLink',
  /** A structurally valid link that lost the longest-chain resolution to a rival. */
  LOST_ADMIN_CHAIN: 'lostAdminChain',
  /** A governing `pub.*` write by somebody who is neither the owner nor an unsharing admin. */
  NOT_OWNER: 'notOwner',
  /**
   * An admin write to another member's entity that is not a §4.3 unshare AT ALL — it does not set
   * `pub.level` to `'privat'`. A patch that MEANS to unshare but carries something this build
   * cannot read as a withdrawal is PARKED (`PARK_REASONS.UNSHARE_SHAPE`), never rejected: a rejection is
   * final, and a wrongly-final rejection of an unshare leaves previously-hidden content visible.
   */
  NOT_AN_UNSHARE: 'notAnUnshare',
  /** `pub.coEdit` is not true on that entity's FINAL registers. */
  NO_COEDIT: 'noCoEdit',
  /** `pub.level` is not 'geteilt' on that entity's FINAL registers. Co-editing needs Geteilt. */
  NOT_GETEILT: 'notGeteilt',
  /** The author is not in `currentMembers`. */
  NOT_MEMBER: 'notMember',
  /** A co-editor wrote a field whose `FIELDS[kind][f].coEdit` is not true. */
  NOT_COEDITABLE: 'notCoEditable',
});

const REJECT_CODES = new Set(Object.values(REJECT_REASONS));
/** @param {string} r @returns {boolean} */
export const isRejectReason = (r) => REJECT_CODES.has(r);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Device attestations (ADR 001 §4.0 · ADR 002 §2.3)
//
// THE `deviceShort(op.dev)` CONTRADICTION, AND HOW IT IS RESOLVED HERE.
//
// ADR 001 §1.2 defines `deviceShort` as `crock32(SHA-256(rawSigPublicKey)[0..10])` — a function
// of the SIGNING KEY. ADR 001 §4.0 and ADR 002 §5.2 then write `deviceShort(op.dev)`, applying
// it to a `dev_` + 128-random-bits identifier that has no derivational relationship to that key.
// Both readings cannot hold. §1.2 is the numbered definition and the one the 80-bit-collision
// and server-key-binding arguments depend on, so it stands, and the `op.dev → deviceShort` step
// is what it can only be: A LOOKUP over the member's own `dev.*` attestation registers.
//
// Doing the lookup means reading the register value, which ADR 002 §2.3 fixes as
//     b64u(canonicalJSON(attestation)) + '.' + b64u(signature)
// with `attestation.deviceId`, `.deviceShort` and `.memberId` inside. Decoding it is pure and
// belongs here; VERIFYING the signature needs the member's recovery public key and is injected
// as `ctx.attestVerify`, exactly as ops.contract.js §4 types it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decode the payload half of a `dev.*` register value. Never throws — a malformed blob from a
 * peer is data, not a bug in this process.
 * @param {unknown} blob
 * @returns {{memberId:string, deviceId:string, deviceShort:string}|null}
 */
export function parseAttestationBlob(blob) {
  if (typeof blob !== 'string') return null;
  const dot = blob.indexOf('.');
  // Both halves must be present. base64url never contains '.', so the split is unambiguous.
  if (dot <= 0 || dot >= blob.length - 1) return null;
  let att;
  try {
    att = JSON.parse(utf8Decode(ub64(blob.slice(0, dot))));
  } catch {
    return null;
  }
  if (att === null || typeof att !== 'object' || Array.isArray(att)) return null;
  if (!isMemberId(att.memberId) || !isDeviceId(att.deviceId) || !isDeviceShort(att.deviceShort)) return null;
  return { memberId: att.memberId, deviceId: att.deviceId, deviceShort: att.deviceShort };
}

/** `dev.<deviceShort16>` — the register-name shape `ops.js` already validates. */
const DEV_PREFIX = 'dev.';
const shortOfRegisterName = (name) => name.slice(DEV_PREFIX.length);
const isDevRegisterName = (name) => typeof name === 'string' && name.startsWith(DEV_PREFIX);

// ─────────────────────────────────────────────────────────────────────────────
// 3. The admin chain (ADR 001 §4.1)
//
// Resolved ENTIRELY from the op set — never from a server column. That is the point: a
// compromised relay that could rewrite a `roleHistory` table could flip the validity of an admin
// unshare and make previously-hidden content reappear on every family board.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify a `space.set` op as a chain link, or not a link at all.
 *
 * A link must declare BOTH `admin` and `adminPrev`. An op carrying `admin` with no `adminPrev`
 * is not a genesis with an implied null — it is a claim with no stated predecessor, and
 * accepting it would let any member mint a rootless admin assertion. `adminPrev: null` is the
 * genesis marker and it must be written explicitly, which is the same "omission is not
 * withdrawal" discipline ADR 004 §5.1 imposes on retraction patches.
 * @param {Object} op @returns {{op:Object, admin:string, prev:string|null}|null}
 */
function linkOf(op) {
  if (op.k !== 'space.set') return null;
  const f = op.f;
  if (!Object.prototype.hasOwnProperty.call(f, 'admin')) return null;
  if (!Object.prototype.hasOwnProperty.call(f, 'adminPrev')) return null;
  if (!isMemberId(f.admin)) return null;
  if (f.adminPrev !== null && !isOpId(f.adminPrev)) return null;
  return { op, admin: f.admin, prev: f.adminPrev };
}

/**
 * Longest-chain comparison over two candidate suffixes that diverge at the same point.
 * Longer wins (ADR 001 §4.1); a tie is broken by the greater `ts` of the disputed link; the
 * opId is the final tiebreak, so the order is TOTAL and no pair of rivals is left unresolved.
 */
function betterChain(a, b) {
  if (!b) return true;
  if (a.length !== b.length) return a.length > b.length;
  const c = cmp(a[0].op.ts, b[0].op.ts);
  if (c !== 0) return c > 0;
  return a[0].op.id > b[0].op.id;
}

/** Deterministic child order, so the walk does not depend on arrival order. */
const linkOrder = (x, y) => cmp(x.op.ts, y.op.ts) || (x.op.id < y.op.id ? -1 : x.op.id > y.op.id ? 1 : 0);

/**
 * Resolve one space's admin chain.
 * @param {Array<{op:Object, admin:string, prev:string|null}>} links every link op for ONE space
 * @param {string|null} genesisPin optional out-of-log pin, see `ctx.genesisOpId`
 * @returns {{links:Array, accepted:Object[], admin:string|null}}
 */
function resolveChain(links, genesisPin) {
  const byId = new Map();
  const children = new Map();
  for (const l of links) {
    byId.set(l.op.id, l);
    if (l.prev !== null) {
      if (!children.has(l.prev)) children.set(l.prev, []);
      children.get(l.prev).push(l);
    }
  }
  for (const arr of children.values()) arr.sort(linkOrder);

  // Genesis: `adminPrev: null` AND `op.act === op.f.admin` (§4.1). Nothing else is a root; a
  // link whose `adminPrev` names an op we have never seen is NOT a root, it is an orphan, and
  // it stays inadmissible until its parent arrives. That is what makes a partial sync safe.
  let roots = links.filter((l) => l.prev === null && l.op.act === l.admin).sort(linkOrder);
  if (typeof genesisPin === 'string') roots = roots.filter((l) => l.op.id === genesisPin);

  // `seen` guards a cycle: `adminPrev` is an opId and a malicious pair could point at each other.
  const seen = new Set();
  const bestFrom = (link) => {
    seen.add(link.op.id);
    let best = null;
    for (const kid of children.get(link.op.id) || []) {
      // A transfer is admissible only from the admin named by the link it supersedes.
      if (kid.op.act !== link.admin) continue;
      if (seen.has(kid.op.id)) continue;
      const c = bestFrom(kid);
      if (betterChain(c, best)) best = c;
    }
    seen.delete(link.op.id);
    return best ? [link, ...best] : [link];
  };

  let accepted = null;
  for (const r of roots) {
    const c = bestFrom(r);
    if (betterChain(c, accepted)) accepted = c;
  }

  return {
    links,
    accepted: accepted ? accepted.map((l) => l.op) : [],
    admin: accepted ? accepted[accepted.length - 1].admin : null,
  };
}

/**
 * `admin@stamp` — a deterministic point-in-time query over the accepted chain.
 *
 * The walk stops at the first link whose `ts` is greater than `at`, rather than scanning for the
 * last link that happens to fit. The chain's order is CAUSAL (each link names its predecessor)
 * and a transfer may legitimately carry a smaller `ts` than the link it supersedes — a laptop
 * with a slow clock, or a deliberate backdate. Honouring the causal order means a backdated
 * transfer cannot reach back over a link that had not yet happened.
 * @param {Object[]} acceptedOps @param {string} at @returns {string|null}
 */
function adminAtIn(acceptedOps, at) {
  let admin = null;
  for (const op of acceptedOps) {
    if (cmp(op.ts, at) > 0) break;
    admin = op.f.admin;
  }
  return admin;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The admin unshare patch (ADR 001 §4.3 stage 3a · ADR 004 §5)
//
// "the patch is exactly `{ 'pub.level': 'privat', ...all other pub fields → null }`".
// "the patch is exactly `{ 'pub.level': 'privat', ...all other pub fields → null }`". The ADR
// says EXACTLY, and reading that as "exactly THIS BUILD'S `FIELDS[kind]` table" is wrong — it
// makes the predicate a function of the reader's version instead of a function of the op.
//
// WHAT GOES WRONG WITH THE LITERAL READING. Add one `pub.*` field to `fnote` in v2.1 and the
// meaning of "an unshare" changes underneath a fleet that is mid-rollout. The unshare a v2.0
// admin authors carries one field fewer than v2.1 expects; a v2.1 client REJECTS it, and a
// rejection is FINAL. The entry the admin unshared therefore stays published on the newer
// client — previously-hidden content still visible, which is precisely the failure ADR 001 §4.1
// exists to prevent, arriving through a staggered app update instead of through a hostile relay.
// A privacy retraction must never depend on which build sees it first.
//
// WHAT IS CHECKED INSTEAD — a property of the patch, not a diff against a table:
//   * `pub.level` is present and is `'privat'` — this is the write that unshares, and nothing
//     without it is an unshare; and
//   * EVERY OTHER field the patch carries is `null`. That, not the field count, is what makes an
//     unshare incapable of being a general write primitive: an admin who appends a field to an
//     unshare can only ever append a WITHDRAWAL of it. Blanking a field the admin was already
//     allowed to blank grants no new power.
// Fields this build's table omits from `unsharePatch(kind)` are therefore fine to carry (a newer
// build's patch) and fine to omit (an older build's). ADR 004 §5.1's "omission is not withdrawal"
// still holds for the FIELDS THAT EXIST HERE — see `unsharePatch`, which every unshare this build
// AUTHORS still emits in full; what changed is only what this build ACCEPTS from a peer.
// `_born` is deliberately not withdrawn: it is write-once and the entry is not deleted (18.3).
//
// AND A NEAR-MISS IS PARKED, NOT REJECTED. `'no'` — no `pub.level: 'privat'` at all — is a plain
// admin write to another member's entity and stays a hard rejection. `'skew'` — an unshare that
// this build cannot confirm, e.g. a future version that withdraws a field with a sentinel rather
// than with `null` — is PARKED: retained, not applied, re-evaluated after an app update. Version
// skew then degrades to "not yet unshared, and the log still knows why", never to "silently not
// unshared, and the op is gone".
// ─────────────────────────────────────────────────────────────────────────────

const UNSHARE_CACHE = new Map();

/**
 * The patch an admin unshare this build AUTHORS carries: every `pub.*` field of the kind, the
 * level set to `'privat'` and the rest nulled. Still the full table, because omission is not
 * withdrawal for a field we know about. `isAdminUnsharePatch` does NOT require equality with it.
 * @param {'fnote'|'fbar'} kind @returns {Object}
 */
export function unsharePatch(kind) {
  if (UNSHARE_CACHE.has(kind)) return UNSHARE_CACHE.get(kind);
  const out = {};
  for (const f of fieldsOf(kind)) {
    if (!isPubField(f)) continue;             // `_born` is not withdrawn
    out[f] = f === 'pub.level' ? 'privat' : null;
  }
  Object.freeze(out);
  UNSHARE_CACHE.set(kind, out);
  return out;
}

/**
 * The tri-state stage-3a verdict on an admin's patch. Version-independent by construction: it
 * reads only the patch, never `FIELDS[kind]`.
 *
 *   'unshare' — admit. Sets the level to privat and withdraws everything else it carries.
 *   'skew'    — PARK. Clearly means to unshare (level → privat) but carries something this build
 *               cannot read as a withdrawal. Retained for re-evaluation, never applied.
 *   'no'      — REJECT. Not an unshare at all.
 *
 * @param {'fnote'|'fbar'} kind @param {Object} f @returns {'unshare'|'skew'|'no'}
 */
export function classifyUnsharePatch(kind, f) {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return 'no';
  if (!Object.prototype.hasOwnProperty.call(f, 'pub.level')) return 'no';
  if (f['pub.level'] !== 'privat') return 'no';
  for (const k of Object.keys(f)) {
    if (k === 'pub.level') continue;
    // Not a `pub.*` name (`_born`, a truth field, anything else) → not a withdrawal this build
    // can vouch for. Not null → the same. Either way: park, do not apply, do not drop.
    if (!isPubField(k) || f[k] !== null) return 'skew';
  }
  return 'unshare';
}

/**
 * True iff the patch is an admissible admin unshare (ADR 001 §4.3 stage 3a).
 * @param {'fnote'|'fbar'} kind @param {Object} f @returns {boolean}
 */
export function isAdminUnsharePatch(kind, f) {
  return classifyUnsharePatch(kind, f) === 'unshare';
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Thin register accessors — the join itself is `registers.js`
// ─────────────────────────────────────────────────────────────────────────────

const emptyRegs = () => emptyRegisters();

/**
 * Fold one op, optionally restricted to a subset of its fields. The restriction exists for
 * exactly one caller: stage 3a folds ONLY the governing registers, because stage 3b must read
 * their final values and must not see a co-editor's content writes while doing it.
 * @param {Map} regs @param {Object} op @param {(f:string)=>boolean} [only]
 */
function foldOp(regs, op, only) {
  if (!only) { applyOp(regs, op); return; }
  const f = {};
  let n = 0;
  for (const [k, v] of Object.entries(op.f)) if (only(k)) { f[k] = v; n++; }
  if (n === 0) return;
  applyOp(regs, { ...op, f });
}

/** @param {Map} regs @param {string} e @param {string} field @returns {Object|null} */
export function registerOf(regs, e, field) {
  return getRegister(regs, e, field) ?? null;
}

/**
 * The register's value, or `undefined` when the register does not exist.
 * `null` is a VALUE (cleared / redacted) and is returned as `null` — ADR 004 §5.1. The
 * projection skips null registers; admissibility must still see them.
 * @param {Map} regs @param {string} e @param {string} field @returns {any}
 */
export function registerValue(regs, e, field) {
  return getValue(regs, e, field);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. foldAuthorized — the only entry point that turns a set of ops into state
// ─────────────────────────────────────────────────────────────────────────────

/** Total order on ops, used to make every output array a function of the SET. */
const opOrder = (a, b) => cmp(a.ts, b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const idOf = (o) => (o && typeof o === 'object' && typeof o.id === 'string' ? o.id : '');
const byId = (a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0);

/**
 * @typedef {Object} AuthzResult
 * @property {Map} regs                     the folded register map — ADMITTED ops only
 * @property {string|null} admin            chain-resolved current admin of the family space
 * @property {(at:string) => string|null} adminAt
 * @property {Set<string>} currentMembers
 * @property {Object[]} admitted            sorted by (ts, id)
 * @property {Object[]} rejected            sorted by id — dropped: failed admissibility
 * @property {Object[]} parked              sorted by id — retained: future / unknown epoch / kind
 * @property {(opId:string) => {stage:string, reason:string}|null} rejectionOf
 * @property {(opId:string) => string|null} parkReasonOf
 * @property {(spaceId:string) => string|null} adminOfSpace
 * @property {(spaceId:string, at:string) => string|null} adminAtInSpace
 * @property {(spaceId:string) => Object[]} adminChainOf     the accepted chain, in causal order
 * @property {Map<string, Set<string>>} attestedDevices      memberId → attested deviceIds
 * @property {(deviceId:string) => string|null} memberOfDevice
 * @property {string[]} splicedIds          opIds that arrived carrying two different op bodies
 */

/**
 * @param {Iterable<Object>} ops
 * @param {{ me:string, nowMs?:number, attestVerify?:(m:string, blob:string)=>boolean,
 *           myDevices?:Set<string>|Iterable<string>, genesisOpId?:string|null,
 *           haveEpochKey?:boolean }} ctx
 * @returns {AuthzResult}
 */
export function foldAuthorized(ops, ctx) {
  if (!ctx || typeof ctx !== 'object') throw new AuthzError('foldAuthorized: a ctx is required');
  if (!isMemberId(ctx.me)) {
    throw new AuthzError(`foldAuthorized: ctx.me must be a MemberId, got ${JSON.stringify(ctx.me)}`);
  }
  if (ctx.nowMs !== undefined && !Number.isFinite(ctx.nowMs)) {
    throw new AuthzError('foldAuthorized: ctx.nowMs must be a finite number when given');
  }
  const me = ctx.me;
  // FAIL CLOSED. With no verifier, no attestation verifies, so no family op is admitted. A
  // default that returned true would make the anti-key-injection measure (ADR 002 §2.3) opt-in.
  const attestVerify = typeof ctx.attestVerify === 'function' ? ctx.attestVerify : () => false;
  // §4.0: "Personal-space ops are checked against the local device set." When the caller does
  // not know it (solo mode before any device record exists), the check degrades to `act === me`
  // — which is all §4.4 claims for the personal space anyway: its confidentiality rests on who
  // holds the PSK, not on this fold.
  const myDevices = ctx.myDevices ? new Set(ctx.myDevices) : null;
  const genesisPin = typeof ctx.genesisOpId === 'string' ? ctx.genesisOpId : null;

  const rejected = [];
  const parked = [];
  const rejectionOf = new Map();
  const parkReasonOf = new Map();
  const splicedIds = [];

  // Dedupe applies to the REPORTED ARRAYS as well as to the fold. ADR 001 §0.2 says state is a
  // function of the SET of ops, and `ops.contract.js` §4 says the result "is a function of the
  // SET, not of the enumeration" — but `rejected` and `parked` are part of the result, they are
  // read by the diagnostics panel and by the sync status (deliverable 20), and a re-pull whose
  // batch boundary differs would otherwise make two devices report "2 parked" and "1 parked" for
  // the same log. Found by property P5 under duplication during WP-1 integration.
  const seenRejected = new Set();
  const seenParked = new Set();

  const reject = (op, stage, reason) => {
    const id = op && typeof op === 'object' ? op.id : undefined;
    if (typeof id === 'string') {
      if (seenRejected.has(id)) return;
      seenRejected.add(id);
    }
    rejected.push(op);
    rejectionOf.set(id, { stage, reason });
  };

  /**
   * The other verdict. A park is NOT final: the op is retained, never folded, and re-evaluated
   * later. Pass A parks what `classifyOp` could not read; stage 3a parks an admin unshare this
   * build cannot confirm (see §4). Same dedupe discipline as `reject`, for the same reason.
   */
  const parkOp = (op, reason) => {
    const id = op && typeof op === 'object' ? op.id : undefined;
    if (typeof id === 'string') {
      if (seenParked.has(id)) return;          // see `seenRejected` above
      seenParked.add(id);
      parkReasonOf.set(id, reason);
    }
    parked.push(op);
  };

  // ── Pass A. Shape triage and idempotent dedupe ────────────────────────────
  //
  // Duplicate delivery is not an error condition here, it is Tuesday (ADR 001 §6). Dedupe by
  // opId keeps the fold idempotent even for the non-ACI parts (the chain walk). Two DIFFERENT
  // bodies under one opId is envelope splicing (ADR 002 §5.1) — resolved content-addressably so
  // every device picks the same one, and reported.
  //
  // THE SPLICE IS RESOLVED FOR PARKED BODIES TOO (attack A6). It used to be resolved only among
  // ops that classify as `admit`: a body that parked short-circuited straight into `parkOp`,
  // which dedupes by opId and therefore kept whichever body ARRIVED FIRST. A parked op is
  // retained precisely so it can be applied after an app update (§7.4), so two devices that
  // received the two envelopes in opposite orders would apply DIFFERENT ops once they updated —
  // and never reconcile. Verdict does not decide the contest; the canonical max does, exactly as
  // in `oplog.js:append`, so both devices retain the same body and then park it for the same
  // reason. A REJECTED body still never competes: a protocol violation may not win a splice, nor
  // disturb one, which is why classification runs first and only its two survivors enter here.
  const candidates = new Map();
  const spliced = new Set();
  const loose = [];                                // no usable opId — cannot be deduped by one
  for (const op of ops) {
    const verdict = classifyOp(op, { nowMs: ctx.nowMs, haveEpochKey: ctx.haveEpochKey });
    if (verdict.status === 'reject') {
      reject(op, STAGES[0], REJECT_REASONS.SHAPE);
      continue;
    }
    const id = op && typeof op === 'object' && typeof op.id === 'string' ? op.id : null;
    if (id === null) { loose.push({ op, verdict }); continue; }
    const prior = candidates.get(id);
    if (prior === undefined) { candidates.set(id, { op, verdict }); continue; }
    if (prior.op === op) continue;
    const cp = canonicalJSON(prior.op);
    const co = canonicalJSON(op);
    if (cp === co) continue;                       // an honest duplicate
    // A SET, not a running push (attack A5). `rejected` and `parked` were given exactly this
    // dedupe during WP-1 integration for exactly this reason — re-delivering one of the two
    // spliced bodies must not make two devices report a different number of splices for the
    // same log — and `splicedIds` was the one report left as an append-per-collision.
    spliced.add(id);
    if (co > cp) candidates.set(id, { op, verdict });
  }
  for (const id of spliced) splicedIds.push(id);
  splicedIds.sort();

  // Only now is the winner routed to its verdict, so `parked` holds the same body on every
  // device. `parked` is sorted by opId before it is returned, so this insertion order is not
  // observable; the BODY is what had to stop depending on arrival.
  const all = [];
  for (const { op, verdict } of [...candidates.values(), ...loose]) {
    if (verdict.status === 'park') { parkOp(op, verdict.parkReason); continue; }
    all.push(op);
  }
  // Everything downstream walks this ONE sorted array. No stage ever sees arrival order.
  all.sort(opOrder);

  // ── Stage 0a. Attestation registers — self-authorizing ────────────────────
  const attested = new Map();          // memberId -> Set<deviceId>
  const memberOfDevice = new Map();    // deviceId -> memberId
  const attestOps = [];
  const wellFormed = [];
  const rest = [];

  for (const op of all) {
    if (op.k !== 'member.set') { rest.push(op); continue; }
    const names = Object.keys(op.f);
    const devNames = names.filter(isDevRegisterName);
    if (devNames.length === 0) { rest.push(op); continue; }
    if (devNames.length !== names.length) {
      // A patch that mixes the self-authorizing bootstrap with fields that need a different
      // predicate has no single admissibility answer. Refuse it rather than pick one.
      reject(op, STAGES[0], REJECT_REASONS.MIXED_MEMBER_PATCH);
      continue;
    }
    const subject = parseEntityKey(op.e).id;
    if (op.act !== subject) {
      // "a member can add devices to their own record and to nobody else's" (§4.0).
      reject(op, STAGES[0], REJECT_REASONS.NOT_SELF);
      continue;
    }
    let bad = false;
    for (const name of devNames) {
      const blob = op.f[name];
      const att = parseAttestationBlob(blob);
      if (!att || att.memberId !== subject || att.deviceShort !== shortOfRegisterName(name)) { bad = true; break; }
      if (!attestVerify(subject, blob)) { bad = true; break; }
    }
    if (bad) { reject(op, STAGES[0], REJECT_REASONS.BAD_ATTESTATION); continue; }
    wellFormed.push(op);
  }

  // WRITE-ONCE, enforced as ADMISSIBILITY (§4.0). For every `member:<M>` → `dev.<short>`
  // register, the only admissible claim is the minimal one under `≺` — the join's own order, so
  // there is no second notion of "first". Every later claim is rejected rather than folded and
  // lost, because a rejection is visible and a silently-losing write is not. Minimal-under-a-
  // total-order is a function of the SET, so this survives every shuffle.
  const firstClaim = new Map();                    // `${e}\u0000${field}` -> write
  for (const op of wellFormed) {
    for (const name of Object.keys(op.f)) {
      const k = `${op.e}\u0000${name}`;
      const w = { stamp: op.ts, op: op.id, value: op.f[name] };
      const cur = firstClaim.get(k);
      if (cur === undefined || cmpWrites(w, cur) < 0) firstClaim.set(k, w);
    }
  }
  for (const op of wellFormed) {
    const wins = Object.keys(op.f).every((name) => firstClaim.get(`${op.e}\u0000${name}`).op === op.id);
    if (wins) attestOps.push(op);
    else reject(op, STAGES[0], REJECT_REASONS.WRITE_ONCE);
  }

  // The device table is read back OUT of the folded registers, not out of the ops, so it can
  // never disagree with what a peer would compute from the same register map.
  const regs = emptyRegs();
  for (const op of attestOps) foldOp(regs, op);
  for (const [e, cells] of regs) {
    const subject = parseEntityKey(e).id;
    for (const [name, cell] of cells) {
      if (!isDevRegisterName(name)) continue;
      const att = parseAttestationBlob(cell.value);
      if (!att) continue;
      if (!attested.has(subject)) attested.set(subject, new Set());
      attested.get(subject).add(att.deviceId);
      // A deviceId can only ever map to one member: the blob is signed over a payload naming
      // `memberId`, and the register it lives in must agree with it, so a second member cannot
      // adopt somebody else's attested device.
      if (!memberOfDevice.has(att.deviceId)) memberOfDevice.set(att.deviceId, subject);
    }
  }

  // ── Stage 0b. The device gate ─────────────────────────────────────────────
  const gated = [];
  for (const op of rest) {
    const cls = spaceClassOf(op.space);
    if (cls === 'family') {
      const set = attested.get(op.act);
      if (!set || !set.has(op.dev)) { reject(op, STAGES[0], REJECT_REASONS.UNATTESTED_DEVICE); continue; }
    } else {
      if (op.act !== me) { reject(op, STAGES[0], REJECT_REASONS.NOT_MY_ACT); continue; }
      if (myDevices && !myDevices.has(op.dev)) { reject(op, STAGES[0], REJECT_REASONS.NOT_MY_DEVICE); continue; }
    }
    gated.push(op);
  }

  // ── Stage 1. The admin chain, per space ───────────────────────────────────
  const linksBySpace = new Map();
  const spaceOps = [];
  const afterChain = [];
  for (const op of gated) {
    if (op.k !== 'space.set') { afterChain.push(op); continue; }
    const parsed = parseEntityKey(op.e);
    if (parsed.id !== op.space) {
      // A `space.set` sealed into space A that addresses space B would let a member of A rewrite
      // B's governance. The entity key and the envelope's space must agree (ADR 002 §5.2).
      reject(op, STAGES[1], REJECT_REASONS.SPACE_MISMATCH);
      continue;
    }
    spaceOps.push(op);
    const l = linkOf(op);
    if (l) {
      if (!linksBySpace.has(op.e)) linksBySpace.set(op.e, []);
      linksBySpace.get(op.e).push(l);
    }
  }

  const chains = new Map();
  for (const [e, links] of linksBySpace) chains.set(e, resolveChain(links, genesisPin));
  const chainFor = (e) => chains.get(e) || { links: [], accepted: [], admin: null };
  const adminAtKey = (e, at) => adminAtIn(chainFor(e).accepted, at);

  const admittedSpaceOps = [];
  for (const op of spaceOps) {
    const chain = chainFor(op.e);
    const l = linkOf(op);
    if (Object.prototype.hasOwnProperty.call(op.f, 'admin')) {
      if (!l) { reject(op, STAGES[1], REJECT_REASONS.BAD_ADMIN_LINK); continue; }
      if (chain.accepted.some((x) => x.id === op.id)) admittedSpaceOps.push(op);
      else reject(op, STAGES[1], REJECT_REASONS.LOST_ADMIN_CHAIN);
      continue;
    }
    // `space.set{name}` / `{epoch}`: admissible only from `op.act === admin@op.ts` (20.1).
    const who = adminAtKey(op.e, op.ts);
    if (who !== null && op.act === who) admittedSpaceOps.push(op);
    else reject(op, STAGES[1], REJECT_REASONS.NOT_ADMIN);
  }

  // ── Stage 2. Membership ───────────────────────────────────────────────────
  const admittedMemberOps = [];
  const afterMembers = [];
  for (const op of afterChain) {
    if (op.k !== 'member.set') { afterMembers.push(op); continue; }
    const subject = parseEntityKey(op.e).id;
    const self = op.act === subject;
    const names = Object.keys(op.f);
    const onlyAlive = names.length === 1 && names[0] === '_alive';
    if (self) { admittedMemberOps.push(op); continue; }
    if (onlyAlive) {
      // Removal by the admin (20.2). There is no other op in this system by which one member
      // touches another member's record — and none at all by which one member purges another
      // member's CONTENT.
      const who = adminAtKey(spaceKey(op.space), op.ts);
      if (who !== null && op.act === who) { admittedMemberOps.push(op); continue; }
      reject(op, STAGES[2], REJECT_REASONS.NOT_ADMIN);
      continue;
    }
    reject(op, STAGES[2], REJECT_REASONS.NOT_SELF);
  }

  for (const op of admittedMemberOps) foldOp(regs, op);

  const currentMembers = new Set(
    [...regs.keys()]
      .filter((e) => e.startsWith('member:'))
      .filter((e) => registerValue(regs, e, '_alive') !== false)
      .map((e) => parseEntityKey(e).id)
      .sort(),
  );

  // ── Stage 3. Content ──────────────────────────────────────────────────────
  //
  // Personal / local first: one writing human, nothing else to check (§4.3). The device gate
  // already ran in stage 0b.
  const admittedContent = [];
  const familyOps = [];
  for (const op of afterMembers) {
    if (op.k === 'pub.set') { familyOps.push(op); continue; }
    admittedContent.push(op);
  }

  // 3a — governing fields. Owner, or the admin's unshare, and nobody else, ever.
  const govRegs = emptyRegs();
  const admittedFamily = [];
  const forStage3b = [];
  for (const op of familyOps) {
    const parsed = parseEntityKey(op.e);
    const kind = parsed.kind;
    const owner = ownerOfEntity(op.e);           // ← the whole of ownership. Structural. §4.4.
    const touchesGov = Object.keys(op.f).some((f) => {
      const s = fieldSpec(kind, f);
      return !!(s && s.gov === true);
    });
    if (op.act === owner) { admittedFamily.push(op); continue; }
    if (touchesGov) {
      const who = adminAtKey(spaceKey(op.space), op.ts);
      if (who === null || op.act !== who) { reject(op, STAGES[3], REJECT_REASONS.NOT_OWNER); continue; }
      const verdict = classifyUnsharePatch(kind, op.f);
      if (verdict === 'no') { reject(op, STAGES[3], REJECT_REASONS.NOT_AN_UNSHARE); continue; }
      if (verdict === 'skew') {
        // An unshare we cannot confirm is PARKED, never rejected. Rejecting it is what turns a
        // staggered app update into "the admin unshared it and the newer client still shows it"
        // — the C2 defect, and the failure ADR 001 §4.1 exists to prevent.
        //
        // Parking is safe in BOTH directions and that is why it is the answer here rather than a
        // rejection: a parked op is never folded, so an admin who pads an unshare with a content
        // write (`{...unsharePatch(kind), 'pub.text': 'gekapert'}`) still gets no write primitive
        // — see ownership-authz-admin A6b. What parking additionally buys, and a rejection
        // destroys, is that the op survives to be re-judged by a build that can read it.
        parkOp(op, PARK_REASONS.UNSHARE_SHAPE);
        continue;
      }
      admittedFamily.push(op);
      continue;
    }
    forStage3b.push(op);
  }
  for (const op of admittedFamily) {
    foldOp(govRegs, op, (f) => {
      const s = fieldSpec(parseEntityKey(op.e).kind, f);
      return !!(s && s.gov === true);
    });
  }

  // 3b — content fields, read against the FINAL 3a registers.
  //
  // "Both predicates read only FAMILY registers (`pub.coEdit`, `pub.level`) — never the owner's
  // truth `visibility`/`coEdit`, which a peer does not have and could never evaluate."
  //
  // Because the predicate reads the FINAL value, an owner who revokes co-edit retroactively
  // withdraws every co-editor write to that entity, at every stamp, on every device. That is the
  // price of order-independence and it is deliberate: the alternative — admitting a write
  // because of a grant that was later withdrawn — makes admissibility depend on which op the
  // folding device saw first, which is precisely the divergence this fold exists to prevent.
  for (const op of forStage3b) {
    const kind = parseEntityKey(op.e).kind;
    if (registerValue(govRegs, op.e, 'pub.coEdit') !== true) { reject(op, STAGES[3], REJECT_REASONS.NO_COEDIT); continue; }
    if (registerValue(govRegs, op.e, 'pub.level') !== 'geteilt') { reject(op, STAGES[3], REJECT_REASONS.NOT_GETEILT); continue; }
    if (!currentMembers.has(op.act)) { reject(op, STAGES[3], REJECT_REASONS.NOT_MEMBER); continue; }
    const badField = Object.keys(op.f).some((f) => {
      const s = fieldSpec(kind, f);
      return !(s && s.coEdit === true);
    });
    if (badField) { reject(op, STAGES[3], REJECT_REASONS.NOT_COEDITABLE); continue; }
    admittedFamily.push(op);   // stage 3a is already folded, so appending here cannot feed back
  }

  for (const op of [...admittedContent, ...admittedFamily]) foldOp(regs, op);
  for (const op of admittedSpaceOps) foldOp(regs, op);

  const admitted = [...attestOps, ...admittedSpaceOps, ...admittedMemberOps, ...admittedContent, ...admittedFamily]
    .sort(opOrder);
  rejected.sort(byId);
  parked.sort(byId);

  // The single family space, when there is exactly one — what `AuthzResult.admin` names. A
  // product with one family space is the whole of ADR 001; the per-space accessors below are the
  // honest general answer.
  const spaceKeys = [...chains.keys()].sort();
  const soleSpace = spaceKeys.length === 1 ? spaceKeys[0] : null;

  return {
    regs,
    admin: soleSpace ? chainFor(soleSpace).admin : null,
    adminAt: (at) => (soleSpace ? adminAtKey(soleSpace, at) : null),
    currentMembers,
    admitted,
    rejected,
    parked,
    splicedIds,
    attestedDevices: attested,
    memberOfDevice: (d) => memberOfDevice.get(d) ?? null,
    rejectionOf: (id) => rejectionOf.get(id) ?? null,
    parkReasonOf: (id) => parkReasonOf.get(id) ?? null,
    adminOfSpace: (sid) => chainFor(`space:${sid}`).admin,
    adminAtInSpace: (sid, at) => adminAtKey(`space:${sid}`, at),
    adminChainOf: (sid) => chainFor(`space:${sid}`).accepted.slice(),
  };
}

/**
 * A JSON-safe, fully ordered rendering of an `AuthzResult`. Two results are equal iff their
 * snapshots are deep-equal — which is how P5 ("shuffling ops never changes which ops
 * foldAuthorized admits") is asserted as ONE comparison rather than a checklist of accessors.
 * @param {AuthzResult} r @returns {Object}
 */
export function snapshot(r) {
  const regs = {};
  for (const e of [...r.regs.keys()].sort()) {
    const cells = r.regs.get(e);
    const o = {};
    for (const f of [...cells.keys()].sort()) {
      const c = cells.get(f);
      o[f] = { value: c.value, stamp: c.stamp, author: c.author, op: c.op ?? null };
    }
    regs[e] = o;
  }
  const devs = {};
  for (const m of [...r.attestedDevices.keys()].sort()) devs[m] = [...r.attestedDevices.get(m)].sort();
  return {
    regs,
    admin: r.admin,
    currentMembers: [...r.currentMembers].sort(),
    admitted: r.admitted.map((o) => o.id),
    rejected: r.rejected.map((o) => (o && typeof o === 'object' ? o.id ?? null : null)),
    parked: r.parked.map((o) => o.id),
    splicedIds: r.splicedIds.slice(),
    attestedDevices: devs,
    reasons: Object.fromEntries(
      r.rejected.filter((o) => o && typeof o === 'object' && typeof o.id === 'string')
        .map((o) => [o.id, r.rejectionOf(o.id)]),
    ),
  };
}
