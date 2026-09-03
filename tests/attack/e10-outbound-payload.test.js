// tests/attack/e10-outbound-payload.test.js — E10 · THE STANDING BAR, A FIFTH TIME, THROUGH THE
// ONE OUTBOUND PATH E10 ACTUALLY ADDS.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE BAR, AND WHY IT IS RAISED AGAIN HERE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Four rounds have already stood it up, and none of them is repeated in this file:
//
//   · `tests/attack/e7-leak-downgrade.test.js`, `e7-leak-observer.test.js`, `e7-leak-routes.test.js`
//     — ADR 004's adversary. Every pre-seal plaintext, every sealed byte, every stored envelope,
//     and a decryption of the whole family log under every epoch key the family has ever held.
//   · `tests/fleet/e6-attack-privat.test.js`, `tests/fleet/e6-gate-privat.test.js` — the same
//     boundary from the fleet's positions, and from the refusal bodies round 3 invented.
//
// Zero bytes of a Privat entry, four times. This file is the fifth, and it exists because **E10
// adds an outbound path that none of those four rounds has ever seen**: `createBridgeTransport`
// hands `{url, method, headers, body}` to a native shell command, and the shell opens the socket.
// A new carrier is exactly where a boundary that has held four times breaks — the four rounds
// above all end at `transport.request`, and this one starts there.
//
// The task that commissioned this round asked for it "through the feedback endpoint" (LZP-1009).
// **There is no feedback endpoint.** 1009 was not delivered — `e10-network-scope.test.js` §2
// measures its absence in four independent places rather than asserting it in prose. So the
// round is run through the outbound path that does exist and that is genuinely new, which is the
// bridge; and §4 states precisely which half of the commissioned attack is therefore still owed.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT "GREP THE WHOLE PAYLOAD" MEANS HERE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Not "the body does not contain the string". Three spellings of every needle, over every part
// of the request:
//
//   1. THE UTF-8 BYTES, over the concatenation of url + method + every header name and value +
//      the body. A header is a place a leak hides precisely because nobody looks there.
//   2. THE b64url SPELLING, because everything in this protocol that is genuinely secret travels
//      base64url-encoded, and a field that was b64u'd without being encrypted would pass a plain
//      substring search while being perfectly readable to the relay.
//   3. THE JSON-ESCAPED SPELLING, because `JSON.stringify` rewrites `ö` as `ö` under some
//      engines' escaping settings and a needle with an umlaut in it would then not match itself.
//      Every needle here has an umlaut or a sharp s on purpose — a German board is the fixture.
//
// And the search is proved to search: §2 runs the identical function over the identical payload
// looking for things that legitimately ARE sent, and requires it to find every one of them.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import {
  makeMember, ring, mkSpaceId, mkOpId, mkGroupId, entityUuid, fmt, b64u, hdrFor,
} from './_member-kit.js';
import { sealOp } from '../../src/js/crypto/envelope.js';
import { projectForFamily, assertFamilyPatch } from '../../src/js/core/project.js';
import { createSpaceKey } from '../../src/js/crypto/spacekeys.js';
import { createBridgeTransport, createFetchTransport, chooseTransport } from '../../src/js/platform/net.js';
import { signBytes } from '../../src/js/crypto/identity.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FIXTURE BOARD — a real German one
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Five distinct needles, because "the note text did not leak", "the bar label did not leak" and
// "the category name did not leak" are three different claims and one needle would let two of
// them ride on the third. They are OWNED BY THIS FILE rather than imported from `_e7-leak-kit.js`
// — a shared needle would mean a failure here names that file's secrets, and a reader would go
// and look in the wrong place.
//
// Every one of them is a sentence a person would actually be upset to find on a relay.

const NEEDLE = Object.freeze({
  privatNote: 'Scheidungsanwältin Dr. Kübler 14:30',
  privatBar: 'Kur in Bad Wörishofen',
  category: 'Zweitfamilie Süd',
  diagnosis: 'Diagnose F32.1 — mittelgradige Episode',
  scratch: 'Passwort fürs Schließfach: Großmutter77',
});

