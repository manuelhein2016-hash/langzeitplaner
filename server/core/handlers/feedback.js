// server/core/handlers/feedback.js — POST /api/v1/feedback.  LZP-1009 · ADR 003 §6 · story 21.4.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// AN UNMETERED ENDPOINT ON THIS RELAY IS THE THING AN ADVERSARY BROKE TWICE THIS MONTH
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `limits.js`'s own history is the specification for this file. Twice, a route landed with a
// `why` in `RATE_COVERAGE` instead of a rule, and both times the reasoning was a true sentence
// that did not support its conclusion:
//
//   · `createSpace` — "reachable only after the full §2 chain" — was a BOOTSTRAP route that
//     registers the device it is signed by, so anyone who can mint a keypair passed (E2-203-6).
//   · `rotateEpoch` — "a flood costs the attacker their own epoch numbers and NOTHING ELSE" —
//     was measured false by a member adversary, and the cost turned out to be unbounded (T2-E1).
//
// This route is a third bootstrap route with a weaker gate than either of them, so **the rate
// rule is in `RATE_RULES` on the first commit** — `feedbackReport`, `LIMIT_EXTENSIONS` E10-L1 —
// rather than as a `why` somebody promises to replace. There is no version of this file in which
// a limiter was owed to a later ticket.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// ██ WHAT THE AUTH ON THIS ROUTE PROVES, AND WHAT IT DOES NOT ██
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `lifecycle.js` established the pattern and the reason: a demotion that lives in a comment is a
// demotion the next reader does not see. So the sentences are `PROVES` / `PROVES_NOT` below,
// they go on the wire, and a test pins them.
//
// **This route cannot require membership.** Two cases, and each on its own is decisive:
//
//   1. **A report is most needed when the family space is broken.** „Ich komme nicht mehr rein",
//      „es sagt KeyStoreUnavailableError", „meine Termine sind weg" — a route that answers those
//      with `403 not_a_member` is a route that works only while nothing is wrong.
//   2. **A solo tester has no server relationship at all.** The PO's mother may never join a
//      Familienkreis. She has no Member row, no Device row, no space. There is nothing for a
//      membership check to check.
//
// So the credential is a **self-attested device signature**: a raw P-256 public key the client
// minted itself, and a signature by it over the exact report bytes. It is verified — a bad
// signature is a 401, not a shrug — and what verification buys is exactly one thing:
//
//   ██ two reports carrying the same `device.pub` were signed by the same private key. ██
//
// That is CONTINUITY and nothing else. It does not say the key belongs to a member, to a device
// this server has ever seen, or to a person; the key is generated on the client and never
// registered anywhere, so anyone may mint a fresh one per report for the cost of one keypair.
// **The rate limit and the size cap are the actual controls, and the signature is not a control
// at all** — it is a thread that lets three reports about one bug be read as one story.
//
// It is also OPTIONAL, which is the same argument as case 1 above pushed one step further: the
// report that says „mein Schlüsselbund ist kaputt" is written by a Mac that cannot sign. Refusing
// it would be refusing the report the endpoint exists for. An unsigned report is accepted and
// recorded as `signed: false`, so the reader knows which kind they are holding.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FOUR STRUCTURAL PROMISES
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   1. **IT NEVER ENTERS THE OP LOG OR ANY SPACE STORE.** If it did, it would sync — and feedback
//      about the family would appear on the family's board, which is the one place LZP-1009 says
//      it must never be (Principle 10). This handler touches `ctx.store` exactly once, through
//      `enforceFor` → `store.rateAllow`, and `tests/server/feedback.test.js` §4 runs it against a
//      store whose every other property THROWS.
//   2. **IT IS WRITE-ONLY.** There is no `GET /feedback`, no list, no read-back, no id returned
//      that could address one. `router.js` has one row for this route and it is a POST.
//   3. **THERE IS NO `to:` FIELD.** A payload-specified recipient is an open relay for spam. The
//      destination is `ctx.feedbackSink`, which is server configuration. And the body shape is a
//      CLOSED SET rather than a blocklist — `LOG_FIELDS`' lesson one file over: a blocklist of
//      forbidden names fails the day someone sends `{ deliver: { to: … } }`.
//   4. **IT REJECTS, IT NEVER TRUNCATES.** A truncated report is a lie about what was sent, and
//      the preview screen promised her otherwise. Over the cap is a 413 that names the cap and the
//      number, so the client can say „schreib etwas kürzer" instead of silently sending less.
//
// PURITY (ADR 003 §9, ADR 005 §2). No clock beyond `ctx.now()`, no randomness, no I/O, no
// framework types.

