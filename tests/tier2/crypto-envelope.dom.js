// TIER 2 · LZP-304 — the op envelope inside the REAL WKWebView.  ADR 002 §5 · ADR 004 §2.4.
//
// WHY THIS FILE EXISTS SEPARATELY FROM THE TIER-1 ONE.
// Node is a WebCrypto engine, but it is not THE engine: the shipping app runs JavaScriptCore inside
// WKWebView under the `app://localhost` scheme. Every claim ADR 002 §5 makes about "both engines" —
// that the AAD is the same bytes, that AES-256-GCM produces the same ciphertext length, that a
// tampered AAD fails, that ECDSA over `aad ‖ iv ‖ ct` interoperates — is only half-proved by
// `npm test`. This is the other half, and it runs against the same `src/` the user's Mac loads.
//
// THE CENTRE OF THIS FILE IS THE CROSS-ENGINE FIXTURE.
// `NODE_SEALED` below is a real envelope produced by `sealOp` running in Node v22, together with the
// raw AES key and the `DeviceAttestation` needed to open it. Opening it HERE proves the wire format
// is one wire format: the AAD bytes agree, the GCM tag agrees, the ECDSA signature made by Node's
// P-256 verifies under WebKit's, the 256-byte padding agrees, and `canonicalJSON` agrees. If any of
// those five drifted, a family with one Mac on Monterey and one on Sequoia would silently stop
// being able to read each other, and no unit test inside a single engine would notice.
//
// THIS IS NOT A GOLDEN SIGNATURE (rule 1). The fixture's `sig` is never COMPARED to anything; it is
// VERIFIED. ECDSA is non-deterministic in both engines, so a fixture that asserted signature bytes
// would be wrong by construction — but a fixture that asserts a signature VERIFIES is exactly the
// interop claim, and it is the only form of it that can be written down.
//
// NO ERROR NAMES ARE BRANCHED ON (rule 3). Every failure assertion reads `err.check` or
// `err.barrier` — values this codebase defines. WebKit's own error names ARE printed with `diag()`,
// because ADR 002 §1's rule-3 table is built from exactly that kind of observation, but nothing in
// this file compares them.

const envelope = await importApp('crypto/envelope.js');
const identity = await importApp('crypto/identity.js');
const suite = await importApp('crypto/suite.js');
const keystore = await importApp('platform/keystore.js');
const b64 = await importApp('core/b64.js');
const canon = await importApp('core/canon.js');
const stamp = await importApp('core/stamp.js');
const ids = await importApp('core/ids.js');
const ops = await importApp('core/ops.js');

const S = crypto.subtle;
const TE = new TextEncoder();
const DAY = '2026-08-27';
const toHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

