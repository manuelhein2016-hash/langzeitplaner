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
  readCircleConfig, armCircleIdentity, startFamilyEngine, CIRCLE_PENDING_PREF,
} from './engine.js';
import { createPairingFlow } from './pairflow.js';
import { initPairingUI } from './pairingui.js';
import { initSyncStatus, refreshSyncChrome } from './syncstatus.js';
import { buildFamilySections } from './familysettings.js';
import { initCreateJoin, familyCircle, circleTransport, CIRCLE_ROLE } from './createjoin.js';
import { initMembersUI, renderFamilyLegend } from './membersui.js';
import { initAdminPanel } from './adminpanel.js';
// A7 / LZP-702 — the popover's sharing cluster. It arrives as a PORT, not as an import from
// `popover.js`, and that is ADR 003 §7 gate 2: `boot.js -> main.js -> popover.js` is the SOLO
// graph, so a static `import './family/sharing.js'` inside `popover.js` makes solo mode statically
// reach `src/js/family/`, which `tests/tier1/network-scope.test.js` §2 refuses. Installed HERE,
// behind the one dynamic door, solo mode cannot render the cluster for two independent structural
// reasons: `stripV2Fields` leaves no `visibility` field on any entry for it to change, AND not one
// byte of the module is evaluated.
import { useSharing, memberNameOf } from '../popover.js';
import { installConflictNotice } from './conflict.js';
import * as sharing from './sharing.js';
import { chooseTransport } from '../platform/net.js';
// LZP-1009 / E10-1009-A — the one binding `feedback/port.js` has been waiting for. `feedback/`
// imports nothing that can open a socket (that is the whole reason it holds a PORT), so the
// module that already owns a transport binds it, and that module is this one — the single dynamic
// door ADR 003 §7 gate 2 allows. `port.js` is a leaf: importing it here adds no reachability.
import { setFeedbackPort, FEEDBACK_PATH } from '../feedback/port.js';
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
 * STEP 2, THE OTHER CASE — **a Mac that is in a Familienkreis and has opted into nothing else.**
 *
 * `arm()` above gates on `syncEnabled && personalSpaceId`, which is story 19.4's OWN-DEVICE sync.
 * Mama joined a circle from a Mac with one Mac; she has `familySpaceId` and none of those three.
 * So `armStore` never ran for her, `store.useIdentity()` was never called, and her store went on
 * running under the EPHEMERAL per-process identity that `store.js` mints when nothing durable is
 * handed in. Three consequences, each of which stops the circle dead:
 *
 *   · `_me` is not her MemberId, so `attestMyDevice` would attest a member who does not exist and
 *     `sealOp` §5.2.2 check 5 (`att.memberId !== op.act`) refuses every op she authors;
 *   · `_short` is random rather than `crock32(SHA-256(sigPubRaw))`, so `createFamilySync`'s own
 *     construction check (`me.deviceShort !== store._short`) throws before the engine exists;
 *   · `foldAuthorized` compares `op.act === me`, so her own ops would not be hers.
 *
 * **IT IS A SEPARATE FUNCTION AND NOT A WIDER `arm()` BECAUSE IT MUST NOT ADOPT A PERSONAL
 * SPACE.** `armStore` calls `usePersonalSpace(cfg.spaceId)`; a circle-only Mac has no `psp_` and
 * adopting one it never created would arm an engine into a space the relay has never heard of —
 * which is exactly what `armCircleIdentity`'s own docblock says it exists to avoid. So this
 * adopts the IDENTITY and nothing else, and `useFamilySpace()` (which may legitimately be called
 * after `init()`, because there is no family placeholder to have stamped anything wrongly) is
 * left to `startFamilyEngine`.
 *
 * **BEFORE `store.init()`, like `arm()` and for `useIdentity()`'s own ordering rule**: the spine
 * is minted from `board.json` at `init()` with whatever identity is current, so an identity
 * adopted afterwards leaves this session's history authored by the temporary one.
 *
 * Principle 7 is untouched: the caller's gate is `familySpaceId`, and a Mac that has opted into
 * nothing has none. Nothing here reaches the network.
 *
 * @param {Object} settings the RAW `board.json` settings, read before the store exists
 * @param {{today:string}} opts
 */
export async function armCircle(settings, opts) {
  const circle = readCircleConfig(settings);
  if (!circle) return null;
  const armed = await armCircleIdentity({ today: opts.today, invoke: ports().invoke });
  if (armed.forStore.memberId !== circle.memberId) {
    // The same refusal `startFamilyEngine` makes, one step earlier, where the store has not yet
    // been pointed at anything. See its docblock: two member ids in one process is silent and
    // permanent.
    throw new Error(
      `family: this Mac's durable identity is member ${armed.forStore.memberId}, but board.json `
      + `says the Familienkreis member is ${circle.memberId}. Refusing to adopt either.`);
  }
  store.useIdentity({ ...armed.forStore });
  circleArmed = armed;
  return armed;
}

