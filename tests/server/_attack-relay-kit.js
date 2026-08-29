// tests/server/_attack-relay-kit.js — the tooling for `attack-relay-*.test.js`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ADVERSARY: ADR 002 §0's T1 — the relay operator
// ═════════════════════════════════════════════════════════════════════════════════════════════
// T1 runs the server or holds a database dump. Concretely, in this file, T1 gets:
//
//   · `dump()` — every row of every model, exactly as it sits at rest. For the file adapter that
//     is the literal bytes on disk, because a dump is a dump and a hydration round trip is where
//     an opaque column quietly becomes a String.
//   · every log line the handlers emitted, as OBJECTS (finding from the E2 pass: regex-scanning
//     `String(line)` matches `[object Object]` and can never fail).
//   · every response body and every error body.
//   · free choice of what to RETURN to a client — §4's `lyingRelay()` wraps the real router and
//     lets T1 withhold, reorder, replay, truncate, fork and forge, without touching the store.
//
// T1 holds NO key. Nothing here ever calls a real seal with a real space key on T1's behalf. The
// content that goes in is sealed by `sealFor()` under a key that lives only in the test's own
// closure — so when a search of the dump comes back empty, it is empty for the right reason.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A SHARED FILE AND ops.test.js's HARNESS IS NOT
// ═════════════════════════════════════════════════════════════════════════════════════════════
// `tests/server/ops.test.js` duplicates its harness deliberately — "a test helper shared between
// two files is a helper that quietly changes both when it changes". That reasoning holds for a
// FIXTURE. It does not hold for an ADVERSARY: the six attack files must agree on exactly what T1
// can do, or a capability proved in one file and assumed in another is a capability nobody
// checked. `tests/attack/_kit.js` and `_crypto-relay-kit.js` make the same call for the same
// reason. This file is named with a leading underscore and does not end in `.test.js`, so
// `npm run test:server`'s glob does not run it.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// NAMING: SUCCEEDED / FAILED are from the ADVERSARY's point of view
// ═════════════════════════════════════════════════════════════════════════════════════════════
// Following `tests/attack/crypto-relay-read.test.js`. A test named SUCCEEDED characterises a real
// capability T1 has today; it is green because the capability is real and it turns red on the day
// the capability is closed, which is the only way a new defence gets noticed. A test named FAILED
// asserts the attack is refused, and it is a regression lock on the refusal.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createStoreEngine, emptyState } from '../../server/adapters/memory.js';
import { fileStore, STORE_FILENAME } from '../../server/adapters/file.js';
import { createHandlers } from '../../server/core/handlers/index.js';
import { authenticate, assertMember, canonicalQuery, signedString, b64u, ub64, deviceShortOfRaw, NONCE_BYTES } from '../../server/core/auth.js';
import { fixtures } from '../../server/core/store-interface.js';
import { HttpError, toResponse } from '../../server/core/errors.js';
import { LIMITS } from '../../server/core/limits.js';
import { pad, paddedLength } from '../../src/js/crypto/envelope.js';
import { PAD_BUCKET } from '../../src/js/crypto/suite.js';

export const SUBTLE = webcrypto.subtle;
export const TE = new TextEncoder();
export const TD = new TextDecoder();

/** 2026-06-15, a Monday, 08:00:00.000 UTC. Every clock in these files starts here. */
export const T0 = 1781510400000;
export const MINUTE = 60000;
export const HOUR = 3600000;
export const DAY = 86400000;

export { b64u, ub64, LIMITS, HttpError, toResponse };

// ─────────────────────────────────────────────────────────────────────────────
// §0 Scaffolding
// ─────────────────────────────────────────────────────────────────────────────

const tempDirs = [];
export function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-t1-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

export function fakeClock(start) {
  let t = start === undefined ? T0 : start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (ms) => { t = ms; } };
}

/**
 * The two adapters, each carrying a `dump()` that is what T1 would really have.
 *
 * `memory` hands over the live state object — the same trick `blindness.test.js` uses, by
 * constructing the engine around a state the test keeps a reference to.
 *
 * `file` re-reads `sync-store.json` from disk and hydrates it through a SECOND `fileStore`, so
 * the dump T1 inspects has been through serialisation and back. That is the round trip where a
 * `Uint8Array` could arrive as a base64 String and satisfy a naive search.
 */
