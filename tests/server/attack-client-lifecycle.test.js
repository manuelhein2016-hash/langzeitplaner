// tests/server/attack-client-lifecycle.test.js — THE HOSTILE CLIENT, part 2: membership.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE ATTACKS, AND WHY IT IS A SEPARATE FILE FROM `attack-client-relay.test.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Part 1 attacked the TRANSPORT: signatures, nonces, clocks, cursors, quotas. Everything there
// is a property of one request. This file attacks the things that are properties of the FAMILY —
// the single-use invite, the rotation coverage check, and the five lifecycle endpoints — where
// the damage is not "the attacker read something" but "an honest member is quietly cut off", and
// where the server is the only party in a position to notice.
//
// Two attackers, both of whom exist in the PO's stories:
//
//   · **T5, a family member with a patched app.** Authenticated, current, and hostile. Every
//     client-side check has been deleted. This is the attacker story 20.2 is written against.
//   · **An outsider holding a leaked invite code.** No key the relay knows, no member row, one
//     twelve-character code that was meant for somebody else.
//
//   ATTACK … / DEFENDED     tried in full, refused
//   ATTACK … / SUCCEEDS     tried in full, ALLOWED — a real capability, pinned so that closing
//                           it later is a test that changes rather than a discovery nobody makes
//
// Nothing here calls a handler directly. Everything enters through `createHandlers()`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createHandlers } from '../../server/core/handlers/index.js';
import { authenticate, assertMember, b64u } from '../../server/core/auth.js';
import { LIMITS, createLog } from '../../server/core/limits.js';
import { memoryStore } from '../../server/adapters/memory.js';
import { attestedPerson, attestedDeviceFor } from './_attested-person.js';
import { fileStore } from '../../server/adapters/file.js';
import { requiredRecipients } from '../../server/core/handlers/spaces.js';
import { MAX_OPEN_INVITES, INVITE_TTL_MS } from '../../server/core/handlers/invites.js';
import { MODEL_COLUMNS } from '../../server/core/store-interface.js';