/** What `armCircle()` opened, so `startCircleEngine` does not open the key store a second time. */
let circleArmed = null;

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
  // The circle's own engine, on a Mac that has BOTH. `armed` is reused rather than re-opened:
  // opening the key store twice on a real Mac is two IndexedDB handles and two chances to mint a
  // second identity, which is `armStore`'s own reason for existing.
  startCircleEngine(hooks, handle.armed);
  // LZP-1009. A Mac with BOTH engines is bound by the CIRCLE one, so that `spaceKind` reads
  // `family` — and it is decided here by asking, not by racing: both binders are async, so
  // "last one wins" would be a coin flip on a slow key export rather than a rule.
  if (!readCircleConfig(store.state && store.state.settings)) bindFeedback(handle.parts, 'personal');
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
// (the product's real clock, key store and transport), so `initCreateJoin()` is called with
// nothing: the defaults ARE the wiring, and calling it makes the mount explicit and resets any
// state a previous mount left behind.
//
// `initMembersUI` and `initAdminPanel` are the two that need a real port, and for the same
// reason: both answer a question that is a JOIN of two sources living in two different modules.
// `initMembersUI` — see `MembersPort` in `membersui.js`. `initAdminPanel` needs exactly one
// property, `roster`, because a LEAVE authors no op and so only the relay's roster knows about
// it — and because a count taken with NO roster is a different fact from a count taken with one
// (finding F-SHELL-2; the whole argument is on `adminpanel.js#eligibleCosigners`). Both are
// handed the SAME `rosterCache`.
//
// `setProfile` IS story 15.6's write half, and it is one property because `core/ops.js` now has
// the mutation (`setMyProfile`, row 23) and `store.useFamilySpace()` has a caller. It was absent
// for one round and `membersui.js` reacted by DISABLING the two fields and saying so — the honest
// rendering, and the reason its `selfEditSupported()` asks about the port rather than assuming.
//
// **The memberId is not an argument here and cannot be.** `core/ops.js`'s row takes it from
// `ctx.act`, because ADR 001 §4.2 admits a `member.set` only on `op.act === memberId`: "rename
// Mama from my Mac" is not a call anybody can write.

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
 * armed BEFORE there is a circle, because it is what creates one. `initAdminPanel`'s one port is
 * a lambda over `rosterCache` rather than the array, so it is read at the moment the count is
 * taken and not at the moment the sheet was mounted — and the `!circle` branch below, which
 * empties the cache, is therefore seen by it too.
 */
