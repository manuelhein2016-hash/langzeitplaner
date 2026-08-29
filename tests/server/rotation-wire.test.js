// tests/server/rotation-wire.test.js — the enumerated rotation wire, walked against live code.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `_rotation-wire-domain.js` enumerates every field of the rotation wire at every station it
// passes through. This walks that table and asserts each row against the REAL handlers and the
// REAL `src/js/crypto/spacekeys.js` — no fixtures standing in for either side, and in particular
// no value crossing from one client to the other except through an HTTP response body.
//
// It is deliberately NOT a list of six regression tests for six mismatches. Round 7's lesson is
// that a fix which names branches gets relocated by the next adversary, so the assertions here
// are over the DOMAIN: every row must be decided, every deviation must name a documented
// finding, and the split between "fixed" and "open" must be visible rather than argued. If
// someone adds a seventh field to this wire and does not add it to the table, §1 fails.
//
// The end-to-end rotation itself lives in `attack-client-lifecycle.test.js` §D — that row was
// the adversary's "THE WIRE GAP" and was inverted in place rather than duplicated here.
// ═════════════════════════════════════════════════════════════════════════════════════════════

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandlers } from '../../server/core/handlers/index.js';
import { authenticate, assertMember, b64u } from '../../server/core/auth.js';
import { LIMITS, createLog } from '../../server/core/limits.js';
import { memoryStore } from '../../server/adapters/memory.js';
import { MODEL_COLUMNS, PLAINTEXT_STRINGS, OPAQUE_FIELDS } from '../../server/core/store-interface.js';
import { requiredRecipients, knownRecipients } from '../../server/core/handlers/spaces.js';
import { DEVICE_PROJECTION, MEMBER_PROJECTION } from '../../server/core/handlers/members.js';
import * as sk from '../../src/js/crypto/spacekeys.js';
import {
  DOMAINS, DOMAIN_SIZES, OPEN_FINDINGS, STATIONS, W1, W2, W3, W4,
} from './_rotation-wire-domain.js';
import { attestedPerson, deviceWire, memberWire, rnd } from './_attested-person.js';

const S = globalThis.crypto.subtle;
const TE = new TextEncoder();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The harness — the real router, the real auth ladder, one in-memory relay
// ─────────────────────────────────────────────────────────────────────────────────────────────

function clock(start) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

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
    headers: { 'x-lzp-protocol': '1', authorization: `LZP1 device=${p.deviceShort}, ts=${ts}, nonce=${nonce}, sig=${sig}` },
    body: body === undefined ? null : JSON.parse(new TextDecoder().decode(rawBody)),
    rawBody,
    clientIp: '198.51.100.9',
  };
}

function relay() {
  const c = clock(1787900000000);
  const store = memoryStore({ now: c.now });
  const route = createHandlers();
  const ctx = {
    store,
    now: () => c.now(),
    random: (n) => rnd(n),
    sha256: async (b) => new Uint8Array(await S.digest('SHA-256', b)),
    auth: (req) => authenticate(req, ctx),
    assertMember: (memberId, spaceId) => assertMember(memberId, spaceId, ctx),
    log: createLog(() => {}),
    limits: LIMITS,
  };
  const call = async (p, method, urlPath, query, body) => {
    let res;
    try {
      res = await route(ctx, await signedReq(p, method, urlPath, query, body, c.now()));
    } catch (e) {
      res = { status: e.status, body: { error: e.code, ...(e.extra || {}) } };
    }
    c.advance(1);
    return res;
  };
  return { store, ctx, call, c };
}

/**
 * A family of two, created and joined through the real endpoints, with epoch-1 wraps built by
 * `spacekeys.js` and no courier anywhere.
 */