import { fail } from '../errors.js';
import { enforceFor } from '../limits.js';
import { ub64, verifySignature, B64U_RE } from '../auth.js';
import { versionHeaders } from '../version.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1. The honest sentences
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a verified `device` block on this route establishes. Exported so
 * `tests/server/feedback.test.js` pins it and so the wire, the sink record and this file cannot
 * drift apart.
 */
export const PROVES = Object.freeze({
  device_continuity:
    'two reports carrying this same self-minted public key were signed by the same private key',
  unsigned:
    'nothing at all; the report was accepted without a credential, which is deliberate — see PROVES_NOT',
});

/** What it does not prove, on every response and every refusal, in one string. */
export const PROVES_NOT = 'that the key belongs to a member, to a device this server has ever '
  + 'registered, or to a person — it is self-minted client-side and never enrolled, so a fresh '
  + 'one costs one keypair. The rate limit (feedbackReport) and the size cap (bytesPerFeedback) '
  + 'are the controls; the signature is a thread, not a gate (LZP-1009)';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2. The body shape — a closed set, not a blocklist
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Every key the body may carry. Anything else is a `400 bad_request`, by name. */
export const BODY_FIELDS = Object.freeze(['v', 'report', 'image', 'device']);

/** Every key a `device` block may carry. */
export const DEVICE_FIELDS = Object.freeze(['pub', 'sig']);

/**
 * The recipient-shaped names, enumerated NOT because the closed set above needs them — it already
 * refuses every one — but so that `tests/server/feedback.test.js` §3 can state what it is
 * proving, and so that a reader looking for "can this be used as an open relay" finds the answer
 * spelled out instead of having to derive it from an allowlist.
 */
export const NEVER_A_RECIPIENT = Object.freeze([
  'to', 'cc', 'bcc', 'recipient', 'recipients', 'email', 'mailto', 'address',
  'dest', 'destination', 'target', 'url', 'endpoint', 'webhook', 'callback',
  'replyTo', 'reply_to', 'from', 'sender', 'subject', 'channel', 'chatId',
]);

/** ADR 002 §1 — an uncompressed P-256 point. */
const RAW_PUBKEY_BYTES = 65;
const SIG_BYTES = 64;

/**
 * The domain prefix the client signs under (`src/js/feedback/report.js#signedBytes`).
 *
 * A sibling of `net.js`'s `lzp/v2\n`, deliberately NOT the same string: a signature made over a
 * feedback report must not verify as a signature over a sync request, and vice versa. One shared
 * prefix and one field-order coincidence is all a cross-protocol replay needs.
 */
export const FEEDBACK_PREFIX = 'lzp/feedback/v1\n';

const TE = new TextEncoder();

/**
 * `ctx` members this handler adds, in `handlers/index.js` REQUIRED_CTX's own idiom (E2-C1's
 * pattern). Declared here rather than assumed, because the failure mode of a missing sink is not
 * a crash at boot — it is a family member pressing „Senden" and a report going nowhere.
 */
export const CTX_EXTENSIONS = Object.freeze([
  Object.freeze({
    name: 'feedbackSink',
    shape: '(record) => Promise<void>',
    absent: 'the route answers 501 not_implemented — HONESTLY, rather than accepting a report and '
      + 'dropping it. The preview screen told her exactly what would be sent; "sent" must mean sent.',
    optional: true,
  }),
]);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 3. The handler
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/feedback
 *
 * @param {Object} req a ServerReq
 * @param {Object} ctx a ServerCtx; `store` (for the limiter alone), `now`, `limits`, and the
 *                     optional `feedbackSink` and `log`
 * @returns {Promise<{status:number, headers:Object, body:Object}>}
 */
