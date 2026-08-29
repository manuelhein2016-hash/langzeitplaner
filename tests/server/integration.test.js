// tests/server/integration.test.js — LZP-207.  The composition, and the three E3 controls,
// exercised THROUGH THE REAL ROUTER by a client that is trying to defeat them.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS ALONGSIDE THE SIX HANDLER SUITES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// LZP-202..206 each proved their own clause, by calling their own handler with a hand-built ctx.
// That is the right shape for a handler test and it leaves exactly one thing unproven: that the
// SERVER — the thing `createHandlers()` returns, with the version gate on the outside, the route
// table in the middle and `ctx.auth` doing the whole ADR 003 §2 ladder — still has the property
// when a request arrives at it as a request. Three specific ways that can be false:
//
//   · a route bound to the wrong file's function (`createRouter` binds by NAME, and a spread
//     wins silently — the hazard `handlers/index.js` was written to prevent);
//   · a limiter composed twice, halving every published pre-auth budget with nothing red;
//   · a control that holds when its handler is called directly and is never REACHED end to end,
//     because the ladder in front of it answers first.
//
// And the E3 red team's charge is specifically about the third:
//
//   > "every server-enforced control in ADR 002 — rotation coverage, the `rid` burn, the
//    5-attempt budget, all rate limits — exists in a contract and in no code that runs."
//
// So §3-§5 below are written as the attacker, entering through `POST /api/v1/...` with a real
// signature over real bytes, and each one asserts BOTH that the attack fails AND that the failure
// left nothing behind — because a refused rotation that still consumed `e+1`, or a refused probe
// that still burned an honest rendezvous, is the control handing the attacker the denial of
// service it was supposed to prevent.
//
// Both adapters. No wall clock anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createHandlers, handlers, HANDLER_OWNERS, REQUIRED_CTX, REQUIRED_CTX_NAMES, assertCtx,
} from '../../server/core/handlers/index.js';
import { ROUTE_NAMES, ROUTES, SPACE_SCOPED, matchRoute } from '../../server/core/router.js';
import { withLimits, RATE_COVERAGE, LIMITS, createLog } from '../../server/core/limits.js';
import { authenticate, assertMember, b64u } from '../../server/core/auth.js';
import { memoryStore } from '../../server/adapters/memory.js';
import { attestedPerson, attestedDeviceFor } from './_attested-person.js';
import { fileStore } from '../../server/adapters/file.js';
import { requiredRecipients } from '../../server/core/handlers/spaces.js';

const S = globalThis.crypto.subtle;
const TE = new TextEncoder();

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-integ-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1  THE COMPOSITION — total, injective, and not double-charging
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 the registry is TOTAL — every route in the table has a handler', () => {
  assert.deepEqual(Object.keys(handlers).sort(), [...ROUTE_NAMES].sort());
  for (const n of ROUTE_NAMES) assert.equal(typeof handlers[n], 'function', `${n} is unbound`);
});

test('§1 the registry is INJECTIVE — no two routes answer with the same function', () => {
  // The failure this catches: `lifecycle.js` and `spaces.js` both implemented `rotateEpoch`
  // during development. One was withdrawn by hand. A registry where two names share a function
  // is either that mistake surviving or a copy-paste, and both are silent.
  const byFn = new Map();
  for (const [name, fn] of Object.entries(handlers)) {
    if (byFn.has(fn)) assert.fail(`${name} and ${byFn.get(fn)} are the same function`);
    byFn.set(fn, name);
  }
  assert.equal(byFn.size, ROUTE_NAMES.length);
});

test('§1 a registry naming a route that does not exist is refused at BUILD time', () => {
  assert.throws(
    () => createHandlers({ registry: { ...handlers, listSpaces: async () => ({ status: 200, body: {} }) } }),
    (e) => e.status === 500 && e.extra.unknownHandler === 'listSpaces');
});

test('§1 a registry MISSING a route is refused at build time, not answered 501 in production', () => {
  const partial = { ...handlers };
  delete partial.pushOps;
  assert.throws(
    () => createHandlers({ registry: partial }),
    (e) => e.status === 500 && e.extra.unboundRoutes.includes('pushOps'));
});