// ── the cross-engine fixture: sealed by `sealOp` in Node v22.23.1 ────────────
const NODE_SEALED =
{
  "att": {
    "memberId": "mem_kGVLInSbeOtavOD8kbg_Og",
    "deviceId": "dev_HqyudS-2ycqLreYM-LzLsA",
    "deviceShort": "M2ZHEQ6Q19VG8BTC",
    "sigPubRaw": "BLcZd8CtminOWPA7lOH6jUyxmzCyXoHkMK64dCEeogiVBRH_RYx_GuBkP5aCj0k8Nrdg1GXJf-ICiWcufCLEOhA",
    "kexPubRaw": "BChe21F-4DrSScKw44KGyqZOzTMVgkEqvixCni1e7tCqEa9LD9Uf_EaOY3eZI7vUZvqRWf4uufpc11cor5SFCuY",
    "createdAt": "2026-08-27"
  },
  "spaceKeyRaw": "Cgo6s62Q2Yjisy8MKV6lang_c4xvnXNRImY5VvfFDHg",
  "env": {
    "v": 1,
    "sp": "fsp_w7BssmcDAvrrAWYmhrlUuQ",
    "ep": 3,
    "dv": "M2ZHEQ6Q19VG8BTC",
    "oid": "6cK-lwZmeo2wnfxC3Ac8qQ",
    "wit": "kQ7bR0aZ4tV9wLpNcgXk92",
    "iv": "qm7BH-Vh1gNN1n8E",
    "ct": "p7ndKwjj2mOTcW5Z-On3dGJwa0NoNGlMpVy_bWcpX6GfZi8wpRhNkIstqxsls2Ra8Yu8M-HSPNSKbr5I0cWNhPCraakL9ROKmyDh8tCW1zQX7EPI0GhlK8olRTabWZSrOXiTWrIGIYOh9Qat-r63DlYYJq2cgUfxMcK4Umab0B4kb4fAGS6J0sqz1ykZPvms14kU8VIfngrTqdqFB1YvyjKKHrrtcNsd4lFlqjQRsaJ5ZeKNnGNw0hd7P06-z3oo7vC9XI_X1DsNmvfGGcLxSYYA9pszAQs578jukX21IvPbwGsyjeedKtKsP4DKO1Z0zcPbrGIRsx_yAMBqbeAOVbBa7jO-_ivbKx360LNbEcs1jn8x9YYcb878ADLbfWLx7iaB87WgVUstnSInfGBS4dl9s-lyynNr6rPPsIesFLCWxn4Gskxkep4NDIii6qJ04BlxIwEc9I32r3AiBa_bBVh0J1i7dPbeOZmdXVtXOlC_ppUQNRSgraHsUPU9NTlzxSrQc4mVX57BYOxtqDDlZytk1TcjINmW8qxbvyVImYrdHmHzeya0PYvaiS2-LiS5FDIBKXxmbDe1LufaDm58LSpbOamQiWnNX-RcNUlRO6HnMjT_r7qJXFUEGirU1D5FFqZjeu_BQXFXaM3FGd7n_X9wupn5Rk6AaCxj7J2bMmx-kYr82JbrLBiQSTz8gRQE",
    "sig": "XYsf2K8U7ejctTn_W1wugd4BmvS-V34u-vUpJHtidTlLzs6FI5tD-CWkTgFu2nrwL-hhoz47MWK7t698Y-fWLQ"
  },
  "op": {
    "v": 1,
    "id": "6cK-lwZmeo2wnfxC3Ac8qQ",
    "ts": "1787836800123.000003.M2ZHEQ6Q19VG8BTC",
    "space": "fsp_w7BssmcDAvrrAWYmhrlUuQ",
    "act": "mem_kGVLInSbeOtavOD8kbg_Og",
    "dev": "dev_HqyudS-2ycqLreYM-LzLsA",
    "gid": "q5oo201F2QcMw1bmoZIUAg",
    "k": "member.set",
    "e": "member:mem_kGVLInSbeOtavOD8kbg_Og",
    "f": {
      "displayName": "Mama",
      "colorRef": "p3"
    }
  },
  "aadHex": "5b226c7a702f76322f6f70222c312c226673705f77374273736d6344417672724157596d68726c557551222c332c224d325a48455136513139564738425443222c2236634b2d6c775a6d656f32776e667843334163387151222c226b5137625230615a34745639774c704e6367586b3932225d",
  "canonicalLen": 320,
  "paddedLen": 512
}
;

// ── helpers, mirroring the tier-1 file so the two read alike ─────────────────

async function checkOf(fn) {
  try { await fn(); } catch (err) {
    if (err && err.name === 'EnvelopeError') return err.check;
    return 'UNEXPECTED ' + (err && err.name) + ': ' + (err && err.message);
  }
  return 'NOTHING WAS THROWN';
}
async function barrierOf(fn) {
  try { await fn(); } catch (err) {
    if (err && err.name === 'RedactionError') return err.barrier;
    return 'UNEXPECTED ' + (err && err.name) + ': ' + (err && err.message);
  }
  return 'NOTHING WAS THROWN';
}
// The one place an engine's error NAME is read, and it is read to REPORT it, never to branch.
// ADR 002 §1's rule-3 table was built from observations exactly like this one.
async function nameOf(fn) {
  try { await fn(); return '(no throw)'; } catch (err) { return (err && err.name) || String(err); }
}

