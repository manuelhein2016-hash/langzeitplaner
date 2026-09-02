// tests/server/limits.test.js — LZP-205: payload caps, rate limits, and logs that cannot leak.
// ADR 003 §6 · ADR 002 §6.2, §7.1 · stories 21.3, 21.4.
//
// This file also carries what ADR 003 §6.2 calls `tests/server/log-redaction.test.js`. The
// content is here rather than in a second file because LZP-205 owns one clause of the ADR
// (§6 — "abuse basics, retention, logging") and the repository's rule is one owner per file;
// the redaction cases are in §7 below and are named so a grep for "log-redaction" finds them.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS ACTUALLY BEING PROVED, AND WHAT IS NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// The crypto red team's finding about E3 was that server-side controls "exist in a contract and
// in no code that runs". The honest statement of what this file achieves against that:
//
//   PROVED HERE, against BOTH the memory and the file adapter, by code that really runs:
//     · the limiter admits exactly `max` and then 429s, including under 25 concurrent callers;
//     · the window really re-opens, and the tumbling boundary really admits up to 2×max;
//     · a 429 really carries `Retry-After`;
//     · every fail-closed path (broken adapter, unknown rule, absent identity) really denies;
//     · a bucket key really cannot be forged into a neighbour's budget;
//     · a header full of German prose really cannot reach `RateBucket.key` — asserted against
//       the file adapter's on-disk JSON, which is the actual database in the dev host;
//     · the sanitiser really drops every field ADR 003 §6.2 forbids, including ones nobody has
//       named yet, because it reads from the allowlist instead of enumerating its input.
//
//   NOT PROVED HERE, and said out loud rather than implied:
//     · that the real handlers charge THESE buckets. LZP-202..204's handlers landed alongside
//       this file with their own `enforceRate` helper over their own key namespace, and their own
//       comments hand that namespace to LZP-205. So §7's last gate follows the CALL GRAPH and
//       asserts the property that matters — every route with a declared rule really reaches
//       `store.rateAllow` — rather than asserting that `enforceFor` in particular was called.
//       Converging the two, and choosing whether `withLimits` is composed at the router at all,
//       is LZP-207's call: see the INTEGRATION WARNING in limits.js, because composing it over
//       handlers that already self-limit would DOUBLE-CHARGE every pre-auth budget.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIMITS, LIMIT_EXTENSIONS, CAP_INTERACTION_NOTE,
  assertRequestBytes, assertBatch, envelopeBytes, pullLimit,
  IP_HEADERS, UNKNOWN_IDENTITY, DEVICE_SHORT_RE, MEMBER_ID_RE,
  clientIp, deviceIdentity, memberIdentity, rateKey,
  RATE_RULES, RATE_RULE_NAMES, RATE_COVERAGE, enforce, enforceFor, noteFailedRidLookup, withLimits,
  LOG_FIELDS, LOG_FIELD_NAMES, LOG_ROUTES, LOG_FORBIDDEN,
  sanitizeLogEvent, formatLogLine, createLog,
} from '../../server/core/limits.js';
import { ROUTE_NAMES, createRouter } from '../../server/core/router.js';
import { toResponse, FORBIDDEN_BODY_FIELDS, ERROR_CODES } from '../../server/core/errors.js';
import { OPAQUE_FIELDS, MODEL_COLUMNS } from '../../server/core/store-interface.js';
import { LIMITS_SHAPE } from '../../docs/v2/contracts/server.contract.js';
import { memoryStore } from '../../server/adapters/memory.js';
import { fileStore, STORE_FILENAME } from '../../server/adapters/file.js';
import { stripCommentsAndStrings } from '../helpers/purity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

