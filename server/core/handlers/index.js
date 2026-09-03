// server/core/handlers/index.js — the one composition site.  LZP-207 · ADR 003 §3, §4, §9.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS FOR
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `router.js` ships the 23-route table and refuses to bind a handler name that is not in it.
// LZP-202..206 shipped the handlers, in eight files, each owning one clause of ADR 003. Nothing
// so far has said which function answers which route — deliberately, because `createRouter`
// binds by NAME and a spread wins silently: two files exporting a `rotateEpoch` would produce a
// working server running whichever one was spread last, with no error anywhere. So the binding
// is written out here, one line per route, explicitly, and a test asserts the mapping is total,
// injective and free of that collision.
//
// It is also the place three integration decisions had to be taken rather than described. All
// three were reported by the builders as owed to this ticket; each is recorded below where the
// code that implements it lives, not in a commit message:
//
//   1. **No `withLimits`.** `limits.js`'s INTEGRATION WARNING names two valid compositions and
//      says there is no third. Every handler charges its own budget — now all of them through
//      `enforceFor` — so wrapping `withLimits` on top would spend each pre-auth rule twice and
//      halve the published number. Option (b), and `assertComposition()` below makes the choice
//      structural rather than a comment: it refuses to build a router that has both.
//   2. **`withVersionGate` wraps everything except `meta`.** ADR 003 §4's N−1 rule is enforced
//      by `version.js`; `meta` is exempt because gating the endpoint that explains the gate is a
//      closed loop with the family inside it.
//   3. **The ctx contract is enumerated, not assumed.** `REQUIRED_CTX` lists every member the 23
//      handlers actually reach for, including the two extensions the builders declared
//      (`ctx.sha256`, E2-C1) — so a host that forgets one fails at startup with the name of what
//      it forgot, instead of at 03:00 with a 500 on a redemption.
//
// PURITY (ADR 003 §9, ADR 005 §2). This file imports only from `server/core`. It has no clock, no
// randomness, no I/O and no framework types; every host — `server/api/[[...path]].js`,
// `server/dev-server.mjs`, and a test binding the port directly — builds its own `ctx` and calls
// the function this file returns.

import { createRouter, ROUTE_NAMES } from '../router.js';
import { withVersionGate } from '../version.js';
import { withLimits, RATE_COVERAGE } from '../limits.js';
import { HttpError } from '../errors.js';

import { meta } from './meta.js';
import { pushOps, pullOps } from './ops.js';
import { createSpace, rotateEpoch } from './spaces.js';
import { listMembers } from './members.js';
import { fetchKeys } from './keys.js';
import { createInvite, redeemInvite, revokeInvite, openInvites } from './invites.js';
import { registerDevice, adoptDevice, revokeDevice } from './devices.js';
import { pairOffer, pairGet, pairAnswer, pairDeliver } from './pair.js';
import { removeMember, leaveSpace, transferAdmin, renameSpace, deleteSpace } from './lifecycle.js';
import { sendFeedback, CTX_EXTENSIONS as FEEDBACK_CTX } from './feedback.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. The registry — one line per route, in `router.js`'s own order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every route name in `ROUTE_NAMES`, bound to the function that answers it.
 *
 * Written as an explicit object literal rather than assembled from the eight files' `handlers`
 * exports. Spreading would be shorter and would hide exactly the failure this file exists to
 * prevent: `keys.js`, `ops.js`, `devices.js`, `pair.js` and `lifecycle.js` each export a frozen
 * `handlers` slice, and during development `lifecycle.js` and `spaces.js` BOTH implemented
 * `rotateEpoch` — the duplicate was found and withdrawn by hand, and a spread would have shipped
 * whichever one came last with nothing red anywhere.
 *
 * @type {Object<string, (req:Object, ctx:Object) => Promise<{status:number, headers?:Object, body:any}>>}
 */
export const handlers = Object.freeze({
  meta,

  pushOps,
  pullOps,

  createSpace,
  fetchKeys,
  rotateEpoch,
  listMembers,
  renameSpace,
  deleteSpace,

  createInvite,
  redeemInvite,
  revokeInvite,
  openInvites,

  removeMember,
  leaveSpace,
  transferAdmin,

  registerDevice,
  adoptDevice,
  revokeDevice,

  pairOffer,
  pairGet,
  pairAnswer,
  pairDeliver,

  // LZP-1009. The function is named for what it does (`sendFeedback`); `handlers/feedback.js`
  // also exports it under the ROUTE's name, which is what lets `blindness.test.js` §8 check this
  // binding against that file's export the way it checks the other twenty-three.
  feedback: sendFeedback,
});

