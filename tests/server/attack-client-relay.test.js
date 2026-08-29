// tests/server/attack-client-relay.test.js — THE HOSTILE CLIENT, part 1: the transport.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE THREAT MODEL THIS FILE ASSUMES, STATED SO EVERY ASSERTION CAN BE READ AGAINST IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// T5 is a family member with a PATCHED APP. Not a bug, not a stale build — an attacker who has
// deleted every client-side check, who signs whatever bytes they like with their own real key,
// and who is trying to read, forge, deny or exhaust. And an OUTSIDER holding a leaked invite,
// who has a code and nothing else.
//
// The server is the only gatekeeper between either of them and the rest of the family. Every
// test below therefore enters through `createHandlers()` — the version gate, the route table and
// the whole ADR 003 §2 auth ladder — over real ECDSA P-256 signatures on real bytes. Nothing
// here calls a handler directly, because a control that holds when its handler is called and is
// never REACHED end to end is not a control.
//
// The naming convention is deliberate and is what the report is built from:
//
//   ATTACK … / DEFENDED     the attack was tried in full and the server refused it
//   ATTACK … / SUCCEEDS     the attack was tried in full and the server ALLOWED it
//
// A `SUCCEEDS` test is green. That is the point: it pins a real capability of a hostile client,
// so that closing it later is a test that changes rather than a discovery nobody makes.
//
// Both adapters where the attack has a storage dimension; memory alone where it does not, and
// the reason is stated at the test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHandlers } from '../../server/core/handlers/index.js';
import { authenticate, assertMember, b64u, ub64 } from '../../server/core/auth.js';
import { LIMITS, createLog, clientIp } from '../../server/core/limits.js';
import { createVersionGate } from '../../server/core/version.js';
import { memoryStore } from '../../server/adapters/memory.js';
import { fileStore } from '../../server/adapters/file.js';

const S = globalThis.crypto.subtle;
const TE = new TextEncoder();

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-atk-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// ─────────────────────────────────────────────────────────────────────────────
// The harness. Same shape as tests/server/integration.test.js, because a second
// spelling of `signedReq` would be a second chance to sign the wrong bytes.
// ─────────────────────────────────────────────────────────────────────────────

const clock = (start) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
async function shortOf(rawSigPub) {
  const h = new Uint8Array(await S.digest('SHA-256', rawSigPub)).subarray(0, 10);
  let bits = 0; let acc = 0; let out = '';
  for (const b of h) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { out += CROCK[(acc >> (bits - 5)) & 31]; bits -= 5; } }
  return out.slice(0, 16);
}
const rawOf = async (k) => new Uint8Array(await S.exportKey('raw', k));
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function person(colorRef, ip) {
  const sig = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const kex = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const recSig = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const recKex = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const sigPubRaw = await rawOf(sig.publicKey);
  return {
    colorRef,
    ip: ip || '198.51.100.9',
    memberId: `mem_${b64u(rnd(16))}`,
    deviceId: `dev_${b64u(rnd(16))}`,
    deviceShort: await shortOf(sigPubRaw),
    sigPriv: sig.privateKey,
    sigPubRaw: b64u(sigPubRaw),
    kexPubRaw: b64u(await rawOf(kex.publicKey)),
    recoveryPubSig: b64u(await rawOf(recSig.publicKey)),
    recoveryPubKex: b64u(await rawOf(recKex.publicKey)),
    attestation: b64u(rnd(120)),
  };
}
const wireDevice = (p) => ({
  deviceId: p.deviceId, deviceShort: p.deviceShort,
  sigPubRaw: p.sigPubRaw, kexPubRaw: p.kexPubRaw, attestation: p.attestation,
});
const wireMember = (p) => ({
  memberId: p.memberId, recoveryPubSig: p.recoveryPubSig, recoveryPubKex: p.recoveryPubKex,
});
const wrap = (recipientId, epoch) => ({ recipientId, epoch, wrapped: b64u(rnd(156)) });

/**
 * Build a signed request. `tamper` runs on the finished request AFTER the signature exists, so a
 * test can do what a patched client does: sign honest bytes, then send different ones.
 */
async function signedReq(p, method, urlPath, query, body, at, tamper) {
  const rawBody = body === undefined ? new Uint8Array(0) : TE.encode(JSON.stringify(body));
  const qs = Object.keys(query || {}).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
  const hash = b64u(new Uint8Array(await S.digest('SHA-256', rawBody)));
  const ts = String(at);
  const nonce = b64u(rnd(16));
  const full = `/api/v1${urlPath}`;
  const toSign = `lzp/v2\n${method}\n${full}?${qs}\n${hash}\n${ts}\n${nonce}`;
  const sig = b64u(new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, p.sigPriv, TE.encode(toSign))));
  const req = {
    method,
    path: full,
    query: query || {},
    headers: {
      'x-lzp-protocol': '1',
      authorization: `LZP1 device=${p.deviceShort}, ts=${ts}, nonce=${nonce}, sig=${sig}`,
    },
    body: body === undefined ? null : JSON.parse(new TextDecoder().decode(rawBody)),
    rawBody,
    clientIp: p.ip,
  };
  return tamper ? (tamper(req) || req) : req;
}

