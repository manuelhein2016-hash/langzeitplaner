// tests/server/version.test.js — LZP-206: protocol versioning, the N−1 rule, the 22.7 gate.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROBLEM THIS FILE HAD TO SOLVE FIRST
// ─────────────────────────────────────────────────────────────────────────────
//
// v2.0 GA ships protocol 1. So `PROTO_MAX === 1`, therefore `PROTO_MIN === 1`, therefore there
// IS no previous protocol version today. Any compat test written against the module constants
// passes for the wrong reason — it proves that a server speaking {1} accepts a client speaking
// {1} — and it would keep passing on the day someone broke the rule, because the rule only has
// content once `PROTO_MAX` is 2.
//
// That is exactly the "vacuously true" trap ADR 003 §7's own amendment records for gate 1 of the
// solo-mode guarantee, and it is worth not repeating. So `version.js` exposes
// `createVersionGate({protoMax, protoFloor, minClientVersion})`, and §4 below instantiates the
// server AS IT WILL EXIST at protocol 2 and 3 and drives a real N−1 client through a real
// push/pull cycle against it, through the real router, over a real store, on a machine where
// protocol 2 does not exist yet.
//
// The synthetic client is synthetic in exactly one respect — it declares a protocol number a
// real build has not shipped yet. Everything under it is production code: `router.js`'s table,
// `version.js`'s gate, `limits.js`'s batch caps, and `memory.js`/`file.js`'s seq assignment,
// idempotency and cursor. When LZP-202 lands its handlers, §4.1 picks them up automatically (it
// imports `server/core/handlers/index.js` when the file exists) and reports which mode it ran
// in, so this file gets STRONGER on its own rather than needing to be remembered.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTO_MAX, PROTO_MIN, PROTO_FLOOR, PROTO_SUPPORTED, MIN_CLIENT_VERSION,
  PROTOCOL_HEADER, CLIENT_HEADER, RESPONSE_PROTOCOL_HEADER, RESPONSE_MIN_PROTOCOL_HEADER,
  WIRE_MIN_CLIENT_KEY, MANIFEST_MIN_VERSION_KEY, VERSION_EXEMPT, isVersionExempt,
  createVersionGate, GATE, versionHeaders, checkVersion, withVersionGate,
  parseVersion, compareVersions,
} from '../../server/core/version.js';
import { createRouter, ROUTE_NAMES } from '../../server/core/router.js';
import { toResponse, ERROR_CODES } from '../../server/core/errors.js';
import { LIMITS, assertBatch, pullLimit, createLog, withLimits } from '../../server/core/limits.js';
import { meta, META_KEYS, REGION } from '../../server/core/handlers/meta.js';
import { memoryStore } from '../../server/adapters/memory.js';
import { fileStore } from '../../server/adapters/file.js';
import { fixtures } from '../../server/core/store-interface.js';
import { stripCommentsAndStrings } from '../helpers/purity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const SPACE = 'fsp_AAAAAAAAAAAAAAAAAAAAAA';

// NO TEST MAY READ THE WALL CLOCK.
function fakeClock(startMs) {
  let t = startMs === undefined ? 1787836800000 : startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const tempDirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lzp-version-'));
  tempDirs.push(d);
  return d;
}
process.on('exit', () => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
});

