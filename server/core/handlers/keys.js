// server/core/handlers/keys.js — key-wrap delivery.  LZP-204.
//
// ADR 003 §3 (`GET /spaces/:id/keys`), ADR 002 §4.3 (the join/removal asymmetry), §4.4 (epoch
// skipping and parked ops), §7.1 step 5 (D9 — the wrap covers all epochs 1..e), §7.3 step 6
// (A2 recovery's waiting state), stories 15.3, 19.6, 21.1.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ `rotateEpoch` AND THE COVERAGE CHECK ARE **NOT** HERE. THEY ARE IN `handlers/spaces.js`.
// ─────────────────────────────────────────────────────────────────────────────────────────────
// This pass built the coverage check (ADR 002 §4.2 — "the server rejects an epoch bump whose
// wraps do not cover every current, non-revoked device of every non-removed member") and then
// found that LZP-203 had built it too, in `server/core/handlers/spaces.js`, where the LZP-201
// skeleton had said it would live. Two implementations of one route name is a defect on its own:
// `createRouter` keys the registry by name and a spread would pick a winner silently.
//
// So this file WITHDRAWS its version rather than shipping a second one. `spaces.js` owns
// `rotateEpoch`, `requiredRecipients`, `staleRecipients` and `assertCoverage`; its own suite
// attacks them. What was checked before withdrawing, because "the other pass has it" is not a
// verification:
//
//   · coverage is asserted BEFORE `claimEpoch` (`spaces.js:800` — "Claimed AFTER the coverage
//     check"), which is the ordering that matters: claiming first would let one malformed
//     request burn `e+1` and lock every honest rotator out of it — the control handing the
//     attacker a one-request denial of service;
//   · `Member.recoveryPubKex` is read and `rec_<memberId>` recipients are required, so finding
//     E3-2's column is actually used;
//   · wraps are demanded for epochs `1..e`, not only for `e+1` — the stronger reading of §7.1
//     step 5, and the one that keeps Oma's birthday readable for a joiner (§4.3, A4).
//
// What remains here is the DELIVERY half, which nothing else implements: the endpoint a device
// calls to collect the wraps addressed to it. `RECOVERY_PREFIX` is re-stated because
// `lifecycle.js` needs it to purge a removed member's recovery recipient and importing it across
// ticket boundaries would couple two passes' files for one string.

import { fail } from '../errors.js';
import { bytesToB64u, requireId } from './devices.js';

/**
 * The reserved recipient form for a member's recovery key (finding E3-4; `KeyWrap.recipientId` is
 * not a foreign key onto `Device` precisely so this can exist). Mirrors `recoveryRecipientId` in
 * `src/js/crypto/spacekeys.js` and `recoveryRecipient` in `handlers/spaces.js` — one string, three
 * places, and the contract case `C35` in `store-interface.js` pins that the store accepts it.
 */
export const RECOVERY_PREFIX = 'rec_';

/** @param {string} memberId @returns {string} */
export const recoveryRecipientId = (memberId) => RECOVERY_PREFIX + memberId;

/**
 * `GET /api/v1/spaces/:id/keys` — every wrap addressed to this device, ALL epochs.
 *
 * **"All epochs" is not a convenience.** ADR 002 §4.4: a member offline across three rotations
 * needs every epoch key spanning ops they have not read, and §4.3: a joining member is granted
 * epochs `1..e+1` so that Oma's birthday, entered in epoch 1, renders (17.1, A4, risk R11). A
 * handler that returned only the current epoch would be the bug §7.1 step 5 names in as many
 * words — "a wrap that covers only the current epoch is a bug".
 *
 * It also returns the caller's **recovery** wraps (`rec_<memberId>`). That is the delivery path
 * for A2: a device adopted from a backup file holds `RK_kex` and nothing else, so the wraps it
 * can open are exactly the ones addressed to its member's recovery key. They are ciphertext to
 * everyone else, including to the relay, so handing them to a device of that same member adds no
 * reader — and withholding them would make §7.3 ("the only path that survives losing every
 * device") depend on a rotation that has not happened yet.
 *
 * **No rate limiter, deliberately.** `RATE_COVERAGE.fetchKeys` in `server/core/limits.js` reasons
 * that this route is "read-only, space-scoped, bounded by the wrap count" and reachable only
 * after the whole ADR 003 §2 chain. Adding an undeclared second bucket here would put §6.1's
 * policy in two files that could disagree; LZP-205 owns that table.
 *
 * @type {(req:Object, ctx:Object) => Promise<Object>}
 */
