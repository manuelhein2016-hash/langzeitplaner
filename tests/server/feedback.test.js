// tests/server/feedback.test.js — LZP-1009, the endpoint. ADR 003 §6 · stories 21.3, 21.4.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THIS ROUTE IS THE SHAPE OF THE THREE THINGS THE PRODUCT REFUSES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// A feedback endpoint is a telemetry endpoint that a person happens to press. It is an open
// relay that happens to have one destination. It is a diagnostics upload that happens to be
// redacted. Each of those is one edit away, so each has a section here that fails on the edit:
//
//   §1  the SURFACE — one route, write-only, no read-back, no space
//   §2  the SIGNATURE — verified for real, and worth exactly what `PROVES` says
//   §3  the OPEN-RELAY refusal — a closed body shape, and 22 recipient spellings refused by name
//   §4  the STORE — one call, `rateAllow`, and every other property of the store THROWS
//   §5  the LIMIT and the CAP — the budget is spent FIRST, and an over-size report is REJECTED
//   §6  the WIRING — the ctx member is declared where the handler is, and the numbers agree
//   §7  the MUTANTS — each names the row that dies
//
// Every row runs the SHIPPED handler through the SHIPPED router over a real memory store. There
// is no hand-built request path: `createHandlers()` is what production runs.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createHandlers, REQUIRED_CTX, HANDLER_OWNERS, handlers } from '../../server/core/handlers/index.js';
import { ROUTES, ROUTE_NAMES, SPACE_SCOPED, API_PREFIX } from '../../server/core/router.js';
import { LIMITS, LIMIT_EXTENSIONS, RATE_RULES, RATE_COVERAGE } from '../../server/core/limits.js';
import { memoryStore } from '../../server/adapters/memory.js';
import { toResponse } from '../../server/core/errors.js';
import { b64u } from '../../server/core/auth.js';
import { PROTO_MAX as PROTOCOL } from '../../server/core/version.js';
import {
  PROVES, PROVES_NOT, BODY_FIELDS, DEVICE_FIELDS, NEVER_A_RECIPIENT,
  FEEDBACK_PREFIX, FEEDBACK_LIMIT_DEFAULTS, signedBytesOf, sendFeedback,
} from '../../server/core/handlers/feedback.js';
import { signedBytes as clientSignedBytes, b64 as clientB64 } from '../../src/js/feedback/report.js';
import { stripCommentsAndStrings } from '../helpers/purity.js';

const S = globalThis.crypto.subtle;
const TE = new TextEncoder();
const route = createHandlers();

/** The eight-byte PNG signature followed by nothing. Enough for the handler's `isPng`. */
const PNG = (n = 64) => {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return b;
};

/** A ctx whose sink records what it was handed. */
function makeCtx(over = {}) {
  const sunk = [];
  const ctx = {
    store: memoryStore(),
    now: () => 1_800_000_000_000,
    random: (n) => new Uint8Array(n),
    sha256: async (b) => new Uint8Array(await S.digest('SHA-256', b)),
    auth: async () => { throw new Error('feedback must never call ctx.auth'); },
    assertMember: async () => { throw new Error('feedback must never call ctx.assertMember'); },
    limits: LIMITS,
    subtle: S,
    feedbackSink: async (r) => { sunk.push(r); },
    ...over,
  };
  return { ctx, sunk };
}

/**
 * A ctx whose feedback budget is out of the way.
 *
 * `limits.js`'s own docblock invites this — "a test can tighten a limit to 2 and watch the real
 * code path 429" — and the inverse is the same seam. The rows that loop over twenty-two spellings
 * of `to:` are about the SHAPE check; §5 is where the budget is the subject, and it uses the real
 * number. Discovered by watching §3a 429 on its seventh spelling, which is the limiter working.
 */
function looseCtx(over = {}) {
  return makeCtx({ limits: { ...LIMITS, feedbackPerIpHour: 10000 }, ...over });
}

