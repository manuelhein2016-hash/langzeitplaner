// FLEET · LZP-608 — REMOVAL, END TO END, ON EVERY REMAINING MAC.
// Stories 20.2 and 20.5 · ADR 002 §4.1, §4.2, §4.3, §7.4 · ADR 001 §4.1, §4.2 · Addendum F20 §6.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A FLEET TEST AND NOT A UNIT TEST
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Story 20.2 says "**all** family boards", and the ticket says it again in its own words: *verify
// multi-device — the removal must land on every remaining member's Mac, not just the admin's.*
// That is not a claim about a function's return value. It is a claim about what a THIRD person's
// laptop shows after it performs one ordinary sync and nobody tells it anything.
//
// So there are three Macs here, each with its own disk, its own store module instance, its own
// key ring and its own device identity, talking to one relay through the REAL router, the REAL
// ADR 003 §2 auth ladder and the REAL `assertCoverage`:
//
//   PAPA  creates the circle and is its admin. He performs the removal.
//   MAMA  joins, publishes ONE shared entry, and is the member who is removed.
//   OMA   joins, sees Mama's entry on her board, and is the Mac the ticket is actually about.
//         Nothing in §3 touches Oma except `syncNow()` — the verb a 45-second cadence tick calls.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FIVE FALSE GREENS THIS FILE WAS WRITTEN TO AVOID
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   1. **the entry was never on Oma's board.** §2c asserts Mama's entry IS on Oma's board, by
//      name and by text, BEFORE the removal. A test that removed a member whose entry had never
//      rendered would prove nothing about 20.2's first clause.
//   2. **the removal was hand-applied to Oma.** §3 calls `syncNow()` and nothing else. No
//      `applyRemote`, no `foldAuthorized`, no register poke.
//   3. **the three Macs are one person.** §1a asserts three memberIds, three recovery identities
//      and three signing keys, and that Mama's entry is sealed under HER key and folded under
//      HERS. A3-H4's sentence, applied to a circle of three.
//   4. **the rotation was vacuous.** §2b asserts the epoch really moved, that the wrap set the
//      relay accepted covers Oma and NOT Mama, and that the relay's own coverage check was in the
//      path — an incomplete rotation is refused by `assertCoverage`, so completeness is proved by
//      the server rather than by this file.
//   5. **"her board is intact" was measured on an empty board.** §4 snapshots Mama's whole state
//      BEFORE the removal, asserts it is non-empty and contains her own entry, and then asserts
//      the snapshot is unchanged afterwards. An intactness test over `{notes: []}` is a tautology.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS, AND THE ROW EACH ONE KILLS  (run in a scratch copy, never in the tree)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// MEASURED, one run each, in a scratch copy of the tree:
//
//   M1  `removal.js` — the rotation is faked, never performed   → §2b · §2c · §2f · §3b
//   M2  `removal.js` — `publishRemoval` replaced by a fake ok    → §2g · §3b · §3c
//   M3  `removal.js` — `REMOVAL_PATCH` grows a second field      → §2e · and six more, because an
//                                                                  op every peer drops takes the
//                                                                  whole removal with it
//   M4  `removal.js` — mint the genesis link when none exists    → §6a
//   M5  `removal.js` — publish the op BEFORE rotating            → §2f
//   M6  `removal.js` — a softened, deleting `honesty`            → §5a · §5b · §6b
//   M7  `adminpanel.js` — `afterRemove: null` again              → §5c
//   M8  `removal.js` — ignore `seat.isMe` and publish anyway     → §6b

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { localStorage as LS, resetStorage, seedBoard } from '../helpers/env.js';