test('§1 THE DOUBLE-CHARGE REFUSAL — `withLimits` over self-limiting handlers cannot be built', () => {
  // Integration decision 1. `limits.js`'s INTEGRATION WARNING names two valid compositions and
  // says there is no third; the handlers self-limit through `enforceFor`, so `withLimits` must
  // not be composed on top. Composing it anyway is not an error anywhere — it silently charges
  // every pre-auth budget twice and HALVES the number ADR 003 §6.1 publishes: `invitesPerIpHour`
  // 10 becomes 5, `pairGetPerIpHour` 20 becomes 10, `spacesPerIpHour` 5 becomes 2. Nothing goes
  // red; a family onboarding two people from one household just hits a 429 nobody can explain.
  let thrown = null;
  try { createHandlers({ registry: withLimits(handlers) }); } catch (e) { thrown = e; }
  assert.ok(thrown, 'a double-charging router was built');
  assert.equal(thrown.status, 500);
  const doubled = thrown.extra.doubleCharged;
  // Exactly the routes `RATE_COVERAGE` declares a pre-auth rule for — derived on both sides, so
  // this cannot drift from the table it is about.
  const expected = ROUTE_NAMES.filter((n) => ((RATE_COVERAGE[n] || {}).pre || []).length > 0);
  assert.deepEqual([...doubled].sort(), [...expected].sort());
  assert.ok(expected.length >= 5, `expected several pre-auth routes, got ${expected.length}`);
});

test('§1 the honest composition still builds, and is what the hosts get', () => {
  assert.equal(typeof createHandlers(), 'function');
  assert.equal(typeof createHandlers({ registry: handlers }), 'function');
});

test('§1 every space-scoped route in `SPACE_SCOPED` is a real route, and vice versa where it must be', () => {
  for (const name of Object.keys(SPACE_SCOPED)) {
    assert.ok(ROUTE_NAMES.includes(name), `SPACE_SCOPED names ${name}, which is not a route`);
    assert.equal(typeof handlers[name], 'function');
  }
  // A route whose PATH carries `:id` is space-scoped by construction; forgetting it in the table
  // would make auth step 7 silently skip for that route.
  for (const r of ROUTES) {
    if (r.spaceParam) assert.ok(SPACE_SCOPED[r.name], `${r.name} has a spaceParam and is not in SPACE_SCOPED`);
  }
});

test('§1 `assertCtx` names what is missing, one member at a time', () => {
  const full = Object.fromEntries(REQUIRED_CTX_NAMES.map((n) => [n, () => {}]));
  assert.doesNotThrow(() => assertCtx(full));
  for (const n of REQUIRED_CTX_NAMES) {
    const short = { ...full };
    delete short[n];
    assert.throws(() => assertCtx(short), (e) => e.status === 500 && e.extra.missingCtx.includes(n), n);
  }
  // The optional ones really are optional — a host that omits `log` must still boot.
  const optional = REQUIRED_CTX.filter((c) => c.optional).map((c) => c.name);
  assert.deepEqual([...optional].sort(), ['log', 'subtle']);
  assert.doesNotThrow(() => assertCtx(full));
});

test('§1 `HANDLER_OWNERS` accounts for every route, so no handler is orphaned', () => {
  assert.deepEqual(Object.keys(HANDLER_OWNERS).sort(), [...ROUTE_NAMES].sort());
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2  A FAMILY, AND A HOSTILE CLIENT, BOTH SPEAKING THE REAL PROTOCOL
// ═════════════════════════════════════════════════════════════════════════════════════════════

const clock = (start) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
async function shortOf(rawSigPub) {
  const h = new Uint8Array(await S.digest('SHA-256', rawSigPub)).subarray(0, 10);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of h) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { out += CROCK[(acc >> (bits - 5)) & 31]; bits -= 5; } }
  return out.slice(0, 16);
}
const rawOf = async (k) => new Uint8Array(await S.exportKey('raw', k));
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function person(colorRef) {
  // Finding E2E3-7: `POST /spaces` and `POST /invites/redeem` now run ADR 002 §2.3's checks that
  // `POST /devices` has always run, and `GET /members` publishes the blob (E2E3-6). A person made
  // of `b64u(rnd(120))` is refused at the door — so this mints with the SHIPPING
  // `buildDeviceAttestation` + `attestDevice`, exactly what a Mac does.
  const p = await attestedPerson({ colorRef });
  return {
    colorRef,
    memberId: p.memberId,
    deviceId: p.deviceId,
    deviceShort: p.deviceShort,
    sigPriv: p.sigPriv,
    sigPub: p.sigPub,
    kexPriv: p.kexPriv,
    kexPub: p.kexPub,
    sigPubRaw: p.sigPubRawB64,
    kexPubRaw: p.kexPubRawB64,
    recPriv: p.recPriv,
    recoveryPubSig: p.recoveryPubSigB64,
    recoveryPubKex: p.recoveryPubKexB64,
    recoveryPubKexBytes: p.recoveryPubKex,
    attestation: p.attestation,
    attestationBytes: p.attestationBytes,
  };
}
const wireDevice = (p) => ({
  deviceId: p.deviceId, deviceShort: p.deviceShort,
  sigPubRaw: p.sigPubRaw, kexPubRaw: p.kexPubRaw, attestation: p.attestation,
});
const wireMember = (p) => ({
  memberId: p.memberId, recoveryPubSig: p.recoveryPubSig, recoveryPubKex: p.recoveryPubKex,
});
/** An opaque wrap. Its CONTENT is irrelevant to every assertion here — its presence is not. */
const wrap = (recipientId, epoch) => ({ recipientId, epoch, wrapped: b64u(rnd(156)) });

