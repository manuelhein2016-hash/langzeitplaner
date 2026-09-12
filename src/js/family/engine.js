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
import { openDeviceIdentity, selfAttest, buildAttestOpen, IdentityUnavailableError } from '../platform/device-identity.js';
import {
  signBytes, exportRawPublic, importSigPublic, importKexPublic,
  buildDeviceAttestation, attestDevice, verifyAttestation, ensureRecoveryIdentity,
} from '../crypto/identity.js';
import {
  createKeyRing, createSpaceKey, wrapSpaceKey, createSpaceWraps, recoveryRecipientId,
} from '../crypto/spacekeys.js';
import { createPersonalSync, createPersonalPublisher, CADENCE } from '../sync/personal.js';
import { createFamilySync } from '../sync/family.js';
import { spaceId as mintSpaceId } from '../core/ids.js';
import { b64u, ub64 } from '../core/b64.js';


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
    // SCOPED. Both slots below are ONE key for the whole device and both engines write them, so
    // each port declares the space it is a slice of — see the block above `parkedEnvelopeStore`.
    parkStore: parkedEnvelopeStore(armed.cfg.spaceId),
    chainStore: chainHeadStore(armed.cfg.spaceId),
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
    // 19.2 — "others' changes arrive automatically — ON APP FOCUS and every ~30–60 s". The focus
    // half was missing, and `visibilitychange` does not cover it: `document.hidden` flips when the
    // window is minimised, occluded or the app is hidden, NOT when it merely loses key status to
    // another app while staying visible. That is the common case — click Safari, read something,
    // click back — and it produced no pull at all, so a peer's entry could sit unseen for up to a
    // minute with the board in front of you. `wake()` cancels and re-arms the timer, so an extra
    // focus event cannot double-fire or stack requests.
    globalThis.addEventListener('focus', wake);
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
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠ TWO BUGS FIXED HERE, BOTH OF THEM SILENT AND BOTH OF THEM MEASURED AGAINST THE LIVE RELAY.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **1 · `device.attestation` — finding E2E3-7.** The note that stood here said the field "has two
 * spellings on two endpoints … `POST /spaces` reads it with `readBytes` (base64url of opaque
 * bytes, never verified)". That was true of the relay this line was written against and has not
 * been true since E2E3-7 closed: `server/core/handlers/spaces.js` now reads the RAW BLOB on every
 * route that writes one (`readAttestationBlob`, ASCII, `b64u '.' b64u`) and VERIFIES it under
 * `member.recoveryPubSig`. So `b64u(TE.encode(blob))` — base64url of the blob's UTF-8 — no longer
 * matches `/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`, because the encoding swallows the dot.
 *
 * The consequence was not a degraded path, it was a dead one: **`POST /spaces` answered
 * `400 bad_shape` and the personal opt-in could not complete against the shipping server.**
 * `adoptOnRelay`, ten lines down, sent `armed.myBlob` raw and was right all along; the two call
 * sites in one file disagreed, and the one nobody had driven end to end was the broken one.
 *
 * **2 · the hand-rolled wrap packer — finding E2E3-2.** `wrapTo` built the `KeyWrap.wrapped`
 * column as `b64u(TE.encode(JSON.stringify(blob)))`. ADR 002 §4.2's amendment is explicit that
 * `encodeWrap`/`decodeWrap` in `crypto/spacekeys.js` "are the only two functions that perform it",
 * and it names the exact program that got this wrong before — `server/dev/two-client.js`, which
 * "hand-rolled its own packer and carried the sender key by courier, and so stepped over every gap
 * instead of hitting one". This was that second translator. `JSON.stringify` is not
 * `canonicalBytes`, so the same blob could reach the column in two spellings, and `putKeyWraps`
 * upserts on `(spaceId, epoch, recipientId)`: two spellings of one value are two rows waiting to
 * happen. `createSpaceWraps` is the sanctioned door and it is what is used now.
 */