export async function sendFeedback(req, ctx) {
  // ── 1. THE BUDGET, FIRST. ──────────────────────────────────────────────────────────────────
  // Before the shape check, before the size check, and above all before the P-256 verify: the
  // expensive part of an unauthenticated request is the cryptography, so a flood must be refused
  // above it. `feedbackReport` is `pre-auth` and IP-keyed for the same reason `inviteRedeem` is —
  // there is no other identity, and a self-minted key is not one (see PROVES_NOT).
  await enforceFor(req, ctx, 'feedbackReport', null);

  const body = req && req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('bad_request');

  // ── 2. THE CLOSED SHAPE. ───────────────────────────────────────────────────────────────────
  // Note the direction: the caller's keys are enumerated and checked against the allowlist, and
  // then only the allowlisted names are read. A key this file does not name is unreachable, and
  // it is also REFUSED — an ignored unknown field is a field somebody starts relying on, and the
  // one this route must never grow is a recipient.
  for (const k of Object.keys(body)) {
    if (!BODY_FIELDS.includes(k)) throw fail('bad_request', { unexpectedField: k });
  }
  if (body.v !== 1) throw fail('bad_request', { unexpectedField: 'v' });

  // ── 3. HER TEXT. ───────────────────────────────────────────────────────────────────────────
  const report = body.report;
  if (typeof report !== 'string' || report.trim().length === 0) throw fail('bad_request');
  const textCap = limitOf(ctx, 'charsPerFeedbackText');
  // Measured in code points, not UTF-16 units: a cap that counts surrogate pairs as two would
  // refuse a report with emoji in it at half the advertised length, and the number in the refusal
  // has to be the number the client showed her.
  if ([...report].length > textCap) {
    throw fail('payload_too_large', { cap: 'charsPerFeedbackText', max: textCap });
  }
  const reportBytes = TE.encode(report);

  // ── 4. THE PICTURE. ────────────────────────────────────────────────────────────────────────
  let image = null;
  if (body.image !== undefined && body.image !== null) {
    if (typeof body.image !== 'string' || !B64U_RE.test(body.image)) throw fail('bad_request');
    // Size is decided from the ENCODED LENGTH before any decode — `limits.js#envelopeBytes`'s own
    // reasoning: the point of a cap is to refuse the work, and decoding first does the work.
    const approx = Math.floor((body.image.length * 3) / 4);
    assertTotal(ctx, reportBytes.length + approx);
    image = ub64(body.image);
    if (image === null) throw fail('bad_request');
    if (!isPng(image)) throw fail('bad_request', { unexpectedField: 'image' });
  }
  const total = reportBytes.length + (image ? image.length : 0);
  assertTotal(ctx, total);

  // ── 5. THE SELF-ATTESTED SIGNATURE. ────────────────────────────────────────────────────────
  let signed = false;
  let devicePub = null;
  if (body.device !== undefined && body.device !== null) {
    const d = body.device;
    if (typeof d !== 'object' || Array.isArray(d)) throw fail('bad_request');
    for (const k of Object.keys(d)) {
      if (!DEVICE_FIELDS.includes(k)) throw fail('bad_request', { unexpectedField: `device.${k}` });
    }
    const pub = ub64(d.pub, RAW_PUBKEY_BYTES);
    const sig = ub64(d.sig, SIG_BYTES);
    if (pub === null || sig === null) throw fail('bad_request');
    const ok = await verifySignature(pub, sig, signedBytesOf(reportBytes, image), ctx);
    // A PRESENTED credential that does not verify is a 401 — the same rule `pair.js#optionalAuth`
    // states from the other end: "an absent header is anonymous and a present-but-invalid header
    // is the error". Absent is a choice; wrong is a lie.
    if (!ok) throw fail('bad_signature');
    signed = true;
    devicePub = d.pub;
  }

  // ── 6. OUT OF BAND, AND NOWHERE ELSE. ──────────────────────────────────────────────────────
  // `ctx.feedbackSink` is server CONFIGURATION. There is no path from here to `ctx.store`'s op
  // log, to a space, to a member, or to a board — this handler holds no space id and was given
  // none, so "the report cannot land on the family's board" is true because there is no board it
  // could name.
  const sink = ctx && ctx.feedbackSink;
  if (typeof sink !== 'function') {
    // 501 and not 202. Accepting a report there is nowhere to put would be exactly the lie the
    // preview screen exists to prevent.
    throw fail('not_implemented', { route: 'feedback' });
  }
  await sink(Object.freeze({
    at: ctx.now(),
    report,
    image,
    signed,
    devicePub,
    proves: signed ? PROVES.device_continuity : PROVES.unsigned,
    provesNot: PROVES_NOT,
  }));

  if (typeof ctx.log === 'function') {
    // `route`, `status` and `byteCount` are three of §6.2's seven fields, and they are all this
    // may say. Not the text, not the device key, not a length of her sentence — `limits.js`'s
    // sanitiser would drop anything else anyway, and asking for less than the sanitiser allows is
    // the right habit on the one route that carries prose.
    ctx.log({ route: 'feedback', status: 202, byteCount: total });
  }

  // 202 rather than 200: the relay has taken custody of the report, and what happens to it next
  // is a human reading it. There is no id in the answer — an id would be a handle, and a handle
  // implies a read-back this route deliberately does not have (promise 2).
  return {
    status: 202,
    headers: versionHeaders(),
    body: { ok: true, proves: signed ? PROVES.device_continuity : PROVES.unsigned, provesNot: PROVES_NOT },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 4. Helpers
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** @param {Object} ctx @param {number} n @throws {import('../errors.js').HttpError} 413 */
function assertTotal(ctx, n) {
  const max = limitOf(ctx, 'bytesPerFeedback');
  if (n > max) throw fail('payload_too_large', { cap: 'bytesPerFeedback', max });
}

/** `ctx.limits` first, the shipped table second — `limits.js#numberFrom`'s contract. */
function limitOf(ctx, name) {
  const v = ctx && ctx.limits && ctx.limits[name];
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : DEFAULTS[name];
}

/**
 * The fallback numbers, kept here as well as in `LIMITS` for the reason every other handler in
 * this directory keeps its own: the file stays independently deployable and its own test pins its
 * own numbers. `tests/server/feedback.test.js` asserts these agree with `LIMITS`.
 */
export const FEEDBACK_LIMIT_DEFAULTS = Object.freeze({
  bytesPerFeedback: 262144,
  charsPerFeedbackText: 4000,
});
const DEFAULTS = FEEDBACK_LIMIT_DEFAULTS;

/**
 * The eight-byte PNG signature.
 *
 * Checked because the field is called `image` and the sink writes it to a file: a route that
 * accepts 256 KB of arbitrary bytes under a name that suggests a picture is a file-upload
 * endpoint with the safety of neither. This is not a parser — it reads eight bytes and never
 * looks inside — but it is the difference between "a PNG" and "anything at all".
 */
function isPng(b) {
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!(b instanceof Uint8Array) || b.length < SIG.length) return false;
  for (let i = 0; i < SIG.length; i++) if (b[i] !== SIG[i]) return false;
  return true;
}

/**
 * The exact bytes a `device.sig` must cover. Mirrors `src/js/feedback/report.js#signedBytes`;
 * `tests/server/feedback.test.js` §2 signs with the CLIENT's function and verifies with this one,
 * so the two cannot drift into a state where every real client gets a 401.
 *
 * @param {Uint8Array} reportBytes @param {Uint8Array|null} image @returns {Uint8Array}
 */
export function signedBytesOf(reportBytes, image) {
  const prefix = TE.encode(FEEDBACK_PREFIX);
  const img = image || new Uint8Array(0);
  const out = new Uint8Array(prefix.length + reportBytes.length + 1 + img.length);
  out.set(prefix, 0);
  out.set(reportBytes, prefix.length);
  out[prefix.length + reportBytes.length] = 0x0a;
  out.set(img, prefix.length + reportBytes.length + 1);
  return out;
}

/**
 * The route-name alias. `blindness.test.js` §8 asserts `handlers[name] === mod[name]` for every
 * row of `HANDLER_OWNERS` — the check that catches a route silently rebound to a different
 * file's function — and it can only do that if the module exports the ROUTE's name. So the
 * function keeps the verb (`sendFeedback`, which reads correctly at a call site) and the route
 * name is an alias of it rather than a second function that could drift from it.
 */
export { sendFeedback as feedback };

export const handlers = Object.freeze({ feedback: sendFeedback });
export default sendFeedback;