export const ADAPTERS = Object.freeze([
  Object.freeze({
    name: 'memory',
    make(clock) {
      const state = emptyState();
      const store = createStoreEngine({ now: clock.now, state });
      return { store, dump: () => state, rawBytes: () => null };
    },
  }),
  Object.freeze({
    name: 'file',
    make(clock) {
      const dir = tempDir();
      const store = fileStore(dir, { now: clock.now });
      const file = path.join(dir, STORE_FILENAME);
      return {
        store,
        // A dump from the FILE, not from the live heap. `createStoreEngine` keeps `state`
        // private, so the bytes are decoded here with T1's own decoder rather than borrowed from
        // the adapter — which is also the only way a tag that decodes to the WRONG TYPE would be
        // noticed, and a JSON store is exactly where an opaque column becomes a String.
        dump: () => (fs.existsSync(file) ? decodeStateFile(fs.readFileSync(file, 'utf8')) : emptyState()),
        rawBytes: () => (fs.existsSync(file) ? fs.readFileSync(file) : null),
      };
    },
  }),
]);

function decodeTagged(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(decodeTagged);
  if (typeof v !== 'object') return v;
  if ('$b' in v) return new Uint8Array(Buffer.from(v.$b, 'base64'));
  if ('$d' in v) return new Date(v.$d);
  if ('$n' in v) return BigInt(v.$n);
  if ('$m' in v) return new Map(v.$m.map(([k, val]) => [decodeTagged(k), decodeTagged(val)]));
  if ('$o' in v) {
    const out = {};
    for (const k of Object.keys(v.$o)) out[k] = decodeTagged(v.$o[k]);
    return out;
  }
  return v;
}

function decodeStateFile(raw) {
  const parsed = JSON.parse(raw);
  const state = emptyState();
  const loaded = decodeTagged(parsed.state);
  for (const k of Object.keys(state)) if (loaded && loaded[k] instanceof Map) state[k] = loaded[k];
  return state;
}

// ─────────────────────────────────────────────────────────────────────────────
// §1 Devices, signing, and the real router
// ─────────────────────────────────────────────────────────────────────────────

let nonceCounter = 0;
export function freshNonce() {
  const b = new Uint8Array(NONCE_BYTES);
  const n = ++nonceCounter;
  b[0] = n & 255; b[1] = (n >>> 8) & 255; b[2] = (n >>> 16) & 255; b[3] = (n >>> 24) & 255;
  b[4] = 0xA7;
  return b64u(b);
}

/** A real P-256 signing key plus a real P-256 agreement key, and the deviceShort derived from it. */
export async function mintDevice(label) {
  const pair = await SUBTLE.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const sigPubRaw = new Uint8Array(await SUBTLE.exportKey('raw', pair.publicKey));
  const kex = await SUBTLE.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const kexPubRaw = new Uint8Array(await SUBTLE.exportKey('raw', kex.publicKey));
  return { label: label || 'dev', pair, sigPubRaw, kexPubRaw, deviceShort: await deviceShortOfRaw(sigPubRaw, {}) };
}

/**
 * A signed `ServerReq`, exactly as ADR 003 §2 specifies the bytes.
 * `at` is the timestamp the client stamps — a T1 test can lie about it, the server cannot.
 */
export async function signReq(o) {
  const method = o.method;
  const reqPath = o.path;
  const query = o.query || {};
  const hasBody = o.body !== undefined && o.body !== null;
  const rawBody = hasBody ? TE.encode(JSON.stringify(o.body)) : new Uint8Array(0);
  const hash = new Uint8Array(await SUBTLE.digest('SHA-256', rawBody));
  const ts = String(o.at === undefined ? T0 : o.at);
  const nonce = o.nonce || freshNonce();
  const toSign = signedString({
    method, path: reqPath, sortedQuery: canonicalQuery(query), bodyHashB64u: b64u(hash), ts, nonce,
  });
  const headers = { 'x-lzp-protocol': '1', ...(o.headers || {}) };
  if (o.dev) {
    const sig = new Uint8Array(await SUBTLE.sign({ name: 'ECDSA', hash: 'SHA-256' }, o.dev.pair.privateKey, TE.encode(toSign)));
    headers.authorization = `LZP1 device=${o.dev.deviceShort}, ts=${ts}, nonce=${nonce}, sig=${b64u(sig)}`;
  }
  return {
    method, path: reqPath, query, headers,
    body: hasBody ? o.body : null,
    rawBody,
    clientIp: o.ip,
  };
}