const req = (method, path_, extra) => ({
  method, path: path_, query: {}, headers: {}, body: null, rawBody: new Uint8Array(0), ...extra,
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. The N−1 rule, as a property of the SOURCE and not of the current value
// ═════════════════════════════════════════════════════════════════════════════

test('PROTO_MIN is DERIVED — the supported window can never be narrower than N−1', () => {
  // The constraint (addendum §9): "The server always supports the current and the previous
  // client protocol version." Asserting `PROTO_MIN === 1` today would assert nothing: it is 1
  // for the trivial reason that PROTO_MAX is. So assert the derivation across the whole future
  // domain instead — every protoMax a release could plausibly declare, against every floor
  // someone could plausibly set, including floors deliberately chosen to break the rule.
  for (let max = 1; max <= 12; max++) {
    for (let floor = 1; floor <= 14; floor++) {
      const g = createVersionGate({ protoMax: max, protoFloor: floor });
      assert.equal(g.protoMax, max);
      assert.ok(g.protoMin >= 1, 'protocol numbers start at 1');
      assert.ok(g.protoMin <= max, `protoMin ${g.protoMin} > protoMax ${max}`);
      if (max > 1) {
        assert.ok(
          g.protoMin <= max - 1,
          `protoFloor ${floor} narrowed the window to {${g.protoMin}..${max}} — N−1 is unexpressible ` +
          'in the wrong direction and this is the assertion that keeps it that way',
        );
        assert.ok(g.supported.includes(max - 1), 'the PREVIOUS protocol must be supported');
      }
      assert.ok(g.supported.includes(max), 'the CURRENT protocol must be supported');
      // contiguous, ascending, no holes: a client cannot be told "1 and 3 but not 2"
      assert.deepEqual(g.supported, Array.from({ length: max - g.protoMin + 1 }, (_, i) => g.protoMin + i));
    }
  }
});

test('raising PROTO_FLOOR can only WIDEN the window, never narrow it past N−1', () => {
  // The scenario this guards: a release wants to stop serving protocol 1. The tempting edit is
  // `PROTO_FLOOR = PROTO_MAX`. That must be a no-op, so the only way to drop the previous
  // version is to bump PROTO_MAX again — which is the discipline the constraint is asking for.
  const naive = createVersionGate({ protoMax: 3, protoFloor: 3 });
  assert.deepEqual(naive.supported, [2, 3], 'setting the floor to protoMax must NOT drop protocol 2');
  const wide = createVersionGate({ protoMax: 3, protoFloor: 1 });
  assert.deepEqual(wide.supported, [1, 2, 3], 'a lower floor may serve a wider window during a long migration');
});

test('this build ships protocol 1 and the module constants agree with the default gate', () => {
  assert.equal(PROTO_MAX, 1, 'ADR 003 §4: v2.0 GA ships protocol 1');
  assert.equal(PROTO_FLOOR, 1);
  assert.equal(PROTO_MIN, Math.max(1, Math.min(PROTO_FLOOR, PROTO_MAX - 1)));
  assert.deepEqual([...PROTO_SUPPORTED], [1]);
  assert.equal(GATE.protoMax, PROTO_MAX);
  assert.equal(GATE.protoMin, PROTO_MIN);
  assert.equal(MIN_CLIENT_VERSION, '0.0.0', 'the client-version gate ships DISARMED; RELEASE §9');
  assert.equal(GATE.clientGateArmed, false);
});

test('version.js source states PROTO_MIN as a derivation, not as a literal', () => {
  // A future edit that "simplifies" `Math.max(1, Math.min(PROTO_FLOOR, PROTO_MAX - 1))` to `1`
  // would leave every test above green — they would all still be describing the derivation
  // helper — while the shipped constant became a literal that the next protocol bump forgets.
  const src = stripCommentsAndStrings(read('server/core/version.js'));
  const line = src.split('\n').find((l) => /export\s+const\s+PROTO_MIN\s*=/.test(l));
  assert.ok(line, 'PROTO_MIN is not exported from version.js');
  assert.match(line, /PROTO_MAX\s*-\s*1/, 'PROTO_MIN must be derived from PROTO_MAX, never assigned a literal');
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. The gate — the whole input domain, not the happy branch
// ═════════════════════════════════════════════════════════════════════════════

const withProto = (v) => req('POST', '/api/v1/ops', { headers: v === undefined ? {} : { [PROTOCOL_HEADER]: v } });

test('X-LZP-Protocol: every shape a caller can send, enumerated', () => {
  const g = createVersionGate({ protoMax: 2, protoFloor: 1 });   // supports {1,2}
  const at = (v) => { try { return { ok: true, proto: g.check(withProto(v)).proto }; } catch (e) { return { ok: false, code: e.code, status: e.status }; } };

  // accepted
  assert.deepEqual(at('1'), { ok: true, proto: 1 }, 'N−1 must be accepted — that is the whole rule');
  assert.deepEqual(at('2'), { ok: true, proto: 2 });
  assert.deepEqual(at('01'), { ok: true, proto: 1 }, 'a zero-padded integer is still that integer');

  // too old / unknown
  assert.deepEqual(at('0'), { ok: false, code: 'protocol_too_old', status: 426 });
  assert.deepEqual(at('3'), { ok: false, code: 'protocol_unknown', status: 400 });
  assert.deepEqual(at('999999999'), { ok: false, code: 'protocol_unknown', status: 400 });

  // absent → 426, deliberately: see the note in version.js. Every client that has ever existed
  // sends the header (ADR 003 §1), so absent means "older than the protocol" or "not a client",
  // and 426 is the one that produces an actionable sentence instead of a quiet failure (22.7).
  assert.deepEqual(at(undefined), { ok: false, code: 'protocol_too_old', status: 426 });
  assert.deepEqual(at(''), { ok: false, code: 'protocol_too_old', status: 426 });

  // malformed → 400 bad_request. NOT 426: "abc" is not a protocol older than ours, and telling
  // that caller to update would be a lie. NOT protocol_unknown either — ADR 003 §4 reserves that
  // for a value strictly ABOVE PROTO_MAX.
  for (const bad of [
    'abc', '1.0', '-1', '+1', ' 1', '1 ', '1e0', '0x1', '1,2', 'Infinity', 'NaN', 'null',
    '١',            // ARABIC-INDIC DIGIT ONE. `Number('١') === 1` in JavaScript, so
                         // without an explicit [0-9] regex this parses as protocol 1. The regex
                         // is load-bearing and this row is why.
    '１',                // FULLWIDTH DIGIT ONE — same trap.
    '1\n2', '1234567890',                        // ten digits: past the 1..9 cap
  ]) {
    assert.deepEqual(at(bad), { ok: false, code: 'bad_request', status: 400 }, `header ${JSON.stringify(bad)}`);
  }

  // non-string header values cannot come off a real HTTP host, but a loopback Transport can hand
  // one in; every one of them must fail closed rather than coerce.
  for (const weird of [1, true, [], {}, null]) {
    const r = (() => { try { g.check(req('POST', '/api/v1/ops', { headers: { [PROTOCOL_HEADER]: weird } })); return 'accepted'; } catch (e) { return e.code; } })();
    assert.ok(r === 'bad_request' || r === 'protocol_too_old', `header value ${JSON.stringify(weird)} was ${r}`);
  }
});

test('a 426 carries everything sync.contract.js §5 promises the client, and no more', () => {
  const g = createVersionGate({ protoMax: 3, protoFloor: 3, minClientVersion: '2.4.0' });
  let body;
  try { g.check(withProto('1')); assert.fail('protocol 1 must be refused by a {2,3} server'); }
  catch (e) { body = toResponse(e); }

  assert.equal(body.status, 426);
  // `checkProtocol` in docs/v2/contracts/sync.contract.js returns
  //   {ok:false, kind:'too_old'|'unknown', minProto:number, minClientVersion:string}
  // for BOTH kinds, so both fields ride on both — a client with one parser is not asked to grow
  // a second branch when it meets the other failure.
  assert.deepEqual(body.body, {
    error: 'protocol_too_old', minProto: 2, maxProto: 3, minClientVersion: '2.4.0',
  });
  assert.equal(ERROR_CODES.protocol_too_old, 426);

  let unknown;
  try { g.check(withProto('9')); } catch (e) { unknown = toResponse(e); }
  assert.equal(unknown.status, 400);
  assert.deepEqual(unknown.body, {
    error: 'protocol_unknown', minProto: 2, maxProto: 3, minClientVersion: '2.4.0',
  });
});

test('an error body never echoes anything from the request', () => {
  // errors.js FORBIDDEN_BODY_FIELDS is the mechanism; this asserts the version gate does not
  // route around it by building extras out of caller data.
  const g = createVersionGate({ protoMax: 2, protoFloor: 1, minClientVersion: '9.9.9' });
  const nasty = req('POST', '/api/v1/ops', {
    headers: { [PROTOCOL_HEADER]: '1', [CLIENT_HEADER]: 'Zahnarzt-14:30' },
    body: { ops: [{ ct: 'ZmFtaWx5LXNlY3JldA' }] },
  });
  let out;
  try { g.check(nasty); assert.fail('an unparsable client version against an armed gate must fail closed'); }
  catch (e) { out = toResponse(e); }
  const text = JSON.stringify(out);
  assert.ok(!text.includes('Zahnarzt'), 'the client header value reached the error body');
  assert.ok(!text.includes('ZmFtaWx5'), 'request body bytes reached the error body');
  assert.deepEqual(Object.keys(out.body).sort(), ['error', 'maxProto', 'minClientVersion', 'minProto']);
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. The minimum-client-version gate (22.7 / LZP-104) — and the field-name trap
// ═════════════════════════════════════════════════════════════════════════════

test('the client-version gate is disarmed at 0.0.0 and armed above it', () => {
  const off = createVersionGate({ protoMax: 1 });
  assert.equal(off.clientGateArmed, false);
  // With no gate, a client that sends no version header at all still syncs. That matters:
  // RELEASE §9 says the manifest is the primary gate and the server is the backstop, so the
  // backstop must not fire when nobody armed it.
  assert.deepEqual(off.check(withProto('1')), { proto: 1, clientVersion: null });

  const on = createVersionGate({ protoMax: 1, minClientVersion: '2.4.0' });
  assert.equal(on.clientGateArmed, true);
});

test('an armed gate: below → 426, at → pass, above → pass, absent/garbage → 426 (fail closed)', () => {
  const g = createVersionGate({ protoMax: 1, minClientVersion: '2.4.0' });
  const at = (client) => {
    const headers = { [PROTOCOL_HEADER]: '1' };
    if (client !== undefined) headers[CLIENT_HEADER] = client;
    try { return { ok: true, v: g.check(req('POST', '/api/v1/ops', { headers })).clientVersion }; }
    catch (e) { return { ok: false, code: e.code }; }
  };

  assert.deepEqual(at('2.3.9'), { ok: false, code: 'protocol_too_old' });
  assert.deepEqual(at('2.4.0-rc.1'), { ok: false, code: 'protocol_too_old' }, 'a pre-release sorts BELOW its release (semver §11)');
  assert.deepEqual(at('2.4.0'), { ok: true, v: '2.4.0' });
  assert.deepEqual(at('2.4.1'), { ok: true, v: '2.4.1' });
  assert.deepEqual(at('10.0.0'), { ok: true, v: '10.0.0' }, '10 > 2 numerically, not lexically');
  assert.deepEqual(at('v2.4.0'), { ok: true, v: '2.4.0' }, 'a pasted git tag still orders right');
  // Build metadata is ignored for ORDERING (semver §10) but is not stripped from the value: two
  // builds of the same version compare equal, and the gate passes both.
  assert.deepEqual(at('2.4.0+build.7'), { ok: true, v: '2.4.0+build.7' });
  assert.equal(compareVersions('2.4.0+build.7', '2.4.0'), 0);

  // FAIL CLOSED. An armed gate plus an unreadable client version is a client nobody can vouch
  // for, and 22.7's whole point is that such a client is TOLD rather than left to fail later in
  // some way it cannot explain.
  for (const bad of [undefined, '', '2.4', 'zwei-punkt-vier', '2.4.0.1', 'x'.repeat(200)]) {
    assert.deepEqual(at(bad), { ok: false, code: 'protocol_too_old' }, `client header ${JSON.stringify(bad)}`);
  }
});

test('the 426 names a version the client can put in its one plain sentence', () => {
  // src/js/i18n.js: updateRequired: (min) => `Diese Version ist zu alt. Bitte auf Version ${min}
  // oder neuer aktualisieren.` — so `min` must be a CLIENT SEMVER, never a protocol integer.
  const g = createVersionGate({ protoMax: 1, minClientVersion: '2.4.0' });
  let body;
  try { g.check(req('POST', '/api/v1/ops', { headers: { [PROTOCOL_HEADER]: '1', [CLIENT_HEADER]: '2.0.0' } })); }
  catch (e) { body = toResponse(e).body; }
  assert.equal(body[WIRE_MIN_CLIENT_KEY], '2.4.0');
  assert.ok(parseVersion(body[WIRE_MIN_CLIENT_KEY]), 'minClientVersion must parse as semver on the client side');
  assert.equal(typeof body.minProto, 'number', 'minProto is the PROTOCOL integer and is a different field');
});

test('THE FIELD-NAME TRAP: the two spellings stay on their own transports', () => {
  // E1 integration found the manifest generator writing `minClientVersion`, which no client
  // reads, so 22.7's gate was silently dead (docs/v2/E1-VERIFICATION.md, RELEASE §9). This is
  // the regression gate for that fix, from the server side, in both directions.
  assert.equal(WIRE_MIN_CLIENT_KEY, 'minClientVersion', 'the 426 body — ADR 003 §4, sync.contract.js §5');
  assert.equal(MANIFEST_MIN_VERSION_KEY, 'minimum_version', 'latest.json — updater.js parseManifest');
  assert.notEqual(WIRE_MIN_CLIENT_KEY, MANIFEST_MIN_VERSION_KEY);

  // the client half, as it exists on disk
  const updater = read('src/js/platform/updater.js');
  assert.ok(updater.includes("'minimum_version'"), 'updater.js parseManifest no longer reads minimum_version');
  const sync = read('docs/v2/contracts/sync.contract.js');
  assert.ok(sync.includes('minClientVersion'), 'sync.contract.js §5 no longer names minClientVersion');

  // the generator half: `minimum_version` must be the emitted KEY. `minClientVersion` may still
  // appear as a local variable name and as a CLI flag — those are E1's and they are correct —
  // so the check is run against comment-stripped source and looks for an object KEY.
  const genSrc = stripCommentsAndStrings(read('.github/scripts/make-update-manifest.mjs'));
  assert.match(genSrc, /\bminimum_version\s*:/, 'the manifest generator must emit `minimum_version`');
  assert.doesNotMatch(
    genSrc, /\bminClientVersion\s*:/,
    'the manifest generator is emitting `minClientVersion` again — no client reads it, and 22.7\'s ' +
    'gate would be silently dead for a second time. See docs/v2/E1-VERIFICATION.md.',
  );

  // and the server must never emit the manifest spelling on the wire
  const g = createVersionGate({ protoMax: 1, minClientVersion: '2.4.0' });
  let body;
  try { g.check(withProto('0')); } catch (e) { body = toResponse(e).body; }
  assert.ok(!(MANIFEST_MIN_VERSION_KEY in body), 'a server response used the manifest spelling');
});

test('the server comparator and the client comparator agree on every pair', () => {
  // Two implementations of semver ordering now exist — one here, one in
  // src/js/platform/updater.js — because ADR 005 §2 forbids server/core from importing the
  // desktop tree. Two implementations that disagree about which build is too old is a gate that
  // fires on the wrong machines, so they are cross-checked rather than trusted.
  const corpus = [
    '0.0.0', '0.0.1', '0.1.0', '1.0.0', '1.0.1', '1.1.0', '1.2.0', '1.10.0', '2.0.0', '2.4.0',
    '2.4.1', '10.0.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta',
    '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0+build.1', '2.4.0-rc.1',
  ];
  return import('../../src/js/platform/updater.js').then(({ compareVersions: clientCompare }) => {
    for (const a of corpus) {
      for (const b of corpus) {
        assert.equal(
          compareVersions(a, b), clientCompare(a, b),
          `server and client disagree on compare(${a}, ${b})`,
        );
      }
    }
  });
});

test('parseVersion refuses what is not a version, and never throws on a header', () => {
  for (const bad of [
    undefined, null, 1, {}, [], '', '1', '1.2', '1.2.3.4', '01.2.3', '1.02.3', 'v', 'vv1.2.3',
    ' 1.2.3', '1.2.3 ', '1.2.-3', '1.2.3-', 'x'.repeat(65), '1.2.3-01',
  ]) {
    assert.equal(parseVersion(bad), null, `parseVersion(${JSON.stringify(bad)})`);
  }
  assert.equal(compareVersions('1.2.3', 'nonsense'), null, 'an unparsable side yields null, and every caller here treats null as "refuse"');
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. THE COMPAT HARNESS — a synthetic N−1 client, a full push/pull cycle
// ═════════════════════════════════════════════════════════════════════════════

/**
 * The handlers the harness runs. When `server/core/handlers/index.js` exists (LZP-202..207) the
 * REAL registry is used and this file becomes a compat test over production handlers with no
 * edit. Until then, push and pull are ~30 lines that call the same store methods the real ones
 * will — `upsertOps`, `listOps`, `headSeq` — so seq assignment, idempotency and the cursor are
 * genuinely exercised; only the envelope-shaped bookkeeping is stubbed.
 */
async function loadHandlers() {
  const real = path.join(REPO, 'server/core/handlers/index.js');
  if (fs.existsSync(real)) {
    const mod = await import(real);
    if (mod && mod.handlers && typeof mod.handlers.pushOps === 'function') {
      // The REAL composition, not a reassembly of it: `createHandlers` is the function
      // `server/api/[[...path]].js` and `server/dev-server.mjs` both call, so the ordering
      // decision it encodes (version gate outermost, NO `withLimits` over self-limiting
      // handlers) is the one under test here rather than one this file invented.
      return { mode: 'real', handlers: mod.handlers, make: ({ gate }) => mod.createHandlers({ version: { gate } }) };
    }
  }
  return {
    mode: 'synthetic',
    handlers: syntheticHandlers(),
    make: ({ handlers, gate }) => createRouter(withVersionGate(withLimits(handlers), { gate })),
  };
}

function syntheticHandlers() {
  return {
    meta,
    pushOps: async (r, ctx) => {
      const body = r.body || {};
      assertBatch(body.ops, ctx.limits);                       // real limits.js, real caps
      const rows = (body.ops || []).map((o) => fixtures.op(o.oid, {
        epoch: o.ep, deviceShort: o.dv, envelope: new Uint8Array(Buffer.from(o.ct, 'base64')),
      }));
      const { inserted, existing } = await ctx.store.upsertOps(body.space, rows);
      return {
        status: 200,
        body: {
          accepted: inserted.map((x) => ({ oid: x.opId, seq: String(x.seq) })),
          duplicate: existing.map((x) => ({ oid: x.opId, seq: String(x.seq) })),
          spaceSeq: String(await ctx.store.headSeq(body.space)),
          serverTime: ctx.now(),
        },
      };
    },
    pullOps: async (r, ctx) => {
      const q = r.query || {};
      const since = /^[0-9]{1,19}$/.test(String(q.since || '0')) ? BigInt(q.since || '0') : 0n;
      const { ops, hasMore } = await ctx.store.listOps(q.space, since, pullLimit(q.limit, ctx.limits));
      const space = await ctx.store.getSpace(q.space);
      return {
        status: 200,
        body: {
          ops: ops.map((o) => ({
            seq: String(o.seq), oid: o.opId, ep: o.epoch, dv: o.deviceShort,
            ct: Buffer.from(o.envelope).toString('base64'),
          })),
          nextCursor: String(ops.length ? ops[ops.length - 1].seq : since),
          hasMore,
          currentEpoch: space ? space.currentEpoch : 1,
          serverTime: ctx.now(),
        },
      };
    },
  };
}

/**
 * The four synthetic Macs. Real `Device` and `Member` rows, so the real `pushOps`/`pullOps` run
 * against a real membership — only the SIGNATURE is stubbed (see `makeServer`'s `auth`).
 */
const FLEET_SHORTS = ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCC', 'DDDDDDDDDDDDDDDD'];
const memberIdOf = (short) => `mem_${short.repeat(2).slice(0, 22)}`;
const deviceIdOf = (short) => `dev_${short.repeat(2).slice(0, 22)}`;

/** A host: router + version gate + limits, plus the header/`toResponse` behaviour a real host has. */
async function makeServer({ gate, adapter, clock }) {
  const { mode, handlers, make } = await loadHandlers();
  const store = adapter === 'file' ? fileStore(tempDir(), { now: clock.now }) : memoryStore({ now: clock.now });
  await store.createSpace(fixtures.space({ id: SPACE }));
  // Seed the fleet. `colorRef` is under @@unique([spaceId, colorRef]), so one each.
  const colors = ['gruen', 'blau', 'rot', 'gelb'];
  for (let i = 0; i < FLEET_SHORTS.length; i++) {
    const short = FLEET_SHORTS[i];
    await store.addMember(fixtures.member({ id: memberIdOf(short), spaceId: SPACE, colorRef: colors[i] }));
    await store.addDevice(fixtures.device({ id: deviceIdOf(short), spaceId: SPACE, memberId: memberIdOf(short), deviceShort: short }));
  }
  const lines = [];
  const ctx = {
    store,
    now: clock.now,
    random: (n) => new Uint8Array(n),
    sha256: async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b)),
    limits: LIMITS,
    log: createLog((e) => lines.push(e)),
    // ── THE ONE STUB, AND EXACTLY WHAT IT STUBS ────────────────────────────────
    // This resolves the caller from `Authorization: LZP1 device=…` and then looks the Device and
    // Member rows up IN THE STORE, so membership, revocation and the space scope are all really
    // checked by the real handlers. What it does NOT do is verify a P-256 signature or claim a
    // nonce — ADR 003 §2's ladder is proved exhaustively, step by step and variant by variant,
    // by `tests/server/auth.test.js` (50 cases against both adapters), and re-proving it here
    // would make this file's subject the auth ladder instead of the N−1 rule. The distinction is
    // worth stating rather than blurring: this harness proves the VERSION GATE and the LOG over
    // production push/pull code; it proves nothing about signatures.
    auth: async (r) => {
      const h = (r.headers || {}).authorization || '';
      const m = /device=([0-9A-HJKMNP-TV-Z]{16})/.exec(h);
      if (!m) throw new Error('the harness client did not send an Authorization header');
      const dev = (await store.listDevicesByShort(m[1]))[0] || null;
      if (!dev || dev.revokedAt !== null) throw new Error('unknown device');
      return { deviceShort: dev.deviceShort, deviceId: dev.id, memberId: dev.memberId };
    },
    assertMember: async (memberId, spaceId) => {
      const members = await store.listMembers(spaceId);
      const found = members.find((x) => x.id === memberId && x.removedAt === null);
      if (!found) throw new Error('not a member');
      return found;
    },
  };
  const route = make({ handlers, gate });

  return {
    mode, ctx, lines, store,
    async call(r) {
      try {
        const res = await route(ctx, r);
        return { status: res.status, headers: { ...gate.headers(), ...(res.headers || {}) }, body: res.body };
      } catch (err) {
        const out = toResponse(err);
        // ADR 003 §4: EVERY response carries the window, errors included — otherwise a 426 is a
        // wall instead of a signpost. `server/dev-server.mjs` writes them unconditionally in
        // `writeHead`; this mirrors that.
        return { status: out.status, headers: { ...gate.headers(), ...out.headers }, body: out.body };
      }
    },
  };
}

/**
 * A wire-shaped envelope. Nine fields, exactly (ADR 002 §5.1), with the real sizes the real
 * `validateEnvelope` enforces — a 12-byte iv, a ct at least as long as an AES-GCM tag, and a
 * 64-byte P1363 signature. The `ct` is not a real sealing (no key material exists in this file),
 * and that is the point: the relay never opens one, so a random 32 bytes and Oma's birthday are
 * indistinguishable to every line of code under test.
 */
const b64uOf = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function envelopeFor(deviceShort, n) {
  const seed = `${deviceShort}#${n}`;
  const fill = (len, off) => Uint8Array.from({ length: len }, (_, i) => (seed.charCodeAt(i % seed.length) + i + off) & 0xff);
  return {
    v: 1, sp: SPACE, ep: 1, dv: deviceShort,
    oid: `${deviceShort}-${n}`.padEnd(22, 'x').slice(0, 22),
    wit: '',
    iv: b64uOf(fill(12, 0)),
    ct: b64uOf(fill(48, 7)),
    sig: b64uOf(fill(64, 13)),
  };
}

/** A client at a declared protocol. Everything else about it is ordinary. */
function makeClient(server, { proto, deviceShort, clientVersion }) {
  const headers = () => {
    const h = {
      [PROTOCOL_HEADER]: String(proto),
      // The harness auth stub reads only `device=` out of this; a real client's full
      // `LZP1 device=…, ts=…, nonce=…, sig=…` is exercised in auth.test.js.
      authorization: `LZP1 device=${deviceShort}, ts=0, nonce=AAAAAAAAAAAAAAAAAAAAAA, sig=x`,
    };
    if (clientVersion) h[CLIENT_HEADER] = clientVersion;
    return h;
  };
  const bodied = (obj) => {
    const rawBody = new Uint8Array(Buffer.from(JSON.stringify(obj), 'utf8'));
    return { headers: headers(), body: obj, rawBody };
  };
  let n = 0;
  return {
    deviceShort,
    push: (count) => server.call(req('POST', '/api/v1/ops', bodied({
      space: SPACE,
      ackSeq: '0',
      ops: Array.from({ length: count }, () => { n += 1; return envelopeFor(deviceShort, n); }),
    }))),
    repush: (oids) => server.call(req('POST', '/api/v1/ops', bodied({
      space: SPACE,
      ackSeq: '0',
      // Re-sent VERBATIM, as ADR 003 §8.1 requires of the outbox: same oid, same bytes. A
      // re-seal would change `ct` and earn a 409 forked_op_id, which is the client defect that
      // section exists to prevent — and which this harness would otherwise hide.
      ops: oids.map((oid) => {
        const k = Number(String(oid).split('-')[1].replace(/x+$/, ''));
        return envelopeFor(deviceShort, k);
      }),
    }))),
    pull: (since) => server.call(req('GET', '/api/v1/ops', {
      headers: headers(), query: { space: SPACE, since: String(since === undefined ? 0 : since), limit: '500' },
    })),
    meta: () => server.call(req('GET', '/api/v1/meta', { headers: headers() })),
  };
}

for (const adapter of ['memory', 'file']) {
  test(`[${adapter}] N−1 COMPAT: a protocol-2 server serves a mixed fleet of 1s and 2s`, async () => {
    // The scenario addendum §3 names: the server has redeployed with a breaking HTTP change and
    // half the family's Macs have not run the updater yet. Both halves must keep working, and
    // must converge on the same log.
    const clock = fakeClock();
    const gate = createVersionGate({ protoMax: 2, protoFloor: 1 });
    const server = await makeServer({ gate, adapter, clock });

    const fleet = [
      makeClient(server, { proto: 2, deviceShort: 'AAAAAAAAAAAAAAAA', clientVersion: '2.1.0' }),
      makeClient(server, { proto: 1, deviceShort: 'BBBBBBBBBBBBBBBB', clientVersion: '2.0.3' }),
      makeClient(server, { proto: 2, deviceShort: 'CCCCCCCCCCCCCCCC', clientVersion: '2.1.0' }),
      makeClient(server, { proto: 1, deviceShort: 'DDDDDDDDDDDDDDDD', clientVersion: '2.0.1' }),
    ];

    for (const d of fleet) {
      const res = await d.push(3);
      assert.equal(res.status, 200, `${d.deviceShort} was refused: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.accepted.length, 3);
      assert.equal(res.headers[RESPONSE_PROTOCOL_HEADER], '2');
      assert.equal(res.headers[RESPONSE_MIN_PROTOCOL_HEADER], '1');
    }

    // every device pulls the whole log and sees the same twelve ops, in the same order
    const seen = [];
    for (const d of fleet) {
      const res = await d.pull(0);
      assert.equal(res.status, 200);
      assert.equal(res.body.ops.length, 12, 'an N−1 client must receive the ops a current client pushed, and vice versa');
      seen.push(res.body.ops.map((o) => `${o.seq}:${o.oid}`).join('|'));
    }
    assert.equal(new Set(seen).size, 1, 'the fleet did not converge — the N−1 client saw a different log');
    assert.deepEqual(
      seen[0].split('|').map((s) => Number(s.split(':')[0])),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      'seq must be gapless and ascending across a mixed-protocol fleet',
    );

    // idempotency survives the protocol difference: an N−1 client re-pushing what a current
    // client already stored is a duplicate, not a fork and not a new seq.
    const first = (await fleet[1].pull(0)).body.ops.slice(0, 2).map((o) => o.oid);
    const again = await fleet[1].repush(first);
    assert.equal(again.status, 200);
    assert.equal(again.body.accepted.length, 0);
    assert.equal(again.body.duplicate.length, 2);
    assert.equal((await fleet[0].pull(0)).body.ops.length, 12, 'a re-push created rows');
  });
}

test('N−1 COMPAT: the harness reports which handlers it ran, so it cannot rot quietly', async () => {
  const clock = fakeClock();
  const server = await makeServer({ gate: createVersionGate({ protoMax: 2, protoFloor: 1 }), adapter: 'memory', clock });
  assert.ok(['real', 'synthetic'].includes(server.mode));
  // LZP-207 landed `server/core/handlers/index.js`, so the fallback is no longer reachable and
  // this file is now a compat test over PRODUCTION push and pull. Stated as an assertion, not as
  // a comment, so that deleting the composition site turns this red instead of quietly demoting
  // the N−1 proof back to a stub.
  assert.equal(server.mode, 'real', 'the compat harness is no longer running the real handlers');
  if (server.mode === 'synthetic') {
    assert.ok(
      !fs.existsSync(path.join(REPO, 'server/core/handlers/index.js')),
      'server/core/handlers/index.js exists but the compat harness fell back to synthetic handlers — ' +
      'it must exercise the REAL push/pull, or the N−1 rule is only proved about a stub',
    );
  }
});

test('a stranded client is refused cleanly and the rest of the family keeps syncing', async () => {
  // The failure mode 22.7 exists to prevent: one Mac that has not updated must not be able to
  // take the family's sync down with it, and must be told why in a form the outdated screen can
  // render.
  const clock = fakeClock();
  const gate = createVersionGate({ protoMax: 3, protoFloor: 3, minClientVersion: '2.4.0' });  // serves {2,3}
  const server = await makeServer({ gate, adapter: 'memory', clock });

  const current = makeClient(server, { proto: 3, deviceShort: 'AAAAAAAAAAAAAAAA', clientVersion: '2.4.0' });
  const previous = makeClient(server, { proto: 2, deviceShort: 'BBBBBBBBBBBBBBBB', clientVersion: '2.4.0' });
  const stranded = makeClient(server, { proto: 1, deviceShort: 'CCCCCCCCCCCCCCCC', clientVersion: '2.0.3' });

  assert.equal((await current.push(2)).status, 200);
  assert.equal((await previous.push(2)).status, 200, 'N−1 must still work while N−2 is being dropped');

  const refused = await stranded.push(2);
  assert.equal(refused.status, 426);
  assert.equal(refused.body.error, 'protocol_too_old');
  assert.equal(refused.body.minProto, 2);
  assert.equal(refused.body[WIRE_MIN_CLIENT_KEY], '2.4.0');
  assert.equal(refused.headers[RESPONSE_MIN_PROTOCOL_HEADER], '2', 'the 426 must carry the window it is enforcing');

  // and it changed nothing
  assert.equal((await current.pull(0)).body.ops.length, 4, 'a refused push wrote to the log');

  // the stranded client can still reach /meta — which is how it learns what to say (22.7)
  const m = await stranded.meta();
  assert.equal(m.status, 200, 'gating /meta would leave the outdated client unable to explain itself');
  assert.equal(m.body.minProto, PROTO_MIN, 'meta reports THIS build\'s window, not the harness gate\'s');
});

test('a client from the future gets 400 protocol_unknown, not a 426 telling it to upgrade', async () => {
  const clock = fakeClock();
  const gate = createVersionGate({ protoMax: 2, protoFloor: 1 });
  const server = await makeServer({ gate, adapter: 'memory', clock });
  const downgraded = makeClient(server, { proto: 5, deviceShort: 'AAAAAAAAAAAAAAAA', clientVersion: '3.0.0' });
  const res = await downgraded.push(1);
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'protocol_unknown');
  assert.equal(res.body.maxProto, 2, 'a downgraded client should be able to log what it was talking to');
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. The wrapper, the exemption, and the headers
// ═════════════════════════════════════════════════════════════════════════════

test('withVersionGate covers every handler in a registry and merges the headers', async () => {
  // The point of a registry wrapper: a route written in six months is covered without anyone
  // remembering. So the assertion is over ROUTE_NAMES, not over a hand-written list.
  const calls = [];
  const registry = {};
  for (const name of ROUTE_NAMES) {
    registry[name] = async () => { calls.push(name); return { status: 200, body: { name } }; };
  }
  const wrapped = withVersionGate(registry);
  assert.deepEqual(Object.keys(wrapped).sort(), [...ROUTE_NAMES].sort(), 'the wrapper dropped a handler');

  for (const name of ROUTE_NAMES) {
    const noHeader = req('POST', '/api/v1/x', { headers: {} });
    if (isVersionExempt(name)) {
      const res = await wrapped[name](noHeader, {});
      assert.equal(res.status, 200, `${name} is exempt and must answer without a protocol header`);
      assert.equal(res.headers[RESPONSE_MIN_PROTOCOL_HEADER], String(PROTO_MIN));
    } else {
      await assert.rejects(() => wrapped[name](noHeader, {}), (e) => e.code === 'protocol_too_old', `${name} is not gated`);
      const ok = await wrapped[name](req('POST', '/api/v1/x', { headers: { [PROTOCOL_HEADER]: String(PROTO_MAX) } }), {});
      assert.equal(ok.headers[RESPONSE_PROTOCOL_HEADER], String(PROTO_MAX));
      assert.equal(ok.headers[RESPONSE_MIN_PROTOCOL_HEADER], String(PROTO_MIN));
    }
  }
  assert.equal(calls.length, ROUTE_NAMES.length, 'a handler was skipped or double-called');
});

test('a handler may override the version headers only by naming them itself', () => {
  assert.deepEqual(versionHeaders(), {
    [RESPONSE_PROTOCOL_HEADER]: String(PROTO_MAX),
    [RESPONSE_MIN_PROTOCOL_HEADER]: String(PROTO_MIN),
  });
  assert.deepEqual(checkVersion(withProto(String(PROTO_MAX))), { proto: PROTO_MAX, clientVersion: null });
});

test('exactly `meta` is exempt from the version gate, and the exemption is justified', () => {
  assert.deepEqual([...VERSION_EXEMPT], ['meta']);
  for (const name of ROUTE_NAMES) assert.equal(isVersionExempt(name), name === 'meta');
  // Everything else being gated is the point: an ungated route is one a client below PROTO_MIN
  // can still reach, which turns "your app is too old" into "some things work and some do not".
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. GET /api/v1/meta  (RELEASE §7.4)
// ═════════════════════════════════════════════════════════════════════════════

test('meta returns exactly the four documented keys, and Frankfurt', async () => {
  const clock = fakeClock(1787836800123);
  const res = await meta(req('GET', '/api/v1/meta'), { now: clock.now });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [...META_KEYS].sort());
  assert.deepEqual(res.body, { region: 'fra1', minProto: PROTO_MIN, maxProto: PROTO_MAX, serverTime: 1787836800123 });
  assert.deepEqual(res.headers, versionHeaders());
});

test('meta REGION agrees with server/vercel.json — the Datenschutz text depends on it', () => {
  // Decision D2 / addendum §9. `.github/scripts/check-server-config.mjs` refuses any region but
  // fra1; this asserts the handler did not duplicate the value and then drift from it. If these
  // two ever disagree, the 21.3 copy telling the family their data is in Frankfurt is false.
  const v = JSON.parse(read('server/vercel.json'));
  assert.deepEqual(v.regions, ['fra1']);
  assert.equal(REGION, v.regions[0]);
  const release = read('docs/v2/RELEASE.md');
  assert.ok(release.includes('eu-central-1'), 'RELEASE no longer names the Prisma spelling of the same datacentre');
});

test('meta reads the injected clock and nothing else', async () => {
  const clock = fakeClock(1000);
  const a = await meta(req('GET', '/api/v1/meta'), { now: clock.now });
  clock.advance(5000);
  const b = await meta(req('GET', '/api/v1/meta'), { now: clock.now });
  assert.equal(b.body.serverTime - a.body.serverTime, 5000, 'serverTime must come from ctx.now()');
});

test('meta answers when the store is unreachable — it is how a broken deploy is diagnosed', async () => {
  // The claim in handlers/meta.js is "no database round trip". This is the assertion behind it:
  // any property access on the store throws, and the handler still answers 200.
  const exploding = new Proxy({}, { get() { throw new Error('the database is down'); } });
  const res = await meta(req('GET', '/api/v1/meta'), { store: exploding, now: () => 42 });
  assert.equal(res.status, 200);
  assert.equal(res.body.serverTime, 42);
});

test('meta leaks nothing family-shaped, whatever it is asked', async () => {
  // RELEASE §7.4: the smoke test asserts "nothing family-shaped leaks from an unauthenticated
  // endpoint". The response must not vary with the request at all — no echo, no counts, no
  // build identifiers, no adapter name, no uptime.
  const clock = fakeClock();
  const server = await makeServer({ gate: GATE, adapter: 'memory', clock });
  await makeClient(server, { proto: 1, deviceShort: 'AAAAAAAAAAAAAAAA' }).push(5);

  const probes = [
    req('GET', '/api/v1/meta'),
    req('GET', '/api/v1/meta', { query: { space: SPACE, debug: '1' } }),
    req('GET', '/api/v1/meta', { headers: { 'x-lzp-client': '2.0.3', authorization: 'LZP1 device=AAAAAAAAAAAAAAAA' } }),
  ];
  const bodies = [];
  for (const p of probes) {
    const res = await server.call(p);
    assert.equal(res.status, 200);
    bodies.push(JSON.stringify(res.body));
    const text = JSON.stringify(res.body);
    for (const leak of [SPACE, 'AAAAAAAAAAAAAAAA', 'memory', 'ops', 'count', 'member', 'device', 'space']) {
      assert.ok(!text.toLowerCase().includes(leak.toLowerCase()), `meta echoed ${leak}`);
    }
  }
  assert.equal(new Set(bodies).size, 1, 'meta answered differently to different callers');
});