export async function createSpaceOnRelay(engineParts, armed, spaceKey) {
  const { transport } = engineParts;
  const id = armed.forStore;
  const devSigPub = b64u(await exportRawPublic(armed.identity.devSig.publicKey));
  const devKexPub = b64u(await exportRawPublic(armed.identity.devKex.publicKey));
  const recSigPub = b64u(await exportRawPublic(armed.recovery.recSig.publicKey));
  const recKexPub = b64u(await exportRawPublic(armed.recovery.recKex.publicKey));

  const wrapTo = async (pubB64u) => wrapSpaceKey(
    spaceKey, armed.identity.devKex.privateKey, await importKexPublic(ub64(pubB64u)),
    { spaceId: armed.cfg.spaceId, epoch: 1 },
  );

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
      // THE RAW BLOB, exactly as `adoptOnRelay` has always sent it. See bug 1 above.
      attestation: armed.myBlob,
    },
    wraps: createSpaceWraps([
      { deviceId: id.deviceId, epoch: 1, wrapped: await wrapTo(devKexPub) },
      { deviceId: recoveryRecipientId(id.memberId), epoch: 1, wrapped: await wrapTo(recKexPub) },
    ]),
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
// THE FAMILIENKREIS — ADR 002 §7.1 steps 4–6, D9, and the second engine
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `docs/v2/E6-VERIFICATION.md` §5.2 measured this as an absence: "a Familienkreis arms no engine
// at all … Mama's Mac, a full member, made **zero** `/ops` requests in 8 s of idling after
// joining, and makes none on any subsequent launch." Everything below is the wiring that ends
// that sentence, and it is deliberately a SECOND arming path rather than a branch inside the
// first one, because the two gates are genuinely different gates:
//
//     armFamilyMode()  opens on  syncEnabled && personalSpaceId   ← story 19.4, MY two Macs
//     armCircleMode()  opens on  familySpaceId                    ← story 15.3, MY family
//
// `mount.js#mountCircleSurfaces` already says why in its own docblock: "a Mac can be in a
// Familienkreis without ever having opted into own-device sync." Such a Mac has a `familySpaceId`
// and no `personalSpaceId`, `readFamilyConfig()` answers `null` for it, and before this it
// therefore armed nothing at all — which is exactly Mama's Mac in §5.2's measurement.

/**
 * The one settings key this file needs from the create/join flow.
 *
 * **RESTATED rather than imported, and the reason is a cycle, not laziness.**
 * `family/createjoin.js` owns `CIRCLE_PREFS` and imports `store.js`, `settings.js`, `palette.js`
 * and `i18n.js`; `mount.js` imports both files; and this module is imported BY `createjoin.js`'s
 * neighbours. An import edge from here into `createjoin.js` would put a UI module inside the door
 * that is supposed to open onto it. `tests/tier1/sync-family.test.js` §5 asserts this string
 * equals `CIRCLE_PREFS.space`, so the copy cannot drift without a red test — the same discipline
 * `sync/personal.js` applies to the protocol constants it restates from the contract file.
 */
export const CIRCLE_SPACE_PREF = 'familySpaceId';
/** Mirrors `CIRCLE_PREFS.member`, pinned by the same test. */
export const CIRCLE_MEMBER_PREF = 'familyMemberId';
/** Mirrors `CIRCLE_PREFS.pending` — D9's waiting state, as a durable fact. */
export const CIRCLE_PENDING_PREF = 'familyKeysPending';

/**
 * What a circle config has to carry before a family engine is worth starting.
 *
 * The origin is SHARED with `FAMILY_PREFS.origin` because there is one relay, and the space id is
 * checked for its prefix here rather than trusted: a `psp_` id in this slot would be handed to
 * `createFamilySync`, which refuses it — but a refusal at boot with a message about a settings key
 * is a better diagnostic than a refusal three frames deeper about a space kind.
 *
 * @param {Object} settings the store's settings, or the raw `board.json` settings
 * @returns {{origin:string, spaceId:string, memberId:string}|null}
 */
export function readCircleConfig(settings) {
  const s = settings || {};
  const origin = typeof s[FAMILY_PREFS.origin] === 'string' ? s[FAMILY_PREFS.origin].trim() : '';
  const spaceId = typeof s[CIRCLE_SPACE_PREF] === 'string' ? s[CIRCLE_SPACE_PREF] : '';
  const memberId = typeof s[CIRCLE_MEMBER_PREF] === 'string' ? s[CIRCLE_MEMBER_PREF] : '';
  if (!origin || !spaceId.startsWith('fsp_') || !memberId) return null;
  return Object.freeze({ origin, spaceId, memberId });
}

/**
 * The durable identity, WITHOUT a space and WITHOUT touching the store.
 *
 * `armStore()` above does the same work and then calls `usePersonalSpace()` + `useIdentity()`,
 * which a circle-only Mac must not do — it has no personal space to adopt, and adopting one it
 * has not created would arm an engine into a space the relay has never heard of.
 *
 * @param {{today:string, invoke?:Function}} ports
 */
export async function armCircleIdentity(ports) {
  const { today, invoke } = ports || {};
  const { store: ks, kind: custody } = chooseKeyStore({ invoke });
  const opened = await openDeviceIdentity(ks, { today, custody, allowMemoryCustody: false });
  const recovery = opened.recovery
    ? opened.recovery
    : await ensureRecoveryIdentity(ks, opened.forStore.memberId, {});
  const mine = await selfAttest(ks, opened.forStore, recovery.recSig.privateKey, { createdAt: today });
  return Object.freeze({
    ks, today, custody,
    identity: opened.identity,
    recovery,
    forStore: opened.forStore,
    myAttestation: mine.attestation,
    myBlob: mine.blob,
  });
}

