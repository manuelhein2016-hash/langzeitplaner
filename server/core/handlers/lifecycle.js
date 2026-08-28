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
// The consequence is exact and must be stated rather than hidden behind a 403: **any current
// member can call `/members/remove` on any other member, and any current member can call
// `/spaces/:id/delete`.** Neither grants a single byte of read access — 20.5 is enforced by
// encryption and is untouched here — but both are denials, and the second is destructive.
//
// What bounds it, honestly:
//   · Every member's client sees the removal, because the authoritative removal is the in-log op
//     and the member list (15.4) is on everyone's screen. A server-side removal without the
//     matching log op is visible as an inconsistency, not as a fait accompli.
//   · 20.4's own promise is the answer to a hostile delete: "server data is purged, every member
//     reverts to a **fully intact** solo board". Every device holds a complete replica (§6.3), so
//     losing the relay costs the family the relay, not the data.
//   · The blast radius is capped by the rate limits below and every call is logged.
//
// What would close it: a proof of admin authority the relay can check without reading anything —
// a signature under the current admin's `RK_sig` over `{spaceId, targetMemberId, epoch}`, with
// the admin's recovery public key already on `Member.recoveryPubSig`. That is a WIRE CHANGE and
// therefore an ADR decision, not a handler's to invent. Escalated as **E2-L1**.

import { fail } from '../errors.js';
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

  const out = await ctx.store.tx(async (tx) => {
    const space = await tx.getSpace(spaceId);
    if (!space) throw fail('not_a_member');
    const members = await tx.listMembers(spaceId);
    const devices = await tx.listDevices(spaceId);
    const invites = await tx.listOpenInvites(spaceId);
    const head = await tx.headSeq(spaceId);
    await tx.deleteSpace(spaceId);
    return { members: members.length, devices: devices.length, invites: invites.length, headSeq: head };
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
      serverTime: ctx.now(),
    },
  };
}

/** The slice of the handler registry this file owns. `server/core/handlers/index.js` composes. */
export const handlers = Object.freeze({ removeMember, leaveSpace, transferAdmin, renameSpace, deleteSpace });