import { memKeyStore } from '../../src/js/platform/keystore.js';
import { openDeviceIdentity, selfAttest, buildAttestOpen } from '../../src/js/platform/device-identity.js';
import { exportRawPublic, importKexPublic } from '../../src/js/crypto/identity.js';
import { createKeyRing, createSpaceKey, wrapSpaceKey, encodeWrap } from '../../src/js/crypto/spacekeys.js';
import { sealOp, brandFamilyPatch } from '../../src/js/crypto/envelope.js';
import { buildRequest } from '../../src/js/platform/net.js';
import { spaceId as mkSpaceId, entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { materialize } from '../../src/js/core/materialize.js';
import { b64u } from '../../src/js/core/b64.js';

import { createRelay, simClock } from '../helpers/loopback.js';

import { createFamilySync } from '../../src/js/sync/family.js';
import { ROTATION_HONESTY, DELIVERY } from '../../src/js/sync/keys.js';
import { attestationsFromRoster } from '../../src/js/family/engine.js';
import {
  createRemoval, afterRemove, membershipOf, REMOVAL, REMOVAL_BLOCKERS, REMOVAL_COPY, REMOVAL_PATCH,
  RemovalError,
} from '../../src/js/family/removal.js';

const DAY = '2026-08-29';
const MEM = { allowMemoryCustody: true };
const ORIGIN = 'https://relay.invalid';
const S = globalThis.crypto.subtle;

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n-own', date: '2026-10-01', text: 'Mein eigener Eintrag', categoryId: 'c1' }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', colorRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const quiet = (s) => clearTimeout(s._saveTimer);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · THE HARNESS — three disks in one process, one real relay
// ═════════════════════════════════════════════════════════════════════════════════════════════

function snapDisk() {
  const o = {};
  for (const k of LS._keys()) o[k] = LS.getItem(k);
  return o;
}
function restoreDisk(image) {
  LS.clear();
  for (const k of Object.keys(image || {})) LS.setItem(k, image[k]);
}

/**
 * Run `fn` with `mac`'s disk mounted, and put the disk back afterwards.
 *
 * Every assertion about a Mac goes through this. Three Macs sharing one `localStorage` shim would
 * share one key ring, one parking lot and one board — and every row below would be measuring one
 * machine wearing three names, which is exactly false green 3.
 */
async function on(mac, fn) {
  restoreDisk(mac.disk);
  try {
    return await fn();
  } finally {
    if (mac.store) quiet(mac.store);
    mac.disk = snapDisk();
  }
}

function makeRelay() {
  const r = createRelay({ clock: simClock(Date.UTC(2026, 7, 29, 9, 0, 0)) });
  return {
    store: r.store,
    ctx: r.ctx,
    tick(ms) { r.clock.advance(ms); },
    async handle(sreq) {
      const res = await r.dispatch(sreq);
      return { status: res.status, headers: res.headers || {}, body: res.body };
    },
  };
}

/** The client Transport, built on `platform/net.js`'s own `buildRequest`. Nothing is faked but
 *  the socket: the header, the canonical query and the body bytes are the shipping client's. */
function loopbackTransport(relay, cfg, calls) {
  return {
    origin: ORIGIN,
    async request(method, path, query, body, headers) {
      const req = await buildRequest(cfg, method, path, query, body, headers);
      const url = new URL(req.url);
      const q = {};
      for (const [k, v] of url.searchParams) q[k] = v;
      const h = {};
      for (const k of Object.keys(req.headers)) h[k.toLowerCase()] = String(req.headers[k]);
      h['x-real-ip'] = '127.0.0.1';
      if (calls) calls.push(`${method} ${url.pathname}`);
      const res = await relay.handle({
        method: req.method,
        path: url.pathname,
        query: q,
        headers: h,
        body: body ?? null,
        rawBody: req.rawBody,
        clientIp: '127.0.0.1',
      });
      return { status: res.status, headers: res.headers, json: res.body };
    },
  };
}

let C = null;   // the circle: relay, three Macs, the space

async function mintMember(tag) {
  const ks = memKeyStore();
  const opened = await openDeviceIdentity(ks, { today: DAY, ...MEM });
  const att = await selfAttest(ks, opened.forStore, opened.recovery.recSig.privateKey, { createdAt: DAY });
  return {
    tag, ks,
    forStore: opened.forStore,
    identity: opened.identity,
    recovery: opened.recovery,
    myAttestation: att.attestation,
    myBlob: att.blob,
    sign: opened.sign,
    disk: {},
    store: null,
    engine: null,
    ring: createKeyRing(),
    calls: [],
  };
}

const memberRow = async (m) => ({
  memberId: m.forStore.memberId,
  recoveryPubSig: b64u(await exportRawPublic(m.recovery.recSig.publicKey)),
  recoveryPubKex: b64u(await exportRawPublic(m.recovery.recKex.publicKey)),
});

const deviceRow = async (m) => ({
  deviceId: m.forStore.deviceId,
  deviceShort: m.forStore.deviceShort,
  sigPubRaw: b64u(await exportRawPublic(m.identity.devSig.publicKey)),
  kexPubRaw: b64u(await exportRawPublic(m.identity.devKex.publicKey)),
  attestation: m.myBlob,
});

/** Papa creates a FAMILY space at epoch 1, wrapping it to his own device. */
async function buildCircle() {
  const relay = makeRelay();
  const papa = await mintMember('papa');
  const mama = await mintMember('mama');
  const oma = await mintMember('oma');
  const spaceId = mkSpaceId('family');
  const spaceKey = await createSpaceKey();
  papa.ring.put(spaceId, 1, spaceKey);

  const now = () => relay.ctx.now();
  const cfgFor = (m) => ({
    origin: ORIGIN,
    deviceShort: m.forStore.deviceShort,
    sign: m.sign,
    clientVersion: '2.0.0',
    now,
    random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    subtle: S,
  });
  for (const m of [papa, mama, oma]) m.transport = loopbackTransport(relay, cfgFor(m), m.calls);

  const devKexPub = await exportRawPublic(papa.identity.devKex.publicKey);
  const wrapped = await wrapSpaceKey(
    spaceKey, papa.identity.devKex.privateKey, await importKexPublic(devKexPub), { spaceId, epoch: 1 });
  const created = await papa.transport.request('POST', '/api/v1/spaces', undefined, {
    spaceId,
    kind: 'FAMILY',
    colorRef: 'gruen',
    member: await memberRow(papa),
    device: await deviceRow(papa),
    wraps: [{ recipientId: papa.forStore.deviceId, epoch: 1, wrapped: encodeWrap(wrapped) }],
  });
  assert.equal(created.status, 200, `POST /spaces → ${JSON.stringify(created.json)}`);

  return { relay, papa, mama, oma, spaceId, now, attestations: new Map() };
}

/** One join through the real invite + redeem pair. D9: no key material anywhere near it. */
async function join(mac) {
  const proof = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const verifier = new Uint8Array(await S.digest('SHA-256', proof));
  const inviteId = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const mk = await C.papa.transport.request('POST', '/api/v1/invites', undefined, {
    spaceId: C.spaceId, inviteId, verifier: b64u(verifier),
  });
  assert.equal(mk.status, 200, `POST /invites → ${JSON.stringify(mk.json)}`);
  const red = await mac.transport.request('POST', '/api/v1/invites/redeem', undefined, {
    inviteId,
    proof: b64u(proof),
    colorRef: mac.tag === 'mama' ? 'blau' : 'magenta',
    member: await memberRow(mac),
    device: await deviceRow(mac),
  });
  assert.equal(red.status, 200, `POST /invites/redeem → ${JSON.stringify(red.json)}`);
}

/** `openOp`'s P1 for the circle, built the way `family/engine.js` builds it: from the roster,
 *  with every blob verified under its housing member's own `recoveryPubSig`. */
async function refreshRoster(expected) {
  const list = await C.papa.transport.request(
    'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
  assert.equal(list.status, 200);
  const { table, unproven } = await attestationsFromRoster(list.json.members);
  assert.equal(unproven, 0, 'NON-VACUITY: every attestation the relay published really verifies');
  if (expected !== undefined) assert.equal(table.size, expected, `${expected} attested device(s)`);
  C.attestations = table;
  C.roster = list.json.members;
  return list.json;
}

/** Boot one Mac's store over its own disk, and adopt the circle. */
async function bootMac(mac, adopt = true) {
  mac.disk = {};
  mac.store = (await import(`../../src/js/store.js?rm-${mac.tag}`)).store;
  const attestOpen = await buildAttestOpen(await Promise.all([C.papa, C.mama, C.oma].map(async (m) => ({
    memberId: m.forStore.memberId,
    recoveryPubSigRaw: await exportRawPublic(m.recovery.recSig.publicKey),
    blobs: [m.myBlob],
  }))));
  await on(mac, async () => {
    resetStorage();
    seedBoard(BOARD());
    const s = mac.store;
    s.listeners.clear();
    s.ready = false;
    s.warnings.length = 0;
    if (!s.hasDurableIdentity()) s.useIdentity({ ...mac.forStore, peerDeviceIds: [], attestOpen });
    await s.init();
    s.warnings.length = 0;
    // ⚠ THE ONE LINE `family/engine.js#startFamilyEngine` OWES AND DOES NOT YET HAVE.
    //
    // `store.useFamilySpace()` exists, is idempotent, is documented as callable after `init()` —
    // and has NO CALLER in `src/js/`. Without it `core/ops.js:spaceFor` refuses to address a
    // family op at any space, so a Mac that must AUTHOR one has to adopt the circle.
    //
    // It is adopted here only for the Macs that author (Papa and Mama) and NOT for Oma, and that
    // asymmetry is a second report rather than a convenience: `store.js#diffCollection` calls
    // `noteKey(entry.id)` for every entry of the projected board, and a FOREIGN entry's `id` is
    // its whole entity key by design (`materialize.js#foreignCandidate`: "v1's `id` is the token
    // that addresses an entry in the state arrays, and for a foreign entry that token IS the
    // key"). So the first `persistNow()` on any board carrying a peer's shared entry throws
    // `EntityKeyError: localKey: bad note id "fnote:mem_…/…"`. One line fixes it — skip
    // `isForeign` rows in `diffCollection` — and it is `store.js`'s owner's line, not this
    // round's. Until it lands, `boardOf()` below composes the projection the way `_project()`
    // does instead of reading `store.state`.
    if (adopt) s.useFamilySpace(C.spaceId);
  });
}

/**
 * The board, composed exactly as `store._project()` composes it: `materialize()` over the folded
 * registers with `store._memberCtx()`'s three member inputs. Reading `store.state` would be
 * shorter and is not available on every Mac here — see `bootMac`'s second note.
 *
 * `currentMembers` therefore comes from the store's OWN §4.2 reader, not from this file, so a row
 * that says "her entry is gone" is measuring the product's answer and not a re-derivation of it.
 */
function boardOf(mac) {
  const regs = mac.store.registers();
  return materialize(regs, {
    me: mac.forStore.memberId,
    familySpaceId: C.spaceId,
    ...mac.store._memberCtx(regs),
    defaultSettings: mac.store.state.settings,
  }).notes;
}

/**
 * The family engine for one Mac — every port the real one, including the outbox.
 *
 * `outbound: store.familyOutbound()` is the SECOND line `startFamilyEngine` owes: the store has
 * shipped `familyOutbox()` and `familyOutbound()` and no caller passes them, so the running
 * engine's `diagnostics().outbound.wired` is `false` in the product. Supplying it here is how
 * this file proves the one-line fix is the right one rather than merely asserting it.
 */
function engineFor(mac, extra = {}) {
  return createFamilySync({
    store: mac.store,
    transport: mac.transport,
    keyring: mac.ring,
    sigPriv: mac.identity.devSig.privateKey,
    kexPriv: mac.identity.devKex.privateKey,
    recoveryKexPriv: mac.recovery.recKex.privateKey,
    spaceId: C.spaceId,
    me: {
      memberId: mac.forStore.memberId,
      deviceId: mac.forStore.deviceId,
      deviceShort: mac.forStore.deviceShort,
    },
    attestationOf: (dv) => C.attestations.get(dv) ?? null,
    attestation: mac.myAttestation,
    outbound: mac.store.familyOutbound(),
    now: C.now,
    subtle: S,
    random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    ...extra,
  });
}

/** What `family/mount.js#circleEngine()` returns, for the Mac that is driving a removal. */
function partsFor(mac, sync) {
  return {
    transport: mac.transport,
    transportKind: 'loopback',
    keyring: mac.ring,
    sync,
    armed: {
      identity: mac.identity,
      recovery: mac.recovery,
      forStore: mac.forStore,
      myAttestation: mac.myAttestation,
      myBlob: mac.myBlob,
    },
    circle: { origin: ORIGIN, spaceId: C.spaceId, memberId: mac.forStore.memberId },
  };
}

/**
 * MAMA PUBLISHES ONE SHARED ENTRY.
 *
 * ⚠ HAND-SEALED, AND THAT IS A REPORT RATHER THAN A SHORTCUT. A family `pub.set` needs ADR 004
 * §2.2's barriers: `ctx.assertFamilyPatch` (barrier 2, REQUIRED by `sealOp`) and `ctx.levelOf`
 * (barrier 4). `sync/family.js#sealLine` injects NEITHER, so the shipped engine cannot seal a
 * single shared entry today — it would quarantine it with `seal: …`. The brand and the two
 * injected ctx functions here are the same stand-ins `tests/attack/crypto-member-read.test.js`
 * uses; the product's own producer is `core/project.js#projectForFamily`, whose owner is E7.
 */
async function publishSharedEntry(mac, uuid) {
  const ctx = mac.store._ctx();
  const patch = brandFamilyPatch({
    'pub.level': 'geteilt',
    'pub.alive': true,
    'pub.date': '2026-10-14',
    'pub.text': 'Omas Geburtstag',
  }, { kind: 'fnote', level: 'geteilt' });
  // The op is assembled here rather than through `core/ops.js#pubSet`, and the reason is itself
  // the report: `makeOp` copies the patch (`{...f}`), and the brand is a NON-ENUMERABLE symbol
  // property, so the shipped constructor cannot carry it. `projectForFamily` must therefore be
  // the thing that builds the whole op, not a patch handed to `pubSet` — which is exactly what
  // `PROJECT_CONTRACT` says, and is why no product code path can seal a shared entry today.
  const op = Object.freeze({
    v: 1,
    id: ctx.newOpId(),
    ts: ctx.mint(),
    space: C.spaceId,
    act: mac.forStore.memberId,
    dev: mac.forStore.deviceId,
    gid: ctx.gid,
    k: 'pub.set',
    e: familyKey('fnote', mac.forStore.memberId, uuid),
    f: patch,
  });
  const env = await sealOp(op, mac.ring, mac.identity.devSig.privateKey, {
    v: 1, sp: C.spaceId, ep: mac.ring.currentEpoch(C.spaceId), dv: mac.forStore.deviceShort,
    oid: op.id, wit: '',
  }, { attestation: mac.myAttestation, levelOf: () => 'geteilt', assertFamilyPatch: () => {} });
  const res = await mac.transport.request('POST', '/api/v1/ops', {}, {
    space: C.spaceId, ackSeq: mac.store.cursor(C.spaceId), ops: [env], drained: true,
  }, {});
  assert.equal(res.status, 200, `POST /ops (shared entry) → ${JSON.stringify(res.json)}`);
  assert.equal((res.json.accepted || []).length, 1, 'NON-VACUITY: the shared entry really landed');
  return op;
}

/**
 * ADR 001 §4.0 — one member's own `member.set{dev.<short>}`, published into the family log.
 *
 * `authz.js` stage 0b refuses every family op from a device whose attestation has not folded, so
 * this is the op the whole circle depends on. Papa and Mama emit it through `store.apply`, i.e.
 * through the shipped `attestMyDevice` mutation; Oma emits it this way because she does not adopt
 * the circle in her store (see `bootMac`) and `store.apply` refuses a family mutation without one.
 * The OP is identical either way — same kind, same entity, same register.
 */
async function publishAttestation(mac) {
  const ctx = mac.store._ctx();
  const op = Object.freeze({
    v: 1,
    id: ctx.newOpId(),
    ts: ctx.mint(),
    space: C.spaceId,
    act: mac.forStore.memberId,
    dev: mac.forStore.deviceId,
    gid: ctx.gid,
    k: 'member.set',
    e: `member:${mac.forStore.memberId}`,
    f: { [`dev.${mac.forStore.deviceShort}`]: mac.myBlob },
  });
  const env = await sealOp(op, mac.ring, mac.identity.devSig.privateKey, {
    v: 1, sp: C.spaceId, ep: mac.ring.currentEpoch(C.spaceId), dv: mac.forStore.deviceShort,
    oid: op.id, wit: '',
  }, { attestation: mac.myAttestation });
  const res = await mac.transport.request('POST', '/api/v1/ops', {}, {
    space: C.spaceId, ackSeq: mac.store.cursor(C.spaceId), ops: [env], drained: true,
  }, {});
  assert.equal(res.status, 200, `POST /ops (attestation) → ${JSON.stringify(res.json)}`);
  return op;
}

/** The foreign entry Mama published, as it appears on somebody else's board. */
const mamaEntryOn = (mac) =>
  boardOf(mac).find((n) => n.ownerId === C.mama.forStore.memberId) || null;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE SETUP — a circle of three, one shared entry, and a board that shows it
// ═════════════════════════════════════════════════════════════════════════════════════════════

let removalReport = null;
let mamaBefore = null;
let mamaEpochsBefore = null;
let epochBefore = 0;
let rosterAtRemoval = null;

before(async () => {
  C = await buildCircle();
  await refreshRoster(1);

  // ── PAPA: the admin's own two founding ops ────────────────────────────────────────────────
  //
  // `attestMyDevice` (ADR 001 §4.0) — without it `authz.js` stage 0b refuses every op he
  // authors, including the removal. `claimAdmin` (ADR 001 §4.1) — the genesis link
  // `space.set{admin, adminPrev:null}`, without which `adminAtIn` answers `null` for every stamp
  // and 20.2's removal is inadmissible from EVERYBODY, the creator included.
  //
  // ⚠ BOTH ARE SHIPPED MUTATIONS AND NEITHER HAS A CALL SITE IN `src/js/`. That is the third
  // line the product owes (owner: `family/createjoin.js`, at circle creation). This file emits
  // them through `store.apply`, i.e. through the product's own constructors, so the day
  // `createCircle` emits them nothing here changes.
  await bootMac(C.papa);
  await on(C.papa, async () => {
    assert.equal(C.papa.store.apply('attestMyDevice', {
      deviceShort: C.papa.forStore.deviceShort, blob: C.papa.myBlob,
    }), true, 'ADR 001 §4.0 — the admin attests his own device into the log');
    assert.equal(C.papa.store.apply('claimAdmin', {}), true,
      'ADR 001 §4.1 — the creator claims the seat, once, at genesis');
    C.papa.engine = engineFor(C.papa);
    const pushed = await C.papa.engine.pushNow();
    assert.equal(pushed.pushed, 2, 'NON-VACUITY: both founding ops really reached the relay');
  });

  // ── MAMA AND OMA JOIN, and Papa's ORDINARY sync hands them the ring ───────────────────────
  await join(C.mama);
  await join(C.oma);
  await refreshRoster(3);
  await on(C.papa, () => C.papa.engine.syncNow());

  await bootMac(C.mama);
  await on(C.mama, async () => {
    C.mama.engine = engineFor(C.mama);
    await C.mama.engine.syncNow();
    assert.ok(C.mama.ring.currentEpoch(C.spaceId) >= 1,
      'D9: Mama holds the ring after ONE ordinary sync, because Papa\'s ordinary sync delivered it');
    assert.equal(C.mama.store.apply('attestMyDevice', {
      deviceShort: C.mama.forStore.deviceShort, blob: C.mama.myBlob,
    }), true);
    await C.mama.engine.pushNow();
    await publishSharedEntry(C.mama, newUuid());
    await C.mama.engine.syncNow();
    mamaBefore = JSON.parse(JSON.stringify(C.mama.store.state));
    mamaEpochsBefore = C.mama.ring.epochs(C.spaceId).slice();
  });

  // OMA does not adopt the circle — she authors nothing, and adopting it would make her first
  // `persistNow()` throw on Mama's foreign entry (see `bootMac`). Her sync, her ring, her fold
  // and her membership are all the product's; only the last projection step is composed here.
  await bootMac(C.oma, false);
  await on(C.oma, async () => {
    C.oma.engine = engineFor(C.oma);
    await C.oma.engine.syncNow();
    await publishAttestation(C.oma);
    await C.oma.engine.syncNow();     // a second ordinary tick, so nothing is left parked
  });

  // ── THE REMOVAL ───────────────────────────────────────────────────────────────────────────
  await on(C.papa, async () => {
    // Papa's own ordinary tick, so his ring holds every epoch the two joiners minted. It throws
    // at `persistNow` on Mama's foreign entry — `store.js#diffCollection`, see `bootMac` — and
    // that throw is AFTER `keys.admit()` and after `applyRemote`, so the ring and the registers
    // are both correct. Caught here rather than papered over: the day the one-line fix lands this
    // becomes a no-op and nothing in this file changes.
    try { await C.papa.engine.syncNow(); } catch { /* store.js#diffCollection — REPORTED */ }
    rosterAtRemoval = await refreshRoster(3);
    epochBefore = rosterAtRemoval.currentEpoch;
    C.papa.calls.length = 0;

    // `family/adminpanel.js#createAdminPort().removeMember()` in two lines: the relay call, then
    // `ports.afterRemove(res)` with the body verbatim. The port is the product's default.
    const res = await C.papa.transport.request('POST', '/api/v1/members/remove', undefined, {
      spaceId: C.spaceId, memberId: C.mama.forStore.memberId,
    });
    assert.equal(res.status, 200, `POST /members/remove → ${JSON.stringify(res.json)}`);
    assert.equal(res.json.rotateRequired, true, 'the relay states ADR 002 §4.1\'s obligation');

    removalReport = await afterRemove(res.json, {
      engine: partsFor(C.papa, C.papa.engine),
      store: C.papa.store,
      warn: () => {},
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · NON-VACUITY — three people, one circle, one entry that really rendered
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · the circle is three people and not one wearing three names', () => {
  test('§1a · three members, three recovery identities, three signing keys', async () => {
    const ids = [C.papa, C.mama, C.oma].map((m) => m.forStore.memberId);
    assert.equal(new Set(ids).size, 3, 'three members, not one');
    const shorts = [C.papa, C.mama, C.oma].map((m) => m.forStore.deviceShort);
    assert.equal(new Set(shorts).size, 3);
    const sig = await Promise.all([C.papa, C.mama, C.oma].map(
      async (m) => b64u(await exportRawPublic(m.identity.devSig.publicKey))));
    assert.equal(new Set(sig).size, 3,
      'A3-H4\'s false green: two devices sharing a SIGNING KEY would make every row below vacuous');
    const rec = await Promise.all([C.papa, C.mama, C.oma].map(
      async (m) => b64u(await exportRawPublic(m.recovery.recSig.publicKey))));
    assert.equal(new Set(rec).size, 3, 'and three RECOVERY identities — three people, not three Macs');
    assert.match(C.spaceId, /^fsp_/, 'and this really is a family space');
  });

  test('§1b · the admin chain names PAPA, resolved from the log and from no server column', () => {
    const seat = C.papa.store.familyAdmin();
    assert.equal(seat.admin, C.papa.forStore.memberId,
      'ADR 001 §4.1 — the admin is resolved entirely from the op set. `store.familyAdmin()` reads '
      + 'the `space:<id>` register that only an ACCEPTED chain link can have written.');
    assert.equal(seat.isMe, true);
    assert.equal(typeof seat.headOpId, 'string');
    // And the relay stores no such thing, which is why the chain has to exist at all.
    assert.equal('admin' in rosterAtRemoval, false, 'ADR 003 §5.1: there is no role column');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE ADMIN'S MAC — both halves of 20.2, in the order the ADR fixes
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · the removal, on the Mac that performed it', () => {
  test('§2a · the verdict is DONE — both halves landed', () => {
    assert.equal(removalReport.verdict, REMOVAL.DONE, JSON.stringify(removalReport));
    assert.deepEqual(removalReport.blockers, [], 'nothing was blocked');
    assert.equal(removalReport.memberId, C.mama.forStore.memberId);
  });

  test('§2b · ADR 002 §4.1 — the epoch really moved, and the relay proved the coverage', () => {
    const r = removalReport.rotation;
    assert.equal(r.verdict, DELIVERY.DELIVERED, JSON.stringify(r));
    assert.equal(r.epoch, epochBefore + 1, 'T2 — a removal rotates to e+1');
    assert.equal(C.papa.ring.currentEpoch(C.spaceId), epochBefore + 1,
      'and the rotator holds the new key, put into the ring only AFTER the relay accepted it');
    assert.equal(C.papa.calls.includes(`POST /api/v1/spaces/${C.spaceId}/epoch`), true,
      'the request really went out — `E6-VERIFICATION.md` §5.2 counted ZERO client callers of it');
  });

  test('§2c · the new key is wrapped to OMA and NOT to Mama — completeness proved by the server', async () => {
    const ids = removalReport.rotation.recipients;
    assert.equal(ids.includes(C.oma.forStore.deviceId), true,
      'ADR 002 §4.2 step 2 — every REMAINING member device is a recipient');
    assert.equal(ids.includes(C.papa.forStore.deviceId), true);
    assert.equal(ids.includes(C.mama.forStore.deviceId), false,
      'ADR 002 §4.3 — "a removed member is granted nothing further". The rotation excludes her by '
      + 'reading the roster the relay already purged her from, not by filtering a list here.');
    // And the relay REFUSES an incomplete rotation naming the missing member, so the fact that
    // this one was accepted is `assertCoverage`'s verdict rather than this file's.
    const keys = await C.papa.transport.request(
      'GET', `/api/v1/spaces/${C.spaceId}/keys`, undefined, undefined);
    assert.equal(keys.status, 200);
    assert.equal(keys.json.currentEpoch, epochBefore + 1, 'the relay agrees about the epoch');
  });

  test('§2d · Mama can no longer reach the circle at all — her access ended at the relay', async () => {
    const pull = await C.mama.transport.request(
      'GET', '/api/v1/ops', { space: C.spaceId, since: '0', limit: '10' }, null, {});
    assert.equal(pull.status === 403 || pull.status === 404, true,
      `ADR 003 §2 auth step 6 — every request from a removed member's device fails. Got ${pull.status}`);
    const push = await C.mama.transport.request('POST', '/api/v1/ops', {}, {
      space: C.spaceId, ackSeq: '0', ops: [], drained: true,
    }, {});
    assert.equal(push.status === 403 || push.status === 404, true, `and she cannot write either (${push.status})`);
  });

  test('§2e · the in-log removal op is exactly `{_alive:false}` and the relay took it', () => {
    assert.equal(removalReport.published.ok, true, JSON.stringify(removalReport.published));
    assert.equal(typeof removalReport.published.seq, 'string');
    assert.deepEqual(Object.keys(REMOVAL_PATCH), ['_alive'],
      'ADR 001 §4.2 — `authz.js` stage 2 admits an admin\'s write to another member\'s record if '
      + 'and only if the patch is EXACTLY `{_alive}`. One extra field and the op is "an admin '
      + 'writing to another member\'s record", which every peer rejects, permanently and in '
      + 'silence.');
    assert.equal(REMOVAL_PATCH._alive, false);
  });

  test('§2f · the op was sealed under the NEW epoch — the rotation ran first', () => {
    // The order in `removal.js` is rotate ▸ author ▸ publish, and this is the observable
    // consequence of it: the removal op is sealed under `e+1`, the epoch the removed member does
    // not hold and will never be wrapped. Publishing before rotating would seal it under `e`.
    assert.equal(C.papa.ring.currentEpoch(C.spaceId), epochBefore + 1);
    assert.equal(removalReport.rotation.epoch, epochBefore + 1);
    const order = C.papa.calls.filter((c) => c.endsWith('/epoch') || c === 'POST /api/v1/ops');
    assert.equal(order[0], `POST /api/v1/spaces/${C.spaceId}/epoch`,
      'ADR 002 §4.2: the rotation is the immediate consequence of the membership change. Publishing '
      + 'first would leave a window in which every board says she is gone and the key says she is not.');
  });

  test('§2g · and the admin\'s OWN board learns it the same way everybody else does', () => {
    const { current, removed } = membershipOf(C.papa.store.registers());
    assert.equal(removed.has(C.mama.forStore.memberId), true,
      'the op came back off the relay and folded through `applyRemote` → `foldAuthorized`, which '
      + 'is the same path Oma\'s Mac uses. There is no local-append shortcut on the admin\'s Mac.');
    assert.equal(current.has(C.papa.forStore.memberId), true);
    assert.equal(current.has(C.oma.forStore.memberId), true);
    assert.equal(mamaEntryOn(C.papa), null, '20.2 — her entry is off the admin\'s board too');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE TICKET'S OWN ROW — it lands on a REMAINING member's Mac
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · Oma\'s Mac, which nobody told anything', () => {
  test('§3a · before the sync her board still shows Mama\'s entry — the control', () => {
    // Measured at this point on purpose: §2 ran a whole removal and Oma has not synced since.
    const entry = mamaEntryOn(C.oma);
    assert.notEqual(entry, null,
      'NON-VACUITY (false green 1): Mama\'s shared entry IS on Oma\'s board. A removal test over a '
      + 'board that never showed the entry proves nothing about 20.2\'s first clause.');
    assert.equal(entry.text, 'Omas Geburtstag');
    assert.equal(entry.isForeign, true);
    assert.equal(entry.ownerId, C.mama.forStore.memberId);
  });

  test('§3b · ONE ordinary sync, and the removal has landed', async () => {
    await on(C.oma, async () => {
      C.oma.calls.length = 0;
      await C.oma.engine.syncNow();

      // The ring first: the removal op is sealed under `e+1`, so a Mac that had not admitted the
      // new epoch would PARK it and this row would pass for the wrong reason.
      assert.equal(C.oma.ring.epochs(C.spaceId).includes(epochBefore + 1), true,
        'ADR 002 §7.1 steps 5-6 — the new epoch was admitted through `admitWraps` with the branded '
        + 'sender set, on the ordinary pass, before the pull');

      const { current, removed } = membershipOf(C.oma.store.registers());
      assert.equal(removed.has(C.mama.forStore.memberId), true,
        'ADR 001 §4.2 — the admin\'s `member.set{_alive:false}` was ADMITTED by Oma\'s own fold. '
        + 'Nothing in this test applied it: `syncNow()` is the verb a cadence tick calls.');
      assert.equal(current.has(C.papa.forStore.memberId), true, 'and nobody else was removed');
      assert.equal(current.has(C.oma.forStore.memberId), true);
    });
  });

  test('§3c · 20.2, the sentence itself — her entries are off THIS board', () => {
    assert.equal(mamaEntryOn(C.oma), null,
      '"Removing a member deletes their shared/Belegt entries from all family boards." '
      + '`entities.js:projectable` refuses a foreign entry whose owner is not in `currentMembers`, '
      + 'and `store._memberCtx` reads that set off the same registers `authz.js` does.');
    // And the register is still THERE — nothing was deleted, it is no longer projected. That
    // distinction is the whole of ADR 004 §7.1 and of Addendum §6.
    const uuidKey = [...C.oma.store.registers().keys()]
      .find((k) => k.startsWith(`fnote:${C.mama.forStore.memberId}/`));
    assert.notEqual(uuidKey, undefined,
      'the op is not erased from the log — it stops being projected. A client that DELETED it '
      + 'could not re-admit her later, and would be claiming a reach into the past it does not have.');
  });

  test('§3d · Oma\'s own board is untouched by somebody else\'s removal', () => {
    const mine = (C.oma.store.state.notes || []).filter((n) => !n.isForeign);
    assert.equal(mine.length, 1, 'her own entry is still there');
    assert.equal(mine[0].text, 'Mein eigener Eintrag');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · THE PROMISE TO TEST HARDEST — the removed member's own board
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · „ihre privaten Daten auf dem eigenen Rechner bleiben unberührt"', () => {
  test('§4a · the snapshot taken before the removal was not empty — the control', () => {
    assert.equal(Array.isArray(mamaBefore.notes), true);
    assert.equal(mamaBefore.notes.length >= 1, true,
      'NON-VACUITY (false green 5): an intactness assertion over an empty board is a tautology');
    assert.equal(mamaBefore.notes.some((n) => n.text === 'Mein eigener Eintrag'), true);
  });

  test('§4b · her board is byte-for-byte what it was — nothing here reached her Mac', async () => {
    await on(C.mama, async () => {
      // Her cadence tick still fires; the relay simply refuses her now. That must not cost her
      // one entry: `sync/family.js#pullNow` returns `{applied:0}` on a non-200 and the cursor and
      // the board are untouched.
      try { await C.mama.engine.syncNow(); } catch { /* an offline Mac is not an error (19.3) */ }
      assert.deepEqual(JSON.parse(JSON.stringify(C.mama.store.state)), mamaBefore,
        '20.2, second clause: "their private data on their own machine is untouched, because it '
        + 'was never ours." There is no remote-wipe primitive in this product and ADR 002 §6.3 '
        + 'says there must not be one.');
    });
  });

  test('§4c · she keeps every epoch key she held — rotation reaches forward, never back', () => {
    assert.deepEqual(C.mama.ring.epochs(C.spaceId), mamaEpochsBefore,
      'ADR 002 §8.1 and `tests/attack/crypto-relay-removed.test.js`: "she keeps EVERYTHING she '
      + 'already held, for ever". This row exists so a future change that "fixed" it would have to '
      + 'redden a test that says the fix is impossible.');
    assert.equal(C.mama.ring.epochs(C.spaceId).includes(epochBefore + 1), false,
      'and she was never given the new one — which is the only thing a rotation buys');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE COPY — Addendum §6, in one place, in two languages
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · unsharing is not unremembering, and the copy says so', () => {
  test('§5a · the honesty line is `ROTATION_HONESTY` BY IDENTITY, not a second spelling', () => {
    assert.equal(REMOVAL_COPY.honesty, ROTATION_HONESTY,
      'One sentence, one home. A copy of it in a UI module is a second copy to soften — which is '
      + 'exactly how a true product becomes a lying one.');
  });

  test('§5b · every outcome ends with it, in both languages, and none of them claims a deletion', () => {
    assert.equal(removalReport.say[removalReport.say.length - 1], ROTATION_HONESTY.de,
      'the LAST thing a person is told after a removal is what could not be taken back');
    for (const lang of ['de', 'en']) {
      assert.ok(ROTATION_HONESTY[lang].length > 40, `${lang} copy exists`);
    }
    assert.match(ROTATION_HONESTY.de, /bleibt auf ihrem Mac/,
      'ADR 002 §7.4\'s required string: „Was ihr Mac schon geladen hat, bleibt auf ihrem Mac"');
    // ADR 002 §7.4's four forbidden claims, swept over every string this module can render.
    const strings = [];
    const walk = (v) => {
      if (typeof v === 'string') strings.push(v);
      else if (typeof v === 'function') { try { strings.push(String(v('Mama'))); } catch { /* not a name-taker */ } }
      else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(REMOVAL_COPY);
    assert.ok(strings.length > 10, 'the sweep found strings to sweep');
    for (const s of strings) {
      assert.equal(/gelöscht bei allen|zurückgezogen|niemand kann es mehr sehen|deleted everywhere|nobody can see it/i.test(s),
        false, `ADR 002 §7.4 forbids this claim: ${JSON.stringify(s)}`);
    }
  });

  test('§5c · the seam is actually wired — `adminpanel.js` no longer warns into the void', async () => {
    const mod = await import('../../src/js/family/adminpanel.js');
    assert.equal(typeof mod.buildAdminSection, 'function');
    const src = await (await import('node:fs/promises')).readFile(
      new URL('../../src/js/family/adminpanel.js', import.meta.url), 'utf8');
    assert.match(src, /afterRemove:\s*\(relayBody\)\s*=>\s*afterRemove\(relayBody\)/,
      'LZP-608\'s seat is filled by the DEFAULT port. `initAdminPanel()` is called with no '
      + 'arguments by `family/mount.js` — "the defaults ARE the wiring" — so a port left `null` '
      + 'would mean the rotation never happens in the shipped app.');
    assert.match(src, /from '\.\/removal\.js'/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE REFUSALS — what this module will not do, and what it says instead
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A stub engine whose rotation always succeeds, so these rows measure the AUTHORITY decision and
 * nothing else. The real path is §2 and §3; this is the branch a real circle reaches today,
 * because nothing in `src/js/` calls `claimAdmin` at circle creation.
 */
function stubEngine(over = {}) {
  return {
    transport: {
      request: async (m, path, q, body) => ({
        status: 200,
        json: { accepted: (body && body.ops ? body.ops : []).map((e) => ({ oid: e.oid, seq: '900' })), duplicate: [] },
      }),
    },
    keyring: C.papa.ring,
    sync: {
      keys: { rotate: async () => ({ verdict: DELIVERY.DELIVERED, epoch: 8, recipients: [], uncovered: [] }) },
      syncNow: async () => ({ ok: true }),
      diagnostics: () => ({ outbound: { wired: true } }),
    },
    armed: { identity: C.papa.identity, forStore: C.papa.forStore, myAttestation: C.papa.myAttestation },
    circle: { origin: ORIGIN, spaceId: C.spaceId, memberId: C.papa.forStore.memberId },
    ...over,
  };
}

/** A store whose log carries whatever admin chain a row wants to test against. */
function stubStore(admin) {
  return {
    familySpaceId: () => C.spaceId,
    useFamilySpace: () => C.spaceId,
    familyAdmin: () => ({ spaceId: C.spaceId, admin, headOpId: admin ? 'op_x' : null, isMe: admin === C.papa.forStore.memberId }),
    registers: () => new Map(),
    cursor: () => '0',
    _ctx: () => C.papa.store._ctx(),
  };
}

describe('§6 · the authority decisions this module refuses to make', () => {
  const body = () => ({
    spaceId: C.spaceId, memberId: C.mama.forStore.memberId, removed: true,
    alreadyRemoved: false, rotateRequired: true,
  });

  test('§6a · with NO admin chain in the log it rotates, publishes nothing, and says why', async () => {
    const warned = [];
    const r = await createRemoval({
      engine: stubEngine(), store: stubStore(null), warn: (m) => warned.push(m),
    }).run(body());

    assert.equal(r.verdict, REMOVAL.PARTIAL);
    assert.deepEqual([...r.blockers], [REMOVAL_BLOCKERS.NO_ADMIN_CHAIN]);
    assert.equal(r.rotation.verdict, DELIVERY.DELIVERED,
      'THE KEY HALF STILL HAPPENS. It needs no log authority at all — the relay already removed '
      + 'her and the roster the rotation reads no longer names her.');
    assert.equal(r.published, null, 'and nothing was published: every peer would reject it');
    assert.equal(warned.some((m) => /claimAdmin/.test(m)), true,
      'the warning NAMES the owner. `core/ops.js`\'s `claimAdmin` is the genesis link and '
      + '`family/createjoin.js` must emit it at circle creation.');

    // AND IT DOES NOT MINT ONE. `resolveChain` roots on `adminPrev === null ∧ act === admin` and
    // decides rival roots by longest-chain-then-STAMP, so a root minted at removal time BEATS one
    // minted at creation — and would hand the seat, and ADR 001 §4.3's admin-unshare primitive
    // over every member's entries, to whoever reached this code path. Not this file's to decide.
    const src = await (await import('node:fs/promises')).readFile(
      new URL('../../src/js/family/removal.js', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    assert.equal(/spaceSet|'space\.set'|"space\.set"/.test(code), false,
      'no code path in `removal.js` builds a `space.set` op. A chain link is the ONLY shape an '
      + 'admin claim can take (ADR 001 §4.1 `linkOf`), so refusing the constructor is refusing the '
      + 'decision. The word may appear in the prose — that is where the report belongs.');
    assert.equal(/store\.apply\(/.test(code), false,
      'and it authors nothing through a mutation this module would have had to add');
  });

  test('§6b · when the chain names somebody else, the board half is refused', async () => {
    const r = await createRemoval({
      engine: stubEngine(), store: stubStore(C.oma.forStore.memberId), warn: () => {},
    }).run(body());
    assert.equal(r.verdict, REMOVAL.PARTIAL);
    assert.deepEqual([...r.blockers], [REMOVAL_BLOCKERS.NOT_THE_ADMIN],
      'ADR 001 §4.2 — only the SITTING admin\'s removal op is admitted. Publishing one anyway '
      + 'would put an op on the relay that every peer drops in silence, for ever.');
    assert.equal(r.published, null);
    assert.equal(r.say[r.say.length - 1], ROTATION_HONESTY.de, 'and the honesty line is still last');
  });

  test('§6c · removing yourself is 20.3, and it is refused here by name', async () => {
    const r = await afterRemove({
      spaceId: C.spaceId, memberId: C.papa.forStore.memberId, removed: true, rotateRequired: true,
    }, { engine: stubEngine(), store: stubStore(C.papa.forStore.memberId) });
    assert.equal(r.verdict, REMOVAL.PARTIAL);
    assert.match(r.detail, /members\/leave/,
      'two stories, two endpoints, two sentences — `handlers/lifecycle.js` answers `use_leave` for '
      + 'the same reason');
    await assert.rejects(
      () => createRemoval({ engine: stubEngine(), store: stubStore(C.papa.forStore.memberId) })
        .run({ spaceId: C.spaceId, memberId: C.papa.forStore.memberId, rotateRequired: true }),
      RemovalError);
  });

  test('§6d · a body from another circle is refused rather than rotating the wrong space', async () => {
    const other = mkSpaceId('family');
    await assert.rejects(
      () => createRemoval({ engine: stubEngine(), store: stubStore(C.papa.forStore.memberId) })
        .run({ spaceId: other, memberId: C.mama.forStore.memberId, rotateRequired: true }),
      /one circle per install|refusing to rotate/i,
      'Addendum 20.6 — one Familienkreis per install; a removal that named another one would '
      + 'rotate a space this Mac is not in.');
  });

  test('§6e · `rotateRequired: false` burns no epoch — the relay is the one that can count wraps', async () => {
    const rotations = [];
    const engine = stubEngine();
    engine.sync.keys.rotate = async (e) => { rotations.push(e); return { verdict: DELIVERY.DELIVERED, epoch: 8, recipients: [], uncovered: [] }; };
    const r = await createRemoval({ engine, store: stubStore(C.papa.forStore.memberId), warn: () => {} })
      .run({ ...body(), removed: false, alreadyRemoved: true, rotateRequired: false });
    assert.deepEqual(rotations, [], 'ADR 002 §4.1: nobody\'s read access changed, so nothing rotates');
    assert.equal(r.verdict, REMOVAL.ALREADY);
  });
});