async function makeDevice() {
  const ks = keystore.memKeyStore();
  const memberId = ids.memberId();
  const deviceId = ids.deviceId();
  const rec = await identity.ensureRecoveryIdentity(ks, memberId, { createdAt: DAY });
  const m = await identity.ensureAttestedDevice(ks, memberId, rec.recSig.privateKey, { deviceId, createdAt: DAY });
  return { memberId, deviceId, att: m.attestation, dv: m.attestation.deviceShort,
           sigPriv: m.identity.devSig.privateKey };
}
const spaceKey = () => S.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
function ring(entries) {
  const m = new Map(entries.map(([sp, ep, k]) => [sp + ' ' + ep, k]));
  return { get: (sp, ep) => m.get(sp + ' ' + ep) || null };
}
const tableOf = (...devs) => {
  const m = new Map(devs.map((d) => [d.dv, d.att]));
  return (dv) => m.get(dv) || null;
};
function makeOp(dev, sp, over) {
  return Object.assign({
    v: 1, id: ids.opId(), ts: stamp.fmt(1787836800123, 3, dev.dv), space: sp,
    act: dev.memberId, dev: dev.deviceId, gid: ids.groupId(),
    k: 'member.set', e: 'member:' + dev.memberId, f: { colorRef: 'p1' },
  }, over || {});
}
const hdrFor = (op, dv, ep, wit) => ({ v: 1, sp: op.space, ep: ep || 3, dv, oid: op.id, wit: wit || '' });
function concat(...parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
async function resign(env, sigPriv) {
  const aad = envelope.aadOf(env);
  const sig = new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, sigPriv,
    concat(aad, b64.ub64(env.iv), b64.ub64(env.ct))));
  return Object.assign({}, env, { sig: b64.b64u(sig) });
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The context, and the cross-engine fixture
// ═════════════════════════════════════════════════════════════════════════════

test('RULE 7: this is the real engine, under app://localhost, with a working SubtleCrypto', () => {
  assert.equal(location.protocol, 'app:');
  assert.equal(isSecureContext, true);
  assert.equal(typeof crypto.subtle, 'object');
  diag('engine: ' + navigator.userAgent);
});

test('CROSS-ENGINE: an envelope sealed by sealOp in NODE opens here, in WebKit, unchanged', async () => {
  // The five things this single assertion proves at once, none of which a single-engine test can:
  //   · the AAD is the same bytes in both engines
  //   · AES-256-GCM with a 12-byte IV and a 128-bit tag interoperates
  //   · an ECDSA P-256/SHA-256 signature made by Node verifies under WebKit
  //   · the 256-byte padding and its varint prefix agree
  //   · `canonicalJSON` produces the same string, so openOp's canonicality check does not reject
  //     the other engine's honest output
  const raw = b64.ub64(NODE_SEALED.spaceKeyRaw);
  const key = await S.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const kr = ring([[NODE_SEALED.env.sp, NODE_SEALED.env.ep, key]]);
  const out = await envelope.openOp(NODE_SEALED.env, kr, () => NODE_SEALED.att);
  assert.equal(out.status, 'opened');
  // Compared through canonicalJSON, because JSON.parse hands back the CANONICAL key order the
  // ciphertext carried, while the fixture literal is written in the ADR's reading order. The bytes
  // are what must agree, and canonicalJSON is the definition of those bytes.
  assert.equal(canon.canonicalJSON(out.op), canon.canonicalJSON(NODE_SEALED.op));
  assert.equal(out.attestation.deviceShort, NODE_SEALED.env.dv);
  diag('opened a Node-sealed envelope: ct=' + b64.ub64(NODE_SEALED.env.ct).length + ' bytes');
});

test('CROSS-ENGINE: the AAD is byte-identical to the one Node computed', () => {
  // If this ever differs the symptom is NOT a readable error — it is every GCM tag failing for one
  // half of a family, three layers away from here.
  const aad = envelope.aadOf(NODE_SEALED.env);
  assert.equal(toHex(aad), NODE_SEALED.aadHex);
  assert.ok(aad.length > 0, 'the AAD is never empty — engine rule 2');
  assert.equal(new TextDecoder().decode(aad).startsWith('["lzp/v2/op",1,'), true);
});

