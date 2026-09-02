// server/core/handlers/invites.js — create, redeem, revoke and list invites.  LZP-203.
// ADR 002 §7.1 (rewritten for PO decision D9) · ADR 003 §3, §6.1 · stories 15.2, 15.3, 15.5.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// D9 IS THE WHOLE DESIGN OF THIS FILE
// ─────────────────────────────────────────────────────────────────────────────────────────────
// An invite authorizes MEMBERSHIP and nothing else. It carries no key material of any kind: no
// epoch key, wrapped or otherwise, is attached to an invite, stored against one, or derivable
// from an invite code. There is no `wrappedKeys` column, and `normalizeRow` throws if a handler
// tries to invent one (store-interface.js RULE 1, contract case C06).
//
// The consequence is a two-step join, and it is a designed screen rather than an error:
//
//   1. the joiner proves knowledge of the code and publishes her PUBLIC device keys. She is
//      immediately a member — the member list shows her (15.4), and this endpoint returns that
//      list so her app can show the circle she just entered;
//   2. she holds no epoch key, so the family ops she can already pull are ciphertext she cannot
//      open. They are parked, never dropped (ADR 001 §7.4, risk R11);
//   3. any existing member device — not only the admin's — wraps the ring to her on its next
//      ordinary sync, covering ALL epochs 1..e so she sees the shared history (A4, 17.1). That
//      wrap arrives through `POST /spaces/:id/epoch`, and `spaces.js` refuses it if it does not
//      cover her.
//
// The response therefore ends with `pendingKeys`, computed rather than asserted, so the client
// can render D9's waiting state from a fact instead of an assumption. Nothing in this file ever
// returns bytes a member could decrypt anything with.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THE SERVER KNOWS ABOUT A CODE: NOTHING
// ─────────────────────────────────────────────────────────────────────────────────────────────
//   code      12 Crockford chars = 60 bits, shown as XXXX-XXXX-XXXX, generated on the admin's Mac
//   inviteId  b64u(HKDF(code, '', 'lzp/v2/invite/id', 16))        — 22 b64url chars
//   verifier  SHA-256(HKDF(code, '', 'lzp/v2/invite/verify', 32)) — 32 bytes, STORED
//   proof     HKDF(code, '', 'lzp/v2/invite/verify', 32)          — 32 bytes, PRESENTED
//
// The raw code never reaches the server, and the stored verifier is not sufficient to redeem:
// a database dump yields `SHA-256(proof)` and inverting it is the whole point. That is why the
// server has to hash — see `CTX_EXTENSIONS` E2-C1 in spaces.js.
//
// PURITY (ADR 003 §9). `ctx.now()`, `ctx.random()`, `ctx.sha256()`, `ctx.store`. Nothing ambient.

import { fail } from '../errors.js';
import {
  INVITE_ID_RE, SPACE_ID_RE, COLOR_REF_RE,
  readObject, readId, readBytes,
  requireActiveMember, requireSelfAuth, readDevice, readMemberKeys, logOk,
} from './spaces.js';
import { memberProjection } from './members.js';
import { enforceFor } from '../limits.js';

/** 7 days (story 15.5, ADR 002 §7.1). Fixed: a client does not get to choose its own TTL. */
export const INVITE_TTL_MS = 604800000;

/** `Invite.wrapSalt` is 32 bytes and vestigial under D9 — finding E2-203-4 in spaces.js. */
const WRAP_SALT_LEN = 32;

/** The HKDF output presented at redemption, and the length of its SHA-256. */
const PROOF_LEN = 32;
const VERIFIER_LEN = 32;

/**
 * How many invites may be open in one space at once.
 *
 * ADR 003 §6.1 publishes a limit on REDEMPTIONS and none on creation, which leaves an
 * authenticated member able to mint invites until the table is full — and every open invite is a
 * redeemable membership, so the cap is a security control and not only a storage one. A family is
 * at most eight people (ADR 003 §3.2), so twenty simultaneously open invites is generous by a
 * factor of two and a half. LZP-205 owns the published number; this is the conservative stand-in
 * and it is stated rather than hidden.
 */
export const MAX_OPEN_INVITES = 20;