async function family() {
  const srv = relay();
  const admin = await attestedPerson({ colorRef: 'gruen' });
  const honest = await attestedPerson({ colorRef: 'blau' });
  const spaceId = `fsp_${b64u(rnd(16))}`;

  // The founder wraps epoch 1 to her own device, with the shipping wrapper — so the very first
  // bytes in `KeyWrap.wrapped` are a real `WrapBlob`, not 156 bytes of noise.
  const ring = sk.createKeyRing();
  const key = await sk.createSpaceKey();
  ring.put(spaceId, 1, key);
  // `familyRecipients`, not `personalRecipients` — barrier 2 refuses a personal recipient for an
  // `fsp_` key by construction, and the founder's own record is a one-entry family roster in
  // exactly the shape `GET /members` will publish it in a moment.
  const mine = sk.familyRecipients([{
    memberId: admin.memberId,
    recoveryPubSig: admin.recoveryPubSig,
    recoveryPubKex: admin.recoveryPubKex,
    removedAt: null,
    devices: [{ deviceId: admin.deviceId, kexPubRaw: admin.kexPubRaw, attestation: admin.attestation, revokedAt: null }],
  }]);
  const wraps = sk.createSpaceWraps(await sk.wrapToRecipients(key, admin.kexPriv, mine, { spaceId, epoch: 1 }));

  const created = await srv.call(admin, 'POST', '/spaces', {}, {
    spaceId, kind: 'FAMILY', colorRef: admin.colorRef,
    member: memberWire(admin), device: deviceWire(admin), wraps,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  const code = b64u(rnd(8));
  const proof = new Uint8Array(await S.digest('SHA-256', TE.encode(`verify|${code}`)));
  const verifier = new Uint8Array(await S.digest('SHA-256', proof));
  const inviteId = b64u(new Uint8Array(await S.digest('SHA-256', TE.encode(`id|${code}`))).subarray(0, 16));
  assert.equal((await srv.call(admin, 'POST', '/invites', {}, { spaceId, inviteId, verifier: b64u(verifier) })).status, 200);
  const joined = await srv.call(honest, 'POST', '/invites/redeem', {}, {
    inviteId, proof: b64u(proof), colorRef: honest.colorRef,
    member: memberWire(honest), device: deviceWire(honest),
  });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));

  return { srv, admin, honest, spaceId, ring };
}

/** Everything a rotation needs, built the way a Mac builds it. */
async function rotate(f, mover) {
  const roster = (await f.srv.call(mover, 'GET', `/spaces/${f.spaceId}/members`, {}, undefined)).body.members;
  const rotation = await sk.rotateSpace({
    ring: f.ring, spaceId: f.spaceId, myKexPriv: mover.kexPriv, recipients: sk.familyRecipients(roster),
  });
  const body = sk.rotationBody(rotation);
  const res = await f.srv.call(mover, 'POST', `/spaces/${f.spaceId}/epoch`, {}, body);
  return { roster, rotation, body, res };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1  THE DOMAIN IS WELL FORMED — before a single field is checked
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§1 the domain is intact: every row is complete, uniquely named, and counted', () => {
  const seen = new Set();
  let rows = 0;
  for (const [name, d] of Object.entries(DOMAINS)) {
    assert.equal(d.entries.length, DOMAIN_SIZES[name], `${name}: the table was truncated or grew`);
    for (const e of d.entries) {
      assert.equal(typeof e.id, 'string');
      assert.equal(seen.has(e.id), false, `duplicate row id ${e.id}`);
      seen.add(e.id);
      rows++;
    }
  }
  assert.equal(rows, 23, 'the wire has 23 enumerated positions');
  assert.deepEqual([...STATIONS], ['produce', 'send', 'store', 'publish', 'consume']);
});