function req(body, extra = {}) {
  return {
    method: 'POST',
    path: `${API_PREFIX}/feedback`,
    query: {},
    headers: { 'x-lzp-protocol': String(PROTOCOL), 'x-real-ip': '203.0.113.7' },
    body,
    rawBody: TE.encode(JSON.stringify(body ?? null)),
    ...extra,
  };
}

/** Drive the shipped router and normalise a throw into the response it would become. */
async function call(ctx, body, extra) {
  try {
    return await route(ctx, req(body, extra));
  } catch (e) {
    return toResponse(e);
  }
}

const REPORT = 'LangzeitPlaner — Rückmeldung\n\nDer Balken springt beim Ziehen zurück.';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE SURFACE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · one route, write-only, and it names no space', () => {
  test('§1a · exactly one /feedback route, and it is a POST', () => {
    const rows = ROUTES.filter((r) => r.pattern.startsWith('/feedback'));
    assert.equal(rows.length, 1, 'the feedback surface grew a second route');
    assert.equal(rows[0].method, 'POST');
    assert.equal(rows[0].name, 'feedback');
  });

  test('§1b · THERE IS NO READ-BACK — no GET anywhere near it', async () => {
    // The property, from both ends. The table has no GET row, and the running server answers a
    // GET with 405 rather than with anything at all. A relay that can hand a report back is a
    // relay that stores reports addressably, and that is a different product with a different
    // privacy story.
    assert.equal(ROUTES.some((r) => r.method === 'GET' && r.pattern.startsWith('/feedback')), false);
    const { ctx } = makeCtx();
    const res = await call(ctx, null, { method: 'GET' });
    assert.equal(res.status, 405, `a GET /feedback answered ${res.status}`);
  });

  test('§1c · it is absent from SPACE_SCOPED because it HAS no space', () => {
    // Not "the membership check was forgotten" — the handler is handed no space id and has no
    // way to obtain one. That is what makes "a report can never appear on the family's board"
    // structural. The row asserts the handler's source names no space parameter at all.
    assert.equal('feedback' in SPACE_SCOPED, false);
    assert.equal(ROUTES.find((r) => r.name === 'feedback').spaceParam, undefined);
    // CODE ONLY. The handler's comments discuss spaces at length — that is the point of them —
    // and a grep that counted prose would have to be deleted within a week, which is how a gate
    // like this actually dies. `stripCommentsAndStrings` is the same blanking `netscope.js` and
    // `purity.js` share, so all three gates agree about what counts as code.
    const src = stripCommentsAndStrings(sendFeedback.toString());
    for (const forbidden of ['spaceId', 'space', 'appendOps', 'putOp', 'getMember', 'assertMember']) {
      assert.equal(new RegExp(`\\b${forbidden}\\b`).test(src), false,
        `the handler body names \`${forbidden}\` — it must not be able to reach a space at all`);
    }
  });

  test('§1d · a report is ACCEPTED, and the answer carries the honest sentences', async () => {
    const { ctx, sunk } = makeCtx();
    const res = await call(ctx, { v: 1, report: REPORT, image: null });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.proves, PROVES.unsigned);
    assert.equal(res.body.provesNot, PROVES_NOT);
    // and no id: an id is a handle, and a handle implies the read-back §1b refuses.
    assert.equal('id' in res.body, false, 'the answer carries an id — that is a read-back handle');
    assert.equal(sunk.length, 1);
    assert.equal(sunk[0].report, REPORT);
    assert.equal(sunk[0].signed, false);
  });

  test('§1e · with no sink configured it answers 501 — it does NOT accept and drop', async () => {
    // The one place a "helpful" 202 would be a lie: the preview screen told her exactly what
    // would be sent, and "sent" has to mean sent.
    const { ctx } = makeCtx({ feedbackSink: undefined });
    const res = await call(ctx, { v: 1, report: REPORT });
    assert.equal(res.status, 501);
    assert.equal(res.body.error, 'not_implemented');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE SIGNATURE — verified for real, worth exactly what PROVES says
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · the self-attested device signature', () => {
  /** A real, self-minted P-256 keypair — exactly what the client has, and nothing more. */
  async function selfMinted() {
    const kp = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await S.exportKey('raw', kp.publicKey));
    return { kp, pub: b64u(raw) };
  }

  async function signWith(kp, report, image) {
    const bytes = signedBytesOf(TE.encode(report), image);
    const sig = new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, bytes));
    return b64u(sig);
  }

  test('§2a · a correctly signed report is accepted and reported as CONTINUITY, not identity', async () => {
    const { kp, pub } = await selfMinted();
    const { ctx, sunk } = makeCtx();
    const res = await call(ctx, {
      v: 1, report: REPORT, image: null,
      device: { pub, sig: await signWith(kp, REPORT, null) },
    });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.proves, PROVES.device_continuity);
    assert.match(res.body.proves, /same private key/);
    assert.equal(sunk[0].signed, true);
    assert.equal(sunk[0].devicePub, pub);
  });

  test('§2b · THE CLIENT AND THE SERVER SIGN THE SAME BYTES', async () => {
    // The row that stops the whole feature from 401ing in production while every unit test
    // passes: the client builds the signed bytes in `src/js/feedback/report.js#signedBytes` and
    // the server rebuilds them in `handlers/feedback.js#signedBytesOf`. Two spellings of one
    // string is exactly the drift `auth.js`'s deviceShort note warns about, so the row signs with
    // the CLIENT's function and verifies through the REAL handler.
    const { kp, pub } = await selfMinted();
    const image = PNG();
    const built = { bytes: TE.encode(REPORT), image };
    const clientBytes = clientSignedBytes(built);
    assert.deepEqual([...clientBytes], [...signedBytesOf(TE.encode(REPORT), image)],
      'the client and the server disagree about what a feedback signature covers');
    const sig = new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, clientBytes));
    const { ctx } = makeCtx();
    const res = await call(ctx, {
      v: 1, report: REPORT, image: clientB64(image), device: { pub, sig: clientB64(sig) },
    });
    assert.equal(res.status, 202, `the client's own signature was refused: ${JSON.stringify(res.body)}`);
  });

  test('§2c · a PRESENTED signature that does not verify is a 401, not a shrug', async () => {
    // `pair.js#optionalAuth`'s rule, restated on this route: absent is a choice, wrong is a lie.
    const { kp, pub } = await selfMinted();
    const { ctx, sunk } = makeCtx();
    const sig = await signWith(kp, REPORT, null);
    const res = await call(ctx, { v: 1, report: `${REPORT} (edited after signing)`, image: null, device: { pub, sig } });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'bad_signature');
    assert.equal(sunk.length, 0, 'a report with a broken signature reached the sink');
  });

  test('§2d · the signature covers the IMAGE too — swapping it is caught', async () => {
    const { kp, pub } = await selfMinted();
    const sig = await signWith(kp, REPORT, PNG(64));
    const { ctx } = makeCtx();
    const res = await call(ctx, {
      v: 1, report: REPORT, image: b64u(PNG(96)), device: { pub, sig },
    });
    assert.equal(res.status, 401, 'the image is outside the signature — it can be swapped in flight');
  });

  test('§2e · AND IT PROVES NOTHING ABOUT WHO — a stranger signs just as well', async () => {
    // The demotion, MEASURED rather than written in a comment. Two keypairs minted from nothing,
    // with no membership, no device row, no invitation and no relationship to any space, both
    // accepted. This row is what stops a future reader from treating `device.pub` as an identity.
    const { ctx, sunk } = makeCtx();
    for (let i = 0; i < 2; i++) {
      const { kp, pub } = await selfMinted();
      const res = await call(ctx, {
        v: 1, report: `${REPORT} ${i}`, image: null,
        device: { pub, sig: await signWith(kp, `${REPORT} ${i}`, null) },
      });
      assert.equal(res.status, 202, 'a self-minted key was refused — the route now requires enrolment');
    }
    assert.equal(sunk.length, 2);
    assert.notEqual(sunk[0].devicePub, sunk[1].devicePub);
    for (const r of sunk) assert.equal(r.provesNot, PROVES_NOT);
    assert.match(PROVES_NOT, /never enrolled/);
    assert.match(PROVES_NOT, /rate limit .* and the size cap .* are the controls/s);
  });

  test('§2f · the domain prefix is a SIBLING of the sync one, never the same string', async () => {
    // A signature over a feedback report must not verify as a signature over a sync request. One
    // shared prefix plus one field-order coincidence is all a cross-protocol replay needs.
    const { SIGNED_PREFIX } = await import('../../server/core/auth.js');
    assert.notEqual(FEEDBACK_PREFIX, SIGNED_PREFIX);
    assert.equal(FEEDBACK_PREFIX.startsWith(SIGNED_PREFIX), false,
      'the feedback prefix is a PREFIX of the sync one — a truncation confusion');
    const bytes = signedBytesOf(TE.encode(REPORT), null);
    assert.ok(new TextDecoder().decode(bytes.subarray(0, FEEDBACK_PREFIX.length)) === FEEDBACK_PREFIX);
  });

  test('§2g · a malformed device block is a 400, and never reaches the verifier', async () => {
    const { ctx, sunk } = looseCtx();
    for (const device of [
      { pub: 'not base64url!!', sig: 'AAAA' },
      { pub: b64u(new Uint8Array(64)), sig: b64u(new Uint8Array(64)) },   // 64-byte "pubkey"
      { pub: b64u(new Uint8Array(65)), sig: b64u(new Uint8Array(63)) },   // short signature
      { pub: b64u(new Uint8Array(65)) },                                   // no signature at all
      'a string',
      ['an', 'array'],
    ]) {
      const res = await call(ctx, { v: 1, report: REPORT, device });
      assert.equal(res.status, 400, `${JSON.stringify(device)} answered ${res.status}`);
    }
    assert.equal(sunk.length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · NOT AN OPEN RELAY
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · there is no `to:` field, and there cannot be one', () => {
  test('§3a · every recipient-shaped field is REFUSED BY NAME, not ignored', async () => {
    // Refused rather than ignored on purpose: an ignored field is a field somebody starts relying
    // on, and the one this route must never grow is a recipient. 22 spellings, each its own
    // request, each naming itself in the refusal.
    const { ctx, sunk } = looseCtx();
    for (const name of NEVER_A_RECIPIENT) {
      const res = await call(ctx, { v: 1, report: REPORT, [name]: 'mallory@example.com' });
      assert.equal(res.status, 400, `\`${name}\` was accepted — this endpoint is an open relay`);
      assert.equal(res.body.unexpectedField, name, `the refusal does not name \`${name}\``);
    }
    assert.equal(sunk.length, 0, 'a report with a recipient field reached the sink');
  });

  test('§3b · and the mechanism is a CLOSED SET, so a spelling nobody listed is refused too', async () => {
    // `NEVER_A_RECIPIENT` is documentation. THIS is the control: the handler enumerates the
    // caller's keys against `BODY_FIELDS` and refuses anything else, so `{ deliver: { to: … } }`,
    // `sendTo`, `an_hände` and a name invented next year are all equally refused — the same
    // reasoning `limits.js` LOG_FIELDS uses one file over.
    const { ctx } = looseCtx();
    for (const name of ['deliver', 'sendTo', 'forward', 'x', '__proto__', 'to ', 'To', 'empfaenger']) {
      const res = await call(ctx, { v: 1, report: REPORT, [name]: 'x' });
      assert.equal(res.status, 400, `an unlisted field \`${name}\` was accepted`);
    }
    assert.deepEqual([...BODY_FIELDS].sort(), ['device', 'image', 'report', 'v']);
    assert.deepEqual([...DEVICE_FIELDS].sort(), ['pub', 'sig']);
  });

  test('§3c · a `device` block may not smuggle one either', async () => {
    const { ctx } = makeCtx();
    const res = await call(ctx, {
      v: 1, report: REPORT, device: { pub: b64u(new Uint8Array(65)), sig: b64u(new Uint8Array(64)), to: 'x' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.unexpectedField, 'device.to');
  });

  test('§3d · the destination is CONFIGURATION — the handler reads it from ctx and nowhere else', () => {
    const src = sendFeedback.toString();
    assert.match(src, /ctx\s*&&\s*ctx\.feedbackSink|ctx\.feedbackSink/,
      'the handler does not read the sink from ctx');
    // and it never reads a destination out of the request.
    for (const bad of ['req.body.to', 'body.to', 'body.url', 'body.webhook']) {
      assert.equal(src.includes(bad), false, `the handler reads \`${bad}\``);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 · IT NEVER ENTERS THE OP LOG OR ANY SPACE STORE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · the store is touched exactly once, and only for the limiter', () => {
  /** A store whose every property but `rateAllow` throws the moment it is READ. */
  function hostileStore(record) {
    const real = memoryStore();
    return new Proxy({}, {
      get(_t, prop) {
        if (prop === 'rateAllow') {
          return (...a) => { record.push('rateAllow'); return real.rateAllow(...a); };
        }
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        throw new Error(`feedback reached ctx.store.${String(prop)} — a report must never enter a space store`);
      },
    });
  }

  test('§4a · a full accepted report touches ONLY store.rateAllow', async () => {
    // If a report reached the op log it would SYNC, and feedback about the family would appear on
    // the family's board — the one place LZP-1009 says it must never be. This is that property,
    // measured on the running handler rather than argued from the source.
    const touched = [];
    const { ctx, sunk } = makeCtx({ store: hostileStore(touched) });
    const res = await call(ctx, { v: 1, report: REPORT, image: b64u(PNG()) });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.deepEqual([...new Set(touched)], ['rateAllow'],
      `the handler reached these store members: ${[...new Set(touched)].join(', ')}`);
    assert.equal(sunk.length, 1);
  });

  test('§4b · ARMED — the hostile store really does throw on anything else', () => {
    const store = hostileStore([]);
    assert.throws(() => store.appendOps, /must never enter a space store/);
    assert.throws(() => store.getMember, /must never enter a space store/);
    assert.doesNotThrow(() => store.rateAllow);
  });

  test('§4c · it never authenticates — ctx.auth and ctx.assertMember are never called', async () => {
    // Both throw in `makeCtx`. A route that authenticated would refuse the solo tester who has
    // no relationship with this server, which is case 2 of the handler's header.
    const { ctx } = makeCtx();
    const res = await call(ctx, { v: 1, report: REPORT });
    assert.equal(res.status, 202);
  });

  test('§4d · the log line carries three of §6.2\'s seven fields and nothing prose-shaped', async () => {
    const lines = [];
    const { ctx } = makeCtx({ log: (e) => lines.push(e) });
    await call(ctx, { v: 1, report: REPORT });
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['byteCount', 'route', 'status']);
    assert.equal(JSON.stringify(lines[0]).includes('Balken'), false,
      'her sentence reached a log line — story 21.3 is defeated by a debug statement');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 · THE BUDGET AND THE CAP
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · metered on the first commit, and it rejects rather than truncating', () => {
  test('§5a · the rule exists, is IP-keyed and PRE-AUTH, and covers the route', () => {
    const rule = RATE_RULES.feedbackReport;
    assert.ok(rule, 'the feedback route has no rate rule at all');
    assert.equal(rule.identity, 'ip',
      'the rule is keyed on something other than the IP — a self-minted key is not an identity');
    assert.equal(rule.phase, 'pre-auth');
    assert.equal(rule.limit, 'feedbackPerIpHour');
    assert.equal(rule.windowMs, 3600000);
    assert.deepEqual(RATE_COVERAGE.feedback.pre, ['feedbackReport']);
    assert.equal(RATE_COVERAGE.feedback.why, null, 'the route carries a `why` instead of a rule');
  });

  test('§5b · the sixth report in an hour is a 429 with Retry-After', async () => {
    const { ctx, sunk } = makeCtx();
    for (let i = 0; i < LIMITS.feedbackPerIpHour; i++) {
      const res = await call(ctx, { v: 1, report: `${REPORT} ${i}` });
      assert.equal(res.status, 202, `report ${i + 1} was refused: ${JSON.stringify(res.body)}`);
    }
    const over = await call(ctx, { v: 1, report: REPORT });
    assert.equal(over.status, 429);
    assert.equal(over.headers['Retry-After'], '3600');
    assert.equal(sunk.length, LIMITS.feedbackPerIpHour);
  });

  test('§5c · THE BUDGET IS SPENT FIRST — before the shape check and before the verify', async () => {
    // The ordering is the control. A body that fails three later checks is sent six times; the
    // sixth must be a 429 and not a 400, because otherwise a flood of malformed requests costs
    // the attacker nothing and costs the relay a P-256 verify each.
    const { ctx } = makeCtx();
    const junk = { v: 1, report: '', to: 'mallory@example.com', device: 'nonsense' };
    for (let i = 0; i < LIMITS.feedbackPerIpHour; i++) {
      assert.equal((await call(ctx, junk)).status, 400, 'the junk body stopped being junk');
    }
    const over = await call(ctx, junk);
    assert.equal(over.status, 429,
      'a malformed body is refused before the budget is charged — a flood of junk is free');
  });

  test('§5d · two IPs have two budgets', async () => {
    const { ctx } = makeCtx();
    for (let i = 0; i < LIMITS.feedbackPerIpHour; i++) await call(ctx, { v: 1, report: `${REPORT} ${i}` });
    assert.equal((await call(ctx, { v: 1, report: REPORT })).status, 429);
    const other = await call(ctx, { v: 1, report: REPORT },
      { headers: { 'x-lzp-protocol': String(PROTOCOL), 'x-real-ip': '198.51.100.4' } });
    assert.equal(other.status, 202, 'the bucket is not keyed on the IP at all');
  });

  test('§5e · an over-size report is REJECTED and names the cap — it is never truncated', async () => {
    const { ctx, sunk } = makeCtx();
    const huge = b64u(PNG(LIMITS.bytesPerFeedback + 1024));
    const res = await call(ctx, { v: 1, report: REPORT, image: huge });
    assert.equal(res.status, 413);
    assert.equal(res.body.error, 'payload_too_large');
    assert.equal(res.body.cap, 'bytesPerFeedback');
    assert.equal(res.body.max, LIMITS.bytesPerFeedback);
    assert.equal(sunk.length, 0, 'A TRUNCATED REPORT REACHED THE SINK — the preview screen lied');
  });

  test('§5f · an over-long text is rejected with the OTHER cap, so she is told which one', async () => {
    const { ctx, sunk } = makeCtx();
    const res = await call(ctx, { v: 1, report: 'ä'.repeat(LIMITS.charsPerFeedbackText + 1) });
    assert.equal(res.status, 413);
    assert.equal(res.body.cap, 'charsPerFeedbackText');
    assert.equal(res.body.max, LIMITS.charsPerFeedbackText);
    assert.equal(sunk.length, 0);
  });

  test('§5g · the text cap counts CODE POINTS, so emoji do not halve it', async () => {
    // A cap counting UTF-16 units would refuse this at half the advertised length, and the number
    // in the 413 has to be the number the client showed her.
    const { ctx } = makeCtx();
    const emoji = '🌻'.repeat(2500);        // 2 UTF-16 units each, 1 code point each
    assert.ok(emoji.length > LIMITS.charsPerFeedbackText, 'the fixture is not long enough in UTF-16 units');
    assert.ok([...emoji].length < LIMITS.charsPerFeedbackText, 'the fixture is too long in code points');
    assert.equal((await call(ctx, { v: 1, report: emoji })).status, 202);
  });

  test('§5h · an empty report is refused — a bundle of diagnostics about nothing is telemetry', async () => {
    const { ctx, sunk } = looseCtx();
    for (const report of ['', '   \n\t ', null, undefined, 42, {}]) {
      assert.equal((await call(ctx, { v: 1, report })).status, 400, `${JSON.stringify(report)} was accepted`);
    }
    assert.equal(sunk.length, 0);
  });

  test('§5i · `image` must actually be a PNG — this is not a file-upload endpoint', async () => {
    const { ctx } = makeCtx();
    const notPng = new Uint8Array(64).fill(0x41);
    const res = await call(ctx, { v: 1, report: REPORT, image: b64u(notPng) });
    assert.equal(res.status, 400);
    assert.equal(res.body.unexpectedField, 'image');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 · THE WIRING
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§6 · the route is bound, declared and budgeted in the same commit', () => {
  test('§6a · the ctx member is declared by the handler and spread into REQUIRED_CTX', () => {
    const row = REQUIRED_CTX.find((c) => c.name === 'feedbackSink');
    assert.ok(row, 'the sink is not declared in REQUIRED_CTX — a host cannot know to supply it');
    assert.equal(row.optional, true);
    assert.match(row.absent, /501/, 'the declared consequence of an absent sink is not the honest one');
  });

  test('§6b · HANDLER_OWNERS names this file, and the binding really is its export', async () => {
    assert.equal(HANDLER_OWNERS.feedback, 'handlers/feedback.js');
    const mod = await import('../../server/core/handlers/feedback.js');
    assert.equal(handlers.feedback, mod.feedback);
    assert.equal(handlers.feedback, mod.sendFeedback);
    assert.ok(ROUTE_NAMES.includes('feedback'));
  });

  test('§6c · the handler-local fallback numbers agree with LIMITS', () => {
    // Every handler in this directory keeps its own defaults so the file stays independently
    // deployable; the price is that they can drift, so the row is here.
    for (const [k, v] of Object.entries(FEEDBACK_LIMIT_DEFAULTS)) {
      assert.equal(LIMITS[k], v, `${k}: the handler default and LIMITS disagree`);
    }
  });

  test('§6d · all three numbers are recorded in LIMIT_EXTENSIONS with a stated reason', () => {
    for (const name of ['feedbackPerIpHour', 'bytesPerFeedback', 'charsPerFeedbackText']) {
      const e = LIMIT_EXTENSIONS.find((x) => x.name === name);
      assert.ok(e, `${name} is a limit with no recorded reason`);
      assert.match(e.tag, /^E10-L\d+$/);
      assert.ok(e.reason.length > 200, `${e.tag}'s reason is a label, not a reason`);
      assert.equal(LIMITS[name], e.value);
    }
    // and the one about the cap says out loud that it rejects rather than truncating.
    assert.match(LIMIT_EXTENSIONS.find((x) => x.name === 'bytesPerFeedback').reason,
      /REJECT, NEVER TRUNCATE/);
  });

  test('§6e · a limits object missing the numbers falls back to the shipped ones, not to zero', async () => {
    // `limits.js#numberFrom`'s contract, on this route: a typo in a host's config must not
    // silently disable a limiter or deny every request.
    const { ctx } = makeCtx({ limits: { bytesPerRequest: 4194304 } });
    const res = await call(ctx, { v: 1, report: REPORT });
    assert.equal(res.status, 202);
    const big = await call(ctx, { v: 1, report: REPORT, image: b64u(PNG(FEEDBACK_LIMIT_DEFAULTS.bytesPerFeedback + 512)) });
    assert.equal(big.status, 413, 'with an incomplete ctx.limits the cap disappeared');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7 · THE MUTANTS — each names the row that dies
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Reasoned against the shipped source rather than run against a patched copy, in the idiom
// `network-scope.test.js` §2's arming rows use: each mutant is a one-line edit, and the row named
// beside it is asserted here to be the row whose assertion depends on that exact line.

describe('§7 · what each defect would kill', () => {
  test('§7a · M1 — move `enforceFor` below the shape check ⇒ §5c dies', () => {
    // §5c is the only row that distinguishes "there is a limiter" from "the limiter runs first".
    // §5b would stay green: six well-formed reports still 429 on the sixth.
    const src = sendFeedback.toString();
    const limitAt = src.indexOf('enforceFor');
    const shapeAt = src.indexOf('BODY_FIELDS');
    const verifyAt = src.indexOf('verifySignature');
    assert.ok(limitAt >= 0 && shapeAt > limitAt && verifyAt > limitAt,
      'the budget is no longer spent before the shape check and the verify — §5c is the row');
  });

  test('§7b · M2 — accept an unknown body field instead of refusing ⇒ §3a and §3b die', async () => {
    // The mutation is `continue` in place of `throw` in the BODY_FIELDS loop. §1d would stay
    // green — a well-formed report is still accepted — and the endpoint would be an open relay
    // the moment anybody added delivery.
    const { ctx } = makeCtx();
    const res = await call(ctx, { v: 1, report: REPORT, to: 'mallory@example.com' });
    assert.equal(res.status, 400);
    assert.equal(res.body.unexpectedField, 'to');
  });

  test('§7c · M3 — truncate instead of rejecting ⇒ §5f dies (text) or §5e (image)', async () => {
    // RUN, NOT REASONED, and the label was corrected by running it. Replacing the text cap's
    // `throw` with `[...report].slice(0, textCap)` kills **§5f**, not §5e — §5e is the IMAGE cap's
    // row, and each cap needs its own truncation mutant because they are separate branches. Both
    // are observable in the same one place: the SINK saw nothing. Every other row in this file
    // stays green under either mutation, which is the point of asserting on the sink at all.
    const { ctx, sunk } = makeCtx();
    await call(ctx, { v: 1, report: 'x'.repeat(LIMITS.charsPerFeedbackText + 1) });
    assert.equal(sunk.length, 0, 'a truncated TEXT was delivered — the §5f mutant is alive');
    const { ctx: ctx2, sunk: sunk2 } = makeCtx();
    await call(ctx2, { v: 1, report: 'ok', image: b64u(PNG(LIMITS.bytesPerFeedback + 1024)) });
    assert.equal(sunk2.length, 0, 'a truncated IMAGE was delivered — the §5e mutant is alive');
  });

  test('§7d · M4 — accept a bad signature as unsigned ⇒ §2c dies', async () => {
    // `if (!ok) { signed = false; }` instead of a 401 looks generous and is a downgrade attack:
    // an attacker takes a real report, edits the text, keeps the key, and it is filed as a report
    // from that key's owner.
    const kp = await S.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = b64u(new Uint8Array(await S.exportKey('raw', kp.publicKey)));
    const sig = b64u(new Uint8Array(await S.sign({ name: 'ECDSA', hash: 'SHA-256' },
      kp.privateKey, signedBytesOf(TE.encode(REPORT), null))));
    const { ctx, sunk } = makeCtx();
    const res = await call(ctx, { v: 1, report: 'etwas ganz anderes', device: { pub, sig } });
    assert.equal(res.status, 401);
    assert.equal(sunk.length, 0);
  });

  test('§7e · M5 — return 202 when no sink is configured ⇒ §1e dies', async () => {
    const { ctx } = makeCtx({ feedbackSink: null });
    assert.equal((await call(ctx, { v: 1, report: REPORT })).status, 501);
  });

  test('§7f · M6 — write the report through ctx.store ⇒ §4a dies', async () => {
    // The most dangerous mutation in the list, because it is the one a well-meaning person makes:
    // "let us keep a copy". A copy in the store is a copy that syncs.
    const touched = [];
    const { ctx } = makeCtx({
      store: new Proxy({}, {
        get(_t, prop) {
          touched.push(String(prop));
          if (prop === 'rateAllow') return async () => true;
          return () => { throw new Error('nope'); };
        },
      }),
    });
    await call(ctx, { v: 1, report: REPORT });
    assert.deepEqual([...new Set(touched)].filter((p) => p !== 'then'), ['rateAllow']);
  });

  test('§7g · M7 — drop the domain prefix from the signed bytes ⇒ §2f dies', () => {
    const bytes = signedBytesOf(TE.encode(REPORT), null);
    assert.ok(bytes.length > TE.encode(REPORT).length,
      'the signed bytes are the report alone — a sync signature could be replayed here');
  });
});
