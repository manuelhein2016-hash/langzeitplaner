// tests/fleet/e6-attack-circle.js — THE RIG THE T5/T2 ATTACKS ARE DRIVEN ON.
//
// Not a test file: it declares no `test()` and the `tests/fleet/*.test.js` glob cannot see it.
// It is the shared scaffolding for `e6-attack-*.test.js`, and it exists because each of those
// files needs the SAME thing — a real Familienkreis, on the real relay, with real key delivery —
// and three copies of a circle builder is three chances for one of them to be quietly weaker.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS REAL HERE  (the list matters more than the list of what is not)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   THE RELAY      every handler, through `server/core/router.js`, over `adapters/memory.js`,
//                  reached by `tests/helpers/loopback.js`. The ADR 003 §2 auth ladder runs; the
//                  ADR 002 §4.2 coverage check runs; `POST /ops` really verifies signatures.
//   THE TRANSPORT  `platform/net.js#buildRequest` — the shipping client's canonical query, header
//                  and body bytes. Only the socket is replaced.
//   THE ENGINE     `sync/family.js#createFamilySync`, unmodified, one per Mac, driven by
//                  `syncNow()` and nothing else.
//   THE DELIVERY   `sync/keys.js` inside that engine — `admit`, `deliver`, `rotate`. This is the
//                  component under attack and no part of it is stood in for.
//   THE CRYPTO     `crypto/spacekeys.js` and `crypto/envelope.js`, unmodified.
//   THE DISKS      one `localStorage` image per Mac, swapped under `storage.js`'s feet by `on()`,
//                  and one `store.js` MODULE EVALUATION per Mac. Three Macs sharing one store
//                  module would be one machine wearing three names.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS STOOD IN FOR, NAMED
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   · **The shared entry is hand-sealed.** `core/project.js#projectForFamily` is E7's file and
//     this round may not touch it, so `publishSharedEntry` assembles the op and brands the patch
//     the way `tests/fleet/e6-removal.test.js` already does. Every barrier the seal passes
//     through is the product's; only the producer of the patch is local.
//   · **The hostile member's rotation is hand-rolled.** That is the whole point: an attacker does
//     not call `keys.js#deliver()`. `hostileRotate()` below is what an attacker's client looks
//     like — the same route, the same auth, arbitrary bytes in `wrapped`.

import { localStorage as LS, resetStorage, seedBoard } from '../helpers/env.js';

import { memKeyStore } from '../../src/js/platform/keystore.js';
import { openDeviceIdentity, selfAttest, buildAttestOpen } from '../../src/js/platform/device-identity.js';
import { exportRawPublic, importKexPublic } from '../../src/js/crypto/identity.js';
import {
  createKeyRing, createSpaceKey, wrapSpaceKey, encodeWrap,
} from '../../src/js/crypto/spacekeys.js';
import { sealOp, brandFamilyPatch } from '../../src/js/crypto/envelope.js';
import { buildRequest } from '../../src/js/platform/net.js';
import { spaceId as mkSpaceId } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { materialize } from '../../src/js/core/materialize.js';
import { b64u, ub64 } from '../../src/js/core/b64.js';

import { createRelay, simClock } from '../helpers/loopback.js';
import { createFamilySync } from '../../src/js/sync/family.js';
import { createKeyDelivery } from '../../src/js/sync/keys.js';
import { attestationsFromRoster } from '../../src/js/family/engine.js';

export const DAY = '2026-08-29';
export const ORIGIN = 'https://relay.invalid';
export const S = globalThis.crypto.subtle;
const MEM = { allowMemoryCustody: true };

export const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n-own', date: '2026-10-01', text: 'Mein eigener Eintrag', categoryId: 'c1' }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', colorRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const quiet = (s) => { try { clearTimeout(s._saveTimer); } catch { /* not started */ } };

// ─────────────────────────────────────────────────────────────────────────────
// Disks
// ─────────────────────────────────────────────────────────────────────────────