function server(makeStore, c, opts) {
  const store = makeStore(c);
  const route = createHandlers(opts);
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
  /** One request through the whole stack. `raw` returns the request too, so it can be replayed. */
  const call = async (p, method, urlPath, query, body, tamper) => {
    const req = await signedReq(p, method, urlPath, query, body, c.now(), tamper);
    const res = await route(ctx, req);
    c.advance(1);
    return res;
  };
  const build = (p, method, urlPath, query, body, tamper) =>
    signedReq(p, method, urlPath, query, body, c.now(), tamper);
  const send = async (req) => { const r = await route(ctx, req); c.advance(1); return r; };
  return { store, ctx, route, call, build, send, logLines };
}

async function expectFail(fn, status, code, hint) {
  let res = null; let err = null;
  try { res = await fn(); } catch (e) { err = e; }
  const got = err ? { status: err.status, code: err.code, extra: err.extra }
                  : { status: res.status, code: res.body && res.body.error, extra: res.body && res.body.detail };
  assert.equal(got.status, status, `${hint || ''} — status; got ${JSON.stringify(got)}`);
  assert.equal(got.code, code, `${hint || ''} — code; got ${JSON.stringify(got)}`);
  return got;
}

/** A family: `admin` at epoch 1, `honest` joined by invite. Both current members. */
async function family(srv) {
  const admin = await person('gruen', '198.51.100.9');
  const honest = await person('blau', '198.51.100.10');
  const spaceId = `fsp_${b64u(rnd(16))}`;

  let res = await srv.call(admin, 'POST', '/spaces', {}, {
    spaceId, kind: 'FAMILY', colorRef: admin.colorRef,
    member: wireMember(admin), device: wireDevice(admin),
    wraps: [wrap(admin.deviceId, 1), wrap(`rec_${admin.memberId}`, 1)],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const inv = await mintInvite(srv, admin, spaceId);
  res = await srv.call(honest, 'POST', '/invites/redeem', {}, {
    inviteId: inv.inviteId, proof: b64u(inv.proof), colorRef: honest.colorRef,
    member: wireMember(honest), device: wireDevice(honest),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { admin, honest, spaceId };
}

/** Mint one invite the way the real client does: the code never reaches the server. */
async function mintInvite(srv, by, spaceId) {
  const code = b64u(rnd(8));
  const proof = new Uint8Array(await S.digest('SHA-256', TE.encode(`verify|${code}`)));
  const verifier = new Uint8Array(await S.digest('SHA-256', proof));
  const inviteId = b64u(new Uint8Array(await S.digest('SHA-256', TE.encode(`id|${code}`))).subarray(0, 16));
  const res = await srv.call(by, 'POST', '/invites', {}, { spaceId, inviteId, verifier: b64u(verifier) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { code, proof, verifier, inviteId };
}

/** One sealed envelope, as a patched client would emit it. `ct` is noise: the relay is blind. */
const envelope = (p, spaceId, epoch, over) => ({
  v: 1, sp: spaceId, ep: epoch, dv: p.deviceShort, oid: b64u(rnd(16)), wit: '',
  iv: b64u(rnd(12)), ct: b64u(rnd(64)), sig: b64u(rnd(64)),
  ...(over || {}),
});

const ADAPTERS = [
  { name: 'memory', make: (c) => memoryStore({ now: c.now }) },
  { name: 'file', make: (c) => fileStore(tempDir(), { now: c.now }) },
];

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`${adapter.name} :: ${name}`, fn);
  const start = 1787900000000;

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §A  READING AND WRITING SOMEBODY ELSE'S SPACE
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('§A ATTACK push into a space I do not belong to / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { spaceId } = await family(srv);

    // The outsider must EXIST as a device or auth step 4 answers first and the membership check
    // is never reached — so they create their own space, then reach across.
    const outsider = await person('rot', '203.0.113.55');
    const own = `fsp_${b64u(rnd(16))}`;
    assert.equal((await srv.call(outsider, 'POST', '/spaces', {}, {
      spaceId: own, kind: 'FAMILY', colorRef: outsider.colorRef,
      member: wireMember(outsider), device: wireDevice(outsider),
      wraps: [wrap(outsider.deviceId, 1), wrap(`rec_${outsider.memberId}`, 1)],
    })).status, 200);

    await expectFail(
      () => srv.call(outsider, 'POST', '/ops', {}, { space: spaceId, ops: [envelope(outsider, spaceId, 1)] }),
      403, 'not_a_member', 'push into a foreign space');

    // Nothing was written. A refused push that still burned a seq would be a hole in the log.
    assert.equal((await srv.store.headSeq(spaceId)), 0n);
    // …and a space that does not exist answers IDENTICALLY, so this is not a space-id oracle.
    await expectFail(
      () => srv.call(outsider, 'POST', '/ops', {}, { space: `fsp_${b64u(rnd(16))}`, ops: [] }),
      403, 'not_a_member', 'push into an imaginary space');
  });

  T('§A ATTACK pull from a space I do not belong to / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);
    assert.equal((await srv.call(admin, 'POST', '/ops', {}, {
      space: spaceId, ops: [envelope(admin, spaceId, 1)],
    })).status, 200);

    const outsider = await person('rot', '203.0.113.56');
    const own = `fsp_${b64u(rnd(16))}`;
    assert.equal((await srv.call(outsider, 'POST', '/spaces', {}, {
      spaceId: own, kind: 'FAMILY', colorRef: outsider.colorRef,
      member: wireMember(outsider), device: wireDevice(outsider),
      wraps: [wrap(outsider.deviceId, 1), wrap(`rec_${outsider.memberId}`, 1)],
    })).status, 200);

    await expectFail(
      () => srv.call(outsider, 'GET', '/ops', { space: spaceId, since: '0' }, undefined),
      403, 'not_a_member', 'pull from a foreign space');
    // The member roster of a foreign space is not readable either — it carries colorRef and the
    // whole device→member mapping.
    await expectFail(
      () => srv.call(outsider, 'GET', `/spaces/${spaceId}/members`, {}, undefined),
      403, 'not_a_member', 'roster of a foreign space');
    await expectFail(
      () => srv.call(outsider, 'GET', `/spaces/${spaceId}/keys`, {}, undefined),
      403, 'not_a_member', 'key wraps of a foreign space');
  });

  T('§A ATTACK push an op ATTRIBUTED to another device of my own family / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv);

    // The patched client sets `dv` to the victim's short. ADR 003 §3.1 checks `dv` FIRST, before
    // even the space match, so this is refused before anything is looked up.
    await expectFail(
      () => srv.call(admin, 'POST', '/ops', {}, {
        space: spaceId, ops: [envelope(admin, spaceId, 1, { dv: honest.deviceShort })],
      }),
      403, 'device_mismatch', 're-attributing an op to a peer');

    // …and a batch that is honest EXCEPT for one row is rejected WHOLE. A partial accept would
    // let an attacker smuggle one forged row per batch and pay one 403 for it.
    await expectFail(
      () => srv.call(admin, 'POST', '/ops', {}, {
        space: spaceId,
        ops: [envelope(admin, spaceId, 1), envelope(admin, spaceId, 1, { dv: honest.deviceShort })],
      }),
      403, 'device_mismatch', 'one forged row inside an honest batch');
    assert.equal(await srv.store.headSeq(spaceId), 0n, 'the honest row of a rejected batch was stored');
  });

  T('§A ATTACK relabel a personal-space op into the family space / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);
    // `sp` inside the AAD must equal the space the push names. This is the field that stops a
    // Privat entry being replayed into the Familienkreis (ENVELOPE_FIELDS.sp).
    await expectFail(
      () => srv.call(admin, 'POST', '/ops', {}, {
        space: spaceId, ops: [envelope(admin, `psp_${b64u(rnd(16))}`, 1)],
      }),
      400, 'space_mismatch', 'sp / space disagreement');
  });

  T('§A ATTACK label an op with an epoch that does not exist yet / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);
    await expectFail(
      () => srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: [envelope(admin, spaceId, 2)] }),
      400, 'future_epoch', 'ep above currentEpoch');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §B  THE SIGNATURE, THE NONCE AND THE CLOCK  (ADR 003 §2, steps 1-5)
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('§B ATTACK forge a signature — flip one byte / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);

    await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId }, undefined, (req) => {
      const m = /sig=([A-Za-z0-9_-]+)/.exec(req.headers.authorization);
      const bytes = ub64(m[1], 64);
      bytes[0] ^= 0x01;
      req.headers.authorization = req.headers.authorization.replace(m[1], b64u(bytes));
    }), 401, 'bad_signature', 'one flipped signature byte');

    // A signature of the RIGHT length over the WRONG bytes: sign the honest string, then change
    // the query. This is the shape a patched client actually produces.
    await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId, since: '0' }, undefined, (req) => {
      req.query = { space: spaceId, since: '5' };
    }), 401, 'bad_signature', 'query changed after signing');

    // …and the body, likewise. `signedBytes` hashes `rawBody`, so swapping the parsed object
    // alone is not enough — an attacker has to change the bytes, and then the hash moves.
    await expectFail(() => srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: [] }, (req) => {
      req.rawBody = TE.encode(JSON.stringify({ space: spaceId, ops: [envelope(admin, spaceId, 1)] }));
    }), 401, 'bad_signature', 'body bytes changed after signing');
  });

  T('§B ATTACK sign with my key, claim a peer\'s deviceShort / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv);
    // The header names the victim; the signature is the attacker's. Step 4 loads the VICTIM's
    // stored public key — never the request's — so step 5 cannot pass.
    await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId }, undefined, (req) => {
      req.headers.authorization = req.headers.authorization.replace(admin.deviceShort, honest.deviceShort);
    }), 401, 'bad_signature', 'impersonating a peer principal');
  });

  T('§B ATTACK replay a captured request verbatim / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);

    const req = await srv.build(admin, 'POST', '/ops', {}, { space: spaceId, ops: [envelope(admin, spaceId, 1)] });
    assert.equal((await srv.send(req)).status, 200);
    const head = await srv.store.headSeq(spaceId);

    // Byte-identical resend, inside the window. Step 3 has the nonce.
    await expectFail(() => srv.send({ ...req, rawBody: req.rawBody }), 401, 'replay', 'verbatim replay');
    assert.equal(await srv.store.headSeq(spaceId), head, 'a replay appended a second copy');
  });

  T('§B ATTACK re-use one nonce across DIFFERENT requests / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);

    const first = await srv.build(admin, 'GET', '/ops', { space: spaceId }, undefined);
    assert.equal((await srv.send(first)).status, 200);
    const nonce = /nonce=([A-Za-z0-9_-]+)/.exec(first.headers.authorization)[1];

    // A DIFFERENT request, correctly signed, re-using the spent nonce. The signature is valid;
    // step 3 answers before step 5 ever runs.
    await expectFail(() => srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: [] }, (req) => {
      const ts = /ts=([0-9]+)/.exec(req.headers.authorization)[1];
      req.headers.authorization = `LZP1 device=${admin.deviceShort}, ts=${ts}, nonce=${nonce}, sig=${/sig=([A-Za-z0-9_-]+)/.exec(req.headers.authorization)[1]}`;
    }), 401, 'replay', 'a spent nonce on a fresh request');
  });

  T('§B ATTACK skew the timestamp past the replay window / DEFENDED, in both directions', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);

    // Signed honestly for a moment 121 s in the past — the whole request, ts included, is
    // internally consistent. Step 2 is a check on the SERVER's clock, so consistency does not help.
    const stale = await signedReq(admin, 'GET', '/ops', { space: spaceId }, undefined, c.now() - 120001);
    await expectFail(() => srv.send(stale), 401, 'stale_request', 'ts 120001 ms in the past');

    const future = await signedReq(admin, 'GET', '/ops', { space: spaceId }, undefined, c.now() + 120001);
    await expectFail(() => srv.send(future), 401, 'stale_request', 'ts 120001 ms in the future');

    // The boundary itself is admitted — the window is |now - ts| <= 120 s, and a family on a
    // slightly wrong clock must still sync.
    const edge = await signedReq(admin, 'GET', '/ops', { space: spaceId }, undefined, c.now() - 120000);
    assert.equal((await srv.send(edge)).status, 200, 'the documented window boundary was refused');
  });

  T('§B ATTACK sign one ts and send another / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);
    // Take a request signed 10 minutes ago and re-stamp the header so step 2 passes. The ts is
    // INSIDE the signed string, so step 5 catches it.
    const old = await signedReq(admin, 'GET', '/ops', { space: spaceId }, undefined, c.now() - 600000);
    old.headers.authorization = old.headers.authorization.replace(/ts=[0-9]+/, `ts=${c.now()}`);
    await expectFail(() => srv.send(old), 401, 'bad_signature', 're-stamped ts');
  });

  T('§B ATTACK an unknown, a revoked and a removed principal are ONE answer / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv);

    // A device that never existed.
    const ghost = await person('rot');
    await expectFail(() => srv.call(ghost, 'GET', '/ops', { space: spaceId }, undefined),
      403, 'device_revoked', 'a device the relay never registered');

    // A member removed a moment ago: their device is revoked in the same transaction, so the
    // very next request from that Mac dies at step 4 with the SAME code. 20.1's "sofort".
    assert.equal((await srv.call(admin, 'POST', '/members/remove', {}, {
      spaceId, memberId: honest.memberId,
    })).status, 200);
    await expectFail(() => srv.call(honest, 'GET', '/ops', { space: spaceId }, undefined),
      403, 'device_revoked', 'a removed member, one request later');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §C  PROTOCOL VERSION GAMES  (addendum §9, ADR 003 §4, story 22.7)
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('§C ATTACK claim N-2, a version that does not exist, and N+1 / DEFENDED', async () => {
    const c = clock(start);
    // Instantiate the server as it will exist at protocol 3, which is the only way to have an
    // N-2 to claim at all: at PROTO_MAX 1 the rule is vacuous and a test of it passes for the
    // wrong reason.
    const srv = server(adapter.make, c, { version: { gate: createVersionGate({ protoMax: 3, protoFloor: 3 }) } });
    const { admin, spaceId } = await family3(srv);

    const withProto = (v) => (req) => { req.headers['x-lzp-protocol'] = v; };

    // N and N-1 are served. That is addendum §9, and it is the half a security test usually
    // forgets: a server that refused N-1 would be a family-wide outage every deploy.
    for (const v of ['3', '2']) {
      const res = await srv.call(admin, 'GET', '/ops', { space: spaceId }, undefined, withProto(v));
      assert.equal(res.status, 200, `protocol ${v} must be served`);
      assert.equal(res.headers['X-LZP-Protocol'], '3');
      assert.equal(res.headers['X-LZP-Min-Protocol'], '2');
    }

    // N-2 is 426 with the window on the body, so a real client can render 22.7's sentence.
    const tooOld = await expectFail(
      () => srv.call(admin, 'GET', '/ops', { space: spaceId }, undefined, withProto('1')),
      426, 'protocol_too_old', 'N-2');
    assert.equal(tooOld.extra.minProto, 2);
    assert.equal(tooOld.extra.maxProto, 3);
    assert.equal(tooOld.extra.minClientVersion, '0.0.0');

    // N+1 is 400 protocol_unknown — NOT 426. Telling a client from the future to upgrade would
    // be a lie, and a lie a client cannot act on.
    await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId }, undefined, withProto('4')),
      400, 'protocol_unknown', 'N+1');

    // A version that is not a version.
    for (const junk of ['abc', '1.0', '', '-1', '0x2', ' 2', '2 ', '99999999999']) {
      const expected = junk === '' ? ['protocol_too_old', 426] : ['bad_request', 400];
      await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId }, undefined, withProto(junk)),
        expected[1], expected[0], `junk protocol ${JSON.stringify(junk)}`);
    }
    // Absent is "too old", never "malformed": every client that has ever existed sends it.
    await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId }, undefined,
      (req) => { delete req.headers['x-lzp-protocol']; }), 426, 'protocol_too_old', 'absent protocol header');

    // `0` is BELOW the floor, so it is 426 and not `protocol_unknown` — the reserved code is for
    // a value strictly ABOVE PROTO_MAX and nothing else.
    await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId }, undefined, withProto('0')),
      426, 'protocol_too_old', 'protocol 0');
  });

  T('§C ATTACK mix envelope versions inside one batch / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);

    // `Envelope.v` is a THIRD version number, independent of the HTTP protocol (version.js's
    // "do not conflate them"). The Op model has no `v` column, so the relay can only round-trip
    // the versions it can reconstruct from a constant — and it refuses the rest rather than
    // storing a v2 envelope and serving it back labelled v1.
    for (const v of [2, 0, -1, 1.5, '1', null]) {
      await expectFail(() => srv.call(admin, 'POST', '/ops', {}, {
        space: spaceId, ops: [envelope(admin, spaceId, 1, { v })],
      }), 400, 'bad_request', `envelope v=${JSON.stringify(v)}`);
    }
    // One good row and one v2 row: the batch dies whole, and the good row is not stored.
    await expectFail(() => srv.call(admin, 'POST', '/ops', {}, {
      space: spaceId, ops: [envelope(admin, spaceId, 1), envelope(admin, spaceId, 1, { v: 2 })],
    }), 400, 'bad_request', 'mixed envelope versions in one batch');
    assert.equal(await srv.store.headSeq(spaceId), 0n, 'the v1 half of a mixed batch was stored');
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §D  EXHAUSTING THE RELAY
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('§D ATTACK oversized payloads — envelope, batch, request / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);

    // One envelope over 64 KiB. The cap is on `iv ‖ ct ‖ sig`, which is what the column holds.
    const fat = envelope(admin, spaceId, 1, { ct: b64u(new Uint8Array(LIMITS.bytesPerEnvelope + 1)) });
    await expectFail(() => srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: [fat] }),
      413, 'payload_too_large', 'a 64 KiB + 1 envelope');

    // 201 ops in one push.
    const many = Array.from({ length: LIMITS.opsPerPush + 1 }, () => envelope(admin, spaceId, 1));
    await expectFail(() => srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: many }),
      413, 'payload_too_large', '201 ops in one push');

    // A request whose RAW BYTES exceed 4 MiB while EVERY envelope is individually legal and the
    // batch is inside 200 — the shape the two per-item caps do not catch. 200 x 21 000 b64 chars
    // of `ct` is ~4.2 MB of body and ~15.7 KiB per envelope. Signed honestly, so this reaches the
    // handler's own check rather than dying at auth.
    const bulky = Array.from({ length: LIMITS.opsPerPush }, () =>
      envelope(admin, spaceId, 1, { ct: b64u(new Uint8Array(15750)) }));
    const big = await expectFail(() => srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: bulky }),
      413, 'payload_too_large', 'a 4 MiB + body of individually legal envelopes');
    assert.equal(big.status, 413);

    // …and a body swapped AFTER signing never reaches any size check at all: `signedBytes`
    // hashes `rawBody`, so the request dies at step 5.
    await expectFail(() => srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: [] }, (req) => {
      req.rawBody = new Uint8Array(LIMITS.bytesPerRequest + 1);
    }), 401, 'bad_signature', 'a 4 MiB + 1 body is not signed either');

    assert.equal(await srv.store.headSeq(spaceId), 0n);
  });

  T('§D ATTACK a pathological pull cursor / DEFENDED — and it never skips', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);
    for (let i = 0; i < 3; i++) {
      assert.equal((await srv.call(admin, 'POST', '/ops', {}, {
        space: spaceId, ops: [envelope(admin, spaceId, 1)],
      })).status, 200);
    }

    // A cursor far past the head returns an EMPTY page whose nextCursor is the caller's own
    // `since` — never the head. A cursor that advanced past ops the client did not receive would
    // lose them silently and permanently, on one device.
    const far = await srv.call(admin, 'GET', '/ops', { space: spaceId, since: '9999999999999999999' }, undefined);
    assert.equal(far.status, 200);
    assert.deepEqual(far.body.ops, []);
    assert.equal(far.body.nextCursor, '9999999999999999999');
    assert.equal(far.body.hasMore, false);

    // 20 digits is not a cursor.
    await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId, since: '99999999999999999999' }, undefined),
      400, 'bad_request', 'a 20-digit cursor');
    for (const junk of ['-1', '1e9', '0x10', ' 1', 'NaN', '1.0']) {
      await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId, since: junk }, undefined),
        400, 'bad_request', `since=${JSON.stringify(junk)}`);
    }

    // `limit` is CLAMPED above the cap and REFUSED below one — a zero-limit page with
    // hasMore:true is an infinite pull loop that looks exactly like a hung sync.
    await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId, limit: '0' }, undefined),
      400, 'bad_request', 'limit=0');
    const clamped = await srv.call(admin, 'GET', '/ops', { space: spaceId, limit: '999999999' }, undefined);
    assert.equal(clamped.status, 200);
    assert.ok(clamped.body.ops.length <= LIMITS.opsPerPull);
    // An empty page on an empty log still cannot rewind the caller.
    const zero = await srv.call(admin, 'GET', '/ops', { space: spaceId, since: '3' }, undefined);
    assert.equal(zero.body.nextCursor, '3');
  });

  T('§D ATTACK inflate ackSeq to release the family\'s tombstones / BOUNDED, not defeated', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv);
    assert.equal((await srv.call(admin, 'POST', '/ops', {}, {
      space: spaceId, ops: [envelope(admin, spaceId, 1)],
    })).status, 200);

    // 2^63 is refused: `parseAck` bounds the claim by the space's own assignment high-water.
    await expectFail(() => srv.call(honest, 'POST', '/ops', {}, {
      space: spaceId, ackSeq: '9223372036854775807', ops: [],
    }), 400, 'bad_request', 'ackSeq far above the head');

    // …but a claim up to the HEAD is accepted from a device that has pulled NOTHING. That is the
    // residual: `minLastSeenSeq` is a minimum over the fleet, so a hostile member cannot release
    // anything alone — it removes ITSELF as the brake, which in a two-device family is the whole
    // brake. Recorded here as the bound, not as a defence.
    const lie = await srv.call(honest, 'POST', '/ops', {}, { space: spaceId, ackSeq: '1', ops: [] });
    assert.equal(lie.status, 200, JSON.stringify(lie.body));
    assert.equal(await srv.store.minLastSeenSeq(spaceId), 0n,
      'the ADMIN has not acked, so the fleet minimum must still be 0 — one liar cannot move it');

    // Write progress is an EXPLICIT claim and fails closed when absent (ADR 001 §7.3 cond. 3).
    assert.equal(await srv.store.minLastPushedSeq(spaceId), 0n);
    assert.equal((await srv.call(honest, 'POST', '/ops', {}, {
      space: spaceId, ops: [], drained: true,
    })).status, 200);
    assert.equal(await srv.store.minLastPushedSeq(spaceId), 0n, 'one device claiming drained moved the fleet minimum');
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §E  THE ATTACKS THAT SUCCEED. Memory adapter only: nothing here is storage-shaped, and each is
//     a property of `server/core/`, which both adapters share verbatim.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const start = 1787900000000;