function syncCircleMounts(hooks) {
  initCreateJoin();
  // The ONE port `adminpanel.js` cannot build for itself: the relay's roster, which is the only
  // list on this Mac that knows who has LEFT (a leave authors no op — the relay purges the
  // leaver's ops in the same transaction, `handlers/lifecycle.js:229`). It is the SAME array
  // `initMembersUI` is handed below, deliberately, and it is a lambda so both read `rosterCache`
  // at the moment the question is asked rather than at the moment the sheet was mounted.
  //
  // ⚠ This does NOT close F-SHELL-2, and `adminpanel.js#eligibleCosigners` says why at length:
  // `membersui.js#readMembers` already applies `removedAt`, so the count was already right
  // whenever `rosterCache` was populated. What the shell measured is `rosterCache` being EMPTY at
  // the moment of the count. What this line buys is that the count can now TELL that state from
  // "nobody has left" and answer `null` instead of a ceiling.
  initAdminPanel({ roster: () => rosterCache });
  const circle = familyCircle();
  const key = circle ? circle.spaceId : null;
  if (key === mountedFor) return;
  mountedFor = key;
  // 16.3 / A7 — the cluster mounts and UNMOUNTS with the circle, in the same breath as the member
  // surfaces and for the same reason (20.3): a Mac that has left may not keep a control that
  // writes a `visibility` register nothing will ever publish.
  useSharing(circle ? sharing : null);
  if (!circle) { initMembersUI(); rosterCache = []; rosterFor = null; return; }
  initMembersUI({
    legend: true,
    onChange: () => { try { hooks?.onChange?.(); } catch { /* a redraw that throws is not ours */ } },
    port: {
      me: () => familyCircle()?.memberId ?? null,
      adminId: () => currentAdminId(),
      keysPending: () => familyCircle()?.keysPending === true,
      roster: () => rosterCache,
      /** 15.6 — see the block above. `displayName`/`colorRef` are both optional in the op. */
      setProfile: async ({ displayName, colorRef }) => {
        store.apply('setMyProfile', { displayName, colorRef });
        // The local prefs as well: they are what the circle section and the join screen render
        // before the op has folded, and on a Mac whose keys have not arrived (D9) they are all
        // there is.
        store.setSettings({ familyDisplayName: displayName, familyColorRef: colorRef });
        if (typeof store.persistNow === 'function') await store.persistNow();
      },
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
      // `devices` is carried through because ADR 002 §8.5's stated mitigation for "a member
      // attests an outsider's Mac" is that the roster SHOWS how many devices each member has —
      // and `membersui.js` renders it from this field. Dropping it here left that mitigation
      // built and fed by nothing, which is what `e6-attack-keydelivery` §5d measured (T5-K4).
      // The LENGTH is what is read; the rows themselves carry only public keys and ids.
      devices: Array.isArray(m.devices) ? m.devices : [],
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
 * ⚠ **THIS DOCBLOCK USED TO SAY "it arms no engine and sends nothing", AND THAT SENTENCE WAS THE
 * BUG.** `docs/v2/E6-VERIFICATION.md` §5.2 measured its consequence: Mama's Mac, a full member of
 * a Familienkreis, made **zero** `/ops` requests in 8 s of idling after joining, and none on any
 * subsequent launch — so D9's waiting state could be entered and never left. It now arms the
 * FAMILY engine (`startCircleEngine`), which is what makes the calm sentence on her screen come
 * true. The board is still on screen before any of it runs, and a solo Mac still reaches none of
 * it: the gate is `familySpaceId`, and a Mac that has opted into nothing has none.
 */
export function mountCircleSurfaces(hooks) {
  installSections(null, hooks);
  syncCircleMounts(hooks);
  renderFamilyLegend();
  refreshRoster().then(() => renderFamilyLegend());
  // 18.5 — THE LOST-EDIT NOTICE, and it is installed HERE for the same reason the legend is:
  // this is the circle-only board path, so a solo Mac reaches no part of it (Principle 7) and a
  // Mac in a circle gets it whether or not it ever opts into 19.4's own-device sync.
  //
  // `nameOf` is `memberNameOf` — the SAME 17.6 roster port `popover.js` installs — so the notice
  // and the attribution line name the same person the same way, rather than two modules each
  // resolving a member id and disagreeing about Mama.
  //
  // It reads `me` through `store.diagnostics()`, not by importing `family/engine.js`: a UI module
  // must not pull the sync engine into its import graph (ADR 005 §2, Principle 7).
  conflictNotice = installConflictNotice({ store, nameOf: memberNameOf });
  startCircleEngine(hooks, null);
}

/** The 18.5 notice's handle, so `leave`/`delete` can stop it. One per launch, like the engine. */
let conflictNotice = null;

/** Tear the 18.5 notice down — the leave/delete path (20.3), where there is no circle left. */
export function stopConflictNotice() {
  if (conflictNotice && typeof conflictNotice.stop === 'function') conflictNotice.stop();
  conflictNotice = null;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CIRCLE'S ENGINE — ADR 002 §7.1 steps 4-6, PO decision D9 part 4
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The family engine, once started. One per launch, because one circle per install (20.6). */
let circleParts = null;
let circleStarting = null;

/**
 * Arm the family sync engine for this Mac's Familienkreis.
 *
 * **IDEMPOTENT AND FIRE-AND-FORGET.** It is called from two places that can both happen in one
 * launch — `start()` on a Mac that also syncs its own two Macs, and `mountCircleSurfaces()` on a
 * Mac that only ever joined a circle — and from the join flow, which turns a Mac into a member in
 * the middle of a session. None of the three may block a redraw, and none of them may arm a
 * second engine: two engines on one space would be two cursors, two parking lots and two devices'
 * worth of pulls from one Mac.
 *
 * `onKeys` is D9 part 4, and it is the only place the waiting state is cleared:
 *
 *   > "The next member device to sync wraps the keys — no action required from anyone, and no
 *   >  notification demanded of them. It must not need any particular person to *notice* anything."
 *
 * The ring grew, so the sentence Mama was shown has come true, so the flag that renders it is
 * written to `board.json` and the board is redrawn. Nobody clicked anything.
 *
 * @param {{onChange?:Function}} hooks
 * @param {Object|null} armed reuse `armStore()`'s identity when this launch already opened one
 */
export function startCircleEngine(hooks, armed) {
  if (circleParts || circleStarting) return circleStarting;
  const circle = readCircleConfig(store.state && store.state.settings);
  if (!circle) return null;
  const p = ports();
  circleStarting = (async () => {
    // `armCircle()` (step 2) already opened the key store on a circle-only Mac and adopted the
    // identity; `start()` (step 4) already did on a Mac that has both. Opening it a third time
    // is two IndexedDB handles and a second chance to mint an identity — `armStore`'s own reason
    // for existing. The fallback is the JOIN FLOW, which turns a Mac into a member in the middle
    // of a session, after both of those have already run and found nothing.
    const id = armed || circleArmed || await armCircleIdentity({ today: todayISO(), invoke: p.invoke });
    if (!circleArmed) circleArmed = id;
    circleParts = await startFamilyEngine(store, id, circle, {
      ...p,
      isOnline: () => globalThis.navigator?.onLine !== false,
      onStatus: () => refreshSyncChrome(),
      onKeys: () => {
        // D9's waiting state, cleared BY THE ARRIVAL OF THE KEYS and by nothing else.
        if (store.state.settings[CIRCLE_PENDING_PREF] !== false) {
          store.setSettings({ [CIRCLE_PENDING_PREF]: false });
          if (typeof store.persistNow === 'function') store.persistNow().catch(() => {});
        }
        refreshRoster().then(() => renderFamilyLegend()).catch(() => {});
        try { hooks?.onChange?.('settings'); } catch { /* a redraw that throws is not ours */ }
      },
    });
    bindFeedback(circleParts, 'family');   // LZP-1009 — last binder wins; see `bindFeedback`
    return circleParts;
  })()
    .catch((e) => {
      // A circle whose engine will not start still has its board and its member list. The one
      // thing that must not happen is a thrown promise on the boot path.
      console.warn('[family] the circle engine did not start:', e);
      return null;
    })
    .finally(() => { circleStarting = null; });
  return circleStarting;
}

/** The family engine, for the admin panel's removal + rotation (20.2) and for tests. */
export function circleEngine() { return circleParts; }

const todayISO = () => new Date().toISOString().slice(0, 10);

const timerPorts = () => {
  const p = ports();
  return { now: p.now, schedule: p.schedule, unschedule: p.unschedule };
};

/** Whatever address the human has typed into „Familienkreis" so far. */
const currentOrigin = () => String(store.state.settings[FAMILY_PREFS.origin] || '').trim();

/**
 * An anonymous transport that is rebuilt per call, because the origin is a field a human is
 * still typing into. Cheap: neither transport holds a connection or any state.
 */
const lazyAnon = () => ({
  request: (...args) => {
    const origin = currentOrigin();
    if (!origin) {
      return Promise.reject(Object.assign(
        new Error('pairing: no server address — fill in „Familienkreis" first'), { code: 'config' }));
    }
    const p = ports();
    // LZP-1002 — `chooseTransport`, not `createFetchTransport`: in the shipped shell a `fetch`
    // is blocked by `default-src 'self'`, so an anonymous adopt/redeem that reached for one
    // could never complete inside the app. Anonymous or signed, the shell is the transport.
    return chooseTransport({
      anonymous: true, origin, clientVersion: CLIENT_V,
      now: p.now, schedule: p.schedule, unschedule: p.unschedule, invoke: p.invoke,
    }).transport.request(...args);
  },
});

const CLIENT_V = '2.0.0';

/**
 * ── LZP-1009 · BINDING „Rückmeldung senden" TO THE RELAY THIS MAC ALREADY TALKS TO ───────────
 *
 * `E10-1009-A` (FINDINGS §18c) was: `setFeedbackPort(...)` existed and nothing called it, so
 * `canSend()` was false on every Mac, „Senden" was disabled, and the screen said so honestly.
 * This is the caller.
 *
 * THREE THINGS IT IS NOT, EACH ONE DELIBERATE:
 *
 *   · It is not a second door. `feedback/port.js` is a leaf module — it imports `nothing that can
 *     open a socket` by its own header, and it is imported HERE, behind the one dynamic import
 *     the boot graph makes. `tests/tier1/network-scope.test.js` §2 still measures one door.
 *   · It is not an origin. The port carries `send`, never a URL: the path is fixed at
 *     `FEEDBACK_PATH` in this one line, and `net.js#assertReachable` refuses every path outside
 *     the one prefix at the other end. Nothing downstream can point the sender somewhere else.
 *     (Written without a quoted path literal on purpose: `tests/attack/privacy-e5-endpoint.test.js`
 *     §5 enumerates the addressable set by reading these files' raw bytes, and a path in a comment
 *     would enter that set as if the product could build it.)
 *   · It is not telemetry. Nothing here sends anything. It makes a button pressable; the person
 *     writes the text, reads the whole payload on the preview screen, and presses „Senden".
 *
 * THE SHAPE CORRECTION `port.js`'s header could not know. A transport answers
 * `{status, headers, json}` (`platform/net.js`), and a `FeedbackPort` promises `{status, body}`
 * (`feedback/ui.js#doSend` reads `res.body.error`). The suggested one-liner would have handed the
 * screen `body: undefined` and turned every named server refusal — `payload_too_large`,
 * `rate_limited`, `not_implemented` — into the generic failure sentence. So it is mapped here.
 *
 * SIGNING IS OPTIONAL AND IS SUPPLIED. `handlers/feedback.js` accepts an anonymous report and
 * records `proves: 'unsigned'`; with a device signature it records `device_continuity`, which is
 * what lets a maintainer tell two reports from one Mac apart from two Macs. The key is the
 * device signing key that already signs every sync request, and `signBytes` is the only thing
 * that can cross that boundary (`IK_sig` is `extractable: false`).
 *
 * @param {Object} parts what `startEngine` / `startFamilyEngine` returned
 * @param {'personal'|'family'} spaceKind which engine bound it — `report.js#SPACE_KINDS`
 */
async function bindFeedback(parts, spaceKind) {
  try {
    const transport = parts && parts.transport;
    if (!transport || typeof transport.request !== 'function') return;
    const devSig = parts.armed && parts.armed.identity && parts.armed.identity.devSig;
    let devicePub;
    let sign;
    if (devSig && devSig.publicKey && devSig.privateKey) {
      devicePub = b64u(await exportRawPublic(devSig.publicKey));
      sign = (bytes) => signBytes(devSig.privateKey, bytes);
    }
    setFeedbackPort({
      send: async (body) => {
        const r = await transport.request('POST', FEEDBACK_PATH, undefined, body);
        return { status: r.status, body: r.json };
      },
      ...(devicePub ? { devicePub, sign } : {}),
      appVersion: CLIENT_V,
      spaceKind,
    });
  } catch (e) {
    // A feedback button that cannot be bound is a disabled button with a sentence on screen —
    // never a boot failure. The screen's own `noRelay` line is the honest rendering of this.
    console.warn('[feedback] the sender could not be bound:', e);
  }
}

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

  const { transport } = chooseTransport({
    origin,
    deviceShort: armed.forStore.deviceShort,
    sign: (bytes) => signBytes(armed.identity.devSig.privateKey, bytes),
    clientVersion: '2.0.0',
    now: p.now,
    schedule: p.schedule,
    unschedule: p.unschedule,
    invoke: p.invoke,   // LZP-1002 — the shell transports; see lazyAnon above
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
    anonTransport: chooseTransport({
      anonymous: true, origin: cfg.origin, clientVersion: '2.0.0',
      now: p.now, schedule: p.schedule, unschedule: p.unschedule, invoke: p.invoke,
    }).transport,
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

  const { transport: signed } = chooseTransport({
    origin,
    deviceShort: r.identity.deviceShort,
    sign: (bytes) => signBytes(r.identity.devSig.privateKey, bytes),
    clientVersion: CLIENT_V,
    now: p.now, schedule: p.schedule, unschedule: p.unschedule, invoke: p.invoke,
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

/**
 * ── F-SHELL-2, THE MEASUREMENT THE REPORT COULD NOT MAKE ─────────────────────────────────────
 *
 * `adminpanel.js#eligibleCosigners` answers a different question depending on whether this Mac
 * holds a roster: with one, the count is log ∩ roster; with none, a positive count is a CEILING
 * and is reported as `null`. `docs/v2/SHELL-VERIFICATION.md` §5 recorded **2** on a Mac where no
 * log state can produce 2 with a roster present — so `rosterCache` must have been empty at that
 * moment, and F-SHELL-2 is a FRESHNESS defect rather than a missing intersection.
 *
 * That sentence was not decidable from `adminpanel.js` and `mount.js` alone: it needs the number
 * recorded beside the count, on the real binary, in the phase that measured it. This is that
 * accessor, and it is READ-ONLY and a COPY — nothing outside this module may hold the live array
 * and nothing may write it.
 *
 * @returns {Array<Object>} a copy of the roster this Mac last fetched; `[]` means "none yet"
 */
export function rosterSnapshot() { return rosterCache.slice(); }

export { refreshSyncChrome, createSpaceOnRelay, adoptOnRelay, exportRawPublic };
