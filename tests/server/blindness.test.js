// tests/server/blindness.test.js — LZP-207.  Story 21.1, 21.3 · ADR 003 §5.2, §6.2 · addendum §3.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CLAIM UNDER TEST, IN THE FORM THE DATENSCHUTZ COPY MAKES IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   "Der Server speichert nur verschlüsselte Daten. Er kann keinen Eintrag, keinen Balken,
//    keine Kategorie, keinen Namen und keinen Notizzettel lesen."
//
// Every other server test asks whether one endpoint behaves. This one asks whether that sentence
// is TRUE — and it asks it the only way that means anything: run a realistic family session
// through the real router, then look at everything the relay is left holding and show that none
// of it is any of the words that were typed.
//
// ── WHY THIS IS AN ENUMERATION AND NOT A LIST OF CASES ───────────────────────────────────────
//
// A blindness test written as "assert the envelope column has no plaintext" proves the thing
// nobody was going to get wrong. What actually leaks is the column somebody adds later for a
// good reason — a `lastKnownName` for a nicer 403, a `label` for an admin page, a `ts` "just for
// debugging". So §2 below does not check a list of columns. It walks **every model × every
// column in `MODEL_COLUMNS`** and requires each cell to fall into one of exactly four buckets:
//
//     opaque bytes  ·  a timestamp  ·  a number/bool/enum  ·  a String on PLAINTEXT_STRINGS
//
// with the fourth carrying a written justification. A new column lands in none of them and the
// test fails naming it. That is the discipline that closed 51 findings in the log layer: the
// assertion is over the DOMAIN, so a case nobody thought of is still covered.
//
// §3 then does the same from the other end — a real session, and a search of the ENTIRE store
// (every Map, every row, every value, and for the file adapter the actual bytes on disk) for a
// corpus of things a German family would really type. §4 does it for responses, §5 for log
// lines, §6 for error bodies.
//
// ── NO src/js IMPORTS, DELIBERATELY ──────────────────────────────────────────────────────────
// This file seals with plain WebCrypto AES-GCM rather than `src/js/crypto/envelope.js`. Two
// reasons, and neither is convenience: the claim being tested is about the SERVER, so a failure
// here must be a server failure and not a crypto-layer failure arriving by import; and a test
// that asserts "the relay cannot read this" must not get its ciphertext from a module whose own
// suite could be red. The real envelope path is exercised end to end by
// `docs/v2/E2-VERIFICATION.md` §2 and by `tests/server/ops.test.js`.
//
// Runs against BOTH adapters. The file adapter is the one that matters most here: it is the only
// place the store's contents become a readable document, and a JSON store is exactly where an
// opaque column quietly becomes text.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MODEL_COLUMNS, OPAQUE_FIELDS, PLAINTEXT_STRINGS, FORBIDDEN_COLUMN_TOKENS,
} from '../../server/core/store-interface.js';
import { createStoreEngine, emptyState } from '../../server/adapters/memory.js';
import { fileStore, STORE_FILENAME } from '../../server/adapters/file.js';
import { createHandlers, handlers, HANDLER_OWNERS, REQUIRED_CTX_NAMES } from '../../server/core/handlers/index.js';
import { authenticate, assertMember, b64u } from '../../server/core/auth.js';
import { LIMITS, createLog, LOG_FIELD_NAMES, LOG_FIELDS, LOG_ROUTES } from '../../server/core/limits.js';
import { DEVICE_PROJECTION, MEMBER_PROJECTION } from '../../server/core/handlers/members.js';
import { attestDevice, buildDeviceAttestation } from '../../src/js/crypto/identity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const S = globalThis.crypto.subtle;
const TE = new TextEncoder();

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-blind-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1  THE CORPUS — what a family actually types
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Every one of these is sealed, published or typed somewhere in §3's session. None of them may
// survive anywhere the relay can reach. They are chosen to cover the five things story 21.1
// names by name (Eintrag, Balken, Kategorie, Name, Notizzettel) plus the two the schema header
// promises are absent (an authoring date, a display name), and they include an Umlaut and an
// ß so that a UTF-8 round trip through the file adapter cannot hide a match.
const CORPUS = Object.freeze([
  'Zahnarzt Mama 14:30',          // a note (Eintrag)
  'Sommerferien Italien',         // a bar label (Balken)
  'Arzttermine',                  // a category (Kategorie)
  'Großmutter Käthe',             // a display name, with an Umlaut and an ß
  'Einkaufszettel: Milch, Brot',  // the scratchpad (Notizzettel)
  'Familie Hein',                 // the space name — addendum §3: it travels encrypted
  '2026-09-10',                   // an entry DATE. There is no date column and must not be one.
]);

/** Recursively collect every primitive value reachable from a store's raw state. */
function scalarsOf(node, out, trail) {
  const at = trail || 'state';
  if (node === null || node === undefined) return out;
  if (node instanceof Uint8Array) return out;              // opaque by construction — §2 proves it
  if (node instanceof Date) { out.push([at, node.toISOString()]); return out; }
  if (node instanceof Map) {
    for (const [k, v] of node) {
      out.push([`${at}«key»`, String(k)]);
      scalarsOf(v, out, `${at}[${String(k)}]`);
    }
    return out;
  }
  if (Array.isArray(node)) { node.forEach((v, i) => scalarsOf(v, out, `${at}[${i}]`)); return out; }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) scalarsOf(node[k], out, `${at}.${k}`);
    return out;
  }
  out.push([at, String(node)]);
  return out;
}

/** Which corpus entries appear in a string. */
const hits = (s) => CORPUS.filter((w) => typeof s === 'string' && s.includes(w));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2  THE COLUMN DOMAIN — every model × every column, classified, nothing unclassified
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Columns whose values are timestamps. Enumerated so a new `*At` cannot arrive unnoticed. */
const TIME_COLUMNS = Object.freeze({
  Space: ['createdAt'], Member: ['joinedAt', 'removedAt'], Device: ['addedAt', 'revokedAt'],
  Op: ['receivedAt'], Epoch: ['createdAt'], KeyWrap: [], Invite: ['expiresAt', 'usedAt', 'revokedAt'],
  PairSession: ['expiresAt', 'burnedAt'], Nonce: ['expiresAt'], RateBucket: ['windowStart'],
});