/**
 * The full server: the REAL `createHandlers()` composition, over a real store, with a log sink
 * T1 can read afterwards.
 *
 * `log` collects OBJECTS. The E2 pass found a test that regex-scanned `String(line)` and was
 * therefore matching `[object Object]` for ever; `logText()` below serialises properly.
 */
export function relay(harness, clock, over) {
  const lines = [];
  const ctx = {
    store: harness.store,
    now: () => clock.now(),
    random: (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 37 + 11) & 255; return b; },
    sha256: async (bytes) => new Uint8Array(await SUBTLE.digest('SHA-256', bytes)),
    log: (evt) => { lines.push(evt); },
    limits: LIMITS,
    subtle: SUBTLE,
    ...over,
  };
  if (!ctx.auth) ctx.auth = (req) => authenticate(req, ctx);
  if (!ctx.assertMember) ctx.assertMember = (m, s) => assertMember(m, s, ctx);
  const route = createHandlers();

  /** Send one request and get `{status, headers, body}` — errors shaped exactly as the wire. */
  async function send(o) {
    const req = await signReq(o);
    try {
      const res = await route(ctx, req);
      return { status: res.status, headers: res.headers || {}, body: res.body };
    } catch (err) {
      if (err instanceof HttpError) return toResponse(err);
      throw err;
    }
  }

  return { ctx, send, lines, logText: () => lines.map((l) => JSON.stringify(l)).join('\n') };
}

// ─────────────────────────────────────────────────────────────────────────────
// §2 A family, seeded into the store the way the relay would find it
// ─────────────────────────────────────────────────────────────────────────────

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function id22(seed) {
  let s = '';
  let x = seed >>> 0;
  for (let i = 0; i < 22; i++) { s = B64U[x % 64] + s; x = Math.floor(x / 64) + 7; }
  return s;
}
export const memberId = (n) => `mem_${id22(0x51000 + n * 977)}`;
export const deviceId = (n) => `dev_${id22(0x77000 + n * 613)}`;
export const opId = (n) => id22(0x10000 + n * 2654435);

/**
 * @param {Object} h        an adapter harness from ADAPTERS[i].make(clock)
 * @param {Object} clock
 * @param {Object} spec     { id, kind, members: [{ name, colorRef, devices: n, joinedAt }] }
 * @returns {Promise<{spaceId, members: Array<{id, colorRef, name, devices: Array<Device>}>}>}
 */
export async function seedSpace(h, clock, spec) {
  const spaceId = spec.id;
  await h.store.createSpace(fixtures.space({
    id: spaceId, kind: spec.kind || 'FAMILY', currentEpoch: spec.epoch || 1,
    createdAt: new Date(spec.createdAt === undefined ? clock.now() : spec.createdAt),
  }));
  const out = [];
  let mi = spec.memberSeed === undefined ? 1 : spec.memberSeed;
  let di = spec.deviceSeed === undefined ? 1 : spec.deviceSeed;
  for (const m of spec.members) {
    const mid = m.id || memberId(mi++);
    await h.store.addMember(fixtures.member({
      id: mid, spaceId, colorRef: m.colorRef,
      joinedAt: new Date(m.joinedAt === undefined ? clock.now() : m.joinedAt),
      removedAt: m.removedAt === undefined ? null : new Date(m.removedAt),
    }));
    const devs = [];
    for (let k = 0; k < (m.devices === undefined ? 1 : m.devices); k++) {
      const dev = await mintDevice(`${m.name}#${k}`);
      dev.id = m.deviceIds && m.deviceIds[k] ? m.deviceIds[k] : deviceId(di++);
      dev.memberId = mid;
      dev.spaceId = spaceId;
      await h.store.addDevice(fixtures.device({
        id: dev.id, memberId: mid, deviceShort: dev.deviceShort,
        sigPubRaw: dev.sigPubRaw, kexPubRaw: dev.kexPubRaw,
        addedAt: new Date(m.addedAt === undefined ? clock.now() : m.addedAt),
      }));
      devs.push(dev);
    }
    out.push({ id: mid, colorRef: m.colorRef, name: m.name, devices: devs });
  }
  return { spaceId, members: out };
}

/**
 * Register an existing device object into a SECOND space, under a new member row.
 * This is how a real person in two circles looks to the relay: one machine, one key pair, two
 * `Member` rows — and it is the whole of §3's correlation attack.
 */
