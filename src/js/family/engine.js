// src/js/family/engine.js — THE FAMILY OPT-IN MOMENT.  LZP-505 · milestone M1 "Zwei Macs".
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS, AND WHY IT IS THE ONLY ONE OF ITS KIND
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Every other module in `src/js/` is either always loaded (the board) or never loaded in solo
// mode (`crypto/`, `sync/`, `platform/net.js`). This is the DOOR between the two, and it is the
// one module `main.js` reaches by a dynamic `await import()`:
//
//     main.js  ──static──▶  store.js, board.js, settings.js, …          every launch
//     main.js  ──dynamic─▶  family/engine.js ──▶ crypto/, sync/, net.js  only with a space
//
// ADR 002 §2.4 — "First run mints only a memberId and a deviceShort. NO KEYGEN, NO PROBE, NO
// NETWORK" — and ADR 003 §7 gate 2 — "`net.js` and the whole of `src/js/sync/` are reached only
// through a dynamic `await import()` gated on `spaces.personal || spaces.family`" — are the same
// claim about the module graph, and this file is where it is kept. A solo install never
// evaluates a line of it. `tests/tier1/network-scope.test.js` §2 and
// `tests/tier1/crypto-identity.test.js`'s PRINCIPLE 7 gate assert exactly that, over the real
// import graph, and they assert that this is the ONLY door — a second one would be a second
// place for solo mode to leak through.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ORDER OF OPERATIONS, AND WHY IT CANNOT BE REARRANGED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   1. `readFamilyConfig(board)`     ← from the RAW board file, before the store exists
//   2. `armStore(store, cfg, …)`     ← `useIdentity()` + `usePersonalSpace()`,  BEFORE init()
//   3. `store.init()`                ← the whole board is minted into the space, once
//   4. `startEngine(...)`            ← transport, key ring, `createPersonalSync`, AFTER init()
//
// Steps 2 and 3 are ordered by `store.usePersonalSpace()`'s own refusal, and it is right to
// refuse: `_ctx().space` is `_personalSpaceId ?? PERSONAL_PLACEHOLDER`, so a space adopted after
// `init()` leaves a whole log of `space: 'personal'` ops that `sealOp` refuses one by one
// (ADR 002 §5.2.2 check 2) with nothing on screen to say why.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ATTESTATION HOP AT M1 — the seam every builder on this epic reported (S-1 / E5's §6.1)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `openOp`'s P1 needs `attestationOf(deviceShort)` and there are three possible sources:
//
//   · THE LOG — `member.set{dev.*}`. **Unavailable at M1**: `member.set` is a family-space op
//     kind (`OP_KINDS['member.set'].space === 'family'`), so a person with two Macs and no
//     Familienkreis has nowhere in the log to record one.
//   · THE RELAY — refused on purpose. `server/core/handlers/members.js`: "The attestation is
//     deliberately NOT published … the relay's device rows are a hint about who to wrap to; the
//     log is the authority."
//   · PAIRING — which is what ADR 002 §2.3 actually says: *"the pairing flow, not the fold, has
//     to deliver a first attestation."*
//
// So this file mints it, on the SAS-authenticated channel and nowhere else:
//
//   · the existing Mac, at `confirmExisting()`, holds the peer's `(deviceId, deviceShort,
//     sigPubRaw, kexPubRaw)` — every field of a `DeviceAttestation` — and holds `RK_sig`, the
//     member's own recovery key. An attestation IS the member's recovery key vouching for a
//     device, and both Macs of one member hold that key, so either may mint the other's.
//   · the new Mac gets the existing Mac's `sigPubRaw` out of the SAS-authenticated offer and its
//     `kexPubRaw` off the relay's roster. That asymmetry is deliberate and bounded: `sigPubRaw`
//     is what P2/P3 and check 4 rest on and it comes from the authenticated channel; `kexPubRaw`
//     decides only who a future key wrap is addressed to, and a wrong one produces a wrap the
//     peer cannot open rather than an op it wrongly accepts.
//
// **What this is NOT:** minting an attestation from the RELAY'S roster alone would hand back the
// exact property ADR 002 §2.3 is about — "a malicious relay cannot fabricate a device row for an
// existing member". So the roster is never a source for `sigPubRaw`; only pairing is.
//
// OWED, and it does not block M1: the moment a Familienkreis exists, the log becomes the
// authority and this local table becomes a bootstrap cache. Owner: WP-9.