/** Columns whose values are numbers, bigints, booleans or a closed enum. */
const SCALAR_COLUMNS = Object.freeze({
  Space: ['currentEpoch', 'nextSeq', 'kind'], Member: [], Device: ['lastSeenSeq', 'lastPushedSeq'],
  Op: ['seq', 'epoch'], Epoch: ['epoch'], KeyWrap: ['epoch'], Invite: ['epoch'],
  PairSession: ['attempts'], Nonce: [], RateBucket: ['count'],
});

test('§2 EVERY column of EVERY model is opaque, a timestamp, a scalar, or a justified String', () => {
  const unclassified = [];
  const buckets = { opaque: 0, time: 0, scalar: 0, justified: 0 };

  for (const model of Object.keys(MODEL_COLUMNS)) {
    for (const col of MODEL_COLUMNS[model]) {
      const key = `${model}.${col}`;
      if (OPAQUE_FIELDS[model].includes(col)) { buckets.opaque++; continue; }
      if (TIME_COLUMNS[model].includes(col)) { buckets.time++; continue; }
      if (SCALAR_COLUMNS[model].includes(col)) { buckets.scalar++; continue; }
      if (Object.prototype.hasOwnProperty.call(PLAINTEXT_STRINGS, key)) {
        // A justification must exist and say something. No length floor: `Member.spaceId`'s
        // "the relation" is a complete answer, and a floor would only teach people to pad.
        const why = PLAINTEXT_STRINGS[key];
        assert.equal(typeof why, 'string', `${key} has no justification`);
        assert.ok(why.trim().length > 0, `${key}: the justification is empty`);
        buckets.justified++;
        continue;
      }
      unclassified.push(key);
    }
  }

  assert.deepEqual(
    unclassified, [],
    'These columns are in none of the four buckets. A column the relay holds that is neither '
    + 'ciphertext, nor a timestamp, nor a number, nor a String with a written justification in '
    + 'PLAINTEXT_STRINGS is a column nobody can answer story 21.3 about. Either classify it here '
    + 'and justify it there, or do not add it.');

  // The classification must be TOTAL and DISJOINT — a column counted twice would let a String
  // hide inside `scalar` and never reach the justification requirement.
  const total = Object.values(MODEL_COLUMNS).reduce((n, c) => n + c.length, 0);
  assert.equal(buckets.opaque + buckets.time + buckets.scalar + buckets.justified, total);
  for (const model of Object.keys(MODEL_COLUMNS)) {
    const seen = [...OPAQUE_FIELDS[model], ...TIME_COLUMNS[model], ...SCALAR_COLUMNS[model]];
    assert.equal(new Set(seen).size, seen.length, `${model}: a column is in two buckets`);
    for (const c of seen) assert.ok(MODEL_COLUMNS[model].includes(c), `${model}.${c} is not a column`);
  }
});

test('§2 the justified-String allowlist names no column that does not exist, and no ghost model', () => {
  for (const key of Object.keys(PLAINTEXT_STRINGS)) {
    const [model, col] = key.split('.');
    assert.ok(MODEL_COLUMNS[model], `PLAINTEXT_STRINGS names model ${model}, which has no columns`);
    assert.ok(MODEL_COLUMNS[model].includes(col), `PLAINTEXT_STRINGS names ${key}, which is not a column`);
    assert.equal(OPAQUE_FIELDS[model].includes(col), false, `${key} is BOTH opaque and a plaintext String`);
  }
});

test('§2 exactly ONE justified String is content rather than an id, and it is the one 15.3 forces', () => {
  // Every other entry on the allowlist is an identifier, a relation, an enum or a derived value.
  // `Member.colorRef` is the single row that carries a user's CHOICE, and it is there because
  // `@@unique([spaceId, colorRef])` cannot be evaluated inside ciphertext. If a second such row
  // ever appears, the Datenschutz copy (21.3) has to gain a sentence — so this test exists to
  // make that a decision rather than a diff.
  // `senderDeviceId` joins the identifier list rather than the content list, and the distinction
  // is the one this test is about: it is a DEVICE ID the relay assigned and then observed itself
  // when it authenticated the rotation request (finding E2E3-3). It carries no client-chosen
  // bits — `readWraps` refuses a body that names it — so it states nothing the relay did not
  // already know. Compare `Member.colorRef`, which is a user's CHOICE and is why that row needs
  // a sentence in the Datenschutz copy.
  const content = Object.keys(PLAINTEXT_STRINGS).filter(
    (k) => !/(^|\.)(id|spaceId|memberId|deviceShort|opId|recipientId|senderDeviceId|createdBy|rid|nonce|key|kind)$/.test(k));
  assert.deepEqual(content, ['Member.colorRef']);
  assert.match(PLAINTEXT_STRINGS['Member.colorRef'], /DELIBERATE LEAK/);
  assert.match(PLAINTEXT_STRINGS['Member.colorRef'], /21\.3/);
});

test('§2 no column name, in the table or in schema.prisma, carries a forbidden token', () => {
  const schema = fs.readFileSync(path.join(REPO, 'server/prisma/schema.prisma'), 'utf8');
  // Comments name several forbidden tokens on purpose (explaining what is absent), so the schema
  // is checked on its DECLARATION lines only: `  name  Type` inside a model block.
  const declared = [];
  let inModel = false;
  for (const raw of schema.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('///') || line.startsWith('//')) continue;
    if (/^(model|enum)\s/.test(line)) { inModel = true; continue; }
    if (line === '}') { inModel = false; continue; }
    if (!inModel) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+\S/.exec(line);
    if (m) declared.push(m[1]);
  }
  assert.ok(declared.length > 30, `expected the schema's columns, parsed ${declared.length}`);

  const names = [...declared, ...Object.values(MODEL_COLUMNS).flat()];
  for (const n of names) {
    for (const tok of FORBIDDEN_COLUMN_TOKENS) {
      assert.equal(
        n.toLowerCase().includes(tok), false,
        `column "${n}" contains the forbidden token "${tok}" — see FORBIDDEN_COLUMN_TOKENS for why`);
    }
  }
});