function fakeClock(startMs) {
  let t = startMs === undefined ? 1787836800000 : startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-limits-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const ADAPTERS = [
  { name: 'memory', make: (clock) => ({ store: memoryStore({ now: clock.now }), dir: null }) },
  { name: 'file', make: (clock) => { const d = tempDir(); return { store: fileStore(d, { now: clock.now }), dir: d }; } },
];

const req = (method, path_, extra) => ({
  method, path: path_, query: {}, headers: {}, body: null, rawBody: new Uint8Array(0), ...extra,
});

/** Seeded, so a failure is replayable. mulberry32. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function codeOf(fn) {
  try { await fn(); return null; } catch (e) { return e.code === undefined ? String(e) : e.code; }
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. The numbers, against the contract that publishes them
// ═════════════════════════════════════════════════════════════════════════════

test('LIMITS carries every number from server.contract.js LIMITS_SHAPE, unchanged', () => {
  for (const [name, value] of Object.entries(LIMITS_SHAPE)) {
    assert.equal(LIMITS[name], value, `LIMITS.${name} drifted from the published contract`);
  }
  // and the ADR's own table, spelled out so a reader can check it against ADR 003 §6.1 by eye
  assert.equal(LIMITS.bytesPerRequest, 4 * 1024 * 1024, 'request body <= 4 MB');
  assert.equal(LIMITS.opsPerPush, 200);
  assert.equal(LIMITS.bytesPerEnvelope, 64 * 1024);
  assert.equal(LIMITS.opsPerPull, 500);
  assert.equal(LIMITS.pushPerMin, 60);
  assert.equal(LIMITS.pullPerMin, 120);
  assert.equal(LIMITS.invitesPerIpHour, 10);       // ADR 002 §7.1 agrees
  assert.equal(LIMITS.pairGetPerIpHour, 20);       // ADR 002 §6.2
  assert.equal(LIMITS.pairSessionsPerMemberHour, 10);
  assert.equal(LIMITS.pairAttempts, 5);            // per rid, in the store, NOT a RateBucket
  assert.equal(LIMITS.authWindowMs, 120000);
  assert.equal(LIMITS.nonceTtlMs, 300000);
  assert.ok(Object.isFrozen(LIMITS));
});

test('every deviation from LIMITS_SHAPE is recorded, with a reason, and nothing else is', () => {
  const shapeKeys = new Set(Object.keys(LIMITS_SHAPE));
  const extra = Object.keys(LIMITS).filter((k) => !shapeKeys.has(k)).sort();
  const recorded = LIMIT_EXTENSIONS.map((e) => e.name).sort();
  assert.deepEqual(extra, recorded, 'a limit was added or removed without a LIMIT_EXTENSIONS row');
  for (const e of LIMIT_EXTENSIONS) {
    assert.match(e.tag, /^E2-L\d+$/);
    assert.equal(LIMITS[e.name], e.value, `${e.tag}: the recorded value is not the shipped one`);
    assert.ok(e.adr && e.adr.length > 5, `${e.tag} names no ADR clause`);
    assert.ok(e.reason && e.reason.length > 80, `${e.tag} has no stated reason`);
    assert.ok(Object.isFrozen(e));
  }
});

test('E3-5 is reconciled: four pairing limiters over three keyspaces, not one number twice', () => {
  // FINDINGS.md E3-5: "ADR 002 §6.2 and ADR 003 §6.1 publish different pairing rate limiters —
  // 20 pair/get/IP/hour vs 5 failed rid lookups/IP/minute plus 10 sessions/member/hour. Not
  // contradictory; not interchangeable." The resolution is that they are four DIFFERENT controls,
  // and this asserts each one exists with its own keyspace rather than being collapsed.
  assert.equal(RATE_RULES.pairGet.limit, 'pairGetPerIpHour');
  assert.equal(RATE_RULES.pairGet.identity, 'ip');
  assert.equal(RATE_RULES.pairGet.windowMs, 3600000);

  assert.equal(RATE_RULES.pairRidMiss.limit, 'pairRidMissPerIpMin');
  assert.equal(RATE_RULES.pairRidMiss.identity, 'ip');
  assert.equal(RATE_RULES.pairRidMiss.windowMs, 60000);
  assert.equal(RATE_RULES.pairRidMiss.onFailureOnly, true, 'a miss budget spent on hits bounds nothing');

  assert.equal(RATE_RULES.pairSession.limit, 'pairSessionsPerMemberHour');
  assert.equal(RATE_RULES.pairSession.identity, 'member');

  // the fourth control is NOT a RateBucket, deliberately: it must survive the attacker changing IP
  assert.ok(!RATE_RULE_NAMES.some((n) => RATE_RULES[n].limit === 'pairAttempts'),
    'pairAttempts is per-rid and lives in Store.bumpPairAttempts; a RateBucket keyed on IP would ' +
    'reset the 5-attempt budget every time the attacker moved');

  // and the two 5s really are different numbers about different things
  assert.equal(LIMITS.pairAttempts, 5);
  assert.equal(LIMITS.pairRidMissPerIpMin, 5);
  const ext = LIMIT_EXTENSIONS.find((e) => e.name === 'pairRidMissPerIpMin');
  assert.ok(ext.reason.includes('E3-5'), 'the reconciliation must say which finding it closes');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Payload caps  (ADR 003 §6.1)
// ═════════════════════════════════════════════════════════════════════════════

test('assertRequestBytes: at the cap passes, one over is 413', () => {
  assertRequestBytes(LIMITS.bytesPerRequest, LIMITS);
  assertRequestBytes(new Uint8Array(0), LIMITS);
  const e = (() => { try { assertRequestBytes(LIMITS.bytesPerRequest + 1, LIMITS); return null; } catch (x) { return x; } })();
  assert.equal(e.status, 413);
  assert.equal(e.code, 'payload_too_large');
  assert.equal(toResponse(e).body.cap, 'bytesPerRequest');
  assert.equal(ERROR_CODES.payload_too_large, 413);
});

test('envelopeBytes measures the ENCODED length — the cap refuses the work, it does not do it', () => {
  // The point: a 12 MB base64 field must be refused without `Buffer.from(x,'base64')` ever
  // allocating 9 MB to discover it is too big.
  assert.equal(envelopeBytes(new Uint8Array(7)), 7);
  assert.equal(envelopeBytes('AAAA'), 3);
  assert.equal(envelopeBytes('AAA='), 2);
  assert.equal(envelopeBytes('AA=='), 1);
  assert.equal(envelopeBytes(''), 0);
  assert.equal(envelopeBytes('AAAA'.repeat(1000)), 3000);
  for (const bad of [undefined, null, 5, {}, [], true]) assert.equal(envelopeBytes(bad), -1, `envelopeBytes(${JSON.stringify(bad)})`);

  // exact against a real encode, at and around the cap
  for (const n of [0, 1, 2, 3, 64, 65535, 65536]) {
    const enc = Buffer.from(new Uint8Array(n)).toString('base64');
    assert.equal(envelopeBytes(enc), n, `round trip at ${n} bytes`);
  }
});

test('assertBatch: the three caps, each at its boundary', () => {
  const env = (n) => Buffer.from(new Uint8Array(n)).toString('base64');

  // an EMPTY batch is legal: `POST /ops` with no ops is how a quiet device reports ackSeq
  // (ADR 003 §3.1, §6.3), and refusing it would leave its family's tombstone GC blocked forever.
  assert.equal(assertBatch([], LIMITS), 0);

  // exactly opsPerPush passes; one more is 413
  const small = Array.from({ length: LIMITS.opsPerPush }, () => ({ ct: env(1) }));
  assert.equal(assertBatch(small, LIMITS), LIMITS.opsPerPush);
  assert.equal(await0(() => assertBatch([...small, { ct: env(1) }], LIMITS)).code, 'payload_too_large');
  assert.equal(await0(() => assertBatch([...small, { ct: env(1) }], LIMITS)).extra.cap, 'opsPerPush');

  // exactly bytesPerEnvelope passes; one more is 413
  assert.equal(assertBatch([{ ct: env(LIMITS.bytesPerEnvelope) }], LIMITS), LIMITS.bytesPerEnvelope);
  const over = await0(() => assertBatch([{ ct: env(LIMITS.bytesPerEnvelope + 1) }], LIMITS));
  assert.equal(over.code, 'payload_too_large');
  assert.equal(over.extra.cap, 'bytesPerEnvelope');

  // `envelope` (the stored concatenation) is measured too, not only `ct`
  assert.equal(assertBatch([{ envelope: new Uint8Array(10) }], LIMITS), 10);

  // shape
  for (const bad of [undefined, null, 'ops', {}, 5]) assert.equal(await0(() => assertBatch(bad, LIMITS)).code, 'bad_request');
  assert.equal(await0(() => assertBatch([null], LIMITS)).code, 'bad_request');
  assert.equal(await0(() => assertBatch([{ ct: 5 }], LIMITS)).code, 'bad_request');
});

test('THE CAPS INTERACT: 200 x 64 KB is 12.8 MB, so the request cap must bind first', () => {
  // This is the one a per-op-only check gets wrong. Both per-op caps can pass while the batch
  // asks the handler to buffer three times the documented request limit.
  assert.ok(LIMITS.opsPerPush * LIMITS.bytesPerEnvelope > LIMITS.bytesPerRequest, CAP_INTERACTION_NOTE);
  const env = Buffer.from(new Uint8Array(LIMITS.bytesPerEnvelope)).toString('base64');
  const fat = Array.from({ length: LIMITS.opsPerPush }, () => ({ ct: env }));  // 12.8 MB, every op legal
  const e = await0(() => assertBatch(fat, LIMITS));
  assert.equal(e.code, 'payload_too_large');
  assert.equal(e.extra.cap, 'bytesPerRequest', 'the total was never checked — a 12.8 MB batch got through');
});

test('assertBatch honours a TIGHTENED ctx.limits, so a test can drive the real code path', () => {
  const tight = { ...LIMITS, opsPerPush: 2 };
  assert.equal(assertBatch([{ ct: 'AA==' }, { ct: 'AA==' }], tight), 2);
  assert.equal(await0(() => assertBatch([{ ct: 'AA==' }, { ct: 'AA==' }, { ct: 'AA==' }], tight)).extra.max, 2);
});

test('pullLimit clamps instead of rejecting, and can never exceed opsPerPull', () => {
  assert.equal(pullLimit(undefined, LIMITS), 500);
  assert.equal(pullLimit('', LIMITS), 500);
  assert.equal(pullLimit('100', LIMITS), 100);
  assert.equal(pullLimit(100, LIMITS), 100);
  assert.equal(pullLimit('500', LIMITS), 500);
  assert.equal(pullLimit('501', LIMITS), 500);
  assert.equal(pullLimit('1000000000', LIMITS), 500);
  assert.equal(pullLimit('0', LIMITS), 1);
  assert.equal(pullLimit('-5', LIMITS), 1);
  assert.equal(pullLimit('1e9', LIMITS), 500, 'exponent notation must not escape the clamp');
  assert.equal(pullLimit('abc', LIMITS), 500);
  assert.equal(pullLimit('12.9', LIMITS), 12);
  assert.equal(pullLimit(Infinity, LIMITS), 500);
  assert.equal(pullLimit(NaN, LIMITS), 500);
  for (let i = 0; i < 400; i++) {
    const r = rng(1234 + i)();
    const v = Math.floor((r - 0.5) * 4e9);
    const out = pullLimit(String(v), LIMITS);
    assert.ok(out >= 1 && out <= LIMITS.opsPerPull, `pullLimit(${v}) = ${out}`);
  }
});

function await0(fn) { try { fn(); return {}; } catch (e) { return e; } }

// ═════════════════════════════════════════════════════════════════════════════
// 3. Identity — the blindness hole in RateBucket.key
// ═════════════════════════════════════════════════════════════════════════════

test('clientIp reads the LAST x-forwarded-for entry, never the first', () => {
  // Reading the first entry is the classic bypass: the client prepends whatever it likes, so a
  // limiter keyed on it has a fresh budget on every request.
  assert.equal(clientIp(req('GET', '/x', { headers: { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' } })), '1.2.3.4');
  assert.equal(clientIp(req('GET', '/x', { headers: { 'x-forwarded-for': '1.2.3.4' } })), '1.2.3.4');
  // and the tighter headers win
  assert.equal(clientIp(req('GET', '/x', { headers: { 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '2.2.2.2' } })), '2.2.2.2');
  assert.equal(clientIp(req('GET', '/x', { headers: { 'x-real-ip': '2.2.2.2', 'x-vercel-forwarded-for': '3.3.3.3' } })), '3.3.3.3');
  assert.deepEqual([...IP_HEADERS], ['x-vercel-forwarded-for', 'x-real-ip', 'x-forwarded-for']);
});

test('an IP header can never carry text into RateBucket.key — it degrades to the shared bucket', () => {
  // store-interface.js PLAINTEXT_STRINGS justifies `RateBucket.key` as "composed of route +
  // device/IP, never of content". Nothing enforced that, and the IP arrives AS A HEADER on an
  // UNAUTHENTICATED endpoint. This is the assertion that makes the justification true.
  const nasty = [
    'Zahnarzt 14:30', 'Oma Geburtstag', '<script>', "'; DROP TABLE", 'x'.repeat(4000),
    '../../etc/passwd', 'a\nb', ' ', 'Mama', 'name@example.com',
  ];
  for (const v of nasty) {
    for (const h of IP_HEADERS) {
      assert.equal(clientIp(req('GET', '/x', { headers: { [h]: v } })), UNKNOWN_IDENTITY, `${h}: ${JSON.stringify(v)}`);
    }
  }
  // length: 45 chars is the longest legal IPv6 text form; 46 is not an address
  assert.equal(clientIp(req('GET', '/x', { headers: { 'x-real-ip': 'f'.repeat(45) } })), 'f'.repeat(45));
  assert.equal(clientIp(req('GET', '/x', { headers: { 'x-real-ip': 'f'.repeat(46) } })), UNKNOWN_IDENTITY);
  // legal forms survive
  for (const ok of ['1.2.3.4', '::1', '2001:db8::1', '[2001:db8::1]', '255.255.255.255', 'ffff::ffff']) {
    assert.equal(clientIp(req('GET', '/x', { headers: { 'x-real-ip': ok } })), ok);
  }
  // A zone id is a LOCAL interface name and is never part of a client address as a proxy sees
  // it. It is refused rather than accepted, because `%<anything>` is the one shape that would
  // otherwise let an arbitrary string ride in attached to a legal address.
  assert.equal(clientIp(req('GET', '/x', { headers: { 'x-real-ip': 'fe80::1%eth0' } })), UNKNOWN_IDENTITY);
  // absent → the shared sentinel, which is the MOST contended bucket, never a private one
  assert.equal(clientIp(req('GET', '/x')), UNKNOWN_IDENTITY);
  assert.equal(clientIp(null), UNKNOWN_IDENTITY);
  assert.equal(UNKNOWN_IDENTITY.length, 1, 'the sentinel must be too short to carry anything');
});

test('device and member identities are validated against their own alphabets', () => {
  assert.equal(deviceIdentity('7QAR2MZ9XKPNC0GV'), '7QAR2MZ9XKPNC0GV');
  for (const bad of ['7QAR2MZ9XKPNC0G', '7QAR2MZ9XKPNC0GVX', 'iloux0000000000z', 'Zahnarzt14:30xxx', '', null, 5, {}]) {
    assert.equal(deviceIdentity(bad), UNKNOWN_IDENTITY, `deviceIdentity(${JSON.stringify(bad)})`);
  }
  assert.ok(!DEVICE_SHORT_RE.test('7QAR2MZ9XKPNC0IL'), 'Crockford base32 excludes I and L (ADR 001 §1.2)');
  assert.equal(memberIdentity('mem_AAAAAAAAAAAAAAAAAAAAAA'), 'mem_AAAAAAAAAAAAAAAAAAAAAA');
  for (const bad of ['mem_short', 'dev_AAAAAAAAAAAAAAAAAAAAAA', 'Mama', null]) {
    assert.equal(memberIdentity(bad), UNKNOWN_IDENTITY);
  }
  assert.ok(MEMBER_ID_RE.test('mem_AAAAAAAAAAAAAAAAAAAAAA'));
});

test('rateKey: no caller-supplied string can address a neighbouring budget', () => {
  assert.notEqual(rateKey('push', 'A|B'), rateKey('push|A', 'B'));
  assert.notEqual(rateKey('push', 'A'), rateKey('pus', 'hA'));
  assert.notEqual(rateKey('push', 'A"],["push'), rateKey('push', 'A'));
  assert.equal(rateKey('push', 'A'), rateKey('push', 'A'), 'the key must be stable');
  assert.equal(rateKey('push', 'A'), '["push","A"]');
  // and a key is a bounded, structured string — never something an operator has to read as data
  assert.ok(rateKey('pairGet', 'f'.repeat(45)).length < 80);
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. RATE_COVERAGE — the enumerated route surface
// ═════════════════════════════════════════════════════════════════════════════

test('RATE_COVERAGE names EVERY route, and nothing that is not a route', () => {
  assert.deepEqual(Object.keys(RATE_COVERAGE).sort(), [...ROUTE_NAMES].sort(),
    'a route with no coverage row, or a coverage row with no route. Adding an endpoint must ' +
    'force an answer to "what stops someone calling it a million times".');
});

test('every rule named in RATE_COVERAGE exists, and every rule is used', () => {
  const used = new Set();
  for (const [name, c] of Object.entries(RATE_COVERAGE)) {
    for (const r of [...c.pre, ...c.post]) {
      assert.ok(RATE_RULES[r], `${name} names rule ${r}, which does not exist`);
      used.add(r);
    }
    for (const r of c.pre) assert.equal(RATE_RULES[r].phase, 'pre-auth', `${name}: ${r} is not a pre-auth rule`);
    for (const r of c.post) assert.equal(RATE_RULES[r].phase, 'post-auth', `${name}: ${r} is not a post-auth rule`);
  }
  assert.deepEqual([...used].sort(), [...RATE_RULE_NAMES].sort(), 'a declared rule that guards nothing');
});

test('every UNPROTECTED route carries a written reason, and the ADR-mandated ones are protected', () => {
  for (const [name, c] of Object.entries(RATE_COVERAGE)) {
    const protectedRoute = c.pre.length + c.post.length > 0;
    if (protectedRoute) {
      assert.equal(c.why, null, `${name} is protected but also carries an excuse`);
    } else {
      assert.ok(typeof c.why === 'string' && c.why.length > 60,
        `${name} has no limiter and no stated reason. An unlimited endpoint is a decision; make it here.`);
    }
  }
  // ADR 003 §6.1's table is not optional: these five rows must be protected, whatever else is not
  assert.deepEqual(RATE_COVERAGE.pushOps.post, ['push']);
  assert.deepEqual(RATE_COVERAGE.pullOps.post, ['pull']);
  assert.deepEqual(RATE_COVERAGE.redeemInvite.pre, ['inviteRedeem']);
  assert.deepEqual(RATE_COVERAGE.pairGet.pre, ['pairGet', 'pairRidMiss']);
  assert.deepEqual(RATE_COVERAGE.pairOffer.post, ['pairSession']);
});

test('the routes left unlimited are the ones the ADR leaves unlimited, and they are named', () => {
  const unlimited = Object.keys(RATE_COVERAGE).filter((n) => RATE_COVERAGE[n].why !== null).sort();
  assert.deepEqual(unlimited, [
    'createInvite', 'deleteSpace', 'fetchKeys', 'leaveSpace',
    'listMembers', 'meta', 'openInvites', 'pairAnswer', 'pairDeliver',
    'renameSpace', 'revokeDevice', 'revokeInvite', 'transferAdmin',
  ], 'this list IS the review surface for "what can be called without a budget"');

  // ── the four that left this list at integration (LZP-207) ──────────────────
  // `createSpace`, `registerDevice`, `adoptDevice` and `removeMember` used to carry a `why`, and
  // all four `why`s were wrong the same way: they reasoned from an authenticated caller on routes
  // that have no caller identity yet (the first three are BOOTSTRAP routes — they register the
  // very device they are signed by) or one whose central claim the server cannot check
  // ("admin-only", finding E2-203-2). LZP-202..204 were charging local budgets and saying so;
  // integration moved the numbers into RATE_RULES so they are reviewable in one table.
  // ── and the FIFTH, which left the list after the round-2 member adversary (T2-E1) ──────────
  // `rotateEpoch`'s excuse was wrong about arithmetic rather than about authentication: "a flood
  // costs the attacker their own space's epoch numbers and nothing else". `assertCoverage` is a
  // row count and already-deposited rows count, so a rotation costs an attacking member one wrap
  // per recipient while `sync/keys.js#rotateTo` sends `recipients × 1..next` — an unmetered
  // ladder walks the shipped client past MAX_WRAPS into a state no route can undo.
  for (const [route, rule] of [
    ['createSpace', 'spaceCreate'], ['registerDevice', 'deviceRegister'],
    ['adoptDevice', 'deviceAdopt'], ['removeMember', 'memberRemove'],
    ['rotateEpoch', 'epochRotate'],
  ]) {
    const c = RATE_COVERAGE[route];
    assert.equal(c.why, null, `${route} is budgeted now; it must not also carry an excuse`);
    assert.deepEqual([...c.pre, ...c.post], [rule], `${route} must declare ${rule}`);
  }
  // and the reasoning the excuses carried must have survived into LIMIT_EXTENSIONS rather than
  // being deleted with them — E2-205-2 in particular was a red-team finding, not a note.
  const ext = LIMIT_EXTENSIONS.map((e) => `${e.name} ${e.adr} ${e.reason}`).join('\n');
  assert.match(ext, /E2-205-2/, 'the device-registration finding was dropped, not resolved');
  assert.match(ext, /E2-203-6/, 'the bootstrap-route finding was dropped, not resolved');
  assert.match(ext, /VOLUME/, 'E2-205-2 was about volume, not forgery; keep the distinction');

  // the ones that remain genuinely uncomfortable must still say so, and name where the work goes
  assert.match(RATE_COVERAGE.pairAnswer.why, /E2-205-3/);
  assert.match(RATE_COVERAGE.pairDeliver.why, /E2-205-3/);
  assert.match(RATE_COVERAGE.meta.why, /store/i);
});

test('T2-E1: the epoch ladder is metered, per MEMBER, and the refuted premise is on the record', () => {
  // The finding: `RATE_COVERAGE.rotateEpoch` was unlimited because "a flood costs the attacker
  // their own space's epoch numbers and nothing else", and that clause was measured false —
  // `assertCoverage` counts rows, already-deposited rows count, so one rotation costs an
  // attacking member ONE wrap per recipient while `sync/keys.js#rotateTo` sends
  // `recipients × 1..next` and `readWraps` refuses more than `MAX_WRAPS`. Past
  // `MAX_WRAPS / recipients` the honest rotation no longer fits in a request, the cap is per
  // REQUEST, and no route prunes an epoch. Driven end to end in
  // `tests/fleet/e6-gate-keys.test.js` §1.
  const rule = RATE_RULES.epochRotate;
  assert.ok(rule, 'the rule that bounds the epoch ladder is gone');
  assert.equal(rule.limit, 'epochRotationsPerMemberHour');
  assert.equal(rule.windowMs, 3600000);
  assert.equal(rule.phase, 'post-auth', 'a rotator is authenticated before the budget is known');

  // THE IDENTITY IS THE DECISION, not the number. `ip` would hand a member a fresh ladder budget
  // for the price of moving networks; a space-wide budget would let one hostile member spend the
  // circle's whole allowance and 429 the honest admin trying to rotate her out — which is the
  // denial being closed, rebuilt as the fix (`e6-gate-keys` §2a).
  assert.equal(rule.identity, 'member');

  // The number, and the honest paths it must not bind: the budgets that CAUSE rotations are
  // themselves 10/hour, so this must sit above them rather than snug against them.
  assert.equal(LIMITS.epochRotationsPerMemberHour, 20);
  for (const cause of ['memberRemovePerMemberHour', 'deviceRegPerIpHour',
    'deviceAdoptPerIpHour', 'invitesPerIpHour']) {
    assert.ok(LIMITS.epochRotationsPerMemberHour > LIMITS[cause],
      `${cause} can force a rotation; a ladder budget at or below it would 429 an honest path`);
  }

  // and the refuted premise must be RECORDED, not deleted — a limiter whose reason is lost is a
  // limiter the next reviewer removes as unexplained.
  const ext = LIMIT_EXTENSIONS.find((e) => e.name === 'epochRotationsPerMemberHour');
  assert.ok(ext, 'the ladder budget has no LIMIT_EXTENSIONS row');
  assert.match(ext.reason, /T2-E1/);
  assert.match(ext.reason, /MAX_WRAPS/, 'the arithmetic that makes the ladder absorbing');
  assert.match(ext.reason, /NOTHING ELSE/, 'quote the clause that was measured false');

  // THE TWO THINGS A READER MUST NOT HAVE TO REDISCOVER, and they are the reason this rule is
  // shaped the way it is rather than the obvious way:
  //   1. the budget is spent on the CLIMB, not on the attempt — an entry charge would meter the
  //      loser of an honest race at the rate of its winner (`e6-gate-keys` §2d);
  //   2. it does NOT close `e6-gate-keys` §2a. That row reads like a race a rung budget bounds
  //      and is not one: a single rotation carrying wraps nobody can open leaves every honest
  //      device ringless at the current epoch, and no rate bounds "one".
  assert.match(ext.reason, /CLIMB AND NOT THE REQUEST/);
  assert.match(ext.reason, /DOES NOT CLOSE/,
    'a limiter credited with a finding it does not close is just the next false premise');
  assert.match(ext.reason, /§2a/, 'name the row it does NOT close, or nobody will look again');
});

test('T2-E1b: "at most eight members" is a cardinality gate, and this table stops claiming to hold it', () => {
  // ADR 003 §3.2's "at most 8 rows" was a sentence about families, not a check: when the round-2
  // adversary looked, `grep -rn 'MAX_MEMBERS|too_many_members' server/core/` was empty and she
  // reached eight live members from one Mac. `listMembers`'s coverage row stated the 8 as though
  // the relay enforced it, which is the shape of claim this whole table exists to prevent.
  //
  // The cap itself is NOT this file's, and the assertion says where it is instead rather than
  // reaching into another owner's file to check: a rate rule bounds a RATE, and a membership
  // ceiling is a cardinality refusal on the one route that admits a member.
  const why = RATE_COVERAGE.listMembers.why;
  assert.match(why, /redeemInvite/, 'name where the cap belongs, or nobody builds it');
  assert.doesNotMatch(why, /at most 8 rows \(ADR 003 §3\.2\)/,
    'the old wording asserted a bound this table does not hold');

  // and the reason it is not merely cosmetic must survive next to the rule it affects: the wall
  // `epochRotate` prices sits at MAX_WRAPS / recipients, so the roster size is an input to it.
  const ext = LIMIT_EXTENSIONS.find((e) => e.name === 'epochRotationsPerMemberHour');
  assert.match(ext.reason, /eight/i, 'the ladder budget is sized against a family, and says so');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Enforcement — against both adapters, by code that really runs
// ═════════════════════════════════════════════════════════════════════════════

for (const adapter of ADAPTERS) {
  const ctxOf = (clock, limits) => {
    const { store, dir } = adapter.make(clock);
    return { ctx: { store, now: clock.now, limits: limits || LIMITS }, dir };
  };

  test(`[${adapter.name}] the limiter admits exactly max, then 429s with Retry-After`, async () => {
    const clock = fakeClock();
    const { ctx } = ctxOf(clock, { ...LIMITS, pushPerMin: 5 });
    for (let i = 0; i < 5; i++) await enforce(ctx, 'push', '7QAR2MZ9XKPNC0GV');
    const e = await (async () => { try { await enforce(ctx, 'push', '7QAR2MZ9XKPNC0GV'); return null; } catch (x) { return x; } })();
    assert.equal(e.status, 429);
    assert.equal(e.code, 'rate_limited');
    const res = toResponse(e);
    assert.equal(res.headers['Retry-After'], '60', 'a 429 without Retry-After makes ADR 003 §8.2 backoff guesswork');
    assert.equal(res.body.error, 'rate_limited');
  });

  test(`[${adapter.name}] budgets are per identity and per rule — no cross-talk`, async () => {
    const clock = fakeClock();
    const { ctx } = ctxOf(clock, { ...LIMITS, pushPerMin: 2, pullPerMin: 2 });
    await enforce(ctx, 'push', 'AAAAAAAAAAAAAAAA');
    await enforce(ctx, 'push', 'AAAAAAAAAAAAAAAA');
    assert.equal(await codeOf(() => enforce(ctx, 'push', 'AAAAAAAAAAAAAAAA')), 'rate_limited');
    // a different device is unaffected
    await enforce(ctx, 'push', 'BBBBBBBBBBBBBBBB');
    // and so is a different rule for the SAME device: exhausting push must not stop pulling
    await enforce(ctx, 'pull', 'AAAAAAAAAAAAAAAA');
    await enforce(ctx, 'pull', 'AAAAAAAAAAAAAAAA');
    assert.equal(await codeOf(() => enforce(ctx, 'pull', 'AAAAAAAAAAAAAAAA')), 'rate_limited');
  });

  test(`[${adapter.name}] the window re-opens, and the tumbling boundary admits at most 2x max`, async () => {
    const clock = fakeClock();
    const { ctx } = ctxOf(clock, { ...LIMITS, pushPerMin: 3 });
    for (let i = 0; i < 3; i++) await enforce(ctx, 'push', 'AAAAAAAAAAAAAAAA');
    assert.equal(await codeOf(() => enforce(ctx, 'push', 'AAAAAAAAAAAAAAAA')), 'rate_limited');

    clock.advance(59999);
    assert.equal(await codeOf(() => enforce(ctx, 'push', 'AAAAAAAAAAAAAAAA')), 'rate_limited', 'the window closed early');

    clock.advance(1);
    for (let i = 0; i < 3; i++) await enforce(ctx, 'push', 'AAAAAAAAAAAAAAAA');
    assert.equal(await codeOf(() => enforce(ctx, 'push', 'AAAAAAAAAAAAAAAA')), 'rate_limited');
    // 6 admitted across ~60 s. That is the documented cost of a TUMBLING window over a
    // three-column RateBucket: at most 2x max across a boundary. At 60/min and 10/hour it is the
    // right trade, and memory.js records it rather than papering over it.
  });

  test(`[${adapter.name}] 25 concurrent callers against max 10 — exactly 10 get through`, async () => {
    const clock = fakeClock();
    const { ctx } = ctxOf(clock, { ...LIMITS, pushPerMin: 10 });
    const results = await Promise.all(Array.from({ length: 25 }, async () => {
      try { await enforce(ctx, 'push', 'AAAAAAAAAAAAAAAA'); return 'ok'; } catch { return '429'; }
    }));
    assert.equal(results.filter((r) => r === 'ok').length, 10, 'a read-modify-write race let extra callers through');
    assert.equal(results.filter((r) => r === '429').length, 15);
  });

  test(`[${adapter.name}] every ambiguity FAILS CLOSED`, async () => {
    const clock = fakeClock();
    const { ctx } = ctxOf(clock);
    // an unknown rule is a wiring bug, not an open door
    assert.equal(await codeOf(() => enforce(ctx, 'nope', 'A')), 'internal');
    // a limit that is not a positive integer
    for (const bad of [0, -1, 1.5, -0.5]) {
      assert.equal(await codeOf(() => enforce({ ...ctx, limits: { ...LIMITS, pushPerMin: bad } }, 'push', 'A')), 'internal', `pushPerMin ${bad}`);
    }
    // A limit that is not a number at all falls back to the SHIPPED constant rather than to
    // "deny everything" or "admit everything". That is the safe direction on both sides: a typo
    // in a ctx cannot become an outage, and it cannot silently disable a limiter either.
    const typo = { ...ctx, limits: { ...LIMITS, pushPerMin: 'lots' } };
    for (let i = 0; i < LIMITS.pushPerMin; i++) await enforce(typo, 'push', 'AAAAAAAAAAAAAAAA');
    assert.equal(await codeOf(() => enforce(typo, 'push', 'AAAAAAAAAAAAAAAA')), 'rate_limited');
    // and a limits object missing the key entirely behaves the same way
    assert.equal(await codeOf(() => enforce({ ...ctx, limits: {} }, 'push', 'BBBBBBBBBBBBBBBB')), null);
    // no identity at all
    assert.equal(await codeOf(() => enforce(ctx, 'push', '')), 'internal');
    assert.equal(await codeOf(() => enforce(ctx, 'push', null)), 'internal');
    // no store
    assert.equal(await codeOf(() => enforce({ ...ctx, store: null }, 'push', 'A')), 'internal');
    assert.equal(await codeOf(() => enforce({ ...ctx, store: {} }, 'push', 'A')), 'internal');
    // AN ADAPTER THAT ANSWERS ANYTHING BUT `true` DENIES. A limiter that opens when the store is
    // confused is a limiter an attacker confuses on purpose.
    for (const v of [undefined, null, 1, 'true', {}, 'ok']) {
      assert.equal(await codeOf(() => enforce({ ...ctx, store: { rateAllow: async () => v } }, 'push', 'A')), 'rate_limited', `rateAllow returned ${JSON.stringify(v)}`);
    }
  });

  test(`[${adapter.name}] enforceFor resolves the identity a rule declares, and refuses garbage`, async () => {
    const clock = fakeClock();
    const { ctx } = ctxOf(clock, { ...LIMITS, pushPerMin: 1, invitesPerIpHour: 1, pairSessionsPerMemberHour: 1 });
    const r = (headers) => req('POST', '/api/v1/x', { headers });

    await enforceFor(r({ 'x-real-ip': '1.2.3.4' }), ctx, 'inviteRedeem', null);
    assert.equal(await codeOf(() => enforceFor(r({ 'x-real-ip': '1.2.3.4' }), ctx, 'inviteRedeem', null)), 'rate_limited');
    await enforceFor(r({ 'x-real-ip': '5.6.7.8' }), ctx, 'inviteRedeem', null);   // different IP, own budget

    await enforceFor(r({}), ctx, 'push', { deviceShort: 'AAAAAAAAAAAAAAAA' });
    assert.equal(await codeOf(() => enforceFor(r({}), ctx, 'push', { deviceShort: 'AAAAAAAAAAAAAAAA' })), 'rate_limited');

    // a malformed device short does not get its own budget — it joins the shared '?' bucket
    await enforceFor(r({}), ctx, 'push', { deviceShort: 'not-a-device' });
    assert.equal(await codeOf(() => enforceFor(r({}), ctx, 'push', { deviceShort: 'also-not-a-device' })), 'rate_limited',
      'two malformed identities got two budgets — a rate limiter with a free-form key is not a limiter');

    await enforceFor(r({}), ctx, 'pairSession', { memberId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' });
    assert.equal(await codeOf(() => enforceFor(r({}), ctx, 'pairSession', { memberId: 'mem_AAAAAAAAAAAAAAAAAAAAAA' })), 'rate_limited');
  });

  test(`[${adapter.name}] noteFailedRidLookup spends the miss budget, and only the miss budget`, async () => {
    const clock = fakeClock();
    const { ctx } = ctxOf(clock);
    const r = req('GET', '/api/v1/pair/abc', { headers: { 'x-real-ip': '1.2.3.4' } });
    // ADR 003 §6.1: five failed rid lookups per IP per minute. The SIXTH guess is refused, an
    // hour before the 20/hour pairGet budget would have noticed.
    for (let i = 0; i < LIMITS.pairRidMissPerIpMin; i++) await noteFailedRidLookup(r, ctx);
    assert.equal(await codeOf(() => noteFailedRidLookup(r, ctx)), 'rate_limited');
    // and the hourly pairGet budget is untouched — they are different keyspaces (E3-5)
    for (let i = 0; i < LIMITS.pairGetPerIpHour; i++) await enforceFor(r, ctx, 'pairGet', null);
    assert.equal(await codeOf(() => enforceFor(r, ctx, 'pairGet', null)), 'rate_limited');
  });
}

test('[file] the on-disk relay contains no text from a header, ever', async () => {
  // The strongest available form of the blindness claim for RateBucket: run the limiter with
  // German prose in every IP header, then read the actual database file the dev host uses.
  const clock = fakeClock();
  const dir = tempDir();
  const store = fileStore(dir, { now: clock.now });
  const ctx = { store, now: clock.now, limits: LIMITS };

  const canaries = ['Zahnarzt-14-30', 'Oma-Geburtstag', 'Mama', 'Klassenfahrt'];
  for (const c of canaries) {
    for (const h of IP_HEADERS) {
      try { await enforceFor(req('POST', '/api/v1/invites/redeem', { headers: { [h]: c } }), ctx, 'inviteRedeem', null); } catch { /* 429 is fine */ }
    }
  }
  await store.tx(async () => {});   // force a flush of the write-through
  const raw = fs.readFileSync(path.join(dir, STORE_FILENAME), 'utf8');
  for (const c of canaries) assert.ok(!raw.includes(c), `${c} reached the database through a header`);
  assert.ok(raw.includes('inviteRedeem'), 'the bucket was not written at all — the test proved nothing');
});

