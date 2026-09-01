// server/core/handlers/lifecycle.js — the space lifecycle.  LZP-204, stories 20.1–20.4.
//
// ADR 003 §3 (`/members/remove`, `/members/leave`, `/members/transfer`, `/spaces/:id/rename`,
// `/spaces/:id/delete`), §6.3 (retention, and the endpoint that is deliberately absent),
// ADR 002 §4.1 (removal forces a rotation), §7.4 (the copy contract), addendum F20.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT REMOVAL ACTUALLY DOES, AND WHAT IT HONESTLY CANNOT
// ─────────────────────────────────────────────────────────────────────────────────────────────
// 20.2: "Removing a member deletes their shared/Belegt entries from all family boards and their
// access — their private data on their own machine is untouched, **because it was never ours**."
// That sentence is the whole design of this file. The server does four things and no more:
//
//   1. `removeMember` — one column write, and every request from that member's devices now fails
//      at auth step 6 (ADR 003 §2). Removal is INSTANT server-side; it does not wait for a
//      rotation, a sync, or anyone's laptop to be awake.
//   2. `deleteOpsByDevices` — the 20.2 purge, keyed on `deviceShort` and never on a bare
//      `deviceId` (ADR 002 §2.3: a `deviceId` is a forgeable label; a purge keyed on it would let
//      a caller name an honest peer's label and have that peer's ops deleted).
//   3. revoke that member's devices and delete every wrap they hold, for all epochs.
//   4. revoke every invite they had issued — otherwise a removed member's outstanding invite is
//      a way back in for an accomplice, sent before anyone had reason to distrust them.
//
// And what it does not do: it does not reach any other member's Mac. Everything already pulled
// stays pulled. ADR 002 §7.4 requires the UI to say so in one plain sentence — „Was ihr Mac schon
// geladen hat, bleibt auf ihrem Mac" — and no server behaviour may be written that implies
// otherwise. There is deliberately **no per-entity redaction endpoint** (§6.3): an endpoint that
// lets any member delete another member's ops from the relay is a censorship primitive.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ THE ONE THING THE SERVER CANNOT CHECK — RECORDED, NOT PAPERED OVER  (finding E2-L1)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// **The relay cannot tell who the admin is.** ADR 003 §5.1: "no role column … the admin is
// resolved from the in-log chain (ADR 001 §4.1)", and `store-interface.js` puts `role` in
// `FORBIDDEN_COLUMN_TOKENS` so one cannot be added by accident. The admin chain lives inside the
// ciphertext, which the relay may not read — that is story 21.1 and it is not negotiable.
//
// The consequence used to be stated here and shipped anyway: **any current member could call
// `/members/remove` on any other member, and any current member could call
// `/spaces/:id/delete`.** A red team drove exactly that against a real three-member circle
// (attack **T5-M1**, `tests/fleet/e6-attack-removed.test.js` §1): a plain invited member evicted
// the admin — 200, `purgedOps: 2`, `revokedDevices: 1` — and then deleted the whole
// Familienkreis in one further request. ADR 002 §0's T5 row names "ability to purge another
// member" in the must-NOT-get column, and this file's sibling `handlers/spaces.js` had already
// written the conclusion down as finding **E2-203-2**: *"an unverifiable 'admin' endpoint that
// purges another member's ops is the censorship primitive ADR 003 §6.3 explicitly rejects."*
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED, AND THE HALF THAT DID NOT — READ BOTH BEFORE TOUCHING EITHER ROUTE
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The fix is `auth.js`'s **admin proof** (ADR 003 §3.7): a signature under a member's
// `Member.recoveryPubSig` — a column the relay already holds and already verifies against for
// `POST /devices/adopt` (ADR 002 §7.3) — over bytes the relay assembles itself,
// `"lzp/admin/1\n" + act + "\n" + spaceId + "\n" + target + "\n" + epoch`. No content is read,
// no role column is written, nothing is stored.
//
// **It cannot prove "the admin".** There is no anchor for that: the founder is not derivable
// (`Member.joinedAt` is identical for every member of a space created and joined inside one
// millisecond — see `auth.js` finding **E2-L1b**, which specifies the one nullable column that
// would fix it). What it proves is strictly weaker and, for T5, sufficient:
//
//     **A SECOND MEMBER'S RECOVERY KEY STOOD BEHIND THIS ACT.**
//
// T5 is *one* family member with *one* patched app and *one* Keychain. She cannot sign under a
// key she does not hold, and no client patch changes that.
//
//   · `POST /spaces/:id/delete` — **REQUIRES the proof**, whenever the space has ever had more
//     than one member row. The irreversible, whole-circle act is the one that must not be
//     available to a single hostile member, and it is the one route in ADR 003 §3 with no honest
//     single-actor caller: a Familienkreis belongs to the family. T5-M1 §1c is closed on this.
//     The degenerate case — a `psp_` personal space, or a circle nobody ever joined — needs no
//     second key, because there is no second person to censor.
//
//   · `POST /members/remove` — the proof is **verified when presented and never ignored** (a
//     malformed or forged one is a hard refusal, not a downgrade to "membership only"), and the
//     response says which authority ran. It is **not yet required**, and that is the honest
//     residual rather than a design: requiring it changes what an unproofed honest caller gets
//     from this route, and four rows in two fleet suites this pass does not own
//     (`tests/fleet/round9-e6.test.js` §…, `tests/fleet/round10-e6-gate.test.js` ×3) assert that
//     an unproofed honest member gets `200` with `purgedOps > 0`, while `src/js/family/
//     adminpanel.js` and `src/js/family/removal.js` mint no proof at all. Flipping it is ONE
//     LINE below plus those callers. Carried as **T5-M1a** in `LIFECYCLE_FINDINGS`, and it is a
//     D7 ruling, not a handler's call.
//
// What still bounds the un-proofed removal, honestly:
//   · Every member's client sees the removal, because the authoritative removal is the in-log op
//     and the member list (15.4) is on everyone's screen. A server-side removal without the
//     matching log op is visible as an inconsistency, not as a fait accompli.
//   · 20.4's own promise is the answer to a hostile delete: "server data is purged, every member
//     reverts to a **fully intact** solo board". Every device holds a complete replica (§6.3), so
//     losing the relay costs the family the relay, not the data.
//   · The blast radius is capped by the rate limits below and every call is logged.