const S = globalThis.crypto.subtle;
const TE = new TextEncoder();

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-atk2-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

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
  // Finding E2E3-7: `POST /spaces` and `POST /invites/redeem` now run ADR 002 §2.3's checks that
  // `POST /devices` has always run, and `GET /members` publishes the blob (E2E3-6). A person made
  // of `b64u(rnd(120))` is refused at the door — so this mints with the SHIPPING
  // `buildDeviceAttestation` + `attestDevice`, exactly what a Mac does.
  const p = await attestedPerson({ colorRef });
  return {
    colorRef,
    ip: ip || '198.51.100.9',
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

/** An opaque wrap. The relay cannot tell this from a real one — which is §C's whole subject. */
const wrap = (recipientId, epoch) => ({ recipientId, epoch, wrapped: b64u(rnd(156)) });

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
    method, path: full, query: query || {},
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
  const call = async (p, method, urlPath, query, body, tamper) => {
    const res = await route(ctx, await signedReq(p, method, urlPath, query, body, c.now(), tamper));
    c.advance(1);
    return res;
  };
  const build = (p, method, urlPath, query, body) => signedReq(p, method, urlPath, query, body, c.now());
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

/** Derive an invite the way ADR 002 §7.1 does: the CODE never reaches the server. */
async function deriveInvite(code) {
  const proof = new Uint8Array(await S.digest('SHA-256', TE.encode(`verify|${code}`)));
  const verifier = new Uint8Array(await S.digest('SHA-256', proof));
  const inviteId = b64u(new Uint8Array(await S.digest('SHA-256', TE.encode(`id|${code}`))).subarray(0, 16));
  return { code, proof, verifier, inviteId };
}

async function mintInvite(srv, by, spaceId, code) {
  const inv = await deriveInvite(code || b64u(rnd(8)));
  const res = await srv.call(by, 'POST', '/invites', {}, {
    spaceId, inviteId: inv.inviteId, verifier: b64u(inv.verifier),
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return inv;
}

const redeemBody = (inv, p) => ({
  inviteId: inv.inviteId, proof: b64u(inv.proof), colorRef: p.colorRef,
  member: wireMember(p), device: wireDevice(p),
});

async function createSpace(srv, p, spaceId, kind) {
  const res = await srv.call(p, 'POST', '/spaces', {}, {
    spaceId, kind: kind || 'FAMILY', colorRef: p.colorRef,
    member: wireMember(p), device: wireDevice(p),
    wraps: [wrap(p.deviceId, 1), wrap(`rec_${p.memberId}`, 1)],
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res;
}

/** A family: `admin` created it, `honest` joined. Both current. */
async function family(srv) {
  const admin = await person('gruen', '198.51.100.9');
  const honest = await person('blau', '198.51.100.10');
  const spaceId = `fsp_${b64u(rnd(16))}`;
  await createSpace(srv, admin, spaceId);
  const inv = await mintInvite(srv, admin, spaceId);
  const res = await srv.call(honest, 'POST', '/invites/redeem', {}, redeemBody(inv, honest));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { admin, honest, spaceId };
}

/** The full, honest wrap set for the space as it stands — every recipient, every epoch 1..e. */
async function fullCoverage(srv, spaceId, upTo) {
  const rs = requiredRecipients(
    await srv.store.listMembers(spaceId), await srv.store.listDevices(spaceId),
    (await srv.store.getSpace(spaceId)).kind,
  );
  const out = [];
  for (const r of rs) for (let e = 1; e <= upTo; e++) out.push(wrap(r, e));
  return out;
}

const ADAPTERS = [
  { name: 'memory', make: (c) => memoryStore({ now: c.now }) },
  { name: 'file', make: (c) => fileStore(tempDir(), { now: c.now }) },
];
const start = 1787900000000;

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`${adapter.name} :: ${name}`, fn);

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §A  BREAKING THE ATOMIC SINGLE-USE INVITE  (story 15.3, 15.5 · ADR 002 §7.1)
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('§A ATTACK race two redemptions of ONE code / DEFENDED — exactly one wins', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const admin = await person('gruen', '198.51.100.9');
    const spaceId = `fsp_${b64u(rnd(16))}`;
    await createSpace(srv, admin, spaceId);
    const inv = await mintInvite(srv, admin, spaceId);

    // The leaked code, redeemed by two different machines at the same instant. Both requests are
    // fully valid and both hold the proof; only the store's atomic `consumeInvite` separates
    // them. Issued without awaiting, so they interleave at every await inside the handler.
    const a = await person('blau', '203.0.113.30');
    const b = await person('rot', '203.0.113.31');
    const reqs = [
      await srv.build(a, 'POST', '/invites/redeem', {}, redeemBody(inv, a)),
      await srv.build(b, 'POST', '/invites/redeem', {}, redeemBody(inv, b)),
    ];
    const out = await Promise.allSettled(reqs.map((r) => srv.route(srv.ctx, r)));

    const won = out.filter((o) => o.status === 'fulfilled' && o.value.status === 200);
    const lost = out.filter((o) => o.status === 'rejected');
    assert.equal(won.length, 1, `both redemptions of one code succeeded: ${JSON.stringify(out.map((o) => o.status))}`);
    assert.equal(lost.length, 1);
    assert.equal(lost[0].reason.code, 'invite_used');
    assert.equal(lost[0].reason.status, 409);

    // The circle has exactly two people in it, and the loser left no member row and no device.
    const members = (await srv.store.listMembers(spaceId)).filter((m) => m.removedAt === null);
    assert.equal(members.length, 2);
    const devices = await srv.store.listDevices(spaceId);
    assert.equal(devices.length, 2);
    // Nothing half-written: the loser has neither a member row nor a device row anywhere.
    const loserIds = [a, b].map((p) => p.memberId).filter((id) => !members.some((m) => m.id === id));
    assert.equal(loserIds.length, 1);
    assert.equal(await srv.store.getDeviceByShort([a, b].find((p) => p.memberId === loserIds[0]).deviceShort), null);
  });

  T('§A ATTACK sixteen simultaneous redemptions of one code / DEFENDED — still exactly one', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const admin = await person('gruen', '198.51.100.9');
    const spaceId = `fsp_${b64u(rnd(16))}`;
    await createSpace(srv, admin, spaceId);
    const inv = await mintInvite(srv, admin, spaceId);

    // Two is a race; sixteen is a fan-out. Every one of them carries a DIFFERENT colour, so the
    // 15.3 colour check cannot be what separates them — it has to be `consumeInvite`.
    const colours = ['blau', 'rot', 'gelb', 'lila', 'orange', 'tuerkis', 'rosa', 'braun',
      'grau', 'oliv', 'mint', 'bordeaux', 'ocker', 'petrol', 'flieder', 'sand'];
    const people = [];
    for (let i = 0; i < 16; i++) people.push(await person(colours[i], `203.0.113.${100 + i}`));
    const reqs = [];
    for (const p of people) reqs.push(await srv.build(p, 'POST', '/invites/redeem', {}, redeemBody(inv, p)));
    const out = await Promise.allSettled(reqs.map((r) => srv.route(srv.ctx, r)));

    const won = out.filter((o) => o.status === 'fulfilled' && o.value.status === 200);
    assert.equal(won.length, 1, `${won.length} of 16 redemptions of one code succeeded`);
    for (const o of out.filter((x) => x.status === 'rejected')) assert.equal(o.reason.code, 'invite_used');
    assert.equal((await srv.store.listMembers(spaceId)).filter((m) => m.removedAt === null).length, 2);
  });

  T('§A ATTACK redeem a REVOKED, an EXPIRED and an UNKNOWN invite / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const admin = await person('gruen', '198.51.100.9');
    const spaceId = `fsp_${b64u(rnd(16))}`;
    await createSpace(srv, admin, spaceId);

    // Revoked (15.5 — "a leaked code can't haunt the family").
    const revoked = await mintInvite(srv, admin, spaceId);
    assert.equal((await srv.call(admin, 'POST', '/invites/revoke', {}, {
      spaceId, inviteId: revoked.inviteId,
    })).body.state, 'revoked');
    const outsider = await person('blau', '203.0.113.40');
    await expectFail(() => srv.call(outsider, 'POST', '/invites/redeem', {}, redeemBody(revoked, outsider)),
      403, 'invite_invalid', 'a revoked invite');

    // Expired: 7 days exactly, and the boundary is `<=`, so the last millisecond is dead.
    const stale = await mintInvite(srv, admin, spaceId);
    c.advance(INVITE_TTL_MS + 1);
    const late = await person('rot', '203.0.113.41');
    await expectFail(() => srv.call(late, 'POST', '/invites/redeem', {}, redeemBody(stale, late)),
      403, 'invite_invalid', 'an invite one millisecond past its TTL');

    // Unknown, and — the part that matters — a KNOWN id with the WRONG proof answers identically,
    // so an eavesdropper who saw an id on the wire cannot poll for "has it been redeemed yet".
    const live = await mintInvite(srv, admin, spaceId);
    const wrongProof = await person('gelb', '203.0.113.42');
    const unknownAnswer = await expectFail(
      () => srv.call(wrongProof, 'POST', '/invites/redeem', {}, {
        ...redeemBody(live, wrongProof), inviteId: b64u(rnd(16)),
      }), 403, 'invite_invalid', 'an unknown invite id');
    const badProofAnswer = await expectFail(
      () => srv.call(wrongProof, 'POST', '/invites/redeem', {}, {
        ...redeemBody(live, wrongProof), proof: b64u(rnd(32)),
      }), 403, 'invite_invalid', 'a known id with the wrong proof');
    assert.deepEqual(unknownAnswer, badProofAnswer, 'the two answers must be indistinguishable');

    // And the live invite is STILL live — a failed attempt must never consume it (15.3's minute).
    const good = await person('mint', '203.0.113.43');
    assert.equal((await srv.call(good, 'POST', '/invites/redeem', {}, redeemBody(live, good))).status, 200);
  });

  T('§A ATTACK a rolled-back redemption must not burn the code / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv);
    const inv = await mintInvite(srv, admin, spaceId);

    // A colour collision — the one failure a real family hits — happens INSIDE the transaction,
    // after `consumeInvite`. If the rollback were not total, Mama's second attempt would meet a
    // code that no longer works and an admin who has to mint another.
    const clash = await person(honest.colorRef, '203.0.113.50');
    await expectFail(() => srv.call(clash, 'POST', '/invites/redeem', {}, redeemBody(inv, clash)),
      400, 'bad_request', 'a colour already taken');
    assert.equal((await srv.store.getInvite(inv.inviteId)).usedAt, null, 'a failed redemption burned the invite');

    // The SAME code, a different colour: in.
    const retry = await person('gelb', '203.0.113.50');
    assert.equal((await srv.call(retry, 'POST', '/invites/redeem', {}, redeemBody(inv, retry))).status, 200);
    assert.notEqual((await srv.store.getInvite(inv.inviteId)).usedAt, null);
  });

  T('§A ATTACK brute-force a code inside its TTL / DEFENDED — 10 tries per IP per hour', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const admin = await person('gruen', '198.51.100.9');
    const spaceId = `fsp_${b64u(rnd(16))}`;
    await createSpace(srv, admin, spaceId);
    await mintInvite(srv, admin, spaceId);

    // The outsider knows the space exists and nothing else. Every guess costs one unit of
    // `inviteRedeem` — charged BEFORE the signature is verified, which is the point: verifying
    // P-256 is the expensive half, so a limiter after it would bound the database and not the CPU.
    const guesser = await person('rot', '203.0.113.60');
    let allowed = 0; let stopped = null;
    for (let i = 0; i < LIMITS.invitesPerIpHour + 6; i++) {
      const junk = await deriveInvite(b64u(rnd(8)));
      try {
        await srv.call(guesser, 'POST', '/invites/redeem', {}, redeemBody(junk, guesser));
        allowed++;
      } catch (e) {
        if (e.code === 'invite_invalid') { allowed++; continue; }
        stopped = e; break;
      }
    }
    assert.equal(allowed, LIMITS.invitesPerIpHour, `${allowed} guesses were served, budget is ${LIMITS.invitesPerIpHour}`);
    assert.equal(stopped.code, 'rate_limited');
    assert.equal(stopped.status, 429);
    assert.equal(stopped.extra.retryAfter, 3600);

    // The arithmetic that makes the budget sufficient, asserted rather than asserted-about: an
    // inviteId is 128 bits and the proof is a 256-bit preimage. 10 guesses an hour against 2^128
    // is not a race anyone finishes; the TTL is 7 days.
    assert.equal(INVITE_TTL_MS / 3600000 * LIMITS.invitesPerIpHour, 1680);   // guesses per IP per TTL

    // One hour later the budget is fresh — a limiter a family cannot recover from would be its
    // own denial of service.
    c.advance(3600001);
    const junk = await deriveInvite(b64u(rnd(8)));
    await expectFail(() => srv.call(guesser, 'POST', '/invites/redeem', {}, redeemBody(junk, guesser)),
      403, 'invite_invalid', 'the budget resets on the hour');
  });

  T('§A ATTACK resurrect a spent invite by re-POSTing its id / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);
    const inv = await mintInvite(srv, admin, spaceId);
    const joiner = await person('gelb', '203.0.113.70');
    assert.equal((await srv.call(joiner, 'POST', '/invites/redeem', {}, redeemBody(inv, joiner))).status, 200);

    // `putInvite` is an UPSERT, so re-POSTing a spent id would reset `usedAt` and hand the code a
    // second life. Refused inside the transaction because the interface has no create-only form.
    await expectFail(() => srv.call(admin, 'POST', '/invites', {}, {
      spaceId, inviteId: inv.inviteId, verifier: b64u(inv.verifier),
    }), 400, 'bad_request', 're-minting a spent invite id');
    assert.notEqual((await srv.store.getInvite(inv.inviteId)).usedAt, null);

    // …and the spent code stays spent.
    const second = await person('lila', '203.0.113.71');
    await expectFail(() => srv.call(second, 'POST', '/invites/redeem', {}, redeemBody(inv, second)),
      409, 'invite_used', 'the spent code, after the resurrection attempt');
  });

  T('§A ATTACK an invite for space A, redeemed against space B / DEFENDED (there is no such body)',
    async () => {
      const c = clock(start);
      const srv = server(adapter.make, c);
      const { admin, spaceId } = await family(srv);

      const other = await person('rot', '203.0.113.80');
      const otherSpace = `fsp_${b64u(rnd(16))}`;
      await createSpace(srv, other, otherSpace);

      // The redemption body names no space at all: the space comes from the INVITE ROW, so there
      // is no field to point elsewhere. And an unknown key is refused rather than ignored.
      const inv = await mintInvite(srv, admin, spaceId);
      const joiner = await person('gelb', '203.0.113.81');
      await expectFail(() => srv.call(joiner, 'POST', '/invites/redeem', {}, {
        ...redeemBody(inv, joiner), spaceId: otherSpace,
      }), 400, 'bad_request', 'a spaceId smuggled into a redemption');

      // Cross-space revocation by id alone is refused the same way: `revokeInvite` proves the
      // invite lives in the space the CALLER is a member of before touching it.
      const res = await srv.call(other, 'POST', '/invites/revoke', {}, {
        spaceId: otherSpace, inviteId: inv.inviteId,
      });
      assert.equal(res.body.state, 'unknown', 'a stranger revoked another family\'s invite');
      assert.equal((await srv.store.getInvite(inv.inviteId)).revokedAt, null);
      // …and naming the victim's space instead is a 403 before anything is read.
      await expectFail(() => srv.call(other, 'POST', '/invites/revoke', {}, {
        spaceId, inviteId: inv.inviteId,
      }), 403, 'not_a_member', 'revoking by naming the victim\'s space');
    });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §B  DEFEATING THE ROTATION COVERAGE CHECK — the shapes it catches  (story 20.2)
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('§B ATTACK rotate omitting a member entirely / DEFENDED, and epoch e+1 is not burned', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv);

    // Not just her device — her whole person. The ring covers the attacker and nobody else.
    const selfish = [wrap(admin.deviceId, 1), wrap(admin.deviceId, 2),
      wrap(`rec_${admin.memberId}`, 1), wrap(`rec_${admin.memberId}`, 2)];
    const got = await expectFail(
      () => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: selfish }),
      409, 'incomplete_coverage', 'omitting a whole member');
    const named = got.extra.missing.map((m) => m.recipientId);
    assert.ok(named.includes(honest.deviceId));
    // INVERTED 2026-08-29 — finding E2E3-8. `rec_${honest.memberId}` used to be named here too.
    // A FAMILY rotation no longer owes it, because no client can build that wrap without wrapping
    // to an UNSIGNED `Member.recoveryPubKex` and handing the relay the family key. The attack
    // this row is about — omitting a whole member — is still refused, on her device.
    assert.equal(named.includes(`rec_${honest.memberId}`), false,
      'a family recovery wrap is permitted, not required (ADR 002 §4.2 step 2, amended)');

    // A refused rotation that had consumed e+1 would wedge the family for ever: the honest
    // rotator that comes next would get `epoch_taken` for an epoch nobody holds a key for.
    assert.equal((await srv.store.getSpace(spaceId)).currentEpoch, 1);
    assert.equal((await srv.store.getKeyWraps(spaceId, admin.deviceId)).length, 1, 'the refused epoch-2 wraps were kept');
    const ok = await srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, {
      epoch: 2, wraps: await fullCoverage(srv, spaceId, 2),
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  T('§B ATTACK claim coverage with the CURRENT epoch only / DEFENDED — 1..e is owed', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv);

    // Everyone reached, nobody backfilled. This is the attack that reads as an optimisation, and
    // its victim is the person who just joined: Oma's birthday, entered in epoch 1, silently
    // stops rendering and there is no error anywhere (ADR 002 §4.3 / §7.1 step 5 / A4 / R11).
    const rs = requiredRecipients(
    await srv.store.listMembers(spaceId), await srv.store.listDevices(spaceId),
    (await srv.store.getSpace(spaceId)).kind,
  );
    const got = await expectFail(
      () => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: rs.map((r) => wrap(r, 2)) }),
      409, 'incomplete_coverage', 'epoch 2 only');
    assert.ok(got.extra.missing.some((m) => m.epoch === 1 && m.recipientId === honest.deviceId));
    assert.equal((await srv.store.getSpace(spaceId)).currentEpoch, 1);
  });

  T('§B ATTACK pad the ring with phantom recipients / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv);

    // Two shapes of phantom: an invented device id and an invented recovery recipient. Either
    // would make the COUNT look right; both are also a small write-anything store on someone
    // else's relay, which is the second reason to refuse them.
    for (const phantom of [`dev_${b64u(rnd(16))}`, `rec_mem_${b64u(rnd(16))}`]) {
      const padded = [...await fullCoverage(srv, spaceId, 2)]
        .filter((w) => w.recipientId !== honest.deviceId)
        .concat([wrap(phantom, 1), wrap(phantom, 2)]);
      await expectFail(
        () => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: padded }),
        400, 'bad_request', `a phantom recipient ${phantom}`);
      assert.equal((await srv.store.getSpace(spaceId)).currentEpoch, 1);
      assert.equal((await srv.store.getKeyWraps(spaceId, phantom)).length, 0, 'the phantom row was stored');
    }

    // And a device that names itself `rec_mem_…` cannot be registered in the first place, so the
    // two namespaces can never meet: `readDevice` pins `dev_` + 22 b64url as the only spelling.
    const squatter = await person('rot', '203.0.113.90');
    await expectFail(() => srv.call(squatter, 'POST', '/spaces', {}, {
      spaceId: `fsp_${b64u(rnd(16))}`, kind: 'FAMILY', colorRef: squatter.colorRef,
      member: wireMember(squatter),
      device: { ...wireDevice(squatter), deviceId: `rec_${squatter.memberId}` },
      wraps: [wrap(`rec_${squatter.memberId}`, 1)],
    }), 400, 'bad_request', 'a device id in the recovery namespace');
  });

  T('§B ATTACK rotate to a JUST-REMOVED member / DEFENDED — accepted, then purged', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv);

    assert.equal((await srv.call(admin, 'POST', '/members/remove', {}, {
      spaceId, memberId: honest.memberId,
    })).status, 200);

    // The honest race is ADMITTED — a member removed between the rotator's read and its POST is
    // still a KNOWN recipient, and refusing would make every removal a rotation the family
    // cannot complete. What must hold is that the rows do not SURVIVE: `staleRecipients` deletes
    // them in the same transaction, for all epochs, so a removed member's device is left with no
    // delivery path at all (ADR 002 §4.2 step 4).
    const wraps = [...await fullCoverage(srv, spaceId, 2),
      wrap(honest.deviceId, 1), wrap(honest.deviceId, 2),
      wrap(`rec_${honest.memberId}`, 1), wrap(`rec_${honest.memberId}`, 2)];
    const res = await srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await srv.store.getKeyWraps(spaceId, honest.deviceId)).length, 0,
      'a removed member kept a live key-delivery path');
    assert.equal((await srv.store.getKeyWraps(spaceId, `rec_${honest.memberId}`)).length, 0);
    assert.ok(res.body.wrapsPurged > 0);
  });

  T('§B ATTACK race a rotation against a join / DEFENDED — the joiner is never half-covered', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);
    const inv = await mintInvite(srv, admin, spaceId);
    const joiner = await person('gelb', '203.0.113.95');

    // The rotator computes its ring from the member list it can see, and a joiner lands in the
    // middle. Both requests are issued without awaiting. Whichever order the store serialises
    // them in, the invariant afterwards must be the same: the space is at an epoch, and every
    // required recipient holds every epoch 1..e — or the rotation was refused and NOTHING moved.
    const stale = await fullCoverage(srv, spaceId, 2);          // computed BEFORE the joiner exists
    const rot = await srv.build(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: stale });
    const red = await srv.build(joiner, 'POST', '/invites/redeem', {}, redeemBody(inv, joiner));
    const out = await Promise.allSettled([srv.route(srv.ctx, rot), srv.route(srv.ctx, red)]);

    const rotOut = out[0];
    const redOut = out[1];
    assert.equal(redOut.status, 'fulfilled', 'the join must never be collateral damage of a rotation');
    assert.equal(redOut.value.status, 200);

    const space = await srv.store.getSpace(spaceId);
    if (rotOut.status === 'fulfilled') {
      // The rotation went first. The joiner is then simply not covered yet — the DESIGNED D9
      // waiting state, `pendingKeys: true` — and the NEXT rotation is obliged to backfill 1..2
      // for her. The one thing that must not be true is a silent partial ring.
      assert.equal(space.currentEpoch, 2);
      assert.equal(redOut.value.body.pendingKeys, true);
      const gap = await expectFail(async () => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, {
        epoch: 3, wraps: (await fullCoverage(srv, spaceId, 3)).filter((w) => w.recipientId !== joiner.deviceId),
      }), 409, 'incomplete_coverage', 'the joiner is still owed 1..3');
      assert.ok(gap.extra.missing.some((m) => m.recipientId === joiner.deviceId && m.epoch === 1));
    } else {
      // The join went first, so the rotator's stale ring no longer covers everybody — and the
      // server catches exactly that, naming the joiner, and leaves the epoch where it was.
      assert.equal(rotOut.reason.code, 'incomplete_coverage');
      assert.ok(rotOut.reason.extra.missing.some((m) => m.recipientId === joiner.deviceId));
      assert.equal(space.currentEpoch, 1, 'a refused rotation moved the epoch');
    }
  });

  T('§B ATTACK jump the epoch, replay an old one, or send a fractional one / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);

    // A jump buys an unbounded amount of coverage work with one request, so `epoch` must be
    // exactly currentEpoch + 1.
    await expectFail(() => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, {
      epoch: 999999, wraps: [wrap(admin.deviceId, 1)],
    }), 400, 'bad_request', 'an epoch jump');
    // Behind, or equal: the documented lost-race answer, so a client re-fetches its wraps.
    for (const e of [1]) {
      await expectFail(() => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, {
        epoch: e, wraps: [wrap(admin.deviceId, 1)],
      }), 409, 'epoch_taken', `epoch ${e}`);
    }
    for (const e of [0, -1, 2.5, '2', null, 1e9 + 1]) {
      await expectFail(() => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, {
        epoch: e, wraps: [wrap(admin.deviceId, 1)],
      }), 400, 'bad_request', `epoch ${JSON.stringify(e)}`);
    }
    // A wrap for an epoch ABOVE the one being claimed is a shape error, not silent extra data.
    await expectFail(async () => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, {
      epoch: 2, wraps: [...await fullCoverage(srv, spaceId, 2), wrap(admin.deviceId, 3)],
    }), 400, 'bad_request', 'a wrap for a future epoch');
    // Two wraps for one (recipient, epoch): the store would upsert and the last would win — a
    // coin flip over which key ring a member ends up holding.
    await expectFail(async () => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, {
      epoch: 2, wraps: [...await fullCoverage(srv, spaceId, 2), wrap(admin.deviceId, 2)],
    }), 400, 'bad_request', 'a duplicated (recipient, epoch)');
    assert.equal((await srv.store.getSpace(spaceId)).currentEpoch, 1);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // §C  ABUSING THE LIFECYCLE  (stories 20.1-20.4 · finding E2-L1)
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  T('§C ATTACK make the cascade purge reach another space\'s rows / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, honest, spaceId } = await family(srv);

    // A second, unrelated family, with its own ops, members, devices, wraps and invites.
    const other = await person('rot', '203.0.113.120');
    const bystander = await person('gelb', '203.0.113.121');
    const otherSpace = `fsp_${b64u(rnd(16))}`;
    await createSpace(srv, other, otherSpace);
    const inv = await mintInvite(srv, other, otherSpace);
    assert.equal((await srv.call(bystander, 'POST', '/invites/redeem', {}, redeemBody(inv, bystander))).status, 200);
    const liveInvite = await mintInvite(srv, other, otherSpace);
    const env = (p, sp) => ({
      v: 1, sp, ep: 1, dv: p.deviceShort, oid: b64u(rnd(16)), wit: '',
      iv: b64u(rnd(12)), ct: b64u(rnd(64)), sig: b64u(rnd(64)),
    });
    for (const p of [other, bystander]) {
      assert.equal((await srv.call(p, 'POST', '/ops', {}, { space: otherSpace, ops: [env(p, otherSpace)] })).status, 200);
    }
    for (const p of [admin, honest]) {
      assert.equal((await srv.call(p, 'POST', '/ops', {}, { space: spaceId, ops: [env(p, spaceId)] })).status, 200);
    }
    const otherHead = await srv.store.headSeq(otherSpace);

    // 1. The 20.2 purge names a member; the shorts it deletes come from `listDevices(spaceId)`
    //    and never from the caller, so there is no field to point at a foreign device.
    assert.equal((await srv.call(admin, 'POST', '/members/remove', {}, {
      spaceId, memberId: honest.memberId,
    })).status, 200);
    assert.equal(await srv.store.headSeq(otherSpace), otherHead, 'a removal reached another space\'s ops');
    assert.equal((await srv.store.getKeyWraps(otherSpace, other.deviceId)).length, 1,
      'the other family\'s epoch-1 wraps were purged by a removal in MY space');

    // 2. Naming a FOREIGN member id on a space you are in: not a member of THIS space -> 403.
    await expectFail(() => srv.call(admin, 'POST', '/members/remove', {}, {
      spaceId, memberId: bystander.memberId,
    }), 403, 'not_a_member', 'removing a member of another family');

    // 3. And the whole-space cascade. Deleting my own circle must leave the other one intact,
    //    down to its open invite.
    assert.equal((await srv.call(admin, 'POST', `/spaces/${spaceId}/delete`, {}, { confirm: spaceId })).status, 200);
    assert.equal(await srv.store.getSpace(spaceId), null);
    assert.notEqual(await srv.store.getSpace(otherSpace), null);
    assert.equal(await srv.store.headSeq(otherSpace), otherHead);
    assert.equal((await srv.store.listMembers(otherSpace)).length, 2);
    assert.equal((await srv.store.listDevices(otherSpace)).length, 2);
    assert.notEqual(await srv.store.getDeviceByShort(otherSpace, other.deviceShort), null);
    assert.equal((await srv.store.getInvite(liveInvite.inviteId)).revokedAt, null);
    assert.equal((await srv.store.getKeyWraps(otherSpace, other.deviceId)).length, 1);
  });

  T('§C ATTACK remove a member of a space I am not in / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { honest, spaceId } = await family(srv);
    const outsider = await person('rot', '203.0.113.130');
    await createSpace(srv, outsider, `fsp_${b64u(rnd(16))}`);

    await expectFail(() => srv.call(outsider, 'POST', '/members/remove', {}, {
      spaceId, memberId: honest.memberId,
    }), 403, 'not_a_member', 'an outsider removing a member');
    await expectFail(() => srv.call(outsider, 'POST', `/spaces/${spaceId}/delete`, {}, { confirm: spaceId }),
      403, 'not_a_member', 'an outsider deleting a circle');
    await expectFail(() => srv.call(outsider, 'POST', '/members/transfer', {}, {
      spaceId, memberId: honest.memberId,
    }), 403, 'not_a_member', 'an outsider transferring the admin role');
    assert.notEqual(await srv.store.getSpace(spaceId), null);
    assert.equal((await srv.store.listMembers(spaceId)).every((m) => m.removedAt === null), true);
  });

  T('§C ATTACK smuggle a readable name onto the relay through a lifecycle body / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);
    // The relay holds no space name, no display name and no role. A body offering one is a client
    // that believes otherwise, and it is corrected loudly at the boundary rather than ignored.
    for (const field of ['name', 'title', 'displayName', 'role', 'admin', 'note', 'description']) {
      const got = await expectFail(() => srv.call(admin, 'POST', `/spaces/${spaceId}/rename`, {}, {
        [field]: 'Familie Hein',
      }), 400, 'bad_request', `rename carrying ${field}`);
      assert.equal(got.extra.reason, 'the_relay_stores_no_readable_names');
    }
    // The endpoint exists to SAY the rename is local, and it stores nothing when it succeeds.
    const ok = await srv.call(admin, 'POST', `/spaces/${spaceId}/rename`, {}, {});
    assert.equal(ok.body.renamed, false);
    assert.equal(ok.body.stored, 'nothing');
    // No String column anywhere could hold it even if a handler tried.
    assert.deepEqual(MODEL_COLUMNS.Space, ['id', 'kind', 'currentEpoch', 'nextSeq', 'headChain', 'createdAt']);
  });

  T('§C ATTACK delete a circle with no confirmation, or the wrong one / DEFENDED', async () => {
    const c = clock(start);
    const srv = server(adapter.make, c);
    const { admin, spaceId } = await family(srv);
    const other = `fsp_${b64u(rnd(16))}`;
    for (const confirm of [undefined, '', other, spaceId.toUpperCase(), ` ${spaceId}`]) {
      await expectFail(() => srv.call(admin, 'POST', `/spaces/${spaceId}/delete`, {},
        confirm === undefined ? {} : { confirm }),
        400, 'bad_request', `confirm=${JSON.stringify(confirm)}`);
    }
    assert.notEqual(await srv.store.getSpace(spaceId), null);
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §D  THE ATTACKS THAT SUCCEED.
//
// Memory adapter only. Every one of these is a property of `server/core/` — the code both
// adapters share verbatim — and none of them turns on storage behaviour.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§D ATTACK satisfy the coverage check with NOISE / SUCCEEDS — 20.2\'s control is a SHAPE check',
  async () => {
    const c = clock(start);
    const srv = server((k) => memoryStore({ now: k.now }), c);
    const { admin, honest, spaceId } = await family(srv);

    // THE ATTACK. The hostile admin does NOT omit the honest member — omission is the one shape
    // `assertCoverage` catches. She sends a wrap for every required recipient and every epoch
    // 1..2, exactly as an honest rotation would, and puts 156 bytes of noise in the honest
    // member's rows instead of a real wrap of the epoch key.
    //
    // The relay is blind BY DESIGN (story 21.1): `KeyWrap.wrapped` is an opaque column, and
    // `spaces.js` says so in as many words — "the server still cannot read a wrap, cannot tell a
    // good wrap from 156 bytes of noise". Every wrap in this whole test file is noise; that is
    // why the rest of them are still valid tests of the shape rule. Here it is the payload.
    const rs = requiredRecipients(
    await srv.store.listMembers(spaceId), await srv.store.listDevices(spaceId),
    (await srv.store.getSpace(spaceId)).kind,
  );
    const victimRecipients = new Set([honest.deviceId, `rec_${honest.memberId}`]);
    const hostile = [];
    for (const r of rs) {
      for (let e = 1; e <= 2; e++) {
        // For the attacker: what a real rotation puts there. For the victim: garbage of exactly
        // the same length. The relay has no way to distinguish the two, and does not try.
        hostile.push({ recipientId: r, epoch: e, wrapped: b64u(rnd(156)) });
      }
    }
    assert.equal(hostile.filter((w) => victimRecipients.has(w.recipientId)).length, 2,
      'the victim IS addressed — that is what makes this pass the check. Two rows rather than '
      + 'four since finding E2E3-8 withdrew the FAMILY `rec_<memberId>` demand; the attack is '
      + 'unchanged, because it was never about the recovery wrap.');

    const res = await srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: hostile });
    assert.equal(res.status, 200, 'the coverage check refused a full-shaped ring — it does not');
    assert.equal(res.body.currentEpoch, 2);
    assert.equal(res.body.wrapsStored, hostile.length);

    // The victim is now on the wrong side of the epoch boundary and everything looks healthy.
    // Her key endpoint answers 200 with `keysPending: false` and four rows she cannot open.
    const hers = await srv.call(honest, 'GET', `/spaces/${spaceId}/keys`, {}, undefined);
    assert.equal(hers.status, 200);
    assert.equal(hers.body.currentEpoch, 2);
    assert.equal(hers.body.keysPending, false, 'the ONE signal a client has says everything is fine');
    assert.equal(hers.body.wraps.length, 2, 'two epochs of unopenable rows, addressed to her device');

    // …and she can still pull every op the attacker writes at epoch 2, as ciphertext she will
    // never open. Not one status code in this sequence is anything but 200.
    const ev = {
      v: 1, sp: spaceId, ep: 2, dv: admin.deviceShort, oid: b64u(rnd(16)), wit: '',
      iv: b64u(rnd(12)), ct: b64u(rnd(64)), sig: b64u(rnd(64)),
    };
    assert.equal((await srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: [ev] })).status, 200);
    const page = await srv.call(honest, 'GET', '/ops', { space: spaceId, since: '0' }, undefined);
    assert.equal(page.status, 200);
    assert.equal(page.body.ops.length, 1);
    assert.equal(page.body.currentEpoch, 2);

    // The residual, stated exactly: `assertCoverage` proves that a (recipient, epoch) ROW EXISTS.
    // It cannot prove the row is a wrap of the right key to the right public key, because proving
    // that requires reading it — which is the one thing 21.1 forbids. The control raises the cost
    // of the 20.2 attack from "omit a recipient" to "send noise", and no further.
  });