test('§E ATTACK downgrade the protocol by editing an UNSIGNED header / SUCCEEDS', async () => {
  const c = clock(start);
  const srv = server((k) => memoryStore({ now: k.now }), c,
    { version: { gate: createVersionGate({ protoMax: 3, protoFloor: 3 }) } });
  const { admin, spaceId } = await family3(srv);

  // ADR 003 §2's signed string covers method, path, query, body hash, ts and nonce. It covers NO
  // HEADER except `Authorization` itself. `X-LZP-Protocol` and `X-LZP-Client` are therefore
  // attacker-writable on any request an on-path party can touch, and the gate that reads them
  // is the outermost thing in the stack.
  //
  // Consequence 1 — a one-header DENIAL of any request, indefinitely, with a valid signature:
  const req = await srv.build(admin, 'GET', '/ops', { space: spaceId }, undefined);
  const original = { ...req.headers };
  req.headers['x-lzp-protocol'] = '1';                       // N-2
  const denied = await expectFail(() => srv.send({ ...req, headers: req.headers }),
    426, 'protocol_too_old', 'header rewritten in flight');
  assert.equal(denied.extra.maxProto, 3);

  // Consequence 2 — a DOWNGRADE. The same signature is served at the older protocol. Today
  // PROTO_MAX is 1 so there is nothing to downgrade TO and the exposure is latent; at protocol 2
  // the older wire format is whatever protocol 1 was, chosen by whoever can write a header.
  const again = await srv.build(admin, 'GET', '/ops', { space: spaceId }, undefined);
  again.headers['x-lzp-protocol'] = '2';
  const down = await srv.send(again);
  assert.equal(down.status, 200, 'a rewritten protocol header was served, so the choice is the attacker\'s');
  assert.notEqual(original['x-lzp-protocol'], '2');
});