import {
  chooseTransport, NetError, PROTOCOL,
} from '../platform/net.js';
import { chooseKeyStore } from '../platform/keystore.js';
import { openDeviceIdentity, selfAttest, IdentityUnavailableError } from '../platform/device-identity.js';
import {
  signBytes, exportRawPublic, importSigPublic, importKexPublic,
  buildDeviceAttestation, attestDevice, verifyAttestation, ensureRecoveryIdentity,
} from '../crypto/identity.js';
import {
  createKeyRing, createSpaceKey, wrapSpaceKey,
} from '../crypto/spacekeys.js';
import { createPersonalSync, createPersonalPublisher, CADENCE } from '../sync/personal.js';
import { spaceId as mintSpaceId } from '../core/ids.js';
import { b64u, ub64 } from '../core/b64.js';

const TE = new TextEncoder();

/** The settings keys the opt-in writes. `pref.set` takes any key and is LOCAL-space, never synced. */
export const FAMILY_PREFS = Object.freeze({
  enabled: 'syncEnabled',
  origin: 'syncOrigin',
  space: 'personalSpaceId',
});

/** The client version string the relay sees in `X-LZP-Client`. */
export const CLIENT_VERSION = '2.0.0';

/** What a config has to carry before any of this is worth starting. */
export function readFamilyConfig(settings) {
  const s = settings || {};
  const origin = typeof s[FAMILY_PREFS.origin] === 'string' ? s[FAMILY_PREFS.origin].trim() : '';
  const space = typeof s[FAMILY_PREFS.space] === 'string' ? s[FAMILY_PREFS.space] : '';
  if (!s[FAMILY_PREFS.enabled] || !origin || !space.startsWith('psp_')) return null;
  return Object.freeze({ origin, spaceId: space });
}

/**
 * STEP 2 — the durable identity and the space, into the store, BEFORE `init()`.
 *
 * Returns everything step 4 needs, so the key store is opened exactly once per launch: opening
 * it twice on a real Mac means two IndexedDB handles and two chances to mint a second identity.
 *
 * @param {Object} store
 * @param {{origin:string, spaceId:string}} cfg
 * @param {{today:string, invoke?:Function, warn?:Function}} ports
 */
export async function armStore(store, cfg, ports) {
  const { today, invoke, warn } = ports || {};
  const { store: ks, kind: custody } = chooseKeyStore({ invoke });
  const opened = await openDeviceIdentity(ks, { today, custody, allowMemoryCustody: false });
  const recovery = opened.recovery
    ? opened.recovery
    : await ensureRecoveryIdentity(ks, opened.forStore.memberId, {});

  // The self-attestation is minted here rather than at pairing time because THIS Mac needs it in
  // its own `attestationOf` table too: `sealOp` mirrors the far-side gate (ADR 002 §5.2.2), so a
  // device that cannot attest itself cannot seal its own ops.
  const mine = await selfAttest(ks, opened.forStore, recovery.recSig.privateKey, { createdAt: today });

  const peers = loadPeers(cfg.spaceId);
  const attestations = new Map();
  attestations.set(opened.forStore.deviceShort, mine.attestation);
  for (const p of peers) {
    if (p.attestation) attestations.set(p.attestation.deviceShort, p.attestation);
  }

  store.usePersonalSpace(cfg.spaceId);
  store.useIdentity({
    ...opened.forStore,
    peerDeviceIds: peers.map((p) => p.deviceId).filter(Boolean),
  });

  if (typeof warn === 'function' && opened.minted) {
    warn('a new device identity was minted for this Mac');
  }

  return Object.freeze({
    ks, cfg, today, custody,
    identity: opened.identity,
    recovery,
    forStore: opened.forStore,
    myAttestation: mine.attestation,
    myBlob: mine.blob,
    attestations,
    peers,
  });
}

