// TIER 1 · LZP-608 — THE FAMILY SYNC ENGINE AND ADR 002 §7.1 STEPS 4-6.
// Stories 15.3, 20.2, 21.2 · PO decision D9 · ADR 002 §4, §7.1 · ADR 003 §3/§8 · ADR 006 §9.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS SUITE IS ABOUT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `docs/v2/E6-VERIFICATION.md` §5 measured D9's fourth required behaviour — *"it resolves
// itself"* — as **NOT DEMONSTRABLE**, and gave the reason as an absence rather than a defect:
//
//   > client callers of GET  /api/v1/spaces/:id/keys    → NONE
//   > client callers of POST /api/v1/spaces/:id/epoch   → NONE
//   > client code that wraps the ring for a PEER device → NONE
//
// §3 of this file is that row, driven. Mama joins a Familienkreis with **no other Mac awake**,
// pulls a family op she cannot open, and is told the calm sentence. Then Papa's Mac performs ONE
// ORDINARY SYNC — nobody clicks anything, nobody is notified, no screen is open — and on Mama's
// next ordinary sync the entry lands and the waiting state clears itself.
//
// THE FOUR FALSE GREENS THIS FILE WAS WRITTEN TO AVOID:
//
//   1. **the receiver holds the key already** → §3 asserts Mama's ring is EMPTY at the moment she
//      first pulls, that her first pull PARKS on `ENVELOPE_PARK.EPOCH`, and that her cursor is
//      held below the op. A test that seeded her ring would prove nothing about steps 4-6.
//   2. **the delivery is hand-driven** → nothing in §3 calls `deliver()`, `rotate()` or
//      `admitWraps` by name. Papa calls `syncNow()`, which is what a 45-second cadence tick calls,
//      and Mama calls `syncNow()`, which is what hers calls. The verbs are exercised through the
//      product's own pass or not at all.
//   3. **the relay is not really in the path** → every request goes through the REAL router, the
//      REAL ADR 003 §2 auth ladder and the REAL `assertCoverage`, via `tests/helpers/loopback.js`.
//      The rotation is accepted by the same coverage check that would refuse a wrap covering only
//      the current epoch, so "all epochs 1..e" is proved by the server and not by this file.
//   4. **the two members are one person** → §3 asserts two distinct memberIds, two distinct
//      recovery identities and two distinct signing keys before anything is applied. A3-H4's
//      sentence applies here word for word: any test that mints its ops with the receiving
//      store's own `_me` is a false green.

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { localStorage as LS, resetStorage, seedBoard } from '../helpers/env.js';

import { memKeyStore } from '../../src/js/platform/keystore.js';
import { openDeviceIdentity, selfAttest, buildAttestOpen } from '../../src/js/platform/device-identity.js';
import { exportRawPublic } from '../../src/js/crypto/identity.js';
import {
  createKeyRing, createSpaceKey, isSenderSet, wrapSpaceKey, encodeWrap,
} from '../../src/js/crypto/spacekeys.js';
import { importKexPublic } from '../../src/js/crypto/identity.js';
import { ENVELOPE_PARK } from '../../src/js/crypto/envelope.js';
import { buildRequest } from '../../src/js/platform/net.js';
import { spaceId as mkSpaceId, opId as newOpId, groupId as newGid } from '../../src/js/core/ids.js';
import { memberSet } from '../../src/js/core/ops.js';
import { createClock } from '../../src/js/core/stamp.js';
import { b64u } from '../../src/js/core/b64.js';

import { createRelay, simClock } from '../helpers/loopback.js';

import { createPersonalSync, PARK_HANDLING as PERSONAL_PARK_HANDLING } from '../../src/js/sync/personal.js';
import {
  createFamilySync, FamilySyncError, PARK_HANDLING, parkHandlingOf, LIMITS, DELIVERY,
} from '../../src/js/sync/family.js';
import { createKeyDelivery, KeyDeliveryError, ROTATION_HONESTY, rosterDeviceIds } from '../../src/js/sync/keys.js';
import {
  createSpaceOnRelay, readCircleConfig, CIRCLE_SPACE_PREF, CIRCLE_MEMBER_PREF, CIRCLE_PENDING_PREF,
  attestationsFromRoster, FAMILY_PREFS,
} from '../../src/js/family/engine.js';
import { CIRCLE_PREFS } from '../../src/js/family/createjoin.js';

const DAY = '2026-08-29';
const MEM = { allowMemoryCustody: true };
const ORIGIN = 'https://relay.invalid';
const S = globalThis.crypto.subtle;

