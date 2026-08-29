// server/dev/two-client.js — the client half of the E2 headline demonstration.  LZP-207.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS REAL HERE, AND WHAT IS STOOD IN FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// REAL, and this is the whole point of the file:
//   · every request is a genuine ADR 003 §2 signed request — `lzp/v2\n` + method + path + '?' +
//     sorted query + b64u(SHA-256(rawBody)) + ts + nonce, signed ECDSA P-256/SHA-256 over the
//     RAW body bytes, carried in an `LZP1` Authorization header;
//   · the server on the other end is `node server/dev-server.mjs`, running `core/router.js`,
//     `core/handlers/index.js` and all 23 handlers over `adapters/file.js`;
//   · the crypto is `src/js/crypto/identity.js`, `spacekeys.js` and `envelope.js`, imported from
//     the repository UNMODIFIED — `sealOp` and `openOp` are the shipped functions, not a
//     re-implementation, and the epoch keys really are ECDH-wrapped per recipient;
//   · the two tabs are two independent JavaScript realms with two independent key pairs. Neither
//     ever holds the other's private key, and the relay never holds either.
//
// STOOD IN FOR, named here so the verification document can be honest about it:
//
//   1. **The invitation email.** A `localStorage` key carries `{spaceId, code}` from tab A to
//      tab B. In the product that hop is the email of deliverable 28 (story 15.2) and the code
//      is typed by a human. It is out-of-band BY DESIGN — the server never sees the code, only
//      HKDF derivations of it — so a same-origin courier is a faithful stand-in for the channel,
//      not a shortcut past a control.
//
//   2. **The attestation hop, and this one IS a gap.** `openOp` resolves the sender's signing key
//      from a VERIFIED device attestation (ADR 002 §5.2.1), and **no endpoint on this server
//      returns one**: `Device.attestation` is written by `POST /spaces`, `POST /invites/redeem`
//      and `POST /devices`, and is read back by nothing — `handlers/members.js` withholds it on
//      purpose, and `memberProjection` has no field for it. ADR 002 §4.4's "bootstrap residual"
//      says the joiner's roster comes from "relay coordination data (`MemberRowDb.recoveryPubSig`
//      plus the `dev.*` blobs)"; §2.3's "What is not closed" says the opposite, that the in-stream
//      path cannot bootstrap itself and "§2.3's device panel and the pairing flow — not the fold —
//      have to deliver a first attestation. Owner: WP-9."
//      Both cannot be satisfied by what E2 shipped. So this demonstration carries the attestation
//      over the same courier and SAYS SO on screen, rather than pretending the wire carried it.
//      Recorded as finding **E2-207-B** in `docs/v2/E2-VERIFICATION.md`.
//
// Nothing else is simulated. In particular the key delivery is NOT: B genuinely cannot read a
// single byte until an existing member device has wrapped an epoch key to B's public key and
// posted it — decision D9, working, over HTTP, in front of you.

import { b64u, ub64 } from '/src/js/core/b64.js';
import * as ids from '/src/js/core/ids.js';
import { fmt } from '/src/js/core/stamp.js';
import * as identity from '/src/js/crypto/identity.js';
import * as spacekeys from '/src/js/crypto/spacekeys.js';
import * as envelope from '/src/js/crypto/envelope.js';
import { INFO } from '/src/js/crypto/suite.js';
import { memKeyStore } from '/src/js/platform/keystore.js';

const S = globalThis.crypto.subtle;
const TE = new TextEncoder();
const rnd = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROLE = new URL(location.href).searchParams.get('role') === 'B' ? 'B' : 'A';
const NAME = ROLE === 'A' ? 'Papa' : 'Mama';
const COLOR = ROLE === 'A' ? 'gruen' : 'blau';

// ─────────────────────────────────────────────────────────────────────────────
// The out-of-band courier — stand-in 1 and 2 above. Deliberately the ONLY channel
// between the tabs other than the relay, so anything that crosses it is visible here.
// ─────────────────────────────────────────────────────────────────────────────