test('§D ATTACK remove any member, without being the admin / SUCCEEDS — finding E2-L1', async () => {
  const c = clock(start);
  const srv = server((k) => memoryStore({ now: k.now }), c);
  const { admin, honest, spaceId } = await family(srv);

  // A third member, so the attacker is unambiguously NOT the space's creator.
  const inv = await mintInvite(srv, admin, spaceId);
  const kid = await person('gelb', '203.0.113.140');
  assert.equal((await srv.call(kid, 'POST', '/invites/redeem', {}, redeemBody(inv, kid))).status, 200);

  // `honest` — who created nothing and was invited by someone else — removes the person who
  // created the circle. The relay has no `role` column and cannot have one: the admin is resolved
  // from the in-log chain, which lives inside the ciphertext (ADR 003 §5.1, story 21.1).
  const res = await srv.call(honest, 'POST', '/members/remove', {}, { spaceId, memberId: admin.memberId });
  assert.equal(res.status, 200, 'the relay refused a non-admin removal — it cannot');
  assert.equal(res.body.removed, true);
  assert.equal(res.body.revokedDevices, 1);

  // It is INSTANT and total: the creator's next request dies at auth step 4, their ops are gone
  // from the relay, their wraps are gone, and their invites are revoked.
  await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId }, undefined),
    403, 'device_revoked', 'the removed creator, one request later');
  assert.equal((await srv.store.getKeyWraps(spaceId, admin.deviceId)).length, 0);

  // What bounds it: ten per member per hour, and every removal is visible to everyone left.
  let refused = null;
  const victims = [];
  for (let i = 0; i < LIMITS.memberRemovePerMemberHour + 2; i++) {
    const p = await person(`c${i}`, `203.0.113.${170 + i}`);
    const iv = await mintInvite(srv, honest, spaceId);
    const r = await srv.call(p, 'POST', '/invites/redeem', {}, redeemBody(iv, p));
    assert.equal(r.status, 200);
    victims.push(p);
  }
  let removed = 1;   // the creator, above
  for (const v of victims) {
    try {
      await srv.call(honest, 'POST', '/members/remove', {}, { spaceId, memberId: v.memberId });
      removed++;
    } catch (e) { refused = e; break; }
  }
  assert.equal(refused.code, 'rate_limited');
  assert.equal(removed, LIMITS.memberRemovePerMemberHour,
    'the per-member-hour budget is the only thing standing between one patched app and the whole circle');
});