test('§E ATTACK grow the Nonce table without ever authenticating / SUCCEEDS', async () => {
  const c = clock(start);
  const store = memoryStore({ now: c.now });
  const srv = { store };
  const route = createHandlers();
  const ctx = {
    store,
    now: () => c.now(),
    random: (n) => rnd(n),
    sha256: async (b) => new Uint8Array(await S.digest('SHA-256', b)),
    auth: (req) => authenticate(req, ctx),
    assertMember: (memberId, spaceId) => assertMember(memberId, spaceId, ctx),
    log: () => {},
    limits: LIMITS,
  };

  // ADR 003 §2 fixes step 3 (claimNonce) BEFORE step 4 (device lookup) and step 5 (verify).
  // `auth.js` implements the ADR and reports the consequence as E2-202-C, handing it to LZP-205.
  // LZP-205 declared `pushOps`/`pullOps` post-auth-only (`RATE_COVERAGE.pushOps = cov([], ['push'])`),
  // so there is no PRE-auth limiter on either — and the post-auth one is never reached, because
  // auth is what fails.
  //
  // The result: an unauthenticated caller, holding no key and naming a device that does not
  // exist, writes one durable Nonce row per request, for free.
  const attacker = await person('rot', '203.0.113.200');
  const stranger = await person('rot', '203.0.113.200');
  let rows = 0;
  for (let i = 0; i < 50; i++) {
    // A syntactically perfect header for a deviceShort the relay has never heard of, with 64
    // bytes of noise where the signature goes. Cost to the attacker: one HTTP request.
    const ts = String(c.now());
    const nonce = b64u(rnd(16));
    const req = {
      method: 'GET', path: '/api/v1/ops', query: { space: `fsp_${b64u(rnd(16))}` },
      headers: {
        'x-lzp-protocol': '1',
        authorization: `LZP1 device=${stranger.deviceShort}, ts=${ts}, nonce=${nonce}, sig=${b64u(rnd(64))}`,
      },
      body: null, rawBody: new Uint8Array(0), clientIp: attacker.ip,
    };
    let code = null;
    try { await route(ctx, req); } catch (e) { code = e.code; }
    assert.equal(code, 'device_revoked', 'the request must still be refused — it is');
    // The nonce was nonetheless CLAIMED: replaying it now answers `replay`, which is only
    // possible if a row was written for a caller who proved nothing.
    let second = null;
    try { await route(ctx, { ...req }); } catch (e) { second = e.code; }
    assert.equal(second, 'replay', 'the nonce row survives a refused request');
    rows += 1;
    c.advance(1);
  }
  assert.equal(rows, 50);

  // And the IP is not what stops it: `pushOps` and `pullOps` have no pre-auth bucket at all, so
  // this loop is limited by the network and by nothing in this server. Bounded only by
  // nonceTtlMs (5 min) — which is a bound on RESIDENT rows, not on the write rate.
  assert.equal(LIMITS.nonceTtlMs, 300000);
});