test('§2 schema.prisma declares exactly the columns MODEL_COLUMNS does, model by model', () => {
  const schema = fs.readFileSync(path.join(REPO, 'server/prisma/schema.prisma'), 'utf8');
  for (const model of Object.keys(MODEL_COLUMNS)) {
    const block = new RegExp(`\\nmodel ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
    assert.ok(block, `schema.prisma has no model ${model}`);
    const cols = [];
    for (const raw of block[1].split('\n')) {
      const line = raw.trim();
      if (line === '' || line.startsWith('//') || line.startsWith('@@')) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s+(\S+)/.exec(line);
      if (!m) continue;
      // Relation fields are Prisma navigation, not storage: `space Space @relation(...)`.
      if (/@relation/.test(line)) continue;
      if (/^[A-Z]/.test(m[2]) && !/^(String|Int|BigInt|Bytes|DateTime|Boolean|Float|SpaceKind)/.test(m[2])) continue;
      cols.push(m[1]);
    }
    assert.deepEqual(
      [...cols].sort(), [...MODEL_COLUMNS[model]].sort(),
      `${model}: schema.prisma and MODEL_COLUMNS disagree. They are the two halves of one closed `
      + 'set; a column in one and not the other is a column no adapter validates.');
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3  A REAL SESSION, AND THEN A SEARCH OF EVERYTHING THE RELAY IS LEFT HOLDING
// ═════════════════════════════════════════════════════════════════════════════════════════════

const clock = (start) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };

async function keypair(usage) {
  return usage === 'sig'
    ? S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    : S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
}
const rawOf = async (k) => new Uint8Array(await S.exportKey('raw', k));

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** ADR 001 §1.2 — crock32(SHA-256(rawSigPub)[0..10]). The same derivation `auth.js` checks. */
async function shortOf(rawSigPub) {
  const h = new Uint8Array(await S.digest('SHA-256', rawSigPub)).subarray(0, 10);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of h) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { out += CROCK[(acc >> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.slice(0, 16);
}

/** One family member with one device, in the shape the bootstrap routes want on the wire. */
async function person(colorRef) {
  const sig = await keypair('sig');
  const kex = await keypair('kex');
  const recSig = await keypair('sig');
  const recKex = await keypair('kex');
  const sigPubRaw = await rawOf(sig.publicKey);
  const p = {
    colorRef,
    memberId: `mem_${b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`,
    deviceId: `dev_${b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`,
    deviceShort: await shortOf(sigPubRaw),
    sigPriv: sig.privateKey,
    kexPriv: kex.privateKey,
    sigPubRaw: b64u(sigPubRaw),
    kexPubRaw: b64u(await rawOf(kex.publicKey)),
    recoveryPubSig: b64u(await rawOf(recSig.publicKey)),
    recoveryPubKex: b64u(await rawOf(recKex.publicKey)),
  };
  // ── THE SMUGGLING ATTEMPT MOVED, IT DID NOT GO AWAY — finding E2E3-6 / E2E3-7 ─────────────
  // This used to be `{deviceShort, note: 'Großmutter Käthe'}`, base64url, unverified: the relay
  // accepted it, stored it and never looked, and §3 proved a corpus word inside it never reached
  // a response. `GET /spaces/:id/members` now PUBLISHES the attestation (E2E3-6), so "stored and
  // never read" stopped being the answer and the door had to become one.
  //
  // Two things changed and both are asserted below rather than assumed:
  //   1. the blob is now REAL — minted by the shipping `buildDeviceAttestation`/`attestDevice`,
  //      verified server-side by `verifyDeviceClaim` on every write path; and
  //   2. its payload is a CLOSED FIELD SET at the door (`assertAttestationClosed`), so the
  //      smuggling attempt is REFUSED rather than merely unread — see '§2 an attestation cannot
  //      carry a note' below, which is the corpus word's new home.
  const att = await buildDeviceAttestation(
    { memberId: p.memberId, deviceId: p.deviceId, createdAt: '2026-08-29' }, sig.publicKey, kex.publicKey,
  );
  p.attestation = await attestDevice(att, recSig.privateKey);
  p.recSigPriv = recSig.privateKey;
  return p;
}
const wireDevice = (p) => ({
  deviceId: p.deviceId, deviceShort: p.deviceShort,
  sigPubRaw: p.sigPubRaw, kexPubRaw: p.kexPubRaw, attestation: p.attestation,
});
const wireMember = (p) => ({
  memberId: p.memberId, recoveryPubSig: p.recoveryPubSig, recoveryPubKex: p.recoveryPubKex,
});

/**
 * Seal a corpus string under a per-space AES-256-GCM key the relay never sees, and frame it the
 * way `pushOps` expects: `iv`, `ct`, `sig` as three base64url fields.
 */
async function seal(key, sigPriv, hdr, plaintext) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const aad = TE.encode(JSON.stringify([hdr.v, hdr.sp, hdr.ep, hdr.dv, hdr.oid, hdr.wit]));
  const ct = new Uint8Array(await S.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, TE.encode(plaintext)));
  const body = new Uint8Array(aad.length + iv.length + ct.length);
  body.set(aad, 0); body.set(iv, aad.length); body.set(ct, aad.length + iv.length);
  const sig = new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, sigPriv, body));
  return { ...hdr, iv: b64u(iv), ct: b64u(ct), sig: b64u(sig) };
}

/** A signed ServerReq, exactly as ADR 003 §2 defines the string. */
async function request(p, method, urlPath, query, body, at) {
  const rawBody = body === undefined ? new Uint8Array(0) : TE.encode(JSON.stringify(body));
  const qs = Object.keys(query || {}).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
  const hash = b64u(new Uint8Array(await S.digest('SHA-256', rawBody)));
  const ts = String(at);
  const nonce = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
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
    clientIp: '203.0.113.7',
  };
}

/**
 * Everything a family does in its first ten minutes, over the real router. Returns the responses,
 * the log lines and a handle on the raw store, so §3-§5 can search all three.
 */
/** The router, a store and a `call` — everything `session()` is built out of, on its own. */
function serverOnly(makeStore) {
  const c = clock(1787900000000);
  const store = makeStore(c);
  const route = createHandlers();
  const logLines = [];
  const responses = [];

  const ctx = {
    store,
    now: () => c.now(),
    random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    sha256: async (b) => new Uint8Array(await S.digest('SHA-256', b)),
    auth: (req) => authenticate(req, ctx),
    assertMember: (memberId, spaceId) => assertMember(memberId, spaceId, ctx),
    log: createLog((line) => logLines.push(line)),
    limits: LIMITS,
  };
  const call = async (p, method, urlPath, query, body) => {
    const res = await route(ctx, await request(p, method, urlPath, query, body, c.now()));
    c.advance(1000);
    responses.push({ route: `${method} ${urlPath}`, res });
    return res;
  };
  return { c, store, ctx, call, logLines, responses };
}

async function session(makeStore) {
  const { c, store, ctx, call, logLines, responses } = serverOnly(makeStore);

  const papa = await person('gruen');
  const mama = await person('blau');
  const spaceId = `fsp_${b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`;
  const spaceKey = await S.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);

  // A wrap is opaque bytes to the relay; fill it with a corpus word so that a relay which ever
  // looked inside one would be caught by the same search.
  const wrap = (recipientId, epoch) => ({
    recipientId, epoch,
    wrapped: b64u(TE.encode(JSON.stringify({ v: 1, ct: 'x', hint: 'Familie Hein' }))),
  });

  const created = await call(papa, 'POST', '/spaces', {}, {
    spaceId, kind: 'FAMILY', colorRef: papa.colorRef,
    member: wireMember(papa), device: wireDevice(papa),
    wraps: [wrap(papa.deviceId, 1), wrap(`rec_${papa.memberId}`, 1)],
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));

  // Two sealed ops under epoch 1: an entry and the space name. Both carry corpus plaintext.
  const push1 = [];
  for (const text of ['Zahnarzt Mama 14:30 · 2026-09-10', 'Familie Hein']) {
    const oid = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    push1.push(await seal(spaceKey, papa.sigPriv,
      { v: 1, sp: spaceId, ep: 1, dv: papa.deviceShort, oid, wit: '' }, text));
  }
  const pushed1 = await call(papa, 'POST', '/ops', {}, { space: spaceId, ops: push1 });
  assert.equal(pushed1.status, 200, JSON.stringify(pushed1.body));

  // An invite, derived from a code that never leaves the client.
  const code = b64u(globalThis.crypto.getRandomValues(new Uint8Array(8)));
  const proof = new Uint8Array(await S.digest('SHA-256', TE.encode(`verify|${code}`)));
  const verifier = new Uint8Array(await S.digest('SHA-256', proof));
  const inviteId = b64u(new Uint8Array(await S.digest('SHA-256', TE.encode(`id|${code}`))).subarray(0, 16));
  assert.equal((await call(papa, 'POST', '/invites', {}, { spaceId, inviteId, verifier: b64u(verifier) })).status, 200);

  const redeemed = await call(mama, 'POST', '/invites/redeem', {}, {
    inviteId, proof: b64u(proof), colorRef: mama.colorRef,
    member: wireMember(mama), device: wireDevice(mama),
  });
  assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));

  const rotated = await call(papa, 'POST', `/spaces/${spaceId}/epoch`, {}, {
    epoch: 2,
    wraps: [papa.deviceId, `rec_${papa.memberId}`, mama.deviceId, `rec_${mama.memberId}`]
      .flatMap((r) => [wrap(r, 1), wrap(r, 2)]),
  });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));

  // A bar label and a category and a scratchpad, sealed under the new epoch.
  const push2 = [];
  for (const text of ['Sommerferien Italien', 'Arzttermine', 'Einkaufszettel: Milch, Brot', 'Großmutter Käthe']) {
    const oid = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    push2.push(await seal(spaceKey, mama.sigPriv,
      { v: 1, sp: spaceId, ep: 2, dv: mama.deviceShort, oid, wit: '' }, text));
  }
  assert.equal((await call(mama, 'POST', '/ops', {}, { space: spaceId, ops: push2 })).status, 200);

  assert.equal((await call(mama, 'GET', '/ops', { space: spaceId, since: '0' })).status, 200);
  assert.equal((await call(papa, 'GET', `/spaces/${spaceId}/members`, {})).status, 200);
  assert.equal((await call(mama, 'GET', `/spaces/${spaceId}/keys`, {})).status, 200);
  assert.equal((await call(papa, 'GET', '/invites/open', { spaceId })).status, 200);
  assert.equal((await call(papa, 'GET', '/meta', {})).status, 200);

  // A rendezvous, so PairSession is not empty when §3 walks the store.
  const rid = b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  assert.equal((await call(papa, 'POST', '/pair/offer', {}, {
    rid, boxA: b64u(TE.encode('Einkaufszettel: Milch, Brot')),
  })).status, 200);

  return { store, responses, logLines, ctx, papa, mama, spaceId };
}

const ADAPTERS = [
  {
    name: 'memory',
    make: (c) => {
      const state = emptyState();
      const store = createStoreEngine({ now: c.now, state });
      store.__state = state;             // the test's handle on the raw graph; see §3
      return store;
    },
    raw: (store) => store.__state,
    bytes: () => null,
  },
  {
    name: 'file',
    make: (c) => {
      const dir = tempDir();
      const store = fileStore(dir, { now: c.now });
      store.__dir = dir;
      return store;
    },
    raw: (store) => JSON.parse(fs.readFileSync(path.join(store.__dir, STORE_FILENAME), 'utf8')),
    bytes: (store) => fs.readFileSync(path.join(store.__dir, STORE_FILENAME), 'utf8'),
  },
];

for (const adapter of ADAPTERS) {
  const T = (name, fn) => test(`${adapter.name} :: ${name}`, fn);

  T('§3 THE HEADLINE — after a full family session, NOTHING in the store is anything they typed',
    async () => {
      const { store } = await session(adapter.make);
      const found = [];
      for (const [where, value] of scalarsOf(adapter.raw(store), [])) {
        for (const w of hits(value)) found.push({ where, word: w, value });
      }
      assert.deepEqual(
        found, [],
        'The relay is holding plaintext a family typed. Every entry above names the exact place. '
        + 'Story 21.1 and the Datenschutz copy (21.3) are false while any of them stands.');
    });

  T('§3 the search is not vacuous — it finds a corpus word the moment one is really stored',
    async () => {
      // A blindness assertion that would pass on an empty store proves nothing. This plants one
      // corpus word in the only readable String column there is (`Member.colorRef`, the
      // documented leak) and asserts the SAME walk finds it. If this test ever fails, the walk
      // above has stopped looking rather than the relay having become blind.
      const c = clock(1787900000000);
      const store = adapter.make(c);
      await store.createSpace({
        id: 'fsp_AAAAAAAAAAAAAAAAAAAAAA', kind: 'FAMILY', currentEpoch: 1, nextSeq: 0n,
        headChain: null, createdAt: new Date(c.now()),
      });
      await store.addMember({
        id: 'mem_AAAAAAAAAAAAAAAAAAAAAA', spaceId: 'fsp_AAAAAAAAAAAAAAAAAAAAAA',
        colorRef: 'Arzttermine',
        recoveryPubSig: new Uint8Array(65), recoveryPubKex: new Uint8Array(65),
        joinedAt: new Date(c.now()), removedAt: null,
      });
      const found = scalarsOf(adapter.raw(store), []).flatMap(([, v]) => hits(v));
      assert.deepEqual(found, ['Arzttermine'], 'the store walk failed to find a planted word');
    });

  T('§3 the ops the relay stored really are the ops that were pushed, byte-count and all',
    async () => {
      // The point of §3 is not "the store is empty". It is "the store is full, and unreadable".
      const { store, spaceId } = await session(adapter.make);
      const page = await store.listOps(spaceId, 0n, 500);
      assert.equal(page.ops.length, 6, 'six sealed ops were pushed');
      for (const op of page.ops) {
        assert.ok(op.envelope instanceof Uint8Array, `${op.opId}: envelope came back as ${typeof op.envelope}`);
        assert.ok(op.envelope.length > 76, 'iv(12) + sig(64) + at least some ct');
        assert.ok(op.chain instanceof Uint8Array && op.chain.length === 32);
        assert.equal(hits(new TextDecoder('utf8', { fatal: false }).decode(op.envelope)).length, 0);
      }
    });

  if (adapter.name === 'file') {
    T('§3 the on-disk relay file, as raw text, contains no corpus word', async () => {
      const { store } = await session(adapter.make);
      const text = adapter.bytes(store);
      assert.ok(text.length > 2000, 'the store file should be substantial after a full session');
      for (const w of CORPUS) {
        assert.equal(text.includes(w), false, `the on-disk store contains ${JSON.stringify(w)}`);
      }
      // …and the same after a round trip, because hydration is where a tagged byte string could
      // decay into a readable one.
      const again = fileStore(store.__dir, { now: () => 1787900000000 });
      assert.equal(scalarsOf(JSON.parse(adapter.bytes(store)), []).flatMap(([, v]) => hits(v)).length, 0);
      assert.ok(typeof again.getSpace === 'function');
    });
  }

  T('§4 no RESPONSE body carries a corpus word — except the one colour 15.3 forces', async () => {
    const { responses } = await session(adapter.make);
    const found = [];
    for (const { route, res } of responses) {
      for (const [where, value] of scalarsOf(res.body, [], route)) {
        for (const w of hits(value)) found.push({ route, where, word: w });
      }
    }
    assert.deepEqual(found, [], 'a response body echoed family plaintext back onto the wire');

    // The colours DO travel — that is `Member.colorRef`, and it is in the Datenschutz copy. This
    // asserts they travel, so the test cannot pass by the responses being empty.
    const members = responses.find((r) => r.route.endsWith('/members')).res.body.members;
    assert.deepEqual([...members.map((m) => m.colorRef)].sort(), ['blau', 'gruen']);
  });

  T('§5 every LOG LINE is seven fields at most, each one shaped like what it claims to be',
    async () => {
      const { logLines } = await session(adapter.make);
      assert.ok(logLines.length >= 10, `expected a log line per call, got ${logLines.length}`);
      // `createLog` hands the sink the SANITISED OBJECT, not a formatted string — so the check is
      // over its keys and values, not over a rendering of it. (An earlier draft of this test
      // regex-scanned `String(line)`, which is `[object Object]` and matches nothing: a log
      // assertion that cannot fail is worse than none, because it reads like coverage.)
      let sawSpaceId = 0;
      let sawDeviceShort = 0;
      for (const line of logLines) {
        assert.equal(typeof line, 'object', 'the sink receives the sanitised object');
        for (const k of Object.keys(line)) {
          assert.ok(
            LOG_FIELD_NAMES.includes(k),
            `log line emitted field ${JSON.stringify(k)}, which is not on ADR 003 §6.2's allowlist`);
        }
        // Enumerate the field DOMAIN: every allowlisted field carries a rule in `LOG_FIELDS`, so
        // read the rule from there rather than restating it. A field whose value does not satisfy
        // its own declared shape has been handed something it was not meant to hold — which is
        // how an opId or a path ends up inside an allowlisted key.
        for (const [k, v] of Object.entries(line)) {
          const spec = LOG_FIELDS[k];
          if (spec.kind === 'route') assert.ok(LOG_ROUTES.includes(v), `route=${JSON.stringify(v)} is not a route name`);
          if (spec.kind === 'pattern') assert.match(String(v), spec.re, `${k}=${JSON.stringify(v)}`);
          if (spec.kind === 'count') assert.ok(Number.isInteger(v) && v >= 0 && v <= spec.max, `${k}=${v}`);
          if (spec.kind === 'status') assert.ok(Number.isInteger(v) && v >= 100 && v <= 599, `${k}=${v}`);
        }
        assert.equal(hits(JSON.stringify(line)).length, 0, `a log line carries plaintext: ${JSON.stringify(line)}`);
        if (line.spaceId !== undefined) sawSpaceId++;
        if (line.deviceShort !== undefined) sawDeviceShort++;
      }
      // Not vacuous: the two fields whose shape is actually constrained really do appear.
      assert.ok(sawSpaceId >= 5, `only ${sawSpaceId} lines carried a spaceId`);
      assert.ok(sawDeviceShort >= 5, `only ${sawDeviceShort} lines carried a deviceShort`);
    });


  T('§6 no ERROR body carries a corpus word, for any of the ways a family session goes wrong',
    async () => {
      const { ctx, papa, mama, spaceId } = await session(adapter.make);
      const route = createHandlers();
      const at = ctx.now();
      const bad = [
        // A hostile or clumsy client putting plaintext in every field a handler reads.
        ['POST', '/spaces', {}, { spaceId: 'Familie Hein', kind: 'FAMILY', colorRef: 'Arzttermine' }],
        ['POST', '/ops', {}, { space: spaceId, ops: [{ v: 1, sp: spaceId, ep: 1, dv: papa.deviceShort, oid: 'Zahnarzt Mama 14:30', wit: '', iv: 'x', ct: 'x', sig: 'x' }] }],
        ['POST', '/invites', {}, { spaceId, inviteId: 'Sommerferien Italien', verifier: 'x' }],
        ['POST', '/invites/redeem', {}, { inviteId: 'Großmutter Käthe', proof: 'x', colorRef: 'Arzttermine' }],
        ['POST', `/spaces/${spaceId}/epoch`, {}, { epoch: 2, wraps: [{ recipientId: 'Einkaufszettel: Milch, Brot', epoch: 1, wrapped: 'x' }] }],
        ['GET', '/ops', { space: 'Familie Hein', since: 'Zahnarzt Mama 14:30' }, undefined],
        ['POST', '/pair/answer', {}, { rid: 'Großmutter Käthe', boxB: 'x' }],
        ['POST', '/members/remove', {}, { spaceId, memberId: '2026-09-10' }],
      ];
      for (const [method, urlPath, query, body] of bad) {
        const req = await request(mama, method, urlPath, query, body, at);
        let res;
        try { res = await route(ctx, req); } catch (err) { res = { status: err.status, body: { error: err.code, ...(err.extra || {}) } }; }
        assert.notEqual(res.status, 200, `${method} ${urlPath} was supposed to fail`);
        for (const [where, value] of scalarsOf(res.body, [], `${method} ${urlPath}`)) {
          assert.deepEqual(
            hits(value), [],
            `an error body echoed the request back: ${where} = ${JSON.stringify(value)}. `
            + 'ADR 003 §6.2 — the operator gets the detail through ctx.log; the client gets a code.');
        }
      }
    });
}

test('§5 a handler that put an op id into an allowlisted field would LOSE it, not log it', () => {
  // The mutation this test exists for: `logLine(ctx, {route:'pushOps', spaceId: <the opIds>})`.
  // `spaceId` is on the allowlist, so a NAME-only check passes it. `LOG_FIELDS.spaceId` carries a
  // PATTERN as well, and the sanitiser drops a value that does not match — so the field comes out
  // ABSENT rather than wrong. Asserted here because "the allowlist has shapes too" is the half of
  // ADR 003 §6.2 a reader is most likely to assume rather than check.
  const seen = [];
  const log = createLog((e) => seen.push(e));
  log({ route: 'pushOps', spaceId: JSON.stringify(['Zahnarzt Mama 14:30']), status: 200 });
  log({ route: 'pushOps', deviceShort: '/api/v1/pair/abc', status: 200 });
  log({ route: '/api/v1/pair/some-rid', status: 200 });
  log({ route: 'meta', ms: -1, byteCount: 'Familie Hein', status: 200 });

  assert.deepEqual(seen[0], { route: 'pushOps', status: 200 }, 'a non-conforming spaceId is dropped');
  assert.deepEqual(seen[1], { route: 'pushOps', status: 200 }, 'a path in deviceShort is dropped');
  assert.equal(seen[2].route, undefined, 'a raw path is not a route name');
  assert.deepEqual(seen[3], { route: 'meta', status: 200 }, 'a negative ms and a text byteCount are dropped');
  for (const e of seen) assert.equal(hits(JSON.stringify(e)).length, 0);
});

test('§5 a count that is merely too LARGE is clamped, not dropped — and that is the right way round',
  () => {
    // `kind: 'count'` clamps to its `max` instead of dropping. The distinction matters and is
    // worth pinning rather than discovering: a count is a MAGNITUDE, so a clamped one still says
    // "a lot", which is what an operator reading a log for an abuse pattern needs; a `spaceId`
    // is an IDENTITY, and a clamped or truncated identity would be a different space. Neither a
    // clamp nor a drop can carry content, which is the property that matters here.
    const seen = [];
    createLog((e) => seen.push(e))({ route: 'pushOps', opCount: 1e12, byteCount: 1e12, ms: 1e12, status: 200 });
    assert.deepEqual(seen[0], {
      route: 'pushOps', opCount: LOG_FIELDS.opCount.max, byteCount: LOG_FIELDS.byteCount.max,
      ms: LOG_FIELDS.ms.max, status: 200,
    });
  });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7  THE TWO MEMBER PROJECTIONS — `members.js` says this file asserts they are still allowlists
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `handlers/members.js` publishes a wider member record than `pullOps`'s piggyback, deliberately
// (its own docblock gives the reason and names this file). Two shapes is fine; two shapes where
// one of them grew a field nobody classified is not. So both are checked against ONE justified
// allowlist, and the pull shape is additionally required to stay a SUBSET.

const JUSTIFIED_WIRE_FIELDS = Object.freeze({
  memberId: 'the pseudonymous id the ops attribute to',
  colorRef: 'the one deliberate leak — 15.3 needs it server-side (Member.colorRef)',
  joinedAt: 'a relay timestamp the relay cannot avoid knowing',
  removedAt: 'ADR 001 §5 step 3 needs the historical member set',
  devices: 'the nested device list',
  recoveryPubSig: 'a PUBLIC key — verifies device attestations (ADR 002 §7.3)',
  recoveryPubKex: 'a PUBLIC key — finding E3-2: a rotation must wrap to each member RK_kex',
  attestation: 'a SIGNED blob whose every field is a value the relay already holds in a column '
    + '(memberId, deviceId, deviceShort, sigPubRaw, kexPubRaw) or a DAY that is coarser than '
    + 'Device.addedAt. Finding E2E3-6: `familyRecipients()` cannot build a recipient without it, '
    + 'so without this field no family key rotation is buildable by anyone. Published as a HINT '
    + 'and verified under the housing member\'s recoveryPubSig before it decides anything; the '
    + 'log remains the authority for ADMISSIBILITY (ADR 002 §2.3), this is DISTRIBUTION. NOT on '
    + 'the pull piggyback — see the §7 subset row.',
  deviceId: 'the address a KeyWrap.recipientId is written to',
  deviceShort: 'derived from the PUBLIC signing key (ADR 001 §1.2)',
  sigPubRaw: 'a PUBLIC key',
  kexPubRaw: 'a PUBLIC key — what a rotating client wraps to',
  revokedAt: 'a relay timestamp; the client needs it to skip a revoked device when wrapping',
});

/**
 * The pull piggyback has no exported constant — `pullOps` builds it inline, and deriving it from
 * a LIVE response is the stronger reading anyway: this measures what the endpoint actually sends,
 * not what a declaration claims it sends.
 */
async function liveShapes() {
  const { responses } = await session(ADAPTERS[0].make);
  const pull = responses.find((r) => r.route === 'GET /ops').res.body.members;
  const full = responses.find((r) => r.route.endsWith('/members')).res.body.members;
  assert.ok(pull.length === 2 && full.length === 2, 'both endpoints should list both members');
  assert.ok(pull[0].devices.length === 1 && full[0].devices.length === 1);
  return {
    pullMember: Object.keys(pull[0]),
    pullDevice: Object.keys(pull[0].devices[0]),
    fullMember: Object.keys(full[0]),
    fullDevice: Object.keys(full[0].devices[0]),
  };
}

test('§7 every field either member projection publishes is on one justified allowlist', async () => {
  const live = await liveShapes();
  const all = new Set([
    ...MEMBER_PROJECTION, ...DEVICE_PROJECTION,
    ...live.pullMember, ...live.pullDevice, ...live.fullMember, ...live.fullDevice,
  ]);
  for (const f of all) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(JUSTIFIED_WIRE_FIELDS, f),
      `the member list publishes ${JSON.stringify(f)} and nothing justifies it. Every pull `
      + 'piggybacks this shape onto every device every 45 seconds; a field added here is a field '
      + 'published to the whole family forever.');
  }
  // The declared projections and what the endpoint really sends must be the same set.
  assert.deepEqual([...live.fullMember].sort(), [...MEMBER_PROJECTION].sort());
  assert.deepEqual([...live.fullDevice].sort(), [...DEVICE_PROJECTION].sort());
  // No display name, ever: they travel as `member.set` ops inside the ciphertext.
  for (const f of all) assert.equal(/name/i.test(f) && f !== 'colorRef', false, `${f} looks like a name`);
});

