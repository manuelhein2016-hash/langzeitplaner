// tests/server/spaces.test.js — LZP-203: space creation, the member list, and the control this
// whole ticket exists for: SERVER-ENFORCED ROTATION COVERAGE.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS BEING ATTACKED HERE
// ─────────────────────────────────────────────────────────────────────────────────────────────
// E3's red team read ADR 002, found the controls, and then found that none of them ran:
//
//   > "every server-enforced control in ADR 002 — rotation coverage, the `rid` burn, the
//    5-attempt budget, all rate limits — exists in a contract and in no code that runs."
//
// The specific hole for this file: `familyRecipients()` takes the member list from its CALLER, so
// an admin rotating the family key can omit one honest member and cut them off from everything
// written afterwards — silently, with a 200 OK, and with no client-side check able to notice,
// because the omitted member is the one who cannot decrypt the result. ADR 002 §4.2 names the
// server as the thing that stops it. So the tests below are written as the attacker: rotate while
// omitting a device, omit a recovery key, omit the shared history, rotate as a stranger, rotate
// twice at once, and smuggle a plaintext name into the one readable column there is.
//
// Every case that must fail is also asserted to leave NOTHING behind — because a refused rotation
// that still consumed epoch `e+1` would wedge the family just as effectively as a successful
// attack: the honest rotator that comes next would get `409 epoch_taken` for an epoch whose key
// nobody holds.
//
// Run against BOTH adapters. The file adapter is the second witness: it is where a `Uint8Array`
// could come back a string, and a coverage check that compared strings to bytes would pass in
// memory and fail in Frankfurt.
//
// NO TEST READS THE WALL CLOCK. Everything runs on an injected clock.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { memoryStore } from '../../server/adapters/memory.js';
import { attestedPerson, attestedDeviceFor, deviceWire, memberWire } from './_attested-person.js';
import { fileStore } from '../../server/adapters/file.js';
import {
  createSpace, rotateEpoch,
  requiredRecipients, staleRecipients, knownRecipients, recoveryRecipient,
  bytesToB64u, b64uToBytes, readObject, safeField, limitOf, SPACES_PER_IP_HOUR,
  CTX_EXTENSIONS, HANDLER_FINDINGS, MAX_WRAPS, WRAP_MAX_BYTES,
} from '../../server/core/handlers/spaces.js';
import { listMembers, memberProjection } from '../../server/core/handlers/members.js';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-spaces-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

function fakeClock(start) {
  let t = start || 1787836800000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const ADAPTERS = [
  { name: 'memory', make: (clock) => memoryStore({ now: clock.now }) },
  { name: 'file', make: (clock) => fileStore(tempDir(), { now: clock.now }) },
];

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Deterministic, so a failure is reproducible and no test depends on entropy. */
function rng(seed) {
  let x = (Math.imul(seed === undefined ? 7 : seed, 2654435761) ^ 0x9e3779b9) >>> 0;
  if (x === 0) x = 0x1234567;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; };
}
function pick(alphabet, n, seed) {
  const next = rng(seed);
  let s = '';
  for (let i = 0; i < n; i++) s += alphabet[next() % alphabet.length];
  return s;
}
const id22 = (seed) => pick(B64U, 22, seed);
const short16 = (seed) => pick(CROCKFORD, 16, seed);
function bytes(n, seed) {
  const next = rng((seed === undefined ? 7 : seed) + 9001);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = next() & 0xff;
  return out;
}
const b64 = (u8) => bytesToB64u(u8);

const LIMITS = Object.freeze({
  opsPerPush: 200, bytesPerEnvelope: 65536, bytesPerRequest: 4194304, opsPerPull: 500,
  pushPerMin: 60, pullPerMin: 120, invitesPerIpHour: 10, pairGetPerIpHour: 20,
  pairSessionsPerMemberHour: 10, pairAttempts: 5, authWindowMs: 120000, nonceTtlMs: 300000,
  spacesPerIpHour: 1000,
});

/**
 * A ServerCtx over a real store. `auth` is a stub because LZP-202 owns the real ladder — but the
 * stub is deliberately GENEROUS (it says yes to whatever device short the caller claims), so a
 * handler that leans on the auth layer for a membership check fails here rather than in
 * production. Everything these handlers refuse, they refuse on their own.
 */
function makeCtx(store, clock, opts) {
  const o = opts || {};
  const logged = [];
  let randSeed = 100;
  return {
    store,
    now: () => clock.now(),
    random: (n) => bytes(n, randSeed++),
    limits: o.limits || LIMITS,
    auth: async () => {
      if (o.authThrows) throw o.authThrows;
      return o.auth || { deviceShort: null, deviceId: null, memberId: null };
    },
    assertMember: async () => {},
    log: (evt) => logged.push(evt),
    sha256: async (b) => new Uint8Array(createHash('sha256').update(b).digest()),
    _logged: logged,
  };
}

/**
 * `limits.js` resolves the client address out of the request headers (its `clientIp`, with the
 * x-vercel-forwarded-for -> x-real-ip -> x-forwarded-for trust order). So the tests speak headers,
 * not a ctx field — which also means a test can spoof one, which is the point of the last case in
 * the rate-limit block.
 */
const req = (extra) => ({
  method: 'POST', path: '/api/v1/spaces', query: {}, headers: { 'x-forwarded-for': '203.0.113.9' },
  body: null, rawBody: new Uint8Array(0), params: {}, ...extra,
});
const fromIp = (ip, extra) => req({ ...extra, headers: ip === null ? {} : { 'x-forwarded-for': ip } });

async function expectFail(fn, status, code, hint) {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  assert.ok(err, `${hint || ''} — expected a failure, got success`);
  assert.equal(err.status, status, `${hint || ''} — status (code was ${err.code}: ${JSON.stringify(err.extra)})`);
  assert.equal(err.code, code, `${hint || ''} — code`);
  return err;
}

// ── fixtures for a whole person ──────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────────────────────
// A PERSON IS NOW REAL, AND THAT IS THE POINT — finding E2E3-7
// ─────────────────────────────────────────────────────────────────────────────────────────────
// This used to be `bytes(65, seed)` standing in for a P-256 point and `bytes(120, seed)` standing
// in for an attestation, because `POST /spaces` read the attestation with `readBytes` and
// verified nothing at all. That is exactly why the divergence from `POST /devices` — which has
// always run ADR 002 §2.3's P2, S1 and S2 — could not be seen from this suite: a fixture made of
// noise cannot tell a verifying route from a credulous one.
//
// `_attested-person.js` mints with the SHIPPING `buildDeviceAttestation` + `attestDevice`, so
// what this suite hands the relay is what a Mac hands the relay. The ids are still stable within
// a run; only the entropy moved, and no assertion here ever depended on a literal id.
const person = attestedPerson;
const memberBody = memberWire;
const deviceBody = deviceWire;
const wrap = (recipientId, epoch, seed) => ({ recipientId, epoch, wrapped: b64(bytes(156, seed || 1)) });

const ADMIN = await person({ colorRef: 'gruen' });
const MOM = await person({ colorRef: 'blau' });
const KID = await person({ colorRef: 'rot' });
const SPACE = `fsp_${id22(2)}`;
const OTHER_SPACE = `fsp_${id22(3)}`;