/**
 * ADR 001 §4.0 — publish this device's own attestation into the family log, ONCE, ever.
 *
 * **THE REGISTER IS CHECKED FIRST AND THAT IS NOT AN OPTIMISATION.** `selfAttest` re-signs on
 * every launch and ECDSA is randomised, so the blob this launch minted is a DIFFERENT STRING
 * from the one already in the log even though both attest the same six fields and both verify
 * under the same recovery key. §4.0's write-once is an *admissibility* rule, so `attestMyDevice`
 * refuses a second blob loudly — correctly, because it cannot tell a harmless re-mint from
 * somebody else's blob being written into my record.
 *
 * Measured before this guard: every relaunch of a Mac already in a circle logged
 * „dev.<short> is already attested with a different blob … peers will park its ops as
 * unattestedDevice", which was **alarming and false** — the register already held a good
 * attestation and no peer was parking anything. A warning that cries wolf on every ordinary
 * launch is worse than no warning, because the launch on which it means something looks the same.
 *
 * So: a register that already holds ANY blob for my short is the write-once rule being satisfied,
 * and there is nothing to do. Only a genuinely absent claim is published, and only that path can
 * still fail loudly.
 *
 * ── F-SHELL-4 · WHY A GUARD OVER THE REGISTER IS NOT ENOUGH ON ITS OWN ───────────────────────
 *
 * The register is the right question and it is the whole of the answer only while the log can be
 * remembered. A Mac whose log has been QUARANTINED writes no history at all (ADR 006 §9.5), so
 * `registers()` cannot carry `dev.<short>` however many times this device has published it — and
 * this guard therefore mints a fresh op, with the same blob, on every launch, each of which
 * every peer refuses `writeOnce` for ever. That is F-SHELL-4, and its cause was
 * `store.js#_persistOps` creating `ops.jsonl` before `checkpoint.json` existed; step ⓪b closes
 * it, so the state below is now reachable only by a log that is genuinely refused.
 *
 * **IT STILL PUBLISHES, AND THAT IS DELIBERATE.** Skipping the claim here would be E6-1 from the
 * far side — a Mac that never attests is a Mac whose every op every peer parks, permanently —
 * and the one launch on which a quarantined Mac has genuinely never published is exactly the
 * launch that must. So it publishes and SAYS what it has done, once, naming the cause: the next
 * person to read a peer's `writeOnce` ledger is told a re-mint happened, not a forgery.
 */
function publishMyAttestation(store, armed) {
  const short = armed.forStore.deviceShort;
  try {
    const held = store.registers().get(`member:${armed.forStore.memberId}`)?.get(`dev.${short}`);
    if (held !== undefined && typeof held.value === 'string' && held.value !== '') return;
  } catch { /* no register view yet — fall through and let the constructor decide */ }
  // Asked BEFORE the op is authored, because afterwards the answer is the same and the sentence
  // would be about a fact the reader can no longer act on. `logIsWritable` is ADR 006 §9.5's own
  // verdict, not a second copy of it.
  const durable = typeof store.logIsWritable !== 'function' || store.logIsWritable();
  try {
    const authored = store.apply('attestMyDevice', { deviceShort: short, blob: armed.myBlob });
    if (authored && !durable) {
      console.warn('[family] this Mac published its device attestation (ADR 001 §4.0) into a log '
        + 'it cannot write — its history is quarantined or the session is read-only, so nothing '
        + 'here will remember the claim and the next launch will publish it again. The blob is '
        + 'unchanged and the device stays attested; what your family\'s Macs will report is a '
        + '`writeOnce` refusal per extra copy (ADR 001 §4.0 admits only the first). This is a '
        + 're-publication, not a forgery. Fix the quarantined log and it stops.');
    }
  } catch (e) {
    console.warn('[family] this Mac could not publish its own device attestation (ADR 001 §4.0). '
      + 'Peers will park its ops as `unattestedDevice` until this is resolved:', e.message);
  }
}

