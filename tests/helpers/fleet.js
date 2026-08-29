// tests/helpers/fleet.js — A SIMULATED FLEET OF REAL DEVICES.  LZP-505 · M1 "Zwei Macs".
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE SENTENCE THIS FILE EXISTS TO MAKE TRUE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// FINDINGS **A3-H4**, verbatim:
//
//   > "Any fleet test that mints its ops with the receiving store's own `_me` is a FALSE GREEN."
//
// So `createFleet()` calls `assertDistinctIdentities()` before it returns, and that gate THROWS
// unless every device holds a key store of its own, a P-256 signing pair of its own, a `deviceId`
// of its own, a `deviceShort` that really is `crock32(SHA-256(its own sigPubRaw)[0..10])`, and a
// `store.js` module evaluation of its own. A fleet that would prove nothing refuses to exist.
// `tests/tier1/sync-convergence.test.js` §0 drives the mutants at that gate and asserts it goes
// red for each of them, because a gate nobody has seen fail is a comment.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS REAL — the list is short because almost everything is
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   THE CLIENT     `src/js/store.js`, one full module evaluation per device (a distinct `?fleet=`
//                  specifier), each with its OWN `localStorage` — a real per-device disk, swapped
//                  under `storage.js`'s feet, because `storage.js` reads the bare global at CALL
//                  time and never captures it. Every device therefore has its own `board.json`,
//                  `ops.jsonl`, `checkpoint` and `snapshots`, and a quarantine on one Mac is
//                  invisible to the other.
//   THE ENGINE     `src/js/sync/personal.js`'s `createPersonalSync` — LZP-502's shipped engine,
//                  not a re-implementation. `push()`/`pull()`/`sync()` below are that object's
//                  methods, so the outbox definition, the `accepted` ≡ `duplicate` rule, F-6's
//                  deferral ladder and ADR 006 §9.1's W1 ordering are the product's and not the
//                  harness's.
//   THE IDENTITY   `src/js/platform/device-identity.js` over `src/js/platform/keystore.js`.
//   THE PAIRING    `src/js/crypto/pairing.js`, driven through `tests/helpers/mitm.js`'s
//                  `honestRelay` and `drivePairing` — E3's own adversary harness, reused rather
//                  than reinvented — and finished with the shipped `adoptPairedDevice`. The
//                  second Mac really does mint its own device keys, really does confirm a SAS,
//                  and really does receive `RK_sig` and the personal key ring over that channel.
//   THE CRYPTO     `sealOp`/`openOp`, unmodified, inside the engine. The epoch key really is
//                  ECDH-wrapped per recipient, so the relay's ADR 002 §4.2 coverage check runs
//                  against real bytes.
//   THE SERVER     all 23 handlers over `server/adapters/memory.js`, through `router.js`, reached
//                  by `tests/helpers/loopback.js` with only the socket replaced.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS STOOD IN FOR, NAMED SO NOTHING DOWNSTREAM BELIEVES OTHERWISE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// S-1 · **THE ATTESTATION HOP HAS NO WIRE AT M1.** `openOp` resolves a sender's signing key from
//       a VERIFIED `DeviceAttestation`, and there are exactly three places one could come from:
//         (a) THE LOG — `authz.js`'s `attestationOf`, folded from `member.set{dev.*}` registers.
//             `member.set` is a FAMILY-space op kind (`core/ops.js` `OP_KINDS`) and `spaceFor()`
//             throws without an `fsp_…` id, so **a person with two Macs and no Familienkreis has
//             nowhere in the log to record one.** This is E5's open seam, seen from the function
//             that needs it.
//         (b) THE RELAY — refused on purpose. `handlers/members.js`: "the relay's device rows are
//             a hint about who to wrap to; the log is the authority", and ADR 003 §3.2's pull
//             piggyback carries no `deviceId` either, so `deviceSetFor()` cannot be fed from a
//             pull. E2 recorded this as finding E2-207-B.
//         (c) PAIRING — which is what is left, and what this file uses. Each Mac self-attests
//             locally (FINDINGS §4.5 option (a): a `dev.*` register is a credential only if the
//             op that wrote it was stamped by the device it attests) and the blobs travel the
//             pairing channel with `RK_sig`. `fleet.attestations` is that source and is handed to
//             the engine as its `attestationOf` port, exactly as `AuthzResult.attestationOf`
//             would be.
//       (c) is CORRECT for M1 — ADR 002 §2.3 says "the pairing flow, not the fold, has to deliver
//       a first attestation. Owner: WP-9" — and it stops being sufficient the moment a third
//       party exists. Reported, not papered over.
//
// E5-1 · **TWO MACS MIGRATING THE SAME `board.json` COLLIDE ON `409 forked_op_id`, FOR EVER.**
//       Found by this harness on the first push of any fleet, and reproduced in
//       `tests/fleet/fleet-harness.test.js` §E5-1. The chain is three facts that are each correct
//       on their own:
//         1. ADR 001 §8.1 — a migration op's id is `deriveOpId(index, kind, key)`, a PURE function
//            of `board.json`. Two Macs over the same file mint the SAME opIds. That is deliberate.
//         2. `store.js:init` — `_buildSpine(board, {restamp: !!binding || _personalSpaceId !== null})`.
//            A store that has adopted a personal space re-stamps the whole spine at `now`, because
//            ADR 001 §8.1's all-zeros device short and ADR 002 §5.2.2 check 4 cannot both hold for
//            an op that has to be SEALED. So the two Macs' BYTES differ.
//         3. `server/core/handlers/ops.js` — the same `oid` with different bytes is
//            `409 forked_op_id`, and `sync/personal.js` quarantines the batch and says so.
//       Same ids + different bytes = a permanent 409. MEASURED COST at M1, precisely:
//         · the boards still CONVERGE — later edits sync in both directions and `board.json` stays
//           byte-identical, because the two spines describe the same entities with the same values;
//         · but the second Mac sits at `sync.status().state === 'error'`, `errorKind:'quarantine'`
//           with a permanently stuck outbox line, on a perfectly healthy pair of Macs. Story 19.3
//           says that state opens the Familie settings with a plain sentence — on day one, for
//           every M1 user;
//         · and the two Macs' REGISTER STAMPS for every migrated cell differ (values agree, so the
//           projection agrees). Benign while the board is personal-only; ADR 004 §4.3 makes those
//           decorations load-bearing the moment a family space exists.
//       The fix is not to weaken check 4 (FINDINGS §4.5 forbids it) and not to re-stamp harder.
//       See the report; `dev.genesisQuarantine()` / `dev.realQuarantine()` split the noise from
//       the signal so every other test in this suite can assert `realQuarantine()` is empty.
//
// S-2 · **THE SECOND MAC'S KEY RING COMES FROM PAIRING, NOT FROM `GET /spaces/:id/keys`.** That
//       matches ADR 002 §6.3, and it leaves §4.1's `rotateRequired` — "a new own device rotates
//       the PERSONAL space" — undischarged. `fleet.owed` records it so a fleet test cannot
//       mistake "we never rotated" for "rotation works".

import { memKeyStore } from '../../src/js/platform/keystore.js';
import { openDeviceIdentity, selfAttest, buildAttestOpen } from '../../src/js/platform/device-identity.js';
import {
  exportRawPublic, importKexPublic, deviceShortOf, signBytes,
  ensureDeviceIdentity, ensureRecoveryIdentity,
} from '../../src/js/crypto/identity.js';
import { createSpaceKey, createKeyRing, wrapSpaceKey } from '../../src/js/crypto/spacekeys.js';
import { createPairingSession, adoptPairedDevice } from '../../src/js/crypto/pairing.js';
import { createPersonalSync, createPersonalPublisher } from '../../src/js/sync/personal.js';
import { spaceId as mkSpaceId } from '../../src/js/core/ids.js';
import { b64u, ub64 } from '../../src/js/core/b64.js';
import { serializeRegisters } from '../../src/js/core/registers.js';

import { honestRelay, drivePairing } from './mitm.js';
import {
  createRelay, createWire, deviceTransport, simClock, MUTATORS, chainMutators,
  ORIGIN, MINUTE, HOUR, DAY, WEEK,
} from './loopback.js';

export {
  createRelay, createWire, deviceTransport, simClock, MUTATORS, chainMutators,
  ORIGIN, MINUTE, HOUR, DAY, WEEK,
};

const TE = new TextEncoder();

/** A wrap blob is `{v,salt,iv,ct}`; `KeyWrap.wrapped` is opaque BYTES (server/dev/two-client.js). */
const packWrap = (blob) => b64u(TE.encode(JSON.stringify(blob)));

/** Distinct module specifiers, so two fleets in one file are two sets of stores. */
let FLEET_SEQ = 0;

// ─────────────────────────────────────────────────────────────────────────────
// 1. A per-device disk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `storage.js` reaches for the bare `localStorage` global at CALL time, so swapping the global is
 * a faithful model of "a different Mac's disk". Everything `storage.js` writes —
 * `langzeitplaner.board`, `.ops`, `.checkpoint`, `.snapshots`, and the quarantine slots — lands
 * in exactly one of these.
 */
export function createDisk(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    _keys() { return [...map.keys()].sort(); },
    _snapshot() { return Object.fromEntries(map); },
  };
}

