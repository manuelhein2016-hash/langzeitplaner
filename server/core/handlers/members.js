// server/core/handlers/members.js — the member list (15.4) and the projection every other
// endpoint publishes it through. LZP-203.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ONE THING THIS FILE MUST NEVER DO
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Story 15.4 is *"all members see the member list (name, colour, initial), so everyone knows
// who's in the circle"* — and the name in it never passes through here. ADR 003 §5.1 is explicit:
//
//   > NOTE: no displayNameCipher and no role column. Display names travel as `member.set` ops
//   > inside the encrypted stream.
//
// The addendum §3 sketch had a `displayNameCipher` column; ADR 002 reduced it further, to nothing
// at all. So the wire shape here carries pseudonymous ids, one palette index, public keys and two
// timestamps — and the client joins it against the `member:` records it decrypts out of the op
// log to produce the list a human reads. `MODEL_COLUMNS` makes storing a name impossible
// (store-interface.js RULE 1); `readObject` in spaces.js makes accepting one a 400; and
// `memberProjection` below makes emitting one impossible, because it builds a fresh object out of
// a fixed field list instead of copying a row.
//
// That last one matters more than it looks. `return { members: rows }` would be correct today and
// would silently start publishing whatever column the schema grows next. The projection is
// written as an allow-list for the same reason `MODEL_COLUMNS` is closed.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY `recoveryPubKex` IS ON THE WIRE  (finding E3-2)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ADR 002 §4.2 step 2 makes a rotation wrap the new key to every device "plus each member's
// RK_kex". E3 found that no wire field carried another member's RK_kex, so that clause was
// unimplementable; E2's skeleton added `Member.recoveryPubKex` to the schema and left the wire
// field to this ticket. Here it is. Without it the coverage check in spaces.js would demand a
// wrap for `rec_<memberId>` that the rotating client has no public key to build.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY `attestation` IS ON THE WIRE  (finding E2E3-6 — this reverses a decision, deliberately)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PARAGRAPH THAT STOOD HERE SAID THE OPPOSITE, and it was right about the danger and wrong
// about the conclusion. It read:
//
//   > The attestation is deliberately NOT published. ADR 002 §2.3 puts it inside the E2EE stream,
//   > and its whole point is that "a malicious relay cannot fabricate a device row for an existing
//   > member" — a client that verified the relay's copy instead of the log's would hand that
//   > property back. The relay's device rows are a hint about who to wrap to; the log is the
//   > authority.
//
// Every sentence of that is still true. What it missed is that `src/js/crypto/spacekeys.js`'s
// `familyRecipients()` — the ONLY constructor of the branded recipient/sender set that ADR 002
// §3 barrier 2 and §4.2 step 6 are built out of — THROWS on a device with no attestation blob.
// So the roster this endpoint serves could not be turned into a recipient set, family key
// rotation could not be built over this API by anybody, and the two positions together were "a
// rotation nobody can build".
//
// ── THE 21.1 COST, MEASURED RATHER THAN ARGUED: NIL. ────────────────────────────────────────
// The blob is a SIGNED payload, not ciphertext, and every field inside it is already a column
// the relay holds and already publishes: `memberId` → `Device.memberId`, `deviceId` →
// `Device.id`, `deviceShort`, `sigPubRaw`, `kexPubRaw`, and `createdAt` — a DAY, coarser than
// the `addedAt` timestamp the relay keeps to the millisecond. The relay already STORES the blob
// (`Device.attestation`, an opaque column since E2). And every member can already read the same
// blob out of the E2EE stream: ADR 002 §2.3 says so in as many words — "the blob is inside the
// E2EE stream, so every member can read it". Publishing it to members of the same space
// therefore tells the relay nothing it did not know and tells a member nothing they could not
// fold for themselves. It is not a metadata reduction and it is not a metadata increase.
//
// ── WHAT KEEPS "THE LOG IS THE AUTHORITY" TRUE ──────────────────────────────────────────────
// The blob is published as a HINT and is never authority for anything, because the only code
// that reads it verifies it first: `recipientProblem()` re-checks the signature under the
// HOUSING member's `recoveryPubSig`, re-checks P2, and binds `att.kexPubRaw` to the very key the
// wrap would be addressed to. A relay that fabricates a blob fails that signature. A relay that
// fabricates a blob AND a recovery key has invented a whole MEMBER, which surfaces in this very
// list as somebody nobody invited — ADR 002 §8.5's already-accepted, UI-surfaceable phantom
// member, and precisely the residual §4.2 step 6 states for the bootstrap.
//
// The distinction ADR 002 §2.3 already draws is the one that resolves this: what the relay's
// device rows support is KEY DISTRIBUTION, not ADMISSIBILITY. Admissibility is still the log's,
// still the fold's, and nothing here changes stage 0b. And this is the roster ADR 002 §4.2 step
// 6 already specified — "its roster must come from relay coordination data
// (`MemberRowDb.recoveryPubSig` plus the `dev.*` blobs)". This file was out of step with its own
// ADR rather than with a preference.
//
// ── WHERE IT IS NOT PUBLISHED, AND THAT IS STILL DELIBERATE ─────────────────────────────────
// Not on `GET /ops`. That projection is re-derived in `ops.js` and stays four device fields; see
// the note on `memberProjection` below for why the two shapes are different on purpose. The
// rotation roster is a cold path (a membership change); the pull piggyback runs every 45 seconds
// for every device in every space.
//
// PURITY (ADR 003 §9). Clock through `ctx.now()`, storage through `ctx.store`, nothing ambient.

