// tests/server/invites.test.js — LZP-203: invites under PO decision D9.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PROPERTY THIS FILE DEFENDS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// D9: **an invite carries no key material of any kind.** A leaked invitation email is never
// sufficient to read family content. So every assertion here is one of four kinds:
//
//   1. **nothing readable, and nothing key-shaped, crosses the wire or reaches a column.** The
//      whole JSON of every 200 this suite provokes is scanned for the field names D9 deleted and
//      for the bytes of a wrap, and the stored `Invite` row is compared against the closed column
//      set. `wrappedKeys` cannot be stored (store-interface C06) and must also never be *emitted*.
//   2. **single use, atomically.** Two racing redemptions, exactly one winner — the property
//      ADR 002 §7.1 states as a SQL statement and that a handler is entirely capable of getting
//      wrong by reading before it writes.
//   3. **a failed redemption never burns the invite.** A colour collision, a duplicate device, a
//      rate limit: each of them, before the transaction was drawn where it is, would have left
//      Mom holding a code that no longer works. 15.3 promises she is in "within a minute"; a
//      one-shot code destroyed by a recoverable error breaks that promise silently.
//   4. **an invite cannot be resurrected.** `putInvite` is an upsert, so re-POSTing the id of a
//      used or revoked invite would reset `usedAt`/`revokedAt` — undoing 15.5's "a leaked link
//      can't haunt the family" on request.
//
// Everything runs against BOTH adapters and on an injected clock: the 7-day TTL is tested by
// moving the clock, never by waiting.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { memoryStore } from '../../server/adapters/memory.js';
import { attestedPerson, attestedDeviceFor, deviceWire, memberWire } from './_attested-person.js';
import { fileStore } from '../../server/adapters/file.js';
import { MODEL_COLUMNS } from '../../server/core/store-interface.js';
import {
  createSpace, rotateEpoch, recoveryRecipient, bytesToB64u,
} from '../../server/core/handlers/spaces.js';
import {
  createInvite, redeemInvite, revokeInvite, openInvites,
  bytesEqual, INVITE_TTL_MS, MAX_OPEN_INVITES, FORBIDDEN_RESPONSE_FIELDS, INVITE_ROUTES,
} from '../../server/core/handlers/invites.js';

// ─────────────────────────────────────────────────────────────────────────────
// Harness — deliberately a copy of spaces.test.js's, because a shared helper file is a file this
// ticket does not own (ADR 005 §1.7 enumerates tests/ too).
// ─────────────────────────────────────────────────────────────────────────────

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-invites-'));
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
const sha256 = (b) => new Uint8Array(createHash('sha256').update(b).digest());

const LIMITS = Object.freeze({
  opsPerPush: 200, bytesPerEnvelope: 65536, bytesPerRequest: 4194304, opsPerPull: 500,
  pushPerMin: 60, pullPerMin: 120, invitesPerIpHour: 10, pairGetPerIpHour: 20,
  pairSessionsPerMemberHour: 10, pairAttempts: 5, authWindowMs: 120000, nonceTtlMs: 300000,
  spacesPerIpHour: 1000,
});

/** Every response body this suite sees, so the blindness scan can run over all of them at once. */
const seenBodies = [];

function makeCtx(store, clock, opts) {
  const o = opts || {};
  let randSeed = 100;
  return {
    store,
    now: () => clock.now(),
    random: (n) => bytes(n, randSeed++),
    limits: o.limits || LIMITS,
    auth: async () => o.auth || { deviceShort: null, deviceId: null, memberId: null },
    assertMember: async () => {},
    log: () => {},
    ...(o.noDigest ? {} : { sha256: async (b) => sha256(b) }),
  };
}