/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * `openOp`'s P1 FOR A FAMILY SPACE — where the verification key comes from, and what it costs.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `attestationOf(deviceShort)` is the one input `openOp` cannot do without, and this file's own
 * header enumerates the three possible sources and rules two of them out for M1. In a FAMILY
 * space the arithmetic changes, and ADR 002 §4.2 step 6 changed with it (finding E2E3-6, which
 * "reverses a decision, deliberately"):
 *
 *   · THE LOG is the authority and stays the authority — but a joiner between §7.1 steps 2 and 6
 *     holds no epoch key, so it cannot fold a single family op, so the log can tell it nothing.
 *     That is not a temporary inconvenience; it is the exact window D9 creates on purpose.
 *   · PAIRING cannot reach here at all: Mama and Papa never share a SAS. They share an invite
 *     code, which by D9 carries no key material of any kind.
 *   · So it is THE ROSTER, and `GET /spaces/:id/members` now publishes `Device.attestation`
 *     precisely so this is possible.
 *
 * **AND EVERY BLOB IS VERIFIED HERE, UNDER THE HOUSING MEMBER'S OWN `recoveryPubSig`**, which is
 * what keeps the relay out: a relay that wants this device to accept a forged attestation has to
 * forge a signature under a recovery key it does not hold, or invent a whole MEMBER — recovery
 * key, attestation, the lot — and that member appears in the member list (15.4) as somebody
 * nobody invited. ADR 002 §8.5 accepts that residual by name and calls it a UI-surfaceable
 * phantom member. It is not zero and it is not hidden.
 *
 * `unproven` is the honest half of the return value: a blob whose signature did not verify is
 * DROPPED, so the ops of that device park on P1 rather than being admitted, and the count says so.
 *
 * @param {Array<Object>} members the `GET /spaces/:id/members` projection
 * @returns {Promise<{table:Map<string,Object>, unproven:number}>} deviceShort → DeviceAttestation
 */
export async function attestationsFromRoster(members) {
  const table = new Map();
  let unproven = 0;
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || typeof m.memberId !== 'string' || typeof m.recoveryPubSig !== 'string') continue;
    let recSigPub;
    try {
      recSigPub = await importSigPublic(ub64(m.recoveryPubSig));
    } catch {
      // An unusable recovery key verifies nothing. Every device of that member stays unproven,
      // which is a park and never an admission.
      unproven += Array.isArray(m.devices) ? m.devices.length : 0;
      continue;
    }
    for (const dev of Array.isArray(m.devices) ? m.devices : []) {
      if (!dev || typeof dev.attestation !== 'string' || dev.attestation === '') { unproven++; continue; }
      if (dev.revokedAt !== undefined && dev.revokedAt !== null) continue;
      let att = null;
      try { att = await verifyAttestation(dev.attestation, recSigPub); }
      catch { att = null; }
      // §2.3's conditions (2) and (3), re-checked at the point of USE rather than trusted from
      // the row: the blob must name the member whose key just verified it, and the short it
      // claims must be the short the relay filed it under. Either mismatch is a relay lying
      // about which device a genuine attestation belongs to.
      if (!att || att.memberId !== m.memberId || att.deviceShort !== dev.deviceShort) { unproven++; continue; }
      table.set(att.deviceShort, att);
    }
  }
  return { table, unproven };
}

/**
 * STEP 4 FOR THE CIRCLE — the transport, the FAMILY key ring, and `createFamilySync`.
 *
 * The ring is a SECOND `createKeyRing()` and not the personal engine's, and that separation is
 * structural rather than tidy: `KeyRing` is keyed by the FULL space id, so `get('fsp_…', 3)`
 * could not reach a `psp_` key whatever a caller intended — but two engines sharing one ring
 * would mean one `admitWraps` call away from a family sender set being asked to authorize a
 * personal admission. `admissibleSenders` refuses that by brand (§3 barrier 2); giving each
 * engine its own ring means the question is never asked.
 *
 * @param {Object} store
 * @param {Object} armed what `armCircleIdentity()` (or `armStore()`) returned
 * @param {{origin:string, spaceId:string, memberId:string}} circle
 * @param {{now:Function, schedule?:Function, unschedule?:Function, invoke?:Function,
 *          isOnline?:Function, onStatus?:Function, onKeys?:Function, fetchImpl?:Function}} ports
 */