test('§1 every deviating row NAMES a documented finding, and every finding is cited', () => {
  // The failure this catches is the one the round-5 and round-7 updates both had to correct:
  // a defect that lives only in a test file. A row that deviates and names nothing is a finding
  // the register does not know about.
  const cited = new Set();
  for (const d of Object.values(DOMAINS)) {
    for (const e of d.entries) {
      if (e.openFinding === null) {
        assert.equal(e.was, undefined, `${e.id}: it says what it USED to do but names no finding`);
        continue;
      }
      assert.ok(OPEN_FINDINGS[e.openFinding], `${e.id} cites ${e.openFinding}, which is not documented`);
      cited.add(e.openFinding);
    }
  }
  for (const id of Object.keys(OPEN_FINDINGS)) {
    assert.ok(cited.has(id), `${id} is documented and no row cites it — a finding with no domain cell`);
  }
  // Exactly one finding is still open, and it is the one that costs safety to close wrongly.
  const open = Object.entries(OPEN_FINDINGS).filter(([, v]) => v.status.startsWith('open')).map(([k]) => k);
  assert.deepEqual(open, ['E2E3-8']);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2  W1 — the rotation body.  Every row, against the live route.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§2 W1 — every field of the rotation body agrees at every station it passes', async () => {
  const f = await family();
  const { body, res } = await rotate(f, f.admin);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const byId = Object.fromEntries(W1.map((e) => [e.id, e]));

  // 'agree' rows: the client's producer and the relay's reader use the same names, and the
  // request the shipping code builds is the request the shipping relay accepts.
  assert.deepEqual(Object.keys(body).sort(), ['epoch', 'wraps']);
  assert.equal(byId.epoch.expect, 'agree');
  assert.equal(typeof body.epoch, 'number');
  for (const w of body.wraps) {
    assert.deepEqual(Object.keys(w).sort(), ['epoch', 'recipientId', 'wrapped'],
      'W1: recipientId (E2E3-1) and a base64url `wrapped` (E2E3-2)');
    assert.equal(typeof w.wrapped, 'string');
    assert.ok(sk.decodeWrap(w.wrapped), 'and it decodes back to a WrapBlob on the other side');
  }

  // 'derived': the sender is in the column, is the AUTHENTICATED device, and is not on the body.
  assert.equal(byId['wraps.senderDeviceId'].expect, 'derived');
  assert.ok(MODEL_COLUMNS.KeyWrap.includes('senderDeviceId'));
  for (const row of await f.srv.store.getKeyWraps(f.spaceId, f.honest.deviceId)) {
    assert.equal(row.senderDeviceId, f.admin.deviceId, 'the relay stamped the depositor it authenticated');
  }

  // 'refused': both spellings of a client-named sender, and the D9-retired `invites`.
  for (const [field, value] of [['senderDeviceId', f.admin.deviceId], ['senderKexPubRaw', b64u(f.admin.kexPubRaw)]]) {
    const bad = await f.srv.call(f.admin, 'POST', `/spaces/${f.spaceId}/epoch`, {}, {
      epoch: 3, wraps: body.wraps.map((w) => ({ ...w, [field]: value })),
    });
    assert.equal(bad.status, 400, `a client may not name the sender as ${field}`);
    assert.equal(bad.body.reason, 'unknown_field');
  }
  assert.equal(byId.invites.expect, 'refused');
  const withInvites = await f.srv.call(f.admin, 'POST', `/spaces/${f.spaceId}/epoch`, {}, { ...body, epoch: 3, invites: [] });
  assert.equal(withInvites.status, 400);
  assert.equal(withInvites.body.reason, 'retired_by_d9');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3  W2 — the delivery response
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3 W2 — GET /keys carries everything admitWraps requires, and nothing it must not trust', async () => {
  const f = await family();
  assert.equal((await rotate(f, f.admin)).res.status, 200);

  const raw = (await f.srv.call(f.honest, 'GET', `/spaces/${f.spaceId}/keys`, {}, undefined)).body;
  const fields = new Set(W2.map((e) => e.field.replace('wraps[].', '')));
  for (const row of raw.wraps) {
    assert.deepEqual(Object.keys(row).sort(), [...fields].sort(),
      'W2: the response shape is exactly the enumerated one');
    assert.equal(row.senderKexPubRaw, b64u(f.admin.kexPubRaw),
      'E2E3-3: ADR 002 §4.2 step 6\'s spelling, joined from Device.kexPubRaw');
  }

  const parsed = sk.parseKeysResponse(raw);
  assert.equal(parsed.dropped, 0);
  assert.deepEqual(parsed.rows.map((r) => r.epoch).sort(), [1, 2]);

  // THE PROPERTY THE COLUMN EXISTS FOR, and it is not "the field is present": a sender the
  // receiver cannot authenticate is REFUSED rather than admitted, and a relay that rewrites the
  // field can only cause that refusal. `senderKexPubRaw` selects; it never supplies.
  const roster = (await f.srv.call(f.honest, 'GET', `/spaces/${f.spaceId}/members`, {}, undefined)).body.members;
  const senders = sk.familyRecipients(roster);
  const stranger = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const strangerRaw = b64u(new Uint8Array(await S.exportKey('raw', stranger.publicKey)));
  const lied = parsed.rows.map((r) => ({ ...r, senderKexPubRaw: strangerRaw }));
  const got = await sk.admitWraps(sk.createKeyRing(), lied, { spaceId: f.spaceId, myKexPriv: f.honest.kexPriv, senders });
  assert.deepEqual(got.admitted, []);
  assert.equal(got.unauthorized, lied.length);

  // …and a row whose sender device row has been cascaded away publishes `null`, which is the
  // same refusal rather than a crash. Removing the admin's member row takes her Device with it.
  await f.srv.store.removeMember(f.admin.memberId, f.srv.c.now());
  const after = (await f.srv.call(f.honest, 'GET', `/spaces/${f.spaceId}/keys`, {}, undefined)).body;
  for (const row of after.wraps) assert.ok('senderKexPubRaw' in row);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4  W3 — the roster.  The half `members.js` used to withhold.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4 W3 — the member list IS the recipient set, with no translation step', async () => {
  const f = await family();
  const roster = (await f.srv.call(f.admin, 'GET', `/spaces/${f.spaceId}/members`, {}, undefined)).body.members;

  // The enumerated member fields and the enumerated device fields are the published ones.
  const memberFields = W3.filter((e) => e.field.startsWith('members[].')).map((e) => e.field.slice('members[].'.length));
  const deviceFields = W3.filter((e) => e.field.startsWith('devices[].')).map((e) => e.field.slice('devices[].'.length));
  for (const m of roster) {
    for (const field of memberFields) assert.ok(field in m, `roster is missing ${field}`);
    for (const d of m.devices) for (const field of deviceFields) assert.ok(field in d, `device is missing ${field}`);
  }
  // The domain enumerates the fields the ROTATION consumes; the projections additionally carry
  // `colorRef`, `joinedAt`, `devices`, `deviceShort` and `sigPubRaw`, which story 15.4's member
  // list needs and no rotation reads. Every published field must be in one of those two sets —
  // a field in neither is a field nobody classified.
  const ROSTER_ONLY = ['colorRef', 'joinedAt', 'devices', 'deviceShort', 'sigPubRaw'];
  for (const f of MEMBER_PROJECTION) {
    assert.ok(memberFields.includes(f) || ROSTER_ONLY.includes(f), `member field ${f} is in no set`);
  }
  for (const f of DEVICE_PROJECTION) {
    assert.ok(deviceFields.includes(f) || ROSTER_ONLY.includes(f), `device field ${f} is in no set`);
  }
  for (const f of [...memberFields, ...deviceFields]) {
    assert.ok(MEMBER_PROJECTION.includes(f) || DEVICE_PROJECTION.includes(f),
      `the domain claims ${f} is published and no projection carries it`);
  }

  // THE ROW THAT WAS THE SEAM: the response object goes straight in.
  const recipients = sk.familyRecipients(roster);
  assert.equal(recipients.length, 2);
  for (const r of recipients) assert.equal(await sk.recipientProblem(r), null);
  assert.deepEqual(sk.familyRecipientsReport(roster).missingRecoveryKex, [],
    'E2E3-5: `recoveryPubKex`, the name the relay publishes');

  // And the hint is never authority: a relay that swaps a blob is caught by the signature.
  const tampered = roster.map((m, i) => (i === 0 ? {
    ...m, devices: m.devices.map((d) => ({ ...d, attestation: roster[1].devices[0].attestation })),
  } : m));
  const problems = await Promise.all(sk.familyRecipients(tampered).map((r) => sk.recipientProblem(r)));
  assert.ok(problems.some((p) => p !== null), 'a swapped blob does not verify under its housing member');
});