export async function alsoJoin(h, clock, spaceId, dev, o) {
  const mid = (o && o.memberId) || memberId(9000 + Math.floor(Math.random() * 1000));
  await h.store.addMember(fixtures.member({
    id: mid, spaceId, colorRef: (o && o.colorRef) || 'blau', joinedAt: new Date(clock.now()),
  }));
  const newId = (o && o.deviceId) || deviceId(9000 + Math.floor(Math.random() * 1000));
  await h.store.addDevice(fixtures.device({
    id: newId, memberId: mid, deviceShort: dev.deviceShort,
    sigPubRaw: dev.sigPubRaw, kexPubRaw: dev.kexPubRaw, addedAt: new Date(clock.now()),
  }));
  return { memberId: mid, deviceId: newId };
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 Real content, really sealed, under a key T1 never sees
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ADR 002 §5.3's padding — THE PRODUCT'S, not a copy of it.
 *
 * `pad()` and `PAD_BUCKET` are imported from `src/js/crypto/envelope.js` and
 * `src/js/crypto/suite.js` so that `attack-relay-infer.test.js`'s `len(envelope) = 92 + 256k`
 * is a statement about the shipped sealer. A local re-implementation would make that test
 * circular — it would prove the kit's own arithmetic and nothing about the relay.
 */
export { PAD_BUCKET, pad };
export const paddedLen = paddedLength;

/** The German a family really types. Every search in these files looks for these bytes. */
export const SECRETS = Object.freeze([
  'Zahnarzt Mama 14:30',
  'Familie Hein',
  'Papa',
  'Elternabend Grundschule',
  'Scheidungstermin Anwalt Dr. Weber',
  'Urlaub Mallorca',
]);

/** A space key that lives in the test's closure and is never handed to the relay in any form. */
export async function spaceKey() {
  return SUBTLE.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/**
 * Seal one piece of plaintext into a wire envelope, with the ADR's padding and AAD.
 *
 * This is not `src/js/crypto/envelope.js`'s `sealOp`: that one validates the op against
 * `core/ops.js` and runs ADR 004's redaction gate, neither of which the RELAY can observe. What
 * it is instead is the same construction reduced to the three things T1 sees, each of them
 * faithful: real AES-256-GCM, the SHIPPED padding (`pad()` is imported, not re-implemented — so
 * `92 + 256k` is a fact about the product), and the six AAD fields as the plaintext header.
 */
export async function sealFor(key, dev, o) {
  const plain = TE.encode(JSON.stringify(o.op));
  const padded = pad(plain);          // the shipped `varint(len) ‖ bytes ‖ zeros`, §5.3
  const iv = new Uint8Array(12);
  const n = o.n || 1;
  for (let i = 0; i < 12; i++) iv[i] = (n * 31 + i * 7) & 255;
  const hdr = {
    v: 1, sp: o.space, ep: o.epoch || 1, dv: dev.deviceShort, oid: o.oid || opId(n),
    wit: o.wit === undefined ? '' : o.wit,
  };
  const aad = TE.encode(`lzp/v2/op\n${JSON.stringify([hdr.v, hdr.sp, hdr.ep, hdr.dv, hdr.oid, hdr.wit])}`);
  const ct = new Uint8Array(await SUBTLE.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, padded));
  const sig = new Uint8Array(await SUBTLE.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.pair.privateKey,
    new Uint8Array([...aad, ...iv, ...ct])));
  return { ...hdr, iv: b64u(iv), ct: b64u(ct), sig: b64u(sig) };
}

// ─────────────────────────────────────────────────────────────────────────────
// §4 The lying relay — T1's real power
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap a `send` so T1 can rewrite a pull response before the client sees it.
 *
 * NOTHING HERE TOUCHES THE STORE. That is the point: every one of these is something the running
 * server can do to one member, silently, while the database stays honest and every other member
 * sees the truth. It is the shape of the attack ADR 002 §5.4 says the chain witness exists to
 * detect, and §8.6 says is detected best-effort.
 *
 * @param {(o:Object)=>Promise<Object>} send
 * @param {(body:Object, req:Object)=>Object} rewrite  return a new body, or the same one
 */
export function lyingRelay(send, rewrite) {
  return async (o) => {
    const res = await send(o);
    if (res.status !== 200) return res;
    return { ...res, body: rewrite(res.body, o) };
  };
}

/** The chain the SERVER computes: `chain_n = SHA-256(chain_{n-1} ‖ utf8(opId_n))`. */
export async function chainAfter(prev, oid) {
  const idb = TE.encode(oid);
  const buf = new Uint8Array((prev ? prev.length : 0) + idb.length);
  if (prev) buf.set(prev, 0);
  buf.set(idb, prev ? prev.length : 0);
  return new Uint8Array(await SUBTLE.digest('SHA-256', buf));
}