const BOARD = () => ({
  schemaVersion: 1,
  notes: [],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', colorRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const quiet = (s) => clearTimeout(s._saveTimer);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §0.1  TWO MACS' DISKS IN ONE PROCESS — the same discipline `sync-personal.test.js` uses
// ─────────────────────────────────────────────────────────────────────────────────────────────

function snapDisk() {
  const o = {};
  for (const k of LS._keys()) o[k] = LS.getItem(k);
  return o;
}
function restoreDisk(image) {
  LS.clear();
  for (const k of Object.keys(image || {})) LS.setItem(k, image[k]);
}
async function on(mac, fn) {
  restoreDisk(mac.disk);
  try {
    return await fn();
  } finally {
    if (mac.store) quiet(mac.store);
    mac.disk = snapDisk();
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §0.2  THE RELAY AND THE TRANSPORT — the real handlers, no sockets
// ─────────────────────────────────────────────────────────────────────────────────────────────

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

/**
 * The client's Transport port bound to the relay's own router, built on `platform/net.js`'s own
 * `buildRequest` — so the `Authorization` header, the canonical query and the exact body bytes are
 * the shipping client's, and `server/core/auth.js` verifies them with the shipping verifier.
 *
 * `calls` records every (method, path) so a row can assert what an ORDINARY sync actually did on
 * the wire, which is the only way to tell a delivery that really happened apart from one this
 * test performed on the product's behalf.
 */
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §0.3  TWO MEMBERS — two recovery identities, two devices, one Familienkreis
// ─────────────────────────────────────────────────────────────────────────────────────────────

let CIRCLE = null;

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
    ring: createKeyRing(),
    calls: [],
  };
}

/**
 * Build the whole circle through the REAL handlers.
 *
 * PAPA creates a `FAMILY` space, wrapping epoch 1 to his own device through the sanctioned
 * `encodeWrap` and sending the RAW attestation blob — which is the shape `family/createjoin.js`
 * sends and the only shape `readAttestedDevice` accepts (finding E2E3-7). §6 below drives
 * `family/engine.js`'s own `createSpaceOnRelay` against a PERSONAL space, which is the call site
 * that had the bug and the one a revert reddens.
 *
 * MAMA joins with `POST /invites` + `POST /invites/redeem`, which is the D9 path exactly: she is
 * a member the instant the invite is consumed, and she holds no key of any kind.
 */
async function buildCircle() {
  const relay = makeRelay();
  const papa = await mintMember('papa');
  const mama = await mintMember('mama');
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
  papa.transport = loopbackTransport(relay, cfgFor(papa), papa.calls);
  mama.transport = loopbackTransport(relay, cfgFor(mama), mama.calls);

  const devKexPub = await exportRawPublic(papa.identity.devKex.publicKey);
  const wrapped = await wrapSpaceKey(
    spaceKey, papa.identity.devKex.privateKey, await importKexPublic(devKexPub), { spaceId, epoch: 1 });
  const created = await papa.transport.request('POST', '/api/v1/spaces', undefined, {
    spaceId,
    kind: 'FAMILY',
    colorRef: 'gruen',
    member: {
      memberId: papa.forStore.memberId,
      recoveryPubSig: b64u(await exportRawPublic(papa.recovery.recSig.publicKey)),
      recoveryPubKex: b64u(await exportRawPublic(papa.recovery.recKex.publicKey)),
    },
    device: {
      deviceId: papa.forStore.deviceId,
      deviceShort: papa.forStore.deviceShort,
      sigPubRaw: b64u(await exportRawPublic(papa.identity.devSig.publicKey)),
      kexPubRaw: b64u(devKexPub),
      attestation: papa.myBlob,
    },
    // NO `rec_` wrap: `requiredRecipients(…, 'FAMILY')` deliberately does not demand one, because
    // `recoveryPubKex` is signed by nothing (finding E2E3-8). Permitted, not required.
    wraps: [{ recipientId: papa.forStore.deviceId, epoch: 1, wrapped: encodeWrap(wrapped) }],
  });
  assert.equal(created.status, 200, `POST /spaces → ${JSON.stringify(created.json)}`);

  return { relay, papa, mama, spaceId, spaceKey, now };
}

/**
 * MAMA JOINS. Real invite, real redemption, and no key material anywhere near it (D9).
 *
 * It is a separate step from `buildCircle` for the reason the whole section is about: D9's
 * scenario is *"Mom pastes the code while every other Mac is asleep"*, so the shared entry has to
 * already be on the relay when she arrives. A join that happens while Papa's Mac is mid-sync
 * would be delivered inside that same pass and would prove nothing about the waiting state.
 */
async function joinMama({ relay, papa, mama, spaceId, now }) {
  const proof = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const verifier = new Uint8Array(await S.digest('SHA-256', proof));
  const inviteId = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const mk = await papa.transport.request('POST', '/api/v1/invites', undefined, {
    spaceId, inviteId, verifier: b64u(verifier),
  });
  assert.equal(mk.status, 200, `POST /invites → ${JSON.stringify(mk.json)}`);

  // SIGNED BY THE NEW DEVICE, not anonymous: `POST /invites/redeem` is the second rung of
  // ADR 003 §2's bootstrap ladder — the request that creates the device row is authenticated
  // against the key it is publishing, which is what `requireSelfAuth` is for.
  const red = await mama.transport.request('POST', '/api/v1/invites/redeem', undefined, {
    inviteId,
    proof: b64u(proof),
    colorRef: 'blau',
    member: {
      memberId: mama.forStore.memberId,
      recoveryPubSig: b64u(await exportRawPublic(mama.recovery.recSig.publicKey)),
      recoveryPubKex: b64u(await exportRawPublic(mama.recovery.recKex.publicKey)),
    },
    device: {
      deviceId: mama.forStore.deviceId,
      deviceShort: mama.forStore.deviceShort,
      sigPubRaw: b64u(await exportRawPublic(mama.identity.devSig.publicKey)),
      kexPubRaw: b64u(await exportRawPublic(mama.identity.devKex.publicKey)),
      attestation: mama.myBlob,
    },
  });
  assert.equal(red.status, 200, `POST /invites/redeem → ${JSON.stringify(red.json)}`);
  assert.equal(red.json.pendingKeys !== false, true,
    'and the relay says so itself: she is a member and holds NO key — D9\'s designed waiting '
    + 'state, reported by the one party that can count her wraps without opening any');
}

/** Boot one Mac's store over its own disk. No personal space: a circle-only Mac has none. */
async function bootMac(mac, circle) {
  mac.disk = {};
  mac.store = (await import(`../../src/js/store.js?fam-${mac.tag}`)).store;
  const attestOpen = await buildAttestOpen([
    { memberId: circle.papa.forStore.memberId, recoveryPubSigRaw: await exportRawPublic(circle.papa.recovery.recSig.publicKey), blobs: [circle.papa.myBlob] },
    { memberId: circle.mama.forStore.memberId, recoveryPubSigRaw: await exportRawPublic(circle.mama.recovery.recSig.publicKey), blobs: [circle.mama.myBlob] },
  ]);
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
  });
}

/** The family engine for one Mac. Every port is the real one except the socket. */
function engineFor(mac, circle, extra = {}) {
  return createFamilySync({
    store: mac.store,
    transport: mac.transport,
    keyring: mac.ring,
    sigPriv: mac.identity.devSig.privateKey,
    kexPriv: mac.identity.devKex.privateKey,
    recoveryKexPriv: mac.recovery.recKex.privateKey,
    spaceId: circle.spaceId,
    me: {
      memberId: mac.forStore.memberId,
      deviceId: mac.forStore.deviceId,
      deviceShort: mac.forStore.deviceShort,
    },
    attestationOf: (dv) => circle.attestations.get(dv) ?? null,
    attestation: mac.myAttestation,
    now: circle.now,
    subtle: S,
    random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    ...extra,
  });
}

/**
 * `openOp`'s P1 for the circle, built the way `family/engine.js#attestationsFromRoster` builds it:
 * from the relay's roster, with EVERY blob verified under its housing member's own
 * `recoveryPubSig`. Nothing here trusts a device row. Re-read whenever the roster changes.
 */
async function refreshCircleRoster(expected) {
  const list = await CIRCLE.papa.transport.request(
    'GET', `/api/v1/spaces/${CIRCLE.spaceId}/members`, undefined, undefined);
  assert.equal(list.status, 200);
  const { table, unproven } = await attestationsFromRoster(list.json.members);
  assert.equal(unproven, 0, 'NON-VACUITY: every attestation the relay published really verifies');
  if (expected !== undefined) assert.equal(table.size, expected, `${expected} attested device(s)`);
  CIRCLE.attestations = table;
  CIRCLE.roster = list.json.members;
}

