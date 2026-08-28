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
//                               injected (`ctx.attestOpen`, or the legacy boolean
//                               `ctx.attestVerify`). Admission is not credential: a register is
//                               only handed to `openOp` if the op that wrote it was stamped by
//                               the device it attests (I-3 / §4.5 option (a), see §2 below).
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

import { cmp, devOf } from './stamp.js';
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
  /**
   * Stage 3c: EVERY field of the patch was content above the entity's folded `pub.level`, so
   * nothing of it is applicable. The ordinary case is a partial redaction — the offending field
   * is dropped and the rest of the op is folded — and this reason exists only for the case where
   * the redaction empties the patch, because `applyOp` refuses an op that writes nothing
   * (`registers.js:applicabilityError`). Reported on `contentAboveLevel` either way.
   */
  CONTENT_ABOVE_LEVEL: 'contentAboveLevel',
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
// as `ctx.attestOpen` (ADR 001 §4.0, ADR 002 §5.2.3), with the older boolean `ctx.attestVerify`
// still accepted — see `foldAuthorized`.
//
// AND THE DECODED PAYLOAD IS KEPT (finding F-10, ADR 002 §5.2.3). It used to be thrown away here
// with only `deviceId → memberId` surviving, which left `envelope.js` unimplementable: `openOp`
// is handed `env.dv`, a deviceShort, BEFORE it has decrypted anything — so before it knows
// `op.act` — and needs `sigPubRaw` to verify at all (§5.2.2 P2/P3) and `deviceId`/`memberId` to
// bind the plaintext afterwards (checks 3 and 5). `AuthzResult.attestationOf(dv)` is that table.
//
// THE ONE-KEY LOOKUP, AND WHAT MAKES IT SOUND. `attestationOf` is keyed by `deviceShort` ALONE
// because `op.act` is not knowable pre-decrypt. ADR 002 §2.3's four acceptance conditions are
// what make `deviceShort → DeviceAttestation` well-formed — they are NOT what makes it a
// function, and §2.3 as amended says so: a FIFTH rule, the possession proof
// `devOf(cell.stamp) === att.deviceShort`, is what makes the lookup single-valued, and it lives
// with the table it guards (see "A CONTESTED `deviceShort`…" below). The four, enforced below at
// stage 0a:
//   (1) `op.act === memberId`      → the `NOT_SELF` rejection on the housing record;
//   (2) register name === `att.deviceShort`;
//   (3) `att.memberId` === the housing member;
//   (4) the signature verifies under THAT member's recovery key — `attestOpen(subject, blob)`,
//       the subject being the housing member, never the payload's self-declared one.
// (3) and (4) together are what stop a member copying a peer's blob verbatim into their own
// record: the payload names the peer, the housing record names the copier, and the two must
// agree. §5.2.1 warns explicitly that relaxing either breaks §5.2.
//
// AND HERE IS WHAT THE FOUR CONDITIONS DO **NOT** BIND: `att.deviceId`. Round 4, R4-13a.
//
// ─────────────────────────────────────────────────────────────────────────────
// A `deviceId` IS A LABEL, NOT AN IDENTITY (ADR 002 §2.3 as amended · round-4 finding 4)
//
// This block used to end with the claim that "a deviceId can only ever map to one member".
// IT WAS FALSE, and the shape of the falsehood is worth keeping, because it is the same shape
// §4.4 removed from ownership.
//
// Condition (1) binds the housing record to `op.act`. (2) binds `att.deviceShort` to the
// register NAME. (3) and (4) bind `att.memberId` to the housing member and to the key that
// signed. Enumerate the payload's six fields against that list and one is left over:
// `deviceId` is a 128-bit random value with no derivational relationship to any key, asserted
// by its own author, checked by nothing. So Eve mints an attestation that is honest in every
// checkable respect — her record, her short, her `memberId`, her signature — and writes MAMA's
// `deviceId` into it. All four conditions pass. Nothing is rejected.
//
// THE FIX IS NOT A FIFTH CONDITION. There is no fifth condition available: a pure fold cannot
// know which member a random 128-bit label "really" belongs to, and any rule that picked a
// winner between two claims would be picking it on a stamp, i.e. on a number the attacker
// chooses (R4-13b showed exactly that, on the map this file used to publish). Adding a check
// here is the move ADR 001 §4.4 refused for ownership, and it fails for the same reason.
//
// SO THE LABEL IS DEMOTED, THE WAY THE `owner` REGISTER WAS NEVER CREATED. The identity of a
// device in this system is the PAIR — the housing member and the register name — and the
// register name is `deviceShort`, which ADR 001 §1.2 derives from the device's signing key and
// which ADR 002 §5.2.2 P2 self-certifies. Everything that enforces anything already reads the
// pair:
//   · stage 0b asks `attested.get(op.act).has(op.dev)` — the member's OWN record, never a
//     global table;
//   · §5.2.2's checks 3 and 5 read `att.deviceId` / `att.memberId` off ONE attestation resolved
//     by `env.dv`, so both come from the same signed payload.
// The only thing that ever treated a bare `deviceId` as a key was `memberOfDevice`, and a
// forgeable resolver for an identity that does not exist is exactly what §4.4 deleted. It is
// deleted here too: `memberOfDevice` is now the SOLE-CLAIMANT function — one claimant answers,
// two or more answer `null` — and every contested label is published on `deviceIdCollisions`.
// No stamp is consulted, so there is nothing left for a backdate to decide.
//
// WHAT EVE GAINS BY ADOPTING MAMA'S LABEL: nothing, and that is provable rather than hoped for.
// The op she can author with it is `act = EVE, dev = <label>`, which stage 0b admits for ANY
// label she has attested in her own record — a fresh random one included (pinned as R4-13d).
// She cannot author as Mama: `act` is gated by her own attestations, and the envelope layer
// gates the signature under `att.sigPubRaw`, which is her key and hashes to her short. The
// forged value is therefore observationally equal to a random value, so there is nothing to
// gain by forging it. `attestedDevices.get(EVE)` containing that label is not "Eve has Mama's
// device"; it is "Eve has a device that answers to a colliding label", and the collision is
// reported.
//
// WHAT IS STILL OWED (ADR 002 §2.3, amended): a `deviceId` is a label, so nothing may key on it
// alone. `attestedDevices` and `memberOfDevice` are the last two accessors that come close, both
// already marked for removal by WP-6 (`ops.contract.js` §4). A member's device COUNT is honest
// — one register, one device, whatever the label says — so the §2.3 panel surface is unaffected.
//
// ─────────────────────────────────────────────────────────────────────────────
// A CONTESTED `deviceShort` IS NOT A CREDENTIAL (finding I-3)
//
// The residual the four conditions leave is the mirror of the above: nothing pure and
// synchronous can check `crock32(SHA-256(sigPubRaw)[0..10]) === att.deviceShort` (ADR 002
// §5.2.2's P2 — it is a SHA-256, and this file may not await), so a member CAN file a
// well-formed attestation under a PEER's short. This file used to resolve that contest
// minimal-under-`≺` and report the short on `shortCollisions`, which handed a backdated squatter
// `openOp`'s verification key and left the report with no reader.
//
// Refusing the contest was the first answer, and it was the wrong side of the trade — the same
// trade this file already refuses two paragraphs above, for the LABEL. `deviceShort` is the last
// sixteen characters of every stamp a device has ever written, so it is trivially discoverable;
// a bare `dev.*` register is self-authorizing; `dev.*` is write-once; and there is no revocation
// anywhere in this fold. One `member.set` from any member therefore parked every envelope a named
// Mac would ever seal, for the lifetime of the board, with no way back (finding I-3 / R5-7, red-
// team rows M-I3b and M-I3c). And in the window BEFORE the victim's own register has been folded
// — a partial pull, a fresh joiner from seq 0, any batch boundary; there is no causal delivery —
// the squatter's blob was the only claim, so it RESOLVED: P2 passed, P3 passed, the AEAD passed,
// and §5.2.2's check 5 threw. A rejection is final, so in that window the squat did not park the
// victim's traffic, it DROPPED it.
//
// ── WHAT CLOSES IT: THE PAIR `(sigPubRaw, deviceShort)`, BOUND BY POSSESSION ──
//
// FINDINGS §4.5 option (a) — first-claim binding on the pair — with the one strengthening the
// red team's measurement forced: the claim only counts when it is PROVED, and then "first" is
// not a race at all, because there is only ever one claimant who can prove it.
//
//     A `dev.<S>` register is a CREDENTIAL only if the op that wrote it was itself stamped by
//     the device it attests:  devOf(cell.stamp) === att.deviceShort.
//
// That one equality is a possession proof, and it is the ONLY one this fold can read. Every op
// in this fold arrived through `openOp`, which binds three things to `env.dv`: P2 (`env.dv` is
// the short of `att.sigPubRaw`), P3 (the envelope signature verifies under `att.sigPubRaw`), and
// check 4 (`devOf(op.ts) === env.dv`). So an op whose stamp ends in S was signed by the holder of
// the private key that hashes to S. `sigPubRaw` is public and copyable — that is exactly why P2
// alone never closed this — but the SIGNATURE is not, and the stamp is where the signature shows
// through into the plaintext the fold sees.
//
// The squatter can mint the blob (P2 is satisfied — she copies key and short together and tells
// the truth about both), can file it in her own record, and can pass all four §2.3 conditions.
// She cannot author the op that files it: her envelope would have to carry `dv = S` and verify
// under a key she does not hold. So her claim is admitted, recorded, REPORTED on
// `unprovenShorts`, and never resolved. The victim's own register, filed by the victim's own Mac,
// is unaffected, resolves as it always did, and his envelopes open.
//
// THIS IS WHAT THE HONEST FLOW ALREADY DOES, EVERYWHERE. ADR 002 §6.3 step 8: the new Mac
// "self-attests" and writes its own register (`pairing.js` `adoptPairedDevice`). §7.3 step 4:
// the restoring Mac self-attests (`backup.js` step 6, `ensureAttestedDevice`). There is no flow
// in which one device files another device's attestation, and there cannot be: the blob is signed
// by `RK_sig`, but the REGISTER is written by an op, and an op is stamped by whoever authored it.
//
// WHAT IS STILL REFUSED, AND WHY BOTH HALVES STAY. `attestationOf` still returns `null` for:
//   · a short with no proven claim at all — including the pre-collision window above, which is
//     now a PARK (P1) instead of a resolve-then-throw. A park is re-evaluable (§5.2.5); a
//     rejection is not, and that difference was S2(c);
//   · a short PROVEN by two different member records. Two members cannot both hold one signing
//     private key, so this is a genuine 80-bit collision or a broken engine, and neither is a
//     contest a fold may pick a winner in. Reported on `shortCollisions`;
//   · one `sigPubRaw` under two different shorts — a DIRECT contradiction of §1.2 that needs no
//     hash to see. `verifyAttestation` enforces P2 and refuses that blob at condition (4) before
//     it ever reaches here, so this is defence in depth against a blob arriving some other way,
//     not the live check it looks like. Also on `shortCollisions`.
//
// AND WHAT IS NOT REJECTED: an unproven claim is still ADMITTED. Refusing it would hand any
// member a way to un-attest an honest peer by naming their short, which is the same worse trade
// this file already refuses for the label — and it would cost the forger nothing, since any op
// she can author under a peer's short she can author under an invented one.
// ─────────────────────────────────────────────────────────────────────────────