import { fail } from '../errors.js';
import { verifyAdminProof } from '../auth.js';
import { memberIdentity, enforceFor } from '../limits.js';
import { enforceRate, requireObject, requireId } from './devices.js';
import { recoveryRecipientId } from './keys.js';

const HOUR = 3600000;

/**
 * ⚠ ONE LIMITER, AND IT IS A DISAGREEMENT WITH `server/core/limits.js` THAT IS DELIBERATE.
 *
 * `RATE_COVERAGE` (LZP-205) declares every route in this file unlimited, and for four of the five
 * its reason holds: `renameSpace` and `transferAdmin` store nothing at all, `leaveSpace` is
 * self-only and idempotent, and `deleteSpace` is "idempotent; the second call has nothing to
 * delete". Those four therefore carry no bucket here, so §6.1's policy stays in one table.
 *
 * `removeMember` is the exception, because its written reason begins **"admin-only"** — and the
 * relay cannot know that. There is no `role` column and there cannot be one (see the header,
 * E2-L1). So the premise that makes an unlimited removal endpoint safe is the one premise this
 * server is structurally unable to check, and until an admin-authority proof exists on the wire,
 * a bounded blast radius is what stands between "a compromised member device" and "the whole
 * circle removed in a loop". Reported for a `RATE_COVERAGE` amendment rather than left implicit.
 *
 * **`deleteSpace` stays unlimited, and the admin proof does not change that.** It adds at most ONE
 * P-256 verification per request, and only to a request that already named a live co-member —
 * the three cheap refusals (absent, self-signed, signer not a member) all run before the verify.
 * A route that already spends one ECDSA verification on the `Authorization` header is not turned
 * into an amplifier by a second one. Worth re-reading if a third act is ever added to §3.7.
 */
export const LIFECYCLE_LIMIT_DEFAULTS = Object.freeze({
  /** A family of eight is removed at most eight times, ever. Ten an hour is generous for the
   *  honest admin and small for a script. */
  memberRemovePerMemberHour: 10,
});

const limitOf = (ctx, name) => (ctx.limits && typeof ctx.limits[name] === 'number' ? ctx.limits[name] : LIFECYCLE_LIMIT_DEFAULTS[name]);

/**
 * Field names a lifecycle body may never carry.
 *
 * The relay stores no space name, no display name and no role (`MODEL_COLUMNS` is a closed set
 * and `FORBIDDEN_COLUMN_TOKENS` names these shapes explicitly). A body that offers one is either
 * a client that believes the server keeps it — a belief worth correcting loudly, once, at the
 * boundary — or the first half of a change that would put a family's name in a database in
 * Frankfurt. Both are answered with a 400 that says which field and why.
 */