async function signedReq(p, method, urlPath, query, body, at) {
  const rawBody = body === undefined ? new Uint8Array(0) : TE.encode(JSON.stringify(body));
  const qs = Object.keys(query || {}).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
  const hash = b64u(new Uint8Array(await S.digest('SHA-256', rawBody)));
  const ts = String(at);
  const nonce = b64u(rnd(16));
  const full = `/api/v1${urlPath}`;
  const toSign = `lzp/v2\n${method}\n${full}?${qs}\n${hash}\n${ts}\n${nonce}`;
  const sig = b64u(new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, p.sigPriv, TE.encode(toSign))));
  return {
    method,
    path: full,
    query: query || {},
    headers: {
      'x-lzp-protocol': '1',
      authorization: `LZP1 device=${p.deviceShort}, ts=${ts}, nonce=${nonce}, sig=${sig}`,
    },
    body: body === undefined ? null : JSON.parse(new TextDecoder().decode(rawBody)),
    rawBody,
    clientIp: p.ip || '198.51.100.9',
  };
}

/** A server, and a `call` that goes through the whole stack: version gate → router → auth ladder. */
function server(makeStore, c) {
  const store = makeStore(c);
  const route = createHandlers();
  const logLines = [];
  const ctx = {
    store,
    now: () => c.now(),
    random: (n) => rnd(n),
    sha256: async (b) => new Uint8Array(await S.digest('SHA-256', b)),
    auth: (req) => authenticate(req, ctx),
    assertMember: (memberId, spaceId) => assertMember(memberId, spaceId, ctx),
    log: createLog((e) => logLines.push(e)),
    limits: LIMITS,
  };
  const call = async (p, method, urlPath, query, body) => {
    const res = await route(ctx, await signedReq(p, method, urlPath, query, body, c.now()));
    c.advance(1);
    return res;
  };
  const anon = async (method, urlPath, query, body, ip) => {
    const req = {
      method, path: `/api/v1${urlPath}`, query: query || {},
      headers: { 'x-lzp-protocol': '1' },
      body: body === undefined ? null : body,
      rawBody: body === undefined ? new Uint8Array(0) : TE.encode(JSON.stringify(body)),
      clientIp: ip || '203.0.113.99',
    };
    const res = await route(ctx, req);
    c.advance(1);
    return res;
  };
  return { store, ctx, call, anon, logLines };
}

async function expectFail(fn, status, code, hint) {
  let res = null;
  let err = null;
  try { res = await fn(); } catch (e) { err = e; }
  const got = err ? { status: err.status, code: err.code, extra: err.extra } : { status: res.status, code: res.body && res.body.error };
  assert.equal(got.status, status, `${hint || ''} — status; got ${JSON.stringify(got)}`);
  assert.equal(got.code, code, `${hint || ''} — code; got ${JSON.stringify(got)}`);
  return got;
}

