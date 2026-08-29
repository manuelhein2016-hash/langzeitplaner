// TIER 1 · LZP-501 · `src/js/sync/protocol.js`.  ADR 003 §2, §3, §4, §8.2, §8.3.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE THREE THINGS THIS FILE IS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §1  THE SIGNED BYTES ARE ONE ANSWER IN THREE FILES. `signedString` and `canonicalQuery` exist in
//     `server/core/auth.js` (the verifier), `src/js/platform/net.js` (the signer) and
//     `src/js/sync/protocol.js` (the contract's declared home). ADR 005 §2's import direction
//     forbids removing the third, so the rule is enforced by running all three over one corpus and
//     asserting they agree CHARACTER FOR CHARACTER. Two files agreeing with the same prose is not
//     the same as two files agreeing with each other — and ADR 003 §2 leaves the sort domain of
//     `sortedQuery` unstated, which is exactly the kind of gap prose cannot close.
//
// §2  THE READERS ARE FED A HOSTILE RELAY. `readPullBody` is the client's only defence against a
//     `nextCursor` that skips: the AAD binds `v`, `sp`, `ep`, `dv`, `oid` and `wit`, and binds
//     NOTHING about `seq`, `chain`, `hasMore` or the cursor. Every field is refused or clamped
//     here or it is trusted for ever.
//
// §3  THE POLICY TABLE IS ENUMERATED. `interpret`, `backoffMs`, `pullDelayMs` and `classify` are
//     four small pure functions that decide whether a family's board syncs, hammers a wall, or
//     shows a glyph nobody can explain. They are tested over their whole input domain, not over
//     the happy path.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL, PROTO_MIN, PROTO_MAX, HDR, HDR_LC, LIMITS, CADENCE, PATHS,
  AUTH_SCHEME, SIGNED_PREFIX, NONCE_BYTES,
  parseSeq, isSeq, cmpSeq, ZERO_SEQ,
  canonicalQuery, signedString, buildAuthHeader, parseAuthHeader,
  readProtocolHeaders, checkProtocol, readPulledOp, readPullBody, readPushBody,
  interpret, retryAfterMs, backoffMs, pullDelayMs, classify,
  pushBody, pullQuery, CLOCK_SKEW_LIMIT_MS, HEALTHY_PULL_AGE_MS,
} from '../../src/js/sync/protocol.js';

import {
  canonicalQuery as netCanonicalQuery, signedString as netSignedString,
  SIGNED_PREFIX as NET_PREFIX, AUTH_SCHEME as NET_SCHEME, NONCE_BYTES as NET_NONCE,
} from '../../src/js/platform/net.js';

import { serverCanonicalQuery, serverSignedString } from '../helpers/relay-auth.js';
import { b64u } from '../../src/js/core/b64.js';

const OID = 'AAAAAAAAAAAAAAAAAAAAAA';
const OID2 = 'BBBBBBBBBBBBBBBBBBBBBB';
const SP = 'psp_9xQ2mR7bL0aZ4tV8wKQ1rT';
const DV = '7QAR2MZ9XKPNC0GV';