const FORBIDDEN_BODY_KEYS = Object.freeze([
  'name', 'title', 'label', 'caption', 'text', 'displayName', 'role', 'admin', 'note', 'description',
]);

function refuseReadableFields(body) {
  for (const k of Object.keys(body)) {
    if (FORBIDDEN_BODY_KEYS.includes(k)) {
      throw fail('bad_request', {
        field: k,
        reason: 'the_relay_stores_no_readable_names',
      });
    }
  }
}

/** @returns {Promise<{space:Object, members:Object[]}>} */
async function spaceAndMembers(store, spaceId) {
  const space = await store.getSpace(spaceId);
  if (!space) throw fail('not_a_member');     // an unknown space and a space you are not in: one answer
  return { space, members: await store.listMembers(spaceId) };
}

/**
 * Everything the relay holds for one member, ready to be deleted. Pure over two arrays so the
 * removal and the leave path cannot diverge.
 * @param {Object[]} devices `listDevices(spaceId)` @param {string} memberId
 */
function belongingsOf(devices, memberId) {
  const own = devices.filter((d) => d.memberId === memberId);
  return {
    deviceIds: own.map((d) => d.id),
    deviceShorts: own.map((d) => d.deviceShort),
    recipients: [...own.map((d) => d.id), recoveryRecipientId(memberId)],
  };
}

/**
 * The shared body of 20.2 (remove) and 20.3 (leave). One implementation, because the two stories
 * say "the same effect" and two implementations would be two chances to forget the invite sweep.
 *
 * @param {Object} tx a store transaction handle
 * @param {string} spaceId @param {string} memberId @param {number} at
 * @returns {Promise<Object>}
 */
async function purgeMember(tx, spaceId, memberId, at) {
  const devices = await tx.listDevices(spaceId);
  const own = belongingsOf(devices, memberId);

  // 20.2 — the member's own ops leave the relay. Keyed on deviceShort (ADR 002 §2.3).
  const purgedOps = own.deviceShorts.length > 0 ? await tx.deleteOpsByDevices(spaceId, own.deviceShorts) : 0;

  await tx.removeMember(memberId, at);
  for (const id of own.deviceIds) await tx.revokeDevice(id, at);

  // Every wrap they hold, for ALL epochs (ADR 002 §4.2 step 4). Without this a removed member's
  // device can still re-fetch the wraps for epochs 1..e from `GET /spaces/:id/keys` — and while
  // that would only ever return keys they already had, leaving a removed member with a live
  // delivery path is the kind of residue that becomes a finding six months later.
  const purgedWraps = await tx.deleteKeyWrapsForDevices(spaceId, own.recipients);

  // An invite they issued is a way back in for someone they choose, minted before anyone had
  // reason to distrust them. 15.5 already makes invites revocable; this makes it automatic.
  const open = await tx.listOpenInvites(spaceId);
  let revokedInvites = 0;
  for (const inv of open) {
    if (inv.createdBy !== memberId) continue;
    await tx.revokeInvite(inv.id, at);
    revokedInvites++;
  }

  return { purgedOps, purgedWraps, revokedInvites, devices: own.deviceIds.length };
}

/**
 * THE ADMIN-PROOF GATE, in one place, so `/members/remove` and `/spaces/:id/delete` cannot drift.
 *
 * `auth.js#verifyAdminProof` owns the cryptography and the refusal codes; this owns the two
 * questions a handler has to answer around it — **must a proof be here?** and **what do we say
 * about the one that was?**
 *
 * `required` is the whole difference between the two routes today, and it is deliberately a
 * parameter rather than two code paths: the day `src/js/family/adminpanel.js` mints a proof for
 * a removal, `removeMember` passes `required: true` and nothing else in this file moves (T5-M1a).
 *
 * Note what is NOT read from the body: `act`, `spaceId`, `target` and `epoch` are all assembled
 * by the CALLER of this function out of values the relay already holds. A proof a caller could
 * re-address by editing a sibling field would authorize an act nobody signed for.
 *
 * @param {Object} body the SIGNED body
 * @param {{act:string, spaceId:string, target:string, epoch:number, members:Object[],
 *          callerMemberId:string, required:boolean, reason:string}} terms
 * @param {Object} ctx
 * @returns {Promise<{authorizedBy:'admin_proof'|'membership_only', by:string|null}>}
 */