/**
 * How many LIVE members one space may hold. ADR 003 §3.2 — *"It is at most 8 rows of pseudonymous
 * ids"* — and until this round that sentence was a comment and not a check: `grep -rn
 * 'MAX_MEMBERS|too_many_members' server/core/` was empty, so a member could mint identities into
 * a circle without limit.
 *
 * **What this is, and what it is not.** It is not a fix for finding **T5-M2**. Nothing here can
 * be: a `Member` row is not a person, and a blind relay cannot compare two of them to one human,
 * so a second identity in an eight-seat circle is still a second identity. What a cap does is
 * turn *"the number of second keys she can hold is not bounded by anything"* into a bounded,
 * stated number, at the size the protocol already assumes everywhere — the pull projection ships
 * `members` on every response because it is "at most 8 rows", `family/createjoin.js` picks from
 * ten colour tones for "at most eight members", and `lifecycle.js` sizes
 * `memberRemovePerMemberHour` on "a family of eight". A relay that promises eight rows on the
 * wire and admits eighty is lying to its own client.
 *
 * **TOMBSTONES DO NOT COUNT, deliberately** — the opposite choice from `deleteSpace`'s
 * `roster.length > 1` exemption, and for the opposite reason. There, counting tombstones shuts a
 * bypass ("remove everyone, then delete alone"). Here, counting them would mean a family of five
 * that has said goodbye to three people over two years cannot invite a sixth: a seat freed by a
 * removal or a leave is a seat. The abuse it re-opens — remove, invite, remove, invite — costs a
 * request per identity, is charged against `memberRemovePerMemberHour = 10`, and is visible on
 * every member list (15.4); and it never exceeds eight live rows, which is the number this cap
 * is about.
 */
export const MAX_LIVE_MEMBERS = 8;

/**
 * Compare two byte strings without an early exit.
 *
 * The realistic attack on this comparison is not a timing attack — an attacker who could feed
 * adaptive guesses of a 32-byte value would be attacking 2^256, and the 10-per-IP-per-hour cap
 * bounds them long before that. It is four lines, it removes a whole class of question from a
 * reviewer's mind, and a comparison of secret-derived material that short-circuits is the kind of
 * thing that gets copied into a place where it does matter.
 *
 * @param {Uint8Array} a @param {Uint8Array} b @returns {boolean}
 */