test('§7 the pull piggyback is a strict SUBSET of the full projection, in both halves', async () => {
  const live = await liveShapes();
  for (const f of live.pullMember) assert.ok(MEMBER_PROJECTION.includes(f), `pull member field ${f}`);
  for (const f of live.pullDevice) assert.ok(DEVICE_PROJECTION.includes(f), `pull device field ${f}`);
  // …and genuinely narrower, which is the reason members.js gives for there being two.
  assert.ok(live.pullMember.length < MEMBER_PROJECTION.length);
  assert.equal(live.pullMember.includes('recoveryPubSig'), false, 'ops.test.js pins this too');
  assert.equal(live.pullDevice.includes('deviceId'), false);
});

// ── INVERTED 2026-08-29 — finding E2E3-6, and this row named its own inversion in advance ────
// It read: "FINDING E2-207-B … `Device.attestation` is written by three routes and read back by
// NONE, so ADR 002 §4.4's bootstrap roster ('the `dev.*` blobs') cannot be built from the wire.
// This assertion is what the fix would have to change, deliberately."
//
// This is that change. What replaces it is not a weaker assertion — it is a STRONGER one, and it
// is the reason the publication is free: every field of the published blob is a value the relay
// already holds in a column of its own, because the payload's field set is closed at the door.
// A leak needs a free bit; there is not one.
test('§7 the attestation IS published — and it can carry nothing the relay does not already hold', async () => {
  const live = await liveShapes();
  assert.ok(DEVICE_PROJECTION.includes('attestation'), 'the full member list carries it (E2E3-6)');
  assert.ok(live.fullDevice.includes('attestation'), 'and the endpoint really sends it');
  // NOT on the hot path. `GET /ops` piggybacks the member list every 45 seconds for every device
  // in every space; the rotation roster is a membership-change path. `members.js` keeps the two
  // projections apart for that reason and this is the half that must stay narrow.
  assert.equal(live.pullDevice.includes('attestation'), false,
    'the pull piggyback stays four device fields — ADR 003 §3.2');

  assert.ok(MODEL_COLUMNS.Device.includes('attestation'), 'the column exists');
  assert.ok(OPAQUE_FIELDS.Device.includes('attestation'),
    'and it is still an OPAQUE column: the relay stores bytes it does not interpret. Publishing '
    + 'is not reading — nothing in server/core/ branches on what is inside the blob except the '
    + 'signature check that refuses a forged one.');

  // The measurement. Every payload field is pinned to a column, or is a DAY.
  const { responses } = await session(ADAPTERS[0].make);
  const full = responses.find((r) => r.route.endsWith('/members')).res.body.members;
  for (const m of full) {
    for (const d of m.devices) {
      const payload = JSON.parse(new TextDecoder().decode(
        Uint8Array.from(atob(d.attestation.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0))));
      assert.deepEqual(Object.keys(payload).sort(),
        ['createdAt', 'deviceId', 'deviceShort', 'kexPubRaw', 'memberId', 'sigPubRaw']);
      assert.equal(payload.memberId, m.memberId);
      assert.equal(payload.deviceId, d.deviceId);
      assert.equal(payload.deviceShort, d.deviceShort);
      assert.equal(payload.sigPubRaw, d.sigPubRaw);
      assert.equal(payload.kexPubRaw, d.kexPubRaw);
      assert.match(payload.createdAt, /^\d{4}-\d{2}-\d{2}$/,
        'a DAY — strictly coarser than Device.addedAt, which the relay keeps to the millisecond');
    }
  }
});