/** A family: `admin` created the space at epoch 1, `honest` joined, both are current members. */
async function family(srv, c) {
  const admin = await person('gruen');
  const honest = await person('blau');
  const spaceId = `fsp_${b64u(rnd(16))}`;

  let res = await srv.call(admin, 'POST', '/spaces', {}, {
    spaceId, kind: 'FAMILY', colorRef: admin.colorRef,
    member: wireMember(admin), device: wireDevice(admin),
    wraps: [wrap(admin.deviceId, 1), wrap(`rec_${admin.memberId}`, 1)],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const code = b64u(rnd(8));
  const proof = new Uint8Array(await S.digest('SHA-256', TE.encode(`verify|${code}`)));
  const verifier = new Uint8Array(await S.digest('SHA-256', proof));
  const inviteId = b64u(new Uint8Array(await S.digest('SHA-256', TE.encode(`id|${code}`))).subarray(0, 16));
  res = await srv.call(admin, 'POST', '/invites', {}, { spaceId, inviteId, verifier: b64u(verifier) });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  res = await srv.call(honest, 'POST', '/invites/redeem', {}, {
    inviteId, proof: b64u(proof), colorRef: honest.colorRef,
    member: wireMember(honest), device: wireDevice(honest),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  return { admin, honest, spaceId };
}

const ADAPTERS = [
  { name: 'memory', make: (c) => memoryStore({ now: c.now }) },
  { name: 'file', make: (c) => fileStore(tempDir(), { now: c.now }) },
];

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`${adapter.name} :: ${name}`, fn);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §3  CONTROL 1 — ROTATION COVERAGE.  Story 20.2, ADR 002 §4.2, finding E3-2.
  //
  // THE ATTACK, in the PO's words: an admin removes nobody and rotates the family key to a ring
  // that quietly leaves one honest member out. Every subsequent entry is unreadable to her, with
  // a 200 OK on the wire and no client-side check able to notice — because the one person who
  // could notice is the one who cannot decrypt the evidence.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('§3 a hostile admin CANNOT rotate while omitting an honest member\'s device', async () => {
    const c = clock(1787900000000);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv, c);

    // Everyone except the honest member's DEVICE. Her recovery recipient is present, so this is
    // the subtle version of the attack: the ring looks complete at a glance.
    const selfish = [admin.deviceId, `rec_${admin.memberId}`, `rec_${honest.memberId}`]
      .flatMap((r) => [wrap(r, 1), wrap(r, 2)]);
    const got = await expectFail(
      () => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: selfish }),
      409, 'incomplete_coverage', 'omitting a device');
    assert.ok(got.extra.missing.some((m) => m.recipientId === honest.deviceId),
      `the 409 must NAME what is missing so an honest client can fix it: ${JSON.stringify(got.extra)}`);

    // …and it left NOTHING behind. A refused rotation that consumed epoch 2 would wedge the
    // family: the honest rotator that comes next gets 409 epoch_taken for an epoch nobody holds.
    const space = await srv.store.getSpace(spaceId);
    assert.equal(space.currentEpoch, 1, 'the epoch moved on a REFUSED rotation');
    assert.equal((await srv.store.getKeyWraps(spaceId, admin.deviceId)).length, 1, 'epoch-2 wraps were written anyway');

    // The honest rotation then succeeds at the SAME epoch number — proving 2 was not burned.
    const honestWraps = requiredRecipients(
      await srv.store.listMembers(spaceId), await srv.store.listDevices(spaceId), 'FAMILY')
      .flatMap((r) => [wrap(r, 1), wrap(r, 2)]);
    const ok = await srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: honestWraps });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.currentEpoch, 2);
  });

  // ── INVERTED 2026-08-29 — finding E2E3-8 ────────────────────────────────────────────────
  // This row demanded `rec_<honest>` of a FAMILY rotation and its reasoning is still exactly
  // right: without ADR 002 §4.2 step 2's recovery wrap, a member who later loses every device
  // has nothing left to recover the space key with. The demand was nevertheless unsatisfiable —
  // `familyRecipients()` builds no recovery recipient — and the only way to satisfy it is to
  // wrap `FSK_{e+1}` to `Member.recoveryPubKex`, a relay column NOTHING signs. Swap it and the
  // relay reads the family board, silently, with every attestation still verifying.
  //
  // So the rotation is now ACCEPTED, the loss is stated where it will be read, and the row keeps
  // its teeth by asserting the mechanism that will close it rather than deleting the concern.
  T('§3 …but NOT her recovery key: the wrap A2 depends on is unbuildable — E2E3-8, open', async () => {
    const c = clock(1787900000000);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv, c);

    const noRecovery = [admin.deviceId, `rec_${admin.memberId}`, honest.deviceId]
      .flatMap((r) => [wrap(r, 1), wrap(r, 2)]);
    const ok = await srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: noRecovery });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await srv.store.getKeyWraps(spaceId, `rec_${honest.memberId}`)).length, 0,
      'nobody wrapped to her recovery key, and the relay no longer pretends somebody could');

    // THE GUARD THAT KEEPS THIS FROM BEING "FIXED" THE CHEAP WAY. The client-side constructor
    // refuses a family recovery recipient BY NAME, so an agent who closes the gap by building
    // one gets a refusal that says why instead of a green suite and a broken story 21.2.
    const sk = await import('../../src/js/crypto/spacekeys.js');
    const roster = (await srv.call(admin, 'GET', `/spaces/${spaceId}/members`, {}, undefined)).body.members;
    assert.equal(sk.familyRecipients(roster).every((r) => r.role === 'device'), true);
    // A spread loses barrier 2's non-enumerable brand, so an outsider's hand-built recipient is
    // refused one step earlier still — that is the first line, and it holds:
    assert.match(
      await sk.recipientProblem({ ...sk.familyRecipients(roster)[0], role: 'recovery' }),
      /unbranded/, 'barrier 2 still refuses an object literal, however it is dressed');
    // …and the SECOND line, which is the one E2E3-8 turns on: a recipient that really does carry
    // the family brand — what an in-module change would produce, and what prototype inheritance
    // produces here — is refused BY NAME rather than waved through as "my own key".
    const branded = Object.create(sk.familyRecipients(roster)[0], {
      role: { value: 'recovery', enumerable: true },
      deviceId: { value: `rec_${honest.memberId}`, enumerable: true },
    });
    assert.equal(sk.recipientScope(branded), 'family', 'the brand really is inherited');
    assert.match(
      await sk.recipientProblem(branded),
      /REFUSING a family recovery recipient/,
      'closing E2E3-8 means BINDING recoveryPubKex into the attestation (ADR 002 §2.3), not this');
  });

  T('§3 …nor while omitting the SHARED HISTORY — epoch 1 is owed to the joiner too', async () => {
    const c = clock(1787900000000);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv, c);

    // Everyone covered for epoch 2, nobody backfilled for epoch 1. This is the attack that reads
    // as an optimisation: the new key reaches everybody, and Oma's birthday — entered in epoch 1
    // — silently stops rendering for the person who just joined (ADR 002 §4.3, story A4, R11).
    const onlyCurrent = requiredRecipients(
      await srv.store.listMembers(spaceId), await srv.store.listDevices(spaceId), 'FAMILY').map((r) => wrap(r, 2));
    const got = await expectFail(
      () => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: onlyCurrent }),
      409, 'incomplete_coverage', 'omitting epoch 1');
    assert.ok(got.extra.missing.some((m) => m.epoch === 1 && m.recipientId === honest.deviceId));
    assert.equal((await srv.store.getSpace(spaceId)).currentEpoch, 1);
  });

  T('§3 …and a wrap addressed to a recipient the space never heard of is not coverage', async () => {
    const c = clock(1787900000000);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv, c);

    // Padding the ring with invented recipients so the COUNT looks right. It is also, on its own,
    // a small write-anything store on somebody else's relay.
    const padded = [admin.deviceId, `rec_${admin.memberId}`, `dev_${b64u(rnd(16))}`, `rec_mem_${b64u(rnd(16))}`]
      .flatMap((r) => [wrap(r, 1), wrap(r, 2)]);
    await expectFail(
      () => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: padded }),
      400, 'bad_request', 'unknown recipient');
    assert.equal((await srv.store.getSpace(spaceId)).currentEpoch, 1);
    assert.equal((await srv.store.getKeyWraps(spaceId, honest.deviceId)).length, 0);
  });

  T('§3 a STRANGER cannot rotate at all, and cannot tell a real space from an imaginary one',
    async () => {
      const c = clock(1787900000000);
      const srv = server(adapter.make, c);
      const { spaceId } = await family(srv, c);

      // The stranger has to exist as a device somewhere, or auth step 4 answers first and the
      // membership check is never reached. So they create their own space and then reach across.
      const outsider = await person('rot');
      const own = `fsp_${b64u(rnd(16))}`;
      outsider.ip = '203.0.113.55';
      assert.equal((await srv.call(outsider, 'POST', '/spaces', {}, {
        spaceId: own, kind: 'FAMILY', colorRef: outsider.colorRef,
        member: wireMember(outsider), device: wireDevice(outsider),
        wraps: [wrap(outsider.deviceId, 1), wrap(`rec_${outsider.memberId}`, 1)],
      })).status, 200);

      await expectFail(
        () => srv.call(outsider, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: [wrap(outsider.deviceId, 1)] }),
        403, 'not_a_member', 'a stranger rotating');
      // A space that does not exist answers IDENTICALLY, so the endpoint is not a space-id oracle.
      await expectFail(
        () => srv.call(outsider, 'POST', `/spaces/fsp_${b64u(rnd(16))}/epoch`, {}, { epoch: 2, wraps: [wrap(outsider.deviceId, 1)] }),
        403, 'not_a_member', 'an imaginary space');
      assert.equal((await srv.store.getSpace(spaceId)).currentEpoch, 1);
    });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §4  CONTROL 2 — THE `rid` BURN.  ADR 002 §6.2, §6.3 step 9.
  //
  // THE ATTACK: a burn must be a TOMBSTONE, not a delete. If a burned rendezvous could be
  // re-created by replaying `pair/offer`, the attempt budget would reset with it and the 60-bit
  // pairing code would become the security parameter after all — which is precisely what the
  // short TTL and the hard cap exist to avoid.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('§4 a burned rendezvous cannot be resurrected by an offer, an answer or a delivery', async () => {
    const c = clock(1787900000000);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv, c);
    assert.ok(spaceId);

    const rid = b64u(rnd(16));
    assert.equal((await srv.call(admin, 'POST', '/pair/offer', {}, { rid, boxA: b64u(rnd(64)) })).status, 200);

    // Burn it the way the protocol does: five anonymous reads of an unanswered rendezvous.
    for (let i = 1; i <= LIMITS.pairAttempts; i++) {
      const res = await srv.anon('GET', `/pair/${rid}`, {}, undefined, '203.0.113.1');
      assert.equal(res.status, 200, `read ${i}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.attempts, i);
      assert.equal(res.body.consumed, i === LIMITS.pairAttempts, `read ${i} should${i === LIMITS.pairAttempts ? '' : ' not'} burn`);
    }

    // Now every door. Each must behave as if the rid had never existed.
    await expectFail(() => srv.anon('GET', `/pair/${rid}`, {}, undefined, '203.0.113.2'), 404, 'not_found', 'a sixth read');
    await expectFail(
      () => srv.call(admin, 'POST', '/pair/offer', {}, { rid, boxA: b64u(rnd(64)) }),
      410, 'pair_burned', 'RE-OFFERING a burned rid — the resurrection primitive');
    await expectFail(
      () => srv.anon('POST', '/pair/answer', {}, { rid, boxB: b64u(rnd(64)) }, '203.0.113.3'),
      404, 'not_found', 'answering a burned rid');
    await expectFail(
      () => srv.call(admin, 'POST', '/pair/deliver', {}, { rid, delivery: b64u(rnd(64)) }),
      404, 'not_found', 'delivering to a burned rid');

    // And the tombstone really is one: the row is gone from the reader's point of view and
    // `putPairSession` on it is a no-op, so nothing above quietly re-created it.
    assert.equal(await srv.store.getPairSession(rid), null, 'a burned rid came back');
    assert.equal(await srv.store.bumpPairAttempts(rid), Number.MAX_SAFE_INTEGER,
      'bumpPairAttempts must FAIL CLOSED on a burned rid, so `attempts >= max` needs no special case');
  });

  T('§4 collecting the delivery burns the rendezvous — one collection, ever', async () => {
    const c = clock(1787900000000);
    const srv = server(adapter.make, c);
    const { admin } = await family(srv, c);
    const rid = b64u(rnd(16));

    assert.equal((await srv.call(admin, 'POST', '/pair/offer', {}, { rid, boxA: b64u(rnd(64)) })).status, 200);
    assert.equal((await srv.anon('POST', '/pair/answer', {}, { rid, boxB: b64u(rnd(64)) }, '203.0.113.4')).status, 200);
    assert.equal((await srv.call(admin, 'POST', '/pair/deliver', {}, { rid, delivery: b64u(rnd(64)) })).status, 200);

    const collected = await srv.anon('GET', `/pair/${rid}`, {}, undefined, '203.0.113.4');
    assert.equal(collected.status, 200);
    assert.notEqual(collected.body.delivery, null, 'the joiner gets the payload');
    assert.equal(collected.body.consumed, true, 'and the collection consumes the rendezvous');
    // A replay of the collection — the attack that would hand a second party the same payload.
    await expectFail(() => srv.anon('GET', `/pair/${rid}`, {}, undefined, '203.0.113.5'), 404, 'not_found', 'a replayed collection');
  });

  T('§4 a race on one rid produces one winner, never a silent overwrite of the honest answer',
    async () => {
      const c = clock(1787900000000);
      const srv = server(adapter.make, c);
      const { admin } = await family(srv, c);
      const rid = b64u(rnd(16));
      const honestBox = b64u(rnd(64));

      assert.equal((await srv.call(admin, 'POST', '/pair/offer', {}, { rid, boxA: b64u(rnd(64)) })).status, 200);
      assert.equal((await srv.anon('POST', '/pair/answer', {}, { rid, boxB: honestBox }, '203.0.113.6')).status, 200);
      // A MITM who knows the rid answering second must not replace the box the human has already
      // begun comparing SAS digits against.
      await expectFail(
        () => srv.anon('POST', '/pair/answer', {}, { rid, boxB: b64u(rnd(64)) }, '203.0.113.7'),
        400, 'bad_request', 'a second answer');
      const session = await srv.store.getPairSession(rid);
      assert.equal(b64u(session.boxB), honestBox, 'the honest boxB was overwritten');
      // Re-offering a LIVE rendezvous that already carries a box is refused too.
      await expectFail(
        () => srv.call(admin, 'POST', '/pair/offer', {}, { rid, boxA: b64u(rnd(64)) }),
        400, 'bad_request', 're-offering a live rid');
    });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §5  CONTROL 3 — THE 5-ATTEMPT BUDGET.  ADR 002 §6.2.
  //
  // THE ATTACK: an online guesser who has found or is hunting a live `rid`. The budget is PER
  // RENDEZVOUS, so it is `Store.bumpPairAttempts` and not a rate bucket — the guesser cannot
  // escape it by changing IP, and the honest joiner cannot be locked out of her own pairing by
  // somebody else's traffic.
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('§5 the budget is per RENDEZVOUS — changing IP every request does not buy one extra read',
    async () => {
      const c = clock(1787900000000);
      const srv = server(adapter.make, c);
      const { admin } = await family(srv, c);
      const rid = b64u(rnd(16));
      assert.equal((await srv.call(admin, 'POST', '/pair/offer', {}, { rid, boxA: b64u(rnd(64)) })).status, 200);

      for (let i = 1; i <= LIMITS.pairAttempts; i++) {
        const res = await srv.anon('GET', `/pair/${rid}`, {}, undefined, `203.0.113.${100 + i}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.attempts, i, 'a new IP must not reset the per-rid counter');
        assert.equal(res.body.attemptsAllowed, LIMITS.pairAttempts);
      }
      await expectFail(
        () => srv.anon('GET', `/pair/${rid}`, {}, undefined, '203.0.113.200'),
        404, 'not_found', 'the sixth read, from a sixth address');
    });

  T('§5 the AUTHENTICATED offerer polling for boxB is not charged — an honest pairing survives',
    async () => {
      // If A's own poll spent the budget, every real pairing would die after five polls while the
      // human was still reading the digits aloud. The budget is aimed at the anonymous guesser.
      const c = clock(1787900000000);
      const srv = server(adapter.make, c);
      const { admin } = await family(srv, c);
      const rid = b64u(rnd(16));
      assert.equal((await srv.call(admin, 'POST', '/pair/offer', {}, { rid, boxA: b64u(rnd(64)) })).status, 200);

      for (let i = 0; i < 12; i++) {
        const res = await srv.call(admin, 'GET', `/pair/${rid}`, {});
        assert.equal(res.status, 200, `poll ${i}`);
        assert.equal(res.body.attempts, 0, 'the offerer was charged an attempt');
        assert.equal(res.body.delivery, null, 'the offerer must never be handed the single-use delivery');
      }
      // The rendezvous is still alive for the joiner afterwards.
      const joiner = await srv.anon('GET', `/pair/${rid}`, {}, undefined, '203.0.113.8');
      assert.equal(joiner.status, 200);
      assert.equal(joiner.body.attempts, 1);
    });

  T('§5 once ANSWERED, reads are no longer charged — polling for the delivery cannot self-burn',
    async () => {
      const c = clock(1787900000000);
      const srv = server(adapter.make, c);
      const { admin } = await family(srv, c);
      const rid = b64u(rnd(16));
      assert.equal((await srv.call(admin, 'POST', '/pair/offer', {}, { rid, boxA: b64u(rnd(64)) })).status, 200);
      assert.equal((await srv.anon('POST', '/pair/answer', {}, { rid, boxB: b64u(rnd(64)) }, '203.0.113.9')).status, 200);

      // B must poll for the delivery on a slow link. A five-poll ceiling here would break every
      // honest pairing; what bounds this phase is the 180 s TTL and the per-IP limiters instead.
      for (let i = 0; i < 8; i++) {
        const res = await srv.anon('GET', `/pair/${rid}`, {}, undefined, '203.0.113.9');
        assert.equal(res.status, 200, `poll ${i}`);
        assert.equal(res.body.attempts, 0, 'an answered rendezvous must not be charged');
        assert.equal(res.body.boxB, null, 'B is never handed back the box it wrote');
      }
      assert.notEqual(await srv.store.getPairSession(rid), null, 'polling burned an answered rendezvous');
    });

  T('§5 an unknown, an expired and a burned rid are ONE answer — the endpoint is not an oracle',
    async () => {
      const c = clock(1787900000000);
      const srv = server(adapter.make, c);
      const { admin } = await family(srv, c);

      const unknown = b64u(rnd(16));
      const expired = b64u(rnd(16));
      assert.equal((await srv.call(admin, 'POST', '/pair/offer', {}, { rid: expired, boxA: b64u(rnd(64)) })).status, 200);
      c.advance(181000);                                   // past the 180 s TTL, on the fake clock

      const a = await expectFail(() => srv.anon('GET', `/pair/${unknown}`, {}, undefined, '203.0.113.10'), 404, 'not_found');
      const b = await expectFail(() => srv.anon('GET', `/pair/${expired}`, {}, undefined, '203.0.113.11'), 404, 'not_found');
      assert.deepEqual(a, b,
        'a 410 on an expired rid would confirm to a guesser that they had found a REAL code — the '
        + 'single most valuable bit in the protocol. The three must be indistinguishable.');
    });

  T('§5 a guesser is cut off by the failed-lookup budget long before the hourly one runs out',
    async () => {
      // `pairRidMiss` — 5 failed lookups per IP per minute (E2-L1). The honest response to an IP
      // that is guessing is to stop answering, not to keep answering 404 twenty times.
      const c = clock(1787900000000);
      const srv = server(adapter.make, c);
      await family(srv, c);
      const ip = '203.0.113.77';
      const misses = LIMITS.pairRidMissPerIpMin;
      assert.ok(Number.isInteger(misses) && misses > 0, 'the rule must publish a number');

      for (let i = 0; i < misses; i++) {
        await expectFail(() => srv.anon('GET', `/pair/${b64u(rnd(16))}`, {}, undefined, ip), 404, 'not_found', `miss ${i}`);
      }
      const stopped = await expectFail(
        () => srv.anon('GET', `/pair/${b64u(rnd(16))}`, {}, undefined, ip),
        429, 'rate_limited', 'the guesser past the budget');
      assert.ok(Number.isInteger(stopped.extra.retryAfter) && stopped.extra.retryAfter > 0,
        'a 429 must carry Retry-After, or the client cannot back off correctly');

      // A DIFFERENT address is unaffected — the budget bounds a guesser, not the internet.
      await expectFail(
        () => srv.anon('GET', `/pair/${b64u(rnd(16))}`, {}, undefined, '203.0.113.78'),
        404, 'not_found', 'an unrelated address');
    });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §6  THE STACK IN FRONT OF THE CONTROLS — reached as a request, not as a function call
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('§6 the version gate is OUTSIDE everything, and `meta` is the only exemption', async () => {
    const c = clock(1787900000000);
    const srv = server(adapter.make, c);
    const route = createHandlers();
    const bare = (urlPath, method) => ({
      method: method || 'GET', path: `/api/v1${urlPath}`, query: {}, headers: {},
      body: null, rawBody: new Uint8Array(0),
    });
    // No protocol header, no auth: 426 must win, BEFORE any handler parses a body. An old client
    // must be told to update, not handed a shape error it has no rule for (ADR 003 §4).
    await expectFail(() => route(srv.ctx, bare('/ops')), 426, 'protocol_too_old', 'pull without a protocol header');
    await expectFail(() => route(srv.ctx, bare('/spaces', 'POST')), 426, 'protocol_too_old', 'create without one');
    // …and `meta` answers, because gating the endpoint that explains the gate is a closed loop.
    const meta = await route(srv.ctx, bare('/meta'));
    assert.equal(meta.status, 200);
    assert.equal(meta.body.region, 'fra1', 'decision D2 — Frankfurt');
    assert.deepEqual(Object.keys(meta.body).sort(), ['maxProto', 'minProto', 'region', 'serverTime']);
  });

  T('§6 every route in the table is REACHABLE — none answers 501, none 404s', async () => {
    // The 501 branch in `createRouter` is what made LZP-201 shippable before the handlers
    // existed. In production a 501 is a gap nobody meant to ship, so this walks the whole table
    // and asserts nothing answers one. An unauthenticated request is enough: 401/403/400 all
    // prove the handler was reached.
    const c = clock(1787900000000);
    const srv = server(adapter.make, c);
    const route = createHandlers();
    const seen = new Set();
    for (const r of ROUTES) {
      const urlPath = r.pattern.replace(':id', `fsp_${b64u(rnd(16))}`).replace(':rid', b64u(rnd(16)));
      const req = {
        method: r.method, path: `/api/v1${urlPath}`, query: {},
        headers: { 'x-lzp-protocol': '1' }, body: r.method === 'POST' ? {} : null,
        rawBody: r.method === 'POST' ? TE.encode('{}') : new Uint8Array(0),
        clientIp: '203.0.113.250',
      };
      // Two separate questions, because both can answer 404 and only one of them is a bug.
      // 1. Did the PATTERN match its own path? `matchRoute` is pure and is the same function the
      //    router uses, so this is the routing half with nothing else in the way.
      const m = matchRoute(req.method, req.path);
      assert.ok(m, `${r.method} ${r.pattern} does not match a path built from its own pattern`);
      assert.equal(m.route.name, r.name);
      // 2. Did a HANDLER answer? Any of 400/401/403/404/409/429 proves one did. `501` and the code
      //    `not_implemented` prove one did not — that branch exists so LZP-201 could ship before
      //    the handlers did, and in production it is a gap nobody meant to ship.
      //    `GET /pair/:rid` legitimately answers 404 for a rendezvous that does not exist (an
      //    unknown, expired and burned rid are one answer — §5), so the status is not the signal
      //    here; the code is.
      let status;
      let code;
      try { const res = await route(srv.ctx, req); status = res.status; code = res.body && res.body.error; }
      catch (e) { status = e.status; code = e.code; }
      assert.notEqual(status, 501, `${r.method} ${r.pattern} answered 501 not_implemented`);
      assert.notEqual(code, 'not_implemented', `${r.method} ${r.pattern}`);
      assert.notEqual(code, 'method_not_allowed', `${r.method} ${r.pattern} is not bound under its own method`);
      seen.add(r.name);
    }
    assert.equal(seen.size, ROUTE_NAMES.length);
  });
}