export function bytesEqual(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** @param {Object} ctx @returns {(b:Uint8Array) => Promise<Uint8Array>} */
function digestOf(ctx) {
  if (!ctx || typeof ctx.sha256 !== 'function') {
    // Fail closed and loudly. A missing digest must never degrade into "accept the proof": that
    // would turn every invite id — which is not a secret once it has been seen on the wire — into
    // a membership grant.
    throw fail('internal');
  }
  return ctx.sha256;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/invites  — 15.2, 15.5
// ─────────────────────────────────────────────────────────────────────────────

const CREATE_FIELDS = ['spaceId', 'inviteId', 'verifier'];

/**
 * Mint an invite for a space the caller is a member of.
 *
 * The client derives `inviteId` and `verifier` from a code it generated and never sends; the
 * server stores two opaque values and a 7-day expiry. It cannot reconstruct the code, cannot
 * redeem the invite it just created, and cannot put the code into the invitation email — the
 * client composes that (docs/v2/invitation-email.md).
 *
 * **Any member may issue an invite, not only the admin.** 15.5 says "the admin", and the server
 * has no way to know who that is: ADR 003 §5.1 deleted the role column deliberately and the admin
 * is resolved from the in-log chain. Finding E2-203-2 states the gap; what bounds it here is that
 * every issued invite is visible to every member through `GET /invites/open`, every redemption
 * shows up in the member list (15.4), and the open-invite cap keeps the blast radius at twenty.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * ⚠ AND THIS LINE IS WHAT MAKES `lifecycle.js`'s TWO-KEY RULE SATISFIABLE BY ONE PERSON
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * Finding **T5-M2**. `verifyAdminProof` requires two distinct `Member` rows to sign an
 * irreversible act. This route lets any member mint a code, `redeemInvite` below admits a fresh
 * `memberId` + `recoveryPubSig` + self-attested device, and **nothing anywhere compares two
 * member rows to one human — a blind relay cannot.** So Eve invites herself, redeems as a second
 * identity, keeps both recovery keys in her own Keychain, and co-signs her own founder removal.
 *
 * **The obvious close was costed and rejected, and it is written here rather than in a commit
 * message so nobody re-proposes it as new.** Requiring the inviter to be the founder — or an
 * admin — is mutant **N-1**, and it *over-closes*: it reddens `tests/fleet/e6-attack-removed`
 * §0e/§0f and `tests/server/attack-client-lifecycle` §D ×2, and it contradicts this paragraph's
 * own shipped design (15.5, and D9's "any existing member wraps the ring to her"). It is also
 * the wrong shape: a founder-signed invite would make the FOUNDER the admin, which
 * `transferAdmin` — a real, shipped op — is there to stop being true.
 *
 * The two closes that are the right shape are both somebody else's file: an **admin-signed**
 * invite verifiable against an in-request transfer-certificate chain (ADR 003 §3.7's owed
 * protocol change), or moving the co-signature **into the op log**, where ADR 001 §4's admin
 * chain already lives and where a client — unlike the relay — can see who a member is. Until one
 * of those, `admin_proof` is a field and not a control, and `lifecycle.js#PROVES_NOT` says so on
 * every response. What this file DOES do about it is bound the fleet: `MAX_LIVE_MEMBERS`.
 *
 * @param {Object} req @param {Object} ctx @returns {Promise<Object>} ServerRes
 */
export async function createInvite(req, ctx) {
  const body = readObject(req.body, CREATE_FIELDS, CREATE_FIELDS, '');
  const spaceId = readId(body, 'spaceId', SPACE_ID_RE, '');
  const inviteId = readId(body, 'inviteId', INVITE_ID_RE, '');
  const verifier = readBytes(body, 'verifier', '', { len: VERIFIER_LEN });

  const { auth, member } = await requireActiveMember(req, ctx, spaceId);
  // NO RATE LIMITER HERE, deliberately. `limits.js`'s RATE_COVERAGE declares `createInvite`
  // unlimited because it is reachable only after the whole ADR 003 §2 chain — a known,
  // unrevoked device of a current member — so a flood is attributable and revocable with one
  // column write. That reasoning holds for this route (unlike `createSpace`, finding E2-203-6),
  // and the bound that actually matters is MAX_OPEN_INVITES below: what a hostile member could
  // do with volume here is mint redeemable memberships, not fill a table, and a cap on how many
  // can be OPEN AT ONCE bounds that directly where a per-hour rate does not.

  const at = ctx.now();
  const expiresAt = new Date(at + INVITE_TTL_MS);
  const epoch = await ctx.store.tx(async (tx) => {
    const space = await tx.getSpace(spaceId);
    if (!space) throw fail('not_a_member');

    // `putInvite` is an UPSERT (store-interface.js), so re-POSTing the id of an invite that has
    // already been used or revoked would overwrite the row and reset `usedAt`/`revokedAt` to
    // null. That is a resurrection primitive: a leaked code that 15.5 promises "can't haunt the
    // family" would come back to life on request. Refused here, inside the transaction, because
    // the interface offers no create-only variant.
    if (await tx.getInvite(inviteId)) throw fail('bad_request', { field: 'inviteId', reason: 'exists' });

    const open = await tx.listOpenInvites(spaceId);
    if (open.length >= MAX_OPEN_INVITES) {
      throw fail('bad_request', { field: 'inviteId', reason: 'too_many_open', open: open.length });
    }

    // ADR 003 §3.2's eight seats, refused EARLY. The authoritative check is at redemption (below,
    // where the seat is actually taken); this one exists so an admin learns the circle is full
    // before she composes an invitation email around a code that cannot work.
    const live = (await tx.listMembers(spaceId)).filter((m) => m.removedAt === null).length;
    if (live >= MAX_LIVE_MEMBERS) {
      throw fail('bad_request', { field: 'inviteId', reason: 'space_full', live, max: MAX_LIVE_MEMBERS });
    }

    await tx.putInvite({
      id: inviteId,
      spaceId,
      verifier,
      // Server-generated, never caller-supplied: under D9 this column means nothing, so 32
      // attacker-chosen bytes parked against an attacker-chosen id would be a small covert store
      // on someone else's relay and nothing else. See finding E2-203-4.
      wrapSalt: ctx.random(WRAP_SALT_LEN),
      epoch: space.currentEpoch,
      createdBy: member.id,
      expiresAt,
      usedAt: null,
      revokedAt: null,
    });
    return space.currentEpoch;
  });

  logOk(ctx, { route: 'createInvite', spaceId, deviceShort: auth.deviceShort, status: 200 });
  return {
    status: 200,
    body: {
      inviteId, spaceId, epoch, createdBy: member.id,
      expiresAt: expiresAt.toISOString(), serverTime: at,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/invites/redeem  — 15.3
// ─────────────────────────────────────────────────────────────────────────────

const REDEEM_FIELDS = ['inviteId', 'proof', 'colorRef', 'member', 'device'];

/**
 * Redeem an invite: prove knowledge of the code, publish the joiner's PUBLIC device keys, and
 * become a member. Returns no key material (D9).
 *
 * **The order of operations is the security of this endpoint.** Each step is placed where it is
 * because moving it breaks something concrete:
 *
 *  1. **shape first** — a malformed body must cost nothing and reach no store.
 *  2. **rate limit before the lookup** (10/IP/hour, ADR 003 §6.1) — so guessing an invite id
 *     costs budget rather than being free. `ctx.ip` absent means one shared bucket, never a
 *     fresh one — `limits.js`'s `clientIp` puts every unidentifiable caller in the shared `?`
 *     bucket rather than in a private one.
 *  3. **verify the proof before reporting anything about the invite's state** — otherwise an
 *     eavesdropper who saw an id on the wire, and who does not have the code, could poll for
 *     "has it been redeemed yet".
 *  4. **consume, then admit, in ONE transaction that rolls back on any failure** — so a colour
 *     collision or a duplicate id cannot burn the invite. 15.3 promises Mom is in "within a
 *     minute"; an invite silently consumed by a failed attempt would end that minute with a code
 *     that no longer works and an admin who has to mint another.
 *
 * @param {Object} req @param {Object} ctx @returns {Promise<Object>} ServerRes
 */
export async function redeemInvite(req, ctx) {
  const body = readObject(req.body, REDEEM_FIELDS, REDEEM_FIELDS, '');
  const inviteId = readId(body, 'inviteId', INVITE_ID_RE, '');
  const proof = readBytes(body, 'proof', '', { len: PROOF_LEN });
  const colorRef = readId(body, 'colorRef', COLOR_REF_RE, '');
  const member = readMemberKeys(body.member, 'member');
  const device = readDevice(body.device, 'device');
  const sha256 = digestOf(ctx);

  // ADR 003 §6.1 / ADR 002 §7.1 — 10 redemptions per IP per hour, through LZP-205's table so the
  // number, the window, the bucket key and the Retry-After are all stated in one place.
  //
  // INTEGRATION NOTE for LZP-207: `RATE_COVERAGE.redeemInvite` declares this rule `pre`, so
  // composing `withLimits(handlers)` on top of this handler would charge the budget TWICE and
  // halve it to five. limits.js's own INTEGRATION WARNING names the two valid compositions;
  // while this call is here, the correct one is (b) — `createRouter(withVersionGate(handlers))`,
  // no `withLimits`. The call is HERE rather than only in the wrapper because a composition
  // mistake at the router must not be able to ship an unlimited redemption endpoint.
  await enforceFor(req, ctx, 'inviteRedeem', null);

  // The bootstrap ladder: this request registers the very device it is signed by, so ADR 003 §2
  // step 4 has nothing to look up. Whatever the auth layer verified the signature against, the
  // device short it authenticated must be the one being registered — a caller cannot sign with
  // key A and register key B. It runs AFTER the limiter because `inviteRedeem` is declared
  // `pre-auth` and signature verification is the expensive half of the request.
  const auth = await requireSelfAuth(req, ctx, device.deviceShort);

  const at = ctx.now();
  const invite = await ctx.store.getInvite(inviteId);
  if (!invite) throw fail('invite_invalid');
  if (!bytesEqual(await sha256(proof), invite.verifier)) throw fail('invite_invalid');

  // Only now, to a caller who has demonstrably held the code, is the invite's state described.
  // `invite_used` rather than `invite_invalid` is the difference between "you were too late" and
  // "you typed it wrong", and 15.5's revocation story needs the first to be sayable.
  if (invite.usedAt !== null) throw fail('invite_used');
  if (invite.revokedAt !== null) throw fail('invite_invalid');
  if (invite.expiresAt.getTime() <= at) throw fail('invite_invalid');

  const spaceId = invite.spaceId;

  const out = await ctx.store.tx(async (tx) => {
    const space = await tx.getSpace(spaceId);
    if (!space) throw fail('invite_invalid');          // the circle was deleted (20.4) meanwhile

    // Everything below can throw, and every throw rolls the consumption back with it.
    if (!(await tx.consumeInvite(inviteId, at))) throw fail('invite_used');

    if (!(await tx.colorFree(spaceId, colorRef))) {
      // 15.3: no two members share a colour. The client picks another and retries — with the SAME
      // code, because the rollback put the invite back.
      throw fail('bad_request', { field: 'colorRef', reason: 'taken' });
    }
    const existing = await tx.listMembers(spaceId);
    if (existing.some((m) => m.id === member.memberId)) {
      throw fail('bad_request', { field: 'member.memberId', reason: 'exists' });
    }
    // ADR 003 §3.2's eight seats, enforced where the seat is taken. Inside the transaction and
    // after `consumeInvite`, so a full circle ROLLS THE CONSUMPTION BACK: the code still works
    // once somebody leaves, exactly as the colour-collision path does. Round 2, finding T5-M2 —
    // this bounds the sybil fleet; it does not close it, and `lifecycle.js#PROVES_NOT` says so.
    const live = existing.filter((m) => m.removedAt === null).length;
    if (live >= MAX_LIVE_MEMBERS) {
      throw fail('bad_request', { field: 'member.memberId', reason: 'space_full', live, max: MAX_LIVE_MEMBERS });
    }
    if (await tx.getDevice(device.deviceId)) throw fail('bad_request', { field: 'device.deviceId', reason: 'registered' });
    if (await tx.getDeviceByShort(spaceId, device.deviceShort)) {
      // Round 10 item 8, closing E2-203-1 where it hurt most: a Mac that already has a personal
      // space used to be unable to join a Familienkreis at all. The namespace is now the SPACE,
      // so this only refuses a short already registered IN THIS CIRCLE.
      throw fail('bad_request', { field: 'device.deviceShort', reason: 'registered' });
    }

    await tx.addMember({
      id: member.memberId,
      spaceId,
      colorRef,
      recoveryPubSig: member.recoveryPubSig,
      recoveryPubKex: member.recoveryPubKex,
      joinedAt: new Date(at),
      removedAt: null,
    });
    await tx.addDevice({
      id: device.deviceId,
      spaceId,
      memberId: member.memberId,
      deviceShort: device.deviceShort,
      sigPubRaw: device.sigPubRaw,
      kexPubRaw: device.kexPubRaw,
      attestation: device.attestation,
      lastSeenSeq: 0n,
      lastPushedSeq: 0n,
      addedAt: new Date(at),
      revokedAt: null,
    });

    // Computed, not asserted. It is 0 by construction today — nobody can have wrapped to a device
    // that did not exist a millisecond ago — and computing it means the client's waiting-state
    // screen is driven by the server's actual key-ring state rather than by a constant that would
    // survive a future change to this handler.
    const wraps = await tx.getKeyWraps(spaceId, device.deviceId);
    return {
      currentEpoch: space.currentEpoch,
      kind: space.kind,
      pendingKeys: wraps.length === 0,
      members: await memberProjection(tx, spaceId),
    };
  });

  logOk(ctx, { route: 'redeemInvite', spaceId, deviceShort: auth.deviceShort, status: 200 });
  return {
    status: 200,
    body: {
      spaceId,
      kind: out.kind,
      memberId: member.memberId,
      deviceId: device.deviceId,
      colorRef,
      currentEpoch: out.currentEpoch,
      // D9's designed waiting state, as a fact the UI can branch on: you are IN the circle, and
      // the entries appear by themselves when another member's Mac next syncs. Never an error.
      pendingKeys: out.pendingKeys,
      members: out.members,
      serverTime: at,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/invites/revoke  — 15.5
// ─────────────────────────────────────────────────────────────────────────────

const REVOKE_FIELDS = ['spaceId', 'inviteId'];

/**
 * Revoke an invite. Idempotent, and scoped to the space the caller belongs to.
 *
 * The `spaceId` is not decoration: without the cross-check a member of space A could revoke space
 * B's invites by id alone, because `getInvite` is keyed on the id and nothing else. `SPACE_SCOPED`
 * in router.js declares this route `body:spaceId`, so the membership check runs against the space
 * the CALLER named — which is only an authorization if the invite is then proved to live there.
 *
 * A revoked, used or unknown invite all answer 200: a caller who is a member of the space learns
 * nothing from the difference, and returning 404 for "unknown" would turn this into an id oracle
 * for anyone who has ever been a member.
 *
 * @param {Object} req @param {Object} ctx @returns {Promise<Object>} ServerRes
 */
export async function revokeInvite(req, ctx) {
  const body = readObject(req.body, REVOKE_FIELDS, REVOKE_FIELDS, '');
  const spaceId = readId(body, 'spaceId', SPACE_ID_RE, '');
  const inviteId = readId(body, 'inviteId', INVITE_ID_RE, '');

  const { auth } = await requireActiveMember(req, ctx, spaceId);

  const at = ctx.now();
  const state = await ctx.store.tx(async (tx) => {
    const inv = await tx.getInvite(inviteId);
    if (!inv || inv.spaceId !== spaceId) return 'unknown';
    if (inv.usedAt !== null) return 'used';
    if (inv.revokedAt !== null) return 'revoked';
    await tx.revokeInvite(inviteId, at);
    return 'revoked';
  });

  logOk(ctx, { route: 'revokeInvite', spaceId, deviceShort: auth.deviceShort, status: 200 });
  return { status: 200, body: { inviteId, spaceId, state, serverTime: at } };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/invites/open?spaceId=…
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The open invites of a space: un-redeemed, un-revoked, un-expired.
 *
 * ADR 003 §3 introduced this as "open invites needing a re-wrap" for ADR 002 §4.2 step 3. D9
 * removed the re-wrap — there is no key material on an invite to refresh — and `rotateEpoch`
 * moves the epoch pointer itself without asking the client for anything. What survives is 15.5's
 * invite management: the list a member sees before deciding what to revoke.
 *
 * It never returns the verifier. The verifier is `SHA-256(proof)`, and while that is not itself
 * redeemable, publishing it to every member would put the one value a database dump would want
 * onto an ordinary API response as well.
 *
 * @param {Object} req @param {Object} ctx @returns {Promise<Object>} ServerRes
 */
export async function openInvites(req, ctx) {
  const spaceId = readId(req.query || {}, 'spaceId', SPACE_ID_RE, 'query');
  const { auth } = await requireActiveMember(req, ctx, spaceId);

  const at = ctx.now();
  const rows = await ctx.store.listOpenInvites(spaceId);
  const invites = rows
    .filter((i) => i.spaceId === spaceId)
    .map((i) => ({
      inviteId: i.id,
      epoch: i.epoch,
      createdBy: i.createdBy,
      expiresAt: i.expiresAt instanceof Date ? i.expiresAt.toISOString() : null,
    }))
    .sort((a, b) => (a.inviteId < b.inviteId ? -1 : 1));

  logOk(ctx, { route: 'openInvites', spaceId, deviceShort: auth.deviceShort, status: 200 });
  return { status: 200, body: { spaceId, invites, serverTime: at } };
}

/**
 * Field names that may never appear anywhere in a response this file produces. Asserted by
 * `tests/server/invites.test.js` against the JSON of every 200 the suite provokes, because "the
 * invite carries no key material" is a property of the WIRE, not of the schema alone — a
 * handler could have joined the key table into a response without the store noticing.
 */
export const FORBIDDEN_RESPONSE_FIELDS = Object.freeze([
  'wrappedKeys', 'wrapped', 'wrapSalt', 'verifier', 'proof', 'code', 'attestation',
  'displayName', 'displayNameCipher', 'role',
]);

/** Unexported ids are unreachable from the router; this names what this file answers. */
export const INVITE_ROUTES = Object.freeze(['createInvite', 'redeemInvite', 'revokeInvite', 'openInvites']);