/** b64url is the alphabet ADR 002 §2.3 fixes for the two raw public points. */
const B64URL = /^[A-Za-z0-9_-]+$/;
const isB64u = (s) => typeof s === 'string' && s.length > 0 && B64URL.test(s);

/**
 * The decoded payload half of a `dev.*` register value — ADR 002 §2.3's `DeviceAttestation`.
 * @typedef {Object} DeviceAttestation
 * @property {string} memberId
 * @property {string} deviceId    `dev_` + 22 b64url
 * @property {string} deviceShort 16 Crockford base32 (ADR 001 §1.2)
 * @property {string} sigPubRaw   b64url of the raw P-256 signing point
 * @property {string} kexPubRaw   b64url of the raw P-256 key-agreement point
 * @property {string} createdAt   'YYYY-MM-DD'
 */

/**
 * Decode the payload half of a `dev.*` register value. Never throws — a malformed blob from a
 * peer is data, not a bug in this process (the door policy: external input is refused, never
 * thrown on).
 *
 * ALL SIX FIELDS ARE REQUIRED, and that is a deliberate tightening (F-10). §2.3 fixes the wire
 * form and ADR 002 §5.2.2's pre-decrypt gate is unrunnable without `sigPubRaw`: P2 self-certifies
 * the short against it and P3 verifies the envelope signature under it. A blob missing them is
 * not a partially-useful attestation, it is a credential `openOp` could never use — so it never
 * becomes one here either, and its op is rejected `badAttestation` rather than admitted into a
 * table with a hole in it. Unknown EXTRA fields are ignored, not refused: a v2.1 attestation must
 * stay readable by a v2.0 client (the same version-skew discipline as `classifyUnsharePatch`).
 *
 * @param {unknown} blob
 * @returns {DeviceAttestation|null}
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
  if (!isB64u(att.sigPubRaw) || !isB64u(att.kexPubRaw)) return null;
  if (typeof att.createdAt !== 'string' || att.createdAt.length === 0) return null;
  return Object.freeze({
    memberId: att.memberId,
    deviceId: att.deviceId,
    deviceShort: att.deviceShort,
    sigPubRaw: att.sigPubRaw,
    kexPubRaw: att.kexPubRaw,
    createdAt: att.createdAt,
  });
}

/**
 * The six fields ADR 002 §2.3 fixes, in the order it lists them. `attestationVerifies` compares
 * ALL SIX — not the four it used to (R4-15a). The two it skipped were `createdAt` and, worse,
 * `kexPubRaw`: the KEY-AGREEMENT POINT, which is the exact thing §2.3's anti-key-injection
 * argument is about and the exact thing §4.2 wraps the space key to. An injected opener that
 * could disagree about it and still be believed would be a second, unlogged source of the one
 * value the family key gets wrapped under — the key-injection hole entered through the front
 * door, which is what the agreement check exists to refuse.
 */