/**
 * Which file each route came from. Data, not documentation: `tests/server/blindness.test.js`
 * asserts that every entry here is really that module's export, so a route silently rebound to a
 * different file's function — the spread hazard above, done by hand — fails a test.
 */
export const HANDLER_OWNERS = Object.freeze({
  meta: 'handlers/meta.js',
  pushOps: 'handlers/ops.js', pullOps: 'handlers/ops.js',
  createSpace: 'handlers/spaces.js', rotateEpoch: 'handlers/spaces.js',
  listMembers: 'handlers/members.js',
  fetchKeys: 'handlers/keys.js',
  createInvite: 'handlers/invites.js', redeemInvite: 'handlers/invites.js',
  revokeInvite: 'handlers/invites.js', openInvites: 'handlers/invites.js',
  registerDevice: 'handlers/devices.js', adoptDevice: 'handlers/devices.js',
  revokeDevice: 'handlers/devices.js',
  pairOffer: 'handlers/pair.js', pairGet: 'handlers/pair.js',
  pairAnswer: 'handlers/pair.js', pairDeliver: 'handlers/pair.js',
  removeMember: 'handlers/lifecycle.js', leaveSpace: 'handlers/lifecycle.js',
  transferAdmin: 'handlers/lifecycle.js', renameSpace: 'handlers/lifecycle.js',
  deleteSpace: 'handlers/lifecycle.js',
  feedback: 'handlers/feedback.js',
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The `ctx` a host must supply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every `ctx` member the 23 handlers reach for, with what breaks when it is absent.
 *
 * This is the deployment checklist for `server/api/**` and for `server/dev-server.mjs`, and it
 * is enumerated rather than trusted because the failure mode of a missing one is not a crash at
 * boot — it is a 500 on one endpoint, months later, on the request that happens to need it.
 * `ctx.sha256` is the sharp example: nothing but `redeemInvite` calls it, so a host that forgot
 * it would pass every smoke test and then fail the one request a joining family member makes.
 */
export const REQUIRED_CTX = Object.freeze([
  Object.freeze({ name: 'store', shape: 'SyncStore', absent: 'nothing works' }),
  Object.freeze({ name: 'now', shape: '() => number', absent: 'every TTL, expiry and serverTime is wrong' }),
  Object.freeze({ name: 'random', shape: '(n) => Uint8Array', absent: 'createInvite cannot fill Invite.wrapSalt' }),
  Object.freeze({
    name: 'sha256', shape: '(bytes) => Promise<Uint8Array>',
    absent: 'redeemInvite 500s — the invite verifier cannot be checked (spaces.js CTX_EXTENSIONS E2-C1)',
  }),
  Object.freeze({ name: 'auth', shape: '(req) => Promise<Auth>', absent: 'every authenticated route 501s' }),
  Object.freeze({
    name: 'assertMember', shape: '(memberId, spaceId) => Promise<Member>',
    absent: 'ADR 003 §2 step 6/7 never runs on the ten routes SPACE_SCOPED does not cover (finding E2-202-A)',
  }),
  Object.freeze({ name: 'limits', shape: 'LIMITS', absent: 'handler-local fallbacks apply; no route is unlimited' }),
  Object.freeze({
    name: 'log', shape: '(evt) => void',
    absent: 'nothing is logged; handlers all guard with typeof === "function", so this one is OPTIONAL',
    optional: true,
  }),
  Object.freeze({
    name: 'subtle', shape: 'SubtleCrypto',
    absent: 'auth.js falls back to globalThis.crypto.subtle, which exists in Node and on Vercel',
    optional: true,
  }),
  // LZP-1009 declares its own ctx member rather than having this list grow a name nobody can
  // trace back to a handler. Spread from `handlers/feedback.js` so the two cannot disagree about
  // what a host must supply — `tests/server/feedback.test.js` §6 asserts the spread really
  // happened, which a hand-copied entry would pass while drifting.
  ...FEEDBACK_CTX,
]);

/** The non-optional subset, as plain names. */
export const REQUIRED_CTX_NAMES = Object.freeze(REQUIRED_CTX.filter((c) => !c.optional).map((c) => c.name));

/**
 * Fail at startup, with the name of what is missing, rather than at 03:00 with a 500.
 *
 * @param {Object} ctx
 * @throws {HttpError} 500 internal, carrying `{ missingCtx: [...] }`
 */
export function assertCtx(ctx) {
  const missing = [];
  for (const c of REQUIRED_CTX) {
    if (c.optional) continue;
    const v = ctx ? ctx[c.name] : undefined;
    if (v === undefined || v === null) missing.push(c.name);
  }
  if (missing.length > 0) throw new HttpError(500, 'internal', { missingCtx: missing });
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The composition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five routes `withLimits` would actually wrap, and the name it gives the wrapper.
 *
 * BOTH ARE DERIVED BY ASKING `limits.js`, NOT COPIED FROM IT. `withLimits` wraps a handler only
 * when `RATE_COVERAGE[name].pre` is non-empty, and names the wrapper itself; hardcoding either
 * fact here would make this check silently stop working the day `limits.js` renamed its wrapper
 * or declared a sixth pre-auth rule — which is precisely the day it would matter. So the probe
 * below runs the real `withLimits` over a stub and reads back what it produced.
 *
 * There is no build step in this project (ADR 005 — the app is served as raw ES modules), so
 * `Function.prototype.name` survives to production unmangled.
 */
const PRE_AUTH_ROUTES = Object.freeze(
  ROUTE_NAMES.filter((n) => ((RATE_COVERAGE[n] && RATE_COVERAGE[n].pre) || []).length > 0));

const LIMIT_WRAPPER_NAME = (() => {
  const probe = PRE_AUTH_ROUTES[0];
  if (probe === undefined) return null;                     // no pre-auth rule declared at all
  const stub = async function unwrapped() { return { status: 200, body: null }; };
  const wrapped = withLimits({ [probe]: stub })[probe];
  return wrapped === stub ? null : wrapped.name;            // null ⇒ withLimits wrapped nothing
})();

/**
 * Integration decision 1, made structural.
 *
 * `limits.js` says there is no correct third option between "converge the handlers onto
 * `enforceFor` and compose `withLimits`" and "let the handlers self-limit and do not". They
 * self-limit, so `withLimits` must not appear here — and a comment saying so would be undone by
 * the first person who reads `withLimits`'s own JSDoc, which shows the other composition. So the
 * factory takes the registry it is handed and refuses to accept a wrapper it did not build.
 *
 * WHAT DOUBLE-COMPOSING WOULD ACTUALLY COST, so the refusal is not read as fussiness: every
 * pre-auth budget would be charged twice per request and the PUBLISHED number would silently
 * halve — `invitesPerIpHour` 10 becomes 5, `pairGetPerIpHour` 20 becomes 10, `spacesPerIpHour` 5
 * becomes 2. Nothing errors. A family onboarding two people from one household hits a limit that
 * ADR 003 §6.1 says is twice as generous as it is, and the only symptom is a 429 nobody can
 * explain. `invites.js` already carries this warning in prose at its `enforceFor` call; this is
 * the half of it that runs.
 *
 * @param {Object<string, Function>} registry
 */
function assertComposition(registry) {
  const names = Object.keys(registry);
  for (const n of names) {
    if (!ROUTE_NAMES.includes(n)) throw new HttpError(500, 'internal', { unknownHandler: n });
    if (typeof registry[n] !== 'function') throw new HttpError(500, 'internal', { notAFunction: n });
  }
  if (LIMIT_WRAPPER_NAME !== null) {
    const doubled = PRE_AUTH_ROUTES.filter(
      (n) => typeof registry[n] === 'function' && registry[n].name === LIMIT_WRAPPER_NAME);
    if (doubled.length > 0) throw new HttpError(500, 'internal', { doubleCharged: doubled });
  }
  // Every route bound. `createRouter` tolerates a partial registry (501 not_implemented) because
  // that is what made LZP-201 shippable before the handlers existed; at the composition site the
  // opposite is right — a route with no handler in production is a gap nobody meant to ship.
  const unbound = ROUTE_NAMES.filter((n) => typeof registry[n] !== 'function');
  if (unbound.length > 0) throw new HttpError(500, 'internal', { unboundRoutes: unbound });
}

/**
 * Build the request entry point every host shares.
 *
 *     const route = createHandlers();
 *     const res = await route(ctx, { method, path, query, headers, body, rawBody });
 *
 * @param {Object} [opts]
 * @param {Object<string, Function>} [opts.registry] override for tests; defaults to `handlers`
 * @param {Object} [opts.version] `createVersionGate` options, for the compat harness
 * @returns {(ctx:Object, req:Object) => Promise<{status:number, headers:Object, body:any}>}
 */
export function createHandlers(opts) {
  const registry = (opts && opts.registry) || handlers;
  assertComposition(registry);
  // ORDER MATTERS. The version gate is outermost so a client the server cannot speak to gets 426
  // before any handler parses its body — ADR 003 §4's whole point is that an old client is told
  // to update, not handed a shape error it has no rule for. `meta` is exempt inside the gate.
  return createRouter(withVersionGate(registry, opts && opts.version));
}

/** The default, for hosts that need no options. */
export const route = createHandlers();

export default handlers;