test('§E ATTACK a per-IP budget is only as good as `clientIp` / SUCCEEDS when the host omits the peer', async () => {
  const c = clock(start);
  // The pre-auth budgets — invite redemption 10/h, space creation 5/h, device registration 10/h
  // — are all keyed on `clientIp(req)`. `clientIp` prefers `req.clientIp`, which BOTH shipped
  // hosts set from `socket.remoteAddress`. Behind Vercel's edge the peer is the edge, so
  // `req.clientIp` is normally ABSENT there (`prisma.js`'s U-VERCELIP: "failing is silent and
  // makes every per-IP limit header-evadable"). This test is that claim, executed.
  const withPeer = { clientIp: '198.51.100.1', headers: { 'x-vercel-forwarded-for': '203.0.113.7' } };
  assert.equal(clientIp(withPeer), '198.51.100.1', 'the peer must outrank every header');

  // Without the peer, the FIRST header wins — and a header is written by whoever sends the
  // request unless the platform overwrites it.
  assert.equal(clientIp({ headers: { 'x-vercel-forwarded-for': '203.0.113.7' } }), '203.0.113.7');
  assert.equal(clientIp({ headers: { 'x-real-ip': '203.0.113.8' } }), '203.0.113.8');
  assert.equal(clientIp({ headers: { 'x-forwarded-for': '10.0.0.1, 203.0.113.9' } }), '203.0.113.9');

  // Executed end to end: 5 space creations per IP per hour, defeated by one rotating header.
  const store = memoryStore({ now: c.now });
  const route = createHandlers();
  const ctx = {
    store, now: () => c.now(), random: (n) => rnd(n),
    sha256: async (b) => new Uint8Array(await S.digest('SHA-256', b)),
    auth: (req) => authenticate(req, ctx),
    assertMember: (m, s) => assertMember(m, s, ctx),
    log: () => {}, limits: LIMITS,
  };
  let made = 0;
  for (let i = 0; i < LIMITS.spacesPerIpHour + 4; i++) {
    const p = await person('gruen');
    const spaceId = `fsp_${b64u(rnd(16))}`;
    const req = await signedReq(p, 'POST', '/spaces', {}, {
      spaceId, kind: 'FAMILY', colorRef: p.colorRef,
      member: wireMember(p), device: wireDevice(p),
      wraps: [wrap(p.deviceId, 1), wrap(`rec_${p.memberId}`, 1)],
    }, c.now());
    delete req.clientIp;                                  // the Vercel shape
    req.headers['x-vercel-forwarded-for'] = `203.0.113.${i + 20}`;   // one rotating header
    const res = await route(ctx, req);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    made++;
    c.advance(1);
  }
  assert.equal(made, LIMITS.spacesPerIpHour + 4,
    'a rotating forwarded-for header bought more than the published per-IP budget');

  // The same loop with the peer address present stops exactly at the published number.
  const store2 = memoryStore({ now: c.now });
  const ctx2 = { ...ctx, store: store2, auth: (req) => authenticate(req, ctx2), assertMember: (m, s) => assertMember(m, s, ctx2) };
  let ok = 0; let refused = null;
  for (let i = 0; i < LIMITS.spacesPerIpHour + 2; i++) {
    const p = await person('gruen', '198.51.100.77');
    const spaceId = `fsp_${b64u(rnd(16))}`;
    const req = await signedReq(p, 'POST', '/spaces', {}, {
      spaceId, kind: 'FAMILY', colorRef: p.colorRef,
      member: wireMember(p), device: wireDevice(p),
      wraps: [wrap(p.deviceId, 1), wrap(`rec_${p.memberId}`, 1)],
    }, c.now());
    req.headers['x-vercel-forwarded-for'] = `203.0.113.${i + 40}`;   // ignored: the peer wins
    try { await route(ctx2, req); ok++; } catch (e) { refused = e.code; break; }
    c.advance(1);
  }
  assert.equal(ok, LIMITS.spacesPerIpHour);
  assert.equal(refused, 'rate_limited');
});