export function snapDisk() {
  const o = {};
  for (const k of LS._keys()) o[k] = LS.getItem(k);
  return o;
}

export function restoreDisk(image) {
  LS.clear();
  for (const k of Object.keys(image || {})) LS.setItem(k, image[k]);
}

/** Run `fn` with `mac`'s disk mounted, and put the disk back afterwards. */
export async function on(mac, fn) {
  restoreDisk(mac.disk);
  try {
    return await fn();
  } finally {
    if (mac.store) quiet(mac.store);
    mac.disk = snapDisk();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The relay and the wire
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Members
// ─────────────────────────────────────────────────────────────────────────────

export async function mintMember(tag) {
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

export const memberRow = async (m) => ({
  memberId: m.forStore.memberId,
  recoveryPubSig: b64u(await exportRawPublic(m.recovery.recSig.publicKey)),
  recoveryPubKex: b64u(await exportRawPublic(m.recovery.recKex.publicKey)),
});

export const deviceRow = async (m) => ({
  deviceId: m.forStore.deviceId,
  deviceShort: m.forStore.deviceShort,
  sigPubRaw: b64u(await exportRawPublic(m.identity.devSig.publicKey)),
  kexPubRaw: b64u(await exportRawPublic(m.identity.devKex.publicKey)),
  attestation: m.myBlob,
});

/**
 * One founder plus `others.length` un-joined members, and a FAMILY space at epoch 1.
 * @param {string[]} names the founder first
 */
export async function buildCircle(names = ['papa', 'mama', 'eve']) {
  const relay = makeRelay();
  const macs = [];
  for (const n of names) macs.push(await mintMember(n));
  const [founder] = macs;
  const spaceId = mkSpaceId('family');
  const spaceKey = await createSpaceKey();
  founder.ring.put(spaceId, 1, spaceKey);

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
  for (const m of macs) m.transport = loopbackTransport(relay, cfgFor(m), m.calls);

  const devKexPub = await exportRawPublic(founder.identity.devKex.publicKey);
  const wrapped = await wrapSpaceKey(
    spaceKey, founder.identity.devKex.privateKey, await importKexPublic(devKexPub),
    { spaceId, epoch: 1 });
  const created = await founder.transport.request('POST', '/api/v1/spaces', undefined, {
    spaceId,
    kind: 'FAMILY',
    colorRef: 'gruen',
    member: await memberRow(founder),
    device: await deviceRow(founder),
    wraps: [{ recipientId: founder.forStore.deviceId, epoch: 1, wrapped: encodeWrap(wrapped) }],
  });
  if (created.status !== 200) throw new Error(`POST /spaces → ${created.status} ${JSON.stringify(created.json)}`);

  const C = {
    relay, spaceId, now, macs, spaceKey,
    attestations: new Map(),
    roster: [],
    colors: { papa: 'gruen', mama: 'blau', eve: 'magenta', oma: 'gelb', mallory: 'rot' },
  };
  for (const m of macs) C[m.tag] = m;
  return C;
}

/** One join through the real invite + redeem pair. D9: no key material anywhere near it. */
export async function join(C, mac, { inviter } = {}) {
  const by = inviter || C.macs[0];
  const proof = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const verifier = new Uint8Array(await S.digest('SHA-256', proof));
  const inviteId = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const mk = await by.transport.request('POST', '/api/v1/invites', undefined, {
    spaceId: C.spaceId, inviteId, verifier: b64u(verifier),
  });
  if (mk.status !== 200) throw new Error(`POST /invites → ${mk.status} ${JSON.stringify(mk.json)}`);
  const red = await mac.transport.request('POST', '/api/v1/invites/redeem', undefined, {
    inviteId,
    proof: b64u(proof),
    colorRef: C.colors[mac.tag] || 'gelb',
    member: await memberRow(mac),
    device: await deviceRow(mac),
  });
  return red;
}

/** `openOp`'s P1 for the circle, built the way `family/engine.js` builds it. */
export async function refreshRoster(C, asMac) {
  const who = asMac || C.macs[0];
  const list = await who.transport.request(
    'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
  if (list.status !== 200) throw new Error(`GET /members → ${list.status}`);
  const { table } = await attestationsFromRoster(list.json.members);
  C.attestations = table;
  C.roster = list.json.members;
  return list.json;
}

/** Boot one Mac's store over its own disk, and adopt the circle. */
export async function bootMac(C, mac, adopt = true) {
  mac.disk = {};
  mac.store = (await import(`../../src/js/store.js?atk-${mac.tag}-${C.spaceId.slice(4, 12)}`)).store;
  const attestOpen = await buildAttestOpen(await Promise.all(C.macs.map(async (m) => ({
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
    if (adopt) s.useFamilySpace(C.spaceId);
  });
}

/**
 * The `coverStore` port, byte for byte what `family/engine.js#coverageStore()` is:
 * `langzeitplaner.keycoverage.<spaceId>` in the Mac's own `localStorage`. It is reproduced here
 * rather than imported because that function is module-private — and it is reproduced because
 * WITHOUT it `keys.js` reports `coverage().durable === false` and a proof written in one launch
 * would not be there in the next, which would understate every §1-class finding by one relaunch.
 */
export function coverageStore() {
  return {
    async load(spaceId) {
      try {
        const raw = LS.getItem(`langzeitplaner.keycoverage.${spaceId}`);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    async save(spaceId, record) {
      try { LS.setItem(`langzeitplaner.keycoverage.${spaceId}`, JSON.stringify(record)); }
      catch { /* a full disk is not a crash */ }
    },
  };
}

/** The family engine for one Mac — every port the real one. */
export function engineFor(C, mac, extra = {}) {
  return createFamilySync({
    coverStore: coverageStore(),
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

/** The board, composed exactly as `store._project()` composes it. */
export function boardOf(C, mac) {
  const regs = mac.store.registers();
  return materialize(regs, {
    me: mac.forStore.memberId,
    familySpaceId: C.spaceId,
    ...mac.store._memberCtx(regs),
    defaultSettings: mac.store.state.settings,
  }).notes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ops a Mac publishes by hand (see the header for why the shared entry is one)
// ─────────────────────────────────────────────────────────────────────────────

/** ADR 001 §4.0 — one member's own `member.set{dev.<short>}`, into the family log. */
export async function publishAttestation(C, mac) {
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
  return pushOp(C, mac, op);
}

/** One shared `pub.set` entry, hand-branded — see the header. */
export async function publishSharedEntry(C, mac, uuid, fields = {}) {
  const ctx = mac.store._ctx();
  const patch = brandFamilyPatch({
    'pub.level': 'geteilt',
    'pub.alive': true,
    'pub.date': '2026-10-14',
    'pub.text': 'Omas Geburtstag',
    ...fields,
  }, { kind: 'fnote', level: 'geteilt' });
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
  await pushOp(C, mac, op, { levelOf: () => 'geteilt', assertFamilyPatch: () => {} });
  return op;
}

/** Seal one op under this Mac's own family ring and POST it. */
export async function pushOp(C, mac, op, sealCtx = {}) {
  const env = await sealOp(op, mac.ring, mac.identity.devSig.privateKey, {
    v: 1, sp: C.spaceId, ep: mac.ring.currentEpoch(C.spaceId), dv: mac.forStore.deviceShort,
    oid: op.id, wit: '',
  }, { attestation: mac.myAttestation, ...sealCtx });
  const res = await mac.transport.request('POST', '/api/v1/ops', {}, {
    space: C.spaceId, ackSeq: mac.store.cursor(C.spaceId), ops: [env], drained: true,
  }, {});
  if (res.status !== 200) throw new Error(`POST /ops → ${res.status} ${JSON.stringify(res.json)}`);
  return { op, env, res };
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ATTACKER'S CLIENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A rotation written by an adversary rather than by `sync/keys.js`.
 *
 * It hits the SAME route with the SAME auth as an honest one. What it does differently is choose
 * the bytes: `wrappedFor(recipientId, epoch)` returns either a genuine `WrapBlob` or whatever the
 * attacker wants the relay to store for that (recipient, epoch) pair. The relay never opens a
 * wrap, so this is not a forgery — it is the shape of the trust the coverage check actually has.
 *
 * @param {Object} C @param {Object} attacker
 * @param {(recipientId:string, epoch:number) => Promise<string>|string} wrappedFor
 *        must return the base64url `encodeWrap()` form the wire takes
 * @param {{epoch?:number, recipients?:string[]}} [opts]
 */
export async function hostileRotate(C, attacker, wrappedFor, opts = {}) {
  const list = await attacker.transport.request(
    'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
  if (list.status !== 200) throw new Error(`GET /members → ${list.status}`);
  const epoch = opts.epoch ?? (list.json.currentEpoch + 1);
  const ids = opts.recipients ?? rosterDeviceIdsOf(list.json.members);
  const wraps = [];
  for (const id of ids) {
    for (let e = 1; e <= epoch; e++) {
      wraps.push({ recipientId: id, epoch: e, wrapped: await wrappedFor(id, e) });
    }
  }
  return attacker.transport.request(
    'POST', `/api/v1/spaces/${C.spaceId}/epoch`, undefined, { epoch, wraps }, {});
}

/**
 * Bring one Mac's key ring up to the relay's current epoch WITHOUT touching any disk.
 *
 * An attacker syncs before she attacks; so does an honest Mac whose engine is not the one being
 * driven in this pass. It is a bare `createKeyDelivery` with no `coverStore`, so it writes
 * nothing to `localStorage` and can be called while somebody else's disk is mounted.
 */
export async function catchUpRing(C, mac) {
  const kd = createKeyDelivery({
    transport: mac.transport,
    spaceId: C.spaceId,
    ring: mac.ring,
    myKexPriv: mac.identity.devKex.privateKey,
    myRecoveryKexPriv: mac.recovery.recKex.privateKey,
    me: {
      memberId: mac.forStore.memberId,
      deviceId: mac.forStore.deviceId,
      deviceShort: mac.forStore.deviceShort,
    },
    now: C.now,
    subtle: S,
    random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
  });
  return kd.admit();
}

/** Every live device id in a roster response. */
export function rosterDeviceIdsOf(members) {
  const out = [];
  for (const m of members || []) {
    if (m.removedAt !== null && m.removedAt !== undefined) continue;
    for (const d of m.devices || []) {
      if (d.revokedAt !== null && d.revokedAt !== undefined) continue;
      out.push(d.deviceId);
    }
  }
  return out.sort();
}

/** A genuine wrap of `key` for one recipient, addressed off the relay's own roster. */
export async function genuineWrap(C, attacker, roster, recipientId, epoch, key) {
  const kexPubRaw = kexOf(roster, recipientId);
  if (!kexPubRaw) throw new Error(`no kexPubRaw for ${recipientId}`);
  const blob = await wrapSpaceKey(
    key, attacker.identity.devKex.privateKey,
    await importKexPublic(ub64(kexPubRaw)), { spaceId: C.spaceId, epoch });
  return encodeWrap(blob);
}

/** A wrap that is well-formed and opens to nothing: the same shape, arbitrary bytes. */
export async function junkWrap(C, epoch) {
  const throwaway = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const key = await createSpaceKey();
  const blob = await wrapSpaceKey(
    key, throwaway.privateKey, throwaway.publicKey, { spaceId: C.spaceId, epoch });
  return encodeWrap(blob);
}

export function kexOf(roster, recipientId) {
  for (const m of roster.members || roster) {
    for (const d of m.devices || []) {
      if (d.deviceId === recipientId) return d.kexPubRaw;
    }
  }
  return null;
}
