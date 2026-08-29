// src/js/family/mount.js — THE ONE DOOR.  LZP-505 · ADR 003 §7 gate 2 · ADR 002 §2.4.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THERE IS EXACTLY ONE OF THESE, AND WHY IT IS THIS FILE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Family mode is five modules — `engine.js`, `pairflow.js`, `pairingui.js`, `syncstatus.js`,
// `familysettings.js` — and behind them the whole of `crypto/`, `sync/` and `platform/net.js`.
// Solo mode must evaluate none of them, which ADR 002 §2.4 states as *"First run mints only a
// memberId and a deviceShort. NO KEYGEN, NO PROBE, NO NETWORK"* and ADR 003 §7 gate 2 states as
// *"reached only through a dynamic `await import()` gated on `spaces.personal ||
// spaces.family`"*.
//
// The honest form of that is a claim about the STATIC import graph, and the way it goes wrong in
// practice is not a missing `if` — it is a second door. One convenience `await import()` in
// `settings.js` "just to draw the section", one in `main.js` "just for the glyph", and solo mode
// is loading `crypto/` again with nobody noticing, because each door on its own looked lazy.
//
// So this file is the ONLY module the boot graph reaches dynamically, and everything family mode
// needs is reached statically FROM HERE. `tests/tier1/network-scope.test.js` §2 asserts exactly
// that, over the real graph: no STATIC path from `boot.js` / `firstrun.js` / `main.js` into
// `crypto/`, `sync/` or `net.js`, and exactly ONE dynamic door, which is this file.
//
// The corollary is the shape of the two UI seams:
//
//   · `syncstatus.js`'s chrome is refreshed through a callback `main.js` is handed, not through
//     a dynamic import in `redraw()`;
//   · `settings.js` never mentions `family/` at all. It exposes `setFamilySections(fn)` and this
//     file calls it. A solo settings sheet has a null callback and draws nothing.

import { store } from '../store.js';
import { setFamilySections } from '../settings.js';
import {
  readFamilyConfig, armStore, startEngine, createSpaceOnRelay, adoptOnRelay,
  attestPeer, savePeer, saveRingEpoch, mintSpaceId, createSpaceKey, FAMILY_PREFS,
} from './engine.js';
import { createPairingFlow } from './pairflow.js';
import { initPairingUI } from './pairingui.js';
import { initSyncStatus, refreshSyncChrome } from './syncstatus.js';
import { buildFamilySections } from './familysettings.js';
import { initCreateJoin, familyCircle, circleTransport, CIRCLE_ROLE } from './createjoin.js';
import { initMembersUI, renderFamilyLegend } from './membersui.js';
import { initAdminPanel } from './adminpanel.js';
import { createFetchTransport } from '../platform/net.js';
import { exportRawPublic, signBytes } from '../crypto/identity.js';
import { b64u } from '../core/b64.js';

const ports = () => ({
  now: () => Date.now(),
  schedule: (ms, fn) => setTimeout(fn, ms),
  unschedule: (h) => clearTimeout(h),
  invoke: globalThis.window?.__TAURI__?.core?.invoke,
});

/**
 * STEP 2 — before `store.init()`. Returns null when this Mac is solo, which is every field the
 * caller has to check.
 *
 * @param {Object} settings the RAW `board.json` settings, read before the store exists
 * @param {{today:string}} opts
 */
export async function arm(settings, opts) {
  const cfg = readFamilyConfig(settings);
  if (!cfg) return null;
  const armed = await armStore(store, cfg, { today: opts.today, invoke: ports().invoke });
  return { cfg, armed, parts: null };
}

/**
 * STEP 4 — after `store.init()`. The transport, the engine, the two screens and the settings
 * sections, in that order, because each one needs the one before it.
 *
 * @param {Object} handle what `arm()` returned
 * @param {{onChange:Function}} hooks
 */
export async function start(handle, hooks) {
  const p = ports();
  handle.parts = await startEngine(store, handle.armed, {
    ...p,
    isOnline: () => globalThis.navigator?.onLine !== false,
    onStatus: () => refreshSyncChrome(),
  });

  initSyncStatus({ sync: handle.parts.sync, now: p.now, schedule: p.schedule, unschedule: p.unschedule });
  initPairingUI({
    port: makePairingFlow(handle, hooks),
    now: p.now,
    schedule: p.schedule,
    unschedule: p.unschedule,
  });
  installSections(handle, hooks);
  refreshSyncChrome();
  return handle;
}