/** What the family space is legitimately told about the same days (ADR 004 §2 GETEILT). */
const SHARED_LABEL = 'Sommerurlaub';

const TE = new TextEncoder();

/** The three spellings of one needle. See the header. */
function spellings(s) {
  const bytes = TE.encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jsonEscaped = JSON.stringify(s).slice(1, -1);
  const uEscaped = [...s].map((c) => (c.charCodeAt(0) > 127
    ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c)).join('');
  return [s, b64, jsonEscaped, uEscaped];
}

/**
 * THE WHOLE PAYLOAD, AS ONE SEARCHABLE STRING.
 *
 * url, method, every header name AND value, and the body. Nothing is skipped, including the
 * parts a reviewer's eye slides over — a `X-LZP-Client` that had grown a board summary would be
 * found by this and by nothing else in the suite.
 */
function flatten(req) {
  const parts = [String(req.url), String(req.method)];
  for (const [k, v] of Object.entries(req.headers || {})) parts.push(String(k), String(v));
  if (typeof req.body === 'string') parts.push(req.body);
  else if (req.body != null) parts.push(JSON.stringify(req.body));
  // Joined with a NUL rather than a space, written as an escape so this file stays text. The
  // separator matters: a needle must never be able to straddle two parts and match across the
  // boundary between, say, a header value and the body. NUL cannot occur inside any of them.
  return parts.join('\u0000');
}