test('§D ATTACK delete the whole Familienkreis, without being the admin / SUCCEEDS', async () => {
  const c = clock(start);
  const srv = server((k) => memoryStore({ now: k.now }), c);
  const { admin, honest, spaceId } = await family(srv);
  const ev = {
    v: 1, sp: spaceId, ep: 1, dv: admin.deviceShort, oid: b64u(rnd(16)), wit: '',
    iv: b64u(rnd(12)), ct: b64u(rnd(64)), sig: b64u(rnd(64)),
  };
  assert.equal((await srv.call(admin, 'POST', '/ops', {}, { space: spaceId, ops: [ev] })).status, 200);

  // The invited member deletes the circle the other person created. One request, no rate limit
  // (`RATE_COVERAGE.deleteSpace` reasons "idempotent; the second call has nothing to delete" —
  // true, and irrelevant to the first call).
  const res = await srv.call(honest, 'POST', `/spaces/${spaceId}/delete`, {}, { confirm: spaceId });
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, true);
  assert.equal(res.body.purged.members, 2);
  assert.equal(res.body.purged.headSeq, '1');

  // Everything is gone, for everyone, including the creator's own device row.
  assert.equal(await srv.store.getSpace(spaceId), null);
  assert.equal(await srv.store.getDeviceByShort(admin.deviceShort), null);
  await expectFail(() => srv.call(admin, 'GET', '/ops', { space: spaceId }, undefined),
    403, 'device_revoked', 'the creator, after their circle was deleted under them');

  // The honest mitigation, and it is a real one: 20.4 promises "every member reverts to a fully
  // intact solo board", because every device holds a complete replica. The relay is what was
  // destroyed, not the data. The response says so, so a client cannot render this as data loss.
  assert.equal(res.body.localBoardsUnaffected, true);
});

