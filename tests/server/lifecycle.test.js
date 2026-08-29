// tests/server/lifecycle.test.js — LZP-204.
//
// Three handler files are proved here, because they are one story and testing them apart would
// miss the joins between them:
//
//   · `server/core/handlers/devices.js`   — who may put a device row in the relay (ADR 002 §2.3)
//   · `server/core/handlers/keys.js`      — key-wrap delivery, all epochs (ADR 002 §4.3, §4.4)
//   · `server/core/handlers/lifecycle.js` — remove / leave / transfer / rename / delete (F20)
//
// THE JOIN THAT MATTERS, AND WHY IT IS ONE FILE. `handlers/spaces.js` (LZP-203) enforces ADR 002
// §4.2's coverage check: a rotation must wrap the new family key to every non-revoked device of
// every current member. That control has a PRECONDITION nobody else tests, and it is here — if
// device registration were open, the obligation would invert into an attack, because an attacker
// who can POST a device row naming Mama's member id has just forced the next honest rotation to
// wrap FSK_{e+1} to their own public key. So the test „an attacker cannot register a device under
// another member" is a test about rotation coverage, and it sits next to „after a removal the
// ex-member is no longer owed a wrap", which is the other end of the same join.
//
// ADVERSARIAL, NOT HAPPY-PATH. These are public endpoints. The cases below are written from the
// attacker's side: the stranger who forges an attestation, the removed partner who tries to
// re-attach a known-good deviceShort, the member who tries to revoke a peer's Mac, the client
// that arrives with `{ name: "Familie Hein" }` in a body.
//
// EVERY CASE RUNS AGAINST BOTH ADAPTERS. The handlers are written against the SyncStore
// interface and never against an adapter, so `memory` and `file` must produce identical answers;
// where they would not, one of them has a bug and the contract has a hole.
//
// NO TEST READS THE WALL CLOCK. Every clock is injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { memoryStore } from '../../server/adapters/memory.js';
import { fileStore } from '../../server/adapters/file.js';
import { fail } from '../../server/core/errors.js';
import {
  registerDevice, adoptDevice, revokeDevice,
  crock32, deviceShortOf, bytesToB64u, b64uToBytes, parseAttestationBlob, DEVICE_LIMIT_DEFAULTS,
} from '../../server/core/handlers/devices.js';
import { fetchKeys, recoveryRecipientId } from '../../server/core/handlers/keys.js';
// LZP-203 owns `rotateEpoch` and the coverage check (`server/core/handlers/spaces.js`); this pass
// withdrew its duplicate rather than binding two handlers to one route name. What is imported
// here is the PURE rule, so the join this ticket does own — a removal must stop the ex-member
// from being owed a wrap — can be asserted without reaching into that pass's handler.
import { requiredRecipients as coverageRequires } from '../../server/core/handlers/spaces.js';
import { LIMITS } from '../../server/core/limits.js';
import {
  removeMember, leaveSpace, transferAdmin, renameSpace, deleteSpace, LIFECYCLE_LIMIT_DEFAULTS,
} from '../../server/core/handlers/lifecycle.js';
// The one cross-boundary import in this file, and it is a TEST-ONLY pin: `devices.js` may not
// import `src/js/core/` (ADR 005 §2 — `server/core` imports only `server/core`), so its Crockford
// encoder is a deliberate duplicate. This import makes a drift between the two a red test rather
// than a device that can never authenticate.
import { deviceShortOf as clientDeviceShortOf } from '../../src/js/core/ids.js';

// ─────────────────────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────────────────────

function fakeClock(startMs) {
  let t = startMs || 1_700_000_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-lifecycle-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const ADAPTERS = [
  { name: 'memory', make: (clock) => memoryStore({ now: clock.now }) },
  { name: 'file', make: (clock) => fileStore(tempDir(), { now: clock.now }) },
];

const CTX_LIMITS = Object.freeze({ ...LIMITS, ...DEVICE_LIMIT_DEFAULTS, ...LIFECYCLE_LIMIT_DEFAULTS });

/** A ctx of the shape ADR 003 §9 types, with auth swapped per call. `auth.js` is LZP-202 and
 *  does not exist yet — which is exactly the point of handlers being pure over `ctx`. */
function makeCtx(store, clock, limits) {
  const state = { auth: null };
  const ctx = {
    store,
    now: () => clock.now(),
    random: (n) => new Uint8Array(n),
    auth: async () => {
      if (!state.auth) throw fail('bad_auth');
      return state.auth;
    },
    assertMember: async (memberId, spaceId) => {
      const members = await store.listMembers(spaceId);
      const m = members.find((x) => x.id === memberId);
      if (!m || m.removedAt !== null) throw fail('not_a_member');
    },
    log: () => {},
    limits: limits || CTX_LIMITS,
  };
  return { ctx, as: (a) => { state.auth = a; return ctx; }, anon: () => { state.auth = null; return ctx; } };
}

const req = (o) => ({ method: 'POST', path: '/api/v1/x', params: {}, query: {}, headers: {}, body: null, rawBody: new Uint8Array(0), routeName: 'x', ...o });

/** Never let a throw escape: every handler failure is a (status, code) pair the client branches on. */
async function call(handler, request, ctx) {
  try {
    const res = await handler(request, ctx);
    return { ok: true, status: res.status, body: res.body };
  } catch (e) {
    return { ok: false, status: e.status, code: e.code, extra: e.extra || null };
  }
}

// ── key material ─────────────────────────────────────────────────────────────

const enc = new TextEncoder();

async function genSig() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { priv: kp.privateKey, pubRaw: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}
async function genKex() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { pubRaw: new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)) };
}

/** `b64u(canonicalJSON(att)) + '.' + b64u(sig)` — ADR 002 §2.3. The server verifies over the
 *  ORIGINAL payload bytes, so plain `JSON.stringify` here is not a shortcut, it is the proof
 *  that no re-canonicalisation happens server-side. */
async function attest(recPriv, att) {
  const payload = enc.encode(JSON.stringify(att));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, recPriv, payload));
  return `${bytesToB64u(payload)}.${bytesToB64u(sig)}`;
}

const SPACE = 'fsp_AAAAAAAAAAAAAAAAAAAAAA';
const SPACE2 = 'fsp_BBBBBBBBBBBBBBBBBBBBBB';