function createBody(p, o) {
  return {
    spaceId: o && 'spaceId' in o ? o.spaceId : SPACE,
    kind: o && 'kind' in o ? o.kind : 'FAMILY',
    colorRef: o && 'colorRef' in o ? o.colorRef : 'gruen',
    member: memberBody(p),
    device: deviceBody(p),
    wraps: o && 'wraps' in o ? o.wraps : [wrap(p.deviceId, 1, 1), wrap(recoveryRecipient(p.memberId), 1, 2)],
  };
}

/** Create a space with ADMIN in it. Returns {store, clock, ctx}. */
async function withSpace(adapter, o) {
  const clock = fakeClock();
  const store = adapter.make(clock);
  const ctx = makeCtx(store, clock, { auth: { deviceShort: ADMIN.deviceShort, deviceId: null, memberId: null } });
  const res = await createSpace(req({ body: createBody(ADMIN, o) }), ctx);
  assert.equal(res.status, 200);
  return { store, clock, ctx };
}

/** Add a second member straight into the store, the way a redemption would. */
async function joinDirect(store, clock, p, colorRef, spaceId) {
  await store.addMember({
    id: p.memberId, spaceId: spaceId || SPACE, colorRef, recoveryPubSig: p.recoveryPubSig,
    recoveryPubKex: p.recoveryPubKex, joinedAt: new Date(clock.now()), removedAt: null,
  });
  await store.addDevice({
    id: p.deviceId, spaceId: spaceId || SPACE, memberId: p.memberId, deviceShort: p.deviceShort, sigPubRaw: p.sigPubRaw,
    kexPubRaw: p.kexPubRaw, attestation: p.attestationBytes, lastSeenSeq: 0n, lastPushedSeq: 0n,
    addedAt: new Date(clock.now()), revokedAt: null,
  });
}

/** The ctx a given person's device would authenticate with. */
const asPerson = (store, clock, p, o) => makeCtx(store, clock, {
  auth: { deviceShort: p.deviceShort, deviceId: p.deviceId, memberId: p.memberId }, ...o,
});

const rotateReq = (spaceId, body) => req({ path: `/api/v1/spaces/${spaceId}/epoch`, params: { id: spaceId }, body });

// ═════════════════════════════════════════════════════════════════════════════
// 1. The wire codec — the layer every other assertion rests on
// ═════════════════════════════════════════════════════════════════════════════

test('b64url decoding is strict, canonical, and never throws a raw error at a caller', () => {
  const round = bytes(65, 1);
  assert.deepEqual(b64uToBytes(bytesToB64u(round), 'x'), round);
  for (const bad of [
    'AA==',                       // padding
    'a+b/c',                      // standard base64 alphabet
    'A',                          // length % 4 === 1
    'AAAAA',                      // ditto
    'AAB',                        // a trailing bit the encoder would never set
    '',                           // empty
    'ab cd',                      // whitespace
    null, 42, {}, [],
  ]) {
    let caught = null;
    try { b64uToBytes(bad, 'field'); } catch (e) { caught = e; }
    assert.ok(caught, `${JSON.stringify(bad)} must be refused`);
    assert.equal(caught.status, 400);
    assert.equal(caught.code, 'bad_request');
  }
  assert.throws(() => b64uToBytes(bytesToB64u(bytes(64, 1)), 'k', { len: 65 }), (e) => e.extra.reason === 'wrong_length');
  assert.throws(() => b64uToBytes(bytesToB64u(bytes(2048, 1)), 'k', { maxLen: 1024 }), (e) => e.status === 413);
});

test('an error body cannot be turned into a reflector by a giant field name', () => {
  // The field name rides back to the client on the 400. It is caller-chosen, so it is bounded.
  assert.equal(safeField('device.deviceShort'), 'device.deviceShort');
  assert.equal(safeField('x'.repeat(4096)), 'field');
  assert.equal(safeField('<script>alert(1)</script>'), 'field');
  assert.equal(safeField(null), 'field');
});

test('readObject refuses an unknown field instead of ignoring it', () => {
  assert.deepEqual(readObject({ a: 1 }, ['a', 'b'], ['a'], ''), { a: 1 });
  assert.throws(() => readObject({ a: 1, displayName: 'Mama' }, ['a'], ['a'], ''), (e) => e.extra.reason === 'unknown_field');
  assert.throws(() => readObject({}, ['a'], ['a'], ''), (e) => e.extra.reason === 'missing');
  for (const bad of [null, undefined, 'x', 7, []]) {
    assert.throws(() => readObject(bad, ['a'], [], ''), (e) => e.extra.reason === 'not_an_object');
  }
});

test('the space-creation limit is a stated number, not an accident', () => {
  // Finding E2-203-6: ADR 003 §6.1 publishes no limiter for POST /spaces and limits.js declares
  // it unlimited on grounds that do not hold for a bootstrap route. Five per hour is the
  // stand-in, and it is exported so a reviewer can find it and LZP-205 can replace it.
  assert.equal(SPACES_PER_IP_HOUR, 5);
});