test('§D ATTACK transfer the admin role to myself / DEFENDED — because the relay holds no role',
  async () => {
    const c = clock(start);
    const srv = server((k) => memoryStore({ now: k.now }), c);
    const { admin, honest, spaceId } = await family(srv);

    // Transferring TO yourself is refused outright.
    await expectFail(() => srv.call(honest, 'POST', '/members/transfer', {}, {
      spaceId, memberId: honest.memberId,
    }), 400, 'bad_request', 'transfer to self');

    // Transferring to somebody else answers 200 — and stores NOTHING. The endpoint is a
    // pre-flight check ("the successor exists and is current"), not a grant. There is no column
    // for it to write to: `role` is in FORBIDDEN_COLUMN_TOKENS and `MODEL_COLUMNS.Member` has no
    // such field, so a hostile transfer changes no authorization anywhere.
    const res = await srv.call(honest, 'POST', '/members/transfer', {}, { spaceId, memberId: admin.memberId });
    assert.equal(res.status, 200);
    assert.equal(res.body.authoritative, false);
    assert.equal(res.body.stored, 'nothing');
    assert.equal(res.body.rotateRequired, false);
    assert.deepEqual(MODEL_COLUMNS.Member,
      ['id', 'spaceId', 'colorRef', 'recoveryPubSig', 'recoveryPubKex', 'joinedAt', 'removedAt']);
    // A removed successor is refused: a transfer to nobody would hand the circle to nobody, and
    // the log op cannot be withdrawn once written.
    assert.equal((await srv.call(honest, 'POST', '/members/remove', {}, {
      spaceId, memberId: admin.memberId,
    })).status, 200);
    await expectFail(() => srv.call(honest, 'POST', '/members/transfer', {}, {
      spaceId, memberId: admin.memberId,
    }), 403, 'not_a_member', 'transfer to a removed member');

    // NOTE: `transferAdmin` is therefore not a privilege-escalation surface at all. The relay's
    // exposure is the opposite one — every member ALREADY has every power the admin has (§D
    // above), so there is no role left to escalate to.
  });