/**
 * The settings sections, for BOTH cases — armed and not.
 *
 * A Mac with no space still needs „Familienkreis", because that section is the opt-in. So this
 * is called from `start()` (armed) and from `mountSolo()` (not), and the sections themselves ask
 * `store.state.settings` which case they are in rather than being told twice.
 */
function installSections(handle, hooks) {
  setFamilySections((body, api) => {
    syncCircleMounts(hooks);               // re-evaluated per sheet, see below
    refreshRoster();                       // fire-and-forget
    return buildFamilySections(body, api, {
      onOptIn: (origin) => optIn(origin, hooks),
    });
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// E6 — THE FAMILIENKREIS MODULES, BEHIND THE SAME ONE DOOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `createjoin.js`, `membersui.js` and `adminpanel.js` reach the network and the key store, so by
// this file's own rule they may be imported only from here. They ship their own DEFAULT_PORTS
// (the product's real clock, key store and transport), so `initCreateJoin()` and
// `initAdminPanel()` are called with nothing: the defaults ARE the wiring, and calling them makes
// the mount explicit and resets any state a previous mount left behind.
//
// `initMembersUI` is the one that needs a real port, because the member list is a join of two
// sources that live in two different modules — see `MembersPort` in `membersui.js`.
//
// ⚠ `setProfile` IS DELIBERATELY ABSENT, and that is a report rather than an oversight. Writing
// my own name and colour (15.6) needs a `member.set` entry in `core/ops.js`'s `MUTATIONS` table,
// and that table is documented as "every v1 `store.mutate()` site, mapped — all 22 sites" with
// `tests/tier1/core-ops.test.js` enumerating them independently. The op CONSTRUCTOR exists
// (`memberSet`, `ops.js:651`); the mutation and the publish path do not. `membersui.js` reacts to
// the absent port by disabling the two fields and saying so, which is the honest rendering. The
// day the mutation lands, `setProfile` is one property here.

/** The pseudonymous roster the relay publishes, cached because `membersUIState()` is sync. */
let rosterCache = [];
let rosterFor = null;

/** What `syncCircleMounts` last mounted for, so a no-op sheet-open does not re-install. */
let mountedFor = null;

/**
 * Mount the three circle modules — or UNMOUNT the member surfaces when there is no circle.
 *
 * ⚠ THE UNMOUNT IS THE WHOLE POINT, and it is a fix for a bug this wiring had for one revision.
 * `membersSupported()` is `!!port`, so mounting a port unconditionally made „Familie" render in
 * the settings sheet of a Mac that had never heard of a Familienkreis — a section, a heading and
 * a member row, on a solo install. That is precisely what story 15.1 forbids, and it was
 * invisible to `buildMembersSection`'s own guard because the guard asks whether a port exists,
 * not whether a circle does. So the CIRCLE decides, and it decides on every sheet open rather
 * than once at install: a Mac becomes a member in the middle of a session (that is the join
 * flow), and a Mac stops being one in the middle of a session (that is 20.3).
 *
 * `initCreateJoin()` and `initAdminPanel()` are unconditional and that is correct — both draw
 * from `familyCircle()` directly and are already silent without one, and `createjoin.js` must be
 * armed BEFORE there is a circle, because it is what creates one.
 */
function syncCircleMounts(hooks) {
  initCreateJoin();
  initAdminPanel();
  const circle = familyCircle();
  const key = circle ? circle.spaceId : null;
  if (key === mountedFor) return;
  mountedFor = key;
  if (!circle) { initMembersUI(); rosterCache = []; rosterFor = null; return; }
  initMembersUI({
    observe: true,
    onChange: () => { try { hooks?.onChange?.(); } catch { /* a redraw that throws is not ours */ } },
    port: {
      me: () => familyCircle()?.memberId ?? null,
      adminId: () => currentAdminId(),
      keysPending: () => familyCircle()?.keysPending === true,
      roster: () => rosterCache,
    },
  });
}

/**
 * Who the circle's admin is, from the log — `space.set{admin}` folded into the `space:` register.
 *
 * NOT from `familyCircle().role`. That pref says what THIS Mac believes about ITSELF and would
 * answer `null` for everyone on a member's Mac, so nobody but the admin would ever see the
 * „Verwaltung" badge. The register is the circle's shared answer, which is the one 15.4 wants.
 * It falls back to my own pref only when the log has not folded a chain yet — the minutes right
 * after `POST /spaces`, when the only member IS me.
 */
function currentAdminId() {
  const c = familyCircle();
  if (!c) return null;
  try {
    const cells = store.registers().get(`space:${c.spaceId}`);
    const admin = cells && cells.get('admin');
    if (admin && typeof admin.value === 'string') return admin.value;
  } catch { /* a store with no log yet is the fallback case below, not an error */ }
  return c.role === CIRCLE_ROLE.admin ? c.memberId : null;
}

/**
 * Refresh the roster from the relay, at most once per open sheet.
 *
 * This is the ONLY thing that makes D9's pre-wrap list render as colours instead of an empty
 * panel: before any member device has wrapped the keys, the joiner can decrypt no `member.set`
 * op at all, so the log knows nobody. `colorRef` is the one member fact `memberProjection`
 * publishes in the clear, and `readMembers` treats it as a second opinion about colour only.
 *
 * Failure is silent on purpose. A roster we could not fetch means the list falls back to the log,
 * which is the correct rendering and not an error worth a sentence (19.3).
 */
async function refreshRoster() {
  const c = familyCircle();
  if (!c || !c.origin) { rosterCache = []; rosterFor = null; return; }
  try {
    const transport = await circleTransport(c.origin);
    const res = await transport.request('GET', `/api/v1/spaces/${c.spaceId}/members`, undefined, undefined);
    if (res.status !== 200 || !res.json) return;
    rosterCache = (res.json.members || []).map((m) => ({
      memberId: m.memberId, colorRef: m.colorRef ?? null, removedAt: m.removedAt ?? null,
    }));
    rosterFor = c.spaceId;
  } catch { /* see the doc comment: an unreachable relay is not a sentence */ }
}

/** Exported for the integration harness, which drives the roster without opening a sheet. */
export { refreshRoster, currentAdminId, syncCircleMounts };

/**
 * Mount the family settings AND the joiner half of pairing, on a Mac that has not opted in.
 *
 * This is the one thing a solo install loads this file for, and it is loaded only when a human
 * opens the settings sheet — never at boot. `main.js` calls it from the ⚙ handler, so the
 * promise "solo mode evaluates none of this" holds for every launch in which nobody goes
 * looking for the feature.
 *
 * **The joiner needs no identity and no space**, which is the whole reason the second Mac can be
 * a fresh install: ADR 002 §6.3 step 4 is an ANONYMOUS read and step 5 an anonymous write, and
 * the device keys are minted inside the session at step 8. All it needs from the human is the
 * relay's address, which is the field one section up.
 */
export function mountSolo(hooks) {
  installSections(null, hooks);
  initPairingUI({ port: makeJoinerFlow(hooks), ...timerPorts() });
}

/**
 * Mount the circle's BOARD surfaces at boot — the member legend (17.3) and the member list.
 *
 * Called by `main.js` only when `board.json` already names a `familySpaceId`, so a solo Mac
 * never reaches it and Principle 7 is untouched. It exists because the two gates are not the
 * same gate: `armFamilyMode()` opens on `syncEnabled && personalSpaceId`, which is story 19.4's
 * PERSONAL space, and a Mac can be in a Familienkreis without ever having opted into own-device
 * sync. Before this, such a Mac showed no member chips in its legend until somebody happened to
 * open the settings sheet — the members were known, and simply not drawn.
 *
 * It arms no engine and sends nothing: the roster refresh is the one request, it is a GET, and
 * it fails silently. The board is already on screen by the time this runs.
 */
export function mountCircleSurfaces(hooks) {
  installSections(null, hooks);
  syncCircleMounts(hooks);
  renderFamilyLegend();
  refreshRoster().then(() => renderFamilyLegend());
}

const timerPorts = () => {
  const p = ports();
  return { now: p.now, schedule: p.schedule, unschedule: p.unschedule };
};

/** Whatever address the human has typed into „Familienkreis" so far. */
const currentOrigin = () => String(store.state.settings[FAMILY_PREFS.origin] || '').trim();

/**
 * An anonymous transport that is rebuilt per call, because the origin is a field a human is
 * still typing into. Cheap: `createFetchTransport` holds no connection and no state.
 */
const lazyAnon = () => ({
  request: (...args) => {
    const origin = currentOrigin();
    if (!origin) {
      return Promise.reject(Object.assign(
        new Error('pairing: no server address — fill in „Familienkreis" first'), { code: 'config' }));
    }
    const p = ports();
    return createFetchTransport({
      anonymous: true, origin, clientVersion: CLIENT_V,
      now: p.now, schedule: p.schedule, unschedule: p.unschedule,
    }).request(...args);
  },
});

const CLIENT_V = '2.0.0';

/** The second Mac's flow: no identity, no space, no signed transport. */
function makeJoinerFlow(hooks) {
  return createPairingFlow({
    transport: null,
    anonTransport: lazyAnon(),
    identity: null,
    recovery: null,
    keyring: null,
    spaceId: null,                       // whatever the payload names is what this Mac joins
    selfShort: null,
    today: new Date().toISOString().slice(0, 10),
    ...timerPorts(),
    invoke: ports().invoke,
    warn: (m) => console.warn('[pairing]', m),
    onPaired: (r) => onPaired(null, r, hooks),
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The opt-in — story 19.4, the first Mac
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Create the personal space on the relay and record it in `board.json`.
 *
 * The identity is minted here and not at boot: ADR 002 §2.4 is explicit that key generation
 * "happens at the family opt-in moment and nowhere else", and this function IS that moment.
 *
 * The order is: identity → space key → `POST /spaces` → settings. The settings write is LAST on
 * purpose. It is the flag that makes the next launch arm family mode, so writing it before the
 * relay has accepted the space would leave a Mac that arms into a space nobody has heard of and
 * 404s on every push.
 */
async function optIn(origin, hooks) {
  const p = ports();
  const today = new Date().toISOString().slice(0, 10);
  const spaceId = mintSpaceId('personal');
  const armed = await armStoreForOptIn(origin, spaceId, today);

  const transport = createFetchTransport({
    origin,
    deviceShort: armed.forStore.deviceShort,
    sign: (bytes) => signBytes(armed.identity.devSig.privateKey, bytes),
    clientVersion: '2.0.0',
    now: p.now,
    schedule: p.schedule,
    unschedule: p.unschedule,
  });

  const spaceKey = await createSpaceKey();
  await createSpaceOnRelay({ transport }, armed, spaceKey);

  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', spaceKey));
  saveRingEpoch(spaceId, 1, b64u(raw));

  store.setSettings({
    [FAMILY_PREFS.enabled]: true,
    [FAMILY_PREFS.origin]: origin,
    [FAMILY_PREFS.space]: spaceId,
  });
  await store.persistNow();
  if (hooks && typeof hooks.onChange === 'function') hooks.onChange('settings');
}

/**
 * The opt-in's own `armStore`, which differs from the boot one in exactly one way: it must NOT
 * call `store.usePersonalSpace()`, because this store has already been `init()`ed and that call
 * would (correctly) throw. The board is re-derived into the space on the next launch — ADR 006
 * §9.4, and it costs nothing because `board.json` is the truth.
 */
async function armStoreForOptIn(origin, spaceId, today) {
  const stub = {
    usePersonalSpace() { /* deliberately inert — see the docblock */ },
    useIdentity() { /* the store is already running; the next launch adopts it */ },
    diagnostics: () => ({}),
  };
  return armStore(stub, { origin, spaceId }, { today, invoke: ports().invoke });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Pairing — story 19.5, and the attestation hop (see engine.js's header)
// ═════════════════════════════════════════════════════════════════════════════════════════════

function makePairingFlow(handle, hooks) {
  const p = ports();
  const { cfg, armed, parts } = handle;
  return createPairingFlow({
    transport: parts.transport,
    // ANONYMOUS — ADR 002 §6.3 step 4 is performed by a Mac with no identity the relay knows.
    anonTransport: createFetchTransport({
      anonymous: true, origin: cfg.origin, clientVersion: '2.0.0',
      now: p.now, schedule: p.schedule, unschedule: p.unschedule,
    }),
    identity: armed.identity,
    recovery: armed.recovery,
    keyring: { personal: { spaceId: cfg.spaceId, epochs: parts.keyring.keysByEpoch(cfg.spaceId) }, family: null },
    spaceId: cfg.spaceId,
    selfShort: armed.forStore.deviceShort,
    today: new Date().toISOString().slice(0, 10),
    now: p.now,
    schedule: p.schedule,
    unschedule: p.unschedule,
    invoke: p.invoke,
    warn: (m) => console.warn('[pairing]', m),
    onPaired: (r) => onPaired(handle, r, hooks),
  });
}

/**
 * What a completed pairing changes on THIS Mac.
 *
 * The existing Mac's half is the attestation hop and nothing else: it vouches for the new device
 * with the member's own recovery key, over fields that came off the SAS-authenticated channel,
 * and stores the blob so `openOp`'s P1 can answer for the peer's short. Then it tells the store
 * the peer is one of its own devices and re-judges anything held for want of exactly that.
 *
 * The new Mac's half is a whole configuration: it has just learnt which member it belongs to,
 * which space, and the key ring. It writes them and reloads, because `usePersonalSpace()` may
 * not be called after `init()`.
 */
async function onPaired(handle, r, hooks) {
  if (r.role === 'existing') {
    const { armed, cfg } = handle;
    const peer = r.peer;
    const { attestation, blob } = await attestPeer(
      { ...peer, memberId: armed.forStore.memberId },
      armed.recovery.recSig,
      armed.today,
    );
    savePeer(cfg.spaceId, {
      deviceId: peer.deviceId, deviceShort: peer.deviceShort, blob, attestation,
    });
    armed.attestations.set(attestation.deviceShort, attestation);
    store._peerDevices.add(peer.deviceId);
    // The held lines, re-judged. Without this, everything the new Mac wrote before its
    // attestation arrived stays parked until some later batch happens to trigger the sweep.
    store.unparkAttested();
    if (hooks && typeof hooks.onChange === 'function') hooks.onChange('settings');
    return;
  }

  // ── THE NEW MAC ──────────────────────────────────────────────────────────────────────────
  //
  // Six steps, and the order is the dependency order, not a preference:
  //
  //   1  the ring, to disk, so this Mac can read the board it is about to pull
  //   2  `POST /devices/adopt`, ANONYMOUSLY — the relay learns this device's public keys, which
  //      is what makes step 4's signatures verify. It is unauthenticated by design: the
  //      attestation signature under `Member.recoveryPubSig` is the authorization, and the relay
  //      already holds that key.
  //   3  a signed transport, now that step 2 has made one meaningful
  //   4  the peer's `kexPubRaw`, off the roster — see engine.js's header for why this ONE field
  //      may come from the relay and `sigPubRaw` may not
  //   5  the peer's attestation, minted under the member's own recovery key
  //   6  the settings, LAST, because they are the flag the next launch arms on
  const origin = handle ? handle.cfg.origin : currentOrigin();
  for (const [epoch, key] of r.epochs) {
    // eslint-disable-next-line no-await-in-loop
    const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', key));
    saveRingEpoch(r.spaceId, epoch, b64u(raw));
  }

  const p = ports();
  const anon = lazyAnon();
  const adoptBody = {
    spaceId: r.spaceId,
    memberId: r.memberId,
    deviceId: r.identity.deviceId,
    deviceShort: r.identity.deviceShort,
    sigPubRaw: b64u(await exportRawPublic(r.identity.devSig.publicKey)),
    kexPubRaw: b64u(await exportRawPublic(r.identity.devKex.publicKey)),
    attestation: r.blob,
  };
  const adopted = await anon.request('POST', '/api/v1/devices/adopt', undefined, adoptBody);
  if (adopted.status !== 200) {
    throw new Error(`devices/adopt → ${adopted.status} ${JSON.stringify(adopted.json)}`);
  }

  const signed = createFetchTransport({
    origin,
    deviceShort: r.identity.deviceShort,
    sign: (bytes) => signBytes(r.identity.devSig.privateKey, bytes),
    clientVersion: CLIENT_V,
    now: p.now, schedule: p.schedule, unschedule: p.unschedule,
  });
  const roster = await signed.request('GET', `/api/v1/spaces/${r.spaceId}/members`, undefined, undefined);
  const kexPubRaw = findPeerKex(roster.json, r.memberId, r.peer.deviceId);
  if (kexPubRaw) {
    const { attestation, blob } = await attestPeer(
      { ...r.peer, memberId: r.memberId, kexPubRaw },
      r.recovery.recSig,
      new Date().toISOString().slice(0, 10),
    );
    savePeer(r.spaceId, {
      deviceId: r.peer.deviceId, deviceShort: r.peer.deviceShort, blob, attestation,
    });
  } else {
    // Not fatal and not silent: without it this Mac parks the other Mac's ops (P1) until the
    // roster carries the device. `sync/personal.js` holds the cursor rather than dropping them.
    console.warn('[pairing] the roster carries no kexPubRaw for the other Mac yet; its ops will park');
  }

  store.setSettings({
    [FAMILY_PREFS.enabled]: true,
    [FAMILY_PREFS.origin]: origin,
    [FAMILY_PREFS.space]: r.spaceId,
  });
  await store.persistNow();
  globalThis.location?.reload();
}

/** The other device of MY member, in the roster the relay publishes. */
function findPeerKex(body, memberId, deviceId) {
  const members = body && Array.isArray(body.members) ? body.members : [];
  for (const m of members) {
    if (m.memberId !== memberId) continue;
    for (const d of m.devices || []) {
      if (d.deviceId === deviceId && typeof d.kexPubRaw === 'string') return d.kexPubRaw;
    }
  }
  return null;
}

export { refreshSyncChrome, createSpaceOnRelay, adoptOnRelay, exportRawPublic };