test('CROSS-ENGINE: canonicalJSON and the 256-byte padding agree with Node byte for byte', () => {
  const bytes = canon.canonicalBytes(NODE_SEALED.op);
  assert.equal(bytes.length, NODE_SEALED.canonicalLen, 'canonicalJSON disagrees between the engines');
  const padded = envelope.pad(bytes);
  assert.equal(padded.length, NODE_SEALED.paddedLen);
  assert.equal(padded.length % suite.PAD_BUCKET, 0);
  assert.equal(toHex(envelope.unpad(padded)), toHex(bytes));
});

test('CROSS-ENGINE: the signature is VERIFIED, never compared — and one flipped bit is caught here too', async () => {
  const raw = b64.ub64(NODE_SEALED.spaceKeyRaw);
  const key = await S.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const kr = ring([[NODE_SEALED.env.sp, NODE_SEALED.env.ep, key]]);
  const flipped = b64.ub64(NODE_SEALED.env.sig);
  flipped[0] ^= 0x01;
  const bad = Object.assign({}, NODE_SEALED.env, { sig: b64.b64u(flipped) });
  assert.equal(await checkOf(() => envelope.openOp(bad, kr, () => NODE_SEALED.att)), 'P3');
  // …and the honest one still verifies, which is the only correct assertion about a signature.
  assert.equal((await envelope.openOp(NODE_SEALED.env, kr, () => NODE_SEALED.att)).status, 'opened');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Seal and open, entirely inside WebKit
// ═════════════════════════════════════════════════════════════════════════════

test('seal -> open round-trips in WebKit, with a nine-field envelope and no authoring time', async () => {
  const dev = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const kr = ring([[sp, 3, key]]);
  const op = makeOp(dev, sp, { f: { displayName: 'Mama', colorRef: 'p3' } });
  const env = await envelope.sealOp(op, kr, dev.sigPriv, hdrFor(op, dev.dv), { attestation: dev.att });

  assert.equal(JSON.stringify(Object.keys(env)), JSON.stringify(envelope.ENVELOPE_FIELDS));
  const wall = op.ts.slice(0, 13);
  for (const f of envelope.AAD_FIELDS) {
    assert.equal(String(env[f]).includes(wall), false, 'header ' + f + ' leaks the wall clock');
  }
  const out = await envelope.openOp(env, kr, tableOf(dev));
  assert.equal(out.status, 'opened');
  assert.equal(JSON.stringify(out.op), JSON.stringify(canon.canonicalJSON(op) && JSON.parse(canon.canonicalJSON(op))));
});

test('RULE 1 in WebKit: two seals of one op differ in sig, iv and ct', async () => {
  const dev = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const kr = ring([[sp, 3, key]]);
  const op = makeOp(dev, sp);
  const a = await envelope.sealOp(op, kr, dev.sigPriv, hdrFor(op, dev.dv));
  const b = await envelope.sealOp(op, kr, dev.sigPriv, hdrFor(op, dev.dv));
  assert.notEqual(a.sig, b.sig, 'WebKit ECDSA must be treated as non-deterministic');
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
  assert.equal(a.oid, b.oid);
  assert.equal((await envelope.openOp(a, kr, tableOf(dev))).status, 'opened');
  assert.equal((await envelope.openOp(b, kr, tableOf(dev))).status, 'opened');
});

test('an envelope sealed in WebKit is opened by an INDEPENDENT verification of the same bytes', async () => {
  // The round trip above uses `openOp` for both halves, so it would still pass if `sealOp` and
  // `openOp` agreed on a shape neither engine's primitives actually produce. This re-does the
  // verification with raw WebCrypto calls, from the wire fields alone.
  const dev = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const op = makeOp(dev, sp);
  const hdr = hdrFor(op, dev.dv, 3, 'kQ7bR0aZ4tV9wLpNcgXk92');
  const env = await envelope.sealOp(op, ring([[sp, 3, key]]), dev.sigPriv, hdr);

  const aad = envelope.aadOf(env);
  const iv = b64.ub64(env.iv);
  const ct = b64.ub64(env.ct);
  const pub = await identity.importSigPublic(b64.ub64(dev.att.sigPubRaw));
  assert.equal(
    await S.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64.ub64(env.sig), concat(aad, iv, ct)),
    true, 'the signature does not cover aad ‖ iv ‖ ct');
  const plain = new Uint8Array(await S.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ct));
  assert.equal(plain.length % suite.PAD_BUCKET, 0);
  assert.equal(new TextDecoder().decode(envelope.unpad(plain)), canon.canonicalJSON(op));
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. The gate and the five checks, in this engine
// ═════════════════════════════════════════════════════════════════════════════

test('P1: a null attestation PARKS the sealed envelope, and the same bytes open once it arrives', async () => {
  const dev = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const kr = ring([[sp, 3, key]]);
  const op = makeOp(dev, sp);
  const env = await envelope.sealOp(op, kr, dev.sigPriv, hdrFor(op, dev.dv));
  const parked = await envelope.openOp(env, kr, () => null);
  assert.equal(parked.status, 'park');
  assert.equal(parked.parkReason, 'attestation');
  assert.equal((await envelope.openOp(env, kr, tableOf(dev))).status, 'opened');
});

test('P2: a substituted attestation is refused in WebKit — the short is self-certifying', async () => {
  const alice = await makeDevice();
  const bob = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const kr = ring([[sp, 3, key]]);
  const op = makeOp(alice, sp);
  const env = await envelope.sealOp(op, kr, alice.sigPriv, hdrFor(op, alice.dv));
  assert.equal(await checkOf(() => envelope.openOp(env, kr, () => bob.att)), 'P2');
  assert.notEqual(alice.dv, bob.dv, 'two devices must have two shorts (ADR 001 §6.2)');
});

test('P3 then P4: verify before decrypt, and a missing epoch PARKS rather than erroring', async () => {
  const dev = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const op = makeOp(dev, sp);
  const env = await envelope.sealOp(op, ring([[sp, 5, key]]), dev.sigPriv, hdrFor(op, dev.dv, 5));
  const parked = await envelope.openOp(env, ring([[sp, 4, key]]), tableOf(dev));
  assert.equal(parked.status, 'park');
  assert.equal(parked.parkReason, ops.PARK_REASONS.EPOCH);
  // A bad signature is caught BEFORE the key lookup, so it throws even with an empty key ring.
  const forged = Object.assign({}, env, { sig: b64.b64u(new Uint8Array(64)) });
  assert.equal(await checkOf(() => envelope.openOp(forged, ring([]), tableOf(dev))), 'P3');
});

test('RE-ATTRIBUTION breaks the signature AND, past that, the GCM tag — proved in WebKit', async () => {
  const alice = await makeDevice();
  const bob = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const kr = ring([[sp, 3, key]]);
  const op = makeOp(alice, sp);
  const env = await envelope.sealOp(op, kr, alice.sigPriv, hdrFor(op, alice.dv));

  const relabelled = Object.assign({}, env, { dv: bob.dv });
  assert.equal(await checkOf(() => envelope.openOp(relabelled, kr, tableOf(alice, bob))), 'P3');
  const resigned = await resign(relabelled, bob.sigPriv);
  assert.equal(await checkOf(() => envelope.openOp(resigned, kr, tableOf(alice, bob))), 'aead');
  // RULE 3 — what WebKit calls the AES-GCM failure, recorded and never branched on.
  diag('WebKit AES-GCM decrypt failure name: ' + await nameOf(
    () => S.decrypt({ name: 'AES-GCM', iv: b64.ub64(resigned.iv), additionalData: envelope.aadOf(resigned), tagLength: 128 },
      key, b64.ub64(resigned.ct))));
});

test('the five post-decrypt checks fire in WebKit, on validly signed envelopes', async () => {
  // Forged locally with raw primitives, so each envelope's signature and tag are genuinely valid
  // and only the plaintext is adversarial. An honest sealer refusing to build these proves nothing
  // about an opener; a modified client is the threat model.
  const alice = await makeDevice();
  const bob = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const kr = ring([[sp, 3, key]]);
  const base = makeOp(alice, sp);

  const forge = async (op, hdr) => {
    const aad = envelope.aadOf(hdr);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      key, envelope.pad(canon.canonicalBytes(op))));
    const sig = new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, alice.sigPriv, concat(aad, iv, ct)));
    return Object.assign({}, hdr, { iv: b64.b64u(iv), ct: b64.b64u(ct), sig: b64.b64u(sig) });
  };

  const rows = [
    ['C1', base, Object.assign(hdrFor(base, alice.dv), { oid: ids.opId() })],
    ['C2', Object.assign({}, base, { space: ids.spaceId('family') }), hdrFor(base, alice.dv)],
    ['C3', Object.assign({}, base, { dev: ids.deviceId() }), hdrFor(base, alice.dv)],
    ['C4', Object.assign({}, base, { ts: stamp.fmt(1787836800123, 3, bob.dv) }), hdrFor(base, alice.dv)],
    ['C5', Object.assign({}, base, { act: ids.memberId() }), hdrFor(base, alice.dv)],
  ];
  for (const [check, op, hdr] of rows) {
    const env = await forge(op, hdr);
    assert.equal(await checkOf(() => envelope.openOp(env, kr, tableOf(alice, bob))), check, check + ' did not fire');
  }
});