test('a missing or absurd limit falls back to the ADR value, never to unlimited', () => {
  assert.equal(limitOf({ limits: { invitesPerIpHour: 3 } }, 'invitesPerIpHour', 10), 3);
  assert.equal(limitOf({ limits: {} }, 'invitesPerIpHour', 10), 10);
  assert.equal(limitOf({ limits: { invitesPerIpHour: 0 } }, 'invitesPerIpHour', 10), 10);
  assert.equal(limitOf({ limits: { invitesPerIpHour: -1 } }, 'invitesPerIpHour', 10), 10);
  assert.equal(limitOf({}, 'invitesPerIpHour', 10), 10);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The coverage arithmetic, on its own
// ═════════════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────────────────────
// INVERTED 2026-08-29 — finding E2E3-8. The row below asserted that `requiredRecipients` owes a
// `rec_<memberId>` wrap for EVERY member of EVERY space. That is ADR 002 §4.2 step 2 read
// literally, it is what closed finding E3-2 for the personal space, and for a FAMILY space it
// was an obligation no client in the world could discharge: `familyRecipients()` in
// `src/js/crypto/spacekeys.js` produces no recovery recipient at all, and its header says so.
// Every family rotation was `409 incomplete_coverage`.
//
// The obvious repair — build the family recovery recipient from `Member.recoveryPubKex` — is a
// live break of 21.1/21.2, because NOTHING SIGNS `recoveryPubKex`. Swapping `recoveryPubSig` is
// loud (every attestation of that member stops verifying); swapping `recoveryPubKex` alone is
// silent, leaves every attestation genuine, is invisible in the member list, and hands the relay
// `FSK_{e+1}`. So the demand is withdrawn for the family space and KEPT for the personal one,
// where `personalRecipients()` builds that recipient from my own locally-held key.
//
// The row is not deleted: it is now asserted in both directions, and the family half carries the
// reason it is `false` rather than being absent.
test('requiredRecipients names every live device, and a member RK_kex only where one can be BOUND (E3-2, E2E3-8)', () => {
  const members = [
    { id: 'mem_a', removedAt: null }, { id: 'mem_b', removedAt: null },
    { id: 'mem_gone', removedAt: new Date(1) },
  ];
  const devices = [
    { id: 'dev_a1', memberId: 'mem_a', revokedAt: null },
    { id: 'dev_a2', memberId: 'mem_a', revokedAt: new Date(1) },
    { id: 'dev_b1', memberId: 'mem_b', revokedAt: null },
    { id: 'dev_x1', memberId: 'mem_gone', revokedAt: null },
  ];
  // PERSONAL — unchanged. `personalRecipients()` REFUSES a device that is not mine and builds
  // the recovery recipient from `me.recoveryKexPubRaw`, a key that never came off the relay.
  assert.deepEqual(requiredRecipients(members, devices, 'PERSONAL'), ['dev_a1', 'dev_b1', 'rec_mem_a', 'rec_mem_b']);
  // FAMILY — devices only. The recovery wrap stays PERMITTED (it is a known recipient, so a
  // client that can bind the key may send it and it lands) and is no longer REQUIRED.
  assert.deepEqual(requiredRecipients(members, devices, 'FAMILY'), ['dev_a1', 'dev_b1']);
  // The teeth are all still where they matter: a hostile admin still cannot omit a live device.
  assert.equal(requiredRecipients(members, devices, 'FAMILY').includes('dev_b1'), true);

  assert.deepEqual(staleRecipients(members, devices), ['dev_a2', 'dev_x1', 'rec_mem_gone'],
    'a removed member is still owed nothing and still keeps nothing — T2 is untouched by this');
  assert.equal(knownRecipients(members, devices).has('dev_a2'), true, 'a revoked device is still KNOWN');
  assert.equal(knownRecipients(members, devices).has('rec_mem_a'), true,
    'and a family recovery wrap is still PERMITTED — this is a withdrawn demand, not a ban');
  assert.equal(knownRecipients(members, devices).has('dev_stranger'), false);

  // A caller that forgets the kind gets a 500, not a silently wrong obligation.
  assert.throws(() => requiredRecipients(members, devices), (e) => e.status === 500);
});

test('an empty space requires nothing; a member with no devices owes a recovery wrap only in a PERSONAL space', () => {
  assert.deepEqual(requiredRecipients([], [], 'PERSONAL'), []);
  assert.deepEqual(requiredRecipients([], [], 'FAMILY'), []);
  assert.deepEqual(requiredRecipients([{ id: 'mem_a', removedAt: null }], [], 'PERSONAL'), ['rec_mem_a']);
  assert.deepEqual(requiredRecipients([{ id: 'mem_a', removedAt: null }], [], 'FAMILY'), [],
    'finding E2E3-8: a family member with no live device is owed nothing the wire can deliver yet');
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. POST /spaces  (15.2)
// ═════════════════════════════════════════════════════════════════════════════

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`${adapter.name} :: ${name}`, fn);

  T('createSpace makes a space, a member, a device and an epoch-1 key ring in one call', async () => {
    const { store, ctx } = await withSpace(adapter);
    const space = await store.getSpace(SPACE);
    assert.equal(space.kind, 'FAMILY');
    assert.equal(space.currentEpoch, 1);
    assert.equal(space.nextSeq, 0n);
    const members = await store.listMembers(SPACE);
    assert.equal(members.length, 1);
    assert.equal(members[0].colorRef, 'gruen');
    assert.deepEqual(members[0].recoveryPubKex, ADMIN.recoveryPubKex, 'RK_kex survives the round trip AS BYTES');
    const devices = await store.listDevices(SPACE);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].deviceShort, ADMIN.deviceShort);
    assert.equal((await store.getKeyWraps(SPACE, ADMIN.deviceId)).length, 1);
    assert.equal((await store.getKeyWraps(SPACE, recoveryRecipient(ADMIN.memberId))).length, 1);
    assert.deepEqual(ctx._logged, [{ route: 'createSpace', spaceId: SPACE, deviceShort: ADMIN.deviceShort, status: 200 }]);
  });

  T('createSpace REFUSES a key ring that does not cover the creator, and creates nothing', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const ctx = asPerson(store, clock, ADMIN);
    // The MEMBER is wrapped; the DEVICE is not — which is the half the coverage rule still
    // demands of every space kind, and the half a hostile client would omit.
    // (Inverted for finding E2E3-8: this used to omit `rec_<memberId>` from a FAMILY creation.
    // A family space no longer owes that wrap, because no client can build it without handing
    // the relay the family key. The personal-space case keeps the RK_kex demand and is the row
    // 'omitting a member RK_kex is still refused where it can be BOUND' below.)
    await expectFail(
      () => createSpace(req({ body: createBody(ADMIN, { wraps: [wrap(recoveryRecipient(ADMIN.memberId), 1, 1)] }) }), ctx),
      409, 'incomplete_coverage', 'a key ring missing the creator\'s own device',
    );
    assert.equal(await store.getSpace(SPACE), null, 'the whole creation rolled back');
    assert.deepEqual(await store.listMembers(SPACE), []);
    assert.equal(await store.getDeviceByShort(SPACE, ADMIN.deviceShort), null);
  });

  T('createSpace refuses a key ring that covers only the recovery key', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const err = await expectFail(
      () => createSpace(req({ body: createBody(ADMIN, { wraps: [wrap(recoveryRecipient(ADMIN.memberId), 1, 1)] }) }), asPerson(store, clock, ADMIN)),
      409, 'incomplete_coverage',
    );
    assert.deepEqual(err.extra.missing, [{ recipientId: ADMIN.deviceId, epoch: 1 }]);
    assert.equal(err.extra.missingCount, 1);
  });

  T('a display name cannot enter through the door, and nothing is created when one tries', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const ctx = asPerson(store, clock, ADMIN);
    for (const extra of [{ displayName: 'Mama' }, { name: 'Familie Weber' }, { role: 'admin' }, { wrappedKeys: 'x' }]) {
      const err = await expectFail(() => createSpace(req({ body: { ...createBody(ADMIN), ...extra } }), ctx), 400, 'bad_request');
      assert.equal(err.extra.reason, 'unknown_field');
    }
    assert.equal(await store.getSpace(SPACE), null);
  });

  T('colorRef is bounded, because it is the one readable string a client can write', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const ctx = asPerson(store, clock, ADMIN);
    // ADR 003 §5.2 names Member.colorRef as the ONE deliberate plaintext leak. An unbounded one
    // would be a plaintext column with a different name.
    for (const c of [
      'Zahnarzt um 14:30 bei Dr. Müller',
      'a'.repeat(200),
      'Gruen',                       // upper case
      '../../etc/passwd',
      '',
      'x',                           // one character — below the floor, so a single-letter smuggle
    ]) {
      await expectFail(() => createSpace(req({ body: createBody(ADMIN, { colorRef: c }) }), ctx), 400, 'bad_request', c);
    }
    for (const c of ['blau', 'gruen', 'tuerkis', 'schiefer', 'neue-farbe']) {
      const fresh = adapter.make(fakeClock());
      const res = await createSpace(req({ body: createBody(ADMIN, { colorRef: c }) }), makeCtx(fresh, clock, { auth: { deviceShort: ADMIN.deviceShort } }));
      assert.equal(res.status, 200, c);
    }
  });

  T('a device may not name itself into the recovery-recipient namespace', async () => {
    // KeyWrap.recipientId admits `dev_…` OR `rec_<memberId>` (extension E2-I5). A device allowed
    // to call itself `rec_mem_…` would be handed the wraps addressed to a member's recovery key.
    const clock = fakeClock();
    const store = adapter.make(clock);
    const ctx = asPerson(store, clock, ADMIN);
    for (const badId of [
      `rec_${MOM.memberId}`, MOM.memberId, `dev_${id22(9)}x`, 'dev_short', `DEV_${id22(9)}`,
    ]) {
      const body = createBody(ADMIN);
      body.device = { ...deviceBody(ADMIN), deviceId: badId };
      await expectFail(() => createSpace(req({ body }), ctx), 400, 'bad_request', badId);
    }
  });

  T('a wrap may not be addressed outside the space, at creation or at rotation', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const ctx = asPerson(store, clock, ADMIN);
    const body = createBody(ADMIN, {
      wraps: [wrap(ADMIN.deviceId, 1, 1), wrap(recoveryRecipient(ADMIN.memberId), 1, 2), wrap(MOM.deviceId, 1, 3)],
    });
    const err = await expectFail(() => createSpace(req({ body }), ctx), 400, 'bad_request');
    assert.equal(err.extra.reason, 'unknown_recipient');
    assert.equal(await store.getSpace(SPACE), null);
  });

  T('the space id prefix and the kind must agree', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const ctx = asPerson(store, clock, ADMIN);
    await expectFail(() => createSpace(req({ body: createBody(ADMIN, { kind: 'PERSONAL' }) }), ctx), 400, 'bad_request');
    await expectFail(() => createSpace(req({ body: createBody(ADMIN, { kind: 'TEAM' }) }), ctx), 400, 'bad_request');
    const ok = await createSpace(req({ body: createBody(ADMIN, { kind: 'PERSONAL', spaceId: `psp_${id22(4)}` }) }), ctx);
    assert.equal(ok.body.kind, 'PERSONAL');
  });

  T('a public key of the wrong length is refused before it can be stored', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const ctx = asPerson(store, clock, ADMIN);
    for (const patch of [
      { sigPubRaw: b64(bytes(64, 1)) }, { kexPubRaw: b64(bytes(66, 1)) },
    ]) {
      const body = createBody(ADMIN);
      body.device = { ...deviceBody(ADMIN), ...patch };
      const err = await expectFail(() => createSpace(req({ body }), ctx), 400, 'bad_request');
      assert.equal(err.extra.reason, 'wrong_length');
    }
    const body = createBody(ADMIN);
    body.member = { ...memberBody(ADMIN), recoveryPubKex: b64(bytes(32, 1)) };
    await expectFail(() => createSpace(req({ body }), ctx), 400, 'bad_request');
  });

  T('a second space with the same id, or the same device, is refused and changes nothing', async () => {
    const { store, clock } = await withSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const err = await expectFail(() => createSpace(req({ body: createBody(ADMIN) }), ctx), 400, 'bad_request');
    assert.equal(err.extra.reason, 'exists');
    assert.equal((await store.listMembers(SPACE)).length, 1, 'the original space is untouched');

    // ROUND 10 ITEM 8: what is refused here is the reused `deviceId`, and ONLY that. E2-203-1's
    // half — one Mac, one Device row, globally, so a user with a personal space could not create
    // a family one — is closed; the row below ('a Mac that already has a space CAN create a
    // second one') is the positive case, and this one now proves the id collision on its own.
    // MOM's member row, and a device MOM really attested that reuses ADMIN's `deviceId`. The
    // attestation therefore VERIFIES (finding E2E3-7 made that a precondition of getting this
    // far), so the request reaches the store check this row is about instead of stopping at 401.
    const momsMac = await attestedDeviceFor(MOM, { deviceId: ADMIN.deviceId });
    const second = createBody(ADMIN, { spaceId: OTHER_SPACE });
    second.member = { ...memberBody(MOM) };
    second.device = deviceWire(momsMac);
    second.wraps = [wrap(ADMIN.deviceId, 1, 1), wrap(recoveryRecipient(MOM.memberId), 1, 2)];
    const err2 = await expectFail(
      () => createSpace(req({ body: second }), makeCtx(store, clock, { auth: { deviceShort: momsMac.deviceShort } })),
      400, 'bad_request');
    assert.equal(err2.extra.reason, 'registered');
    assert.equal(err2.extra.field, 'device.deviceId');
  });

  T('a Mac that already has a space CAN create a second one — E2-203-1, closed (round 10 item 8)', async () => {
    // The flow this round unblocked, on the wire: one machine, one `IK_sig`, one `deviceShort`
    // for life (ADR 002 §2.1), and 19.4 + 15.2 both need it. The ONLY thing that changes between
    // the two requests is the space and the member row — the device's short and keys are the
    // same bytes, deliberately, because that is what used to be refused.
    const { store, clock } = await withSpace(adapter);
    // The SAME machine: `borrowKeysFrom` hands MOM's new attestation ADMIN's actual public
    // points, so the payload MOM signs carries ADMIN's `deviceShort` — which is what one Mac in
    // two circles genuinely looks like, since ADR 002 §2.1 mints `IK_sig` per DEVICE.
    const sameMac = await attestedDeviceFor(MOM, { borrowKeysFrom: ADMIN });
    assert.equal(sameMac.deviceShort, ADMIN.deviceShort, 'one machine, one short, for life');

    const second = createBody(ADMIN, { spaceId: OTHER_SPACE, colorRef: 'blau' });
    second.member = { ...memberBody(MOM) };
    second.device = deviceWire(sameMac);
    second.wraps = [wrap(sameMac.deviceId, 1, 1), wrap(recoveryRecipient(MOM.memberId), 1, 2)];
    const ctx = makeCtx(store, clock, { auth: { deviceShort: sameMac.deviceShort } });
    const res = await createSpace(req({ body: second }), ctx);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.spaceId, OTHER_SPACE);

    // Two rows, one machine, one key — and the correlation that follows is stated rather than
    // denied (ADR 003 §5.1, server-metadata.md §7, attack-relay-correlate.test.js §2).
    const both = await store.listDevicesByShort(sameMac.deviceShort);
    assert.equal(both.length, 2, 'one Mac, a row in each circle');
    assert.equal(new Set(both.map((d) => d.spaceId)).size, 2);
    assert.equal(new Set(both.map((d) => [...d.sigPubRaw].join(','))).size, 1, 'and one public key');
  });

  T('signing with one device and registering another is refused', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    // The auth layer verified MOM's key; the body registers ADMIN's device.
    const ctx = makeCtx(store, clock, { auth: { deviceShort: MOM.deviceShort } });
    await expectFail(() => createSpace(req({ body: createBody(ADMIN) }), ctx), 403, 'device_mismatch');
    assert.equal(await store.getSpace(SPACE), null);
  });

  T('space creation is rate limited per IP, and an unknown IP shares one budget', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const limits = { ...LIMITS, spacesPerIpHour: 2 };
    const mk = async (seed, ip) => {
      const p = await person({ colorRef: 'blau' });
      const ctx = makeCtx(store, clock, { auth: { deviceShort: p.deviceShort }, limits });
      const body = createBody(p, { spaceId: `fsp_${id22(600 + seed)}`, colorRef: 'blau' });
      return () => createSpace(fromIp(ip, { body }), ctx);
    };
    assert.equal((await (await mk(1, '198.51.100.7'))()).status, 200);
    assert.equal((await (await mk(2, '198.51.100.7'))()).status, 200);
    const err = await expectFail(await mk(3, '198.51.100.7'), 429, 'rate_limited');
    assert.equal(err.extra.retryAfter, 3600, '429 must carry Retry-After (ADR 003 §6.1)');
    // A different IP has its own budget…
    assert.equal((await (await mk(4, '198.51.100.8'))()).status, 200);
    // …but two callers with NO usable address share ONE bucket rather than each getting a fresh
    // two. `limits.js` puts them all in the `?` identity; an unknown origin must never be handed
    // a private budget, which is what per-request keying would silently do.
    assert.equal((await (await mk(5, null))()).status, 200);
    assert.equal((await (await mk(6, null))()).status, 200);
    await expectFail(await mk(7, null), 429, 'rate_limited', 'an unknown origin must not mint a budget');
    // …and a header that is present but not address-shaped lands in the same shared bucket
    // rather than minting a private one per spoofed value.
    await expectFail(await mk(8, 'not-an-address'), 429, 'rate_limited', 'a junk XFF must not mint a budget');
  });

  T('a rate-limited creation consumes no rows', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const ctx = makeCtx(store, clock, { auth: { deviceShort: ADMIN.deviceShort }, limits: { ...LIMITS, spacesPerIpHour: 1 } });
    await createSpace(req({ body: createBody(ADMIN) }), ctx);
    const p = await person({ colorRef: 'blau' });
    const ctx2 = makeCtx(store, clock, { auth: { deviceShort: p.deviceShort }, limits: { ...LIMITS, spacesPerIpHour: 1 } });
    await expectFail(() => createSpace(req({ body: createBody(p, { spaceId: OTHER_SPACE }) }), ctx2), 429, 'rate_limited');
    assert.equal(await store.getSpace(OTHER_SPACE), null);
  });

  T('a wrap at creation may only be for epoch 1', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const ctx = asPerson(store, clock, ADMIN);
    await expectFail(
      () => createSpace(req({ body: createBody(ADMIN, { wraps: [wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 1, 2)] }) }), ctx),
      400, 'bad_request',
    );
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. POST /spaces/:id/epoch — THE COVERAGE CONTROL
  // ═══════════════════════════════════════════════════════════════════════════

  T('a full rotation moves the epoch and stores the ring', async () => {
    const { store, clock } = await withSpace(adapter);
    await joinDirect(store, clock, MOM, 'blau');
    const ctx = asPerson(store, clock, ADMIN);
    const wraps = [
      wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2),
      wrap(MOM.deviceId, 2, 3), wrap(recoveryRecipient(MOM.memberId), 2, 4),
      // MOM joined after epoch 1 was minted, so the backfill is hers alone (ADR 002 §7.1 step 5).
      wrap(MOM.deviceId, 1, 5), wrap(recoveryRecipient(MOM.memberId), 1, 6),
    ];
    const res = await rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps }), ctx);
    assert.equal(res.status, 200);
    assert.equal(res.body.currentEpoch, 2);
    assert.equal(res.body.wrapsStored, 6);
    assert.equal((await store.getSpace(SPACE)).currentEpoch, 2);
    assert.deepEqual((await store.getKeyWraps(SPACE, MOM.deviceId)).map((w) => w.epoch).sort(), [1, 2]);
  });

  T('THE ATTACK: a rotation that omits an honest member is refused, and consumes nothing', async () => {
    const { store, clock } = await withSpace(adapter);
    await joinDirect(store, clock, MOM, 'blau');
    const ctx = asPerson(store, clock, ADMIN);
    // The admin rotates and wraps only to herself. Before this check existed, this was a 200 and
    // Mom simply stopped being able to read anything the family wrote from now on — with no error
    // anywhere, because the one device that could notice is the one that cannot decrypt.
    const selfish = [wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2)];
    const err = await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: selfish }), ctx), 409, 'incomplete_coverage');
    const missing = err.extra.missing.map((m) => `${m.recipientId}@${m.epoch}`).sort();
    // INVERTED 2026-08-29 — finding E2E3-8. `rec_${MOM.memberId}@1` and `@2` used to be on this
    // list. They are not any more, and the ATTACK this row is about is unaffected: the admin
    // still cannot rotate while omitting Mom's DEVICE, which is the whole of 20.2's control. What
    // is gone is a demand no client could satisfy — see `requiredRecipients` and its header.
    assert.deepEqual(missing, [
      `${MOM.deviceId}@1`, `${MOM.deviceId}@2`,
    ], 'the client is told exactly whom it forgot, at which epochs');

    const space = await store.getSpace(SPACE);
    assert.equal(space.currentEpoch, 1, 'the epoch did not move');
    assert.deepEqual(await store.getKeyWraps(SPACE, ADMIN.deviceId), (await store.getKeyWraps(SPACE, ADMIN.deviceId)).filter((w) => w.epoch === 1), 'no epoch-2 wrap was kept');
    assert.equal((await store.getKeyWraps(SPACE, ADMIN.deviceId)).length, 1);

    // AND the epoch was not consumed: the honest retry succeeds at 2, not at 3. A refused
    // rotation that burned e+1 would wedge the family exactly as effectively as the attack.
    const full = [
      ...selfish, wrap(MOM.deviceId, 2, 3), wrap(recoveryRecipient(MOM.memberId), 2, 4),
      wrap(MOM.deviceId, 1, 5), wrap(recoveryRecipient(MOM.memberId), 1, 6),
    ];
    const ok = await rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: full }), ctx);
    assert.equal(ok.body.currentEpoch, 2);
  });

  T('THE OTHER HALF: covering only the current epoch cuts a joiner off from the history', async () => {
    // ADR 002 §7.1 step 5 — the wrap covers ALL epochs 1..e "so the joiner sees the shared
    // history: Oma's birthday entered three years ago must render (A4, 17.1)". Before D9 that
    // arrived in the invite blob; D9 deleted the blob and left the requirement, so this rotation
    // is the only delivery path there is.
    const { store, clock } = await withSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    // Two rotations first, so there is a history to miss.
    await rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: [wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2)] }), ctx);
    await joinDirect(store, clock, MOM, 'blau');
    const onlyCurrent = [
      wrap(ADMIN.deviceId, 3, 1), wrap(recoveryRecipient(ADMIN.memberId), 3, 2),
      wrap(MOM.deviceId, 3, 3), wrap(recoveryRecipient(MOM.memberId), 3, 4),
    ];
    const err = await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 3, wraps: onlyCurrent }), ctx), 409, 'incomplete_coverage');
    assert.deepEqual(
      err.extra.missing.map((m) => `${m.recipientId}@${m.epoch}`).sort(),
      [`${MOM.deviceId}@1`, `${MOM.deviceId}@2`],
      'inverted for finding E2E3-8: the HISTORY half of the coverage rule is untouched — a joiner '
      + 'is still owed every epoch 1..e on her device, which is what keeps Oma\'s birthday visible',
    );
    assert.equal((await store.getSpace(SPACE)).currentEpoch, 2);

    const withHistory = [...onlyCurrent];
    for (const e of [1, 2]) {
      withHistory.push(wrap(MOM.deviceId, e, 10 + e), wrap(recoveryRecipient(MOM.memberId), e, 20 + e));
    }
    const ok = await rotateEpoch(rotateReq(SPACE, { epoch: 3, wraps: withHistory }), ctx);
    assert.equal(ok.body.currentEpoch, 3);
    assert.deepEqual((await store.getKeyWraps(SPACE, MOM.deviceId)).map((w) => w.epoch).sort(), [1, 2, 3]);
  });

  // INVERTED 2026-08-29 — finding E2E3-8, and this is the row that moved rather than died.
  // It used to rotate a FAMILY space omitting `rec_<MOM>` and assert a 409. `familyRecipients()`
  // builds no recovery recipient, so that 409 fired on every honest client too, and the obvious
  // repair (build it from the unsigned `Member.recoveryPubKex`) hands the relay the family key.
  // The demand — and therefore this row — moves to the PERSONAL space, where the wrap is built
  // from my own locally-held `RK_kex` and the E3-2 clause is still both true and dischargeable.
  T('omitting a member RK_kex is still refused where it can be BOUND — a PERSONAL space (E3-2)', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const me = await person({ colorRef: 'gruen' });
    const psp = `psp_${id22(77)}`;
    const ctx = makeCtx(store, clock, { auth: { deviceShort: me.deviceShort } });
    await createSpace(req({
      body: {
        spaceId: psp, kind: 'PERSONAL', colorRef: 'gruen',
        member: memberBody(me), device: deviceWire(me),
        wraps: [wrap(me.deviceId, 1, 1), wrap(recoveryRecipient(me.memberId), 1, 2)],
      },
    }), ctx);
    const noRecovery = [wrap(me.deviceId, 2, 3), wrap(me.deviceId, 1, 4)];
    const err = await expectFail(
      () => rotateEpoch(req({ path: `/api/v1/spaces/${psp}/epoch`, params: { id: psp }, body: { epoch: 2, wraps: noRecovery } }),
        makeCtx(store, clock, { auth: { deviceShort: me.deviceShort, deviceId: me.deviceId, memberId: me.memberId } })),
      409, 'incomplete_coverage');
    assert.equal(err.extra.missing.every((m) => m.recipientId === recoveryRecipient(me.memberId)), true,
      'she keeps reading today and loses everything the day she replaces her Mac from the backup file');
  });

  // The family half of the same clause, stated as the OPEN GAP it is rather than left unsaid.
  T('a FAMILY rotation that omits every RK_kex is ACCEPTED — finding E2E3-8, open', async () => {
    const { store, clock } = await withSpace(adapter);
    await joinDirect(store, clock, MOM, 'blau');
    const ctx = asPerson(store, clock, ADMIN);
    const noRecovery = [
      wrap(ADMIN.deviceId, 2, 1), wrap(MOM.deviceId, 2, 3), wrap(MOM.deviceId, 1, 4),
    ];
    const ok = await rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: noRecovery }), ctx);
    assert.equal(ok.body.currentEpoch, 2);
    // The consequence, written down where it will be read: a family member who loses every device
    // has no wrap addressed to her recovery key, so ADR 002 §7.3's A2 recovery of a FAMILY space
    // waits for the next rotation by somebody else. That is the price of not wrapping to an
    // unsigned public key, and it is reversible the moment `recoveryPubKex` is bound (ADR 002
    // §2.3). The wrap is still PERMITTED, so a client that can bind it needs no server change:
    const withRec = [wrap(recoveryRecipient(MOM.memberId), 3, 7), wrap(recoveryRecipient(MOM.memberId), 1, 8),
      wrap(recoveryRecipient(MOM.memberId), 2, 9), wrap(ADMIN.deviceId, 3, 10),
      wrap(MOM.deviceId, 3, 11), wrap(ADMIN.deviceId, 1, 12), wrap(ADMIN.deviceId, 2, 13)];
    const ok2 = await rotateEpoch(rotateReq(SPACE, { epoch: 3, wraps: withRec }), ctx);
    assert.equal(ok2.body.currentEpoch, 3);
    assert.equal((await store.getKeyWraps(SPACE, recoveryRecipient(MOM.memberId))).length, 3,
      'permitted, not banned — the row lands as soon as a client can build it');
  });

  T('a revoked device is not owed a wrap, and its old wraps are purged', async () => {
    const { store, clock } = await withSpace(adapter);
    await joinDirect(store, clock, MOM, 'blau');
    await store.putKeyWraps([
      { spaceId: SPACE, epoch: 1, recipientId: MOM.deviceId, wrapped: bytes(156, 1), senderDeviceId: ADMIN.deviceId },
      { spaceId: SPACE, epoch: 1, recipientId: recoveryRecipient(MOM.memberId), wrapped: bytes(156, 2), senderDeviceId: ADMIN.deviceId },
    ]);
    await store.revokeDevice(MOM.deviceId, clock.now());
    const ctx = asPerson(store, clock, ADMIN);
    const wraps = [
      wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2),
      wrap(recoveryRecipient(MOM.memberId), 2, 3),
    ];
    const res = await rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps }), ctx);
    assert.equal(res.status, 200);
    assert.equal(res.body.wrapsPurged, 1, 'the revoked device lost its epoch-1 wrap');
    assert.deepEqual(await store.getKeyWraps(SPACE, MOM.deviceId), []);
  });

  T('a removed member is owed nothing and keeps nothing (T2)', async () => {
    const { store, clock } = await withSpace(adapter);
    await joinDirect(store, clock, MOM, 'blau');
    await store.putKeyWraps([
      { spaceId: SPACE, epoch: 1, recipientId: MOM.deviceId, wrapped: bytes(156, 1), senderDeviceId: ADMIN.deviceId },
      { spaceId: SPACE, epoch: 1, recipientId: recoveryRecipient(MOM.memberId), wrapped: bytes(156, 2), senderDeviceId: ADMIN.deviceId },
    ]);
    await store.removeMember(MOM.memberId, clock.now());
    const ctx = asPerson(store, clock, ADMIN);
    const res = await rotateEpoch(rotateReq(SPACE, {
      epoch: 2, wraps: [wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2)],
    }), ctx);
    assert.equal(res.body.wrapsPurged, 2);
    assert.deepEqual(await store.getKeyWraps(SPACE, MOM.deviceId), []);
    assert.deepEqual(await store.getKeyWraps(SPACE, recoveryRecipient(MOM.memberId)), []);
  });

  T('a stranger and a removed member cannot rotate', async () => {
    const { store, clock } = await withSpace(adapter);
    await joinDirect(store, clock, MOM, 'blau');
    const full = [
      wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2),
      wrap(MOM.deviceId, 2, 3), wrap(recoveryRecipient(MOM.memberId), 2, 4),
      wrap(MOM.deviceId, 1, 5), wrap(recoveryRecipient(MOM.memberId), 1, 6),
    ];
    // A stranger whose auth layer happily vouched for them: the HANDLER refuses, so a route left
    // out of SPACE_SCOPED cannot silently open a space up.
    await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: full }), asPerson(store, clock, KID)), 403, 'not_a_member');
    // A member of another space.
    await joinDirect(store, clock, KID, 'rot', OTHER_SPACE).catch(() => {});
    await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: full }), asPerson(store, clock, KID)), 403, 'not_a_member');
    // A removed member — instant, one column (ADR 003 §2).
    await store.removeMember(MOM.memberId, clock.now());
    await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: full }), asPerson(store, clock, MOM)), 403, 'not_a_member');
    assert.equal((await store.getSpace(SPACE)).currentEpoch, 1);
  });

  T('a rotation on a space that does not exist is not_a_member, not a 404 oracle', async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    await expectFail(
      () => rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: [wrap(ADMIN.deviceId, 2, 1)] }), asPerson(store, clock, ADMIN)),
      403, 'not_a_member',
    );
  });

  T('the epoch must be exactly the next one', async () => {
    const { store, clock } = await withSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const w = (e) => [wrap(ADMIN.deviceId, e, 1), wrap(recoveryRecipient(ADMIN.memberId), e, 2)];
    await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 1, wraps: w(1) }), ctx), 409, 'epoch_taken');
    const jump = await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 5, wraps: w(5) }), ctx), 400, 'bad_request');
    assert.equal(jump.extra.reason, 'not_next');
    for (const bad of [0, -1, 1.5, '2', null, 2 ** 53]) {
      await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: bad, wraps: w(2) }), ctx), 400, 'bad_request', String(bad));
    }
    assert.equal((await store.getSpace(SPACE)).currentEpoch, 1);
  });

  T('two rotations racing for one epoch: exactly one wins', async () => {
    const { store, clock } = await withSpace(adapter);
    await joinDirect(store, clock, MOM, 'blau');
    const full = (seed) => [
      wrap(ADMIN.deviceId, 2, seed), wrap(recoveryRecipient(ADMIN.memberId), 2, seed + 1),
      wrap(MOM.deviceId, 2, seed + 2), wrap(recoveryRecipient(MOM.memberId), 2, seed + 3),
      wrap(MOM.deviceId, 1, seed + 4), wrap(recoveryRecipient(MOM.memberId), 1, seed + 5),
    ];
    const results = await Promise.allSettled([
      rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: full(1) }), asPerson(store, clock, ADMIN)),
      rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: full(50) }), asPerson(store, clock, MOM)),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.equal(won.length, 1, 'exactly one rotation may own epoch 2');
    assert.equal(lost.length, 1);
    assert.equal(lost[0].reason.status, 409);
    assert.equal((await store.getSpace(SPACE)).currentEpoch, 2);
    // And the winner's wraps are the ones stored — not a half-and-half of both.
    for (const r of [ADMIN.deviceId, MOM.deviceId, recoveryRecipient(ADMIN.memberId), recoveryRecipient(MOM.memberId)]) {
      const two = (await store.getKeyWraps(SPACE, r)).filter((x) => x.epoch === 2);
      assert.equal(two.length, 1, `${r} holds exactly one epoch-2 wrap`);
    }
  });

  T('the D9-retired `invites` field is refused rather than silently ignored', async () => {
    const { store, clock } = await withSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const wraps = [wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2)];
    const err = await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps, invites: [] }), ctx), 400, 'bad_request');
    assert.equal(err.extra.reason, 'retired_by_d9');
    // …and an invite blob smuggled in under any spelling is a plain unknown field.
    await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps, wrappedKeys: 'x' }), ctx), 400, 'bad_request');
  });

  T('open invites follow the rotation; used and revoked ones do not', async () => {
    const { store, clock } = await withSpace(adapter);
    const open = id22(41);
    const used = id22(42);
    const revoked = id22(43);
    for (const [id, patch] of [[open, {}], [used, { usedAt: new Date(clock.now()) }], [revoked, { revokedAt: new Date(clock.now()) }]]) {
      await store.putInvite({
        id, spaceId: SPACE, verifier: bytes(32, 1), wrapSalt: bytes(32, 2), epoch: 1,
        createdBy: ADMIN.memberId, expiresAt: new Date(clock.now() + 604800000),
        usedAt: null, revokedAt: null, ...patch,
      });
    }
    const res = await rotateEpoch(rotateReq(SPACE, {
      epoch: 2, wraps: [wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2)],
    }), asPerson(store, clock, ADMIN));
    assert.equal(res.body.invitesRefreshed, 1);
    assert.equal((await store.getInvite(open)).epoch, 2, 'a pending invite is not silently invalidated (ADR 002 §4.2 step 3)');
    assert.equal((await store.getInvite(used)).epoch, 1);
    assert.equal((await store.getInvite(revoked)).epoch, 1);
  });

  T('wrap batches are bounded, and a duplicate (recipient, epoch) is refused', async () => {
    const { store, clock } = await withSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const base = [wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2)];
    // Two wraps for one address in one request: the store upserts, so the last would win by
    // arrival order and which key ring a member ends up holding would be a coin flip.
    const dup = [...base, wrap(ADMIN.deviceId, 2, 99)];
    const err = await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: dup }), ctx), 400, 'bad_request');
    assert.equal(err.extra.reason, 'duplicate_recipient_epoch');

    const huge = [{ recipientId: ADMIN.deviceId, epoch: 2, wrapped: b64(bytes(WRAP_MAX_BYTES + 1, 1)) }];
    await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: huge }), ctx), 413, 'payload_too_large');

    const many = [];
    for (let i = 0; i <= MAX_WRAPS; i++) many.push({ recipientId: `dev_${id22(1000 + i)}`, epoch: 2, wrapped: b64(bytes(16, i)) });
    await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: many }), ctx), 413, 'payload_too_large');

    for (const bad of [[], null, 'x', {}]) {
      await expectFail(() => rotateEpoch(rotateReq(SPACE, { epoch: 2, wraps: bad }), ctx), 400, 'bad_request', JSON.stringify(bad));
    }
    assert.equal((await store.getSpace(SPACE)).currentEpoch, 1);
  });

  T('order of operations: membership is proved before a 1024-entry wrap list is parsed', async () => {
    // `rotateEpoch` carries no rate limiter (limits.js RATE_COVERAGE), so the membership check is
    // the only thing between a stranger and the parse. A stranger sending a malformed body must
    // therefore see 403, not the 400 that would prove the parser ran first.
    const { store, clock } = await withSpace(adapter);
    const junk = { epoch: 'not a number', wraps: 'not an array', invites: 'also wrong' };
    await expectFail(() => rotateEpoch(rotateReq(SPACE, junk), asPerson(store, clock, KID)), 403, 'not_a_member');
    // …and the same body from a member does reach the parser.
    await expectFail(() => rotateEpoch(rotateReq(SPACE, junk), asPerson(store, clock, ADMIN)), 400, 'bad_request');
  });

  T('order of operations: the IP budget is charged before the signature is verified', async () => {
    // ADR 003 §6.1's IP limits exist to bound work, and verifying a P-256 signature is the
    // expensive half of a request. A limiter that runs after auth protects the database and
    // leaves the CPU open, so a request that would fail auth must still cost budget.
    const clock = fakeClock();
    const store = adapter.make(clock);
    const limits = { ...LIMITS, spacesPerIpHour: 2 };
    const bad = () => createSpace(fromIp('198.51.100.9', { body: createBody(ADMIN) }), makeCtx(store, clock, { auth: { deviceShort: MOM.deviceShort }, limits }));
    await expectFail(bad, 403, 'device_mismatch');
    await expectFail(bad, 403, 'device_mismatch');
    await expectFail(bad, 429, 'rate_limited', 'a failing signature still spends the budget');
  });

  T('a rotation in one space never touches another', async () => {
    const { store, clock } = await withSpace(adapter);
    const other = await person({ colorRef: 'rot' });
    const ctx2 = makeCtx(store, clock, { auth: { deviceShort: other.deviceShort } });
    await createSpace(req({
      body: createBody(other, {
        spaceId: OTHER_SPACE, colorRef: 'rot',
        wraps: [wrap(other.deviceId, 1, 1), wrap(recoveryRecipient(other.memberId), 1, 2)],
      }),
    }), ctx2);
    await rotateEpoch(rotateReq(SPACE, {
      epoch: 2, wraps: [wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2)],
    }), asPerson(store, clock, ADMIN));
    assert.equal((await store.getSpace(OTHER_SPACE)).currentEpoch, 1, 'the other family did not move');
    assert.equal((await store.getKeyWraps(OTHER_SPACE, other.deviceId)).length, 1);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. GET /spaces/:id/members — 15.4
  // ═══════════════════════════════════════════════════════════════════════════

  T('the member list carries ids, a colour and public keys — and no name anywhere', async () => {
    const { store, clock } = await withSpace(adapter);
    await joinDirect(store, clock, MOM, 'blau');
    const res = await listMembers(req({ method: 'GET', params: { id: SPACE } }), asPerson(store, clock, ADMIN));
    assert.equal(res.status, 200);
    assert.equal(res.body.currentEpoch, 1);
    assert.equal(res.body.members.length, 2);
    const mom = res.body.members.find((m) => m.memberId === MOM.memberId);
    assert.deepEqual(Object.keys(mom).sort(), ['colorRef', 'devices', 'joinedAt', 'memberId', 'recoveryPubKex', 'recoveryPubSig', 'removedAt'].sort());
    assert.equal(mom.colorRef, 'blau');
    assert.equal(mom.recoveryPubKex, b64(MOM.recoveryPubKex), 'E3-2: RK_kex is finally on the wire');
    assert.deepEqual(Object.keys(mom.devices[0]).sort(), ['attestation', 'deviceId', 'deviceShort', 'kexPubRaw', 'revokedAt', 'sigPubRaw']);

    // ── INVERTED 2026-08-29 — finding E2E3-6 ──────────────────────────────────────────────
    // This row asserted `JSON.stringify(res.body).includes(b64(MOM.attestation)) === false`, on
    // the grounds that "a client that verified the relay's copy would hand back the property
    // that a malicious relay cannot fabricate a device". That reasoning is still right and it is
    // still enforced — by `recipientProblem()`, which verifies the blob under the HOUSING
    // member's `recoveryPubSig` before it decides anything. What the row missed is that
    // `familyRecipients()`, the only constructor of the branded recipient set ADR 002 §3 barrier
    // 2 is made of, THROWS without this field. So the roster this very endpoint serves could not
    // be turned into a recipient set and family rotation was unbuildable by anyone.
    //
    // ADR 002 §4.2 step 6 had already specified this roster — "relay coordination data
    // (`MemberRowDb.recoveryPubSig` plus the `dev.*` blobs)". The blob is published as a HINT.
    assert.equal(mom.devices[0].attestation, MOM.attestation,
      'byte for byte as it was signed — a re-encoding would fail every signature over it');

    // AND IT COSTS 21.1 NOTHING, which is checked rather than asserted: every field inside the
    // published blob is a value the relay already holds in a column of its own.
    const payload = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(mom.devices[0].attestation.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
    assert.deepEqual(Object.keys(payload).sort(),
      ['createdAt', 'deviceId', 'deviceShort', 'kexPubRaw', 'memberId', 'sigPubRaw'],
      'the payload is a CLOSED field set at the door, so there are no free bits to smuggle in');
    assert.equal(payload.memberId, mom.memberId);
    assert.equal(payload.deviceId, mom.devices[0].deviceId);
    assert.equal(payload.deviceShort, mom.devices[0].deviceShort);
    assert.equal(payload.sigPubRaw, mom.devices[0].sigPubRaw);
    assert.equal(payload.kexPubRaw, mom.devices[0].kexPubRaw);
    assert.match(payload.createdAt, /^\d{4}-\d{2}-\d{2}$/,
      'a DAY — strictly coarser than the Device.addedAt the relay keeps to the millisecond');

    for (const forbidden of ['displayName', 'name', 'role', 'wrapped', 'wrappedKeys', 'verifier']) {
      assert.equal(JSON.stringify(res.body).includes(forbidden), false, `${forbidden} reached the wire`);
    }
  });

  T('a removed member stays on the list, marked', async () => {
    // ADR 001 §5 step 3 folds ops against the member set; dropping a departed member would make
    // every op she ever wrote unattributable.
    const { store, clock } = await withSpace(adapter);
    await joinDirect(store, clock, MOM, 'blau');
    await store.removeMember(MOM.memberId, clock.now());
    const res = await listMembers(req({ method: 'GET', params: { id: SPACE } }), asPerson(store, clock, ADMIN));
    const mom = res.body.members.find((m) => m.memberId === MOM.memberId);
    assert.equal(typeof mom.removedAt, 'string');
    assert.equal(res.body.members.find((m) => m.memberId === ADMIN.memberId).removedAt, null);
  });

  T('the member list is members-only, and an unknown space answers the same 403', async () => {
    const { store, clock } = await withSpace(adapter);
    const get = (spaceId, who) => listMembers(req({ method: 'GET', params: { id: spaceId } }), asPerson(store, clock, who));
    await expectFail(() => get(SPACE, MOM), 403, 'not_a_member', 'a stranger');
    await expectFail(() => get(OTHER_SPACE, ADMIN), 403, 'not_a_member', 'a space that does not exist');
    await expectFail(() => listMembers(req({ method: 'GET', params: { id: 'not-a-space' } }), asPerson(store, clock, ADMIN)), 400, 'bad_request');
  });

  T('memberProjection is byte-identical whichever endpoint publishes it', async () => {
    const { store, clock } = await withSpace(adapter);
    await joinDirect(store, clock, MOM, 'blau');
    const a = await memberProjection(store, SPACE);
    const b = await memberProjection(store, SPACE);
    assert.equal(JSON.stringify(a), JSON.stringify(b), 'stable order — two devices must compare identical documents');
    assert.deepEqual(a.map((m) => m.memberId), [...a.map((m) => m.memberId)].sort());
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. The register of things this ticket could not fix
// ═════════════════════════════════════════════════════════════════════════════

test('every ctx extension and handler finding states its reason and its owner', () => {
  assert.equal(CTX_EXTENSIONS.length, 1, 'ctx.ip was withdrawn in favour of limits.js clientIp()');
  for (const e of CTX_EXTENSIONS) {
    for (const k of ['id', 'member', 'shape', 'why', 'suppliedBy']) {
      assert.equal(typeof e[k], 'string', `${e.id}.${k}`);
      const floor = { id: 5, member: 6, shape: 6, why: 60, suppliedBy: 20 }[k];
      assert.ok(e[k].length >= floor, `${e.id}.${k} must say something (>= ${floor} chars)`);
    }
  }
  assert.deepEqual(CTX_EXTENSIONS.map((e) => e.member), ['ctx.sha256']);

  assert.ok(HANDLER_FINDINGS.length >= 6);
  const ids = new Set();
  for (const f of HANDLER_FINDINGS) {
    for (const k of ['id', 'what', 'consequence', 'fix', 'owner']) {
      assert.equal(typeof f[k], 'string', `${f.id}.${k}`);
      const floor = k === 'id' ? 8 : k === 'owner' ? 12 : 60;
      assert.ok(f[k].length >= floor, `${f.id}.${k} must be a sentence, not a label (>= ${floor})`);
    }
    assert.equal(ids.has(f.id), false, `duplicate finding id ${f.id}`);
    ids.add(f.id);
    assert.equal(f.owner.includes('handlers/'), false, 'a finding owned by this ticket is a bug, not a finding');
  }
});