/** `limits.js` reads the client address out of the headers, so the tests speak headers. */
const req = (extra) => ({
  method: 'POST', path: '/api/v1/invites', query: {}, headers: { 'x-forwarded-for': '203.0.113.9' },
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

/** Record and return a handler result, so §7's blindness scan sees every 200 the suite makes. */
function capture(res) {
  seenBodies.push(res.body);
  return res;
}

// ── people, and the code a human would type ──────────────────────────────────

// A person is now REAL — see `_attested-person.js` and finding E2E3-7. `POST /invites/redeem`
// shares `readDevice` with `POST /spaces`, and that reader now requires the attestation to parse
// and to describe the very device being registered, so a fixture made of noise is refused.
const person = attestedPerson;
const memberBody = memberWire;
const deviceBody = deviceWire;
const wrap = (recipientId, epoch, seed) => ({ recipientId, epoch, wrapped: b64(bytes(156, seed || 1)) });

/**
 * Stand in for the client's HKDF. The real derivation lives in `src/js/crypto/` (a parallel
 * work package owns it); what matters to the SERVER is only the shape of the two derived values
 * and that neither of them is the code.
 */
function inviteFromCode(codeSeed) {
  const code = pick(CROCKFORD, 12, codeSeed);            // 12 Crockford chars = 60 bits
  const inviteId = b64(sha256(new TextEncoder().encode(`id|${code}`)).slice(0, 16));
  const proof = sha256(new TextEncoder().encode(`verify|${code}`));
  return { code, inviteId, proof, verifier: sha256(proof) };
}

const ADMIN = await person({ colorRef: 'gruen' });
const MOM = await person({ colorRef: 'blau' });
const KID = await person({ colorRef: 'rot' });
const STRANGER = await person({ colorRef: 'schiefer' });
const SPACE = `fsp_${id22(2)}`;
const OTHER_SPACE = `fsp_${id22(3)}`;

const asPerson = (store, clock, p, o) => makeCtx(store, clock, {
  auth: { deviceShort: p.deviceShort, deviceId: p.deviceId, memberId: p.memberId }, ...o,
});
/** The bootstrap ctx: the auth layer verified the key that is being registered, nothing more. */
const asNewDevice = (store, clock, p, o) => makeCtx(store, clock, {
  auth: { deviceShort: p.deviceShort, deviceId: null, memberId: null }, ...o,
});

async function makeSpace(adapter, spaceId, admin) {
  const clock = fakeClock();
  const store = adapter.make(clock);
  const who = admin || ADMIN;
  await createSpace(req({
    body: {
      spaceId: spaceId || SPACE, kind: 'FAMILY', colorRef: 'gruen',
      member: memberBody(who), device: deviceBody(who),
      wraps: [wrap(who.deviceId, 1, 1), wrap(recoveryRecipient(who.memberId), 1, 2)],
    },
  }), asNewDevice(store, clock, who));
  return { store, clock };
}

const redeemBody = (inv, p, colorRef) => ({
  inviteId: inv.inviteId, proof: b64(inv.proof), colorRef: colorRef || 'blau',
  member: memberBody(p), device: deviceBody(p),
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Pure pieces
// ═════════════════════════════════════════════════════════════════════════════

test('bytesEqual is length-safe, type-safe and has no early exit', () => {
  assert.equal(bytesEqual(bytes(32, 1), bytes(32, 1)), true);
  assert.equal(bytesEqual(bytes(32, 1), bytes(32, 2)), false);
  assert.equal(bytesEqual(bytes(32, 1), bytes(31, 1)), false);
  const a = bytes(32, 1);
  const b = new Uint8Array(a); b[31] ^= 1;
  assert.equal(bytesEqual(a, b), false, 'a difference in the LAST byte must still be seen');
  for (const bad of [null, undefined, 'x', [1, 2], Buffer.from([1])]) {
    assert.equal(bytesEqual(bytes(1, 1), bad), false, String(bad));
  }
  // Read the source: no `return` inside the comparison loop.
  const src = bytesEqual.toString();
  const loop = src.slice(src.indexOf('for ('));
  assert.equal(/return/.test(loop.slice(0, loop.indexOf('return diff'))), false, 'the loop must not short-circuit');
});

test('the invite constants are the published ones', () => {
  assert.equal(INVITE_TTL_MS, 7 * 24 * 3600 * 1000, '7 days (story 15.5)');
  assert.equal(MAX_OPEN_INVITES, 20);
  assert.deepEqual([...INVITE_ROUTES].sort(), ['createInvite', 'openInvites', 'redeemInvite', 'revokeInvite']);
  for (const f of ['wrappedKeys', 'wrapped', 'verifier', 'proof']) {
    assert.ok(FORBIDDEN_RESPONSE_FIELDS.includes(f), `${f} must be on the response blocklist`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2..6 — the handlers, against both adapters
// ═════════════════════════════════════════════════════════════════════════════

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`${adapter.name} :: ${name}`, fn);

  // ── create ────────────────────────────────────────────────────────────────

  T('an invite stores two derived values, a 7-day expiry, and no key material', async () => {
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(1);
    const res = capture(await createInvite(req({
      body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) },
    }), asPerson(store, clock, ADMIN)));
    assert.equal(res.status, 200);
    assert.equal(res.body.inviteId, inv.inviteId);
    assert.equal(res.body.epoch, 1);
    assert.equal(res.body.createdBy, ADMIN.memberId);
    assert.equal(new Date(res.body.expiresAt).getTime() - clock.now(), INVITE_TTL_MS);

    const row = await store.getInvite(inv.inviteId);
    assert.deepEqual(Object.keys(row).sort(), [...MODEL_COLUMNS.Invite].sort(),
      'the stored row is exactly the closed column set — there is nowhere for a key to live');
    assert.deepEqual(row.verifier, inv.verifier);
    assert.equal(row.wrapSalt.length, 32);
    // Server-generated, not caller-supplied: 32 attacker-chosen bytes against an
    // attacker-chosen id would be a small covert store (finding E2-203-4).
    assert.equal(bytesEqual(row.wrapSalt, inv.proof), false);
    assert.equal(row.usedAt, null);
    assert.equal(row.revokedAt, null);
  });

  T('the raw code never reaches the server, and neither does anything shaped like one', async () => {
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(2);
    const ctx = asPerson(store, clock, ADMIN);
    for (const extra of [
      { code: inv.code }, { wrappedKeys: 'x' }, { keys: [] }, { displayName: 'Mama' }, { ttlMs: 1 },
    ]) {
      const err = await expectFail(() => createInvite(req({
        body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier), ...extra },
      }), ctx), 400, 'bad_request', Object.keys(extra)[0]);
      assert.equal(err.extra.reason, 'unknown_field');
    }
    assert.equal(await store.getInvite(inv.inviteId), null);
  });

  T('a malformed invite id or verifier is refused before anything is stored', async () => {
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(3);
    const ctx = asPerson(store, clock, ADMIN);
    for (const id of ['', 'short', `${inv.inviteId}x`, 'inv_' + inv.inviteId, null, 42]) {
      await expectFail(() => createInvite(req({ body: { spaceId: SPACE, inviteId: id, verifier: b64(inv.verifier) } }), ctx), 400, 'bad_request', String(id));
    }
    for (const v of [b64(bytes(31, 1)), b64(bytes(33, 1)), 'not b64', '']) {
      await expectFail(() => createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: v } }), ctx), 400, 'bad_request', String(v));
    }
  });

  T('only a current member of the named space may issue an invite', async () => {
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(4);
    const body = { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) };
    await expectFail(() => createInvite(req({ body }), asPerson(store, clock, STRANGER)), 403, 'not_a_member');
    await expectFail(() => createInvite(req({ body: { ...body, spaceId: OTHER_SPACE } }), asPerson(store, clock, ADMIN)), 403, 'not_a_member');
    assert.equal(await store.getInvite(inv.inviteId), null);
  });

  T('THE RESURRECTION GUARD: a used or revoked invite id cannot be re-POSTed back to life', async () => {
    // `putInvite` is an upsert. Without this check, 15.5's "a leaked link can't haunt the family"
    // is undone by re-sending the same id: usedAt and revokedAt would both reset to null.
    const { store, clock } = await makeSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const inv = inviteFromCode(5);
    const body = { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) };
    await createInvite(req({ body }), ctx);
    await revokeInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId } }), ctx);
    const err = await expectFail(() => createInvite(req({ body }), ctx), 400, 'bad_request');
    assert.equal(err.extra.reason, 'exists');
    assert.notEqual((await store.getInvite(inv.inviteId)).revokedAt, null, 'still revoked');

    // …and the same for a redeemed one, including with a DIFFERENT verifier, which would
    // otherwise let the issuer re-point an id at a code of their choosing.
    const inv2 = inviteFromCode(6);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv2.inviteId, verifier: b64(inv2.verifier) } }), ctx);
    await redeemInvite(req({ body: redeemBody(inv2, MOM) }), asNewDevice(store, clock, MOM));
    await expectFail(() => createInvite(req({
      body: { spaceId: SPACE, inviteId: inv2.inviteId, verifier: b64(bytes(32, 99)) },
    }), ctx), 400, 'bad_request');
    assert.notEqual((await store.getInvite(inv2.inviteId)).usedAt, null, 'still used');
  });

  T('open invites are capped per space, and the cap counts only live ones', async () => {
    const { store, clock } = await makeSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    for (let i = 0; i < MAX_OPEN_INVITES; i++) {
      const inv = inviteFromCode(100 + i);
      assert.equal((await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), ctx)).status, 200);
    }
    const over = inviteFromCode(999);
    const err = await expectFail(() => createInvite(req({
      body: { spaceId: SPACE, inviteId: over.inviteId, verifier: b64(over.verifier) },
    }), ctx), 400, 'bad_request');
    assert.equal(err.extra.reason, 'too_many_open');

    // Revoking one frees a slot: the cap is on OPEN invites, not on invites ever issued.
    const first = inviteFromCode(100);
    await revokeInvite(req({ body: { spaceId: SPACE, inviteId: first.inviteId } }), ctx);
    assert.equal((await createInvite(req({ body: { spaceId: SPACE, inviteId: over.inviteId, verifier: b64(over.verifier) } }), ctx)).status, 200);
  });

  T('invite creation carries no rate limiter, and the open-invite cap is what bounds it', async () => {
    // `limits.js` RATE_COVERAGE declares createInvite unlimited: it is reachable only behind the
    // whole ADR 003 §2 chain, so a flood is attributable to one device of one current member and
    // revocable with one column write. What volume here actually buys an attacker is REDEEMABLE
    // MEMBERSHIPS, and the cap on simultaneously-open invites bounds that directly.
    const { store, clock } = await makeSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const before = await store.rateAllow('probe', 3600000, 1);
    for (let i = 0; i < 12; i++) {
      const inv = inviteFromCode(200 + i);
      assert.equal((await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), ctx)).status, 200, `invite ${i}`);
    }
    assert.equal(before, true);
    assert.equal((await openInvites(req({ method: 'GET', query: { spaceId: SPACE } }), ctx)).body.invites.length, 12);
  });

  // ── redeem ────────────────────────────────────────────────────────────────

  T('redeeming admits the member, publishes public keys, and returns NO key material (D9)', async () => {
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(10);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), asPerson(store, clock, ADMIN));

    const res = capture(await redeemInvite(req({ body: redeemBody(inv, MOM, 'blau') }), asNewDevice(store, clock, MOM)));
    assert.equal(res.status, 200);
    assert.equal(res.body.spaceId, SPACE, 'the space comes from the invite, never from the caller');
    assert.equal(res.body.memberId, MOM.memberId);
    assert.equal(res.body.currentEpoch, 1);
    // D9's designed waiting state, as a fact rather than a guess.
    assert.equal(res.body.pendingKeys, true);
    assert.equal((await store.getKeyWraps(SPACE, MOM.deviceId)).length, 0,
      'a joiner holds no epoch key: the family ops she can pull are ciphertext she cannot open');

    // 15.4 — the member list shows her immediately. From the product's point of view the join
    // has succeeded here, before any key arrives.
    assert.equal(res.body.members.length, 2);
    const mom = res.body.members.find((m) => m.memberId === MOM.memberId);
    assert.equal(mom.colorRef, 'blau');
    assert.equal(mom.devices[0].deviceShort, MOM.deviceShort);
    assert.notEqual((await store.getInvite(inv.inviteId)).usedAt, null);
  });

  T('THE RACE: two devices redeem one invite at the same instant — exactly one wins', async () => {
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(11);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), asPerson(store, clock, ADMIN));
    const results = await Promise.allSettled([
      redeemInvite(req({ body: redeemBody(inv, MOM, 'blau') }), asNewDevice(store, clock, MOM)),
      redeemInvite(req({ body: redeemBody(inv, KID, 'rot') }), asNewDevice(store, clock, KID)),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    assert.equal(won.length, 1, 'single use is not advisory');
    assert.equal(lost[0].reason.status, 409);
    assert.equal(lost[0].reason.code, 'invite_used');
    const members = await store.listMembers(SPACE);
    assert.equal(members.length, 2, 'exactly one joiner was admitted');
    const devices = await store.listDevices(SPACE);
    assert.equal(devices.length, 2);
  });

  T('a wrong code is refused and does NOT consume the invite', async () => {
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(12);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), asPerson(store, clock, ADMIN));
    const wrong = { ...redeemBody(inv, MOM), proof: b64(bytes(32, 77)) };
    await expectFail(() => redeemInvite(req({ body: wrong }), asNewDevice(store, clock, MOM)), 403, 'invite_invalid');
    assert.equal((await store.getInvite(inv.inviteId)).usedAt, null, 'a typo must not burn the code');
    assert.equal((await store.listMembers(SPACE)).length, 1);
    // The right code still works afterwards.
    assert.equal((await redeemInvite(req({ body: redeemBody(inv, MOM) }), asNewDevice(store, clock, MOM))).status, 200);
  });

  T('an unknown invite id is invite_invalid, and says nothing about whether it ever existed', async () => {
    const { store, clock } = await makeSpace(adapter);
    const ghost = inviteFromCode(13);
    await expectFail(() => redeemInvite(req({ body: redeemBody(ghost, MOM) }), asNewDevice(store, clock, MOM)), 403, 'invite_invalid');
  });

  T('the invite state is only described to a caller who has proved they hold the code', async () => {
    // An eavesdropper who saw an id on the wire, and does not have the code, must not be able to
    // poll "has it been redeemed yet". So the verifier is checked BEFORE used/revoked/expired.
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(14);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), asPerson(store, clock, ADMIN));
    await redeemInvite(req({ body: redeemBody(inv, MOM) }), asNewDevice(store, clock, MOM));
    // With the code: "you were too late".
    await expectFail(() => redeemInvite(req({ body: redeemBody(inv, KID, 'rot') }), asNewDevice(store, clock, KID)), 409, 'invite_used');
    // Without it: the same answer a nonexistent invite gives.
    await expectFail(() => redeemInvite(req({
      body: { ...redeemBody(inv, KID, 'rot'), proof: b64(bytes(32, 5)) },
    }), asNewDevice(store, clock, KID)), 403, 'invite_invalid');
  });

  T('an expired invite is refused, on the injected clock, and a revoked one too', async () => {
    const { store, clock } = await makeSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const late = inviteFromCode(15);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: late.inviteId, verifier: b64(late.verifier) } }), ctx);
    clock.advance(INVITE_TTL_MS - 1);
    // One millisecond before the deadline it still works…
    const stillOk = await store.getInvite(late.inviteId);
    assert.ok(stillOk.expiresAt.getTime() > clock.now());
    clock.advance(2);
    await expectFail(() => redeemInvite(req({ body: redeemBody(late, MOM) }), asNewDevice(store, clock, MOM)), 403, 'invite_invalid');

    const killed = inviteFromCode(16);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: killed.inviteId, verifier: b64(killed.verifier) } }), ctx);
    await revokeInvite(req({ body: { spaceId: SPACE, inviteId: killed.inviteId } }), ctx);
    await expectFail(() => redeemInvite(req({ body: redeemBody(killed, MOM) }), asNewDevice(store, clock, MOM)), 403, 'invite_invalid');
    assert.equal((await store.listMembers(SPACE)).length, 1);
  });

  T('a colour collision rolls the redemption back — the code still works (15.3)', async () => {
    // This is the case that makes the transaction boundary load-bearing. `consumeInvite` is
    // atomic and irreversible on its own; the colour check happens after it, so without the
    // rollback Mom's first attempt would burn her one-shot code on a recoverable mistake.
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(17);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), asPerson(store, clock, ADMIN));
    const err = await expectFail(
      () => redeemInvite(req({ body: redeemBody(inv, MOM, 'gruen') }), asNewDevice(store, clock, MOM)),
      400, 'bad_request', 'gruen is the admin colour',
    );
    assert.equal(err.extra.reason, 'taken');
    assert.equal((await store.getInvite(inv.inviteId)).usedAt, null, 'THE INVITE SURVIVED');
    assert.equal((await store.listMembers(SPACE)).length, 1);
    const ok = await redeemInvite(req({ body: redeemBody(inv, MOM, 'blau') }), asNewDevice(store, clock, MOM));
    assert.equal(ok.status, 200);
  });

  T('a duplicate member id, device id or device short rolls the redemption back too', async () => {
    const { store, clock } = await makeSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const mk = async (seed) => {
      const inv = inviteFromCode(seed);
      await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), ctx);
      return inv;
    };
    // The two device clashes are now built as REAL attestations, because `readDevice` refuses a
    // blob that does not describe the device it arrives with (finding E2E3-7) — so swapping a
    // field in `deviceBody(MOM)` no longer reaches the store check this row is about, it stops
    // at the door. Mom therefore attests, under her OWN recovery key, a device that carries
    // ADMIN's label in one case and ADMIN's public keys (and therefore ADMIN's short) in the
    // other. Both blobs verify; both must still be refused by the relay's uniqueness checks.
    const momClaimsAdminsLabel = await attestedDeviceFor(MOM, { deviceId: ADMIN.deviceId });
    const momClaimsAdminsShort = await attestedDeviceFor(MOM, { borrowKeysFrom: ADMIN });
    const clash = [
      ['member.memberId', { ...redeemBody(await mk(18), MOM), member: { ...memberBody(MOM), memberId: ADMIN.memberId } }],
      ['device.deviceId', { ...redeemBody(await mk(19), MOM), device: deviceWire(momClaimsAdminsLabel) }],
      ['device.deviceShort', { ...redeemBody(await mk(20), MOM), device: deviceWire(momClaimsAdminsShort) }],
    ];
    for (const [field, body] of clash) {
      const err = await expectFail(() => redeemInvite(req({ body }), makeCtx(store, clock, { auth: { deviceShort: body.device.deviceShort } })), 400, 'bad_request', field);
      assert.equal(err.extra.field, field);
      assert.equal((await store.getInvite(body.inviteId)).usedAt, null, `${field}: the invite survived`);
    }
    assert.equal((await store.listMembers(SPACE)).length, 1);
  });

  T('signing with one device and registering another is refused, and burns nothing', async () => {
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(21);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), asPerson(store, clock, ADMIN));
    // The auth layer verified KID's key; the body registers MOM's device.
    await expectFail(() => redeemInvite(req({ body: redeemBody(inv, MOM) }), asNewDevice(store, clock, KID)), 403, 'device_mismatch');
    assert.equal((await store.getInvite(inv.inviteId)).usedAt, null);
  });

  T('redemption is rate limited per IP (10/hour) and a limited attempt burns nothing', async () => {
    const { store, clock } = await makeSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const inv = inviteFromCode(22);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), ctx);

    const limits = { ...LIMITS, invitesPerIpHour: 3 };
    const guess = (seed) => redeemInvite(
      fromIp('198.51.100.4', { body: { ...redeemBody(inv, MOM), proof: b64(bytes(32, 500 + seed)) } }),
      makeCtx(store, clock, { auth: { deviceShort: MOM.deviceShort }, limits }),
    );
    // The limit is charged BEFORE the lookup, so guessing costs budget rather than being free.
    for (let i = 0; i < 3; i++) await expectFail(() => guess(i), 403, 'invite_invalid');
    const err = await expectFail(() => guess(9), 429, 'rate_limited');
    assert.equal(err.extra.retryAfter, 3600);
    // …and the honest redeemer from another address is unaffected.
    const ok = await redeemInvite(fromIp('198.51.100.5', { body: redeemBody(inv, MOM) }), makeCtx(store, clock, {
      auth: { deviceShort: MOM.deviceShort }, limits,
    }));
    assert.equal(ok.status, 200);
  });

  T('order of operations: a redemption that fails auth still spends the IP budget', async () => {
    // `inviteRedeem` is a `pre-auth` rule in limits.js precisely so that a flood of requests that
    // will fail signature verification is bounded before the verification happens.
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(26);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), asPerson(store, clock, ADMIN));
    const limits = { ...LIMITS, invitesPerIpHour: 2 };
    // Signed by KID, registering MOM: device_mismatch, every time.
    const bad = () => redeemInvite(
      fromIp('198.51.100.9', { body: redeemBody(inv, MOM) }),
      makeCtx(store, clock, { auth: { deviceShort: KID.deviceShort }, limits }),
    );
    await expectFail(bad, 403, 'device_mismatch');
    await expectFail(bad, 403, 'device_mismatch');
    await expectFail(bad, 429, 'rate_limited');
    assert.equal((await store.getInvite(inv.inviteId)).usedAt, null);
  });

  T('a missing digest fails closed — a broken ctx must never accept a proof', async () => {
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(23);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), asPerson(store, clock, ADMIN));
    await expectFail(
      () => redeemInvite(req({ body: redeemBody(inv, MOM) }), makeCtx(store, clock, { auth: { deviceShort: MOM.deviceShort }, noDigest: true })),
      500, 'internal',
    );
    assert.equal((await store.getInvite(inv.inviteId)).usedAt, null);
    assert.equal((await store.listMembers(SPACE)).length, 1);
  });

  T('a name, a role or a key cannot be smuggled into a redemption', async () => {
    const { store, clock } = await makeSpace(adapter);
    const inv = inviteFromCode(24);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), asPerson(store, clock, ADMIN));
    const ctx = asNewDevice(store, clock, MOM);
    for (const extra of [
      { displayName: 'Mama' }, { role: 'admin' }, { spaceId: OTHER_SPACE }, { wrappedKeys: 'x' },
      { epoch: 9 },
    ]) {
      await expectFail(() => redeemInvite(req({ body: { ...redeemBody(inv, MOM), ...extra } }), ctx), 400, 'bad_request', Object.keys(extra)[0]);
    }
    // …and the member's own sub-object is closed too.
    await expectFail(() => redeemInvite(req({
      body: { ...redeemBody(inv, MOM), member: { ...memberBody(MOM), displayName: 'Mama' } },
    }), ctx), 400, 'bad_request');
    await expectFail(() => redeemInvite(req({ body: { ...redeemBody(inv, MOM), proof: b64(bytes(31, 1)) } }), ctx), 400, 'bad_request');
    assert.equal((await store.getInvite(inv.inviteId)).usedAt, null);
  });

  T('a joiner is admitted with no key ring, and the next rotation must backfill her history', async () => {
    // The end-to-end shape of D9 + ADR 002 §7.1 step 5, across both handlers.
    const { store, clock } = await makeSpace(adapter);
    const admin = asPerson(store, clock, ADMIN);
    const inv = inviteFromCode(25);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), admin);
    await redeemInvite(req({ body: redeemBody(inv, MOM) }), asNewDevice(store, clock, MOM));

    const rot = (wraps) => rotateEpoch(req({
      path: `/api/v1/spaces/${SPACE}/epoch`, params: { id: SPACE }, body: { epoch: 2, wraps },
    }), admin);
    const onlyNew = [
      wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2),
      wrap(MOM.deviceId, 2, 3), wrap(recoveryRecipient(MOM.memberId), 2, 4),
    ];
    await expectFail(() => rot(onlyNew), 409, 'incomplete_coverage', 'Oma\'s birthday would be invisible to Mom');
    const withHistory = [...onlyNew, wrap(MOM.deviceId, 1, 5), wrap(recoveryRecipient(MOM.memberId), 1, 6)];
    assert.equal((await rot(withHistory)).status, 200);
    assert.deepEqual((await store.getKeyWraps(SPACE, MOM.deviceId)).map((w) => w.epoch).sort(), [1, 2]);
  });

  // ── revoke ────────────────────────────────────────────────────────────────

  T('THE CROSS-SPACE GUARD: a member of one family cannot revoke another family\'s invite', async () => {
    const { store, clock } = await makeSpace(adapter);
    // A second family, on the same relay, with its own admin.
    const other = await person({ colorRef: 'ocker' });
    await createSpace(req({
      body: {
        spaceId: OTHER_SPACE, kind: 'FAMILY', colorRef: 'rot',
        member: memberBody(other), device: deviceBody(other),
        wraps: [wrap(other.deviceId, 1, 1), wrap(recoveryRecipient(other.memberId), 1, 2)],
      },
    }), asNewDevice(store, clock, other));
    const theirs = inviteFromCode(30);
    await createInvite(req({ body: { spaceId: OTHER_SPACE, inviteId: theirs.inviteId, verifier: b64(theirs.verifier) } }), asPerson(store, clock, other));

    // Naming their own space (which passes the membership check) and the other family's invite id.
    const res = capture(await revokeInvite(req({ body: { spaceId: SPACE, inviteId: theirs.inviteId } }), asPerson(store, clock, ADMIN)));
    assert.equal(res.body.state, 'unknown', 'it is not theirs to revoke, and they learn nothing about it');
    assert.equal((await store.getInvite(theirs.inviteId)).revokedAt, null, 'the other family\'s invite is untouched');
    // Naming the other family's space fails at the membership check.
    await expectFail(() => revokeInvite(req({ body: { spaceId: OTHER_SPACE, inviteId: theirs.inviteId } }), asPerson(store, clock, ADMIN)), 403, 'not_a_member');
  });

  T('revocation is idempotent and reports the state it found', async () => {
    const { store, clock } = await makeSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const inv = inviteFromCode(31);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), ctx);
    const first = capture(await revokeInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId } }), ctx));
    assert.equal(first.body.state, 'revoked');
    const at = (await store.getInvite(inv.inviteId)).revokedAt.getTime();
    clock.advance(60000);
    const again = await revokeInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId } }), ctx);
    assert.equal(again.body.state, 'revoked');
    assert.equal((await store.getInvite(inv.inviteId)).revokedAt.getTime(), at, 'the first revocation stands');

    const used = inviteFromCode(32);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: used.inviteId, verifier: b64(used.verifier) } }), ctx);
    await redeemInvite(req({ body: redeemBody(used, MOM) }), asNewDevice(store, clock, MOM));
    assert.equal((await revokeInvite(req({ body: { spaceId: SPACE, inviteId: used.inviteId } }), ctx)).body.state, 'used');
    assert.equal((await store.getInvite(used.inviteId)).revokedAt, null, 'a used invite is not re-marked');
  });

  T('a stranger cannot revoke, and a removed member cannot either', async () => {
    const { store, clock } = await makeSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const inv = inviteFromCode(33);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), ctx);
    await expectFail(() => revokeInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId } }), asPerson(store, clock, STRANGER)), 403, 'not_a_member');
    await store.removeMember(ADMIN.memberId, clock.now());
    await expectFail(() => revokeInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId } }), ctx), 403, 'not_a_member');
    assert.equal((await store.getInvite(inv.inviteId)).revokedAt, null);
  });

  // ── open list ─────────────────────────────────────────────────────────────

  T('the open list shows live invites only, and never the verifier', async () => {
    const { store, clock } = await makeSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const live = inviteFromCode(40);
    const used = inviteFromCode(41);
    const revoked = inviteFromCode(42);
    const stale = inviteFromCode(43);
    for (const i of [live, used, revoked, stale]) {
      await createInvite(req({ body: { spaceId: SPACE, inviteId: i.inviteId, verifier: b64(i.verifier) } }), ctx);
    }
    await redeemInvite(req({ body: redeemBody(used, MOM) }), asNewDevice(store, clock, MOM));
    await revokeInvite(req({ body: { spaceId: SPACE, inviteId: revoked.inviteId } }), ctx);

    const res = capture(await openInvites(req({ method: 'GET', query: { spaceId: SPACE } }), ctx));
    assert.deepEqual(res.body.invites.map((i) => i.inviteId).sort(), [live.inviteId, stale.inviteId].sort());
    for (const i of res.body.invites) {
      assert.deepEqual(Object.keys(i).sort(), ['createdBy', 'epoch', 'expiresAt', 'inviteId']);
    }
    const json = JSON.stringify(res.body);
    assert.equal(json.includes(b64(live.verifier)), false, 'the verifier never leaves the database');
    assert.equal(json.includes('wrapSalt'), false);

    clock.advance(INVITE_TTL_MS + 1);
    assert.deepEqual((await openInvites(req({ method: 'GET', query: { spaceId: SPACE } }), ctx)).body.invites, [],
      'an expired invite drops off the list on the clock, with no sweep');
  });

  T('the open list is members-only and scoped to one space', async () => {
    const { store, clock } = await makeSpace(adapter);
    await expectFail(() => openInvites(req({ method: 'GET', query: { spaceId: SPACE } }), asPerson(store, clock, STRANGER)), 403, 'not_a_member');
    await expectFail(() => openInvites(req({ method: 'GET', query: { spaceId: OTHER_SPACE } }), asPerson(store, clock, ADMIN)), 403, 'not_a_member');
    await expectFail(() => openInvites(req({ method: 'GET', query: {} }), asPerson(store, clock, ADMIN)), 400, 'bad_request');
  });

  T('rotating refreshes the open invites without touching their secrets', async () => {
    const { store, clock } = await makeSpace(adapter);
    const ctx = asPerson(store, clock, ADMIN);
    const inv = inviteFromCode(44);
    await createInvite(req({ body: { spaceId: SPACE, inviteId: inv.inviteId, verifier: b64(inv.verifier) } }), ctx);
    const before = await store.getInvite(inv.inviteId);
    await rotateEpoch(req({
      path: `/api/v1/spaces/${SPACE}/epoch`, params: { id: SPACE },
      body: { epoch: 2, wraps: [wrap(ADMIN.deviceId, 2, 1), wrap(recoveryRecipient(ADMIN.memberId), 2, 2)] },
    }), ctx);
    const after = await store.getInvite(inv.inviteId);
    assert.equal(after.epoch, 2, 'a pending invite is not silently invalidated by a rotation');
    assert.deepEqual(after.verifier, before.verifier);
    assert.deepEqual(after.wrapSalt, before.wrapSalt);
    assert.equal(after.expiresAt.getTime(), before.expiresAt.getTime(), 'the TTL is not extended by a rotation');
    // …and the refreshed invite still redeems.
    assert.equal((await redeemInvite(req({ body: redeemBody(inv, MOM) }), asNewDevice(store, clock, MOM))).status, 200);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. The blindness scan, over everything this suite provoked
// ═════════════════════════════════════════════════════════════════════════════

test('no response this suite produced carries a key, a verifier or a name', () => {
  assert.ok(seenBodies.length >= 10, `only ${seenBodies.length} responses captured — the scan needs material`);
  for (const body of seenBodies) {
    const json = JSON.stringify(body);
    // ── `attestation` LEFT THIS BLOCKLIST 2026-08-29 — finding E2E3-6 ──────────────────────
    // `memberProjection` now publishes the device attestation, and the redeem response carries
    // that projection (it is how a joiner learns who is already in the circle). The blob is a
    // SIGNED payload whose field set is closed at the door (`assertAttestationClosed` in
    // `spaces.js`), so every value in it is one the relay already holds in a column of its own —
    // it is not key material and it cannot carry a name. Every other entry still bites.
    //
    // ⚠ CROSS-FILE: `FORBIDDEN_RESPONSE_FIELDS` in `server/core/handlers/invites.js` still lists
    // `attestation` and should drop it. That constant is another pass's file, so the exclusion is
    // made HERE, loudly, rather than reached into — and it is asserted to be exactly one entry so
    // it cannot quietly grow into a hole.
    const stillForbidden = FORBIDDEN_RESPONSE_FIELDS.filter((f) => f !== 'attestation');
    assert.equal(stillForbidden.length, FORBIDDEN_RESPONSE_FIELDS.length - 1,
      'exactly one field left the blocklist, and this is which');
    for (const f of stillForbidden) {
      assert.equal(json.includes(`"${f}"`), false, `${f} appeared on a 200 body: ${json.slice(0, 200)}`);
    }
    for (const word of ['Mama', 'Familie Weber', 'privat', 'Zahnarzt']) {
      assert.equal(json.includes(word), false, `${word} appeared on a 200 body`);
    }
  }
});