before(async () => {
  CIRCLE = await buildCircle();
  CIRCLE.attestations = new Map();
  await refreshCircleRoster(1);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE TWO SCOPES ARE DISJOINT AT THE ENGINE SEAM, IN BOTH DIRECTIONS  (story 21.2)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · a personal engine and a family engine cannot be handed each other\'s space', () => {
  const PSP = 'psp_AAAAAAAAAAAAAAAAAAAAAA';
  const FSP = 'fsp_BBBBBBBBBBBBBBBBBBBBBB';
  const ME = { memberId: 'mem_AAAAAAAAAAAAAAAAAAAAAA', deviceId: 'dev_AAAAAAAAAAAAAAAAAAAAAA', deviceShort: 'A'.repeat(16) };

  test('§1a · the personal engine REFUSES a family space — unchanged, and it must stay so', () => {
    assert.throws(
      () => createPersonalSync({
        spaceId: FSP, store: {}, transport: {}, keyring: {}, attestationOf: () => null, now: () => 0,
      }),
      /must be a psp_/,
      'ADR 002 §5 / story 21.2: a personal engine pointed at a family space would push the private '
      + 'board into the family stream. LZP-608 did NOT loosen this — it built a second engine.');
  });

  test('§1b · the family engine REFUSES a personal space, by the same construction', () => {
    assert.throws(
      () => createFamilySync({
        spaceId: PSP, store: {}, transport: {}, keyring: {}, attestationOf: () => null, now: () => 0, me: ME,
      }),
      (e) => e instanceof FamilySyncError && /must be an fsp_/.test(e.message),
      'the mirror image, and it is not decoration: a family engine on a `psp_` id would drive '
      + '`keys.js` deliver() over familyRecipients() — every OTHER member\'s devices — and hand '
      + 'them the personal space key.');
  });

  test('§1c · and neither refusal has an option, a flag or a default that reaches past it', () => {
    for (const extra of [{ kind: 'family' }, { allowFamily: true }, { force: true }, { spaceKind: 'family' }]) {
      assert.throws(() => createPersonalSync({
        spaceId: FSP, store: {}, transport: {}, keyring: {}, attestationOf: () => null, now: () => 0, ...extra,
      }), /must be a psp_/, `\`${Object.keys(extra)[0]}\` must not open the personal door`);
      assert.throws(() => createFamilySync({
        spaceId: PSP, store: {}, transport: {}, keyring: {}, attestationOf: () => null, now: () => 0, me: ME, ...extra,
      }), /must be an fsp_/, `\`${Object.keys(extra)[0]}\` must not open the family door`);
    }
  });

  test('§1d · the key delivery is bound to ONE space too, and refuses a rotation for the other kind', async () => {
    const kd = createKeyDelivery({
      transport: { request: async () => ({ status: 200, json: {} }) },
      spaceId: FSP,
      ring: createKeyRing(),
      myKexPriv: {},
      me: ME,
      now: () => 0,
    });
    await assert.rejects(() => kd.rotate('device.pair'), (e) => e instanceof KeyDeliveryError && /rotates the personal space/.test(e.message),
      'ADR 002 §4.1: `device.pair` rotates the PERSONAL space. Asking a family delivery to perform '
      + 'it is asking for the wrong key to be replaced, and it is refused by name rather than '
      + 'quietly performed on whichever space happened to be wired.');
    await assert.rejects(() => kd.rotate('nobody wrote this down'), /not one of ADR 002 §4.1/,
      'and an UNLISTED event throws rather than defaulting to "no rotation", which would be a '
      + 'silent security downgrade no test would notice');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE PARK TAXONOMY HAS EXACTLY ONE HOME
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · the two engines share the park table rather than each keeping a copy', () => {
  test('§2a · `PARK_HANDLING` is the SAME OBJECT, not an equal one', () => {
    assert.equal(PARK_HANDLING, PERSONAL_PARK_HANDLING,
      'identity, not deep equality: two structurally equal tables are two answers to "what do I '
      + 'do with every reason the envelope layer can emit?", and they disagree the day a seventh '
      + 'reason lands in only one of them. `sync/family.js` re-exports `sync/personal.js`\'s own '
      + 'table rather than declaring one, so there is exactly one table in the process.');
  });

  test('§2b · and it is still TOTAL over `ENVELOPE_PARK`, read through the family engine', () => {
    const reasons = Object.values(ENVELOPE_PARK).sort();
    assert.deepEqual(Object.keys(PARK_HANDLING).sort(), reasons,
      'every reason `openOp` can emit has a row');
    for (const r of reasons) assert.equal(parkHandlingOf(r).known, true);
    assert.equal(parkHandlingOf('a reason from a newer build').curedBy, 'update',
      'and an UNKNOWN reason is held, not dropped — the one case where destroying the op is '
      + 'certainly wrong');
    assert.equal(PARK_HANDLING[ENVELOPE_PARK.EPOCH].curedBy, 'session',
      'and `epoch` — which in a family space is EVERY op until the ring arrives — is cured within '
      + 'the session by a key fetch, which is what makes D9\'s waiting state a wait and not a loss');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · D9, END TO END, THROUGH THE REAL RELAY.  **This is the row §5.2 of E6-VERIFICATION owed.**
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · Mama joins with nobody awake, and the board fills in by itself', () => {
  let papaSync = null;
  let mamaSync = null;
  let keyEvents = [];
  let papaOutbox = [];

  before(async () => {
    await bootMac(CIRCLE.papa, CIRCLE);

    // ── PAPA AUTHORS ONE REAL FAMILY OP ──────────────────────────────────────────────────────
    //
    // `member.set{dev.<short>}` — his own device attestation, published into the family log. It is
    // the op the whole circle depends on (`core/authz.js` stage 0b admits a member's family ops
    // only once their `dev.*` register has been folded), it needs no `projectForFamily` — that is
    // `core/project.js`'s barrier and E7's file — and it is a family-space op like any other:
    // sealed under `FSK_1`, opaque to the relay, and unopenable by a device with no ring.
    //
    // It is minted with the SHIPPED constructor over a hand-built `OpCtx`, because the store has
    // no mutation that authors one. **THAT IS THE REPORTED GAP, not a shortcut for this test:**
    // `core/ops.js`'s MUTATIONS table has no `member.set` row and `store._familySpaceId` has no
    // setter, so no product code path can author a family op today. See `sync/family.js`'s header.
    const clock = createClock(CIRCLE.papa.forStore.deviceShort, CIRCLE.now);
    const ctx = {
      act: CIRCLE.papa.forStore.memberId,
      dev: CIRCLE.papa.forStore.deviceId,
      gid: newGid(),
      mint: () => clock.tick(),
      newOpId,
      familySpaceId: CIRCLE.spaceId,
    };
    const op = memberSet(ctx, CIRCLE.papa.forStore.memberId, {
      [`dev.${CIRCLE.papa.forStore.deviceShort}`]: CIRCLE.papa.myBlob,
    });
    papaOutbox = [{ op, seq: null, park: null }];

    papaSync = engineFor(CIRCLE.papa, CIRCLE, {
      // The family OUTBOX port. `store.outbox()` is hard-filtered to the personal space and there
      // is no `store.useFamilySpace()`, so this is the seam E7 fills; the engine's push path is
      // the shipped one either way.
      outbound: {
        lines: ({ limit = Infinity } = {}) => papaOutbox.slice(0, limit),
        ack: (acks) => {
          const done = new Set(acks.map((a) => a.oid));
          papaOutbox = papaOutbox.filter((l) => !done.has(l.op.id));
          return done.size;
        },
      },
    });
    // ── PAPA SHARES IT, WITH NO FAMILY IN THE CIRCLE YET ─────────────────────────────────────
    //
    // `pushNow()` is the product's own verb — it is what the 2 s debounce `attach()` arms fires,
    // i.e. what happens when a person commits a change. It runs BEFORE Mama exists so that the
    // entry is already on the relay when she arrives, which is D9's scenario exactly: the shared
    // history predates the joiner.
    const pushed = await papaSync.pushNow();
    assert.equal(pushed.pushed, 1, 'NON-VACUITY: one op really reached the relay');
    assert.equal(papaOutbox.length, 0, 'and left the outbox');

    // ── AND ONLY NOW DOES MAMA JOIN ──────────────────────────────────────────────────────────
    await joinMama(CIRCLE);
    await refreshCircleRoster(2);
    await bootMac(CIRCLE.mama, CIRCLE);
    mamaSync = engineFor(CIRCLE.mama, CIRCLE, {
      onKeys: (r) => keyEvents.push(r),
    });
  });

  test('§3a · NON-VACUITY — two members, two recovery identities, two signing keys', async () => {
    const { papa, mama } = CIRCLE;
    assert.notEqual(papa.forStore.memberId, mama.forStore.memberId, 'two members, not one');
    assert.notEqual(papa.forStore.deviceShort, mama.forStore.deviceShort);
    assert.notEqual(
      b64u(await exportRawPublic(papa.identity.devSig.publicKey)),
      b64u(await exportRawPublic(mama.identity.devSig.publicKey)),
      'A3-H4\'s false green: two devices sharing a SIGNING KEY would make every assertion below '
      + 'meaningless');
    assert.notEqual(
      b64u(await exportRawPublic(papa.recovery.recSig.publicKey)),
      b64u(await exportRawPublic(mama.recovery.recSig.publicKey)),
      'and two RECOVERY identities, which is what makes them two people rather than two Macs');
    assert.match(CIRCLE.spaceId, /^fsp_/, 'and this really is a family space');
  });

  test('§3b · Mama pulls the shared entry and CANNOT open it — the designed waiting state', async () => {
    // ── MAMA. Her ring is EMPTY. This is the assertion the whole section rests on. ────────────
    assert.equal(CIRCLE.mama.ring.currentEpoch(CIRCLE.spaceId), 0,
      'NON-VACUITY: Mama holds NO epoch key at all. D9 is the promise that a leaked invite is '
      + 'never sufficient to read family content, and this is that promise as a measured fact.');

    const before = CIRCLE.mama.store.cursor(CIRCLE.spaceId);
    const m = await mamaSync.syncNow();
    assert.equal(m.admitted.keysPending, true,
      'THE WAITING STATE, from the relay: `GET /spaces/:id/keys` returns no wrap addressed to her, '
      + 'and answers `keysPending: true` — the DESIGNED state, never an error (ADR 002 §7.1 step 6)');
    assert.equal(m.delivery.verdict, DELIVERY.NO_RING,
      'and her own delivery pass declines: a device that holds no ring cannot hand one over. This '
      + 'is why D9 needs somebody else\'s Mac and says so.');

    const held = mamaSync.deferredOps();
    assert.equal(held.length, 1, 'she pulled exactly one op and is holding it');
    assert.equal(held[0].why, ENVELOPE_PARK.EPOCH,
      'PARKED ON `epoch` — the envelope is sealed under a key epoch her ring does not hold. Not '
      + 'refused, not dropped, not an error: ADR 002 §4.4\'s park.');
    assert.equal(held[0].curedBy, 'session',
      'and the cure is a KEY FETCH within this session, which is exactly what step 5 delivers');
    assert.equal(CIRCLE.mama.store.cursor(CIRCLE.spaceId), before,
      'AND THE CURSOR IS HELD BELOW IT (ADR 006 §9.1 W1): while the cursor is held the relay is '
      + 'the durable copy, so quitting here loses nothing');
    assert.equal(mamaSync.status().state, 'pending',
      'the three-state indicator says `pending`, NEVER `error` — D9: "never render as an error, a '
      + 'failure, or a retry prompt"');
    assert.equal(mamaSync.status().keysPending, true, 'and the fact a calm screen renders from');
    assert.equal(keyEvents.length, 0, 'and nothing has been admitted, so nothing has been claimed');
  });

  test('§3c · Papa\'s NEXT ORDINARY SYNC delivers the ring — nobody clicked anything', async () => {
    CIRCLE.papa.calls.length = 0;
    const p = await papaSync.syncNow();

    assert.equal(p.delivery.verdict, DELIVERY.DELIVERED,
      'ADR 002 §7.1 STEP 4, on the ordinary sync path: Papa\'s Mac noticed a recipient in the '
      + 'roster it cannot prove holds the ring, and handed the ring over. No screen was open, no '
      + 'notification was raised, and nothing in this test called `deliver()` — `syncNow()` did.');
    assert.ok(p.delivery.uncovered.includes(CIRCLE.mama.forStore.deviceId),
      'and it named Mama\'s device as the one it could not prove holds the ring');
    assert.equal(p.delivery.epoch, 2,
      'ADR 002 §4.1: a member joining rotates to e+1. The space was at 1 — the epoch the shared '
      + 'entry was sealed under — so the new one is 2.');
    assert.ok(CIRCLE.papa.calls.includes(`POST /api/v1/spaces/${CIRCLE.spaceId}/epoch`),
      'and the request really went out — the route `E6-VERIFICATION.md` §5.2 counted ZERO client '
      + 'callers of');

    // THE COVERAGE RULE IS THE SERVER'S, AND IT PASSED. `assertCoverage` refuses a rotation whose
    // wraps do not cover epochs 1..e for every required recipient, INSIDE the transaction. So
    // "the wrap covers ALL epochs 1..e" (§7.1 step 5, A4, story 17.1, risk R11) is proved by the
    // relay refusing anything less, not by this file counting rows.
    const wraps = await CIRCLE.relay.store.getKeyWraps(CIRCLE.spaceId, CIRCLE.mama.forStore.deviceId);
    assert.deepEqual(wraps.map((w) => w.epoch).sort(), [1, 2],
      'MAMA HOLDS A WRAP FOR EVERY EPOCH, 1 AND 2 — not just the current one. Epoch 1 is the one '
      + 'Papa\'s entry was sealed under, i.e. the shared history: "Oma\'s birthday entered three '
      + 'years ago must render". A wrap covering only the current epoch is the bug §7.1 step 5 '
      + 'names in as many words.');
    assert.equal(wraps.every((w) => w.senderDeviceId === CIRCLE.papa.forStore.deviceId), true,
      'and the relay STAMPED the depositor itself (finding E2E3-3) — the client never named one');

    const again = await papaSync.syncNow();
    assert.equal(again.delivery.verdict, DELIVERY.COVERED,
      'AND THE STEADY STATE IS QUIET: the very next sync proves everybody is covered and rotates '
      + 'nothing. A delivery that fired on every poll would climb the epoch ladder for ever.');
  });

  test('§3d · Mama\'s next ordinary sync opens the parked op and the waiting state clears ITSELF', async () => {
    CIRCLE.mama.calls.length = 0;
    const m = await mamaSync.syncNow();

    assert.deepEqual(m.admitted.admitted, [1, 2],
      'ADR 002 §7.1 STEPS 5 AND 6: both epochs admitted, through `admitWraps` with the branded '
      + 'sender set. Epoch 1 is the one that makes the history readable.');
    assert.equal(m.admitted.unauthorized, 0,
      'and no row named a sender this space does not admit — finding S1\'s check, on the honest path');
    assert.equal(keyEvents.length, 1, 'the engine fired `onKeys` exactly once, on the ARRIVAL of keys');
    assert.equal(keyEvents[0].keysPending, false,
      'D9 PART 4: "it resolves itself". The fact a waiting screen renders from has flipped, and '
      + 'nothing anywhere was clicked, opened, retried or asked for.');

    assert.equal(m.applied, 1,
      'AND IT LANDED IN THIS SAME PASS, not on the next poll: `syncNow` runs the key pass BEFORE '
      + 'the pull, so the envelope she had been holding was handed back to `openOp` with a ring '
      + 'that now has the key. That order is the whole mechanism — "it resolves itself" is a '
      + 'sentence about what happens while the person is still looking at the screen.');
    assert.equal(m.recovered, 0,
      'and the BACKSTOP sweep did not fire, which is the measurement that pins the claim above: '
      + 'if the second sweep were doing the work, the order would not be. See `syncNow`\'s step 3.');
    assert.equal(mamaSync.deferredOps().length, 0, 'nothing is held any more');
    assert.equal(mamaSync.status().keysPending, false);
    assert.notEqual(CIRCLE.mama.store.cursor(CIRCLE.spaceId), '0', 'and the cursor moved past it');

    // ── THE CONTENT. Papa's op is in Mama's log, folded into her register map. ────────────────
    const cells = CIRCLE.mama.store.registers().get(`member:${CIRCLE.papa.forStore.memberId}`);
    assert.notEqual(cells, undefined,
      'THE ENTRY LANDED: an op Papa authored, sealed under a key Mama did not have when she pulled '
      + 'it, is now folded into her board\'s register map.');
    assert.equal(cells.get(`dev.${CIRCLE.papa.forStore.deviceShort}`).value, CIRCLE.papa.myBlob,
      'byte for byte what he wrote — and this particular cell is the one that unlocks every '
      + 'FURTHER op of his: `core/authz.js` stage 0b admits a member\'s family ops only once their '
      + '`dev.*` register has been folded.');

    assert.equal(mamaSync.status().state !== 'error', true,
      'and at no point in the whole flow did the indicator go red');
  });

  test('§3e · a relay that lies about the sender causes a REFUSAL and never an admission (S1)', async () => {
    // A THIRD PARTY: a device that is not in this circle at all, offering Mama a key.
    const stranger = await mintMember('stranger');
    const strangerKey = await createSpaceKey();
    const ring = createKeyRing();
    const kd = createKeyDelivery({
      transport: {
        request: async (method, path) => {
          if (/\/members$/.test(path)) return { status: 200, json: { currentEpoch: 3, members: CIRCLE.roster } };
          return {
            status: 200,
            json: {
              spaceId: CIRCLE.spaceId,
              currentEpoch: 3,
              keysPending: false,
              wraps: [{
                epoch: 3,
                recipientId: CIRCLE.mama.forStore.deviceId,
                wrapped: 'not-a-wrap',
                senderKexPubRaw: b64u(await exportRawPublic(stranger.identity.devKex.publicKey)),
              }],
            },
          };
        },
      },
      spaceId: CIRCLE.spaceId,
      ring,
      myKexPriv: CIRCLE.mama.identity.devKex.privateKey,
      me: {
        memberId: CIRCLE.mama.forStore.memberId,
        deviceId: CIRCLE.mama.forStore.deviceId,
        deviceShort: CIRCLE.mama.forStore.deviceShort,
      },
      now: CIRCLE.now,
      subtle: S,
    });
    const out = await kd.admit();
    assert.deepEqual(out.admitted, [],
      'NOTHING WAS ADMITTED. The row named an ECDH key that is not in the verified sender set, so '
      + 'no KEK was ever derived against it — `senderKexPubRaw` SELECTS a sender and can never '
      + 'supply one (finding S1, ADR 002 §4.2 step 6).');
    assert.equal(ring.currentEpoch(CIRCLE.spaceId), 0, 'and the ring is untouched');
    assert.ok(strangerKey, 'NON-VACUITY: the stranger really had a key to offer');
  });

  test('§3g · ROUND 8\'s L-3 · the reaper runs on the ordinary pull, not only at a pairing', async () => {
    // L-3, in its own words: "`store.unparkAttested()` exists and `init()` does not call it." It
    // was called from ONE place in the product — `family/mount.js`, on the adoption of a peer — so
    // a hold whose cure arrived by any other route was never looked at again.
    //
    // In a FAMILY space that is not a corner, it is the main road. `core/authz.js` stage 0b
    // refuses every family op of a member whose `dev.*` register has not been folded, `applyRemote`
    // PARKS the line rather than dropping it (F-6), and once the ladder has released the cursor
    // that parked line is the ONLY copy this Mac can reach — no batch will ever arrive to trigger
    // `applyRemote`'s own sweep. So the pull has to look.
    const calls = [];
    const stub = {
      _warn() {},
      cursor: () => '0',
      noteCursor() { return true; },
      applyRemote: () => ({ applied: [], refused: [] }),
      persistNow: async () => {},
      unparkAttested: () => { calls.push('reaped'); return []; },
      subscribe: () => () => {},
      diagnostics: () => null,
    };
    const sync = createFamilySync({
      store: stub,
      transport: { request: async () => ({ status: 200, headers: {}, json: { ops: [], nextCursor: '0', hasMore: false } }) },
      keyring: createKeyRing(),
      sigPriv: {},
      kexPriv: {},
      spaceId: CIRCLE.spaceId,
      me: { memberId: 'mem_x', deviceId: 'dev_x', deviceShort: 'X'.repeat(16) },
      attestationOf: () => null,
      now: () => 0,
    });
    await sync.pullNow();
    assert.deepEqual(calls, ['reaped'],
      'THE ROW: one ordinary pull, one call to the reaper. It runs on an EMPTY page too, because '
      + 'the cure it is looking for — an attestation that arrived by pairing, by a launch, or by '
      + 'a roster refresh — has nothing to do with whether this page carried anything.');
    await sync.pullNow();
    assert.equal(calls.length, 2, 'and on every pull, not once per session');
  });

  test('§3f · the sender set is the BRANDED one, built from the same two constructors', async () => {
    const { admissibleSenders, familyRecipients, recipientScope } = await import('../../src/js/crypto/spacekeys.js');
    const recipients = familyRecipients(CIRCLE.roster);
    assert.ok(recipients.length >= 2, 'NON-VACUITY: the roster really produced recipients');
    for (const r of recipients) {
      assert.equal(recipientScope(r), 'family',
        'every recipient carries the FAMILY brand — an object literal has none, which is what '
        + 'makes barrier 2 structural rather than a comment');
    }
    const set = await admissibleSenders(recipients, CIRCLE.spaceId);
    assert.equal(isSenderSet(set), true);
    await assert.rejects(() => admissibleSenders(recipients, 'psp_AAAAAAAAAAAAAAAAAAAAAA'),
      /cannot authorize a "personal"-space admission/,
      'and a FAMILY sender set can never authorize a personal admission — story 20.5, on the way IN');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · ROTATION ON MEMBERSHIP CHANGE, AND WHAT IT HONESTLY CANNOT DO  (20.2, ADR 002 §4)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · a membership change mints a new epoch, and the copy does not lie about it', () => {
  test('§4a · `rotate()` bumps the epoch and re-covers every remaining recipient', async () => {
    const before = CIRCLE.papa.ring.currentEpoch(CIRCLE.spaceId);
    const out = await CIRCLE.papa.transport.request(
      'GET', `/api/v1/spaces/${CIRCLE.spaceId}/members`, undefined, undefined);
    const epochBefore = out.json.currentEpoch;
    const r = await (await import('../../src/js/sync/keys.js')).createKeyDelivery({
      transport: CIRCLE.papa.transport,
      spaceId: CIRCLE.spaceId,
      ring: CIRCLE.papa.ring,
      myKexPriv: CIRCLE.papa.identity.devKex.privateKey,
      me: {
        memberId: CIRCLE.papa.forStore.memberId,
        deviceId: CIRCLE.papa.forStore.deviceId,
        deviceShort: CIRCLE.papa.forStore.deviceShort,
      },
      now: CIRCLE.now,
      subtle: S,
    }).rotate('member.remove');
    assert.equal(r.verdict, DELIVERY.DELIVERED, JSON.stringify(r));
    assert.equal(r.epoch, epochBefore + 1, 'ADR 002 §4.1: a removal rotates to e+1 — T2');
    assert.equal(CIRCLE.papa.ring.currentEpoch(CIRCLE.spaceId), before + 1,
      'and the rotator holds the new key — put into the ring only AFTER the relay accepted it, so '
      + 'a lost race cannot leave a private epoch nobody else has (see `keys.js` rotateTo)');
  });

  test('§4b · the honesty note says what a rotation cuts off AND what it cannot take back', () => {
    assert.match(ROTATION_HONESTY.cutsOff, /new epoch|from the new epoch/i);
    assert.match(ROTATION_HONESTY.cannotUndo, /already/,
      'Addendum §6: *unsharing is not unremembering.* A rotation reaches forward and never '
      + 'backward, and the copy that says otherwise is a promise the mathematics does not make.');
    for (const lang of ['de', 'en']) {
      assert.ok(ROTATION_HONESTY[lang].length > 40, `${lang} copy exists`);
      assert.equal(/gelöscht|deleted|entfernt von ihrem Mac|removed from their Mac/i.test(ROTATION_HONESTY[lang]), false,
        `the ${lang} copy must NOT claim anything is deleted on the other person's Mac`);
    }
    assert.match(ROTATION_HONESTY.de, /bleibt auf ihrem Mac/,
      'the German line says it plainly: what they already downloaded stays on their Mac');
  });

  test('§4c · nothing in the delivery API names a role, an admin or a permission', async () => {
    const mod = await import('../../src/js/sync/keys.js');
    for (const name of Object.keys(mod)) {
      assert.equal(/admin|role|owner|permission/i.test(name), false,
        `\`${name}\` names an authority. ADR 002 §7.1 step 4: delivery is NOT a second gate — `
        + '"any existing member device, not only the admin\'s". `crypto/spacekeys.js` holds the '
        + 'same line and `crypto-spacekeys.test.js` asserts it of that module; this is the same '
        + 'assertion one layer up.');
    }
    const kd = createKeyDelivery({
      transport: { request: async () => ({ status: 0, json: null }) },
      spaceId: CIRCLE.spaceId,
      ring: createKeyRing(),
      myKexPriv: {},
      me: { memberId: 'mem_x', deviceId: 'dev_x', deviceShort: 'S'.repeat(16) },
      now: () => 0,
    });
    for (const k of Object.keys(kd)) {
      assert.equal(/admin|role/i.test(k), false, `the instance exposes \`${k}\``);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE SEAMS — the restated constants, and the empty half this engine does not own
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · the wiring is honest about what it is and what it is not', () => {
  test('§5a · the restated settings keys equal `createjoin.js`\'s, so the copies cannot drift', () => {
    assert.equal(CIRCLE_SPACE_PREF, CIRCLE_PREFS.space);
    assert.equal(CIRCLE_MEMBER_PREF, CIRCLE_PREFS.member);
    assert.equal(CIRCLE_PENDING_PREF, CIRCLE_PREFS.pending);
    assert.equal(FAMILY_PREFS.origin, CIRCLE_PREFS.origin,
      'and the ORIGIN is genuinely one key, because there is one relay');
  });

  test('§5b · `readCircleConfig` opens on `fsp_` and on nothing else', () => {
    const good = { syncOrigin: 'https://r.test', familySpaceId: 'fsp_AAAAAAAAAAAAAAAAAAAAAA', familyMemberId: 'mem_A' };
    assert.deepEqual(readCircleConfig(good), { origin: 'https://r.test', spaceId: good.familySpaceId, memberId: 'mem_A' });
    assert.equal(readCircleConfig({ ...good, familySpaceId: 'psp_AAAAAAAAAAAAAAAAAAAAAA' }), null,
      'a `psp_` id in the circle slot is refused HERE, with a message about a settings key, rather '
      + 'than three frames deeper with a message about a space kind');
    assert.equal(readCircleConfig({ ...good, syncOrigin: '' }), null, 'no relay, no engine');
    assert.equal(readCircleConfig({ ...good, familyMemberId: '' }), null, 'no member id, no engine');
    assert.equal(readCircleConfig(null), null, 'and a solo Mac arms nothing at all (15.1)');
  });

  test('§5c · with no outbox port the engine SAYS SO rather than reporting a healthy zero', () => {
    const sync = createFamilySync({
      store: CIRCLE.mama.store,
      transport: CIRCLE.mama.transport,
      keyring: CIRCLE.mama.ring,
      sigPriv: CIRCLE.mama.identity.devSig.privateKey,
      kexPriv: CIRCLE.mama.identity.devKex.privateKey,
      spaceId: CIRCLE.spaceId,
      me: {
        memberId: CIRCLE.mama.forStore.memberId,
        deviceId: CIRCLE.mama.forStore.deviceId,
        deviceShort: CIRCLE.mama.forStore.deviceShort,
      },
      attestationOf: () => null,
      now: CIRCLE.now,
    });
    const d = sync.diagnostics();
    assert.equal(d.outbound.wired, false,
      'THE HONEST HALF: `store.outbox()` is hard-filtered to the personal space and there is no '
      + '`store.useFamilySpace()`, so this build shares nothing — not because sharing failed, but '
      + 'because nothing can author a family op yet.');
    assert.match(d.outbound.owner, /project\.js/, 'and the diagnostic names whose it is');
    assert.equal(d.outbound.pending, 0);
  });

  test('§5d · `rosterDeviceIds` counts without verifying, and says so by never deciding anything', () => {
    const ids = rosterDeviceIds(CIRCLE.roster);
    assert.equal(ids.length, 2);
    assert.deepEqual(ids, [CIRCLE.papa.forStore.deviceId, CIRCLE.mama.forStore.deviceId].sort());
    assert.deepEqual(rosterDeviceIds([{ memberId: 'm', removedAt: '2026-01-01', devices: [{ deviceId: 'dev_z' }] }]), [],
      'a removed member contributes no device — ADR 002 §4.3, T2');
    assert.deepEqual(rosterDeviceIds(null), [], 'and it is total over garbage, like every reader of relay data');
  });

  test('§5e · the protocol caps are the shared ones, not a second copy', async () => {
    const { LIMITS: PERSONAL_LIMITS } = await import('../../src/js/sync/personal.js');
    assert.equal(LIMITS, PERSONAL_LIMITS, 'identity again: one table, two engines');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · FINDING E2E3-7 — the personal opt-in was BROKEN against the shipping relay
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `family/engine.js#createSpaceOnRelay` is the ONE call `family/mount.js#optIn` makes to bring a
// personal space into existence — story 19.4's whole opt-in. It sent `b64u(TE.encode(blob))` for
// `device.attestation`, and `server/core/handlers/spaces.js#readAttestationBlob` requires the raw
// `b64u '.' b64u` string, so the route answered `400 bad_shape` and the opt-in could not complete.
// `adoptOnRelay`, ten lines below it in the same file, sent the raw blob and always had.
//
// This row is the regression. It drives the SHIPPED function against the REAL handler, so
// re-wrapping the blob in base64url — the mutant — reddens it by name.

describe('§6 · `createSpaceOnRelay` completes against the real relay (E2E3-7)', () => {
  test('§6a · the personal opt-in\'s one POST is accepted, with the RAW attestation blob', async () => {
    const relay = makeRelay();
    const me = await mintMember('opt-in');
    const spaceId = mkSpaceId('personal');
    me.transport = loopbackTransport(relay, {
      origin: ORIGIN,
      deviceShort: me.forStore.deviceShort,
      sign: me.sign,
      clientVersion: '2.0.0',
      now: () => relay.ctx.now(),
      random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      subtle: S,
    }, me.calls);

    const key = await createSpaceKey();
    const out = await createSpaceOnRelay({ transport: me.transport }, {
      forStore: me.forStore,
      identity: me.identity,
      recovery: me.recovery,
      myBlob: me.myBlob,
      cfg: { spaceId },
    }, key);
    assert.equal(out.spaceId, spaceId,
      'THE ROW: the shipped opt-in call is accepted. Before LZP-608 this was `400 bad_shape` on '
      + '`device.attestation`, so story 19.4\'s opt-in was dead against the shipping server.');

    const stored = await relay.store.getSpace(spaceId);
    assert.equal(stored.kind, 'PERSONAL');
    const devices = await relay.store.listDevices(spaceId);
    assert.equal(new TextDecoder().decode(devices[0].attestation), me.myBlob,
      'and the column round-trips the blob BYTE FOR BYTE, which it must: the client verifies a '
      + 'signature over these bytes and a re-encoding fails every one of them');

    const wraps = await relay.store.getKeyWraps(spaceId, me.forStore.deviceId);
    assert.equal(wraps.length, 1, 'and the epoch-1 wrap landed');
    const rec = await relay.store.getKeyWraps(spaceId, `rec_${me.forStore.memberId}`);
    assert.equal(rec.length, 1,
      'including the `rec_<memberId>` row, which `requiredRecipients(…, \'PERSONAL\')` DEMANDS — '
      + 'it is the only wrap a member who has lost every device can still open (§7.3, A2)');
  });

  test('§6b · and the mutant is refused — a base64url-wrapped blob is `400 bad_shape`', async () => {
    const relay = makeRelay();
    const me = await mintMember('mutant');
    const spaceId = mkSpaceId('personal');
    const transport = loopbackTransport(relay, {
      origin: ORIGIN,
      deviceShort: me.forStore.deviceShort,
      sign: me.sign,
      clientVersion: '2.0.0',
      now: () => relay.ctx.now(),
      random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      subtle: S,
    }, me.calls);
    const key = await createSpaceKey();
    const devKexPub = await exportRawPublic(me.identity.devKex.publicKey);
    const w = await wrapSpaceKey(key, me.identity.devKex.privateKey, await importKexPublic(devKexPub), { spaceId, epoch: 1 });
    const res = await transport.request('POST', '/api/v1/spaces', undefined, {
      spaceId,
      kind: 'PERSONAL',
      colorRef: 'gruen',
      member: {
        memberId: me.forStore.memberId,
        recoveryPubSig: b64u(await exportRawPublic(me.recovery.recSig.publicKey)),
        recoveryPubKex: b64u(await exportRawPublic(me.recovery.recKex.publicKey)),
      },
      device: {
        deviceId: me.forStore.deviceId,
        deviceShort: me.forStore.deviceShort,
        sigPubRaw: b64u(await exportRawPublic(me.identity.devSig.publicKey)),
        kexPubRaw: b64u(devKexPub),
        // THE MUTANT: exactly what `engine.js` used to send.
        attestation: b64u(new TextEncoder().encode(me.myBlob)),
      },
      wraps: [{ recipientId: me.forStore.deviceId, epoch: 1, wrapped: encodeWrap(w) }],
    });
    assert.equal(res.status, 400,
      'THE PROOF THAT §6a IS NOT VACUOUS: the encoding the file used to send is refused by the '
      + 'shipping handler. The dot is what the base64url swallows, and `readAttestationBlob`\'s '
      + 'shape check is exactly `b64u . b64u`.');
    assert.equal(res.json.field, 'device.attestation');
    assert.equal(res.json.reason, 'bad_shape');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · THE FOUR THINGS THE THREE-MAC INTEGRATION FOUND, EACH OF WHICH SILENCED THE WHOLE CIRCLE
//
// Every one of these was found by driving three real browser contexts against
// `node server/dev-server.mjs`, and NOT ONE of them was visible to a green suite — because every
// one of them fails by PARKING or by DECLINING, which is the shape this product is designed to
// have. The ops arrive, they are held, the board is empty, and nothing is in an error state.
// That is exactly right as a failure mode and exactly why a test has to name the cure.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§7 · the integration findings, each with the row that dies without the fix', () => {
  // ── §7a · `attestOpen` — the one nobody could verify anybody ─────────────────────────────────
  test('§7a · without ctx.attestOpen a peer\'s OWN attestation op is rejected, and then nothing '
    + 'that peer ever authors can be admitted', async () => {
    const { foldAuthorized, REJECT_REASONS } = await import('../../src/js/core/authz.js');
    const papa = CIRCLE.papa;

    // Papa's own `member.set{dev.<short>}` — ADR 001 §4.0's self-authorizing bootstrap.
    const clock = createClock(papa.forStore.deviceShort, () => 1788000000000);
    const attestOp = memberSet({
      act: papa.forStore.memberId, dev: papa.forStore.deviceId,
      gid: newGid(), mint: () => clock.tick(), newOpId,
      space: CIRCLE.spaceId, familySpaceId: CIRCLE.spaceId,
    }, papa.forStore.memberId, { [`dev.${papa.forStore.deviceShort}`]: papa.myBlob });

    // WITHOUT an opener — which is what every Mac in this product had until the integration.
    const blind = foldAuthorized([attestOp], { me: CIRCLE.mama.forStore.memberId });
    assert.equal(blind.rejected.length, 1,
      'THE DEFECT: `attestationVerifies` returns false for EVERY blob when no opener is wired — '
      + 'fail-closed, correctly, and catastrophic when nothing ever wires one');
    assert.equal(blind.rejectionOf(attestOp.id).reason, REJECT_REASONS.BAD_ATTESTATION,
      'and it is refused BY NAME — `badAttestation`, at stage 0a, which is the one place a '
      + 'missing opener can be told from a forged blob');

    // WITH the opener `family/engine.js#refreshAttestations` now builds from the roster.
    const attestOpen = await buildAttestOpen([{
      memberId: papa.forStore.memberId,
      recoveryPubSigRaw: await exportRawPublic(papa.recovery.recSig.publicKey),
      blobs: [papa.myBlob],
    }]);
    const seeing = foldAuthorized([attestOp], { me: CIRCLE.mama.forStore.memberId, attestOpen });
    assert.equal(seeing.rejected.length, 0,
      'THE CURE: the same op, the same bytes, and the only difference is that this Mac can now '
      + 'check the signature the log already carried');
    assert.equal(
      seeing.regs.get(`member:${papa.forStore.memberId}`)?.get(`dev.${papa.forStore.deviceShort}`)?.value,
      papa.myBlob, 'and the register holds the blob, so stage 0b can attest his every later op');
  });

  test('§7b · `store.setAttestOpen` is a SEPARATE seam from `useIdentity`, because the two change '
    + 'on different clocks', async () => {
    const s = CIRCLE.papa.store;
    assert.equal(typeof s.setAttestOpen, 'function',
      'without this the table could only be supplied to `useIdentity()`, which may be called ONCE '
      + 'and only before init() — while who I can verify changes every time a member joins');
    // It is live: the LAST function installed is the one the fold uses, with no re-adoption.
    const wasSet = s._attestOpen;
    const marker = { memberId: 'x' };
    s.setAttestOpen(() => marker);
    assert.equal(s._authzCtx().attestOpen('anyone', 'anything'), marker,
      'the LAST function installed is the one the fold uses, with no identity re-adoption');
    s.setAttestOpen(null);
    assert.equal('attestOpen' in s._authzCtx(), false, 'and null removes it, fail-closed again');
    s.setAttestOpen(wasSet);
    assert.throws(() => s.setAttestOpen('not a function'), TypeError);
  });

  // ── §7c · the roster is the attestation source, and it is read on EVERY pass ─────────────────
  test('§7c · every roster read refreshes the tables, so a member who joins after launch is not '
    + 'unattested until the app restarts', async () => {
    const seen = [];
    const relay = makeRelay();
    const solo = await mintMember('late-a');
    const spaceId = mkSpaceId('family');
    const key = await createSpaceKey();
    solo.ring.put(spaceId, 1, key);
    const now = () => relay.ctx.now();
    solo.transport = loopbackTransport(relay, {
      origin: ORIGIN, deviceShort: solo.forStore.deviceShort, sign: solo.sign,
      clientVersion: '2.0.0', now, subtle: S,
      random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    }, solo.calls);
    const kexPub = await exportRawPublic(solo.identity.devKex.publicKey);
    const w = await wrapSpaceKey(key, solo.identity.devKex.privateKey, await importKexPublic(kexPub), { spaceId, epoch: 1 });
    const made = await solo.transport.request('POST', '/api/v1/spaces', undefined, {
      spaceId, kind: 'FAMILY', colorRef: 'gruen',
      member: {
        memberId: solo.forStore.memberId,
        recoveryPubSig: b64u(await exportRawPublic(solo.recovery.recSig.publicKey)),
        recoveryPubKex: b64u(await exportRawPublic(solo.recovery.recKex.publicKey)),
      },
      device: {
        deviceId: solo.forStore.deviceId, deviceShort: solo.forStore.deviceShort,
        sigPubRaw: b64u(await exportRawPublic(solo.identity.devSig.publicKey)),
        kexPubRaw: b64u(kexPub), attestation: solo.myBlob,
      },
      wraps: [{ recipientId: solo.forStore.deviceId, epoch: 1, wrapped: encodeWrap(w) }],
    });
    assert.equal(made.status, 200);

    const keys = createKeyDelivery({
      transport: solo.transport, spaceId, ring: solo.ring,
      myKexPriv: solo.identity.devKex.privateKey,
      me: { memberId: solo.forStore.memberId, deviceId: solo.forStore.deviceId, deviceShort: solo.forStore.deviceShort },
      now, subtle: S, random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      onRoster: (members) => { seen.push(members.map((m) => m.memberId)); },
    });

    await keys.admit();
    assert.equal(seen.length >= 1, true, 'admit() reads the roster, so the tables refresh on it');
    const afterAdmit = seen.length;
    await keys.deliver();
    assert.ok(seen.length > afterAdmit,
      'and so does deliver() — the hook is on `roster()` itself, so there is no second GET and no '
      + 'path that reads the roster without refreshing who this Mac can verify');
    for (const call of seen) assert.deepEqual(call, [solo.forStore.memberId]);
  });

  // ── §7d · a seal that only lacks a KEY is held, never quarantined ────────────────────────────
  test('§7d · D9\'s window does not destroy the ops a joiner authors inside it', async () => {
    // A Mac in the circle with an EMPTY ring — precisely Mama between `POST /invites/redeem` and
    // the first delivery, which is when `createjoin.js#adoptCircleIntoLog` authors her
    // attestation and her name.
    const ringless = createKeyRing();
    const held = [];
    const eng = engineFor(CIRCLE.mama, CIRCLE, {
      keyring: ringless,
      outbound: {
        lines: () => held.slice(),
        ack: (entries) => { for (const a of entries) { const i = held.findIndex((l) => l.op.id === a.oid); if (i >= 0) held.splice(i, 1); } },
      },
    });
    const clock = createClock(CIRCLE.mama.forStore.deviceShort, () => 1788000001000);
    held.push({ op: memberSet({
      act: CIRCLE.mama.forStore.memberId, dev: CIRCLE.mama.forStore.deviceId,
      gid: newGid(), mint: () => clock.tick(), newOpId,
      space: CIRCLE.spaceId, familySpaceId: CIRCLE.spaceId,
    }, CIRCLE.mama.forStore.memberId, { displayName: 'Mama', colorRef: 'blau' }) });

    const before = held.length;
    const res = await eng.pushNow();
    assert.equal(res.pushed, 0, 'nothing goes out unencrypted, ever');
    assert.deepEqual(eng.quarantined(), [],
      'THE DEFECT, INVERTED: this used to quarantine, and a quarantine has NO CURE — so the two '
      + 'ops that say who a new member IS were destroyed by the very window D9 exists to make '
      + 'survivable, and every op she authored afterwards would have parked on every peer as '
      + '`unattestedDevice`, permanently');
    assert.equal(held.length, before,
      'the line is LEFT IN THE OUTBOX, untouched, so the next push after the ring arrives sends it');
    assert.equal(eng.diagnostics().opsHeldForKey, 1,
      'and it is COUNTED rather than silent — "waiting for a key" is a state, not an absence');

    // The cure is the ring arriving, and nothing else: same engine, same outbox, one key.
    ringless.put(CIRCLE.spaceId, 1, CIRCLE.spaceKey);
    const after = await eng.pushNow();
    assert.equal(after.pushed, 1, 'THE SAME op, sealed and accepted, with no retry a human asked for');
    assert.equal(held.length, 0, 'and the outbox drains');
  });
});