let MOUNTED = null;

/**
 * Mount one device's disk for the duration of `fn`.
 *
 * Re-entrancy is a THROW, never a stack. Two devices' storage interleaved would be the most
 * confusing bug this harness could have — a board written to the wrong Mac — and it would present
 * as a convergence failure. So it is made structurally impossible instead of avoided by
 * convention.
 */
async function mounted(disk, fn) {
  if (MOUNTED) throw new Error('fleet: a device disk is already mounted; devices are driven one at a time');
  MOUNTED = disk;
  const prevGlobal = globalThis.localStorage;
  const prevWindow = globalThis.window ? globalThis.window.localStorage : undefined;
  globalThis.localStorage = disk;
  if (globalThis.window) globalThis.window.localStorage = disk;
  try {
    return await fn();
  } finally {
    globalThis.localStorage = prevGlobal;
    if (globalThis.window) globalThis.window.localStorage = prevWindow;
    MOUNTED = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Bootstrapping the fleet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{board:Object, devices?:string[], clock?:Object, relay?:Object,
 *          today?:string, maxDeferrals?:number}} opts
 *        `board` is the v1 `board.json` the FIRST Mac starts from. Every other Mac starts EMPTY
 *        and receives the whole board over the wire — which is only possible because
 *        `store.usePersonalSpace()` mints the spine into the `psp_…` space (LZP-502), and it is
 *        the strongest form of story 19.4 available.
 */
export async function createFleet(opts) {
  const tag = `f${++FLEET_SEQ}`;
  const clock = opts.clock || simClock();
  const relay = opts.relay || createRelay({ clock, limits: opts.limits });
  const wire = opts.wire || createWire(relay);
  const names = opts.devices || ['A', 'B'];
  const today = opts.today || clock.today();
  const spaceId = mkSpaceId('personal');

  const primary = await mintPrimary({ today });
  const spaceKey = await createSpaceKey();
  const ring0 = createKeyRing([[spaceId, 1, spaceKey]]);

  const fleet = {
    tag, clock, relay, wire, spaceId, today,
    memberId: primary.forStore.memberId,
    recovery: primary.recovery,
    /** deviceShort -> DeviceAttestation. THE `openOp` P1 INPUT. See S-1 for where it comes from. */
    attestations: new Map(),
    attestBlobs: [],
    devices: new Map(),
    /** Every device's public row, as PAIRING established it — ADR 001 §4.0's local device set. */
    roster: [],
    /** Obligations this harness deliberately does not discharge. See S-2. */
    owed: ['ADR 002 §4.1 — a new own device should rotate the personal space; this fleet does not'],
    board: opts.board,
    get all() { return [...fleet.devices.values()]; },
    device(name) {
      const d = fleet.devices.get(name);
      if (!d) throw new Error(`fleet: no device named ${JSON.stringify(name)}`);
      return d;
    },
    assertDistinctIdentities() { return assertDistinctIdentities(fleet); },
    async settle(rounds = 3) { return settle(fleet, rounds); },
  };

  const d0 = await addDevice(fleet, {
    name: names[0], tag, keys: primary, ring: ring0, maxDeferrals: opts.maxDeferrals,
  });
  await createSpaceOnRelay(fleet, d0, spaceKey);

  for (const name of names.slice(1)) {
    const joined = await pairInNewMac(fleet, d0, { today });
    const dev = await addDevice(fleet, {
      name, tag, keys: joined, ring: joined.ring, maxDeferrals: opts.maxDeferrals,
    });
    await registerDeviceOnRelay(fleet, dev);
  }

  // Every Mac learns every peer's attestation. Nothing here came off the relay (S-1).
  fleet.attestOpen = await buildAttestOpen([{
    memberId: fleet.memberId,
    recoveryPubSigRaw: await exportRawPublic(primary.recovery.recSig.publicKey),
    blobs: fleet.attestBlobs,
  }]);

  // EVERY Mac is seeded with the SAME `board.json` unless a test says otherwise. That is not a
  // convenience, it is defect **E5-1** (see the header): `store._buildSpine()` mints the spine at
  // the `'personal'` PLACEHOLDER, so `store.outbox()`'s space filter drops all of it and a freshly
  // paired Mac receives NOTHING of the board that already existed. Seeding both Macs models the
  // hand-over pairing performs, and it is exactly what ADR 001 §8.1's GENESIS determinism exists
  // for — two Macs migrating the same file agree byte for byte, so the spine never has to travel.
  // `createFleet({ seedAll: false })` is the un-papered case, and
  // `tests/fleet/fleet-harness.test.js` measures it.
  const seedAll = opts.seedAll !== false;
  for (const dev of fleet.all) await dev.open({ seed: seedAll || dev === d0 });

  await fleet.assertDistinctIdentities();
  return fleet;
}

/** The member: a recovery identity, one device, one self-attestation. */
async function mintPrimary({ today }) {
  const ks = memKeyStore();
  const opened = await openDeviceIdentity(ks, { today, allowMemoryCustody: true });
  const att = await selfAttest(ks, opened.forStore, opened.recovery.recSig.privateKey, { createdAt: today });
  return { ks, ...opened, attestation: att.attestation, blob: att.blob };
}

/**
 * ADR 002 §6.3 in full, over `tests/helpers/mitm.js`'s HONEST relay.
 *
 * The new Mac mints its own device keys inside `pairing.js`, both sides compute a SAS and a human
 * compares them, and only then does A deliver the payload — `RK_sig`, `RK_kex`, the member id and
 * the personal key ring. `adoptPairedDevice` writes the three key-store records
 * `ensureDeviceIdentity` reads, so the new Mac's identity is durable from its very first launch;
 * re-opening it through the SHIPPED entry points rather than trusting the return value is the
 * anti-drift assertion `crypto-pairing.test.js` makes, applied where it matters most.
 */
async function pairInNewMac(fleet, existing, { today }) {
  const A = createPairingSession(
    { ...existing.keys.identity, recSig: fleet.recovery.recSig, recKex: fleet.recovery.recKex },
    { personal: { spaceId: fleet.spaceId, epochs: existing.ring.keysByEpoch(fleet.spaceId) }, family: null },
    { now: fleet.clock.now },
  );
  const B = createPairingSession(null, null, { now: fleet.clock.now });
  const run = await drivePairing({ A, B, transport: honestRelay({ now: fleet.clock.now }) });
  if (run.error) throw run.error;
  if (run.sasMatched !== true) throw new Error('fleet: the SAS did not match on an honest relay');

  const ks = memKeyStore();
  await adoptPairedDevice(ks, run.restored, B.newDeviceKeys(), { createdAt: today });
  const identity = await ensureDeviceIdentity(ks, fleet.memberId, {});
  const recovery = await ensureRecoveryIdentity(ks, fleet.memberId, {});
  const att = await selfAttest(
    ks,
    { memberId: identity.memberId, deviceId: identity.deviceId, deviceShort: identity.deviceShort },
    recovery.recSig.privateKey,
    { createdAt: today },
  );

  // The ring came E2E and never through the relay. A payload naming another space is refused
  // rather than merged — a paired Mac that joined the wrong space would sync silently to nothing.
  const personal = run.restored.personal;
  if (!personal || !(personal.epochs instanceof Map)) throw new Error('fleet: pairing carried no key ring');
  if (personal.spaceId !== fleet.spaceId) {
    throw new Error(`fleet: the pairing payload names ${personal.spaceId}, not ${fleet.spaceId}`);
  }
  const ring = createKeyRing();
  for (const [e, k] of personal.epochs) ring.put(fleet.spaceId, Number(e), k);

  return {
    ks,
    forStore: { memberId: identity.memberId, deviceId: identity.deviceId, deviceShort: identity.deviceShort },
    identity,
    recovery,
    attestation: att.attestation,
    blob: att.blob,
    ring,
  };
}

async function createSpaceOnRelay(fleet, dev, spaceKey) {
  const k = dev.keys;
  const myKexPriv = k.identity.devKex.privateKey;
  const devSigPub = b64u(await exportRawPublic(k.identity.devSig.publicKey));
  const devKexPub = b64u(await exportRawPublic(k.identity.devKex.publicKey));
  const recSigPub = b64u(await exportRawPublic(k.recovery.recSig.publicKey));
  const recKexPub = b64u(await exportRawPublic(k.recovery.recKex.publicKey));
  const wrapTo = async (pubB64u) => packWrap(await wrapSpaceKey(
    spaceKey, myKexPriv, await importKexPublic(ub64(pubB64u)), { spaceId: fleet.spaceId, epoch: 1 },
  ));
  const wraps = [
    { recipientId: k.forStore.deviceId, epoch: 1, wrapped: await wrapTo(devKexPub) },
    { recipientId: `rec_${fleet.memberId}`, epoch: 1, wrapped: await wrapTo(recKexPub) },
  ];

  const res = await dev.run(() => dev.transport.request('POST', '/api/v1/spaces', undefined, {
    spaceId: fleet.spaceId,
    kind: 'PERSONAL',
    colorRef: 'gruen',
    member: { memberId: fleet.memberId, recoveryPubSig: recSigPub, recoveryPubKex: recKexPub },
    device: {
      deviceId: k.forStore.deviceId,
      deviceShort: k.forStore.deviceShort,
      sigPubRaw: devSigPub,
      kexPubRaw: devKexPub,
      // Finding E2E3-7: `POST /spaces` takes the blob STRING now, exactly as `POST /devices`
      // always did, and verifies it under `member.recoveryPubSig`. One spelling, one contract.
      attestation: k.blob,
    },
    // REAL wraps, so the relay's ADR 002 §4.2 coverage check runs against real bytes.
    wraps,
  }));
  if (res.status !== 200) throw new Error(`fleet: POST /spaces -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/**
 * `POST /api/v1/devices` — the second Mac becomes a row on the relay so its signatures verify.
 *
 * It is handed NO wrap here and needs none: the key ring came over the pairing channel (ADR 002
 * §6.3), so the response's `keysPending: true` is the truth about the RELAY and not about this
 * device. `rotateRequired: true` (§4.1) is a real obligation this harness deliberately leaves
 * undischarged — see S-2 and `fleet.owed`.
 */
async function registerDeviceOnRelay(fleet, dev) {
  const k = dev.keys;
  const res = await dev.run(() => dev.transport.request('POST', '/api/v1/devices', undefined, {
    spaceId: fleet.spaceId,
    memberId: fleet.memberId,
    deviceId: k.forStore.deviceId,
    deviceShort: k.forStore.deviceShort,
    sigPubRaw: dev.wire.sigPubRaw,
    kexPubRaw: dev.wire.kexPubRaw,
    attestation: k.blob,
  }));
  if (res.status !== 200) throw new Error(`fleet: POST /devices -> ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. One device
// ─────────────────────────────────────────────────────────────────────────────

async function addDevice(fleet, { name, tag, keys, ring, maxDeferrals }) {
  const short = keys.forStore.deviceShort;
  const sigPubRaw = b64u(await exportRawPublic(keys.identity.devSig.publicKey));
  const kexPubRaw = b64u(await exportRawPublic(keys.identity.devKex.publicKey));

  fleet.attestations.set(short, keys.attestation);
  fleet.attestBlobs.push(keys.blob);
  fleet.roster.push({
    deviceId: keys.forStore.deviceId, deviceShort: short, memberId: keys.forStore.memberId,
    sigPubRaw, kexPubRaw, attestation: keys.blob, revokedAt: null,
  });

  const dev = makeDevice(fleet, { name, tag, keys, ring, sigPubRaw, kexPubRaw, maxDeferrals });
  fleet.devices.set(name, dev);
  Object.defineProperty(fleet, name, { value: dev, configurable: true, enumerable: false });
  return dev;
}

function makeDevice(fleet, { name, tag, keys, ring, sigPubRaw, kexPubRaw, maxDeferrals }) {
  const disk = createDisk();
  const short = keys.forStore.deviceShort;
  const st = { store: null, sync: null, online: true, skewMs: 0, publisher: null, persistOwed: false };

  /** The shape `deviceTransport` and `POST /devices` both want. */
  const wire = {
    deviceId: keys.forStore.deviceId,
    deviceShort: short,
    sigPubRaw,
    kexPubRaw,
    attestation: keys.blob,
    member: { memberId: keys.forStore.memberId },
  };

  // The clock SKEW rides on the SIGNING timestamp — the value ADR 003 §2 step 2 compares against
  // the relay's 120 000 ms window. A Mac whose clock is five minutes out therefore gets a real
  // `401 stale_request` from the real verifier, which is the behaviour LZP-505 has to characterise.
  const transport = deviceTransport({
    wire: fleet.wire,
    deviceShort: short,
    sign: (bytes) => signBytes(keys.identity.devSig.privateKey, bytes, {}),
    now: () => fleet.clock.now() + st.skewMs,
  });

  const dev = {
    name, keys, ring, disk, wire, transport,
    get short() { return short; },
    get deviceId() { return keys.forStore.deviceId; },
    get memberId() { return keys.forStore.memberId; },
    get store() { return st.store; },
    get engine() { return st.sync; },
    get state() { return st.store.state; },
    get publisher() { return st.publisher; },
    set skewMs(v) { st.skewMs = v; },
    get skewMs() { return st.skewMs; },
    /**
     * A partition is a property of THIS MAC, not of the relay: `wire.deliver` raises
     * `NetError('offline')`, which is the branch ADR 003 §8.2 takes for "stop scheduling and
     * queue in ops.jsonl". Modelling it as a 5xx would exercise the backoff ladder instead, and
     * that is a different rule.
     */
    offline() { st.online = false; fleet.wire.partition(short); return dev; },
    online() { st.online = true; fleet.wire.heal(short); return dev; },
    get isOffline() { return !st.online; },

    run(fn) { return mounted(disk, fn); },

    // ── lifecycle ───────────────────────────────────────────────────────────

    /**
     * Launch.
     *
     * THE ORDER IS THE PRODUCT'S, NOT THE HARNESS'S: `useIdentity()` and `usePersonalSpace()`
     * BEFORE `init()`. `usePersonalSpace` throws after `init()` on purpose — a space adopted late
     * leaves a whole log of placeholder-space ops that `sealOp` would refuse one at a time for
     * ever — and `useIdentity` after `init()` leaves the spine authored by the ephemeral identity.
     */
    async open({ seed = false } = {}) {
      return dev.run(async () => {
        if (seed && fleet.board && disk.getItem('langzeitplaner.board') === null) {
          disk.setItem('langzeitplaner.board', JSON.stringify(fleet.board, null, 2));
        }
        const store = (await import(`../../src/js/store.js?fleet-${tag}-${name}`)).store;
        st.store = store;
        clearTimeout(store._saveTimer);
        // ── NO WALL-CLOCK TIMER MAY SURVIVE A DEVICE OPERATION ────────────────────────────────
        //
        // `schedulePersist()` arms a real `setTimeout(persistNow, SAVE_DEBOUNCE)`, and every
        // `ackPushed`/`noteCursor` inside the engine calls it. A timer that fires LATER — after
        // `mounted()` has swapped `globalThis.localStorage` back, or during another device's
        // turn — runs `persistNow()` against SOMEBODY ELSE'S DISK and writes one Mac's board over
        // another's. That is not a hypothetical: it is what made §3 of
        // `tests/tier1/sync-convergence.test.js` fail intermittently with "disagree on: notes,
        // bars" before this line existed, and it would have been read as a convergence bug.
        //
        // So the debounce is made DETERMINISTIC rather than merely cleared: the flag records that
        // a persist is owed, `persistNow()` is untouched, and `dev.persist()` / the engine's own
        // `await store.persistNow()` are the only things that ever write. Precedent:
        // `tests/tier1/store-identity.test.js`'s `quiet()` does the same job with `clearTimeout`,
        // one call site at a time; this closes every call site at once.
        store.schedulePersist = () => { st.persistOwed = true; };
        store.listeners.clear();
        store.warnings.length = 0;
        store.snapshots.length = 0;
        store._lastSnapshotDay = null;
        store.ready = false;

        if (!store.hasDurableIdentity()) {
          store.useIdentity({
            ...keys.forStore,
            peerDeviceIds: fleet.roster
              .filter((r) => r.memberId === keys.forStore.memberId && r.deviceId !== keys.forStore.deviceId)
              .map((r) => r.deviceId),
            attestOpen: fleet.attestOpen,
          });
        }
        if (store.personalSpaceId() === null) store.usePersonalSpace(fleet.spaceId);

        st.publisher = createPersonalPublisher();
        store.setPublisher(st.publisher);

        await store.init();
        clearTimeout(store._saveTimer);

        // A launch writes `board.json` — `main.js` does it on the first autosave and every fleet
        // assertion about "the file on disk" needs the file to exist. It also fixes the lineage,
        // which is what makes a later quarantine a real quarantine rather than a fresh install.
        await store.persistNow();
        clearTimeout(store._saveTimer);

        st.sync = createPersonalSync({
          store,
          transport,
          keyring: ring,
          sigPriv: keys.identity.devSig.privateKey,
          spaceId: fleet.spaceId,
          deviceShort: short,
          attestationOf: (dv) => fleet.attestations.get(dv) || null,
          attestation: keys.attestation,
          now: () => fleet.clock.now(),
          isOnline: () => st.online,
          schedule: () => null,
          unschedule: () => {},
          // P-8's durable park, on THIS device's disk, so a relaunch reads back what the previous
          // session retained — the same `disk` every other file of this Mac lives in. Modelled on
          // `family/engine.js`'s `parkedEnvelopeStore()`, which is the shipping implementation.
          parkStore: {
            durable: true,
            async loadRecords() {
              try { return JSON.parse(disk.getItem('langzeitplaner.parked') || '[]'); }
              catch { return []; }
            },
            async saveRecords(rows) { disk.setItem('langzeitplaner.parked', JSON.stringify(rows)); },
          },
          // P-4's durable chain anchor, on THIS device's disk. Modelled on `family/engine.js`'s
          // `chainHeadStore()`. It is NOT the transport cursor — that stays in the checkpoint.
          chainStore: {
            async loadCursors() {
              try { return JSON.parse(disk.getItem('langzeitplaner.chainheads') || '{}'); }
              catch { return {}; }
            },
            async saveCursors(all) { disk.setItem('langzeitplaner.chainheads', JSON.stringify(all)); },
          },
          ...(maxDeferrals ? { maxDeferrals } : {}),
        });
        return dev;
      });
    },

    /** Quit: flush and forget the engine. The disk survives; `open()` re-reads it. */
    async close() {
      return dev.run(async () => {
        clearTimeout(st.store._saveTimer);
        await st.store.persistNow();
        st.sync = null;
      });
    },

    /**
     * Quit and relaunch on the same disk — the "three weeks later, it opens" move.
     *
     * `init()` is re-run over the files this Mac wrote: `board.json` is re-migrated, the log is
     * re-adopted, the cursor comes back out of `checkpoint().cursors` and the outbox comes back
     * out of the lines whose `seq` is unset. Nothing is carried in memory across the boundary
     * except the identity — which is what "durable" means — and the engine is rebuilt, so its
     * sealed-envelope cache starts empty exactly as it would after a real quit.
     */
    async relaunch() {
      await dev.close();
      return dev.open();
    },

    // ── editing ─────────────────────────────────────────────────────────────

    async apply(mutation, args, label) {
      return dev.run(async () => {
        const r = st.store.apply(mutation, args, label);
        clearTimeout(st.store._saveTimer);
        await st.store.persistNow();
        return r;
      });
    },
    async txn(label, fn) {
      return dev.run(async () => {
        const r = st.store.txn(label, fn);
        clearTimeout(st.store._saveTimer);
        await st.store.persistNow();
        return r;
      });
    },
    /** `store.replaceAll` — the WP-3 path: `planReplaceAll`, retractions handed to the publisher. */
    async replaceAll(next) {
      return dev.run(async () => {
        const r = st.store.replaceAll(next);
        clearTimeout(st.store._saveTimer);
        await st.store.persistNow();
        return r;
      });
    },
    async persist() {
      return dev.run(async () => {
        clearTimeout(st.store._saveTimer);
        await st.store.persistNow();
      });
    },

    // ── the shipped engine ──────────────────────────────────────────────────

    async push() { return dev.run(() => st.sync.pushNow()); },
    async pull() { return dev.run(() => st.sync.pullNow()); },
    /** Pull to exhaustion, then push — ADR 003 §8.2's "back online" order. */
    async sync() { return dev.run(() => st.sync.syncNow()); },
    /**
     * A device that was away for weeks: sync until nothing more moves. Several cycles are needed
     * in general, not for paging (`syncNow` drains `hasMore` itself) but for F-6: an op deferred
     * because its cure had not arrived is retried on the NEXT cycle.
     */
    async catchUp(maxCycles = 6) {
      const seen = [];
      let before = null;
      for (let i = 0; i < maxCycles; i++) {
        seen.push(await dev.sync());
        const now = `${dev.cursor()}|${dev.outboxSize()}|${dev.deferredOps().length}`;
        if (now === before) break;
        before = now;
      }
      return seen;
    },

    // ── inspection ──────────────────────────────────────────────────────────

    boardText() { return disk.getItem('langzeitplaner.board'); },
    /** `board.json` WITHOUT ADR 006 §4.1's local `_v2` binding — see `boardsAgree`. */
    boardContent() {
      const text = dev.boardText();
      if (text === null) return null;
      const raw = JSON.parse(text);
      delete raw._v2;
      return raw;
    },
    diskKeys() { return disk._keys(); },
    cursor() { return st.store.cursor(fleet.spaceId); },
    outboxSize() { return st.store.outboxSize(); },
    diagnostics() { return st.sync.diagnostics(); },
    status() { return st.sync.status(); },
    deferredOps() { return st.sync.deferredOps(); },
    quarantined() { return st.sync.quarantined(); },
    /**
     * The quarantine E5-1 causes, and only it: a spine op refused `409 forked_op_id` because the
     * peer already published the same deterministic opId with different bytes, or (before the
     * re-stamp) one whose GENESIS stamp names no device.
     */
    genesisQuarantine() {
      return st.sync.quarantined().filter((q) => /forked_op_id|0000000000000000/.test(q.reason || ''));
    },
    /** Everything else in the quarantine — which must be EMPTY on an honest run. */
    realQuarantine() {
      return st.sync.quarantined().filter((q) => !/forked_op_id|0000000000000000/.test(q.reason || ''));
    },
    storeDiagnostics() { return st.store.diagnostics(); },
    warnings() { return [...st.store.warnings]; },
    logOps({ includeParked = false } = {}) { return st.store._log.ops({ includeParked }); },
    parked() { return st.store._log.lines().filter((l) => l.park !== null && l.park !== undefined); },
    /**
     * The SEALED envelopes the ENGINE is retaining, with their park reasons — P-8's third axis.
     * `parked()` above is the LOG's park (ops this Mac can read and will not apply);
     * `sync/outbox.js`'s parking lot is the other one (bytes it cannot read yet, because P1, P4
     * or the version gate refused before the decrypt). A fresh process answers this the same way,
     * which is the whole point of it.
     */
    heldEnvelopes() { return st.sync.heldEnvelopes(); },
  };
  return dev;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The op-stream adversary
// ─────────────────────────────────────────────────────────────────────────────
//
// `tests/helpers/mitm.js` is E3's hostile relay for the PAIRING rendezvous and is reused verbatim
// above for the pairing hop. It cannot be reused for the OP STREAM, because the two adversaries
// have different powers: a pairing MITM substitutes ephemeral keys inside a three-message
// protocol, while an op-stream relay holds an append-only log and can reorder, duplicate,
// withhold, rewind a cursor, relabel an epoch, re-attribute a device or forge a member row.
//
// That adversary lives in `loopback.js` as `MUTATORS`, re-exported above, and is armed per fleet:
//
//     fleet.wire.hostile.onResponse = MUTATORS.shuffleOps(7);
//     fleet.wire.honest();
//
// The third argument every mutator receives is the VICTIM's `deviceShort`, so a relay can lie to
// one Mac and tell the other the truth — the only shape of adversary that can produce a
// divergence rather than a shared error.

// ─────────────────────────────────────────────────────────────────────────────
// 5. Fleet-level moves and assertions
// ─────────────────────────────────────────────────────────────────────────────

/** Sync everybody until nothing moves. Push first, then pull-and-push, so one round covers each edge. */
export async function settle(fleet, rounds = 3) {
  const report = [];
  for (let r = 0; r < rounds; r++) {
    for (const dev of fleet.all) if (!dev.isOffline) report.push({ r, dev: dev.name, push: await dev.push() });
    for (const dev of fleet.all) if (!dev.isOffline) report.push({ r, dev: dev.name, sync: await dev.sync() });
  }
  return report;
}

/**
 * THE A3-H4 GATE. Called by `createFleet` before it returns; a fleet that cannot pass does not
 * exist. Six checks, each closing a different way of writing a false green.
 */
export async function assertDistinctIdentities(fleet) {
  const rows = fleet.roster;
  const fail = (m) => { throw new Error(`fleet: identity gate — ${m}`); };
  if (rows.length < 2) fail('a fleet of one device proves nothing about convergence');

  if (new Set(rows.map((r) => r.deviceId)).size !== rows.length) fail('two devices share a deviceId');
  if (new Set(rows.map((r) => r.deviceShort)).size !== rows.length) fail('two devices share a deviceShort');
  if (new Set(rows.map((r) => r.sigPubRaw)).size !== rows.length) fail("two devices share a SIGNING KEY — A3-H4's false green");
  if (new Set(rows.map((r) => r.memberId)).size !== 1) fail('M1 is ONE member with several Macs');
  for (const r of rows) {
    if (deviceShortOf(ub64(r.sigPubRaw)) !== r.deviceShort) {
      fail(`${r.deviceShort} is not the short of its own signing key (ADR 002 §5.2.0)`);
    }
  }

  const stores = fleet.all.map((d) => d.store).filter(Boolean);
  if (stores.length >= 2) {
    const seen = new Set();
    for (const s of stores) {
      if (seen.has(s)) fail('two devices share ONE store instance');
      seen.add(s);
      if (!s.hasDurableIdentity()) fail('a device is running on the ephemeral per-process identity');
    }
    if (new Set(stores.map((s) => s._me)).size !== 1) fail('the stores disagree about which member they are');
    if (new Set(stores.map((s) => s._device)).size !== stores.length) fail('two stores share a _device — the A3-H4 false green');
  }
  return true;
}

/**
 * "Both devices converge to the identical board, and `board.json` is byte-identical afterwards."
 *
 * `_v2` is stripped first, and that is not a loophole: ADR 006 §4.1/§4.2 make `lineageId` the
 * LOCAL `board.json` ↔ log binding, and §9.3's round-7 amendment is explicit that it is "not a
 * sync identity" — two Macs each bind their own log, and re-minting one on a peer's behalf would
 * orphan the log a later launch is meant to adopt. The CONTENT — which story 11.4 asserts IS
 * `store.state` — is what must agree byte for byte, and it is what this compares.
 */
export function boardsAgree(devices) {
  const texts = devices.map((d) => JSON.stringify(d.boardContent(), null, 2));
  const equal = texts.every((t) => t === texts[0]);
  let detail = 'identical';
  if (!equal) {
    const a = JSON.parse(texts[0]);
    const diffs = [];
    for (const other of texts.slice(1)) {
      const b = JSON.parse(other);
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(k);
      }
    }
    detail = `disagree on: ${[...new Set(diffs)].join(', ')}`;
  }
  return { equal, detail, texts };
}

/**
 * Every register cell as `entityKey|field -> {value, stamp, author}` — stronger than comparing
 * boards, because two Macs can project the same v1 board out of cells that disagree about WHO
 * wrote a value and WHEN, and the next edit would then diverge. `serializeRegisters` is the
 * shipped canonicaliser, so this is the log's own answer rather than a second opinion.
 */
export function registerDigest(dev) {
  const blob = serializeRegisters(dev.store.registers());
  const out = {};
  for (const [key, fields] of Object.entries(blob.regs)) {
    for (const [field, cell] of Object.entries(fields)) {
      out[`${key}|${field}`] = { value: cell.value, stamp: cell.stamp, author: cell.author };
    }
  }
  return out;
}