let memberCounter = 0;
const nextMemberId = () => `mem_${String(memberCounter++).padStart(22, 'M')}`;

/** A member, with a real recovery keypair so attestations can actually be signed. */
async function makeMember(store, spaceId, colorRef, opts) {
  const rec = await genSig();
  const recKex = await genKex();
  const id = nextMemberId();
  await store.addMember({
    id,
    spaceId,
    colorRef,
    recoveryPubSig: rec.pubRaw,
    // A member who has not published an RK_kex carries a zero-length value — see
    // `hasPublishedKex`. Publishing one is what makes the recovery half of coverage bite.
    recoveryPubKex: opts && opts.publishKex ? recKex.pubRaw : new Uint8Array(0),
    joinedAt: new Date(0),
    removedAt: null,
  });
  return { id, spaceId, recPriv: rec.priv, recPubRaw: rec.pubRaw, recKexPubRaw: recKex.pubRaw };
}

let deviceCounter = 0;

/** The full registration body for a device of `member`, signed by that member's recovery key. */
async function deviceBody(member, opts) {
  const sig = await genSig();
  const kex = await genKex();
  const deviceId = `dev_${String(deviceCounter++).padStart(22, 'D')}`;
  const deviceShort = await deviceShortOf(sig.pubRaw);
  const att = {
    memberId: (opts && opts.attMemberId) || member.id,
    deviceId: (opts && opts.attDeviceId) || deviceId,
    deviceShort: (opts && opts.attDeviceShort) || deviceShort,
    sigPubRaw: bytesToB64u(sig.pubRaw),
    kexPubRaw: bytesToB64u(kex.pubRaw),
    createdAt: '2026-08-28',
  };
  const signer = (opts && opts.signWith) || member.recPriv;
  return {
    spaceId: member.spaceId,
    memberId: member.id,
    deviceId,
    deviceShort,
    sigPubRaw: bytesToB64u(sig.pubRaw),
    kexPubRaw: bytesToB64u(kex.pubRaw),
    attestation: await attest(signer, att),
  };
}

/** Register a device through the real handler, so no test seeds a row the endpoint would refuse. */
async function register(ctxWrap, member, opts) {
  const body = await deviceBody(member, opts);
  const res = await call(registerDevice, req({ routeName: 'registerDevice', body }), ctxWrap.anon());
  return { body, res };
}

async function seedSpace(store, kind) {
  await store.createSpace({ id: SPACE, kind: kind || 'FAMILY', currentEpoch: 1, nextSeq: 0n, headChain: null, createdAt: new Date(0) });
}

// ═════════════════════════════════════════════════════════════════════════════
// Adapter-independent: the pure functions
// ═════════════════════════════════════════════════════════════════════════════

test('crock32 / deviceShortOf agree byte-for-byte with src/js/core/ids.js', async () => {
  // `server/core` may not import `src/js/core` (ADR 005 §2), so the encoder is duplicated. This
  // pins the duplicate: a drift would mint a deviceShort the client never derives, and every op
  // that device signed would fail ADR 002 §5.2's P2 forever.
  for (let i = 0; i < 24; i++) {
    const raw = new Uint8Array(65);
    raw[0] = 0x04;
    for (let j = 1; j < 65; j++) raw[j] = (i * 31 + j * 17) & 255;
    assert.equal(await deviceShortOf(raw), clientDeviceShortOf(raw), `deviceShort drift at i=${i}`);
  }
  assert.equal(crock32(new Uint8Array(10)), '0'.repeat(16), 'the all-zero short must stay the true minimum (ADR 001 §8.1)');
  assert.match(await deviceShortOf(new Uint8Array(65)), /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/);
});

test('b64uToBytes is strict: no padding, no standard base64, no non-canonical tail', () => {
  assert.deepEqual([...b64uToBytes('AQID')], [1, 2, 3]);
  assert.equal(b64uToBytes('AQID='), null, 'padding must be refused');
  assert.equal(b64uToBytes('a+/b'), null, 'standard base64 alphabet must be refused');
  assert.equal(b64uToBytes('AR'), null, 'spare bits set — one blob, one encoding');
  assert.deepEqual([...b64uToBytes('AQ')], [1], 'a canonical two-character group is fine');
  assert.equal(b64uToBytes('A'), null, 'an impossible length');
  assert.equal(b64uToBytes(null), null);
  assert.equal(b64uToBytes(undefined), null);
});

test('parseAttestationBlob refuses everything that is not exactly one blob', () => {
  assert.equal(parseAttestationBlob('nodot'), null);
  assert.equal(parseAttestationBlob('a.b.c'), null, 'two separators is not the format');
  assert.equal(parseAttestationBlob('.abc'), null);
  assert.equal(parseAttestationBlob('abc.'), null);
  assert.equal(parseAttestationBlob(`${bytesToB64u(enc.encode('{}'))}.${bytesToB64u(new Uint8Array(64))}`), null,
    'an attestation missing the six signed fields is not an attestation');
  assert.equal(parseAttestationBlob(`${bytesToB64u(enc.encode('[1,2]'))}.${bytesToB64u(new Uint8Array(64))}`), null);
  assert.equal(parseAttestationBlob('x'.repeat(9000)), null, 'unbounded input must be refused before any work');
});