export async function startFamilyEngine(store, armed, circle, ports) {
  const p = ports || {};
  // ONE MEMBER ID, TWO PLACES IT IS WRITTEN DOWN — and they must agree before a single wrap is
  // addressed. `circle.memberId` is `familyMemberId`, written by the create/join flow into
  // `board.json`; `armed.forStore.memberId` is the durable identity's, read out of the key store.
  // They are the same value on every honest path (both flows open the SAME identity), and if they
  // ever diverge the consequences are silent and expensive: `sealOp` check 5 refuses every op this
  // device authors (`att.memberId !== op.act`), and `keys.js` addresses the recovery wraps to
  // `rec_<the wrong member>`, which nothing would ever open. Refused here, where the message can
  // name both values, rather than three layers deeper where it can only name one.
  if (armed.forStore.memberId !== circle.memberId) {
    throw new Error(
      `family engine: this Mac's durable identity is member ${armed.forStore.memberId}, but `
      + `board.json says the Familienkreis member is ${circle.memberId}. Refusing to sync: every `
      + 'envelope sealed under the first would be refused by every peer, and every key wrapped to '
      + 'the second would be unopenable here (ADR 002 §5.2.2 checks 3 and 5).');
  }
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // THE STORE SEAM — three calls, and without them the engine runs and shares nothing.
  // ═══════════════════════════════════════════════════════════════════════════════════════════
  //
  // `store.useFamilySpace()`, `store.familyOutbound()` and `store.apply('attestMyDevice')` all
  // shipped before this line existed, and NONE OF THEM HAD A CALLER anywhere in `src/js/`. What
  // that cost, measured, one item per call:
  //
  //   1. **`useFamilySpace`** — `core/materialize.js:791` is `if (!familySpaceId) break;`, so a
  //      peer's entry folded into the register map and could not RENDER. The op landed, the board
  //      stayed empty, and nothing anywhere was in an error state. It also arms `_logMayBeWritten`
  //      for a Mac that never opted into 19.4 — the Mac E6-VERIFICATION §5.2 measured — whose
  //      family ops would otherwise never have reached disk.
  //   2. **`familyOutbound`** — `createFamilySync` falls back to `NO_OUTBOUND`, whose `lines()`
  //      returns `[]`. The push path was real and drained an empty list for ever: this build
  //      shared nothing outbound and reported it honestly as `diagnostics().outbound.wired`.
  //   3. **`attestMyDevice`** — ADR 001 §4.0. Until this device publishes `dev.<short>` into the
  //      family log, `core/authz.js` stage 0b answers `unattestedDevice` for every op every peer
  //      ever sends me, AND for every op I send them. The engine parks those correctly and
  //      nothing could ever cure them. It is E6-1 from the far side: not "my name is missing" but
  //      **the circle cannot admit a single op**.
  //
  // **THE ATTESTATION BELONGS ON AN ARMING PATH AND NOWHERE ELSE.** It must be re-published by a
  // Mac that joined before the op existed, by a second Mac of an existing member (19.4 pairing),
  // and by a Mac whose log was rebuilt from a backup — none of which is a moment the human does
  // anything. So it runs every launch, and `core/ops.js`'s row is IDEMPOTENCE-GATED for exactly
  // that reason: §4.0's write-once is an *admissibility* rule, so an ungated call here would mint
  // one permanently-dead op per launch. Same blob -> `DECLINED`; different blob -> it throws, and
  // the throw is caught below because a Mac whose attestation cannot be published still has a
  // board, a member list and a working personal sync.
  store.useFamilySpace(circle.spaceId);
  publishMyAttestation(store, armed);

  const { transport, kind } = chooseTransport({
    origin: circle.origin,
    deviceShort: armed.forStore.deviceShort,
    sign: (bytes) => signBytes(armed.identity.devSig.privateKey, bytes),
    clientVersion: CLIENT_VERSION,
    now: p.now,
    schedule: p.schedule,
    unschedule: p.unschedule,
    invoke: p.invoke,
    fetchImpl: p.fetchImpl,
  });

  const keyring = createKeyRing();
  for (const [epoch, raw] of loadRing(circle.spaceId)) {
    // eslint-disable-next-line no-await-in-loop
    keyring.put(circle.spaceId, epoch, await importSpaceKey(raw));
  }

  // The P1 table, refreshed from the roster on every key pass. It starts with MY OWN attestation
  // because `sealOp` mirrors the far-side gate (ADR 002 §5.2.2): a device that cannot attest
  // itself cannot seal its own ops.
  const attestations = new Map([[armed.forStore.deviceShort, armed.myAttestation]]);

  // ── THE SECOND TABLE, AND IT IS NOT THE SAME TABLE ──────────────────────────────────────────
  //
  // `attestations` above is `openOp`'s P1: deviceShort → attestation, "whose signing key do I
  // check this ENVELOPE against". `attestOpen` is `foldAuthorized` stage 0a: (memberId, blob) →
  // attestation, "does this `dev.*` REGISTER WRITE verify under its housing member's recovery
  // key". Two questions, two keys, two lookups — and until this line the second had no answer at
  // all, so every peer's attestation op was rejected `badAttestation` and every op behind it
  // parked `unattestedDevice` for ever. See `store.setAttestOpen`.
  //
  // It is installed as a STABLE closure over a mutable slot rather than re-installed per refresh,
  // so a roster read that fails leaves the previous answer standing instead of blanking it — an
  // unreachable relay must never look like "nobody in this family can be verified".
  let attestOpenFn = () => null;
  store.setAttestOpen((memberId, blob) => attestOpenFn(memberId, blob));

  const refreshAttestations = async (members) => {
    const { table } = await attestationsFromRoster(members);
    for (const [short, att] of table) if (!attestations.has(short)) attestations.set(short, att);
    // `buildAttestOpen` verifies every blob against its own member's `recoveryPubSig` and DROPS
    // whatever does not verify, so the map it returns is exactly the set stage 0a may admit. My
    // own row is included: this Mac folds its OWN attestation op back through `applyRemote` on
    // the sync after it is published, and a device that cannot verify itself would reject it.
    const rows = (Array.isArray(members) ? members : [])
      .filter((m) => m && typeof m.memberId === 'string' && typeof m.recoveryPubSig === 'string')
      .map((m) => ({
        memberId: m.memberId,
        recoveryPubSigRaw: m.recoveryPubSig,
        blobs: (Array.isArray(m.devices) ? m.devices : [])
          .map((dv) => dv && dv.attestation)
          .filter((b) => typeof b === 'string' && b !== ''),
      }));
    if (rows.length) attestOpenFn = await buildAttestOpen(rows);
    return attestations.size;
  };

  const sync = createFamilySync({
    store,
    transport,
    keyring,
    sigPriv: armed.identity.devSig.privateKey,
    kexPriv: armed.identity.devKex.privateKey,
    recoveryKexPriv: armed.recovery.recKex.privateKey,
    spaceId: circle.spaceId,
    me: {
      memberId: circle.memberId,
      deviceId: armed.forStore.deviceId,
      deviceShort: armed.forStore.deviceShort,
    },
    attestationOf: (dv) => attestations.get(dv) || null,
    attestation: armed.myAttestation,
    now: p.now,
    schedule: p.schedule,
    unschedule: p.unschedule,
    isOnline: p.isOnline,
    onStatus: p.onStatus,
    onKeys: p.onKeys,
    // Every roster read refreshes BOTH attestation tables — see `refreshAttestations` above and
    // `sync/keys.js#roster`. Without it a member who joins after this launch is unattested here
    // until the app is restarted, and every op they author parks on P1.
    onRoster: (members) => refreshAttestations(members),
    saveKey: async (epoch, key) => {
      const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key));
      saveRingEpoch(circle.spaceId, epoch, b64u(raw));
    },
    envelopeStore: sealedEnvelopeStore(),
    // SCOPED — the other half of the pair `startEngine` builds. Without the space id these two
    // ports are the personal engine's ports, over the personal engine's rows.
    parkStore: parkedEnvelopeStore(circle.spaceId),
    chainStore: chainHeadStore(circle.spaceId),
    coverStore: coverageStore(),
    // The outbound half. One property, and it is the whole of it — see the block above.
    outbound: store.familyOutbound(),
  });

  // The roster is read once at start so the FIRST pull already has a P1 table — without it every
  // envelope on a launch would park on `attestation`, be re-served on the next poll, and the
  // board would fill in one cadence tick late for no reason.
  try {
    const seed = await sync.keys.roster();
    if (seed.ok) await refreshAttestations(seed.members);
  } catch { /* an unreachable relay at launch is not a sentence (19.3); the next pass asks again */ }

  sync.attach();
  const cadence = driveCadence(sync, p);
  return Object.freeze({ transport, transportKind: kind, keyring, sync, armed, circle, cadence, refreshAttestations });
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
//
// ONE OF THEM IS NOT PER SPACE, and that is a fact about the disk rather than an oversight:
// `LS_CHAIN` is one map for the device, and both engines write it. That port therefore DECLARES
// the space it is a slice of (`space: spaceId`) and the module that owns the data —
// `sync/cursor.js` — merges on write and adopts only its own record on read. See that file's
// header; the ports below stay dumb on purpose.
//
// `LS_PARKED` USED TO BE THE SECOND, AND IS NOT ANY MORE. A slot is a per-space slot — the shape
// `LS_SEALED` has always had — because the cap that bounds a lot is per space and the write that
// fills it was not: both engines wrote the WHOLE slot, so the personal lot's every write carried
// the family lot's whole undecryptable backlog with it, and a slot the family space had filled
// was a slot the personal space could not write into. `park()` then answered `false` for somebody
// else's reason, which `sync/outbox.js` defines as "the caller MUST NOT advance the cursor past
// this" — family traffic stalling personal sync while the family lot sat nowhere near its own
// cap. The `space:` declaration below stays, and so does the merge on the other side of the port:
// it is what makes the lot correct for ANY shared slot, and it is now belt as well as braces for
// this one (`foreign` is structurally empty here). See `tests/fleet/e6-gate-slots.test.js` §2.