/**
 * STEP 4 — the transport, the key ring and the engine. AFTER `store.init()`.
 *
 * @param {Object} store
 * @param {Object} armed what `armStore` returned
 * @param {{now:Function, schedule?:Function, unschedule?:Function, invoke?:Function,
 *          isOnline?:Function, onStatus?:Function, fetchImpl?:Function}} ports
 */
export async function startEngine(store, armed, ports) {
  const p = ports || {};
  const { transport, kind } = chooseTransport({
    origin: armed.cfg.origin,
    deviceShort: armed.forStore.deviceShort,
    // THE SIGN PORT — one line, and the reason `net.js` imports nothing from `crypto/`. `IK_sig`
    // is `extractable: false`, so a signature is the only thing that can cross this boundary.
    sign: (bytes) => signBytes(armed.identity.devSig.privateKey, bytes),
    clientVersion: CLIENT_VERSION,
    now: p.now,
    schedule: p.schedule,
    unschedule: p.unschedule,
    invoke: p.invoke,
    fetchImpl: p.fetchImpl,
  });

  const keyring = createKeyRing();
  const stored = loadRing(armed.cfg.spaceId);
  for (const [epoch, raw] of stored) {
    // eslint-disable-next-line no-await-in-loop
    keyring.put(armed.cfg.spaceId, epoch, await importSpaceKey(raw));
  }

  const sync = createPersonalSync({
    store,
    transport,
    keyring,
    sigPriv: armed.identity.devSig.privateKey,
    spaceId: armed.cfg.spaceId,
    deviceShort: armed.forStore.deviceShort,
    attestationOf: (dv) => armed.attestations.get(dv) || null,
    attestation: armed.myAttestation,
    now: p.now,
    schedule: p.schedule,
    unschedule: p.unschedule,
    isOnline: p.isOnline,
    onStatus: p.onStatus,
    envelopeStore: sealedEnvelopeStore(),
    parkStore: parkedEnvelopeStore(),
    chainStore: chainHeadStore(),
  });

  // ADR 004 §3 / the WP-3 obligation. `nullPublisher()` RECORDS retractions rather than
  // discarding them, and `setPublisher` carries that record across — an import performed in solo
  // mode would otherwise leave entries live on the other Mac for ever (story 16.5).
  const publisher = createPersonalPublisher({});
  store.setPublisher(publisher);

  sync.attach();
  const cadence = driveCadence(sync, p);
  return Object.freeze({ transport, transportKind: kind, keyring, sync, publisher, armed, cadence });
}

/**
 * ADR 003 §8.2's CADENCE, which is the caller's job and not the engine's.
 *
 * `sync/personal.js`'s `attach()` subscribes to the store and arms the 2 s push debounce, and
 * that is deliberately ALL it does: nothing under `src/js/sync/` reads a clock or a `document`,
 * so "every 45 seconds while the window is visible" is a sentence only a module that may touch
 * `document.hidden` can say. This is that module.
 *
 * Four triggers, and each one is a row of §8.2:
 *
 *   · ONCE, immediately — the launch pull. Without it a Mac that was closed while its peer wrote
 *     shows yesterday's board until the first 45 s tick, which is the one moment a person is
 *     actually looking.
 *   · every `pullVisibleMs` ± jitter while visible, every `pullHiddenMs` while hidden. The
 *     jitter is not cosmetic: two Macs of one member woken by the same NTP step would otherwise
 *     pull in lockstep for ever.
 *   · `visibilitychange` and `online` — a Mac that slept for a week is back, and 45 s of a stale
 *     board is 45 s too many when the user has just looked at it.
 *   · `pagehide` — `flush()`. Durability is already guaranteed (the envelope was persisted at
 *     seal time); DELIVERY is best effort, and this file does not pretend otherwise.
 */