const COURIER = 'lzp-e2-demo-courier';
const courierRead = () => { try { return JSON.parse(localStorage.getItem(COURIER) || '{}'); } catch { return {}; } };
const courierWrite = (patch) => localStorage.setItem(COURIER, JSON.stringify({ ...courierRead(), ...patch }));
async function courierWait(key, label) {
  for (let i = 0; i < 600; i++) {
    const v = courierRead()[key];
    if (v !== undefined && v !== null) return v;
    if (i === 0) step(`waiting for ${label} (out-of-band)`, 'dim');
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The wire — ADR 003 §2, by hand, because there is no sync client yet (that is E5)
// ─────────────────────────────────────────────────────────────────────────────

const BASE = '/api/v1';
let calls = 0;

async function signed(who, method, path, query, body) {
  const rawBody = body === undefined ? new Uint8Array(0) : TE.encode(JSON.stringify(body));
  const qs = Object.keys(query || {}).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
  const bodyHash = b64u(new Uint8Array(await S.digest('SHA-256', rawBody)));
  const ts = String(Date.now());
  const nonce = b64u(rnd(16));
  const full = BASE + path;
  const toSign = `lzp/v2\n${method.toUpperCase()}\n${full}?${qs}\n${bodyHash}\n${ts}\n${nonce}`;
  const sig = b64u(new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, who.sigPriv, TE.encode(toSign))));
  const res = await fetch(full + (qs ? `?${qs}` : ''), {
    method,
    headers: {
      'x-lzp-protocol': '1',
      authorization: `LZP1 device=${who.dv}, ts=${ts}, nonce=${nonce}, sig=${sig}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: rawBody }),
  });
  calls++;
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, proto: res.headers.get('X-LZP-Protocol') };
}

function must(r, what) {
  if (r.status !== 200) throw new Error(`${what} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// ─────────────────────────────────────────────────────────────────────────────
// This tab's identity — one member, one attested device, keys generated HERE
// ─────────────────────────────────────────────────────────────────────────────

async function mint() {
  const ks = memKeyStore();
  const memberId = ids.memberId();
  const deviceId = ids.deviceId();
  const day = new Date().toISOString().slice(0, 10);
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: day });
  const dev = await identity.ensureAttestedDevice(ks, memberId, rec.recSig.privateKey, { deviceId, createdAt: day });
  const raw = async (k) => new Uint8Array(await S.exportKey('raw', k));
  return {
    memberId, deviceId,
    dv: dev.attestation.deviceShort,
    att: dev.attestation,
    blob: dev.blob,
    sigPriv: dev.identity.devSig.privateKey,
    kexPriv: dev.identity.devKex.privateKey,
    sigPubRaw: b64u(await raw(dev.identity.devSig.publicKey)),
    kexPubRaw: b64u(await raw(dev.identity.devKex.publicKey)),
    recKexPubRaw: b64u(await raw(rec.recKex.publicKey)),
    recSigPubRaw: b64u(await raw(rec.recSig.publicKey)),
    keys: new Map(),
  };
}

const wireDevice = (c) => ({
  deviceId: c.deviceId, deviceShort: c.dv,
  sigPubRaw: c.sigPubRaw, kexPubRaw: c.kexPubRaw, attestation: b64u(TE.encode(c.blob)),
});
const wireMember = (c) => ({
  memberId: c.memberId, recoveryPubSig: c.recSigPubRaw, recoveryPubKex: c.recKexPubRaw,
});
const ringOf = (c, spaceId) => ({ get: (sp, ep) => (sp === spaceId ? c.keys.get(ep) || null : null) });

/** A wrap blob is `{v,salt,iv,ct}`; the `KeyWrap.wrapped` column is opaque BYTES. */
const packWrap = (blob) => b64u(TE.encode(JSON.stringify(blob)));
const unpackWrap = (s) => JSON.parse(new TextDecoder().decode(ub64(s)));

/** ADR 002 §7.1 — the code never leaves the client; the server sees two HKDF derivations. */
async function deriveInvite(code) {
  const hk = await S.importKey('raw', TE.encode(code), 'HKDF', false, ['deriveBits']);
  const bits = async (label, n) => new Uint8Array(await S.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: TE.encode(label) }, hk, n * 8));
  const proof = await bits(INFO.inviteVerify, 32);
  return {
    inviteId: b64u(await bits(INFO.inviteId, 16)),
    proof,
    verifier: new Uint8Array(await S.digest('SHA-256', proof)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

const $log = document.getElementById('log');
let n = 0;
function step(text, cls) {
  n++;
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<div class="n">${n}</div><div class="t ${cls || ''}"></div>`;
  row.lastElementChild.textContent = text;
  $log.append(row);
  row.scrollIntoView({ block: 'nearest' });
}
const verdict = (text, cls) => {
  const v = document.getElementById('verdict');
  v.textContent = text;
  v.className = cls || '';
};

// ─────────────────────────────────────────────────────────────────────────────
// A — Papa. Creates the circle, invites, rotates the key to the joiner, publishes.
// ─────────────────────────────────────────────────────────────────────────────

async function runA(me) {
  const spaceId = ids.spaceId('family');
  const k1 = await spacekeys.createSpaceKey();
  me.keys.set(1, k1);

  const wrapTo = async (key, epoch, pubRawB64u) => packWrap(await spacekeys.wrapSpaceKey(
    key, me.kexPriv, await identity.importKexPublic(ub64(pubRawB64u)), { spaceId, epoch }));

  step(`POST /spaces  — creating ${spaceId} with epoch-1 wraps to my device and my recovery key`);
  const created = must(await signed(me, 'POST', '/spaces', {}, {
    spaceId, kind: 'FAMILY', colorRef: COLOR,
    member: wireMember(me), device: wireDevice(me),
    wraps: [
      { recipientId: me.deviceId, epoch: 1, wrapped: await wrapTo(k1, 1, me.kexPubRaw) },
      { recipientId: `rec_${me.memberId}`, epoch: 1, wrapped: await wrapTo(k1, 1, me.recKexPubRaw) },
    ],
  }), 'POST /spaces');
  step(`  200 · epoch ${created.currentEpoch} · ${created.memberCount} member`, 'ok');

  const op = (kind, e, f, ctr, ep) => ({
    op: {
      v: 1, id: ids.opId(), ts: fmt(Date.now(), ctr, me.dv), space: spaceId,
      act: me.memberId, dev: me.deviceId, gid: ids.groupId(), k: kind, e, f,
    },
    ep,
  });
  const push = async (specs, note) => {
    const envs = [];
    for (const { op: o, ep } of specs) {
      envs.push(await envelope.sealOp(o, ringOf(me, spaceId), me.sigPriv,
        { v: 1, sp: spaceId, ep, dv: me.dv, oid: o.id, wit: '' }, { attestation: me.att }));
    }
    step(`sealOp × ${envs.length} — ${note}`);
    step(`POST /ops — pushing ${envs.length} envelope(s) (iv‖ct‖sig; the relay copies, never reads)`);
    const r = must(await signed(me, 'POST', '/ops', {}, { space: spaceId, ops: envs }), 'push');
    step(`  200 · accepted ${r.accepted.length} · spaceSeq ${r.spaceSeq}`, 'ok');
    return r;
  };

  // Written BEFORE B exists, under epoch 1. ADR 002 §4.3 / risk R11 / story A4: the joiner is
  // granted epochs 1..e+1 precisely so that this op still renders for her. B's blind pull below
  // is blind about THIS envelope.
  await push([op('space.set', `space:${spaceId}`,
    { name: 'Familie Hein', admin: me.memberId, adminPrev: null, epoch: 1 }, 0, 1)],
  'plaintext: space name "Familie Hein", under epoch 1, before B exists');

  const code = b64u(rnd(8));
  const inv = await deriveInvite(code);
  step('POST /invites — the code stays here; the server gets HKDF(code,"…/id") and SHA-256(HKDF(code,"…/verify"))');
  const made = must(await signed(me, 'POST', '/invites', {}, {
    spaceId, inviteId: inv.inviteId, verifier: b64u(inv.verifier),
  }), 'POST /invites');
  step(`  200 · inviteId ${made.inviteId} · epoch ${made.epoch} · expires ${made.expiresAt.slice(0, 10)}`, 'ok');

  courierWrite({ spaceId, code, attA: me.att, dvA: me.dv });
  step('courier ← {spaceId, code}   (stand-in for the invitation email, story 15.2)', 'dim');
  step('courier ← attestation(A)    (STAND-IN: no endpoint returns one — finding E2-207-B)', 'dim');

  const joinedMemberId = await courierWait('joined', 'B to redeem the invite');
  step(`B redeemed as ${joinedMemberId}`, 'ok');

  step(`GET /spaces/${spaceId}/members — reading the roster the relay publishes`);
  const roster = must(await signed(me, 'GET', `/spaces/${spaceId}/members`, {}), 'GET members');
  const bm = roster.members.find((m) => m.memberId === joinedMemberId);
  step(`  200 · ${roster.members.length} members · B has ${bm.devices.length} device, kexPubRaw ${bm.devices[0].kexPubRaw.slice(0, 12)}…`, 'ok');

  const k2 = await spacekeys.createSpaceKey();
  me.keys.set(2, k2);
  const recipients = [
    [me.deviceId, me.kexPubRaw], [`rec_${me.memberId}`, me.recKexPubRaw],
    [bm.devices[0].deviceId, bm.devices[0].kexPubRaw], [`rec_${bm.memberId}`, bm.recoveryPubKex],
  ];
  const wraps = [];
  for (const [rid, pub] of recipients) {
    for (const [epoch, key] of [[1, k1], [2, k2]]) {
      wraps.push({ recipientId: rid, epoch, wrapped: await wrapTo(key, epoch, pub) });
    }
  }
  step(`POST /spaces/${spaceId}/epoch — rotating to 2 with ${wraps.length} wraps (D9: THIS is where B's key comes from)`);
  const rot = must(await signed(me, 'POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps }), 'rotate');
  step(`  200 · currentEpoch ${rot.currentEpoch} · wrapsStored ${rot.wrapsStored} · the server ran the coverage check`, 'ok');
  courierWrite({ rotated: 2 });

  const second = await push([op('member.set', `member:${me.memberId}`,
    { displayName: NAME, colorRef: COLOR, [`dev.${me.dv}`]: b64u(TE.encode(me.blob)) }, 0, 2)],
  `plaintext: displayName "${NAME}", under the NEW epoch 2`);
  courierWrite({ pushed: second.spaceSeq });

  const read = await courierWait('bRead', 'B to report what it read');
  verdict(
    `A: sealed "Familie Hein" under epoch 1 (before B existed) and "${NAME}" under epoch 2,\n`
    + `in ${calls} signed requests.\n`
    + `B, in the other tab, opened BOTH and read: ${JSON.stringify(read)}\n`
    + 'Neither tab ever held the other\'s private key. The relay holds neither.',
    'ok');
}

// ─────────────────────────────────────────────────────────────────────────────
// B — Mama. Joins with the code, waits for a key, then reads the board.
// ─────────────────────────────────────────────────────────────────────────────

async function runB(me) {
  const spaceId = await courierWait('spaceId', 'A to create the circle');
  const code = courierRead().code;
  const inv = await deriveInvite(code);
  step(`courier → {spaceId ${spaceId}, code}   (stand-in for the invitation email)`, 'dim');

  step('POST /invites/redeem — proving I hold the code, publishing my public keys');
  const red = must(await signed(me, 'POST', '/invites/redeem', {}, {
    inviteId: inv.inviteId, proof: b64u(inv.proof), colorRef: COLOR,
    member: wireMember(me), device: wireDevice(me),
  }), 'redeem');
  step(`  200 · I am a member of ${red.spaceId} · ${red.members.length} members · pendingKeys ${red.pendingKeys}`, 'ok');
  const keyish = Object.keys(red).filter((k) => /wrap|secret|spaceKey/i.test(k));
  step(`  D9 · key material in the redemption response: ${keyish.length ? keyish.join(', ') : 'NONE'}`,
    keyish.length ? 'bad' : 'ok');
  courierWrite({ joined: me.memberId, attB: me.att, dvB: me.dv });

  step(`GET /spaces/${spaceId}/keys — before anyone has wrapped to me`);
  const before = must(await signed(me, 'GET', `/spaces/${spaceId}/keys`, {}), 'keys (early)');
  step(`  200 · wraps ${before.wraps.length} · keysPending ${before.keysPending}  ← D9's designed waiting state (19.3)`,
    before.keysPending ? 'ok' : 'bad');

  step('GET /ops — I am a member, so the relay hands me the envelopes. I cannot read them.');
  const blind = must(await signed(me, 'GET', '/ops', { space: spaceId, since: '0' }), 'pull (blind)');
  let openedBlind = 0;
  for (const wire of blind.ops) {
    const out = await envelope.openOp(wire, ringOf(me, spaceId), () => null);
    if (out.op) openedBlind++;
  }
  step(`  200 · ${blind.ops.length} envelope(s) delivered, ${openedBlind} openable — no epoch key here yet`,
    blind.ops.length > 0 && openedBlind === 0 ? 'ok' : 'bad');
  step(`  ct[0] = ${blind.ops[0] ? blind.ops[0].ct.slice(0, 64) : '—'}…`, 'dim');

  let got = before;
  for (let i = 0; i < 300 && got.wraps.length === 0; i++) {
    await sleep(300);
    got = must(await signed(me, 'GET', `/spaces/${spaceId}/keys`, {}), 'keys');
  }
  step(`GET /spaces/${spaceId}/keys — A has rotated`);
  step(`  200 · ${got.wraps.length} wraps · currentEpoch ${got.currentEpoch} · keysPending ${got.keysPending}`, 'ok');

  const dvA = courierRead().dvA;
  const roster = must(await signed(me, 'GET', `/spaces/${spaceId}/members`, {}), 'GET members');
  const aDev = roster.members.flatMap((m) => m.devices).find((d) => d.deviceShort === dvA);
  const aKexPub = await identity.importKexPublic(ub64(aDev.kexPubRaw));
  for (const w of got.wraps) {
    if (w.recipientId !== me.deviceId) continue;
    const key = await spacekeys.unwrapSpaceKey(unpackWrap(w.wrapped), me.kexPriv, aKexPub, { spaceId, epoch: w.epoch });
    if (key) me.keys.set(w.epoch, key);
  }
  step(`unwrapSpaceKey with MY private ECDH key → epochs [${[...me.keys.keys()].join(', ')}] admitted`, 'ok');

  // STAND-IN 2 — see the header. `openOp` needs the sender's VERIFIED attestation and no
  // endpoint returns one (finding E2-207-B), so it comes over the courier and is labelled.
  const attA = courierRead().attA;
  step('courier → attestation(A)   (STAND-IN: the wire carries no attestation — finding E2-207-B)', 'dim');
  const attestationOf = (dv) => (dv === dvA ? attA : dv === me.dv ? me.att : null);

  await courierWait('pushed', 'A to push');
  step('GET /ops — pulling again, now that I hold a key');
  const pulled = must(await signed(me, 'GET', '/ops', { space: spaceId, since: '0' }), 'pull');
  step(`  200 · ${pulled.ops.length} envelope(s) · currentEpoch ${pulled.currentEpoch}`, 'ok');

  const read = {};
  for (const wire of pulled.ops) {
    const out = await envelope.openOp(wire, ringOf(me, spaceId), attestationOf);
    if (!out.op) { step(`  openOp ${wire.oid} (ep ${wire.ep}) → PARKED ${out.reason}`, 'bad'); continue; }
    step(`  openOp ${wire.oid} (ep ${wire.ep}) → ${out.op.k}  ${JSON.stringify(out.op.f)}`, 'ok');
    if (out.op.k === 'space.set') read.spaceName = out.op.f.name;
    if (out.op.k === 'member.set') read.displayName = out.op.f.displayName;
  }
  courierWrite({ bRead: read });
  verdict(
    `B: joined with a code the server never saw, was handed ${blind.ops.length} envelope(s) it could not read,\n`
    + "then — after A wrapped epoch keys to B's public key — opened them and read:\n"
    + `    space name  "${read.spaceName}"   (sealed under epoch 1, BEFORE B existed — ADR 002 §4.3, A4)\n`
    + `    displayName "${read.displayName}"   (sealed under epoch 2)\n`
    + `${calls} signed requests. B's private keys never left this tab.`,
    read.spaceName && read.displayName ? 'ok' : 'bad');
}

// ─────────────────────────────────────────────────────────────────────────────

const me = await mint();
document.getElementById('role').textContent = `${ROLE} · ${NAME}`;
document.getElementById('ident').textContent = `deviceShort ${me.dv} · ${me.memberId}`;
document.getElementById('start').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  if (ROLE === 'A') localStorage.removeItem(COURIER);
  try { await (ROLE === 'A' ? runA(me) : runB(me)); }
  catch (err) { step(String(err && err.message ? err.message : err), 'bad'); verdict(`FAILED: ${err}`, 'bad'); }
});