test('withLimits enforces the pre-auth rules through the real router, and skips failure-only ones', async () => {
  const clock = fakeClock();
  const store = memoryStore({ now: clock.now });
  const ctx = { store, now: clock.now, limits: { ...LIMITS, invitesPerIpHour: 2, pairGetPerIpHour: 2 } };

  const seen = [];
  const registry = {};
  for (const name of ROUTE_NAMES) registry[name] = async (r) => { seen.push(name); return { status: 200, body: { name } }; };
  const route = createRouter(withLimits(registry));

  const call = async (method, p, headers, query) => {
    try { return await route(ctx, req(method, p, { headers, query: query || {} })); }
    catch (e) { return toResponse(e); }
  };

  // redeemInvite is IP-limited pre-auth: two through, the third is 429 before the handler runs
  assert.equal((await call('POST', '/api/v1/invites/redeem', { 'x-real-ip': '1.1.1.1' })).status, 200);
  assert.equal((await call('POST', '/api/v1/invites/redeem', { 'x-real-ip': '1.1.1.1' })).status, 200);
  const blocked = await call('POST', '/api/v1/invites/redeem', { 'x-real-ip': '1.1.1.1' });
  assert.equal(blocked.status, 429);
  assert.equal(seen.filter((n) => n === 'redeemInvite').length, 2, 'the handler ran on a rate-limited request');

  // pairGet declares TWO pre rules; only the non-failure-only one is spent on entry, or the
  // 5-per-minute miss budget would be exhausted by five successful lookups.
  for (let i = 0; i < 2; i++) assert.equal((await call('GET', '/api/v1/pair/abc', { 'x-real-ip': '2.2.2.2' })).status, 200);
  assert.equal((await call('GET', '/api/v1/pair/abc', { 'x-real-ip': '2.2.2.2' })).status, 429);
  // the miss budget is still whole: five misses remain available
  for (let i = 0; i < LIMITS.pairRidMissPerIpMin; i++) {
    await noteFailedRidLookup(req('GET', '/api/v1/pair/abc', { headers: { 'x-real-ip': '2.2.2.2' } }), ctx);
  }

  // a route with no pre rules is passed through untouched (identity, not a wrapper)
  const unwrapped = withLimits({ listMembers: registry.listMembers });
  assert.equal(unwrapped.listMembers, registry.listMembers, 'an unlimited route should not pay for a wrapper');
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. LOG REDACTION  (ADR 003 §6.2 — the file the ADR calls log-redaction.test.js)
// ═════════════════════════════════════════════════════════════════════════════

test('log-redaction: the allowlist is ADR 003 §6.2 exactly, and has not been widened', () => {
  assert.deepEqual([...LOG_FIELD_NAMES].sort(),
    ['byteCount', 'deviceShort', 'ms', 'opCount', 'route', 'spaceId', 'status'],
    'ADR 003 §6.2 names seven fields. Widening a privacy allowlist for debugging convenience is ' +
    'an ADR amendment, not an edit.');
  assert.ok(Object.isFrozen(LOG_FIELDS));
  // and it cannot overlap anything the other direction forbids
  for (const f of LOG_FIELD_NAMES) {
    assert.ok(!FORBIDDEN_BODY_FIELDS.has(f), `${f} is both loggable and forbidden on an error body`);
    assert.ok(!LOG_FORBIDDEN.includes(f), `${f} is on both lists`);
  }
});

test('log-redaction: LOG_FORBIDDEN is DERIVED from the schema, so it cannot rot', () => {
  // If someone adds an opaque column to store-interface.js, it must become un-loggable without
  // anyone remembering to edit a second list.
  for (const cols of Object.values(OPAQUE_FIELDS)) {
    for (const c of cols) assert.ok(LOG_FORBIDDEN.includes(c), `opaque column ${c} is not in LOG_FORBIDDEN`);
  }
  for (const f of FORBIDDEN_BODY_FIELDS) assert.ok(LOG_FORBIDDEN.includes(f), `${f} is forbidden on a body but not in a log`);
  // ADR 003 §6.2's own hand-written list
  for (const f of ['envelope', 'iv', 'ct', 'sig', 'wrapped', 'wrappedKeys', 'boxA', 'boxB', 'delivery']) {
    assert.ok(LOG_FORBIDDEN.includes(f), `${f} is named in ADR 003 §6.2 and is missing`);
  }
});

test('log-redaction: the sanitiser never enumerates its input — unnamed fields are UNREACHABLE', () => {
  // This is the mechanism, and it is worth asserting on the source: a blocklist fails the day
  // someone logs `{payload: op}`; reading from a fixed key list cannot.
  const src = stripCommentsAndStrings(read('server/core/limits.js'));
  const fn = src.slice(src.indexOf('export function sanitizeLogEvent'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /for\s*\(\s*const\s+name\s+of\s+LOG_FIELD_NAMES\s*\)/, 'the sanitiser must iterate the ALLOWLIST');
  assert.doesNotMatch(body, /Object\.keys\s*\(\s*evt/, 'the sanitiser enumerates the caller object');
  assert.doesNotMatch(body, /Object\.entries\s*\(\s*evt/, 'the sanitiser enumerates the caller object');
  assert.doesNotMatch(body, /\bin\s+evt\b/, 'the sanitiser enumerates the caller object');
  assert.doesNotMatch(body, /\.\.\.evt/, 'the sanitiser spreads the caller object');
});

test('log-redaction: every ciphertext-shaped field is dropped, whatever it is called', () => {
  const CANARY = 'Zahnarzt-14-30-Oma';
  const B64 = 'q1ZQslIyMjE1MzE0MDZTVYqtBQA';
  const evt = {
    route: 'pushOps', spaceId: 'fsp_AAAAAAAAAAAAAAAAAAAAAA', deviceShort: '7QAR2MZ9XKPNC0GV',
    opCount: 3, byteCount: 2048, status: 200, ms: 12,
  };
  // every forbidden name, plus names nobody has thought of — all with the same canary value
  for (const name of [...LOG_FORBIDDEN, 'payload', 'note', 'text', 'label', 'anythingAtAll', 'toJSON']) {
    evt[name] = CANARY;
  }
  evt.envelopeBytes = new Uint8Array([1, 2, 3]);
  evt.ops = [{ ct: B64, iv: B64, sig: B64 }];
  evt.body = { notes: [{ text: CANARY }] };

  const line = formatLogLine(evt);
  assert.ok(!line.includes(CANARY), `the canary reached the log line: ${line}`);
  assert.ok(!line.includes(B64), 'ciphertext reached the log line');
  assert.deepEqual(JSON.parse(line), {
    route: 'pushOps', spaceId: 'fsp_AAAAAAAAAAAAAAAAAAAAAA', deviceShort: '7QAR2MZ9XKPNC0GV',
    opCount: 3, byteCount: 2048, status: 200, ms: 12,
  });
  assert.ok(line.length < 200, 'a log line is bounded by construction');
});

test('log-redaction: an allowlisted field with a non-conforming VALUE is dropped, not coerced', () => {
  // The subtle failure: `route` is allowlisted, so a careless implementation logs whatever was
  // put there — and `req.path` is `/api/v1/pair/<rid>`, where rid is HKDF of the pairing code.
  assert.deepEqual(sanitizeLogEvent({ route: '/api/v1/pair/3nR7bR0aZ4tV9wLpNc' }), {});
  assert.deepEqual(sanitizeLogEvent({ route: 'pushOps' }), { route: 'pushOps' });
  assert.deepEqual(sanitizeLogEvent({ route: 'unmatched' }), { route: 'unmatched' });
  for (const r of ROUTE_NAMES) assert.deepEqual(sanitizeLogEvent({ route: r }), { route: r });
  assert.deepEqual(LOG_ROUTES.filter((r) => !ROUTE_NAMES.includes(r)).sort(), ['health', 'unmatched']);

  // spaceId and deviceShort are patterns, so free text cannot ride in on a legitimate key
  assert.deepEqual(sanitizeLogEvent({ spaceId: 'Familie Müller' }), {});
  assert.deepEqual(sanitizeLogEvent({ spaceId: 'fsp_AAAAAAAAAAAAAAAAAAAAAA' }), { spaceId: 'fsp_AAAAAAAAAAAAAAAAAAAAAA' });
  assert.deepEqual(sanitizeLogEvent({ spaceId: 'psp_AAAAAAAAAAAAAAAAAAAAAA' }), { spaceId: 'psp_AAAAAAAAAAAAAAAAAAAAAA' });
  assert.deepEqual(sanitizeLogEvent({ deviceShort: 'Mamas MacBook' }), {});

  // numbers are clamped rather than trusted; a "byteCount" of 1e300 is not a byte count
  assert.deepEqual(sanitizeLogEvent({ byteCount: 1e300 }), { byteCount: LOG_FIELDS.byteCount.max });
  assert.deepEqual(sanitizeLogEvent({ byteCount: -5 }), {});
  assert.deepEqual(sanitizeLogEvent({ byteCount: NaN }), {});
  assert.deepEqual(sanitizeLogEvent({ byteCount: '2048' }), {}, 'a string is not a count');
  assert.deepEqual(sanitizeLogEvent({ ms: 12.7 }), { ms: 12 });
  assert.deepEqual(sanitizeLogEvent({ status: 200 }), { status: 200 });
  for (const s of [99, 600, 200.5, '200', null]) assert.deepEqual(sanitizeLogEvent({ status: s }), {});
});

test('log-redaction: the sanitiser survives hostile objects and never throws', () => {
  const boom = {};
  Object.defineProperty(boom, 'route', { get() { throw new Error('gotcha'); }, enumerable: true });
  Object.defineProperty(boom, 'spaceId', { get() { return 'fsp_AAAAAAAAAAAAAAAAAAAAAA'; }, enumerable: true });
  assert.deepEqual(sanitizeLogEvent(boom), { spaceId: 'fsp_AAAAAAAAAAAAAAAAAAAAAA' });

  const proxy = new Proxy({}, { get() { throw new Error('nope'); }, has() { return true; } });
  assert.deepEqual(sanitizeLogEvent(proxy), {});

  const poisoned = JSON.parse('{"__proto__":{"route":"pushOps"},"status":200}');
  assert.deepEqual(sanitizeLogEvent(poisoned), { status: 200 });
  assert.equal({}.route, undefined, 'the prototype was polluted');

  for (const v of [null, undefined, 0, '', 'x', [], () => {}, Symbol.iterator]) {
    assert.deepEqual(sanitizeLogEvent(v), {}, `sanitizeLogEvent(${String(v)})`);
  }
  // a value that stringifies to something else must not sneak past
  assert.deepEqual(sanitizeLogEvent({ status: { valueOf: () => 200 } }), {});
  assert.deepEqual(sanitizeLogEvent({ route: { toString: () => 'pushOps' } }), {});
  assert.deepEqual(sanitizeLogEvent({ spaceId: new String('fsp_AAAAAAAAAAAAAAAAAAAAAA') }), {});
});

test('log-redaction: fuzz — 2000 hostile events, no canary and no long base64 run survives', () => {
  const r = rng(20260828);
  const NAMES = [...LOG_FIELD_NAMES, ...LOG_FORBIDDEN, ...Object.values(MODEL_COLUMNS).flat(), 'payload', 'raw', 'x'];
  const CANARY = 'GEHEIM';
  let emitted = 0;
  for (let i = 0; i < 2000; i++) {
    const evt = {};
    const n = 1 + Math.floor(r() * 8);
    for (let j = 0; j < n; j++) {
      const key = NAMES[Math.floor(r() * NAMES.length)];
      const roll = r();
      evt[key] = roll < 0.25 ? `${CANARY}-${i}`
        : roll < 0.5 ? Buffer.from(`${CANARY}${i}`.repeat(4)).toString('base64')
          : roll < 0.7 ? new Uint8Array([i & 255, 1, 2, 3])
            : roll < 0.85 ? { nested: `${CANARY}` }
              : Math.floor(r() * 1e6);
    }
    const line = formatLogLine(evt);
    emitted += line.length;
    assert.ok(!line.includes(CANARY), `seed 20260828, iteration ${i}: ${line}`);
    // nothing ciphertext-shaped: no base64-ish run of 24+ characters anywhere in the line
    assert.doesNotMatch(line, /[A-Za-z0-9+/_-]{24,}/, `seed 20260828, iteration ${i}: ${line}`);
    assert.ok(line.length <= 200, `unbounded line at iteration ${i}: ${line.length} chars`);
  }
  assert.ok(emitted > 0);
});

test('log-redaction: createLog hands the sink the sanitised object, and a broken sink cannot fail a request', () => {
  const got = [];
  const log = createLog((e) => got.push(e));
  log({ route: 'pullOps', status: 200, envelope: 'GEHEIM', ms: 4 });
  assert.deepEqual(got, [{ route: 'pullOps', status: 200, ms: 4 }]);
  assert.ok(!('envelope' in got[0]));

  const angry = createLog(() => { throw new Error('the log pipeline is down'); });
  assert.doesNotThrow(() => angry({ route: 'meta', status: 200 }), 'a diagnostic must never become an outage');
  assert.doesNotThrow(() => createLog(null)({ route: 'meta' }));
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. The source gates — modelled on E1's check-*.mjs: they can fail, and they name why
// ═════════════════════════════════════════════════════════════════════════════

function serverSources() {
  const out = [];
  const walk = (absDir, relDir) => {
    for (const e of fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(absDir, e.name);
      const rel = `${relDir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(abs, rel); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      out.push({ rel, src: fs.readFileSync(abs, 'utf8') });
    }
  };
  walk(path.join(REPO, 'server'), 'server');
  return out;
}

test('gate: nothing under server/core/ writes to the console', () => {
  // A `console.log(req.body)` left in after a debugging session is the single most likely way
  // ciphertext reaches Vercel's retained request logs. server/core is pure; the host is the only
  // place a line becomes output, and there is exactly one host.
  const offenders = [];
  for (const f of serverSources()) {
    if (!f.rel.startsWith('server/core/')) continue;
    const cleaned = stripCommentsAndStrings(f.src);
    cleaned.split('\n').forEach((line, i) => { if (/\bconsole\s*\./.test(line)) offenders.push(`${f.rel}:${i + 1}`); });
  }
  assert.deepEqual(offenders, [], 'server/core must reach the outside world only through ctx.log');
});

test('gate: every object literal handed to a log call uses only allowlisted keys', () => {
  // The other half of the redaction story: the sanitiser makes an unnamed field UNREACHABLE, and
  // this makes the call sites legible — a reviewer can read what the server says about a request
  // without tracing every helper. It covers `ctx.log({…})` and every local forwarder
  // (`logEvent(ctx, {…})`, `logOk(ctx, {…})`, `logLine(ctx, {…})`) in one rule, so a handler
  // written next month is covered without this test being edited.
  const problems = [];
  const DANGEROUS = /^(req|body|rawBody|envelope|ops?|err|error|payload|e)$/;

  for (const f of serverSources()) {
    const cleaned = stripCommentsAndStrings(f.src);
    const re = /\b(\w*[lL]og\w*)\s*\(/g;
    let m;
    while ((m = re.exec(cleaned))) {
      const callee = m[1];
      if (/^console$/.test(callee)) continue;
      const open = m.index + m[0].length - 1;
      const args = balancedParen(cleaned, open);
      if (args === null) continue;
      for (const arg of splitTopLevel(args)) {
        const t = arg.trim();
        if (t.startsWith('{')) {
          for (const key of topLevelKeys(balanced(t, 0))) {
            if (!LOG_FIELD_NAMES.includes(key)) {
              problems.push(`${f.rel}: ${callee}({ ${key}: … }) — ADR 003 §6.2 allows only ${LOG_FIELD_NAMES.join(', ')}`);
            }
          }
        } else if (DANGEROUS.test(t)) {
          problems.push(`${f.rel}: ${callee}(${t}) — a whole request/body/op/error may never be handed to a log call`);
        } else if (t.includes('...')) {
          problems.push(`${f.rel}: ${callee}(${t}) — a spread into a log call defeats the allowlist by construction`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('gate: the dev host logs through the sanitiser, and never a raw path', () => {
  // server/dev-server.mjs IS the process that prints a line per request on a developer's machine,
  // so the line it prints is worth a standing assertion.
  //
  // THIS GATE GOT STRICTER AT INTEGRATION (LZP-207), because the host got better. It used to
  // hand-write `const {route, spaceId, …} = evt` and print that, and this test read the
  // destructuring and checked the names. A hand-copied allowlist is a second copy of a privacy
  // policy, and the host had already drifted from it in the way that actually matters: it logged
  // `route: url.pathname`, a RAW PATH — which for `/api/v1/pair/<rid>` is HKDF output of the
  // pairing code, printed to stdout. The names were all allowlisted; the VALUE was the leak.
  //
  // So the host now calls `createLog(console.log)`, and this asserts the two properties that
  // make that safe: the sanitiser is really the one in use, and nothing path-shaped is handed to
  // it. `sanitizeLogEvent` then validates `route` against ROUTE_NAMES, so a path cannot survive
  // even if one were passed.
  const raw = read('server/dev-server.mjs');
  const cleaned = stripCommentsAndStrings(raw);

  assert.match(cleaned, /createLog\s*\(/, 'the dev host no longer logs through limits.js — a second allowlist has appeared somewhere');
  assert.doesNotMatch(
    cleaned, /log\s*:\s*\(\s*evt\s*\)/,
    'the dev host is hand-writing a log sink again. Use createLog(); a copied allowlist drifts.',
  );

  // every object literal handed to a `log(` call uses allowlisted keys only
  const problems = [];
  const re = /\blog\s*\(\s*\{/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const lit = balanced(cleaned, cleaned.indexOf('{', m.index + m[0].length - 1));
    if (!lit) continue;
    for (const key of topLevelKeys(lit)) {
      if (!LOG_FIELD_NAMES.includes(key)) problems.push(key);
    }
  }
  assert.deepEqual(problems, [], 'server/dev-server.mjs logs a field ADR 003 §6.2 does not allow');

  // and the specific regression: no `pathname`, no `req.url`, no `req.path` near a log call
  assert.doesNotMatch(
    cleaned, /log\s*\(\s*\{[^}]*\b(pathname|req\.url|req\.path)\b/,
    'the dev host is logging a raw path again — /api/v1/pair/<rid> is the pairing rendezvous id',
  );
});

test('gate: a route that declares a rate rule must actually reach store.rateAllow', () => {
  // THE ANTI-VAPOUR GATE, and the one the crypto red team's finding is really about.
  // `RATE_COVERAGE` says pushOps is limited. The moment `server/core/handlers/ops.js` exists,
  // that claim becomes checkable — and false unless the handler charges a bucket. Nothing is
  // asserted about handlers that do not exist yet; everything is asserted the day they land.
  //
  // The check is deliberately implementation-agnostic, and it follows the CALL GRAPH rather than
  // looking for one function name. LZP-202..204 shipped their own helpers over their own key
  // namespace — `rateGate` in ops.js, `enforceRate` in devices.js, `missingRendezvous` in
  // pair.js — instead of importing `enforceFor` (see the INTEGRATION WARNING in limits.js), and
  // that is protection, not a gap. So the gate asks the question that matters: does a budget get
  // charged, by any route, through however many helpers. A future handler that invents a fourth
  // helper is covered without editing this test; one that charges nothing is not.
  const dir = path.join(REPO, 'server/core/handlers');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.js')) : [];
  const handlerNames = new Set(files.map((f) => `server/core/handlers/${f}`));

  // Scan ALL of server/core, not only the handler directory: a shared helper that charges a
  // bucket may live one level up (this file's own `enforce` does), and a gate that walked only
  // `handlers/` would go blind the moment someone hoisted one — which is exactly the refactor
  // LZP-207 is expected to do.
  const sources = serverSources()
    .filter((f) => f.rel.startsWith('server/core/'))
    .map((f) => ({ rel: f.rel, src: stripCommentsAndStrings(f.src) }));

  // ── every top-level function in server/core, with its body ────────────────
  const funcs = new Map();                       // name -> {rel, body}
  for (const f of sources) {
    const re = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:function\s*)?\(/gm;
    const marks = [];
    let m;
    while ((m = re.exec(f.src))) marks.push({ name: m[1] || m[2], at: m.index });
    marks.forEach((mk, i) => {
      const stop = i + 1 < marks.length ? marks[i + 1].at : f.src.length;
      const body = f.src.slice(mk.at, stop);
      // a route handler must win over a same-named helper elsewhere
      if (!funcs.has(mk.name) || handlerNames.has(f.rel)) funcs.set(mk.name, { rel: f.rel, body });
    });
  }

  // ── which of them, transitively, charge a rate bucket ──────────────────────
  const charging = new Set(['rateAllow']);
  for (let pass = 0; pass < 10; pass++) {
    let grew = false;
    for (const [name, f] of funcs) {
      if (charging.has(name)) continue;
      for (const c of charging) {
        if (new RegExp(`\\b${c}\\s*\\(`).test(f.body)) { charging.add(name); grew = true; break; }
      }
    }
    if (!grew) break;
  }
  const chargesIn = (body) => [...charging].some((c) => new RegExp(`\\b${c}\\s*\\(`).test(body));

  let checked = 0;
  for (const [name, c] of Object.entries(RATE_COVERAGE)) {
    const declared = [...c.pre, ...c.post].filter((r) => !RATE_RULES[r].onFailureOnly);
    if (declared.length === 0) continue;
    const f = funcs.get(name);
    if (!f) continue;                                      // not written yet — nothing to check
    checked += 1;
    assert.ok(chargesIn(f.body),
      `${f.rel}: ${name} declares rate rules (${declared.join(', ')}) and never charges a budget. ` +
      'ADR 003 §6.1 is not advisory: an unlimited append or redeem endpoint on a public relay is ' +
      'the one thing that must not ship.');
  }

  // The failure-only budget (E2-L1 / E3-5) is spent on the MISS path, by a helper, not on entry.
  // It is the control that bounds guessing at the 60-bit pairing code, so its absence is checked
  // separately rather than being satisfied by the hourly pairGet limiter next to it.
  const missRoutes = Object.entries(RATE_COVERAGE)
    .filter(([, c]) => c.pre.some((r) => RATE_RULES[r].onFailureOnly)).map(([n]) => n);
  const allBodies = sources.filter((f) => handlerNames.has(f.rel)).map((f) => f.src).join('\n');
  for (const name of missRoutes) {
    if (!funcs.get(name)) continue;
    assert.match(allBodies, /noteFailedRidLookup\s*\(|miss/i,
      `${name} is implemented but nothing charges the FAILED-lookup budget. ADR 003 §6.1's ` +
      '"5 failed rid lookups per IP per minute" is what bounds guessing at the 60-bit pairing ' +
      'code; the 20-per-hour pairGet budget would let a guesser run for years.');
  }

  // and the gate must not pass by finding nothing to look at
  if (files.length > 0) {
    assert.ok(checked > 0, 'handler files exist but the gate matched no route function — the export shape changed and this gate went blind');
    assert.ok(charging.size > 1, 'no handler charges a rate bucket at all');
  }
});

test('gate: limits.js and version.js honour the ADR 003 §9 purity rule', () => {
  // The purity suite covers server/core generically (tests/tier1/core-purity.test.js). This is
  // the local, legible version so a failure here says what was wrong rather than which
  // directory walk found it.
  for (const rel of ['server/core/limits.js', 'server/core/version.js', 'server/core/handlers/meta.js']) {
    const cleaned = stripCommentsAndStrings(read(rel));
    for (const [name, re] of [
      ['Date.now', /\bDate\s*\.\s*now\b/], ['Math.random', /\bMath\s*\.\s*random\b/],
      ['process.env', /\bprocess\s*\.\s*env\b/], ['crypto.randomUUID', /\brandomUUID\b/],
      ['node:fs', /['"]node:fs/], ['setTimeout', /\bsetTimeout\b/],
    ]) {
      assert.doesNotMatch(cleaned, re, `${rel} uses ${name}; ADR 003 §9 says everything arrives through ctx`);
    }
  }
});

// ── tiny source helpers ──────────────────────────────────────────────────────

function firstNonSpace(s, i) { let j = i; while (j < s.length && /\s/.test(s[j])) j++; return j; }

function balanced(s, open) {
  if (s[open] !== '{') return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(open + 1, i); }
  }
  return null;
}

/** Top-level `key:` and bare `key` members of a (comment-and-string-stripped) object literal. */
function topLevelKeys(body) {
  const out = [];
  let depth = 0;
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    buf = '';
    if (!t) return;
    const m = /^([A-Za-z_$][\w$]*)\s*(:|$)/.exec(t);
    if (m) out.push(m[1]);
  };
  for (const ch of body) {
    if ('{(['.includes(ch)) depth++;
    else if ('})]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { flush(); continue; }
    buf += ch;
  }
  flush();
  return out;
}

function balancedParen(s, open) {
  if (s[open] !== '(') return null;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return s.slice(open + 1, i); }
  }
  return null;
}

/** Split an argument list at top-level commas. */
function splitTopLevel(argsText) {
  const out = [];
  let depth = 0;
  let buf = '';
  for (const ch of argsText) {
    if ('{(['.includes(ch)) depth++;
    else if ('})]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}