test('§D ATTACK a removed member rejoins on a still-live invite / SUCCEEDS, under a new pseudonym',
  async () => {
    const c = clock(start);
    const srv = server((k) => memoryStore({ now: k.now }), c);
    const { admin, honest, spaceId } = await family(srv);

    // The admin has an invite out for Oma. The hostile member sees the code (they are in the
    // family; the code travels by WhatsApp) and is then removed.
    const omasCode = await mintInvite(srv, admin, spaceId);
    assert.equal((await srv.call(admin, 'POST', '/members/remove', {}, {
      spaceId, memberId: honest.memberId,
    })).status, 200);

    // Re-joining as THEMSELVES is refused: their member row survives with `removedAt` set, and
    // their deviceShort is a function of a signing key the relay already holds.
    await expectFail(() => srv.call(honest, 'POST', '/invites/redeem', {}, redeemBody(omasCode, honest)),
      400, 'bad_request', 'the removed member, under their own identity');

    // But a member id and a device key are things a client mints for itself. One fresh keypair
    // and one fresh id, and the same person walks back in on the invite that was meant for Oma.
    const alias = await person('gelb', '203.0.113.160');
    const back = await srv.call(alias, 'POST', '/invites/redeem', {}, redeemBody(omasCode, alias));
    assert.equal(back.status, 200, 'a removed member could not re-enter on a live invite — they can');
    assert.equal(back.body.pendingKeys, true);

    // What bounds it, and it is the design rather than an accident: this is not a bypass of
    // removal, it is a REDEMPTION, and it costs a live invite that the family can revoke (15.5).
    // `purgeMember` already auto-revokes every invite the removed member ISSUED — this one was
    // issued by the admin, which is precisely why it survived.
    assert.equal((await srv.store.getInvite(omasCode.inviteId)).createdBy, admin.memberId);
    // And they arrive as a NEW member in the list every other member sees (15.4) — the intruder
    // is surfaced, never silent. Oma's code, meanwhile, no longer works.
    const roster = await srv.call(admin, 'GET', `/spaces/${spaceId}/members`, {}, undefined);
    assert.equal(roster.body.members.filter((m) => m.removedAt === null).length, 2);
    const oma = await person('mint', '203.0.113.161');
    await expectFail(() => srv.call(oma, 'POST', '/invites/redeem', {}, redeemBody(omasCode, oma)),
      409, 'invite_used', 'the invite Oma was actually sent');
  });