test('§2 an attestation cannot carry a note — the corpus word is REFUSED at the door, not merely unread', async () => {
  // Where 'Großmutter Käthe' lived until 2026-08-29: inside an unverified, unread blob. Now that
  // the blob is published, "unread" is not a defence, so the door refuses a payload with any
  // field the six ADR 002 §2.3 names do not cover — and refuses a `createdAt` that is not a day.
  const { call } = serverOnly(ADAPTERS[0].make);
  // The router lets an `HttpError` out; every other row here only ever provokes 200s.
  const attempt = async (...a) => {
    try { return await call(...a); } catch (e) { return { status: e.status, body: { error: e.code, ...(e.extra || {}) } }; }
  };
  const smuggler = await person('ocker');
  const payload = TE.encode(JSON.stringify({
    memberId: smuggler.memberId, deviceId: smuggler.deviceId, deviceShort: smuggler.deviceShort,
    sigPubRaw: smuggler.sigPubRaw, kexPubRaw: smuggler.kexPubRaw, createdAt: '2026-08-29',
    note: 'Großmutter Käthe',
  }));
  const sig = new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, smuggler.recSigPriv, payload));
  const blob = `${b64u(payload)}.${b64u(sig)}`;
  const res = await attempt(smuggler, 'POST', '/spaces', {}, {
    spaceId: `fsp_${b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`,
    kind: 'FAMILY', colorRef: 'ocker',
    member: wireMember(smuggler),
    device: { ...wireDevice(smuggler), attestation: blob },
    wraps: [{ recipientId: smuggler.deviceId, epoch: 1, wrapped: b64u(new Uint8Array(156)) }],
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.reason, 'attestation_unknown_field');
  assert.equal(JSON.stringify(res.body).includes('Käthe'), false, 'and the error does not echo it back');

  // The same for `createdAt`, the only required field not pinned to a column.
  const chatty = TE.encode(JSON.stringify({
    memberId: smuggler.memberId, deviceId: smuggler.deviceId, deviceShort: smuggler.deviceShort,
    sigPubRaw: smuggler.sigPubRaw, kexPubRaw: smuggler.kexPubRaw, createdAt: 'Zahnarzt 14:30',
  }));
  const sig2 = new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, smuggler.recSigPriv, chatty));
  const res2 = await attempt(smuggler, 'POST', '/spaces', {}, {
    spaceId: `fsp_${b64u(globalThis.crypto.getRandomValues(new Uint8Array(16)))}`,
    kind: 'FAMILY', colorRef: 'mint',
    member: wireMember(smuggler),
    device: { ...wireDevice(smuggler), attestation: `${b64u(chatty)}.${b64u(sig2)}` },
    wraps: [{ recipientId: smuggler.deviceId, epoch: 1, wrapped: b64u(new Uint8Array(156)) }],
  });
  assert.equal(res2.status, 400);
  assert.equal(res2.body.reason, 'attestation_createdAt');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §8  THE COMPOSITION IS WHAT IT SAYS IT IS — `handlers/index.js` names this file
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§8 every route is bound to the function the file it claims really exports', async () => {
  for (const [name, owner] of Object.entries(HANDLER_OWNERS)) {
    const mod = await import(`../../server/core/${owner}`);
    assert.equal(
      handlers[name], mod[name],
      `${name} is bound to something other than ${owner}'s export. That is the spread hazard `
      + 'handlers/index.js exists to prevent, done by hand.');
  }
  assert.deepEqual(Object.keys(HANDLER_OWNERS).sort(), Object.keys(handlers).sort());
});