const LS_RING = (spaceId) => `langzeitplaner.ring.${spaceId}`;
const LS_PEERS = (spaceId) => `langzeitplaner.peers.${spaceId}`;
const LS_SEALED = 'langzeitplaner.sealed';
const LS_PARKED = 'langzeitplaner.parked';
const LS_CHAIN = 'langzeitplaner.chainheads';
const LS_COVER = 'langzeitplaner.keycoverage';

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
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `space: spaceId` IS THE WHOLE OF THE SCOPING, AND IT IS A DECLARATION AND NOT A FILTER
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * This file builds this port TWICE — once in `startEngine` for the personal space, once in
 * `startFamilyEngine` for the family one. Two writers. The E7 red team drove what ONE SLOT cost
 * them: an ordinary family park wrote the family lot's rows over the slot and destroyed a
 * personal envelope that a ladder had shelved — the only copy on this Mac, with the cursor
 * already past it — and the family lot's undecryptable backlog counted against the PERSONAL
 * lot's cap, so `park()` answered `false` and stalled a cursor for somebody else's reason.
 *
 * The round-2 team then drove the half those two fixes are not about. The COUNT was scoped and
 * the DELETION was closed, but the WRITE was still one write over one key: every personal park
 * re-serialised the family lot's entire backlog, so a slot the family space had filled was a slot
 * the personal space could not write into at all — 24 rows under a cap of 3, and `park()` false
 * while the family lot sat nowhere near its own cap. The cap is not the lever (a cap that counted
 * the shelf would let one ladder burn-out permanently shrink a lot — `round8-park.test.js` §6.5)
 * and neither is the stall (a `park()` that answered `true` on a write that did not land is R8-5,
 * the cursor released over bytes that are not on the disk). **The lever is the key**, and it is
 * the one `LS_SEALED` beside it has always had: `${LS_PARKED}.${spaceId}`, one slot per space.
 *
 * What is left after that is one disk, honestly shared: a device whose storage is genuinely full
 * cannot write either slot, and that stall is real and correct. What was NOT honest was the
 * sentence — `writeJSON` swallowed the failure, so the lot was told the bytes had landed when
 * they had not (R8-5 in the shipped port, in production, on every full disk) and nothing named
 * the space whose backlog filled the disk. So `saveRecords` now THROWS what `localStorage` threw,
 * which is what `sync/outbox.js#persist` is written to catch, and it names the foreign slot in
 * the message the user is shown.
 *
 * This port stays as dumb as every other one here otherwise: it reads a slot and writes a slot,
 * because that is the I/O `src/js/sync/` may not do for itself (ADR 005 §2). It keeps the one
 * fact it is the only file in a position to know — WHICH SPACE THIS ONE IS FOR — because
 * `sync/outbox.js#createParkingLot` reads `space` to scope the cap, the replay set and the
 * diagnostics, and because the merge on the far side must stay correct for every OTHER caller
 * that builds its own port over a shared slot. Here it is now belt as well as braces: with a key
 * per space the lot's `foreign` set is structurally empty.
 *
 * A `spaceId` of `undefined` would put every space back in one slot named `…parked.undefined`,
 * which is why both call sites pass one and `tests/fleet/e6-attack-privat.test.js` §2a pins that
 * they do.
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
 *
 * THE LEGACY SLOT IS READ, NEVER DELETED. A Mac upgrading into this build has envelopes under the
 * old device-wide `LS_PARKED`, and they are the only copy of ops whose cursor has already moved
 * past them (ADR 002 §5.2.5: parked, never dropped). `loadRecords` therefore falls back to that
 * list — filtered to THIS space, so the other engine's rows are not adopted and not copied into
 * this slot — until this space has a slot of its own. The old key is left where it is: the other
 * space has not migrated yet, and a delete here would be exactly the silent loss that rule
 * forbids.
 *
 * EXPORTED, unlike its three neighbours, and for one reason: `tests/fleet/e6-gate-slots.test.js`
 * §2 used to REPRODUCE this port because it was module-private, and a reproduction of a defect is
 * a test that cannot see the fix — every row of it stayed green over the fixed file. It now
 * drives these bytes. Nothing in `src/` calls it but the two engines below.
 */