test('§D ATTACK grief the family by filling every invite slot / SUCCEEDS, and it is reversible', async () => {
  const c = clock(start);
  const srv = server((k) => memoryStore({ now: k.now }), c);
  const { admin, honest, spaceId } = await family(srv);

  // `createInvite` carries NO rate limiter — `RATE_COVERAGE.createInvite` reasons that the
  // bound that matters is MAX_OPEN_INVITES, "which bounds what volume here could actually buy —
  // redeemable memberships, not table rows". True. It also means one hostile member can occupy
  // every slot in a loop and the honest admin cannot mint the invite she wanted to send.
  const mine = [];
  for (let i = 0; i < MAX_OPEN_INVITES; i++) mine.push(await mintInvite(srv, honest, spaceId));
  const got = await expectFail(() => srv.call(admin, 'POST', '/invites', {}, {
    spaceId, inviteId: b64u(rnd(16)), verifier: b64u(rnd(32)),
  }), 400, 'bad_request', 'the 21st open invite');
  assert.equal(got.extra.reason, 'too_many_open');
  assert.equal(got.extra.open, MAX_OPEN_INVITES);

  // Twenty live, redeemable memberships is also the real cost: each of those codes is a way in
  // for anyone the attacker chooses.
  assert.equal((await srv.store.listOpenInvites(spaceId)).length, MAX_OPEN_INVITES);

  // Reversible, and by ANY member: `revokeInvite` is not restricted to the issuer. That is the
  // same missing role check as §D's removal, pointed the other way — and here it is what makes
  // the grief recoverable rather than permanent.
  for (const inv of mine) {
    assert.equal((await srv.call(admin, 'POST', '/invites/revoke', {}, {
      spaceId, inviteId: inv.inviteId,
    })).body.state, 'revoked');
  }
  assert.equal((await srv.store.listOpenInvites(spaceId)).length, 0);
  assert.equal((await srv.call(admin, 'POST', '/invites', {}, {
    spaceId, inviteId: b64u(rnd(16)), verifier: b64u(rnd(32)),
  })).status, 200);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §D THE WIRE GAP — INVERTED 2026-08-29.  Findings E2E3-1 … E2E3-7.
//
// The row that stood here proved the seam did not meet, and it was right about every clause:
//
//   > `assert.deepEqual(MODEL_COLUMNS.KeyWrap, ['spaceId','epoch','recipientId','wrapped'])`
//   > `assert.equal(r.senderKexPubRaw, undefined, 'the receiving-side S1 check has no input')`
//   > `assert.equal(d.attestation, undefined, 'the relay publishes no attestation — E2-207-B')`
//   > `assert.throws(() => familyRecipients(roster…), /has no attestation blob/,
//   >   'the recipient set is buildable from the wire — it is not')`
//   > "Both positions are defensible. Together they are a rotation nobody can build."
//   > "Left as a test so the day someone adds `senderKexPubRaw` to the schema, the first two
//   >  assertions here are what tells them the other three lines exist."
//
// This is that day. Every one of those assertions is inverted below, in place, and the row is
// now what it was written to become: a REAL family key rotation, end to end, over the real
// router, with real ECDH wraps that really open on the other Mac.
//
// ⚠ THE THING THIS ROW EXISTS TO PREVENT, AND IT IS NOT A FIELD CHECK. `server/dev/two-client.js`
// ran a "working" rotation across this same seam for weeks by hand-rolling `packWrap` and
// carrying the sender's public key BY COURIER — its own comment says "STAND-IN: the wire carries
// no attestation". So this test may use NO courier: every value the second Mac uses to admit a
// key must have arrived in an HTTP response body, and the only functions allowed to build or
// read the wire are the shipping ones in `src/js/crypto/spacekeys.js`. If a future edit passes
// anything from `admin` to `honest` other than through `srv.call`, this row has stopped testing
// what it is for.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§D THE WIRE MEETS — a real family rotation, end to end, no courier (E2E3-1..7)', async () => {
  const c = clock(start);
  const srv = server((k) => memoryStore({ now: k.now }), c);
  const { admin, honest, spaceId } = await family(srv);

  const sk = await import('../../src/js/crypto/spacekeys.js');

  // ── 1. The column exists, and it is a STAMPED device id rather than a client-chosen key ─────
  assert.deepEqual(MODEL_COLUMNS.KeyWrap, ['spaceId', 'epoch', 'recipientId', 'wrapped', 'senderDeviceId']);

  // …and the write side still refuses a client that tries to name the sender itself. E2E3-3's
  // decision in one assertion: the relay derives this, it does not accept it.
  await expectFail(async () => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, {
    epoch: 2,
    wraps: (await fullCoverage(srv, spaceId, 2)).map((w) => ({ ...w, senderKexPubRaw: admin.kexPubRaw })),
  }), 400, 'bad_request', 'a wrap that names its own sender');
  await expectFail(async () => srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, {
    epoch: 2,
    wraps: (await fullCoverage(srv, spaceId, 2)).map((w) => ({ ...w, senderDeviceId: admin.deviceId })),
  }), 400, 'bad_request', 'nor under the column name');

  // ── 2. THE ROSTER IS NOW A RECIPIENT SET — E2E3-6, and it is one call ───────────────────────
  const roster = (await srv.call(admin, 'GET', `/spaces/${spaceId}/members`, {}, undefined)).body.members;
  assert.equal(roster.length, 2);
  for (const m of roster) {
    assert.equal(typeof m.recoveryPubSig, 'string');
    assert.equal(typeof m.recoveryPubKex, 'string');
    for (const d of m.devices) assert.equal(typeof d.attestation, 'string', 'the blob is published — E2E3-6');
  }
  // No translation layer: the response object IS the argument. That is finding E2E3-5 closed —
  // `familyRecipients` reads `recoveryPubKex`, the name the relay actually publishes.
  const recipients = sk.familyRecipients(roster);
  assert.equal(recipients.length, 2, 'one attested device per member, and no unsigned recovery key');
  assert.deepEqual(recipients.map((r) => r.deviceId).sort(), [admin.deviceId, honest.deviceId].sort());
  const report = sk.familyRecipientsReport(roster);
  assert.deepEqual(report.missingRecoveryKex, [],
    'E2E3-5: the column was published all along; the reader was looking for the wrong name');
  assert.equal(report.recipients.every((r) => r.role === 'device'), true,
    'E2E3-8 stays open BY CHOICE: nothing signs recoveryPubKex, so nothing wraps to it');

  // Every recipient really verifies — the blob the relay handed back is the blob that was signed.
  for (const r of recipients) assert.equal(await sk.recipientProblem(r), null);

  // ── 3. ADMIN ROTATES, using only functions that ship ────────────────────────────────────────
  const ring = sk.createKeyRing();
  ring.put(spaceId, 1, await sk.createSpaceKey());
  const rotation = await sk.rotateSpace({ ring, spaceId, myKexPriv: admin.kexPriv, recipients });
  assert.equal(rotation.epoch, 2);

  const body = sk.rotationBody(rotation);
  assert.deepEqual(Object.keys(body).sort(), ['epoch', 'wraps'],
    'E2E3-4: `invites` never reaches the wire — the relay refreshes them itself');
  assert.deepEqual([...new Set(body.wraps.map((w) => Object.keys(w).sort().join(',')))],
    ['epoch,recipientId,wrapped'], 'E2E3-1 and E2E3-2: the relay\'s spelling, and bytes not objects');

  const rot = await srv.call(admin, 'POST', `/spaces/${spaceId}/epoch`, {}, body);
  assert.equal(rot.status, 200, JSON.stringify(rot.body));
  assert.equal(rot.body.currentEpoch, 2);
  assert.equal(rot.body.wrapsStored, 4, 'two members × epochs 1..2');

  // ── 4. HONEST COLLECTS, AND OPENS — the sender arrives on the wire (E2E3-3) ─────────────────
  const keys = sk.parseKeysResponse((await srv.call(honest, 'GET', `/spaces/${spaceId}/keys`, {}, undefined)).body);
  assert.equal(keys.dropped, 0);
  assert.equal(keys.keysPending, false);
  assert.equal(keys.rows.length, 2, 'epochs 1 and 2, both addressed to her device');
  for (const r of keys.rows) {
    assert.equal(r.senderKexPubRaw, admin.kexPubRaw,
      'the relay joined KeyWrap.senderDeviceId to Device.kexPubRaw — ADR 002 §4.2 step 6\'s field');
  }

  // Her sender set is built from the SAME response — not handed to her by the test.
  const hersRoster = (await srv.call(honest, 'GET', `/spaces/${spaceId}/members`, {}, undefined)).body.members;
  const hersRing = sk.createKeyRing();
  const admitted = await sk.admitWraps(hersRing, keys.rows, {
    spaceId, myKexPriv: honest.kexPriv, senders: sk.familyRecipients(hersRoster),
  });
  assert.deepEqual(admitted.admitted, [1, 2], 'BOTH epochs opened — the backfill is what A4 rests on');
  assert.equal(admitted.refused, 0);
  assert.equal(admitted.unauthorized, 0);

  // THE PROOF, and it is not a field comparison: the key she unwrapped is the key he minted.
  const mine = new Uint8Array(await S.exportKey('raw', rotation.key));
  const hers = new Uint8Array(await S.exportKey('raw', hersRing.get(spaceId, 2)));
  assert.deepEqual([...hers], [...mine], 'one FSK_2, on two Macs, over a relay that never saw it');
  assert.deepEqual(hersRing.originOf(spaceId, 2), { how: 'admitted', deviceId: admin.deviceId, memberId: admin.memberId },
    'and she can say WHICH verified device delivered it');

  // ── 5. AND THE S1 REFUSAL STILL BITES — a stranger's row is `unauthorized`, not admitted ────
  const stranger = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const strangerRaw = b64u(new Uint8Array(await S.exportKey('raw', stranger.publicKey)));
  const forged = keys.rows.map((r) => ({ ...r, senderKexPubRaw: strangerRaw }));
  const emptyRing = sk.createKeyRing();
  const got = await sk.admitWraps(emptyRing, forged, {
    spaceId, myKexPriv: honest.kexPriv, senders: sk.familyRecipients(hersRoster),
  });
  assert.deepEqual(got.admitted, []);
  assert.equal(got.unauthorized, 2, 'a relay that rewrites the sender causes a refusal, never an admission');
});