test('§E ATTACK fill one space with ops until the relay is full / SUCCEEDS — no quota exists', async () => {
  const c = clock(start);
  const srv = server((k) => memoryStore({ now: k.now }), c);
  const { admin, spaceId } = await family(srv);

  // Every cap in ADR 003 §6.1 is a cap on ONE REQUEST or on a RATE. There is no cap on the total
  // an account, a member, a device or a space may accumulate — `LIMITS` has no such key, and no
  // handler reads one.
  assert.equal(Object.keys(LIMITS).some((k) => /quota|total|storage|maxOps(PerSpace|Total)/i.test(k)), false,
    'if a storage quota is ever added, this assertion is the one to delete');

  // What one device may lawfully write per minute, from the published numbers alone:
  const perMinute = LIMITS.pushPerMin * Math.min(
    LIMITS.opsPerPush * LIMITS.bytesPerEnvelope, LIMITS.bytesPerRequest);
  assert.equal(perMinute, 251658240);                     // 60 x 4 MiB = 240 MiB per device-minute

  // Executed in miniature: the same op-shaped batch, repeated, one op under every cap, is
  // accepted indefinitely and the log grows without bound. 40 batches x 50 ops.
  let seq = 0n;
  for (let i = 0; i < 40; i++) {
    const ops = Array.from({ length: 50 }, () => envelope(admin, spaceId, 1));
    const res = await srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.accepted.length, 50);
    seq = BigInt(res.body.spaceSeq);
  }
  assert.equal(seq, 2000n, 'every batch was accepted; nothing anywhere counts the total');
  assert.equal(await srv.store.headSeq(spaceId), 2000n);

  // The ONLY thing that answers is the per-device per-minute rate, and it resets on the minute.
  // 40 pushes are well inside 60/min, so nothing above was rate-limited at all.
  let refused = null;
  for (let i = 0; i < LIMITS.pushPerMin + 5; i++) {
    try {
      await srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: [envelope(admin, spaceId, 1)] });
    } catch (e) { refused = e.code; break; }
  }
  assert.equal(refused, 'rate_limited', 'the per-device rate is the only brake, and it is a RATE');
  c.advance(60001);
  assert.equal((await srv.call(admin, 'POST', '/ops', {}, {
    space: spaceId, ops: [envelope(admin, spaceId, 1)],
  })).status, 200, 'and one minute later the same device may continue, for ever');
});