import { fail } from '../errors.js';
import {
  SPACE_ID_RE, bytesToB64u, readId, requireActiveMember, logOk,
} from './spaces.js';

/**
 * The device fields a member list publishes. An allow-list, not an omission list.
 *
 * `deviceId` is here because it is the address a `KeyWrap` is written to (`recipientId`), so a
 * rotating client cannot build its wrap set without it. ADR 002 §2.3's warning — *"nothing may
 * key on a bare deviceId"* — is about the in-log attestation fold, where a `deviceId` is an
 * unbound label a peer can copy. Server-side it is a primary key the relay assigned once and
 * enforces, which is a different object with the same name; the identity that decides anything
 * remains the pair (member record, `deviceShort`).
 */
export const DEVICE_PROJECTION = Object.freeze(['deviceId', 'deviceShort', 'sigPubRaw', 'kexPubRaw', 'attestation', 'revokedAt']);

/** The member fields a member list publishes. */
export const MEMBER_PROJECTION = Object.freeze([
  'memberId', 'colorRef', 'recoveryPubSig', 'recoveryPubKex', 'joinedAt', 'removedAt', 'devices',
]);

/** @param {Date|null|undefined} d @returns {string|null} */
const iso = (d) => (d instanceof Date ? d.toISOString() : null);

/**
 * Build the member list for one space, exactly as ADR 003 §3.2 piggybacks it on every pull.
 *
 * Exported because the endpoints that publish the FULL member record must publish one shape or
 * the client ends up with two parsers: `GET /spaces/:id/members` (15.4) and the response to a
 * redemption, which is how a joiner learns who is already in the circle before she can decrypt
 * anything.
 *
 * ── `GET /ops` DELIBERATELY DOES NOT USE THIS, and the reason is not laziness ────────────────
 * This file originally asked LZP-202 to import `memberProjection` into `pullOps` rather than
 * re-derive it. At integration (LZP-207) that request was REVERSED, because the two shapes are
 * different on purpose and ADR 003 §3.2 is the one that says so:
 *
 *   · §3.2's pull piggyback carries FOUR device fields — `deviceShort`, `sigPubRaw`, `kexPubRaw`,
 *     `revokedAt` — and no `deviceId`, and no `recoveryPubSig` / `recoveryPubKex` on the member.
 *     `tests/server/ops.test.js` asserts `recoveryPubSig` never appears in a pull response.
 *   · This projection carries `deviceId` (the `KeyWrap.recipientId` a rotating client must
 *     address) and both recovery public keys (`recoveryPubKex` is how finding E3-2 is closed on
 *     the wire — §4.2 step 2 wraps to each member's RK_kex and the client cannot without it).
 *
 * Pull runs every 45 seconds for every device in every space; the member list rides on all of
 * them (ADR 003 §10 weakness 5 already calls that ~2 KB a known cost). Widening it to carry two
 * 65-byte recovery keys per member — data that changes at most once in a member's lifetime —
 * would grow the hot path to serve the cold one. Converging the shapes would mean either
 * publishing recovery keys on every pull or dropping them from the rotation path; the first is
 * waste and the second is a bug. So there are two projections, and this comment is the reason.
 *
 * `tests/server/blindness.test.js` asserts the difference is still exactly that — every field in
 * either projection is on the same justified allowlist — so "two shapes" cannot quietly become
 * "one of them leaks something".
 *
 * Removed members are INCLUDED, with `removedAt` set. The projection rule (ADR 001 §5 step 3)
 * needs the historical member set to resolve ops written before a removal; dropping them would
 * make every op a departed member ever wrote unattributable.
 *
 * @param {Object} store a SyncStore or transaction handle
 * @param {string} spaceId
 * @returns {Promise<Array<Object>>}
 */