test('the pad is not a channel, and a non-canonical plaintext is refused — in WebKit too', async () => {
  const dev = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const kr = ring([[sp, 3, key]]);
  const op = makeOp(dev, sp);
  const hdr = hdrFor(op, dev.dv);
  const aad = envelope.aadOf(hdr);

  const sealRaw = async (plain) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plain));
    const sig = new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.sigPriv, concat(aad, iv, ct)));
    return Object.assign({}, hdr, { iv: b64.b64u(iv), ct: b64.b64u(ct), sig: b64.b64u(sig) });
  };

  const smuggled = envelope.pad(canon.canonicalBytes(op));
  smuggled[smuggled.length - 1] = 0x21;
  const smuggledEnv = await sealRaw(smuggled);
  assert.equal(await checkOf(() => envelope.openOp(smuggledEnv, kr, tableOf(dev))), 'padding');

  const nonCanonicalEnv = await sealRaw(envelope.pad(TE.encode(JSON.stringify(op))));
  assert.equal(await checkOf(() => envelope.openOp(nonCanonicalEnv, kr, tableOf(dev))), 'canonical');
});

test('BARRIER 3 of §3 in WebKit: a personal envelope will not open under a family key', async () => {
  const dev = await makeDevice();
  const psp = ids.spaceId('personal');
  const psk = await spaceKey();
  const fsk = await spaceKey();
  const op = makeOp(dev, psp, { k: 'note.set', e: 'note:' + ids.entityUuid(), f: { date: '2026-09-10', text: 'Therapie' } });
  const env = await envelope.sealOp(op, ring([[psp, 3, psk]]), dev.sigPriv, hdrFor(op, dev.dv));
  assert.equal(await checkOf(() => envelope.openOp(env, ring([[psp, 3, fsk]]), tableOf(dev))), 'aead');
  // There is no "wrong key, right ciphertext" degradation path. The engine refuses, it does not
  // return plausible-looking garbage — which is what makes stories 20.5 and 21.2 true.
  diag('WebKit wrong-key failure name: ' + await nameOf(() => S.decrypt(
    { name: 'AES-GCM', iv: b64.ub64(env.iv), additionalData: envelope.aadOf(env), tagLength: 128 },
    fsk, b64.ub64(env.ct))));
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Padding as a privacy measure, measured on this engine's real ciphertext
// ═════════════════════════════════════════════════════════════════════════════

test('STORY 16.7 in WebKit: Belegt and Geteilt ops are the same size on the wire', async () => {
  const dev = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const kr = ring([[sp, 4, key]]);
  const entity = 'fnote:' + dev.memberId + '/' + ids.entityUuid();

  const seal = async (f, level) => {
    const op = makeOp(dev, sp, { k: 'pub.set', e: entity, f: envelope.brandFamilyPatch(f, { kind: 'fnote', level }) });
    const env = await envelope.sealOp(op, kr, dev.sigPriv, hdrFor(op, dev.dv, 4),
      { levelOf: () => level, assertFamilyPatch: () => {} });
    return b64.ub64(env.ct).length;
  };
  const belegt = await seal({ 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-09-10',
    'pub.repeatsYearly': false }, 'belegt');
  const geteilt = await seal({ 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-09-10',
    'pub.repeatsYearly': false, 'pub.coEdit': false,
    'pub.text': 'Zahnarzt um 14 Uhr bei Dr. Mueller, Karte mitnehmen' }, 'geteilt');
  diag('belegt ct=' + belegt + ' geteilt ct=' + geteilt);
  assert.equal(belegt % suite.PAD_BUCKET, 16, 'ciphertext = padded plaintext + a 16-byte tag');
  assert.equal(belegt, geteilt, 'a Belegt op is distinguishable from a Geteilt op by size');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. ADR 004 §2.4 — the refusal holds in the shipping engine
// ═════════════════════════════════════════════════════════════════════════════

test('sealOp refuses an unbranded family patch in WebKit, and the brand never reaches the ciphertext', async () => {
  const dev = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const kr = ring([[sp, 3, key]]);
  const entity = 'fnote:' + dev.memberId + '/' + ids.entityUuid();
  const raw = { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt' };
  const seal = (f, ctx) => {
    const op = makeOp(dev, sp, { k: 'pub.set', e: entity, f });
    return envelope.sealOp(op, kr, dev.sigPriv, hdrFor(op, dev.dv), ctx);
  };
  const ctx = { levelOf: () => 'geteilt', assertFamilyPatch: () => {} };
  assert.equal(await barrierOf(() => seal(Object.assign({}, raw), ctx)), 'barrier3');
  // Barrier 4: a patch that does NOT declare its own `pub.level` takes it from the AUTHENTICATED
  // register map, and a projection that disagrees with that map is refused rather than corrected.
  const noLevel = envelope.brandFamilyPatch(
    { 'pub.alive': true, 'pub.date': '2026-09-10', 'pub.text': 'Therapie, 16:00' },
    { kind: 'fnote', level: 'geteilt' });
  assert.equal(await barrierOf(() => seal(noLevel, { levelOf: () => 'belegt', assertFamilyPatch: () => {} })), 'barrier4');
  const branded = envelope.brandFamilyPatch(Object.assign({}, raw), { kind: 'fnote', level: 'geteilt' });
  // Barrier 2 is required, not optional: project.js has not landed, so nothing seals without it.
  assert.equal(await barrierOf(() => seal(branded, { levelOf: () => 'geteilt' })), 'barrier2');

  // And with all four satisfied it seals — with no trace of the brand in the plaintext.
  const good = makeOp(dev, sp, { k: 'pub.set', e: entity, f: branded });
  const env = await envelope.sealOp(good, kr, dev.sigPriv, hdrFor(good, dev.dv), ctx);
  assert.equal(typeof env.ct, 'string');
  assert.equal(canon.canonicalJSON(branded).includes('family-patch'), false);
  assert.equal(envelope.FAMILY_PATCH_BRAND === Symbol.for('lzp/v2/family-patch'), true);
});

test('BARRIER 4 in WebKit: a declared `pub.level` is a CLAIM CHECKED against the map (S5)', async () => {
  // Finding S5, closed 2026-08-28. `envelope.js` used to compute
  //     level = declared === undefined || declared === null ? folded : declared
  // so the caller's `pub.level` governed whenever the caller supplied one, and the brand — minted
  // by the same caller in the same expression — agreed with the lie. The red team sealed a
  // `pub.text` for an entry the register map calls belegt (row M-R7c). The level is now the map's:
  // `const level = folded`, and a declared level that disagrees is a barrier-4 refusal.
  //
  // This runs in the SHIPPING ENGINE because barrier 4 is the only one of ADR 004's four whose
  // outcome is a REFUSAL TO ENCRYPT — Node proving it is Node proving a branch, and 21.1's claim
  // is about the bytes WebKit puts on the wire. The two seals below are the same input to
  // WKWebView's SubtleCrypto with one field changed.
  const dev = await makeDevice();
  const sp = ids.spaceId('family');
  const kr = ring([[sp, 3, await spaceKey()]]);
  const entity = 'fnote:' + dev.memberId + '/' + ids.entityUuid();
  const nop = () => {};
  const seal = (f, level) => {
    const op = makeOp(dev, sp, { k: 'pub.set', e: entity, f });
    return envelope.sealOp(op, kr, dev.sigPriv, hdrFor(op, dev.dv),
      { levelOf: () => level, assertFamilyPatch: nop });
  };

  // The attack, verbatim: the caller lies in `pub.level` AND in the brand that restates it.
  const lie = envelope.brandFamilyPatch(
    { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-09-10',
      'pub.text': 'Scheidungsanwalt 14:30' },
    { kind: 'fnote', level: 'geteilt' });
  assert.equal(await barrierOf(() => seal(lie, 'belegt')), 'barrier4');
  // Told honestly at belegt, the same text still dies at the BACKSTOP — the two are independent
  // and the fix did not move the leak from one to the other.
  const honestBelegt = envelope.brandFamilyPatch(
    { 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-09-10',
      'pub.text': 'Scheidungsanwalt 14:30' },
    { kind: 'fnote', level: 'belegt' });
  assert.equal(await barrierOf(() => seal(honestBelegt, 'belegt')), 'backstop');
  // The map agreeing with the declaration is the legitimate transition, and it SEALS — the fix is
  // not "refuse everything", and a share that stopped working would be the loud symptom of a
  // `levelOf` wired to the last-published level instead of the entity's own truth register.
  assert.equal(typeof (await seal(lie, 'geteilt')).ct, 'string');

  // The whole (declared × folded) cross, on a withdrawal payload so `privat` is reachable at all.
  for (const declared of ['privat', 'belegt', 'geteilt']) {
    for (const folded of ['privat', 'belegt', 'geteilt']) {
      const p = envelope.brandFamilyPatch(
        { 'pub.level': declared, 'pub.text': null }, { kind: 'fnote', level: declared });
      const where = declared + ' declared / ' + folded + ' folded';
      if (declared === folded) assert.equal(typeof (await seal(p, folded)).ct, 'string', where);
      else assert.equal(await barrierOf(() => seal(p, folded)), 'barrier4', where);
    }
  }

  // And an answer the map cannot give is a refusal in its own right — never a fallback to the
  // patch. `undefined` matters here specifically: it is what a `levelOf` returns for an entity it
  // has never seen, which is every entity on a fresh device mid-pull.
  for (const answer of [null, undefined, 'oeffentlich']) {
    assert.equal(await barrierOf(() => seal(lie, answer)), 'barrier4', String(answer));
  }
});

test('the backstop refuses content above the level even with a no-op barrier 2, in WebKit', async () => {
  const dev = await makeDevice();
  const sp = ids.spaceId('family');
  const key = await spaceKey();
  const kr = ring([[sp, 3, key]]);
  const entity = 'fnote:' + dev.memberId + '/' + ids.entityUuid();
  const leak = envelope.brandFamilyPatch(
    { 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': '2026-09-10', 'pub.text': 'Therapie' },
    { kind: 'fnote', level: 'belegt' });
  const op = makeOp(dev, sp, { k: 'pub.set', e: entity, f: leak });
  assert.equal(
    await barrierOf(() => envelope.sealOp(op, kr, dev.sigPriv, hdrFor(op, dev.dv),
      { levelOf: () => 'belegt', assertFamilyPatch: () => {} })),
    'backstop');
  // …and §5's withdrawal escape still passes: an explicit null is not a value.
  const withdrawal = envelope.brandFamilyPatch(
    { 'pub.level': 'belegt', 'pub.text': null }, { kind: 'fnote', level: 'belegt' });
  const wOp = makeOp(dev, sp, { k: 'pub.set', e: entity, f: withdrawal });
  const sealed = await envelope.sealOp(wOp, kr, dev.sigPriv, hdrFor(wOp, dev.dv),
    { levelOf: () => 'belegt', assertFamilyPatch: () => {} });
  assert.equal(sealed.v, suite.ENVELOPE_V);
});

test('the `attestation` park reason is still missing from core/ops.js in this build too (F-6, WP-8)', () => {
  assert.equal('ATTESTATION' in ops.PARK_REASONS, false,
    'WP-8 landed it — re-point ENVELOPE_PARK.ATTESTATION and delete this row in both tiers');
  assert.equal(ops.isParkReason(envelope.ENVELOPE_PARK.ATTESTATION), false);
  assert.equal(envelope.ENVELOPE_PARK.EPOCH, ops.PARK_REASONS.EPOCH);
});