// ═════════════════════════════════════════════════════════════════════════════
// Everything below runs against BOTH adapters
// ═════════════════════════════════════════════════════════════════════════════

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`${adapter.name} :: ${name}`, async () => {
    const clock = fakeClock();
    const store = adapter.make(clock);
    const w = makeCtx(store, clock);
    await seedSpace(store);
    await fn({ store, clock, ...w });
  });

  // ── devices.js — the precondition ──────────────────────────────────────────

  T('a device registers when — and only when — its member signed the attestation', async ({ store, anon, ctx }) => {
    const mama = await makeMember(store, SPACE, 'gruen');
    const body = await deviceBody(mama);
    const res = await call(registerDevice, req({ routeName: 'registerDevice', body }), anon());
    assert.equal(res.status, 200);
    assert.equal(res.body.registered, true);
    assert.equal(res.body.keysPending, true, 'a fresh device holds no wrap — ADR 002 §7.1 step 6');
    assert.equal(res.body.rotateRequired, true);

    const stored = await store.getDeviceByShort(SPACE, body.deviceShort);
    assert.ok(stored, 'the row is there');
    assert.equal(stored.memberId, mama.id);
    assert.ok(stored.attestation instanceof Uint8Array, 'the blob is stored as BYTES — an opaque column refuses a String (RULE 1)');
    assert.deepEqual([...stored.sigPubRaw], [...b64uToBytes(body.sigPubRaw)], 'the public key round-trips byte-identically');
    assert.equal(stored.lastSeenSeq, 0n);
    assert.equal(stored.lastPushedSeq, 0n);
    assert.equal(ctx.limits.deviceRegPerIpHour, 10);
  });

  T('KEY INJECTION: an attacker cannot register a device under another member — and so cannot force a wrap', async ({ store, anon }) => {
    const mama = await makeMember(store, SPACE, 'gruen');
    const attacker = await genSig();

    // The attack the coverage check would otherwise amplify: a device row naming Mama's member id,
    // whose public key the next honest rotation would be REQUIRED to wrap FSK_{e+1} to.
    const forged = await deviceBody(mama, { signWith: attacker.priv });
    const res = await call(registerDevice, req({ routeName: 'registerDevice', body: forged }), anon());
    assert.equal(res.status, 401);
    assert.equal(res.code, 'bad_signature');
    assert.equal(res.extra.check, 'attestation_signature');
    assert.equal(await store.getDeviceByShort(SPACE, forged.deviceShort), null, 'nothing was written');

    // And so the attacker's key never enters the set a rotation is REQUIRED to wrap to.
    const required = coverageRequires(await store.listMembers(SPACE), await store.listDevices(SPACE), 'FAMILY');
    assert.equal(required.includes(forged.deviceId), false, 'no row, nothing owed — the amplifier never arms');
  });

  T('a deviceShort that is not derived from the presented signing key is refused (ADR 001 §1.2)', async ({ store, anon }) => {
    const mama = await makeMember(store, SPACE, 'gruen');
    const good = await deviceBody(mama);
    // Self-certification: claim a short the key does not hash to. Checked BEFORE the signature,
    // so even a member cannot mint a row under a short they did not derive.
    const lied = { ...good, deviceShort: 'ZZZZZZZZZZZZZZZZ' };
    const res = await call(registerDevice, req({ routeName: 'registerDevice', body: lied }), anon());
    assert.equal(res.status, 400);
    assert.equal(res.extra.check, 'deviceShort');
    assert.equal(await store.getDeviceByShort(SPACE, 'ZZZZZZZZZZZZZZZZ'), null);

    const bad = await call(registerDevice, req({ routeName: 'registerDevice', body: { ...good, deviceShort: 'lower-case-hax!' } }), anon());
    assert.equal(bad.status, 400);
    assert.equal(bad.extra.field, 'deviceShort');
  });

  T('the signed payload must equal the presented row, field by field (ADR 002 §2.3 conditions 2 and 3)', async ({ store, anon }) => {
    const mama = await makeMember(store, SPACE, 'gruen');
    const papa = await makeMember(store, SPACE, 'blau');

    // A blob Mama signed, naming Papa inside — condition (3). Presented as Mama's device.
    const crossed = await deviceBody(mama, { attMemberId: papa.id });
    const r1 = await call(registerDevice, req({ routeName: 'registerDevice', body: crossed }), anon());
    assert.equal(r1.status, 401);
    assert.equal(r1.extra.check, 'attestation_memberId');

    // A blob naming a different deviceId than the row — condition (2)'s sibling.
    const swapped = await deviceBody(mama, { attDeviceId: 'dev_somethingelse' });
    const r2 = await call(registerDevice, req({ routeName: 'registerDevice', body: swapped }), anon());
    assert.equal(r2.status, 401);
    assert.equal(r2.extra.check, 'attestation_deviceId');

    assert.deepEqual(await store.listDevices(SPACE), [], 'not one of them was stored');
  });

  T('a removed member cannot attach a new device, and an unknown member is indistinguishable', async ({ store, anon, clock }) => {
    const mama = await makeMember(store, SPACE, 'gruen');
    await store.removeMember(mama.id, clock.now());
    const res = await call(registerDevice, req({ routeName: 'registerDevice', body: await deviceBody(mama) }), anon());
    assert.equal(res.status, 403);
    assert.equal(res.code, 'not_a_member');

    const ghost = { ...(await deviceBody(mama)), memberId: 'mem_doesnotexist' };
    const res2 = await call(registerDevice, req({ routeName: 'registerDevice', body: ghost }), anon());
    assert.equal(res2.code, 'not_a_member', 'a probe learns only that it may not do this');
    assert.equal(res2.extra, null, 'and learns nothing else');
  });

  T('registration is idempotent, and a deviceShort cannot be re-homed to another member', async ({ store, anon }) => {
    const mama = await makeMember(store, SPACE, 'gruen');
    const papa = await makeMember(store, SPACE, 'blau');
    const body = await deviceBody(mama);
    const first = await call(registerDevice, req({ routeName: 'registerDevice', body }), anon());
    assert.equal(first.body.registered, true);
    const again = await call(registerDevice, req({ routeName: 'registerDevice', body }), anon());
    assert.equal(again.status, 200, 'a lost response costs one retry, never an error');
    assert.equal(again.body.registered, false);
    assert.equal((await store.listDevices(SPACE)).length, 1);

    // The removed-partner move: take a short you know is good and hang it off a fresh member row.
    // It fails on the signature first, and on the uniqueness even if it did not.
    const rehome = { ...body, memberId: papa.id, spaceId: SPACE };
    const res = await call(registerDevice, req({ routeName: 'registerDevice', body: rehome }), anon());
    assert.equal(res.ok, false);
    assert.ok(res.status === 401 || res.status === 400, `expected a refusal, got ${res.status}`);
    assert.equal((await store.getDeviceByShort(SPACE, body.deviceShort)).memberId, mama.id, 'still Mama’s');
  });

  T('/devices/adopt is the SAME check — one signature under Member.recoveryPubSig (ADR 002 §7.3)', async ({ store, anon }) => {
    const mama = await makeMember(store, SPACE, 'gruen');
    const ok = await call(adoptDevice, req({ routeName: 'adoptDevice', body: await deviceBody(mama) }), anon());
    assert.equal(ok.status, 200);
    assert.equal(ok.body.keysPending, true, '„Schlüssel ausstehend" — §7.3 step 6, answered from a COUNT');

    const attacker = await genSig();
    const forged = await call(adoptDevice, req({ routeName: 'adoptDevice', body: await deviceBody(mama, { signWith: attacker.priv }) }), anon());
    assert.equal(forged.status, 401, 'adopt is not the weaker door');
  });

  T('registration is rate limited per IP, and the refusal carries Retry-After', async ({ anon, store }) => {
    const mama = await makeMember(store, SPACE, 'gruen');
    const ip = { 'x-forwarded-for': '203.0.113.9' };
    let refusals = 0;
    for (let i = 0; i < 14; i++) {
      const r = await call(registerDevice, req({ routeName: 'registerDevice', headers: ip, body: await deviceBody(mama) }), anon());
      if (r.status === 429) { refusals++; assert.equal(r.extra.retryAfter, 3600); }
    }
    assert.equal(refusals, 4, 'exactly 10 of 14 admitted (DEVICE_LIMIT_DEFAULTS.deviceRegPerIpHour)');
    // A different IP has its own budget — the limiter is keyed, not global.
    const other = await call(registerDevice, req({ routeName: 'registerDevice', headers: { 'x-forwarded-for': '198.51.100.4' }, body: await deviceBody(mama) }), anon());
    assert.equal(other.status, 200);
  });

  T('a device may be revoked only by its own member — never by a peer, never by "the admin"', async ({ store, as }) => {
    const mama = await makeMember(store, SPACE, 'gruen');
    const papa = await makeMember(store, SPACE, 'blau');
    const m1 = await register(makeCtx(store, fakeClock()), mama);
    const m2 = await register(makeCtx(store, fakeClock()), mama);
    const p1 = await register(makeCtx(store, fakeClock()), papa);
    assert.equal(m1.res.status, 200); assert.equal(m2.res.status, 200); assert.equal(p1.res.status, 200);

    const asMama = { deviceShort: m1.body.deviceShort, deviceId: m1.body.deviceId, memberId: mama.id };

    // The admin-shaped attack: reach across and unpair someone else's Mac.
    const cross = await call(revokeDevice, req({ routeName: 'revokeDevice', body: { spaceId: SPACE, deviceId: p1.body.deviceId } }), as(asMama));
    assert.equal(cross.status, 403);
    assert.equal(cross.code, 'not_a_member');
    assert.equal((await store.getDevice(p1.body.deviceId)).revokedAt, null, 'Papa’s Mac is untouched');

    // Probing for device ids gets the same answer as a peer's device.
    const ghost = await call(revokeDevice, req({ routeName: 'revokeDevice', body: { spaceId: SPACE, deviceId: 'dev_nope' } }), as(asMama));
    assert.equal(ghost.code, 'not_a_member');

    // Her own second Mac: allowed, and its wraps go with it.
    await store.putKeyWraps([{ spaceId: SPACE, epoch: 1, recipientId: m2.body.deviceId, wrapped: new Uint8Array([1, 2]), senderDeviceId: 'dev_seed' }]);
    const own = await call(revokeDevice, req({ routeName: 'revokeDevice', body: { spaceId: SPACE, deviceId: m2.body.deviceId } }), as(asMama));
    assert.equal(own.status, 200);
    assert.equal(own.body.revoked, true);
    assert.equal(own.body.purgedWraps, 1, 'a revoked device keeps no delivery path (ADR 002 §4.2 step 4)');
    assert.equal(own.body.rotateRequired, true);
    assert.deepEqual(await store.getKeyWraps(SPACE, m2.body.deviceId), []);

    // Her last one: refused, with the endpoint that actually means "I want out".
    const last = await call(revokeDevice, req({ routeName: 'revokeDevice', body: { spaceId: SPACE, deviceId: m1.body.deviceId } }), as(asMama));
    assert.equal(last.status, 400);
    assert.equal(last.extra.reason, 'last_device');
    assert.equal(last.extra.use, '/api/v1/members/leave');
  });

  T('a Mac in TWO circles can still unpair, and the member is resolved from the SPACE it names', async ({ store, as }) => {
    // ROUND 10 ITEM 8, the half that is easy to get wrong. `/devices/revoke` is not in
    // `router.js`'s `SPACE_SCOPED`, so ADR 003 §2 step 4 has no space to select a row with — and
    // a Mac that is in a personal space AND a Familienkreis now has a row in each. Step 4
    // therefore returns `memberId: null` rather than guessing, and a handler that read
    // `auth.memberId` would answer 403 for exactly the users this round unblocked. The identity
    // ADR 002 §2.3 defines is the PAIR — the short and the space — and that is what is resolved.
    const mama = await makeMember(store, SPACE, 'gruen');
    const m1 = await register(makeCtx(store, fakeClock()), mama);
    const m2 = await register(makeCtx(store, fakeClock()), mama);
    assert.equal(m1.res.status, 200); assert.equal(m2.res.status, 200);

    // The same Mac (`m1`), in her own personal space, under a different member row.
    await store.createSpace({
      id: SPACE2, kind: 'FAMILY', currentEpoch: 1, nextSeq: 0n, headChain: null, createdAt: new Date(0),
    });
    const alsoHers = await makeMember(store, SPACE2, 'gruen');
    await store.addDevice({
      id: 'dev_TWOCIRCLESAAAAAAAAAA', spaceId: SPACE2, memberId: alsoHers.id,
      deviceShort: m1.body.deviceShort,
      sigPubRaw: b64uToBytes(m1.body.sigPubRaw), kexPubRaw: b64uToBytes(m1.body.kexPubRaw),
      attestation: new TextEncoder().encode('x'), lastSeenSeq: 0n, lastPushedSeq: 0n,
      addedAt: new Date(0), revokedAt: null,
    });

    // What the REAL ladder hands a handler on this route for this Mac: a principal, and no member.
    const twoCircles = { deviceShort: m1.body.deviceShort, deviceId: null, memberId: null };

    const own = await call(revokeDevice, req({ routeName: 'revokeDevice', body: { spaceId: SPACE, deviceId: m2.body.deviceId } }), as(twoCircles));
    assert.equal(own.status, 200, JSON.stringify(own));
    assert.equal(own.body.revoked, true, 'she unpairs her second Mac from THIS circle, as before');

    // And the scope holds: naming the other space, where this short IS registered but under a
    // member who owns no such device, does not reach across.
    const across = await call(revokeDevice, req({ routeName: 'revokeDevice', body: { spaceId: SPACE2, deviceId: m2.body.deviceId } }), as(twoCircles));
    assert.equal(across.status, 403);
    assert.equal(across.code, 'not_a_member');

    // A space this Mac has no row in at all is the same answer — no circle-membership oracle.
    const nowhere = await call(revokeDevice, req({ routeName: 'revokeDevice', body: { spaceId: 'fsp_CCCCCCCCCCCCCCCCCCCCCC', deviceId: m2.body.deviceId } }), as(twoCircles));
    assert.equal(nowhere.code, 'not_a_member');
  });

  // ── keys.js — THE COVERAGE CHECK ──────────────────────────────────────────

  T('GET /keys returns every epoch, plus the caller’s recovery wraps, and nobody else’s', async ({ store, as }) => {
    const mama = await makeMember(store, SPACE, 'gruen', { publishKex: true });
    const papa = await makeMember(store, SPACE, 'blau');
    const m1 = await register(makeCtx(store, fakeClock()), mama);
    const p1 = await register(makeCtx(store, fakeClock()), papa);
    await store.putKeyWraps([
      { spaceId: SPACE, epoch: 1, recipientId: m1.body.deviceId, wrapped: new Uint8Array([1]), senderDeviceId: 'dev_seed' },
      { spaceId: SPACE, epoch: 3, recipientId: m1.body.deviceId, wrapped: new Uint8Array([3]), senderDeviceId: 'dev_seed' },
      { spaceId: SPACE, epoch: 2, recipientId: recoveryRecipientId(mama.id), wrapped: new Uint8Array([2]), senderDeviceId: 'dev_seed' },
      { spaceId: SPACE, epoch: 1, recipientId: p1.body.deviceId, wrapped: new Uint8Array([99]), senderDeviceId: 'dev_seed' },
    ]);

    const asMama = { deviceShort: m1.body.deviceShort, deviceId: m1.body.deviceId, memberId: mama.id };
    const res = await call(fetchKeys, req({ method: 'GET', routeName: 'fetchKeys', params: { id: SPACE } }), as(asMama));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.wraps.map((w) => w.epoch), [1, 2, 3],
      'ADR 002 §4.4 — a device offline across three rotations needs every epoch spanning ops it has not read');
    assert.equal(res.body.wraps.filter((w) => w.recipientId === recoveryRecipientId(mama.id)).length, 1,
      'the A2 delivery path: wraps addressed to this member’s RK_kex');
    assert.equal(res.body.wraps.some((w) => w.recipientId === p1.body.deviceId), false, 'and never a peer’s');
    assert.equal(res.body.keysPending, false);
    assert.deepEqual([...b64uToBytes(res.body.wraps[0].wrapped)], [1], 'ciphertext round-trips byte-identically');

    const asPapa = { deviceShort: p1.body.deviceShort, deviceId: p1.body.deviceId, memberId: papa.id };
    const other = await call(fetchKeys, req({ method: 'GET', routeName: 'fetchKeys', params: { id: SPACE } }), as(asPapa));
    assert.equal(other.body.wraps.length, 1);
  });

  // ── lifecycle.js — F20 ────────────────────────────────────────────────────

  T('20.2 — removal purges the member’s ops, keyed on deviceShort, and leaves every peer’s alone', async ({ store, as, clock }) => {
    const admin = await makeMember(store, SPACE, 'gruen');
    const gone = await makeMember(store, SPACE, 'rot');
    const a1 = await register(makeCtx(store, fakeClock()), admin);
    const g1 = await register(makeCtx(store, fakeClock()), gone);
    const g2 = await register(makeCtx(store, fakeClock()), gone);

    await store.upsertOps(SPACE, [
      { opId: 'op_admin_1', epoch: 1, deviceShort: a1.body.deviceShort, witness: null, chain: new Uint8Array(32), envelope: new Uint8Array(64) },
      { opId: 'op_gone_1', epoch: 1, deviceShort: g1.body.deviceShort, witness: null, chain: new Uint8Array(32), envelope: new Uint8Array(64) },
      { opId: 'op_gone_2', epoch: 1, deviceShort: g2.body.deviceShort, witness: null, chain: new Uint8Array(32), envelope: new Uint8Array(64) },
    ]);
    await store.putKeyWraps([
      { spaceId: SPACE, epoch: 1, recipientId: g1.body.deviceId, wrapped: new Uint8Array([1]), senderDeviceId: 'dev_seed' },
      { spaceId: SPACE, epoch: 2, recipientId: g1.body.deviceId, wrapped: new Uint8Array([2]), senderDeviceId: 'dev_seed' },
      { spaceId: SPACE, epoch: 1, recipientId: recoveryRecipientId(gone.id), wrapped: new Uint8Array([3]), senderDeviceId: 'dev_seed' },
      { spaceId: SPACE, epoch: 1, recipientId: a1.body.deviceId, wrapped: new Uint8Array([4]), senderDeviceId: 'dev_seed' },
    ]);
    const exp = new Date(clock.now() + 86400000);
    await store.putInvite({ id: 'inv_by_gone', spaceId: SPACE, verifier: new Uint8Array(32), wrapSalt: new Uint8Array(32), epoch: 1, createdBy: gone.id, expiresAt: exp, usedAt: null, revokedAt: null });
    await store.putInvite({ id: 'inv_by_admin', spaceId: SPACE, verifier: new Uint8Array(32), wrapSalt: new Uint8Array(32), epoch: 1, createdBy: admin.id, expiresAt: exp, usedAt: null, revokedAt: null });

    const asAdmin = { deviceShort: a1.body.deviceShort, deviceId: a1.body.deviceId, memberId: admin.id };
    const res = await call(removeMember, req({ routeName: 'removeMember', body: { spaceId: SPACE, memberId: gone.id } }), as(asAdmin));

    assert.equal(res.status, 200);
    assert.equal(res.body.removed, true);
    assert.equal(res.body.purgedOps, 2, 'both of her devices’ ops');
    assert.equal(res.body.purgedWraps, 3, 'every wrap she held, for ALL epochs, plus her recovery recipient');
    assert.equal(res.body.revokedDevices, 2);
    assert.equal(res.body.revokedInvites, 1, 'an invite she issued is not a way back in for an accomplice');
    assert.equal(res.body.rotateRequired, true, 'ADR 002 §4.1 — a removal forces e+1');
    assert.equal(res.body.alreadyDeliveredIsIrrevocable, true, 'ADR 002 §7.4 — „geteilt ist geteilt"');

    const left = await store.listOps(SPACE, 0n, 100);
    assert.deepEqual(left.ops.map((o) => o.opId), ['op_admin_1'], 'the admin’s op is untouched');
    assert.equal((await store.getInvite('inv_by_gone')).revokedAt !== null, true);
    assert.equal((await store.getInvite('inv_by_admin')).revokedAt, null, 'and only hers');
    assert.equal((await store.getDevice(g1.body.deviceId)).revokedAt !== null, true);
    assert.equal((await store.getKeyWraps(SPACE, a1.body.deviceId)).length, 1, 'the admin keeps hers');
    assert.equal((await store.listMembers(SPACE)).find((m) => m.id === gone.id).removedAt !== null, true);
    assert.equal((await store.getSpace(SPACE)).nextSeq, 3n, 'a purge leaves holes and never rewinds the counter (ADR 003 §3.3)');
  });

  T('after a removal the ex-member is no longer owed a wrap — 20.2 and ADR 002 §4.2 meet here', async ({ store, as, clock }) => {
    // The removal half is this ticket's; the coverage rule is LZP-203's. This asserts the JOIN,
    // by feeding the post-removal store state to the very function `rotateEpoch` uses. Before the
    // removal the rule protects her — which is the whole point of the control, and why an admin
    // cannot cut off a member she has not removed. After it, it does not, and the removal was
    // visible to every member because the authoritative one is the in-log op.
    const admin = await makeMember(store, SPACE, 'gruen');
    const gone = await makeMember(store, SPACE, 'rot');
    const a1 = await register(makeCtx(store, fakeClock()), admin);
    const g1 = await register(makeCtx(store, fakeClock()), gone);
    const asAdmin = { deviceShort: a1.body.deviceShort, deviceId: a1.body.deviceId, memberId: admin.id };

    const before = coverageRequires(await store.listMembers(SPACE), await store.listDevices(SPACE), 'FAMILY');
    assert.equal(before.includes(g1.body.deviceId), true, 'while she is a member, every rotation owes her a wrap');

    const res = await call(removeMember, req({ routeName: 'removeMember', body: { spaceId: SPACE, memberId: gone.id } }), as(asAdmin));
    assert.equal(res.body.removed, true);

    const after = coverageRequires(await store.listMembers(SPACE), await store.listDevices(SPACE), 'FAMILY');
    assert.equal(after.includes(g1.body.deviceId), false, 'T2 — a removed member is granted nothing further (ADR 002 §4.3)');
    // Still false, and now for two reasons rather than one: she is removed, AND finding E2E3-8
    // withdrew the FAMILY recovery demand entirely (nothing signs `Member.recoveryPubKex`, so
    // wrapping to it would hand the relay the family key). The T2 property this row is about is
    // unchanged — check the PERSONAL reading too, where the demand still exists and still drops.
    assert.equal(after.includes(recoveryRecipientId(gone.id)), false, 'nor her recovery recipient');
    const afterPersonal = coverageRequires(await store.listMembers(SPACE), await store.listDevices(SPACE), 'PERSONAL');
    assert.equal(afterPersonal.includes(recoveryRecipientId(gone.id)), false,
      'T2 holds under the reading that still demands a recovery wrap, so this row is about removal and not about E2E3-8');
    assert.equal(afterPersonal.includes(recoveryRecipientId(admin.id)), true);
    assert.equal(after.includes(a1.body.deviceId), true, 'and the admin is still owed hers');
    assert.equal(clock.now() > 0, true);
  });
  T('removal is idempotent, refuses self, and refuses a stranger', async ({ store, as }) => {
    const admin = await makeMember(store, SPACE, 'gruen');
    const mama = await makeMember(store, SPACE, 'blau');
    const a1 = await register(makeCtx(store, fakeClock()), admin);
    const asAdmin = { deviceShort: a1.body.deviceShort, deviceId: a1.body.deviceId, memberId: admin.id };

    const self = await call(removeMember, req({ routeName: 'removeMember', body: { spaceId: SPACE, memberId: admin.id } }), as(asAdmin));
    assert.equal(self.status, 400);
    assert.equal(self.extra.use, '/api/v1/members/leave', 'two stories, two endpoints, two sentences on screen');

    const stranger = await call(removeMember, req({ routeName: 'removeMember', body: { spaceId: SPACE, memberId: 'mem_notinthisspace' } }), as(asAdmin));
    assert.equal(stranger.code, 'not_a_member');

    const first = await call(removeMember, req({ routeName: 'removeMember', body: { spaceId: SPACE, memberId: mama.id } }), as(asAdmin));
    assert.equal(first.body.removed, true);
    const again = await call(removeMember, req({ routeName: 'removeMember', body: { spaceId: SPACE, memberId: mama.id } }), as(asAdmin));
    assert.equal(again.status, 200, 'a lost response must never cost a second confirmation dialogue');
    assert.equal(again.body.removed, false);
    assert.equal(again.body.alreadyRemoved, true);

    // A non-member gets nowhere: `assertMember` is auth step 7 and it runs first.
    const outsider = await call(removeMember, req({ routeName: 'removeMember', body: { spaceId: SPACE, memberId: mama.id } }), as({ deviceShort: 'X', deviceId: 'dev_x', memberId: 'mem_outsider' }));
    assert.equal(outsider.code, 'not_a_member');
  });

  T('20.3 — leaving is self-service, and the last member out deletes the space', async ({ store, as }) => {
    const mama = await makeMember(store, SPACE, 'gruen');
    const papa = await makeMember(store, SPACE, 'blau');
    const m1 = await register(makeCtx(store, fakeClock()), mama);
    const p1 = await register(makeCtx(store, fakeClock()), papa);
    await store.upsertOps(SPACE, [
      { opId: 'op_m', epoch: 1, deviceShort: m1.body.deviceShort, witness: null, chain: new Uint8Array(32), envelope: new Uint8Array(64) },
      { opId: 'op_p', epoch: 1, deviceShort: p1.body.deviceShort, witness: null, chain: new Uint8Array(32), envelope: new Uint8Array(64) },
    ]);

    const asMama = { deviceShort: m1.body.deviceShort, deviceId: m1.body.deviceId, memberId: mama.id };
    const first = await call(leaveSpace, req({ routeName: 'leaveSpace', body: { spaceId: SPACE } }), as(asMama));
    assert.equal(first.status, 200);
    assert.equal(first.body.left, true);
    assert.equal(first.body.spaceDeleted, false);
    assert.equal(first.body.purgedOps, 1);
    assert.equal(first.body.rotateRequired, true);
    assert.deepEqual((await store.listOps(SPACE, 0n, 10)).ops.map((o) => o.opId), ['op_p']);

    const asPapa = { deviceShort: p1.body.deviceShort, deviceId: p1.body.deviceId, memberId: papa.id };
    const last = await call(leaveSpace, req({ routeName: 'leaveSpace', body: { spaceId: SPACE } }), as(asPapa));
    assert.equal(last.body.spaceDeleted, true, 'a space nobody holds a key for is not retention, it is residue');
    assert.equal(last.body.rotateRequired, false, 'nothing left to rotate');
    assert.equal(await store.getSpace(SPACE), null);
    assert.deepEqual(await store.listMembers(SPACE), []);
    assert.deepEqual(await store.listDevices(SPACE), []);
  });

  T('20.1 — a transfer validates the successor and STORES NOTHING', async ({ store, as, clock }) => {
    const admin = await makeMember(store, SPACE, 'gruen');
    const heir = await makeMember(store, SPACE, 'blau');
    const gone = await makeMember(store, SPACE, 'rot');
    await store.removeMember(gone.id, clock.now());
    const a1 = await register(makeCtx(store, fakeClock()), admin);
    const asAdmin = { deviceShort: a1.body.deviceShort, deviceId: a1.body.deviceId, memberId: admin.id };

    const before = JSON.stringify((await store.listMembers(SPACE)).map((m) => [m.id, m.colorRef, m.removedAt]));
    const res = await call(transferAdmin, req({ routeName: 'transferAdmin', body: { spaceId: SPACE, memberId: heir.id } }), as(asAdmin));
    assert.equal(res.status, 200);
    assert.equal(res.body.authoritative, false, 'the admin is resolved from the in-log chain, never from a column');
    assert.equal(res.body.stored, 'nothing');
    assert.equal(res.body.rotateRequired, false, 'ADR 002 §4.1 — nobody’s read access changes');
    assert.equal(JSON.stringify((await store.listMembers(SPACE)).map((m) => [m.id, m.colorRef, m.removedAt])), before);

    const dead = await call(transferAdmin, req({ routeName: 'transferAdmin', body: { spaceId: SPACE, memberId: gone.id } }), as(asAdmin));
    assert.equal(dead.code, 'not_a_member', 'a transfer to a removed member would hand the circle to nobody');
    const self = await call(transferAdmin, req({ routeName: 'transferAdmin', body: { spaceId: SPACE, memberId: admin.id } }), as(asAdmin));
    assert.equal(self.status, 400);

    // The shadow-role attempt.
    const shadow = await call(transferAdmin, req({ routeName: 'transferAdmin', body: { spaceId: SPACE, memberId: heir.id, role: 'admin' } }), as(asAdmin));
    assert.equal(shadow.status, 400);
    assert.equal(shadow.extra.field, 'role');
    assert.equal(shadow.extra.reason, 'the_relay_stores_no_readable_names');
  });

  T('20.1 — a rename stores nothing, and a body that offers a name is refused by field', async ({ store, as }) => {
    const admin = await makeMember(store, SPACE, 'gruen');
    const a1 = await register(makeCtx(store, fakeClock()), admin);
    const asAdmin = { deviceShort: a1.body.deviceShort, deviceId: a1.body.deviceId, memberId: admin.id };

    const ok = await call(renameSpace, req({ routeName: 'renameSpace', params: { id: SPACE }, body: {} }), as(asAdmin));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.renamed, false);
    assert.equal(ok.body.stored, 'nothing');

    for (const field of ['name', 'title', 'label', 'displayName', 'caption', 'text']) {
      const r = await call(renameSpace, req({ routeName: 'renameSpace', params: { id: SPACE }, body: { [field]: 'Familie Hein' } }), as(asAdmin));
      assert.equal(r.status, 400, field);
      assert.equal(r.extra.field, field);
    }
    const space = await store.getSpace(SPACE);
    assert.deepEqual(Object.keys(space).sort(), ['createdAt', 'currentEpoch', 'headChain', 'id', 'kind', 'nextSeq'],
      'the Space row has no column a name could land in, and this is the assertion that keeps it that way');
  });

  T('20.4 — delete cascades everything, needs an explicit confirmation, and touches no other space', async ({ store, as, clock }) => {
    await store.createSpace({ id: SPACE2, kind: 'FAMILY', currentEpoch: 1, nextSeq: 0n, headChain: null, createdAt: new Date(0) });
    const admin = await makeMember(store, SPACE, 'gruen');
    const other = await makeMember(store, SPACE2, 'gruen');
    const a1 = await register(makeCtx(store, fakeClock()), admin);
    const o1 = await register(makeCtx(store, fakeClock()), other);
    await store.upsertOps(SPACE, [{ opId: 'op_1', epoch: 1, deviceShort: a1.body.deviceShort, witness: null, chain: new Uint8Array(32), envelope: new Uint8Array(64) }]);
    await store.upsertOps(SPACE2, [{ opId: 'op_o', epoch: 1, deviceShort: o1.body.deviceShort, witness: null, chain: new Uint8Array(32), envelope: new Uint8Array(64) }]);
    await store.putKeyWraps([{ spaceId: SPACE, epoch: 1, recipientId: a1.body.deviceId, wrapped: new Uint8Array([1]), senderDeviceId: 'dev_seed' }]);
    await store.putInvite({ id: 'inv_x', spaceId: SPACE, verifier: new Uint8Array(32), wrapSalt: new Uint8Array(32), epoch: 1, createdBy: admin.id, expiresAt: new Date(clock.now() + 86400000), usedAt: null, revokedAt: null });

    const asAdmin = { deviceShort: a1.body.deviceShort, deviceId: a1.body.deviceId, memberId: admin.id };
    const naked = await call(deleteSpace, req({ routeName: 'deleteSpace', params: { id: SPACE }, body: {} }), as(asAdmin));
    assert.equal(naked.status, 400);
    assert.equal(naked.extra.field, 'confirm', 'a destructive endpoint does not fire on an empty body');
    const wrong = await call(deleteSpace, req({ routeName: 'deleteSpace', params: { id: SPACE }, body: { confirm: SPACE2 } }), as(asAdmin));
    assert.equal(wrong.status, 400);
    assert.ok(await store.getSpace(SPACE), 'still there');

    const res = await call(deleteSpace, req({ routeName: 'deleteSpace', params: { id: SPACE }, body: { confirm: SPACE } }), as(asAdmin));
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, true);
    assert.deepEqual(res.body.purged, { members: 1, devices: 1, openInvites: 1, headSeq: '1' });
    assert.equal(res.body.localBoardsUnaffected, true, '20.4 — „every member reverts to a fully intact solo board"');

    assert.equal(await store.getSpace(SPACE), null);
    assert.deepEqual(await store.listMembers(SPACE), []);
    assert.deepEqual(await store.listDevices(SPACE), []);
    assert.deepEqual((await store.listOps(SPACE, 0n, 10)).ops, []);
    assert.deepEqual(await store.getKeyWraps(SPACE, a1.body.deviceId), []);
    assert.equal(await store.getInvite('inv_x'), null);

    assert.ok(await store.getSpace(SPACE2), 'the other family is untouched');
    assert.equal((await store.listOps(SPACE2, 0n, 10)).ops.length, 1);
    assert.equal((await store.listDevices(SPACE2)).length, 1);
  });

  T('the removal limiter is per member, and its refusal carries Retry-After', async ({ store, clock }) => {
    // The blast radius of E2-L1 — the relay cannot verify who the admin is — is bounded by this
    // limiter and by nothing else, so it is asserted rather than assumed. The budget is lowered
    // through `ctx.limits` (LZP-205's seam) instead of by looping 11 times.
    const w = makeCtx(store, clock, { ...CTX_LIMITS, memberRemovePerMemberHour: 2 });
    const admin = await makeMember(store, SPACE, 'gruen');
    const a1 = await register(w, admin);
    const victims = [];
    for (const c of ['blau', 'rot', 'gelb', 'lila']) victims.push(await makeMember(store, SPACE, c));
    const asAdmin = { deviceShort: a1.body.deviceShort, deviceId: a1.body.deviceId, memberId: admin.id };

    const codes = [];
    for (const v of victims) {
      const r = await call(removeMember, req({ routeName: 'removeMember', body: { spaceId: SPACE, memberId: v.id } }), w.as(asAdmin));
      codes.push(r.status);
      if (r.status === 429) assert.equal(r.extra.retryAfter, 3600);
    }
    assert.deepEqual(codes, [200, 200, 429, 429], 'exactly two removals admitted');
    const survivors = (await store.listMembers(SPACE)).filter((m) => m.removedAt === null);
    assert.equal(survivors.length, 3, 'the rate-limited calls removed nobody');
  });

  T('every lifecycle route runs the membership check first', async ({ store, as }) => {
    const admin = await makeMember(store, SPACE, 'gruen');
    await register(makeCtx(store, fakeClock()), admin);
    const outsider = { deviceShort: 'X', deviceId: 'dev_x', memberId: 'mem_outsider' };

    const routes = [
      [removeMember, req({ routeName: 'removeMember', body: { spaceId: SPACE, memberId: admin.id } })],
      [leaveSpace, req({ routeName: 'leaveSpace', body: { spaceId: SPACE } })],
      [transferAdmin, req({ routeName: 'transferAdmin', body: { spaceId: SPACE, memberId: admin.id } })],
      [renameSpace, req({ routeName: 'renameSpace', params: { id: SPACE }, body: {} })],
      [deleteSpace, req({ routeName: 'deleteSpace', params: { id: SPACE }, body: { confirm: SPACE } })],
      [fetchKeys, req({ method: 'GET', routeName: 'fetchKeys', params: { id: SPACE } })],
    ];
    for (const [handler, request] of routes) {
      const r = await call(handler, request, as(outsider));
      assert.equal(r.code, 'not_a_member', `${request.routeName} admitted a non-member`);
    }
    assert.ok(await store.getSpace(SPACE), 'and none of them did anything');
    assert.deepEqual(await store.listOps(SPACE, 0n, 10).then((r) => r.ops), []);
  });

  T('an error body names the offending FIELD and never echoes its value', async ({ store, as }) => {
    // ADR 003 §6.2 from the other direction. `errors.js` filters FORBIDDEN_BODY_FIELDS; this is
    // the half a review would miss — that no handler here builds an `extra` out of a caller's
    // bytes in the first place. A client that puts the family's name in a rename body must be
    // told which field was refused WITHOUT that name coming back through a relay error body, or
    // through the request log line that error produces.
    const admin = await makeMember(store, SPACE, 'gruen');
    const a1 = await register(makeCtx(store, fakeClock()), admin);
    const asAdmin = { deviceShort: a1.body.deviceShort, deviceId: a1.body.deviceId, memberId: admin.id };

    const secret = 'Familie Hein — Zahnarzt 14:30';
    const cases = [
      [renameSpace, req({ routeName: 'renameSpace', params: { id: SPACE }, body: { name: secret } })],
      [transferAdmin, req({ routeName: 'transferAdmin', body: { spaceId: SPACE, memberId: admin.id, displayName: secret } })],
      [removeMember, req({ routeName: 'removeMember', body: { spaceId: SPACE, memberId: admin.id, note: secret } })],
      [deleteSpace, req({ routeName: 'deleteSpace', params: { id: SPACE }, body: { confirm: SPACE, title: secret } })],
    ];
    for (const [handler, request] of cases) {
      const r = await call(handler, request, as(asAdmin));
      assert.equal(r.status, 400, request.routeName);
      const serialised = JSON.stringify(r.extra);
      assert.equal(serialised.includes(secret), false, `${request.routeName} echoed the value`);
      assert.equal(serialised.includes('Zahnarzt'), false);
      assert.match(serialised, /"field":/, 'but it does say which field');
    }
    assert.ok(await store.getSpace(SPACE), 'and none of them did anything');
  });
}