export async function memberProjection(store, spaceId) {
  const members = await store.listMembers(spaceId);
  const devices = await store.listDevices(spaceId);
  const byMember = new Map();
  for (const d of devices) {
    if (!byMember.has(d.memberId)) byMember.set(d.memberId, []);
    byMember.get(d.memberId).push({
      deviceId: d.id,
      deviceShort: d.deviceShort,
      sigPubRaw: bytesToB64u(d.sigPubRaw),
      kexPubRaw: bytesToB64u(d.kexPubRaw),
      // The blob string, byte for byte as it was signed. `readDevice`/`verifyDeviceClaim` admit
      // only base64url-dot-base64url on every write path (finding E2E3-7), so the column is
      // always ASCII and this round-trips exactly — which it must, because the client verifies a
      // signature over these bytes and a re-encoding would fail every one of them.
      attestation: new TextDecoder().decode(d.attestation),
      revokedAt: iso(d.revokedAt),
    });
  }
  const out = [];
  for (const m of members) {
    const list = (byMember.get(m.id) || []).sort((a, b) => (a.deviceShort < b.deviceShort ? -1 : 1));
    out.push({
      memberId: m.id,
      colorRef: m.colorRef,
      recoveryPubSig: bytesToB64u(m.recoveryPubSig),
      recoveryPubKex: bytesToB64u(m.recoveryPubKex),
      joinedAt: iso(m.joinedAt),
      removedAt: iso(m.removedAt),
      devices: list,
    });
  }
  // Sorted by member id so two devices comparing lists compare byte-identical documents, and so
  // the order carries no information about join order beyond what `joinedAt` already states.
  out.sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/spaces/:id/members  — 15.4
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The member list. Members only: `requireActiveMember` answers `403 not_a_member` for a stranger,
 * for a removed member, and for a space that does not exist — the three are indistinguishable on
 * purpose, so the endpoint cannot be used to test whether a space id is real.
 *
 * @param {Object} req @param {Object} ctx @returns {Promise<Object>} ServerRes
 */
export async function listMembers(req, ctx) {
  const spaceId = readId(req.params || {}, 'id', SPACE_ID_RE, 'params');
  const { auth } = await requireActiveMember(req, ctx, spaceId);

  const at = ctx.now();
  const { members, currentEpoch } = await ctx.store.tx(async (tx) => {
    const space = await tx.getSpace(spaceId);
    if (!space) throw fail('not_a_member');
    return { members: await memberProjection(tx, spaceId), currentEpoch: space.currentEpoch };
  });

  logOk(ctx, { route: 'listMembers', spaceId, deviceShort: auth.deviceShort, status: 200 });
  return { status: 200, body: { spaceId, currentEpoch, members, serverTime: at } };
}

// ─────────────────────────────────────────────────────────────────────────────
// What is NOT here, and why — 15.6, 20.1, 20.2, 20.3
// ─────────────────────────────────────────────────────────────────────────────
//
// ── STATUS AT INTEGRATION (LZP-207): these three now EXIST, in `handlers/lifecycle.js`. ──────
// LZP-204 shipped `removeMember`, `leaveSpace` and `transferAdmin` after this section was
// written, and `handlers/index.js` binds them. The reasoning below is NOT stale — it is the
// reasoning LZP-204 had to answer, and the answer it gave is a bounded blast radius rather than
// an authorization: `removeMember` is any-current-member, and it is budgeted at 10 per member
// per hour (RATE_RULES.memberRemove, LIMIT_EXTENSIONS E2-L6) precisely because the "admin-only"
// premise is the one thing this server structurally cannot check. That is a mitigation, not a
// fix; finding E2-203-2 / E2-L1 stays open until an admin proof exists on the wire, and the
// paragraph below is what it is open about. `renameSpace` and `deleteSpace` also exist there.
//
// The original reasoning, unchanged:
//
// `POST /members/remove` (20.1/20.2), `POST /members/leave` (20.3) and `POST /members/transfer`
// (20.1) were deliberately left to a ticket that could carry the decision they need. Two
// reasons, both recorded as `HANDLER_FINDINGS` in spaces.js:
//
//   · **Removal cannot be authorized** (E2-203-2). ADR 003 §5.1 removed the role column on
//     purpose and `FORBIDDEN_COLUMN_TOKENS` forbids adding one, so the server cannot tell an
//     admin from any other member. `/members/remove` purges the target's `Op` rows in the same
//     transaction (§6.3) — that is the one irreversible action in the API, and shipping it with
//     "any member may call it" makes every member able to delete every other member's history.
//     ADR 003 §6.3 rejects exactly this shape: *"an endpoint that lets any member delete another
//     member's ops from the relay is a censorship primitive"*. `/members/leave` is the same
//     purge with the caller as its own target and is safe to authorize, but it is one half of a
//     pair that should land together with 20.2's rotation obligation.
//   · **`/members/transfer` "mirrors the in-log admin chain; never authoritative"** (ADR 003 §3),
//     and the column it would mirror into does not exist. It is a no-op waiting for a purpose.
//
// 15.6's colour change has no route and no store method at all — finding E2-203-3. It is not
// implementable from inside a handler file, and inventing `POST /members/color` here would put a
// route in one file and its handler in another.