export function parkedEnvelopeStore(spaceId) {
  const slot = `${LS_PARKED}.${spaceId}`;
  return {
    durable: true,
    space: spaceId,
    // NOT `async`, and that is a property of the fix rather than a style choice. `localStorage`
    // is a synchronous API; wrapping it in a promise puts a microtask boundary in the middle of
    // `createParkingLot#persist`'s read-modify-write, which is where another writer over a shared
    // slot slips in. A plain value is a valid answer at every call site — all of them `await`.
    loadRecords() {
      const own = readJSON(slot, null);
      return Array.isArray(own) ? own : legacyParkedFor(spaceId);
    },
    saveRecords(rows) { writeParked(slot, rows); },
  };
}

/**
 * The pre-per-space slot, read for THIS space only. See the note above: read, never deleted, and
 * never merged into this space's slot as somebody else's rows.
 */
function legacyParkedFor(spaceId) {
  const rows = readJSON(LS_PARKED, null);
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r !== null && typeof r === 'object' && r.space === spaceId);
}

/**
 * Write one space's parked slot, and THROW when the write did not land.
 *
 * The other stores here use `writeJSON`, which swallows — losing a cached roster or a coverage
 * record to a full disk costs one extra delivery and nothing else. These bytes are different:
 * they are the only copy of ops the relay has already handed over, and `sync/outbox.js` is
 * written around the rule that a failed write is the same answer as a full lot, so that `park()`
 * returns `false` and the cursor is NOT advanced over envelopes that are not on the disk (R8-5).
 * A swallowed throw tells the lot a fact about the disk that is false. So this one propagates.
 *
 * `sync/outbox.js#persist` catches it and shows the message, which is why the message says the
 * one thing this file is in a position to know and the lot is not: whether the disk is full of
 * THIS space's envelopes or of another space's.
 */