const ATT_FIELDS = Object.freeze(['memberId', 'deviceId', 'deviceShort', 'sigPubRaw', 'kexPubRaw', 'createdAt']);

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
 *
 * THE ATTESTATION SURFACE (F-10 · ADR 002 §5.2.3). `attestationOf` is the one `envelope.js` is
 * written against; the two below it are retained for existing in-repo callers and are strictly
 * derivable from it (`attestationOf(dv).memberId` / `.deviceId`). WP-6 removes them once those
 * callers move — see `docs/v2/contracts/ops.contract.js` §4.
 * @property {(dv:string) => DeviceAttestation|null} attestationOf   keyed by deviceShort ALONE;
 *                                           `null` for a CONTESTED short, for an UNPROVEN one
 *                                           (I-3 / §4.5 option (a)) and for a plain miss
 * @property {string[]} shortCollisions      sorted contested deviceShorts — one short PROVEN on
 *                                           two member records, or one `sigPubRaw` under two
 *                                           shorts
 * @property {string[]} unprovenShorts       sorted deviceShorts whose `dev.*` register was filed
 *                                           by some OTHER device — admitted, reported, and never
 *                                           resolved: the squat (I-3 / R5-7) lands here
 * @property {Array<{opId:string,e:string,field:string,level:string|null}>} contentAboveLevel
 *                                           stage 3c: registers DROPPED because the entity's
 *                                           folded `pub.level` does not carry them (INV-R1 on
 *                                           the receiving device). Sorted by `(opId, field)`.
 * @property {Map<string, Set<string>>} attestedDevices      memberId → attested deviceIds
 * @property {(deviceId:string) => string|null} memberOfDevice  the SOLE claimant, else null
 * @property {string[]} deviceIdCollisions   sorted deviceIds claimed on more than one member
 *                                           record; a label with no owner (R4-13a)
 * @property {string[]} splicedIds          opIds that arrived carrying two different op bodies
 */