export async function fetchKeys(req, ctx) {
  const auth = await ctx.auth(req);
  const spaceId = requireId(req.params || {}, 'id');
  await ctx.assertMember(auth.memberId, spaceId);

  const space = await ctx.store.getSpace(spaceId);
  // An unknown space and a space the caller is not in are one answer, so a probe learns nothing.
  if (!space) throw fail('not_a_member');

  const forDevice = await ctx.store.getKeyWraps(spaceId, auth.deviceId);
  const forRecovery = await ctx.store.getKeyWraps(spaceId, recoveryRecipientId(auth.memberId));

  // ─────────────────────────────────────────────────────────────────────────────────────────
  // `senderKexPubRaw` — ADR 002 §4.2 step 6's field, published by JOIN.  Finding E2E3-3.
  // ─────────────────────────────────────────────────────────────────────────────────────────
  // Step 6 makes the receiving device verify WHO SENT a wrap before it derives a KEK against it,
  // and E3 shipped that as a required `ctx.senders` on `admitWraps`, indexed by this field.
  // Nothing on the wire carried it, so `admitWraps` threw on every honest row and §4.2 was
  // unimplementable end to end.
  //
  // The relay stores the sender as a DEVICE ID it stamped itself (`KeyWrap.senderDeviceId`,
  // never a body field) and publishes it here as the ADR's `senderKexPubRaw`, joined from the
  // `Device.kexPubRaw` it already holds and already publishes in the member list. The client
  // side and the ADR wording are therefore both unchanged, and the column carries no
  // client-chosen bits.
  //
  // `null` when the sender's device row is gone — a member removal cascades its devices away
  // while their deposits are still being purged. `SenderSet.lookup(null)` answers `null`, which
  // `admitWraps` counts as `unauthorized`, which is the RIGHT answer: a key deposited by a
  // device this space no longer admits must not be admitted (§4.2 step 6's table). The rotation
  // that follows the removal re-deposits epochs 1..e+1 under a live sender, so this heals.
  //
  // A relay that lies here can cause a refusal and never an admission: the bytes only SELECT
  // among keys the receiver imported from verified attestations (spacekeys.js §6b).
  const kexBySender = new Map();
  for (const d of await ctx.store.listDevices(spaceId)) kexBySender.set(d.id, d.kexPubRaw);

  const wraps = [...forDevice, ...forRecovery]
    .sort((a, b) => a.epoch - b.epoch || (a.recipientId < b.recipientId ? -1 : 1))
    .map((w) => ({
      epoch: w.epoch,
      recipientId: w.recipientId,
      wrapped: bytesToB64u(w.wrapped),
      senderKexPubRaw: kexBySender.has(w.senderDeviceId) ? bytesToB64u(kexBySender.get(w.senderDeviceId)) : null,
    }));

  if (typeof ctx.log === 'function') {
    ctx.log({ route: req.routeName, spaceId, deviceShort: auth.deviceShort, opCount: wraps.length, status: 200 });
  }

  return {
    status: 200,
    body: {
      spaceId,
      currentEpoch: space.currentEpoch,
      wraps,
      // ADR 002 §7.1 step 6 / §7.3 step 6 — the DESIGNED waiting state, not an error. Answered
      // from a count, which is all the relay can do and all it needs to: it never opens a wrap.
      // The client renders 19.3's `pending`, never `error`, and never a spinner on the board.
      keysPending: wraps.length === 0,
      serverTime: ctx.now(),
    },
  };
}

/** The slice of the handler registry this file owns. `rotateEpoch` belongs to `spaces.js`. */
export const handlers = Object.freeze({ fetchKeys });