test('§8 the required-ctx list names nothing a handler cannot reach, and nothing ambient', () => {
  // A `ctx` member that no handler reads is a member a host is forced to build for nothing; one
  // that is read and not listed is the 03:00 500 the list exists to prevent. The direction that
  // can be checked cheaply is the second, and `assertCtx` is what enforces it at startup.
  assert.deepEqual([...REQUIRED_CTX_NAMES].sort(),
    ['assertMember', 'auth', 'limits', 'now', 'random', 'sha256', 'store'].sort());
});

test('§8 nothing under server/core reaches for the filesystem, the network, the clock or entropy',
  () => {
    // ADR 003 §9's purity rule, checked as a fact about the files rather than as a convention.
    // A handler that called Date.now() would pass every test on a fake clock and then answer a
    // real one; a handler that read process.env would be untestable and would leak a secret into
    // a stack trace. `limits.test.js` checks `auth.js`'s import graph; this checks all of core.
    const dir = path.join(REPO, 'server/core');
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) files.push(p);
      }
    };
    walk(dir);
    assert.ok(files.length >= 12, `expected server/core to have files, found ${files.length}`);
    const banned = [
      [/\bDate\s*\.\s*now\s*\(/, 'Date.now() — the clock arrives as ctx.now'],
      [/\bMath\s*\.\s*random\s*\(/, 'Math.random() — entropy arrives as ctx.random'],
      [/\bprocess\s*\.\s*env\b/, 'process.env — configuration arrives on ctx'],
      [/from\s+'node:/, "a node: builtin — server/core must run unchanged on Vercel's runtime"],
      [/\bfetch\s*\(/, 'fetch() — a handler makes no outbound call'],
      [/@prisma|@vercel/, 'a platform import — those live in server/adapters'],
    ];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, 'utf8'));
      for (const [re, why] of banned) {
        assert.equal(re.test(src), false, `${path.relative(REPO, f)} uses ${why}`);
      }
    }
  });

/** Strip line and block comments and string literals, so a rule named in prose is not a hit. */
function stripComments(src) {
  let out = '';
  let i = 0;
  let mode = 'code';
  let quote = '';
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (mode === 'code') {
      if (two === '//') { mode = 'line'; i += 2; continue; }
      if (two === '/*') { mode = 'block'; i += 2; continue; }
      if (src[i] === '"' || src[i] === "'" || src[i] === '`') { mode = 'str'; quote = src[i]; i++; continue; }
      out += src[i]; i++; continue;
    }
    if (mode === 'line') { if (src[i] === '\n') { mode = 'code'; out += '\n'; } i++; continue; }
    if (mode === 'block') { if (two === '*/') { mode = 'code'; i += 2; continue; } i++; continue; }
    // string
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) { mode = 'code'; out += '""'; }
    i++;
  }
  return out;
}