function envRow(over = {}) {
  return {
    seq: '1', chain: 'aaaa', v: 1, sp: SP, ep: 1, dv: DV, oid: OID, wit: '',
    iv: 'cccccccccccccccc', ct: 'ZGRk', sig: 'ZWVl', ...over,
  };
}
function pullRes(over = {}) {
  return {
    status: 200,
    headers: { 'x-lzp-protocol': '1', 'x-lzp-min-protocol': '1' },
    json: {
      ops: [], nextCursor: '0', hasMore: false, currentEpoch: 1,
      serverTime: 1787836800123, members: [], ...over,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §0 · Constants — the ones another file will disagree with if they drift
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§0 · the constants are the contract\'s', () => {
  test('the protocol window, the caps and the cadence match sync.contract.js §0', () => {
    assert.equal(PROTOCOL, 1);
    assert.equal(PROTO_MIN, 1);
    assert.equal(PROTO_MAX, 1);
    assert.deepEqual({ ...LIMITS }, {
      opsPerPush: 200, bytesPerEnvelope: 65536, bytesPerRequest: 4194304, opsPerPull: 500,
      authWindowMs: 120000, nonceTtlMs: 300000,
    });
    assert.deepEqual({ ...CADENCE }, {
      pushDebounceMs: 2000, pullVisibleMs: 45000, pullJitterMs: 15000, pullHiddenMs: 600000,
      backoffBaseMs: 2000, backoffMaxMs: 300000, pendingAfterMs: 20000, statusDebounceMs: 2000,
    });
    assert.equal(PATHS.ops, '/api/v1/ops');
    assert.equal(HDR.protocol, 'X-LZP-Protocol');
    assert.equal(HDR_LC.protocol, 'x-lzp-protocol');
  });

  test('this module and net.js agree on the four values a signature is made of', () => {
    // A drift in any one of these is a 401 nobody can reproduce.
    assert.equal(SIGNED_PREFIX, NET_PREFIX);
    assert.equal(AUTH_SCHEME, NET_SCHEME);
    assert.equal(NONCE_BYTES, NET_NONCE);
    assert.equal(SIGNED_PREFIX, 'lzp/v2\n');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · The signed bytes — three implementations, one answer
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · signedString and canonicalQuery agree across all three files', () => {
  /**
   * The corpus is chosen for the places ADR 003 §2 is SILENT, not for the places it is clear.
   */
  const QUERIES = [
    undefined, null, {}, { space: SP },
    { space: SP, since: '10201' },
    { since: '10201', space: SP },                       // key order must not matter
    { b: '1', a: '2' },
    { a: ['2', '1'] },                                   // a repeated key sorts by value
    { a: ['~', ' '] },
    // THE ONE THAT MATTERS: sort-before-encode and sort-after-encode disagree here. '~' is 0x7E
    // and sorts after 'a' raw; ' ' encodes to '%20' and sorts before everything. The relay pins
    // sort-AFTER-encode (E2-202-3) and both clients must too.
    { 'a~': 'x', 'a ': 'y' },
    { 'a b': 'c d', 'a+b': 'c+d' },
    { 'ü': 'ö' },
    { k: '' },
    { k: 0 },
    { drop: undefined, keep: '1' },
    { drop: null, keep: '1' },
    { 'a/b': 'c?d', e: 'f#g' },
    { '&': '=' },
  ];

  test('canonicalQuery is character-identical in protocol.js, net.js and the relay', () => {
    let checked = 0;
    for (const q of QUERIES) {
      const mine = canonicalQuery(q);
      assert.equal(mine, netCanonicalQuery(q), `net.js disagrees on ${JSON.stringify(q)}`);
      assert.equal(mine, serverCanonicalQuery(q), `the relay disagrees on ${JSON.stringify(q)}`);
      checked++;
    }
    assert.ok(checked >= 17, `only ${checked} queries checked`);
    // And the one the ADR does not state, pinned by value so a "simplification" is visible.
    assert.equal(canonicalQuery({ 'a~': 'x', 'a ': 'y' }), 'a%20=y&a~=x');
  });

  test('signedString is character-identical in all three, including the empty query', () => {
    const bodies = ['47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU', 'ZGVhZGJlZWY'];
    let checked = 0;
    for (const method of ['GET', 'POST', 'get']) {
      for (const path of [PATHS.ops, PATHS.meta, '/api/v1/spaces/psp_x/keys']) {
        for (const q of QUERIES) {
          for (const hash of bodies) {
            const p = {
              method, path, sortedQuery: canonicalQuery(q), bodyHashB64u: hash,
              ts: '1787836800123', nonce: 'AAECAwQFBgcICQoLDA0ODw',
            };
            const mine = signedString(p);
            assert.equal(mine, netSignedString(p));
            assert.equal(mine, serverSignedString(p));
            checked++;
          }
        }
      }
    }
    assert.ok(checked > 250, `only ${checked} strings compared`);
  });

  test('the "?" is unconditional and the string is never empty (ADR 002 §1 rule 2)', () => {
    // Dropping the separator when there is no query is the single most tempting simplification in
    // the file, and it would make every query-less request fail to verify.
    const s = signedString({
      method: 'POST', path: PATHS.ops, sortedQuery: '', bodyHashB64u: 'x', ts: '1', nonce: 'n',
    });
    assert.equal(s, 'lzp/v2\nPOST\n/api/v1/ops?\nx\n1\nn');
    assert.ok(s.startsWith(SIGNED_PREFIX));
    assert.notEqual(s.length, 0);
  });

  test('the method is upper-cased before it is signed', () => {
    const p = { path: '/api/v1/ops', sortedQuery: '', bodyHashB64u: 'x', ts: '1', nonce: 'n' };
    assert.equal(signedString({ ...p, method: 'get' }), signedString({ ...p, method: 'GET' }));
  });
});

describe('§1b · the Authorization header round-trips, and refuses everything else', () => {
  const good = buildAuthHeader({
    deviceShort: DV, ts: 1787836800123, nonceB64u: b64u(new Uint8Array(16)), sigB64u: b64u(new Uint8Array(64)),
  });

  test('a header this module built is a header this module parses', () => {
    assert.equal(good, `LZP1 device=${DV}, ts=1787836800123, nonce=${b64u(new Uint8Array(16))}, sig=${b64u(new Uint8Array(64))}`);
    const p = parseAuthHeader(good);
    assert.equal(p.deviceShort, DV);
    assert.equal(p.ts, 1787836800123);
  });

  test('every malformed shape is null — never a throw, never a partial parse', () => {
    const bad = [
      undefined, null, 42, '', 'LZP1', 'Bearer x', 'LZP2 device=x',
      good.replace('device=', 'devise='),                       // unknown parameter
      `${good}, device=${DV}`,                                  // duplicate
      good.replace(`device=${DV}`, 'device=short'),             // not 16 crockford
      good.replace(`device=${DV}`, 'device=IIIIIIIIIIIIIIII'),  // I is not in the alphabet
      good.replace('ts=1787836800123', 'ts=-1'),
      good.replace('ts=1787836800123', 'ts=1e9'),
      good.replace('ts=1787836800123', 'ts='),
      good.replace(/nonce=[^,]+/, 'nonce=****'),
      good.replace(/nonce=[^,]+/, `nonce=${b64u(new Uint8Array(15))}`),   // wrong width
      good.replace(/sig=.+$/, `sig=${b64u(new Uint8Array(63))}`),         // not P1363 64 bytes
      good.replace(', sig=', ' sig='),
    ];
    for (const h of bad) assert.equal(parseAuthHeader(h), null, `parsed: ${h}`);
    // …and the good one still parses, so the list above is not vacuously refusing everything.
    assert.notEqual(parseAuthHeader(good), null);
  });

  test('the scheme token is case-insensitive, as HTTP auth schemes are', () => {
    assert.notEqual(parseAuthHeader(good.replace('LZP1', 'lzp1')), null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · `seq` — BigInt or nothing
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · a seq is a canonical decimal string that does not fit in a double', () => {
  test('a seq above Number.MAX_SAFE_INTEGER still compares correctly', () => {
    const a = '9007199254740993';                 // 2^53 + 1
    const b = '9007199254740992';                 // 2^53
    assert.equal(Number(a) === Number(b), true, 'the double comparison this avoids really is broken');
    assert.equal(cmpSeq(a, b), 1, 'the BigInt comparison is not');
  });

  test('non-canonical spellings are refused, not coerced', () => {
    for (const v of ['007', ' 7', '7 ', '7.0', '+7', '-1', '0x7', '', 'seven', '1e3', null, undefined, {}, [], 7.5]) {
      assert.equal(parseSeq(v), null, `${JSON.stringify(v)} parsed`);
      assert.equal(isSeq(v), false);
    }
    assert.equal(String(parseSeq('0')), '0');
    assert.equal(String(parseSeq('10432')), '10432');
    assert.equal(ZERO_SEQ, '0');
  });

  test('cmpSeq is null — not 0 — when either side is not a seq', () => {
    // Returning 0 would make "is this cursor newer?" answer "no" for a garbage value, which is the
    // direction that loses ops.
    assert.equal(cmpSeq('1', 'x'), null);
    assert.equal(cmpSeq('x', '1'), null);
    assert.equal(cmpSeq('1', '1'), 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · The readers, fed a hostile relay
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · readPulledOp refuses every row that is not exactly an envelope', () => {
  test('the honest row is accepted and reduced to nine fields', () => {
    const r = readPulledOp(envRow());
    assert.notEqual(r, null);
    assert.deepEqual(Object.keys(r.env).sort(), ['ct', 'dv', 'ep', 'iv', 'oid', 'sig', 'sp', 'v', 'wit']);
    assert.equal(r.seq, '1');
  });

  test('a tenth field is refused — a field the client does not understand is one it would carry', () => {
    assert.equal(readPulledOp({ ...envRow(), extra: 1 }), null);
  });

  test('every missing or malformed member is refused, one at a time', () => {
    const cases = {
      'missing seq': (r) => { delete r.seq; },
      'missing chain': (r) => { delete r.chain; },
      'missing oid': (r) => { delete r.oid; },
      'seq not canonical': (r) => { r.seq = '01'; },
      'chain not b64u': (r) => { r.chain = '!!'; },
      'v is not an integer': (r) => { r.v = '1'; },
      'v is zero': (r) => { r.v = 0; },
      'sp is not a SpaceId': (r) => { r.sp = 'personal'; },
      'sp is the local space': (r) => { r.sp = 'local'; },
      'ep is zero': (r) => { r.ep = 0; },
      'dv is not 16 crockford': (r) => { r.dv = 'lowercase123456x'; },
      'oid is 21 chars': (r) => { r.oid = OID.slice(1); },
      'wit is not b64u': (r) => { r.wit = '###'; },
      'iv is not b64u': (r) => { r.iv = '@@'; },
      'ct is not a string': (r) => { r.ct = 3; },
      'sig is null': (r) => { r.sig = null; },
    };
    for (const [name, mutate] of Object.entries(cases)) {
      const r = envRow();
      mutate(r);
      assert.equal(readPulledOp(r), null, `${name} was accepted`);
    }
    // An EMPTY `wit` is legal — ADR 002 §5.1: "'' on the first push".
    assert.notEqual(readPulledOp(envRow({ wit: '' })), null);
  });

  test('a non-object is refused without throwing', () => {
    for (const v of [null, undefined, 3, 'x', []]) assert.equal(readPulledOp(v), null);
  });
});

describe('§3b · readPullBody is the client\'s only defence against a cursor that skips', () => {
  test('an honest empty page reads back with the caller\'s own cursor', () => {
    const r = readPullBody(pullRes({ nextCursor: '10201' }), '10201');
    assert.equal(r.ok, true);
    assert.equal(r.nextCursor, '10201');
    assert.equal(r.hasMore, false);
    assert.equal(r.cursorLie, null);
  });

  test('THE SKIP: a relay answering with the head is clamped to the last row RETURNED', () => {
    // This is the hazard `server/core/handlers/ops.js` documents from the other side: "a cursor
    // that advances past an op the client did not receive loses that op permanently and quietly".
    const res = pullRes({
      ops: [envRow({ seq: '11', oid: OID }), envRow({ seq: '12', oid: OID2 })],
      nextCursor: '9999',
      hasMore: false,
    });
    const r = readPullBody(res, '10');
    assert.equal(r.ok, true);
    assert.equal(r.nextCursor, '12', 'the cursor was clamped to the last op actually received');
    assert.match(r.cursorLie, /9999/);
  });

  test('a page that is not strictly ascending is refused outright', () => {
    for (const seqs of [['12', '11'], ['11', '11']]) {
      const res = pullRes({ ops: seqs.map((s, i) => envRow({ seq: s, oid: i ? OID2 : OID })) });
      const r = readPullBody(res, '10');
      assert.equal(r.ok, false, `${seqs} was accepted`);
      assert.match(r.why, /ascending/);
    }
  });

  test('a row at or below the cursor we asked from is refused — `WHERE seq > since`', () => {
    const res = pullRes({ ops: [envRow({ seq: '10' })] });
    assert.equal(readPullBody(res, '10').ok, false);
    assert.equal(readPullBody(res, '11').ok, false);
    assert.equal(readPullBody(res, '9').ok, true);
  });

  test('an empty page with hasMore:true is refused — it is an infinite loop, not a page', () => {
    const r = readPullBody(pullRes({ ops: [], hasMore: true, nextCursor: '10' }), '10');
    assert.equal(r.ok, false);
    assert.match(r.why, /cursor cannot advance/);
  });

  test('every scalar field is type-checked, and a coercible wrong type is still wrong', () => {
    const bad = {
      'ops is an object': { ops: {} },
      'ops is missing': { ops: undefined },
      'ops is over the cap': { ops: Array.from({ length: 501 }, (_, i) => envRow({ seq: String(i + 1), oid: OID })) },
      'hasMore is a string': { hasMore: 'false' },
      'nextCursor is null': { nextCursor: null },
      'nextCursor is a number': { nextCursor: 5 },
      'currentEpoch is zero': { currentEpoch: 0 },
      'currentEpoch is a string': { currentEpoch: '3' },
      'serverTime is a string': { serverTime: 'now' },
      'members is an object': { members: {} },
    };
    for (const [name, over] of Object.entries(bad)) {
      const res = pullRes(over);
      if (over.ops === undefined) delete res.json.ops;
      assert.equal(readPullBody(res, '0').ok, false, `${name} was accepted`);
    }
  });

  test('a body that is not an object at all is refused without throwing', () => {
    for (const j of [null, undefined, 3, 'x', []]) {
      assert.equal(readPullBody({ status: 200, json: j }, '0').ok, false);
    }
  });
});

describe('§3c · readPushBody merges accepted and duplicate into ONE list', () => {
  const receipt = (oid, seq) => ({ oid, seq, chain: 'aaaa' });

  test('both lists mean "the relay has it" (ADR 003 §3.1) and are one output', () => {
    const r = readPushBody({
      status: 200,
      json: { accepted: [receipt(OID, '5')], duplicate: [receipt(OID2, '3')], spaceSeq: '5', serverTime: 1 },
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.held.map((x) => x.oid).sort(), [OID, OID2].sort());
    assert.equal(r.spaceSeq, '5');
  });

  test('an id in BOTH lists is held once, not twice', () => {
    const r = readPushBody({
      status: 200,
      json: { accepted: [receipt(OID, '5')], duplicate: [receipt(OID, '5')], spaceSeq: '5' },
    });
    assert.equal(r.held.length, 1);
  });

  test('a malformed receipt refuses the whole body — nothing is acknowledged on a guess', () => {
    const bad = [
      { accepted: {}, duplicate: [], spaceSeq: '1' },
      { accepted: [], duplicate: {}, spaceSeq: '1' },
      { accepted: [receipt('short', '1')], duplicate: [], spaceSeq: '1' },
      { accepted: [{ oid: OID, chain: 'a' }], duplicate: [], spaceSeq: '1' },
      { accepted: [{ oid: OID, seq: '1' }], duplicate: [], spaceSeq: '1' },
      { accepted: [], duplicate: [], spaceSeq: 'x' },
      { accepted: [], duplicate: [] },
    ];
    for (const json of bad) assert.equal(readPushBody({ status: 200, json }).ok, false, JSON.stringify(json));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · The version gate
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · checkProtocol reads BOTH failure kinds with one parser', () => {
  test('426 is too_old and carries what the outdated screen needs', () => {
    const g = checkProtocol({
      status: 426,
      headers: { 'x-lzp-min-protocol': '2' },
      json: { error: 'protocol_too_old', minProto: 2, maxProto: 3, minClientVersion: '2.4.0' },
    });
    assert.equal(g.ok, false);
    assert.equal(g.kind, 'too_old');
    assert.equal(g.minProto, 2);
    assert.equal(g.minClientVersion, '2.4.0');
  });

  test('400 protocol_unknown is the DOWNGRADE case and takes the same screen', () => {
    const g = checkProtocol({ status: 400, headers: {}, json: { error: 'protocol_unknown', minProto: 2, minClientVersion: '2.4.0' } });
    assert.equal(g.kind, 'unknown');
  });

  test('a 426 whose body was dropped still says something true, from the header', () => {
    const g = checkProtocol({ status: 426, headers: { 'x-lzp-min-protocol': '4' }, json: null });
    assert.equal(g.minProto, 4);
    assert.equal(g.minClientVersion, null);
  });

  test('an ordinary 400 is NOT a protocol failure', () => {
    assert.deepEqual(checkProtocol({ status: 400, headers: {}, json: { error: 'bad_request' } }), { ok: true });
    assert.deepEqual(checkProtocol({ status: 200, headers: {}, json: {} }), { ok: true });
  });

  test('readProtocolHeaders refuses a header that is not a small integer', () => {
    for (const v of ['', 'x', '-1', '1.0', '1234567890', null, 3]) {
      assert.equal(readProtocolHeaders({ headers: { 'x-lzp-protocol': v } }).proto, null, String(v));
    }
    assert.equal(readProtocolHeaders({ headers: { 'x-lzp-protocol': '1' } }).proto, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · The policy table (ADR 003 §8.2)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · interpret gives four words and never a fifth', () => {
  const R = (status, error, headers) => interpret({ status, headers: headers || {}, json: error ? { error } : null });

  test('the whole table, row by row', () => {
    assert.equal(R(200).kind, 'ok');
    assert.equal(R(204).kind, 'ok');

    assert.equal(R(500).kind, 'retry');
    assert.equal(R(502).kind, 'retry');
    assert.equal(R(408).kind, 'retry', 'a timeout is a retry, not a verdict');

    assert.equal(R(429).kind, 'rate');

    for (const [status, code] of [[401, 'bad_signature'], [403, 'device_revoked'], [403, 'not_a_member'], [426, 'protocol_too_old']]) {
      const v = R(status, code);
      assert.equal(v.kind, 'stop', `${status} ${code}`);
    }
    assert.equal(R(401, 'bad_auth').errorKind, 'auth');
    assert.equal(R(426, 'protocol_too_old').errorKind, 'protocol');
    assert.equal(R(400, 'protocol_unknown').kind, 'stop');
    assert.equal(R(400, 'protocol_unknown').errorKind, 'protocol');

    assert.equal(R(409, 'forked_op_id').kind, 'reject');
    assert.equal(R(400, 'bad_request').kind, 'reject');
    assert.equal(R(413, 'payload_too_large').kind, 'reject');
  });

  test('a 409 names the forked opId only when it is really an opId', () => {
    const good = interpret({ status: 409, headers: {}, json: { error: 'forked_op_id', oid: OID } });
    assert.equal(good.forkedOid, OID);
    for (const oid of ['short', 42, null, undefined, '../../etc']) {
      const v = interpret({ status: 409, headers: {}, json: { error: 'forked_op_id', oid } });
      assert.equal(v.forkedOid, null, String(oid));
    }
  });

  test('a status that is not an integer is a retry, not a crash', () => {
    for (const s of [undefined, null, 'x', NaN]) {
      assert.equal(interpret({ status: s, headers: {}, json: null }).kind, 'retry');
    }
    assert.equal(interpret(null).kind, 'retry');
  });

  test('every kind produced is one of the five that were enumerated', () => {
    const kinds = new Set();
    for (const s of [200, 201, 400, 401, 403, 404, 408, 409, 410, 413, 426, 429, 500, 503, 599]) {
      kinds.add(interpret({ status: s, headers: {}, json: null }).kind);
    }
    for (const k of kinds) assert.ok(['ok', 'retry', 'stop', 'reject', 'rate'].includes(k), k);
  });
});

describe('§5b · Retry-After and the backoff', () => {
  test('Retry-After is read in seconds and clamped to the backoff ceiling', () => {
    assert.equal(retryAfterMs({ headers: { 'retry-after': '3' } }), 3000);
    assert.equal(retryAfterMs({ headers: { 'retry-after': ' 3 ' } }), 3000);
    // A `Retry-After: 86400` would otherwise silence a family's sync for a day on one header.
    assert.equal(retryAfterMs({ headers: { 'retry-after': '86400' } }), CADENCE.backoffMaxMs);
    for (const v of ['', 'x', '-1', '1.5', 'Wed, 21 Oct 2026 07:28:00 GMT', undefined]) {
      assert.equal(retryAfterMs({ headers: { 'retry-after': v } }), null, String(v));
    }
    assert.equal(retryAfterMs({}), null);
  });

  test('the backoff is FULL jitter: every delay is drawn from [0, 2^n × 2 s], capped at 300 s', () => {
    // Not "equal jitter" and not decorative. Eight family members woken by one Vercel cold start
    // must not re-synchronise on every retry (Risk R3).
    const ceilings = [2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000];
    ceilings.forEach((ceil, i) => {
      const n = i + 1;
      assert.equal(backoffMs(n, () => 0), 0, `n=${n} lower bound`);
      assert.equal(backoffMs(n, () => 0.999999), Math.floor(0.999999 * ceil), `n=${n} upper bound`);
      for (const r of [0.1, 0.5, 0.9]) {
        const ms = backoffMs(n, () => r);
        assert.ok(ms >= 0 && ms < ceil + 1, `n=${n} r=${r} gave ${ms}`);
      }
    });
    assert.equal(backoffMs(99, () => 0.5), 150000, 'the exponent is clamped, not overflowed');
  });

  test('a broken random source degrades to 0, never to NaN', () => {
    for (const bad of [() => NaN, () => -1, () => 1, () => 'x', null]) {
      const ms = backoffMs(3, bad);
      assert.equal(Number.isInteger(ms), true, String(ms));
      assert.ok(ms >= 0);
    }
  });

  test('two devices with different randomness get different delays — that IS the anti-herd', () => {
    const a = backoffMs(4, () => 0.2);
    const b = backoffMs(4, () => 0.8);
    assert.notEqual(a, b);
  });
});

describe('§5c · the pull cadence', () => {
  test('visible is 45 s ± 15 s and hidden is a flat 10 min', () => {
    assert.equal(pullDelayMs(true, () => 0.5), 45000);
    assert.equal(pullDelayMs(true, () => 0), 30000);
    assert.equal(pullDelayMs(true, () => 0.999999), 60000);
    assert.equal(pullDelayMs(false, () => 0), CADENCE.pullHiddenMs);
    assert.equal(pullDelayMs(false, () => 0.9), CADENCE.pullHiddenMs);
  });

  test('the jitter is re-drawn every call, so the fleet decorrelates instead of phase-shifting', () => {
    const seq = [0.1, 0.9, 0.3, 0.7];
    let i = 0;
    const r = () => seq[i++ % seq.length];
    const four = [pullDelayMs(true, r), pullDelayMs(true, r), pullDelayMs(true, r), pullDelayMs(true, r)];
    assert.equal(new Set(four).size, 4, 'the same jitter was reused across ticks');
  });

  test('a hostile cadence override cannot produce a negative delay', () => {
    assert.ok(pullDelayMs(true, () => 0, { pullVisibleMs: 10, pullJitterMs: 1000 }) >= 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · classify — the three states, and the one input that is deliberately absent
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§6 · classify (ADR 003 §8.3)', () => {
  const base = {
    pendingOps: 0, pendingSinceMs: null, online: true, consecutiveFailures: 0,
    lastPullAt: 1000, now: 1000, quarantined: 0, errorKind: null, clockSkewMs: 0,
  };

  test('healthy is the silent state, and it is reachable', () => {
    assert.equal(classify(base), 'healthy');
    // A pull that has never happened is not a failure — a launch must not greet the user with a glyph.
    assert.equal(classify({ ...base, lastPullAt: null }), 'healthy');
    // An outbox that is non-empty for LESS than 20 s is still healthy (§8.3's row).
    assert.equal(classify({ ...base, pendingOps: 3, pendingSinceMs: 1000, now: 1000 + 19999 }), 'healthy');
  });

  test('pending: offline, one or two failures, or a queue older than 20 s', () => {
    assert.equal(classify({ ...base, online: false }), 'pending');
    assert.equal(classify({ ...base, consecutiveFailures: 1 }), 'pending');
    assert.equal(classify({ ...base, consecutiveFailures: 4 }), 'pending');
    assert.equal(classify({ ...base, pendingOps: 1, pendingSinceMs: 0, now: 20001 }), 'pending');
    assert.equal(classify({ ...base, lastPullAt: 0, now: HEALTHY_PULL_AGE_MS + 1 }), 'pending');
  });

  test('error: five failures, auth, protocol, a quarantined op, a decrypt failure, or clock skew', () => {
    assert.equal(classify({ ...base, consecutiveFailures: 5 }), 'error');
    assert.equal(classify({ ...base, errorKind: 'auth' }), 'error');
    assert.equal(classify({ ...base, errorKind: 'protocol' }), 'error');
    assert.equal(classify({ ...base, errorKind: 'decrypt' }), 'error');
    assert.equal(classify({ ...base, quarantined: 1 }), 'error');
    assert.equal(classify({ ...base, clockSkewMs: CLOCK_SKEW_LIMIT_MS + 1 }), 'error');
    assert.equal(classify({ ...base, clockSkewMs: -(CLOCK_SKEW_LIMIT_MS + 1) }), 'error', 'skew is absolute');
    assert.equal(classify({ ...base, clockSkewMs: CLOCK_SKEW_LIMIT_MS }), 'healthy', 'and the boundary is not error');
  });

  test('error wins over pending — a device that is offline AND revoked shows the revocation', () => {
    assert.equal(classify({ ...base, online: false, errorKind: 'auth' }), 'error');
  });

  test('THE CHAIN WITNESS IS NOT AN INPUT, and that is deliberate', () => {
    // ADR 002 §5.4: detection-only, "it never blocks sync in v2". ADR 003 §8.3's error row
    // enumerates its causes and the chain is not among them. Letting a finding flip the indicator
    // would put a permanent glyph on the board of every family that ever removed a member, because
    // `POST /members/remove` purges op rows (ADR 003 §6.3) and the chain cannot then be recomputed.
    assert.equal(classify({ ...base, chainBroken: true, chainFindings: 12 }), 'healthy');
  });

  test('a raw status with missing members does not throw and does not invent an error', () => {
    assert.equal(classify({}), 'healthy');
    assert.equal(classify(null), 'healthy');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · The two request shapes
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§7 · pushBody and pullQuery', () => {
  test('`drained` is present only when it is TRUE — omitting it fails closed on the relay', () => {
    // `server/core/handlers/ops.js`: omitting it leaves `minLastPushedSeq` at 0 and no tombstone
    // is collected, which is the safe direction. Inventing a value resurrects deleted entries.
    assert.deepEqual(pushBody({ space: SP, ackSeq: '5', ops: [], drained: false }), { space: SP, ackSeq: '5', ops: [] });
    assert.deepEqual(pushBody({ space: SP, ackSeq: '5', ops: [], drained: true }), { space: SP, ackSeq: '5', ops: [], drained: true });
    // and nothing else ever rides along
    assert.deepEqual(Object.keys(pushBody({ space: SP, ackSeq: '0', ops: [], drained: true })).sort(),
      ['ackSeq', 'drained', 'ops', 'space']);
  });

  test('pullQuery omits `limit` when it is the server default — fewer signed bytes, one spelling', () => {
    assert.deepEqual(pullQuery(SP, '10', LIMITS.opsPerPull), { space: SP, since: '10' });
    assert.deepEqual(pullQuery(SP, '10', 2), { space: SP, since: '10', limit: '2' });
    assert.deepEqual(pullQuery(SP, 0, undefined), { space: SP, since: '0' });
    // every value is a string: a query parameter with several spellings is one whose canonical
    // form for signing is a matter of opinion.
    for (const v of Object.values(pullQuery(SP, 10, 3))) assert.equal(typeof v, 'string');
  });
});