test('§E ATTACK concurrent appends into one space — 32 in flight / DEFENDED (no seq collision)', async () => {
  const c = clock(start);
  const srv = server((k) => memoryStore({ now: k.now }), c);
  const { admin, spaceId } = await family(srv);

  // 32 pushes issued without awaiting, so they interleave at every await point inside the
  // handler. What must hold: every op gets its own seq, no seq is issued twice, and no seq is
  // skipped — a duplicate seq is one member's afternoon overwriting another's with a 200 OK
  // (`prisma.js`'s U-SEQ, here on the adapter that CAN be exercised).
  const reqs = [];
  for (let i = 0; i < 32; i++) {
    reqs.push(await srv.build(admin, 'POST', '/ops', {}, { space: spaceId, ops: [envelope(admin, spaceId, 1)] }));
  }
  const out = await Promise.all(reqs.map((r) => srv.route(srv.ctx, r)));
  const seqs = out.flatMap((r) => r.body.accepted.map((a) => a.seq));
  assert.equal(seqs.length, 32);
  assert.equal(new Set(seqs).size, 32, 'two concurrent pushes took the same seq');
  const sorted = [...seqs].map(BigInt).sort((a, b) => (a < b ? -1 : 1));
  for (let i = 0; i < sorted.length; i++) assert.equal(sorted[i], BigInt(i + 1), 'a seq was skipped');

  // And every one of them is readable back, in order, through one page.
  const page = await srv.call(admin, 'GET', '/ops', { space: spaceId, since: '0' }, undefined);
  assert.equal(page.body.ops.length, 32);
});

