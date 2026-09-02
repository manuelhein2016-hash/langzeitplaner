// tests/fleet/e9-attack-kit.js — THE RIG THE E9 CO-EDITOR ATTACKS ARE DRIVEN ON.
//
// Not a test file: it declares no `test()` and `tests/fleet/*.test.js` cannot see it. It is a
// THIN layer over `e6-attack-circle.js`, which already owns everything hard — the real relay
// (every handler, through `server/core/router.js`), the real transport (`platform/net.js`), the
// real engine (`sync/family.js#createFamilySync`), the real key delivery, the real crypto, and
// one `store.js` MODULE EVALUATION per Mac over its own `localStorage` image.
//
// WHAT THIS FILE ADDS, and why each piece is here rather than in a test:
//
//   `circle(names)`      founder + joins + attestations + one converged sync, in one call. Four
//                        of the five attack files need the same five-member-lifecycle preamble
//                        and a fifth copy of it is a fifth chance for one of them to be weaker.
//   `patchedOp`          THE ATTACKER'S CLIENT. A `pub.set` assembled by hand and sealed with a
//                        seal context of the attacker's choosing. This is what "a member running
//                        a modified client" MEANS in this product: `sealOp`'s barriers read
//                        `ctx.levelOf` / `ctx.adminOf` / `ctx.assertFamilyPatch`, and a patched
//                        build supplies whatever it likes. Nothing here forges a signature, a
//                        device, an attestation or a membership — the attacker is an INVITED,
//                        ATTESTED member throughout, which is exactly the threat D7 describes.
//   `honestOp`           the same shape with the shipped seal context. Used to establish that a
//                        row's finding is about AUTHORITY and not about the seal refusing.
//   `regsOf` / `cells`   one Mac's folded view of one entity, as plain data, so two Macs can be
//                        compared with `assert.deepEqual` instead of by narration.
//
// ⚠ THIS FILE DRIVES `store.applyCoEdit` FOR EVERY HONEST WRITE. The co-editor's write path
// landed at E9 integration and it is the thing under attack; a row that hand-built the honest
// case too would be measuring the harness.

import assert from 'node:assert/strict';

import { brandFamilyPatch } from '../../src/js/crypto/envelope.js';
import {
  buildCircle, join, refreshRoster, bootMac, engineFor, on,
  publishAttestation, pushOp,
} from './e6-attack-circle.js';

export {
  buildCircle, join, refreshRoster, bootMac, engineFor, on,
  publishAttestation, publishSharedEntry, pushOp, boardOf, snapDisk, restoreDisk,
} from './e6-attack-circle.js';

/** The founder: attest, claim the genesis admin seat, push. */
export async function found(C) {
  await bootMac(C, C.papa);
  await on(C.papa, async () => {
    assert.equal(C.papa.store.apply('attestMyDevice', {
      deviceShort: C.papa.forStore.deviceShort, blob: C.papa.myBlob,
    }), true);
    assert.equal(C.papa.store.apply('claimAdmin', {}), true);
    C.papa.engine = engineFor(C, C.papa);
    assert.equal((await C.papa.engine.pushNow()).pushed, 2);
  });
}

/** One joined member: boot, sync, publish their own `member.set{dev.*}` into the family log. */
export async function bring(C, mac) {
  await bootMac(C, mac);
  await on(mac, async () => {
    mac.engine = engineFor(C, mac);
    await mac.engine.syncNow();
    await publishAttestation(C, mac);
  });
}

/**
 * A real Familienkreis, converged. `names[0]` founds it and holds the genesis admin seat.
 * @param {string[]} names any of papa · mama · oma · eve · mallory (each has a distinct colour)
 */
export async function circle(names) {
  const C = await buildCircle(names);
  await refreshRoster(C);
  await found(C);
  for (const n of names.slice(1)) {
    assert.equal((await join(C, C[n])).status, 200, `join ${n}`);
  }
  await refreshRoster(C);
  await on(C.papa, () => C.papa.engine.syncNow());
  for (const n of names.slice(1)) await bring(C, C[n]);
  await refreshRoster(C);
  for (const n of names) await on(C[n], () => C[n].engine.syncNow());
  return C;
}

/** Every Mac in `macs` pulls and pushes once. */
export async function converge(C, macs) {
  for (const m of macs) await on(m, () => m.engine.syncNow());
}

const kindOfKey = (e) => e.slice(0, e.indexOf(':'));

/**
 * A `pub.set` minted on `mac`'s own store ctx — real opId, real HLC stamp, real device, real
 * act. Only the PATCH is the caller's. `level` is what the brand declares, which barrier 4 then
 * checks against whatever `seal.levelOf` answers.
 */
export function mkPubSet(C, mac, e, f, level = 'geteilt') {
  const ctx = mac.store._ctx();
  return Object.freeze({
    v: 1,
    id: ctx.newOpId(),
    ts: ctx.mint(),
    space: C.spaceId,
    act: mac.forStore.memberId,
    dev: mac.forStore.deviceId,
    gid: ctx.gid,
    k: 'pub.set',
    e,
    f: brandFamilyPatch({ ...f }, { kind: kindOfKey(e), level }),
  });
}

/**
 * THE ATTACKER'S CLIENT: seal with a chosen context and POST. `seal.levelOf` / `seal.adminOf` /
 * `seal.assertFamilyPatch` are the four author-side barriers' only inputs, so overriding them is
 * precisely "I patched my own build". The signature, the device and the space key are real.
 */
export async function patchedOp(C, mac, op, seal = {}) {
  return pushOp(C, mac, op, {
    levelOf: () => 'geteilt', assertFamilyPatch: () => {}, ...seal,
  });
}

/** The same, sealed the way the shipping engine seals: the store answers the level. */
export async function honestOp(C, mac, op) {
  return pushOp(C, mac, op, {
    levelOf: (k) => mac.store.familyLevelOf(k),
  });
}

/** One entity's folded registers on one Mac, as plain `{field: value}`. */
export async function regsOf(mac, key) {
  let out = null;
  await on(mac, () => {
    const c = mac.store.registers().get(key);
    out = c === undefined ? null
      : Object.fromEntries([...c.entries()].map(([f, cell]) => [f, cell.value]));
  });
  return out;
}

/** One field's whole register cell (value + stamp + author), for the LWW rows. */
export async function cellOf(mac, key, field) {
  let out = null;
  await on(mac, () => {
    const c = mac.store.registers().get(key);
    const cell = c && c.get(field);
    out = cell ? { value: cell.value, stamp: cell.stamp, author: cell.author } : null;
  });
  return out;
}

/** Every op this Mac holds for one entity, parked ones included. */
export async function opsOn(mac, key) {
  let out = [];
  await on(mac, () => {
    out = [...mac.store._log.ops({ includeParked: true })]
      .filter((o) => o.e === key)
      .map((o) => ({ k: o.k, act: o.act, ts: o.ts, f: Object.keys(o.f).sort() }));
  });
  return out;
}

/** The reasons this Mac has parked anything under. */
export async function parkedOn(mac) {
  let out = [];
  await on(mac, () => {
    out = [...mac.store._log.parkedOps()].map((e) => e.reason);
  });
  return out;
}