async function adminProofGate(body, terms, ctx) {
  const present = body.adminProof !== undefined && body.adminProof !== null;
  if (!present) {
    if (terms.required) {
      // A 403, because what is missing is AUTHORITY and not shape. `errors.js` gained
      // `admin_proof_required: 403` during integration — this used to be a `bad_request` only
      // because that frozen table had no authorization code that was not a lie
      // (`not_a_member` would also have been the oracle `assertMember` exists to avoid).
      // The body still says exactly what is missing and over what.
      throw fail('admin_proof_required', {
        field: 'adminProof',
        reason: terms.reason,
        signedString: 'lzp/admin/1 | act | spaceId | target | epoch',
        act: terms.act,
        epoch: terms.epoch,
      });
    }
    return { authorizedBy: 'membership_only', by: null };
  }
  // PRESENT, THEREFORE VERIFIED. A proof that is offered and not checked is worse than no proof
  // at all: it puts a field on the wire that every later reader takes for a control.
  const { by } = await verifyAdminProof(body.adminProof, {
    act: terms.act,
    spaceId: terms.spaceId,
    target: terms.target,
    epoch: terms.epoch,
    members: terms.members,
    callerMemberId: terms.callerMemberId,
  }, ctx);
  return { authorizedBy: 'admin_proof', by };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 20.1 / 20.2 — `POST /api/v1/members/remove`
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** @type {(req:Object, ctx:Object) => Promise<Object>} */
export async function removeMember(req, ctx) {
  const auth = await ctx.auth(req);
  const body = requireObject(req.body);
  refuseReadableFields(body);
  const spaceId = requireId(body, 'spaceId');
  const memberId = requireId(body, 'memberId');
  await ctx.assertMember(auth.memberId, spaceId);
  // Integrated (LZP-207): now RATE_RULES.memberRemove, declared by RATE_COVERAGE.removeMember —
  // so the table no longer says "admin-only, therefore unlimited" about the one route whose admin
  // claim the server structurally cannot check (E2-203-2). See LIMIT_EXTENSIONS E2-L6.
  await enforceFor(req, ctx, 'memberRemove', auth);

  // Removing yourself is `/members/leave`. Two stories, two endpoints, and keeping them apart is
  // what lets the client show the right sentence: 20.2's is about someone else, 20.3's is about
  // you, and ADR 002 §7.4 fixes different copy for each.
  if (memberId === auth.memberId) throw fail('bad_request', { reason: 'use_leave', use: '/api/v1/members/leave' });

  // ── THE ADMIN PROOF, VERIFIED WHEN PRESENTED (ADR 003 §3.7, finding T5-M1a) ────────────────
  // `required: false` is the residual, not the design — see the file header. It is read here,
  // before the transaction, out of values the RELAY holds: the epoch is the store's, the member
  // list is the store's, and the only thing that comes from the body is the signature itself.
  const seen = await ctx.store.getSpace(spaceId);
  if (!seen) throw fail('not_a_member');
  //
  // ── WHERE THE PROOF IS REQUIRED, AND WHY IT IS EXACTLY THERE (the T5-M1a ruling) ──────────
  //
  // Required to remove THE FOUNDER; not required for anybody else. That line is not a
  // compromise between "closed" and "green", it is where the damage actually is.
  //
  // WHY NOT "always". The relay cannot identify the admin — `AUTH_INTERFACE_GAPS` E2-L1b, and
  // it is structural: the admin chain is an in-log `transferAdmin` op (ADR 001 §4.1) that a
  // blind relay may not read. So the strongest blind rule is "a second member co-signed". Made
  // unconditional, that rule is UNSATISFIABLE in a two-member circle — the only other member is
  // the target, and she will not co-sign her own removal — so a couple could never remove
  // anybody, which is the single most likely real removal there is. A rule that cannot be
  // satisfied is not a rule; it is the feature deleted.
  //
  // WHY THE FOUNDER. Removing her is the only removal that destroys the space for EVERYBODY
  // rather than for one person: it purges ADR 001 §4.0's attestation and §4.1's admin-chain
  // genesis link, after which `adminAtIn` answers null for every stamp in the space and no
  // future joiner can admit anything she ever wrote. That is precisely the damage the red team
  // measured (`tests/fleet/e6-attack-removed.test.js` §1b), and `Space.founderMemberId` is a
  // fact the relay wrote itself and can check blind.
  //
  // WHAT IS STILL OPEN, AND IT IS STATED RATHER THAN IMPLIED: an ordinary member may still
  // remove any NON-founder, and two members who collude may remove the founder. Closing that
  // needs the relay to verify the admin chain — a transfer-certificate chain anchored here —
  // which is a protocol change (ADR 003 §3.7, E2-L1b), not a gate.
  const founder = seen.founderMemberId || null;
  const gate = await adminProofGate(body, {
    act: 'member.remove',
    spaceId,
    target: memberId,
    epoch: seen.currentEpoch,
    members: await ctx.store.listMembers(spaceId),
    callerMemberId: auth.memberId,
    // A space created before this column existed has no founder recorded, and fails OPEN: a null
    // must not wedge every removal in every circle that already exists.
    required: founder !== null && memberId === founder,
    reason: 'founder_removal_needs_second_key',
  }, ctx);

  const out = await ctx.store.tx(async (tx) => {
    const { space, members } = await spaceAndMembers(tx, spaceId);
    const target = members.find((m) => m.id === memberId);
    if (!target) throw fail('not_a_member');
    // Idempotent: a retried removal is a success, not a 409. A lost response must never cost the
    // admin a second confirmation dialogue.
    if (target.removedAt !== null) {
      return { removed: false, alreadyRemoved: true, purgedOps: 0, purgedWraps: 0, revokedInvites: 0, devices: 0, currentEpoch: space.currentEpoch };
    }
    const r = await purgeMember(tx, spaceId, memberId, ctx.now());
    return { removed: true, alreadyRemoved: false, ...r, currentEpoch: space.currentEpoch };
  });

  if (typeof ctx.log === 'function') ctx.log({ route: req.routeName, spaceId, deviceShort: auth.deviceShort, opCount: out.purgedOps, status: 200 });

  return {
    status: 200,
    body: {
      spaceId,
      memberId,
      removed: out.removed,
      alreadyRemoved: out.alreadyRemoved,
      purgedOps: out.purgedOps,
      purgedWraps: out.purgedWraps,
      revokedDevices: out.devices,
      revokedInvites: out.revokedInvites,
      currentEpoch: out.currentEpoch,
      // WHICH AUTHORITY ACTUALLY RAN. Said on the wire rather than inferred, so a client cannot
      // render a membership-only removal as an admin act, and so the day this route REQUIRES a
      // proof the change is visible in a response body rather than only in a status code.
      authorizedBy: gate.authorizedBy,
      // ADR 002 §4.1 — a removal forces `e+1`, and `keys.js` will refuse a rotation that leaves
      // anyone who is left behind out of it. The server states the obligation and cannot perform
      // it: performing it would mean holding a key.
      rotateRequired: true,
      // ADR 002 §7.4. The relay is telling the client what is true, so the client cannot claim
      // something stronger on screen.
      alreadyDeliveredIsIrrevocable: true,
      serverTime: ctx.now(),
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 20.3 — `POST /api/v1/members/leave`
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * "Leaving voluntarily has the same effect, self-initiated … nobody ever loses their *own* data
 * by leaving." The second half is true because of what this endpoint does **not** touch: the
 * leaver's board, registers and log are on their Mac and were never on the relay in readable
 * form. What leaves the relay is the leaver's ops — the copies other members were reading.
 *
 * **The last member out deletes the space.** A family space with no members is an unreadable pile
 * of ciphertext nobody holds a key for; leaving it there would be retention for its own sake, and
 * 20.4's outcome — everyone back to a fully intact solo board — is already what has happened.
 *
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function leaveSpace(req, ctx) {
  const auth = await ctx.auth(req);
  const body = requireObject(req.body);
  refuseReadableFields(body);
  const spaceId = requireId(body, 'spaceId');
  await ctx.assertMember(auth.memberId, spaceId);

  const out = await ctx.store.tx(async (tx) => {
    const { space, members } = await spaceAndMembers(tx, spaceId);
    const me = members.find((m) => m.id === auth.memberId);
    if (!me) throw fail('not_a_member');
    if (me.removedAt !== null) {
      return { left: false, alreadyLeft: true, spaceDeleted: false, purgedOps: 0, purgedWraps: 0, revokedInvites: 0, devices: 0, currentEpoch: space.currentEpoch };
    }
    const r = await purgeMember(tx, spaceId, auth.memberId, ctx.now());

    const remaining = members.filter((m) => m.id !== auth.memberId && m.removedAt === null);
    let spaceDeleted = false;
    if (remaining.length === 0) {
      await tx.deleteSpace(spaceId);
      spaceDeleted = true;
    }
    return { left: true, alreadyLeft: false, spaceDeleted, ...r, currentEpoch: space.currentEpoch };
  });

  if (typeof ctx.log === 'function') ctx.log({ route: req.routeName, spaceId, deviceShort: auth.deviceShort, opCount: out.purgedOps, status: 200 });

  return {
    status: 200,
    body: {
      spaceId,
      memberId: auth.memberId,
      left: out.left,
      alreadyLeft: out.alreadyLeft,
      spaceDeleted: out.spaceDeleted,
      purgedOps: out.purgedOps,
      purgedWraps: out.purgedWraps,
      revokedDevices: out.devices,
      revokedInvites: out.revokedInvites,
      // A leave rotates too (ADR 002 §4.1) — performed by "the departing member's successor-admin",
      // not by the leaver, who no longer holds a seat at `e+1`. Nothing to do when the space is gone.
      rotateRequired: !out.spaceDeleted,
      alreadyDeliveredIsIrrevocable: true,
      serverTime: ctx.now(),
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 20.1 — `POST /api/v1/members/transfer`
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * "Mirrors the IN-LOG admin chain; **never authoritative**" (`server.contract.js` §3).
 *
 * This endpoint **stores nothing**, and that is the design rather than an omission. There is no
 * `Member.role` column — `role` is in `FORBIDDEN_COLUMN_TOKENS` — because the admin is resolved
 * from the in-log chain (ADR 001 §4.1), which is inside the ciphertext. A shadow role column on
 * the relay would be a second, weaker, plaintext answer to "who is the admin", and the first
 * time the two disagreed the weaker one would win somewhere.
 *
 * So what is it for? Two checkable things, both worth a round trip before a client emits the
 * transfer op into the log: **the successor exists and is a current member of this space**, and
 * **the caller is a current member too**. A transfer to a removed member would hand the circle to
 * nobody, and the log op cannot be withdrawn once written (ADR 001 — registers are write-once at
 * a stamp). ADR 002 §4.1 confirms a transfer does not rotate: nobody's read access changes.
 *
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function transferAdmin(req, ctx) {
  const auth = await ctx.auth(req);
  const body = requireObject(req.body);
  refuseReadableFields(body);
  const spaceId = requireId(body, 'spaceId');
  const memberId = requireId(body, 'memberId');
  await ctx.assertMember(auth.memberId, spaceId);

  const { members } = await spaceAndMembers(ctx.store, spaceId);
  const target = members.find((m) => m.id === memberId);
  if (!target || target.removedAt !== null) throw fail('not_a_member');
  if (memberId === auth.memberId) throw fail('bad_request', { reason: 'transfer_to_self' });

  if (typeof ctx.log === 'function') ctx.log({ route: req.routeName, spaceId, deviceShort: auth.deviceShort, status: 200 });

  return {
    status: 200,
    body: {
      spaceId,
      memberId,
      /** The relay checked that the successor is real. It did not — and cannot — record a role. */
      authoritative: false,
      stored: 'nothing',
      recordedIn: 'the encrypted op log (ADR 001 §4.1)',
      rotateRequired: false,          // ADR 002 §4.1 — "admin role transfer: no. Nobody's read access changes."
      serverTime: ctx.now(),
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 20.1 — `POST /api/v1/spaces/:id/rename`
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * **The relay has never held a space name and this endpoint does not start.**
 *
 * `MODEL_COLUMNS.Space` is `[id, kind, currentEpoch, nextSeq, headChain, createdAt]` and the set
 * is closed; the Familienkreis's name travels encrypted, like a display name, like everything
 * else a human wrote. So a rename is a client-side op and this route's entire job is to be the
 * place where that is said out loud — including to a future client that arrives with
 * `{ name: "Familie Hein" }` in the body and gets a 400 naming the field, rather than a 200 and a
 * name sitting in a Postgres row in Frankfurt.
 *
 * It is kept in the table (ADR 003 §3 lists it) because removing it would only move the question:
 * a client would then have no way to learn that the rename it just performed is purely local.
 *
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function renameSpace(req, ctx) {
  const auth = await ctx.auth(req);
  const spaceId = requireId(req.params || {}, 'id');
  const body = req.body === null || req.body === undefined ? {} : requireObject(req.body);
  refuseReadableFields(body);
  await ctx.assertMember(auth.memberId, spaceId);

  const space = await ctx.store.getSpace(spaceId);
  if (!space) throw fail('not_a_member');

  if (typeof ctx.log === 'function') ctx.log({ route: req.routeName, spaceId, deviceShort: auth.deviceShort, status: 200 });

  return {
    status: 200,
    body: {
      spaceId,
      renamed: false,
      stored: 'nothing',
      reason: 'the relay stores no space name; the name travels encrypted in the op log (ADR 003 §5.2)',
      rotateRequired: false,          // ADR 002 §4.1 — "space rename: no"
      serverTime: ctx.now(),
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 20.4 — `POST /api/v1/spaces/:id/delete`
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * "As admin I can delete the entire Familienkreis: **server data is purged, every member reverts
 * to a fully intact solo board.**"
 *
 * The second clause is what makes the first safe to implement, and it is a fact about the
 * architecture rather than a hope: every device holds a complete replica (ADR 003 §6.3), so
 * deleting the space costs the family the **relay**, not the **data**. That is also the honest
 * mitigation for E2-L1 in the header — the relay cannot verify who the admin is, and the worst a
 * hostile member can do with this endpoint is force everyone back to the solo board they can
 * still see in full.
 *
 * `store.deleteSpace` is the cascade, in one place, so nothing survives by omission: members,
 * devices, ops, epochs, wraps and invites all go (contract case C09..C11). The handler's job is
 * the three things around it — establish that the caller is in the space, require an explicit
 * confirmation, and report what went — plus one rate limit tight enough that a compromised
 * device cannot do this in a loop.
 *
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function deleteSpace(req, ctx) {
  const auth = await ctx.auth(req);
  const spaceId = requireId(req.params || {}, 'id');
  const body = requireObject(req.body);
  refuseReadableFields(body);
  await ctx.assertMember(auth.memberId, spaceId);

  // The body must name the space it is deleting. A destructive endpoint that fires on an empty
  // body is one mis-routed retry away from deleting the wrong circle, and the client already has
  // the id — this costs nothing and is the same shape as every „tippe den Namen ein" confirmation
  // the admin panel shows (deliverable 22).
  if (body.confirm !== spaceId) throw fail('bad_request', { field: 'confirm', reason: 'must_equal_space_id' });

  // ── AND THE SECOND KEY (ADR 003 §3.7) ─────────────────────────────────────────────────────
  // This is the route T5-M1 §1c drove: one request from one ordinary invited member destroyed a
  // three-person Familienkreis. It now takes two people's recovery keys, and the reason it can
  // take that without a role column is that the relay never has to learn who the admin is — only
  // that the caller was not alone (see `auth.js` §6b).
  //
  // **The exemption is the degenerate case, and it is counted over ALL member rows including
  // tombstones.** `members.length === 1` means nobody has ever joined this space but the caller:
  // a `psp_` personal space (19.4), or a circle created and abandoned. There is no second person
  // to censor, so demanding a second key would only make a solo space undeletable. Counting
  // tombstones is what keeps the obvious bypass shut — remove everyone first, then delete alone
  // — because a removed member leaves a row behind (`Member.removedAt`), never a hole.
  const space = await ctx.store.getSpace(spaceId);
  if (!space) throw fail('not_a_member');
  const roster = await ctx.store.listMembers(spaceId);
  await adminProofGate(body, {
    act: 'space.delete',
    spaceId,
    target: spaceId,
    epoch: space.currentEpoch,
    members: roster,
    callerMemberId: auth.memberId,
    required: roster.length > 1,
    reason: 'second_member_signature_required',
  }, ctx);

  const out = await ctx.store.tx(async (tx) => {
    const space = await tx.getSpace(spaceId);
    if (!space) throw fail('not_a_member');
    const members = await tx.listMembers(spaceId);
    const devices = await tx.listDevices(spaceId);
    const invites = await tx.listOpenInvites(spaceId);
    const head = await tx.headSeq(spaceId);
    await tx.deleteSpace(spaceId);
    return { members: members.length, devices: devices.length, invites: invites.length, headSeq: head, roster: members.length };
  });

  if (typeof ctx.log === 'function') ctx.log({ route: req.routeName, spaceId, deviceShort: auth.deviceShort, status: 200 });

  return {
    status: 200,
    body: {
      spaceId,
      deleted: true,
      purged: {
        members: out.members,
        devices: out.devices,
        openInvites: out.invites,
        // The op-log high-water mark, not a row count: the relay reports what it held, and after
        // the cascade there is nothing left to count.
        headSeq: String(out.headSeq),
      },
      // 20.4's promise, echoed so a client cannot render this as data loss.
      localBoardsUnaffected: true,
      // ADR 003 §3.7. `sole_member` is the degenerate exemption above and never a family circle.
      authorizedBy: out.roster > 1 ? 'admin_proof' : 'sole_member',
      serverTime: ctx.now(),
    },
  };
}

/**
 * What this pass closed, what it did not, and who owns the rest. Frozen and exported as DATA —
 * the way `AUTH_INTERFACE_GAPS` and `HANDLER_FINDINGS` are — so `tests/server/lifecycle.test.js`
 * asserts each row still carries its consequence, and so "T5-M1a is open" cannot quietly stop
 * being said. A finding that lives only in a commit message is a finding nobody closes.
 *
 * @type {ReadonlyArray<{id:string, status:string, what:string, consequence:string, owner:string}>}
 */
export const LIFECYCLE_FINDINGS = Object.freeze([
  Object.freeze({
    id: 'T5-M1b',
    status: 'CLOSED — `POST /spaces/:id/delete` requires a second member\'s recovery signature.',
    what:
      'A plain invited member deleted a three-member Familienkreis in one request. ADR 002 §0 T5 '
      + 'puts that in the must-NOT-get column and handlers/spaces.js finding E2-203-2 had already '
      + 'written down why the route should not exist without an admin proof.',
    consequence:
      'The route now runs auth.js#verifyAdminProof over "lzp/admin/1 | act | spaceId | target | '
      + 'epoch", signed under a LIVE member\'s Member.recoveryPubSig, and refuses a signature by '
      + 'the caller herself. Exempt only when the space has exactly one member row EVER — '
      + 'tombstones counted, so "remove everyone, then delete alone" is not a bypass.',
    owner: 'CLOSED — server/core/auth.js §6b + this file',
  }),
  Object.freeze({
    id: 'T5-M1a',
    status: 'OPEN — the proof is verified when presented and NOT yet required. D7 ruling owed.',
    what:
      '`POST /members/remove` still authorizes on `ctx.assertMember` alone, so any current member '
      + 'can evict any other, purge their Op rows and revoke their devices. The client-side rule '
      + '(`src/js/core/ops.js#mustBeSittingAdmin`) is real and is on the wrong side of the wire.',
    consequence:
      'Requiring the proof is `required: true` on ONE call in `removeMember` — and it changes what '
      + 'an unproofed honest caller gets, which four rows in two suites this pass does not own '
      + 'assert today: tests/fleet/round9-e6.test.js (the racing-removals row) and '
      + 'tests/fleet/round10-e6-gate.test.js (three rows) all require `200` + `purgedOps > 0` from '
      + 'a member holding no proof. `src/js/family/adminpanel.js` and `src/js/family/removal.js` '
      + 'mint none. Until then the residual is a DENIAL and a purge by a single member, never a '
      + 'read: 20.5 is enforced by encryption and is untouched.',
    owner: 'PO / D7 + src/js/family/adminpanel.js + the two fleet suites',
  }),
  Object.freeze({
    id: 'T5-M1c',
    status: 'OPEN — consequence of T5-M1a, not a defect of its own.',
    what:
      'While `/members/remove` is un-proofed, a hostile member can still reach an empty circle in '
      + 'N+1 requests: remove every other member (N calls, rate-limited to 10/member/hour and '
      + 'individually visible on every member list), then `/members/leave`, whose last-member-out '
      + 'cascade deletes the space.',
    consequence:
      'The ONE-CALL destruction primitive is gone and every step is now separately attributable, '
      + 'rate-limited and visible (15.4). The cascade is deliberately left alone: gating it would '
      + 'make an all-members-left circle undeletable and would not close the path, because the path '
      + 'is the un-proofed removal. Closing T5-M1a closes this.',
    owner: 'follows T5-M1a',
  }),
  Object.freeze({
    id: 'E2-L1',
    status: 'HALF-CLOSED — superseded by T5-M1a/T5-M1b + auth.js E2-L1b.',
    what:
      'The original "the relay cannot tell who the admin is". Still true, and now stated with the '
      + 'reason it cannot be fixed here: there is no founder anchor in the schema and Member.joinedAt '
      + 'ties for every member of a space created and joined inside one millisecond (E2-L1b).',
    consequence:
      'The relay enforces a TWO-KEY rule where an admin rule is unavailable. That is weaker than '
      + '"only the admin" and strictly stronger than "any one member", and the T5 adversary is by '
      + 'definition one member with one Keychain.',
    owner: 'server/prisma/schema.prisma + server/core/store-interface.js (Space.founderMemberId)',
  }),
]);

/** The slice of the handler registry this file owns. `server/core/handlers/index.js` composes. */
export const handlers = Object.freeze({ removeMember, leaveSpace, transferAdmin, renameSpace, deleteSpace });