function writeParked(slot, rows) {
  try {
    localStorage.setItem(slot, JSON.stringify(rows));
  } catch (e) {
    const name = (e && e.name) || 'Error';
    const msg = (e && e.message) || 'the write did not land';
    throw new Error(`${name}: ${msg}${foreignParkNote(slot)}`);
  }
}

/**
 * The sentence that names the OTHER space — N-7.
 *
 * A stall the user is shown says "sync has STALLED"; without this it does not say that the reason
 * is a circle they may not even be looking at. One space's backlog can still fill a device's
 * storage — that is one disk, honestly shared, and no key scheme changes it — but it must not be
 * anonymous. Best effort by construction: no `length`/`key` on the storage, or a throw from it,
 * and the sentence is simply omitted rather than guessed at.
 */
function foreignParkNote(slot) {
  let biggest = null;
  let bytes = 0;
  try {
    if (typeof localStorage.key !== 'function') return '';
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (typeof k !== 'string' || k === slot) continue;
      if (k !== LS_PARKED && !k.startsWith(`${LS_PARKED}.`)) continue;
      const n = (localStorage.getItem(k) || '').length;
      if (n > bytes) { bytes = n; biggest = k; }
    }
  } catch { return ''; }
  if (biggest === null || bytes === 0) return '';
  const other = biggest === LS_PARKED ? 'a space not yet migrated to its own slot'
    : biggest.slice(LS_PARKED.length + 1);
  return ` — and the disk is not full of THIS space's envelopes: ${other} is holding ${bytes} `
    + 'bytes of parked envelopes on the same disk. Sync for this space is stalled by that space, '
    + 'and clearing space there is what un-stalls it.';
}

/**
 * The `coverStore` port — `sync/keys.js` §4's COVERAGE PROOF, across launches.
 *
 * It holds two tiny records per space: the recipient ids this device can PROVE hold the ring, at
 * which epoch, and the last roster it read together with the epoch that reading carried. Losing
 * it is survivable and bounded — this Mac then delivers the ring once more than it had to, which
 * is one extra epoch and no lost key — and that is why it is a `localStorage` slot rather than a
 * new obligation on `board.json`.
 *
 * It is NOT key material and it is NOT a secret: every id in it is published by
 * `GET /spaces/:id/members` to every member of the circle already.
 */
function coverageStore() {
  return {
    async load(spaceId) { return readJSON(`${LS_COVER}.${spaceId}`, null); },
    async save(spaceId, record) { writeJSON(`${LS_COVER}.${spaceId}`, record); },
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
 *
 * `space: spaceId` for the same reason `parkedEnvelopeStore` carries one, and with a sharper
 * edge: `LS_CHAIN` is a MAP keyed by space, so the second engine's whole-map write did not merely
 * overwrite the personal space's anchor — it deleted the key, taking `fromGenesis` (the right to
 * call an unknown witness a fork, ADR 002 §5.4) with it. `sync/cursor.js` merges on write and
 * adopts only this space's record on read; this port only says which space that is.
 */
function chainHeadStore(spaceId) {
  return {
    space: spaceId,
    // Synchronous for the same reason `parkedEnvelopeStore` is — see the note there.
    loadCursors() { return readJSON(LS_CHAIN, {}); },
    saveCursors(all) { writeJSON(LS_CHAIN, all); },
  };
}

export { mintSpaceId, createSpaceKey, IdentityUnavailableError, PROTOCOL };