test('§E ATTACK the same op id with different bytes — a fork / DEFENDED', async () => {
  const c = clock(start);
  const srv = server((k) => memoryStore({ now: k.now }), c);
  const { admin, spaceId } = await family(srv);

  const e = envelope(admin, spaceId, 1);
  assert.equal((await srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: [e] })).status, 200);
  // Honest retry: `duplicate`, same seq, 200. This is what makes at-least-once delivery enough.
  const retry = await srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: [e] });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.duplicate.length, 1);
  assert.equal(retry.body.accepted.length, 0);

  // Same oid, different ciphertext — an attempt to make one op mean two different things to two
  // members depending on who pulled first.
  await expectFail(() => srv.call(admin, 'POST', '/ops', {}, {
    space: spaceId, ops: [{ ...e, ct: b64u(rnd(64)) }],
  }), 409, 'forked_op_id', 'same oid, different bytes');
  assert.equal(await srv.store.headSeq(spaceId), 1n);
});

/** The protocol-3 variant of `family()`: the same flow with an N-generation header. */
async function family3(srv) {
  const admin = await person('gruen', '198.51.100.19');
  const spaceId = `fsp_${b64u(rnd(16))}`;
  const res = await srv.call(admin, 'POST', '/spaces', {}, {
    spaceId, kind: 'FAMILY', colorRef: admin.colorRef,
    member: wireMember(admin), device: wireDevice(admin),
    wraps: [wrap(admin.deviceId, 1), wrap(`rec_${admin.memberId}`, 1)],
  }, (req) => { req.headers['x-lzp-protocol'] = '3'; });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { admin, spaceId };
}
