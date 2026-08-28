// server/core/errors.js — the one place an HTTP failure is shaped.  ADR 003 §3, §4, §6.
//
// WHY THIS FILE IS TINY AND WHY IT IS STILL WORTH HAVING.
// Every failure the sync API can produce is a (status, code) pair that the client branches on:
// 401/403 stop the sync loop, 426 shows the outdated screen, 409 re-mints an opId, 429 honours
// Retry-After, and everything else backs off. If each handler invented its own body shape the
// client would have to guess, so the shape is decided here, once, and `toResponse` is the only
// function allowed to build it.
//
// PURITY (ADR 003 §9, ADR 005 §2). No clock, no randomness, no I/O, no globals. A thrown
// HttpError carries only what the wire needs; anything an operator needs instead goes through
// ctx.log() with the whitelisted field set (§6.2).

/**
 * A failure that has a defined HTTP shape. Anything else thrown out of a handler is a bug and
 * becomes `500 internal` with NO detail on the wire — see `toResponse`.
 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code   the stable machine code the client branches on
   * @param {Object} [extra] extra top-level body fields (e.g. `minProto`, `retryAfter`).
   *                         MUST be coordination data only — never ciphertext, never a body echo.
   */
  constructor(status, code, extra) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra || null;
  }
}

/**
 * Every code this server may emit, grouped by the ADR clause that defines it. A handler that
 * needs a code not in this table is proposing a protocol change and should say so in an ADR.
 * Frozen so it cannot be widened at runtime.
 */
export const ERROR_CODES = Object.freeze({
  // §2 — authentication, in verification order
  bad_auth: 401,
  stale_request: 401,
  replay: 401,
  bad_signature: 401,
  device_revoked: 403,
  not_a_member: 403,
  // §3.1 — push
  device_mismatch: 403,
  space_mismatch: 400,
  future_epoch: 400,
  forked_op_id: 409,
  // §4 — protocol versioning and the N-1 rule
  protocol_too_old: 426,
  protocol_unknown: 400,
  // §4.2 of ADR 002 — rotation
  epoch_taken: 409,
  incomplete_coverage: 409,
  // §6 — abuse basics
  payload_too_large: 413,
  rate_limited: 429,
  // §6 of ADR 002 — pairing
  pair_burned: 410,
  pair_expired: 410,
  // invites
  invite_invalid: 403,
  invite_used: 409,
  // routing and shape
  bad_request: 400,
  not_found: 404,
  method_not_allowed: 405,
  not_implemented: 501,
  internal: 500,
});

/** @param {string} code @returns {number} */
export function statusFor(code) {
  const s = ERROR_CODES[code];
  if (typeof s !== 'number') throw new HttpError(500, 'internal');
  return s;
}

/**
 * Build an HttpError from a code in the table, so a handler cannot pair a code with the wrong
 * status by hand.
 * @param {keyof ERROR_CODES|string} code @param {Object} [extra] @returns {HttpError}
 */
export function fail(code, extra) {
  return new HttpError(statusFor(code), code, extra);
}

/**
 * The ONLY function that turns a thrown value into a response.
 *
 * An unrecognised throw becomes `500 internal` with an empty detail set. That is deliberate:
 * a stack trace or a message built from request data is exactly how ciphertext, an opId or a
 * space id leaks into a body that the relay's operator can read (21.3). The operator gets the
 * detail through ctx.log(); the client gets a code.
 *
 * @param {unknown} err
 * @returns {{status:number, headers:Object<string,string>, body:Object}}
 */
export function toResponse(err) {
  if (err instanceof HttpError || (err && typeof err === 'object' && typeof err.status === 'number' && typeof err.code === 'string')) {
    const body = { error: err.code };
    const extra = err.extra;
    if (extra && typeof extra === 'object') {
      for (const k of Object.keys(extra)) {
        if (FORBIDDEN_BODY_FIELDS.has(k)) continue;
        body[k] = extra[k];
      }
    }
    const headers = {};
    if (err.status === 429 && extra && typeof extra.retryAfter === 'number') {
      headers['Retry-After'] = String(extra.retryAfter);
    }
    return { status: err.status, headers, body };
  }
  return { status: 500, headers: {}, body: { error: 'internal' } };
}

/**
 * Field names that may never ride on an error body. This mirrors ADR 003 §6.2's log whitelist
 * from the other direction: the log says what MAY appear, an error body says what MAY NOT, and
 * both lists name the same bytes.
 */
export const FORBIDDEN_BODY_FIELDS = new Set([
  'envelope', 'ct', 'iv', 'sig', 'wrapped', 'wrappedKeys', 'boxA', 'boxB', 'delivery',
  'verifier', 'attestation', 'stack', 'message',
]);