function driveCadence(sync, p) {
  const schedule = p.schedule || ((ms, fn) => setTimeout(fn, ms));
  const unschedule = p.unschedule || ((h) => clearTimeout(h));
  const random = p.random || (() => Math.random());
  const doc = globalThis.document;
  let timer = null;
  let stopped = false;

  const hidden = () => !!(doc && doc.hidden);
  const nextDelay = () => (hidden()
    ? CADENCE.pullHiddenMs
    : CADENCE.pullVisibleMs + Math.floor(random() * CADENCE.pullJitterMs));

  const tick = () => {
    timer = null;
    if (stopped) return;
    sync.syncNow().catch(() => {}).finally(arm);
  };
  const arm = () => {
    if (stopped) return;
    if (timer !== null) unschedule(timer);
    timer = schedule(nextDelay(), tick);
  };
  const wake = () => {
    if (stopped) return;
    if (timer !== null) { unschedule(timer); timer = null; }
    tick();
  };

  sync.syncNow().catch(() => {}).finally(arm);

  const onVisible = () => { if (!hidden()) wake(); else arm(); };
  if (doc) doc.addEventListener('visibilitychange', onVisible);
  if (globalThis.addEventListener) {
    globalThis.addEventListener('online', wake);
    globalThis.addEventListener('pagehide', () => { sync.flush().catch(() => {}); });
  }

  return {
    wake,
    stop() {
      stopped = true;
      if (timer !== null) unschedule(timer);
      timer = null;
      if (doc) doc.removeEventListener('visibilitychange', onVisible);
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Creating the space — the first Mac, once
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `POST /api/v1/spaces` — become a member, register this device, and publish the epoch-1 wraps.
 *
 * The wraps are REQUIRED by the relay's coverage rule and they are not ceremony: without them
 * `GET /spaces/:id/keys` returns nothing for a space that has never rotated, so a member
 * restoring from the backup file would recover a member id and no space key.
 *
 * NOTE, and it is a real wart reported to the server's owner: `device.attestation` has two
 * spellings on two endpoints. `POST /spaces` reads it with `readBytes` (base64url of opaque
 * bytes, never verified); `POST /devices` reads the raw blob string and VERIFIES it. So the same
 * value is encoded differently for the two calls, below and in `adoptOnRelay`.
 */
export async function createSpaceOnRelay(engineParts, armed, spaceKey) {
  const { transport } = engineParts;
  const id = armed.forStore;
  const devSigPub = b64u(await exportRawPublic(armed.identity.devSig.publicKey));
  const devKexPub = b64u(await exportRawPublic(armed.identity.devKex.publicKey));
  const recSigPub = b64u(await exportRawPublic(armed.recovery.recSig.publicKey));
  const recKexPub = b64u(await exportRawPublic(armed.recovery.recKex.publicKey));

  const wrapTo = async (pubB64u) => b64u(TE.encode(JSON.stringify(await wrapSpaceKey(
    spaceKey, armed.identity.devKex.privateKey, await importKexPublic(ub64(pubB64u)),
    { spaceId: armed.cfg.spaceId, epoch: 1 },
  ))));

  const res = await transport.request('POST', '/api/v1/spaces', undefined, {
    spaceId: armed.cfg.spaceId,
    kind: 'PERSONAL',
    colorRef: 'gruen',
    member: { memberId: id.memberId, recoveryPubSig: recSigPub, recoveryPubKex: recKexPub },
    device: {
      deviceId: id.deviceId,
      deviceShort: id.deviceShort,
      sigPubRaw: devSigPub,
      kexPubRaw: devKexPub,
      attestation: b64u(TE.encode(armed.myBlob)),      // ← base64url here …
    },
    wraps: [
      { recipientId: id.deviceId, epoch: 1, wrapped: await wrapTo(devKexPub) },
      { recipientId: `rec_${id.memberId}`, epoch: 1, wrapped: await wrapTo(recKexPub) },
    ],
  });
  if (res.status !== 200) {
    throw new NetError('bad_response', `POST /spaces → ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

/** `POST /api/v1/devices/adopt` — the second Mac becomes a row so its signatures verify. */
export async function adoptOnRelay(engineParts, armed) {
  const id = armed.forStore;
  const res = await engineParts.transport.request('POST', '/api/v1/devices/adopt', undefined, {
    spaceId: armed.cfg.spaceId,
    memberId: id.memberId,
    deviceId: id.deviceId,
    deviceShort: id.deviceShort,
    sigPubRaw: b64u(await exportRawPublic(armed.identity.devSig.publicKey)),
    kexPubRaw: b64u(await exportRawPublic(armed.identity.devKex.publicKey)),
    attestation: armed.myBlob,                          // ← the raw blob string here
  });
  if (res.status !== 200) {
    throw new NetError('bad_response', `POST /devices/adopt → ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The attestation a pairing produces — see the header for why this is minted and not fetched
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Mint and verify an attestation for a peer device of MY OWN member, from fields that came off
 * the SAS-authenticated pairing channel.
 *
 * It is verified after minting, with `verifyAttestation`, against the same recovery public key a
 * peer would use. That is not paranoia about our own signature: it is the assertion that the
 * blob this Mac stores is one the OTHER Mac's `buildAttestOpen` will accept, checked here where
 * a failure is a red test rather than a silent permanent park in the field.
 *
 * @param {{memberId:string, deviceId:string, deviceShort:string, sigPubRaw:string, kexPubRaw:string}} peer
 * @param {CryptoKeyPair} recSig the member's recovery signing pair
 * @param {string} createdAt 'YYYY-MM-DD', injected — nothing under crypto/ reads a clock
 */
export async function attestPeer(peer, recSig, createdAt) {
  const att = await buildDeviceAttestation(
    { memberId: peer.memberId, deviceId: peer.deviceId, createdAt },
    await importSigPublic(ub64(peer.sigPubRaw)),
    await importKexPublic(ub64(peer.kexPubRaw)),
  );
  if (att.deviceShort !== peer.deviceShort) {
    // P2 in advance. `deviceShort` is DERIVED inside `buildDeviceAttestation` and never accepted
    // from a caller, so a mismatch means the channel handed us a short and a key that do not go
    // together — which is what a substituted key looks like.
    throw new Error(
      `attestPeer: the peer's deviceShort (${peer.deviceShort}) is not the short of the key it sent `
      + `(${att.deviceShort}). Refusing to vouch for it.`);
  }
  const blob = await attestDevice(att, recSig.privateKey);
  const back = await verifyAttestation(blob, recSig.publicKey);
  if (!back) throw new Error('attestPeer: the blob we just minted does not verify — refusing to store it');
  return { attestation: back, blob };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Local storage of the things that are not board content
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `board.json` holds the BOARD. A space key, a peer's attestation and the sealed outbox are none
// of those, and ADR 006 §9.2 is explicit that `ops.jsonl` holds plaintext op lines. They live in
// `localStorage` under their own keys, per space, which is exactly what `storage.js` would give
// them if it owned a slot for each — and it does not yet. **OWED to `storage.js`'s owner** (see
// `sync/personal.js` §4(b)): three named slots, so a Tauri build writes them beside `board.json`
// instead of in the WebView's storage.

const LS_RING = (spaceId) => `langzeitplaner.ring.${spaceId}`;
const LS_PEERS = (spaceId) => `langzeitplaner.peers.${spaceId}`;
const LS_SEALED = 'langzeitplaner.sealed';
const LS_PARKED = 'langzeitplaner.parked';
const LS_CHAIN = 'langzeitplaner.chainheads';

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* a full disk is not a crash */ }
}

/** @returns {Array<[number, string]>} epoch → base64url raw key */
function loadRing(spaceId) {
  const o = readJSON(LS_RING(spaceId), {});
  return Object.entries(o)
    .map(([e, k]) => [Number(e), k])
    .filter(([e, k]) => Number.isInteger(e) && e >= 1 && typeof k === 'string')
    .sort((a, b) => a[0] - b[0]);
}

export function saveRingEpoch(spaceId, epoch, rawB64u) {
  const o = readJSON(LS_RING(spaceId), {});
  o[String(epoch)] = rawB64u;
  writeJSON(LS_RING(spaceId), o);
}

async function importSpaceKey(rawB64u) {
  // EXTRACTABLE, exactly as `createSpaceKey` mints them: every epoch key must stay wrappable
  // to every future joiner for as long as the space exists (ADR 002 §4.2).
  return crypto.subtle.importKey('raw', ub64(rawB64u), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

/** @returns {Array<{deviceId:string, deviceShort:string, blob:string, attestation:Object|null}>} */
function loadPeers(spaceId) {
  const rows = readJSON(LS_PEERS(spaceId), []);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r && typeof r.deviceId === 'string' && typeof r.blob === 'string')
    .map((r) => ({ ...r, attestation: r.attestation || null }));
}

export function savePeer(spaceId, row) {
  const rows = loadPeers(spaceId).filter((r) => r.deviceId !== row.deviceId);
  rows.push(row);
  writeJSON(LS_PEERS(spaceId), rows);
}

/**
 * The `envelopeStore` port `sync/personal.js` asks for — ADR 003 §8.1 vs ADR 006 §9.2.
 *
 * §8.1 says the outbox IS `ops.jsonl`, "i.e. sealed envelopes"; §9.2 and `store.js` say
 * `ops.jsonl` holds PLAINTEXT op lines, and they are right to, because a checkpoint of
 * ciphertext folds nothing. The disagreement is invisible until a relaunch with a non-empty
 * outbox: the ops would be re-derived from the log, re-sealed with a fresh iv and a fresh
 * non-deterministic signature, and refused `409 forked_op_id` — a laptop closed on a train, i.e.
 * the ordinary case for story 19.1.
 */
function sealedEnvelopeStore() {
  return {
    load(spaceId) { return readJSON(`${LS_SEALED}.${spaceId}`, []); },
    save(spaceId, envs) { writeJSON(`${LS_SEALED}.${spaceId}`, envs); },
  };
}

/**
 * The `parkStore` port — P-8's third axis, and the INBOUND twin of `sealedEnvelopeStore` above.
 *
 * That one keeps the sealed bytes this device still owes the relay. This one keeps the sealed
 * bytes the relay has already handed over and this device cannot open YET: an op from a Mac whose
 * attestation has not arrived, an epoch whose key has not been fetched, an envelope version or an
 * op kind only a newer build knows. ADR 002 §5.2.5 and ADR 003 §4 both say those are PARKED and
 * never dropped, and `core/oplog.js` cannot hold them — three of the four park reasons are
 * decided BEFORE the decrypt, so there is no op to give it.
 *
 * Same shape as every other record store here, one key per space. `sync/outbox.js`'s
 * `createParkingLot` owns the cap, the replay order and the refuse-rather-than-drop rule; this is
 * only the I/O `src/js/sync/` may not do for itself (ADR 005 §2).
 */
function parkedEnvelopeStore() {
  return {
    durable: true,
    async loadRecords() { return readJSON(LS_PARKED, []); },
    async saveRecords(rows) { writeJSON(LS_PARKED, rows); },
  };
}

/**
 * The `chainStore` port — where ADR 002 §5.4's verified chain HEAD is kept between launches.
 *
 * NOT a transport cursor. ADR 006 §9.1 W1 keeps that in `checkpoint().cursors`, written by
 * `store.js` below the board, and `sync/personal.js` still reads `store.cursor()` and nothing
 * else as `since`. What lives here is the chain value the witness verified up to, so a relay that
 * forks the stream ACROSS a relaunch is caught on the first page rather than adopted as the new
 * truth. `sync/cursor.js` owns the record shape and its hostile-input reading.
 */
function chainHeadStore() {
  return {
    async loadCursors() { return readJSON(LS_CHAIN, {}); },
    async saveCursors(all) { writeJSON(LS_CHAIN, all); },
  };
}

export { mintSpaceId, createSpaceKey, IdentityUnavailableError, PROTOCOL };