/**
 * @param {Iterable<Object>} ops
 * @param {{ me:string, nowMs?:number,
 *           attestOpen?:(m:string, blob:string)=>(DeviceAttestation|null),
 *           attestVerify?:(m:string, blob:string)=>boolean,
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
  //
  // TWO SHAPES, ONE SOURCE OF TRUTH FOR THE PAYLOAD. ADR 001 §4.0 / ADR 002 §5.2.3 name the
  // injection `attestOpen(memberId, blob) => DeviceAttestation|null`; the WP-1 shape was the
  // boolean `attestVerify(memberId, blob)`. Both are accepted so the two can cross over without
  // a flag day — but neither supplies the payload the table is built from. That always comes
  // from `parseAttestationBlob`, i.e. from the register bytes themselves, and an `attestOpen`
  // whose answer disagrees with those bytes is treated as a failed verification. Otherwise the
  // injected function could smuggle in an attestation the log does not actually carry, which is
  // the same key-injection hole §2.3 exists to close, entered through the front door.
  const attestOpen = typeof ctx.attestOpen === 'function' ? ctx.attestOpen : null;
  const attestVerifyFn = typeof ctx.attestVerify === 'function' ? ctx.attestVerify : null;
  /** @param {string} memberId @param {string} blob @param {DeviceAttestation} parsed */
  const attestationVerifies = (memberId, blob, parsed) => {
    if (attestOpen) {
      const opened = attestOpen(memberId, blob);
      if (opened === null || typeof opened !== 'object') return false;
      // ALL SIX, not four (R4-15a). `kexPubRaw` is the key-agreement point §4.2 wraps the space
      // key to; an opener allowed to disagree about it is a key-injection channel.
      return ATT_FIELDS.every((f) => opened[f] === parsed[f]);
    }
    if (attestVerifyFn) return !!attestVerifyFn(memberId, blob);
    return false;
  };
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
  const attested = new Map();          // memberId -> Set<deviceId>  — the PAIR, per §2.3 amended
  const claimants = new Map();         // deviceId -> Set<memberId>  — a label may be claimed twice
  const attByShort = new Map();        // deviceShort -> { att: DeviceAttestation, member }
  const shortOfSigPub = new Map();     // sigPubRaw -> deviceShort   — §1.2 is a function
  const shortCollisions = new Set();   // contested deviceShorts: `attestationOf` refuses these
  const unprovenShorts = new Set();    // claimed by a record that did not file it FROM that device
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
    // ADR 002 §2.3's four acceptance conditions, all four, in one place. (1) is the `NOT_SELF`
    // rejection immediately above — `op.act === subject`, the housing member. The rest:
    //   (2) `att.deviceShort` === the register name;
    //   (3) `att.memberId` === the housing member — this is what refuses a peer's blob copied
    //       verbatim into my own record, and §5.2.1 warns that relaxing it breaks §5.2;
    //   (4) the signature verifies under the HOUSING member's recovery key. `subject` is passed,
    //       never `att.memberId`, so a payload cannot nominate the key that checks it — though
    //       with (3) already enforced the two are equal by then. Belt and braces, because if (3)
    //       ever moves this line is the one still holding.
    let bad = false;
    for (const name of devNames) {
      const blob = op.f[name];
      const att = parseAttestationBlob(blob);
      if (!att || att.memberId !== subject || att.deviceShort !== shortOfRegisterName(name)) { bad = true; break; }
      if (!attestationVerifies(subject, blob, att)) { bad = true; break; }
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
      // THE PAIR. `(housing member, deviceId)` is the only device fact this fold asserts, and it
      // is the one stage 0b reads. It is scoped by construction: the deviceId is read out of a
      // register that lives in `subject`'s own record and nowhere else.
      if (!attested.has(subject)) attested.set(subject, new Set());
      attested.get(subject).add(att.deviceId);
      // THE LABEL. `att.deviceId` is asserted by its own author and bound by none of §2.3's four
      // conditions (R4-13a). It is therefore recorded as a MULTI-valued claim, never as a key: a
      // deviceId with two claimants has no owner, and `memberOfDevice` says so rather than
      // picking the one whose author chose the smaller stamp.
      if (!claimants.has(att.deviceId)) claimants.set(att.deviceId, new Set());
      claimants.get(att.deviceId).add(subject);
      // THE `deviceShort → DeviceAttestation` TABLE (F-10), AND THE POSSESSION PROOF THAT MAKES
      // IT A CREDENTIAL (I-3 / R5-7, FINDINGS §4.5 option (a)).
      //
      // One short can appear at most once per member record — the register NAME is the short, and
      // a Map has one cell per name — so a second sighting is always a second MEMBER claiming the
      // same short. §2.3 argues that cannot happen honestly; the four conditions do not make it
      // impossible, only dishonest. What makes it impossible is the line below.
      //
      // `cell.stamp` IS the writing op's `ts`, and its last sixteen characters are the authoring
      // device's short (`stamp.js`: pad13(ms).pad6(ctr).deviceShort16). That op reached this fold
      // through `openOp`, whose P2, P3 and check 4 together mean: an op stamped with S was signed
      // by the holder of the private key that hashes to S. So a register that attests S and was
      // written by S is PROVED; one written by any other device is a claim its author could not
      // back, and is never handed to `openOp` as a verification key. See the §2 block above for
      // why it is still admitted rather than rejected.
      if (devOf(cell.stamp) !== att.deviceShort) unprovenShorts.add(att.deviceShort);
      else {
        const prior = attByShort.get(att.deviceShort);
        if (prior === undefined) attByShort.set(att.deviceShort, { att, member: subject });
        else if (prior.member !== subject) shortCollisions.add(att.deviceShort);
      }
      // The one half of ADR 001 §1.2 a pure fold CAN check: the short is a hash of `sigPubRaw`,
      // so one signing key hashes to exactly one short. Two shorts over one key is a direct
      // contradiction — visible without hashing anything — and both shorts are contested. This
      // catches the squat that lands BEFORE its victim's own attestation, when the member test
      // above has nothing yet to collide with.
      const seenShort = shortOfSigPub.get(att.sigPubRaw);
      if (seenShort === undefined) shortOfSigPub.set(att.sigPubRaw, att.deviceShort);
      else if (seenShort !== att.deviceShort) {
        shortCollisions.add(att.deviceShort);
        shortCollisions.add(seenShort);
      }
    }
  }
  // A label with more than one claimant. Reported so the contest is auditable rather than merely
  // survivable — and so a caller that gets `null` from `memberOfDevice` can tell "unknown device"
  // from "contested label". Nothing is rejected for it: refusing both claims would let anybody
  // un-attest an honest peer's device by naming its label, which is a worse trade than an
  // unresolved query. See the §2 block for why the label buys its forger nothing.
  const deviceIdCollisions = new Set();
  for (const [devId, who] of claimants) if (who.size > 1) deviceIdCollisions.add(devId);

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

  // ── Stage 3c. INV-R1 on the RECEIVING device (ADR 004 §2.2, barrier 4's mirror) ───────────
  //
  // WHY THIS EXISTS AT ALL. Every redaction barrier in the product lives in `sealOp` — barriers
  // 3 and 4 and the `assertNoContentAboveLevel` backstop are all AUTHOR-side. A member running a
  // patched build has no seal path to defeat: they hand the relay an envelope whose plaintext
  // carries `pub.text` for an entry the family only ever agreed to see as Belegt, and until this
  // stage existed every honest peer decrypted it, folded it and rendered it. `geteiltOnly` was a
  // mark that only the writer consulted, which makes it a house style rather than an invariant.
  //
  // THE RULE IS MIRRORED, NOT INVENTED. Two rules already say what may exist at a level, and a
  // third answer to that question is the duplication ADR 004 warns against, so this reads the
  // same `FIELDS` marks the author side reads and adds no table of its own:
  //
  //   at `geteilt`            nothing is above the level
  //   at `belegt`             the `geteiltOnly` fields are      (`assertNoContentAboveLevel`)
  //   at `privat`, or with
  //   no level register yet   every non-governing `pub.*` field is   (barrier 4's privat clause)
  //
  // GOVERNING REGISTERS ARE NEVER DROPPED. `pub.level`, `pub.coEdit`, `pub.alive` and `_born`
  // carry no content, and they are HOW a withdrawal is expressed — a rule that dropped them
  // could not be undone by the admin unshare that has to survive it (§4.3 stage 3a).
  //
  // AN EXPLICIT `null` ALWAYS PASSES, at every level. §5's withdrawal escape: a downgrade
  // clears a published value by writing null, so a rule that refused nulls below Geteilt would
  // make the downgrade unrepresentable. A null can never carry a value, which is the whole
  // distinction, and it is the same sentence `assertNoContentAboveLevel` makes on the far side.
  //
  // THE FIELD IS DROPPED, THE OP IS NOT REJECTED — and that is not politeness, it is the
  // difference between the two implementable rules. Rejecting the op would drop its `pub.date`
  // too, and at Belegt a date is not content above the level, it is the ENTIRE legitimate Belegt
  // payload. So an owner who later downgrades Geteilt → Belegt would silently destroy the
  // booking the downgrade was supposed to keep. Dropping the field keeps it. Domain C5 measures
  // `date` beside `text` for exactly this reason.
  //
  // IT READS THE FINAL FOLDED LEVEL, exactly as stage 3b's co-edit predicate does and for the
  // reason stated there: admissibility must not depend on which op the folding device saw first.
  // That also makes it RETROACTIVE, which is the point rather than a side effect — an op that
  // was entirely legitimate when it was sealed (the entry really was Geteilt then) is redacted
  // once the owner downgrades, so a replayed envelope, an older client that downgraded without
  // nulling, and a patched build that never nulls at all all land in the same place. No non-null
  // `geteiltOnly` value can survive in the register map while the level says otherwise, whatever
  // order the ops arrived in.
  const contentAboveLevel = [];
  const redacted = new Map();          // opId -> the patch with the offending fields removed
  for (const op of admittedFamily) {
    const level = registerValue(govRegs, op.e, 'pub.level');
    if (level === 'geteilt') continue;              // nothing is above the top level
    const kind = parseEntityKey(op.e).kind;
    const drop = [];
    for (const name of Object.keys(op.f)) {
      const s = fieldSpec(kind, name);
      // A field with no spec is not classifiable as content and is left to the gates that own
      // field names; a governing register is not content at all.
      if (!s || s.gov === true) continue;
      if (op.f[name] === null) continue;            // the withdrawal escape
      if (level === 'belegt' && !s.geteiltOnly) continue;
      drop.push(name);
    }
    if (!drop.length) continue;
    const f = {};
    for (const [k, v] of Object.entries(op.f)) if (!drop.includes(k)) f[k] = v;
    redacted.set(op.id, Object.keys(f).length ? f : null);   // null = nothing of it survives
    for (const name of drop) {
      contentAboveLevel.push({ opId: op.id, e: op.e, field: name, level: level ?? null });
    }
  }
  // A function of the SET, like every other reported array here (§0.2).
  contentAboveLevel.sort((a, b) => (a.opId < b.opId ? -1 : a.opId > b.opId ? 1
    : a.field < b.field ? -1 : a.field > b.field ? 1 : 0));

  // AN OP IS REPLACED BY ITS REDACTED BODY EVERYWHERE, `admitted` INCLUDED — and that is a
  // contract, not tidiness. `admitted` is the audit trail of what produced the register map, so
  // `ops.contract.js` §3's guarantee (re-applying an admitted op to the settled map changes
  // nothing — property P2, and deliverable 17.5's „neu" dot rests on it) is false the moment
  // `admitted` hands back a body that was not the one folded. Replaying the ORIGINAL patch would
  // also put the redacted value straight back into the map, which would make stage 3c cosmetic on
  // any path that re-folds. Nothing persists `admitted` — the log keeps the original envelope —
  // so redacting the derived array loses nothing that is not still on disk.
  //
  // A patch redacted to NOTHING is rejected rather than admitted with an empty body:
  // `applyOp` refuses an op that writes nothing, so an inapplicable op in `admitted` would break
  // the same contract from the other side. Stage 3b sets the precedent — it rejects a co-editor's
  // whole op when ANY field is non-co-editable — so refusing one where EVERY field is refused is
  // the more permissive of the two, not a new severity.
  const foldedFamily = [];
  for (const op of admittedFamily) {
    if (!redacted.has(op.id)) { foldedFamily.push(op); continue; }
    const f = redacted.get(op.id);
    if (f === null) { reject(op, STAGES[3], REJECT_REASONS.CONTENT_ABOVE_LEVEL); continue; }
    foldedFamily.push(Object.freeze({ ...op, f: Object.freeze(f) }));
  }

  for (const op of [...admittedContent, ...foldedFamily]) foldOp(regs, op);
  for (const op of admittedSpaceOps) foldOp(regs, op);

  const admitted = [...attestOps, ...admittedSpaceOps, ...admittedMemberOps, ...admittedContent, ...foldedFamily]
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
    // F-10 / ADR 002 §5.2.3. Keyed by deviceShort alone, because `openOp` calls it before it
    // has decrypted anything and therefore before it knows `op.act`. Never throws on a bad key:
    // `env.dv` is peer-supplied, and peer-supplied input is refused, not thrown on.
    //
    // I-3 / §4.5 option (a): only a PROVEN claim is a credential. `attByShort` holds nothing but
    // registers filed by the device they attest, so an unproven claim is already absent from it
    // — the squat resolves to `null` without a second table being consulted, in the contested
    // case AND in the pre-collision window where it is the only claim there is. A genuine
    // collision — one short proven twice — is still refused outright, and `null` is a defined
    // outcome at this seam: §5.2.2 P1 parks the sealed envelope and a park is re-evaluable.
    // This is `shortCollisions`' reader.
    attestationOf: (dv) => (shortCollisions.has(dv) ? null : attByShort.get(dv)?.att ?? null),
    shortCollisions: [...shortCollisions].sort(),
    // The squat's report. A short claimed by a record that could not author an op under it: the
    // §2.3 device panel SHOULD render these next to `shortCollisions`, because this is the one
    // contest that is now decided rather than merely visible, and the loser should still be able
    // to see that somebody tried.
    unprovenShorts: [...unprovenShorts].sort(),
    // Stage 3c's report. Content the fold DROPPED because the entity's folded `pub.level` does
    // not carry it — `{opId, e, field, level}` per dropped register, sorted. The panel should
    // render it: the receiving device is now deliberately disagreeing with the sender about what
    // was published, and a redaction nobody can see is indistinguishable from a sync bug.
    contentAboveLevel,
    // Retained for existing callers; both fall out of `attestationOf`. WP-6 removes them.
    attestedDevices: attested,
    // The SOLE-CLAIMANT function, not a first-writer-wins map (R4-13a/b). A `deviceId` is a
    // label its own author asserts; one claimant is an answer, two or more is `null` and a row
    // on `deviceIdCollisions`. No stamp is read, so backdating decides nothing.
    memberOfDevice: (d) => {
      const who = claimants.get(d);
      return who !== undefined && who.size === 1 ? [...who][0] : null;
    },
    deviceIdCollisions: [...deviceIdCollisions].sort(),
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
  // The `deviceShort → DeviceAttestation` table, rendered from the result itself: the shorts that
  // exist are exactly the `dev.*` registers that survived the fold, and `attestationOf` is asked
  // for each one. So P5 ("shuffling never changes the fold") now covers WHICH attestation each
  // short resolves to, which is what `openOp` will key on — a divergence there would hand two
  // devices different verification keys for the same envelope.
  const shorts = new Set();
  for (const cells of r.regs.values()) {
    for (const [name, cell] of cells) {
      if (!isDevRegisterName(name)) continue;
      const att = parseAttestationBlob(cell.value);
      if (att) shorts.add(att.deviceShort);
    }
  }
  const attestations = {};
  for (const s of [...shorts].sort()) attestations[s] = r.attestationOf(s);
  return {
    regs,
    admin: r.admin,
    currentMembers: [...r.currentMembers].sort(),
    admitted: r.admitted.map((o) => o.id),
    rejected: r.rejected.map((o) => (o && typeof o === 'object' ? o.id ?? null : null)),
    parked: r.parked.map((o) => o.id),
    splicedIds: r.splicedIds.slice(),
    attestations,
    shortCollisions: r.shortCollisions.slice(),
    unprovenShorts: r.unprovenShorts.slice(),
    // Stage 3c rides in the snapshot for the same reason the contest reports do: it is a
    // decision the fold makes, so P5 ("shuffling ops never changes the fold") has to cover it.
    // A device that redacted a field its peer applied would be exactly the divergence INV-R1 is
    // supposed to remove, and it would be invisible without this line.
    contentAboveLevel: r.contentAboveLevel.map((x) => ({ ...x })),
    // Both contest reports ride in the snapshot, so P5 ("shuffling never changes the fold")
    // covers them: a device that reported a collision its peer did not would be a divergence in
    // the one place the design now leans on — `attestationOf` refuses a contested short, so the
    // report decides whether an envelope opens.
    deviceIdCollisions: r.deviceIdCollisions.slice(),
    attestedDevices: devs,
    reasons: Object.fromEntries(
      r.rejected.filter((o) => o && typeof o === 'object' && typeof o.id === 'string')
        .map((o) => [o.id, r.rejectionOf(o.id)]),
    ),
  };
}