/** Which spellings of `needle` appear in `hay`. Empty is the claim; non-empty is the leak. */
function found(hay, needle) {
  return spellings(needle).filter((s) => s.length > 0 && hay.includes(s));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RIG — one real member, one real device, real keys, real seals
// ═════════════════════════════════════════════════════════════════════════════════════════════

const S = globalThis.crypto.subtle;

/** Everything §1–§3 share. Built once; a fresh AES key per space, as the product does. */
const rig = {};

before(async () => {
  const papa = await makeMember(1);
  const dev = papa.devices[0];
  const personal = mkSpaceId('personal');
  const family = mkSpaceId('family');
  const kPersonal = await createSpaceKey({ subtle: S });
  const kFamily = await createSpaceKey({ subtle: S });
  const keyring = ring([[personal, 1, kPersonal], [family, 1, kFamily]]);

  const ctx = { subtle: S, attestation: dev.att };

  /** A Privat entry, on the PERSONAL space. Nothing about it is ever meant for the family. */
  const privatNote = {
    v: 1, id: mkOpId(), ts: fmt(1787836800100, 3, dev.deviceShort), space: personal,
    act: papa.memberId, dev: dev.deviceId, gid: mkGroupId(), k: 'note.set',
    e: `note:${entityUuid()}`,
    f: { date: '2027-03-11', text: NEEDLE.privatNote, categoryId: 'cat-1' },
  };
  const privatBar = {
    v: 1, id: mkOpId(), ts: fmt(1787836800101, 3, dev.deviceShort), space: personal,
    act: papa.memberId, dev: dev.deviceId, gid: mkGroupId(), k: 'bar.set',
    e: `bar:${entityUuid()}`,
    f: { startDate: '2027-07-01', endDate: '2027-07-14', label: NEEDLE.privatBar, categoryId: 'cat-1' },
  };
  const cat = {
    v: 1, id: mkOpId(), ts: fmt(1787836800102, 3, dev.deviceShort), space: personal,
    act: papa.memberId, dev: dev.deviceId, gid: mkGroupId(), k: 'cat.set',
    e: `cat:${entityUuid()}`,
    f: { name: NEEDLE.category, paletteRef: 'gruen', visible: true },
  };
  const pad = {
    v: 1, id: mkOpId(), ts: fmt(1787836800103, 3, dev.deviceShort), space: personal,
    act: papa.memberId, dev: dev.deviceId, gid: mkGroupId(), k: 'pad.set',
    e: 'pad:2027-03',
    f: { text: `${NEEDLE.diagnosis}\n${NEEDLE.scratch}` },
  };

  /**
   * The projected family entry for the SAME fortnight — what the family is allowed to see.
   *
   * Built through `projectForFamily`, which is the ONLY function in the product that may turn
   * truth into a family patch (ADR 004 §2.2 barrier 3). A hand-written patch is refused by
   * `sealOp` — measured in §1f, because the refusal is a load-bearing part of this round: it
   * means no test, including this one, can smuggle a plaintext onto the wire by accident and
   * then congratulate itself for not finding it.
   */
  const projected = projectForFamily('fbar', {
    startDate: '2027-07-01', endDate: '2027-07-14', label: SHARED_LABEL,
    categoryId: 'cat-1', visibility: 'geteilt', coEdit: false, _alive: true,
    _born: fmt(1787836800000, 1, dev.deviceShort),
  }, 'geteilt', null);
  const familyBar = {
    v: 1, id: mkOpId(), ts: fmt(1787836800110, 3, dev.deviceShort), space: family,
    act: papa.memberId, dev: dev.deviceId, gid: mkGroupId(), k: 'pub.set',
    e: `fbar:${papa.memberId}/${entityUuid()}`,
    f: projected,
  };

  const sealPersonal = (op) => sealOp(op, keyring, dev.devSig.privateKey, hdrFor(op, dev, 1), ctx);
  rig.personalEnvelopes = [];
  for (const op of [privatNote, privatBar, cat, pad]) rig.personalEnvelopes.push(await sealPersonal(op));
  // Barrier 4: the level is RE-DERIVED at the seal, from the entity's own authenticated
  // `visibility` truth register — never taken from the patch. The outbox's obligation, wired
  // here the way `family/engine.js` wires it.
  rig.familyEnvelope = await sealOp(familyBar, keyring, dev.devSig.privateKey, hdrFor(familyBar, dev, 1),
    { ...ctx, assertFamilyPatch, levelOf: (e) => (e === familyBar.e ? 'geteilt' : null) });

  rig.papa = papa;
  rig.dev = dev;
  rig.familyKey = kFamily;
  rig.personal = personal;
  rig.family = family;
  rig.preSealPlaintext = JSON.stringify([privatNote, privatBar, cat, pad, familyBar]);

  /** The transport config the product builds — `sign` is the injected port, as in production. */
  rig.deps = {
    origin: 'https://relay.example.com',
    clientVersion: 'lzp/2.0.0 (darwin)',
    deviceShort: dev.deviceShort,
    sign: (bytes) => signBytes(dev.devSig.privateKey, bytes, { subtle: S }),
    subtle: S,
  };
});

/** Drive one real push through the bridge and capture everything that crosses it. */
async function pushOverBridge(space, envelopes, extra = {}) {
  const crossed = [];
  const t = createBridgeTransport({
    ...rig.deps,
    invoke: async (cmd, args) => {
      crossed.push({ cmd, args });
      // The shell must name the URL the bytes came from and deny a redirect (finding P-5);
      // `createBridgeTransport` refuses an answer that does not. Echoing the request's own URL is
      // what an honest shell does, and it keeps this rig on the product's real success path.
      return { status: 200, headers: {}, body: '{"ok":true}', url: args.url, redirected: false };
    },
    ...extra,
  });
  await t.request('POST', '/api/v1/ops', {}, { space, ackSeq: 0, ops: envelopes, drained: true });
  return crossed;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE FIFTH ROUND — zero bytes of a Privat entry across the bridge
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · the bridge carries the board and not one byte of a Privat entry', () => {
  test('§1a · the personal push: five needles, three spellings each, whole payload — nothing', async () => {
    const crossed = await pushOverBridge(rig.personal, rig.personalEnvelopes);
    assert.equal(crossed.length, 1, 'the bridge was asked more than once for one request');
    assert.equal(crossed[0].cmd, 'sync_request', `the bridge command is ${crossed[0].cmd}`);
    const hay = flatten(crossed[0].args);
    for (const [name, needle] of Object.entries(NEEDLE)) {
      assert.deepEqual(found(hay, needle), [],
        `${name} crossed the bridge in the clear: ${JSON.stringify(needle)}`);
    }
  });

  test('§1b · the FAMILY push carries no Privat needle either, and the two spaces never mix', async () => {
    // The push the family space really makes. Its only content is the projected `fbar` — and the
    // four personal envelopes above cannot appear in it, in any spelling, because they were
    // sealed under a different key for a different space and a different outbox.
    const crossed = await pushOverBridge(rig.family, [rig.familyEnvelope]);
    const hay = flatten(crossed[0].args);
    for (const [name, needle] of Object.entries(NEEDLE)) {
      assert.deepEqual(found(hay, needle), [], `${name} reached the FAMILY bridge payload`);
    }
    // and the space it names is the family one, not the personal one — the mix-up that would put
    // a personal envelope in a family batch names itself here.
    assert.ok(hay.includes(rig.family), 'the family push does not name the family space');
    assert.equal(hay.includes(rig.personal), false, 'the family push names the PERSONAL space id');
  });

  test('§1c · the shared label is sealed too — „versiegelt" here means unreadable, not just intact', async () => {
    // The one string that is legitimately on this board's family side. It is still not in the
    // clear: the relay stores ciphertext it cannot read (21.1). This row is what separates
    // "the redaction boundary held" from "the encryption held" — both are claims and this is the
    // second one, measured on the same payload.
    const crossed = await pushOverBridge(rig.family, [rig.familyEnvelope]);
    const hay = flatten(crossed[0].args);
    assert.deepEqual(found(hay, SHARED_LABEL), [],
      'the shared label is on the wire in the clear — the family envelope is not sealed');
  });

  test('§1d · a GET carries no body at all, so the pull leg cannot leak by accident', async () => {
    const crossed = [];
    const t = createBridgeTransport({
      ...rig.deps,
      invoke: async (cmd, args) => {
        crossed.push(args);
        return { status: 200, headers: {}, body: '{}', url: args.url, redirected: false };
      },
    });
    await t.request('GET', '/api/v1/ops', { space: rig.personal, since: '0' });
    assert.equal(crossed[0].body, '', 'a GET crossed the bridge carrying a body');
    const hay = flatten(crossed[0]);
    for (const needle of Object.values(NEEDLE)) assert.deepEqual(found(hay, needle), []);
  });

  test('§1e · the bridge hands the shell FOUR fields, and a board cannot ride in a fifth', async () => {
    // The structural half of the same claim. Whatever the page believes it is sending, the
    // bridge's argument object has exactly four keys — so a future field carrying "context for
    // the support team" would be a visible change to this row rather than an invisible one to a
    // payload. This is the assertion `sync_request`'s far side is written against, and the shell
    // has its own allowlist (`SYNC_HEADER_ALLOWLIST`) below it.
    const crossed = await pushOverBridge(rig.personal, rig.personalEnvelopes);
    assert.deepEqual(Object.keys(crossed[0].args).sort(), ['body', 'headers', 'method', 'url']);
    assert.deepEqual(Object.keys(crossed[0].args.headers).sort(),
      ['Authorization', 'Content-Type', 'X-LZP-Client', 'X-LZP-Protocol'],
      'the request grew a header the protocol does not define');
  });

  test('§1f · the fifth round could not have cheated: a hand-built patch cannot be sealed', async () => {
    // Discovered while BUILDING this file, and worth a row of its own. Every needle in §1 is a
    // string this test put on a board and then failed to find on a wire — and the obvious way for
    // such a test to be worthless is for the plaintext never to have had a route to the wire at
    // all. It does not, and the reason is a refusal, not an omission: `sealOp` rejects a family
    // patch that did not come out of `projectForFamily`, by brand, before it encrypts anything.
    //
    // So the rig above had to go through the product's own projection to get its family op — and
    // any FUTURE round that tries to smuggle a raw truth field onto the family wire will be
    // stopped here rather than quietly producing a green absence.
    const raw = {
      v: 1, id: mkOpId(), ts: fmt(1787836800199, 3, rig.dev.deviceShort), space: rig.family,
      act: rig.papa.memberId, dev: rig.dev.deviceId, gid: mkGroupId(), k: 'pub.set',
      e: `fbar:${rig.papa.memberId}/${entityUuid()}`,
      f: { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.label': NEEDLE.privatBar },
    };
    await assert.rejects(
      () => sealOp(raw, ring([[rig.family, 1, rig.familyKey]]), rig.dev.devSig.privateKey,
        hdrFor(raw, rig.dev, 1),
        { subtle: S, attestation: rig.dev.att, assertFamilyPatch, levelOf: () => 'geteilt' }),
      (e) => /barrier 3|UNBRANDED/i.test(String(e && e.message)),
      'a hand-built family patch was sealed — barrier 3 is not enforced and §1 could be cheated');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE SEARCH IS PROVED TO SEARCH
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Every row in §1 is an absence, and an absence is what a broken matcher also produces. These
// rows run the IDENTICAL function over the IDENTICAL payload looking for things that are
// legitimately sent, and require it to find all of them.

describe('§2 · the positive control — the same search finds what IS sent', () => {
  test('§2a · the payload really does carry the space id, the device, the client and the auth', async () => {
    const crossed = await pushOverBridge(rig.personal, rig.personalEnvelopes);
    const hay = flatten(crossed[0].args);
    const mustFind = {
      'the space id': rig.personal,
      'the device short id': rig.dev.deviceShort,
      'the client version': rig.deps.clientVersion,
      'the auth scheme': 'LZP1',
      'the endpoint path': '/api/v1/ops',
      'the origin': 'relay.example.com',
    };
    for (const [what, s] of Object.entries(mustFind)) {
      assert.ok(found(hay, s).length > 0,
        `the search did not find ${what} — every absence in §1 is therefore worthless`);
    }
  });

  test('§2b · and it finds the SEALED bytes, so it is reading the body and not only the headers', async () => {
    const crossed = await pushOverBridge(rig.personal, rig.personalEnvelopes);
    const hay = flatten(crossed[0].args);
    for (const env of rig.personalEnvelopes) {
      assert.ok(hay.includes(env.ct), 'a sealed ciphertext is not in the payload the search read');
      assert.ok(hay.includes(env.sig), 'an envelope signature is not in the payload the search read');
    }
  });

  test('§2c · the needles really were on the board — the fixture is not empty', () => {
    // The other half of non-vacuity: §1 would also be green if the board had never carried the
    // secrets. The pre-seal plaintext is searched with the same function, and every needle must
    // be there, in the same three spellings.
    for (const [name, needle] of Object.entries(NEEDLE)) {
      assert.ok(found(rig.preSealPlaintext, needle).length > 0,
        `${name} was never on the fixture board — §1 proved nothing about it`);
    }
    assert.ok(found(rig.preSealPlaintext, SHARED_LABEL).length > 0);
  });

  test('§2d · ARMED — a needle planted in the payload IS caught', async () => {
    // The last way §1 could be vacuous: `flatten` returning something the search cannot read.
    // A payload with a secret deliberately added to a header is built and shown to the search.
    const crossed = [];
    const t = createBridgeTransport({
      ...rig.deps,
      invoke: async (cmd, args) => {
        crossed.push(args);
        return { status: 200, headers: {}, body: '{}', url: args.url, redirected: false };
      },
    });
    await t.request('POST', '/api/v1/ops', {}, { space: rig.personal, ops: [] },
      { 'X-Debug-Context': NEEDLE.diagnosis });
    const hay = flatten(crossed[0]);
    assert.ok(found(hay, NEEDLE.diagnosis).length > 0,
      'a secret placed in a header of the real request was NOT found — §1 is measuring nothing');
  });

  test('§2e · and the b64u spelling is caught too, which a plain substring search would miss', () => {
    // The spelling that matters most, because a field that was base64url-encoded without being
    // encrypted is perfectly readable to a relay and invisible to `hay.includes(secret)`.
    const encoded = b64u(TE.encode(NEEDLE.scratch));
    const hay = flatten({ url: 'https://relay.example.com/api/v1/ops', method: 'POST', headers: {}, body: `{"note":"${encoded}"}` });
    assert.equal(hay.includes(NEEDLE.scratch), false, 'the plain search would have found it — wrong control');
    assert.ok(found(hay, NEEDLE.scratch).length > 0, 'the b64u spelling was not searched for');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE OTHER TRANSPORT, AND THE ANONYMOUS ONE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · the same bar over every transport shape that ships', () => {
  test('§3a · the fetch transport — the dev-server path — carries the same and no more', async () => {
    // `createFetchTransport` is what `node dev-server.mjs` uses and it is THE ONE `fetch` in the
    // product. A leak that existed only on this leg would be invisible to §1.
    let seen = null;
    const t = createFetchTransport({
      ...rig.deps,
      fetchImpl: async (url, init) => {
        seen = { url, method: init.method, headers: init.headers, body: init.body };
        return { status: 200, headers: new Map(), text: async () => '{}' };
      },
    });
    await t.request('POST', '/api/v1/ops', {}, { space: rig.personal, ackSeq: 0, ops: rig.personalEnvelopes, drained: true });
    const hay = flatten({ ...seen, body: seen.body instanceof Uint8Array ? new TextDecoder().decode(seen.body) : seen.body });
    for (const [name, needle] of Object.entries(NEEDLE)) {
      assert.deepEqual(found(hay, needle), [], `${name} is on the fetch leg`);
    }
    assert.ok(found(hay, rig.personal).length > 0, 'and the control still holds on this leg');
  });

  test('§3b · chooseTransport picks the bridge when a shell is present — the shipped path', () => {
    // Which leg the product actually takes on a real Mac. A `fetch` here would be a bug in gate 3
    // (the shell navigation gate), and `net.js` says so in its own words.
    const { kind } = chooseTransport({ ...rig.deps, invoke: async () => ({ status: 200 }) });
    assert.equal(kind, 'bridge');
    assert.equal(chooseTransport({ ...rig.deps, fetchImpl: async () => ({}) }).kind, 'fetch');
  });

  test('§3c · an ANONYMOUS transport signs nothing and still carries no board', async () => {
    // The shape used before a device exists — invite redemption, device adoption. It is handed
    // no `sign` and no `deviceShort` at all, so the usual reasoning ("the signature covers the
    // body") does not apply to it, which is exactly why it is worth a row of its own.
    const crossed = [];
    const t = createBridgeTransport({
      origin: rig.deps.origin, clientVersion: rig.deps.clientVersion, anonymous: true,
      invoke: async (cmd, args) => {
        crossed.push(args);
        return { status: 200, headers: {}, body: '{}', url: args.url, redirected: false };
      },
    });
    await t.request('POST', '/api/v1/invites/redeem', {}, { code: 'ABCD-EFGH-JKMN' });
    const hay = flatten(crossed[0]);
    assert.equal('Authorization' in crossed[0].headers, false,
      'an anonymous transport emitted an Authorization header');
    for (const needle of Object.values(NEEDLE)) assert.deepEqual(found(hay, needle), []);
    assert.ok(hay.includes('ABCD-EFGH-JKMN'), 'the control: the invite code IS sent, and was found');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · WHAT THIS ROUND DOES NOT CLOSE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · the half of the commissioned attack that is still owed', () => {
  test('§4a · there was no feedback payload to grep, and that is the finding', () => {
    // Stated as a row rather than as a sentence in a report, because a row is what a reader of a
    // green suite sees. The commissioned attack was "drive the feedback button against a real
    // fixture board and grep the whole outbound payload, text and image bytes". §1–§3 did the
    // first half of that sentence over the transport that exists. The second half — a payload
    // assembled by a feedback feature, and image bytes — has no subject:
    //
    //   · `e10-network-scope.test.js` §2 measures the absence of the feature in four places.
    //   · `e10-network-scope.test.js` §3 measures that the product cannot produce an image AT
    //     ALL, so "the redacted PNG was produced by not drawing" is vacuous rather than verified.
    //
    // This row's job is to keep those two facts joined to this file, so that whoever lands 1009
    // finds the rig above — the fixture board, the three spellings, the positive control — and
    // points it at their new payload instead of writing a weaker one.
    assert.ok(Object.keys(NEEDLE).length === 5, 'the fixture the feedback payload should be greped against');
    assert.ok(typeof flatten === 'function' && typeof found === 'function',
      'the two functions LZP-1009 must reuse: flatten the whole payload, search three spellings');
  });
});