test('§4 W3 — one spelling of `device.attestation` on every write path (E2E3-7)', async () => {
  const f = await family();
  for (const d of await f.srv.store.listDevices(f.spaceId)) {
    const asText = new TextDecoder().decode(d.attestation);
    assert.match(asText, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      'the column holds UTF-8 of the blob string — the `POST /devices` contract, everywhere');
  }
  // …and it survives publication byte for byte, which it must: the client verifies a signature
  // over exactly these bytes.
  const roster = (await f.srv.call(f.admin, 'GET', `/spaces/${f.spaceId}/members`, {}, undefined)).body.members;
  const published = roster.flatMap((m) => m.devices.map((d) => d.attestation)).sort();
  const stored = (await f.srv.store.listDevices(f.spaceId)).map((d) => new TextDecoder().decode(d.attestation)).sort();
  assert.deepEqual(published, stored);

  // The column is still OPAQUE: the relay stores bytes and interprets nothing but the signature.
  assert.ok(OPAQUE_FIELDS.Device.includes('attestation'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5  W4 — the coverage obligation.  The one row this pass leaves open on purpose.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§5 W4 — every coverage cell is required exactly where it is producible', async () => {
  const members = [{ id: 'mem_a', removedAt: null }];
  const devices = [{ id: 'dev_a1', memberId: 'mem_a', revokedAt: null }];
  const cell = Object.fromEntries(W4.map((e) => [e.id, e]));

  const personal = requiredRecipients(members, devices, 'PERSONAL');
  const familyReq = requiredRecipients(members, devices, 'FAMILY');

  assert.equal(personal.includes('dev_a1'), cell['cover.personal.device'].expect.required);
  assert.equal(personal.includes('rec_mem_a'), cell['cover.personal.recovery'].expect.required);
  assert.equal(familyReq.includes('dev_a1'), cell['cover.family.device'].expect.required);
  assert.equal(familyReq.includes('rec_mem_a'), cell['cover.family.recovery'].expect.required);

  // 'suspended', not 'banned' — the distinction is the whole of the disposition. A family
  // recovery wrap is still a KNOWN recipient, so the day the binding exists no relay change is
  // needed; what is gone is the demand no client could discharge.
  assert.equal(cell['cover.family.recovery'].disposition, 'suspended');
  assert.equal(knownRecipients(members, devices).has('rec_mem_a'), true);

  // And the client side refuses to produce it, by name, so the gap cannot be closed the cheap
  // way — which would wrap FSK to an unsigned relay column.
  const f = await family();
  const roster = (await f.srv.call(f.admin, 'GET', `/spaces/${f.spaceId}/members`, {}, undefined)).body.members;
  const device = sk.familyRecipients(roster)[0];
  assert.equal(cell['cover.family.recovery'].expect.producible, false);
  const asRecovery = Object.create(device, {
    role: { value: 'recovery', enumerable: true },
    deviceId: { value: `rec_${roster[0].memberId}`, enumerable: true },
  });
  assert.equal(sk.recipientScope(asRecovery), 'family');
  assert.match(await sk.recipientProblem(asRecovery), /REFUSING a family recovery recipient/);

  // The personal one is produced, and is sound, because the key never came off a relay.
  const me = sk.personalRecipients({
    memberId: f.admin.memberId,
    recoverySigPubRaw: f.admin.recoveryPubSig,
    recoveryKexPubRaw: f.admin.recoveryPubKex,
    devices: [{
      deviceId: f.admin.deviceId, memberId: f.admin.memberId,
      kexPubRaw: f.admin.kexPubRaw, attestation: f.admin.attestation,
    }],
  });
  const rec = me.find((r) => r.role === 'recovery');
  assert.ok(rec, 'personalRecipients builds it');
  assert.equal(await sk.recipientProblem(rec), null, 'and it verifies, because it is my own key');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6  THE METADATA LEDGER — a new column is a new sentence in the Datenschutz copy, or it is not
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§6 the one column this pass added is classified, and it carries no client-chosen bits', async () => {
  assert.ok(PLAINTEXT_STRINGS['KeyWrap.senderDeviceId'], 'ADR 003 §5.2 inventories every readable String');
  assert.match(PLAINTEXT_STRINGS['KeyWrap.senderDeviceId'], /Stamped by the relay/);

  // The proof that it is not a channel: two rotations of the same shape by the same device
  // produce the same value, and the client has no way to influence it — `readWraps` refuses the
  // field under either name (§2), and the value can only ever be a device id of this space.
  const f = await family();
  assert.equal((await rotate(f, f.admin)).res.status, 200);
  const stored = await f.srv.store.getKeyWraps(f.spaceId, f.honest.deviceId);
  assert.ok(stored.length > 0);
  const devices = new Set((await f.srv.store.listDevices(f.spaceId)).map((d) => d.id));
  for (const row of stored) {
    assert.ok(devices.has(row.senderDeviceId),
      'a sender is always a device of this space — the relay authenticated it to accept the request');
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7  W3.roster.attestation.encoding — the half `readDevice` CANNOT do, and `POST /spaces`
//     used to skip entirely.  Finding E2E3-7.
//
// `readDevice` is shared with `POST /invites/redeem`, which calls it synchronously, so it can
// only enforce the part of ADR 002 §2.3 that needs no key: the blob parses, its field set is
// closed, and it describes the device it arrived with. THREE checks are left, all of them
// asynchronous, all of them the ones `POST /devices` has always run — and `POST /spaces` ran
// none of them, which is the whole of finding E2E3-7:
//
//   P2  `deviceShort === crock32(SHA-256(sigPubRaw)[0..10])`   (ADR 001 §1.2)
//   S1  the blob verifies under the HOUSING member's `recoveryPubSig`
//   S2  `att.memberId` is the member this request creates — the clause `readDevice` cannot make,
//       because it is handed a device and not a member
//
// Without them, a founder can plant a blob nothing verifies. That is not a self-inflicted wound:
// `familyRecipients()` THROWS on a device whose attestation does not verify, so the space could
// never build a recipient set and could never rotate again — a wedge with no route out, created
// by the one request that establishes the space.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Sign an arbitrary payload as an attestation blob. Deliberately NOT `attestDevice`: these are
 *  blobs `attestDevice` refuses to mint, which is exactly why the relay must refuse them too. */
async function forgedBlob(payload, recPriv) {
  const bytes = TE.encode(JSON.stringify(payload));
  const sig = new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, recPriv, bytes));
  return `${b64u(bytes)}.${b64u(sig)}`;
}

test('§7 POST /spaces runs P2, S1 and S2 — the three checks readDevice cannot (E2E3-7)', async () => {
  const srv = relay();
  const p = await attestedPerson({ colorRef: 'gruen' });
  const stranger = await attestedPerson({ colorRef: 'blau' });
  const spaceId = `fsp_${b64u(rnd(16))}`;
  const wraps = [{ recipientId: p.deviceId, epoch: 1, wrapped: b64u(rnd(156)) }];
  const create = (device, member = memberWire(p)) => srv.call(p, 'POST', '/spaces', {}, {
    spaceId: `fsp_${b64u(rnd(16))}`, kind: 'FAMILY', colorRef: 'gruen', member, device, wraps,
  });

  // The control: the honest body is accepted, so a refusal below is about the mutation and not
  // about the fixture.
  assert.equal((await srv.call(p, 'POST', '/spaces', {}, {
    spaceId, kind: 'FAMILY', colorRef: 'gruen', member: memberWire(p), device: deviceWire(p), wraps,
  })).status, 200);

  // ── S1 — signed by SOMEBODY ELSE'S recovery key ────────────────────────────────────────────
  // Self-consistent in every field, so `readDevice` waves it through; it is `verifyDeviceClaim`
  // that has the member's public key to check it against.
  const wrongSigner = await forgedBlob({
    memberId: p.memberId, deviceId: p.deviceId, deviceShort: p.deviceShort,
    sigPubRaw: p.sigPubRawB64, kexPubRaw: p.kexPubRawB64, createdAt: '2026-08-29',
  }, stranger.recPriv);
  const s1 = await create({ ...deviceWire(p), attestation: wrongSigner });
  assert.equal(s1.status, 401, JSON.stringify(s1.body));
  assert.equal(s1.body.check, 'attestation_signature');

  // ── S2 — the blob names a DIFFERENT member than the one being created ──────────────────────
  const wrongMember = await forgedBlob({
    memberId: stranger.memberId, deviceId: p.deviceId, deviceShort: p.deviceShort,
    sigPubRaw: p.sigPubRawB64, kexPubRaw: p.kexPubRawB64, createdAt: '2026-08-29',
  }, p.recPriv);
  const s2 = await create({ ...deviceWire(p), attestation: wrongMember });
  assert.equal(s2.status, 401, JSON.stringify(s2.body));
  assert.equal(s2.body.check, 'attestation_memberId');

  // ── P2 — a `deviceShort` that is not the short of the signing key ──────────────────────────
  // The body and the blob AGREE on the false short, so every check `readDevice` can make passes.
  // Only re-deriving the short from `sigPubRaw` catches it — and P2 is what makes `env.dv`
  // self-certifying, which is what `openOp` selects a verification key with (ADR 002 §5.2.2).
  const liedShort = 'ZZZZZZZZZZZZZZZZ';
  const wrongShort = await forgedBlob({
    memberId: p.memberId, deviceId: p.deviceId, deviceShort: liedShort,
    sigPubRaw: p.sigPubRawB64, kexPubRaw: p.kexPubRawB64, createdAt: '2026-08-29',
  }, p.recPriv);
  const p2 = await create({ ...deviceWire(p), deviceShort: liedShort, attestation: wrongShort });
  assert.equal(p2.status, 400, JSON.stringify(p2.body));
  assert.equal(p2.body.check, 'deviceShort');
  assert.equal(p2.body.reason, 'not_derived_from_sigPubRaw');

  // …and nothing was written by any of the three.
  assert.equal((await srv.store.listMembers(spaceId)).length, 1, 'only the honest control exists');
});