/**
 * THE DETECTOR THE CONTRACT DECLARES AND NOBODY HAS WRITTEN.
 *
 * `docs/v2/contracts/sync.contract.js` line "Diagnostic only; never blocks sync in v2" exports
 * `verifyChain(ops, lastChain)` as a stub that throws `not implemented`. This is that function,
 * written here in five lines, so the attack files can measure WHICH lies it would catch and which
 * it would not — a capability question that cannot be answered by noting the stub is a stub.
 *
 * @param {Array<{oid:string, chain:string}>} ops   a pull page, in the order served
 * @param {Uint8Array|null} lastChain               the chain of the last op this client folded
 * @returns {{ok:boolean, brokeAt:number|null}}
 */
export async function verifyChainHere(ops, lastChain) {
  let prev = lastChain;
  for (let i = 0; i < ops.length; i++) {
    const want = await chainAfter(prev, ops[i].oid);
    const got = ub64(ops[i].chain);
    if (!got || got.length !== want.length || want.some((b, j) => b !== got[j])) {
      return { ok: false, brokeAt: i };
    }
    prev = got;
  }
  return { ok: true, brokeAt: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// §5 Searching a dump, and the control that proves the search is not vacuous
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every readable string anywhere in a state object: every Map, every row, every value, plus the
 * base64 and hex spellings of every byte array — because "the search found nothing" is only
 * meaningful if a byte array holding the text would have been found.
 *
 * @param {Object} state @returns {string[]}
 */
export function readableStrings(state) {
  const out = [];
  const seen = new Set();
  const walk = (v, depth) => {
    if (v === null || v === undefined || depth > 12) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') { out.push(String(v)); return; }
    if (v instanceof Uint8Array) {
      // The three spellings a byte column could hide text in.
      out.push(Buffer.from(v).toString('utf8'));
      out.push(Buffer.from(v).toString('latin1'));
      try { out.push(Buffer.from(Buffer.from(v).toString('utf8'), 'base64').toString('utf8')); } catch { /* not base64 */ }
      return;
    }
    if (v instanceof Date) { out.push(v.toISOString()); return; }
    if (v instanceof Map) { for (const [k, val] of v) { walk(k, depth + 1); walk(val, depth + 1); } return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);
      for (const k of Object.keys(v)) { out.push(k); walk(v[k], depth + 1); }
    }
  };
  walk(state, 0);
  return out;
}

/** @returns {string[]} the needles that were found — empty means the relay stayed blind. */
export function findText(haystackStrings, needles) {
  const hit = [];
  for (const needle of needles) {
    for (const s of haystackStrings) {
      if (typeof s === 'string' && s.includes(needle)) { hit.push(needle); break; }
    }
  }
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────
// §6 Story 21.3 — is this inference DOCUMENTED?
// ─────────────────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const METADATA_DOC_PATH = path.resolve(HERE, '../../docs/v2/server-metadata.md');
export const METADATA_DOC = fs.readFileSync(METADATA_DOC_PATH, 'utf8');

/**
 * Assert that `docs/v2/server-metadata.md` really names this inference.
 *
 * The task's rule: an inference T1 can draw that the Datenschutz source document does not name is
 * a finding against story 21.3, not a finding against the server. So every SUCCEEDED metadata
 * test ends with this call, and the call fails if the document is silent — which is what makes
 * "we wrote it down" a test result rather than a claim.
 *
 * `phrases` are matched case-insensitively as substrings. Keep them short and load-bearing: a
 * whole sentence would break on a comma and stop protecting anything.
 *
 * @param {Object} assert @param {string} what @param {string[]} phrases
 */
export function assertDocumented(assert, what, phrases) {
  const doc = METADATA_DOC.toLowerCase();
  const missing = phrases.filter((p) => !doc.includes(p.toLowerCase()));
  assert.deepEqual(missing, [],
    `UNDOCUMENTED INFERENCE — finding against story 21.3.\n` +
    `  T1 can derive: ${what}\n` +
    `  docs/v2/server-metadata.md does not contain: ${JSON.stringify(missing)}\n` +
    `  Either the document gains a sentence or this capability is closed.`);
}

/** The same question, answered rather than asserted — for a test that reports both ways. */
export function documents(phrases) {
  const doc = METADATA_DOC.toLowerCase();
  return phrases.every((p) => doc.includes(p.toLowerCase()));
}
