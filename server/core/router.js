// server/core/router.js — (method, path) -> handler.  ADR 003 §3, §9; ADR 005 §1.6.
//
// THE POINT OF THIS FILE. There are three ways into the sync API — the Vercel function, the
// dev-server over the file adapter, and tests/helpers/loopback.js which binds the client's
// Transport port straight to these handlers with no sockets at all. All three go through this
// table. That is what makes ADR 003 §9's claim true: the same handler code that runs in
// production runs in CI, and `api/v1/[[...path]].js` cannot contain a bug that a handler test
// would not also see.
//
// PURITY. No clock, no randomness, no I/O, no framework types. Matching is a pure function of
// (method, path) and nothing else.

import { HttpError, fail } from './errors.js';

export const API_PREFIX = '/api/v1';

/**
 * The route table, verbatim from ADR 003 §3. `name` is the key a handler registry is keyed on,
 * so a handler file can be written and wired without touching this table's order or shape.
 *
 * A pattern segment beginning with ':' captures into `params`. Nothing else is dynamic — no
 * regexes, no optional segments, no wildcards. A route surface a reader cannot enumerate at a
 * glance is a route surface nobody audits.
 *
 * @type {ReadonlyArray<{method:string, pattern:string, name:string, spaceParam?:string}>}
 */
export const ROUTES = Object.freeze([
  { method: 'GET',  pattern: '/meta',                 name: 'meta' },

  { method: 'POST', pattern: '/ops',                  name: 'pushOps' },
  { method: 'GET',  pattern: '/ops',                  name: 'pullOps' },

  { method: 'POST', pattern: '/spaces',               name: 'createSpace' },
  { method: 'GET',  pattern: '/spaces/:id/keys',      name: 'fetchKeys',    spaceParam: 'id' },
  { method: 'POST', pattern: '/spaces/:id/epoch',     name: 'rotateEpoch',  spaceParam: 'id' },
  { method: 'GET',  pattern: '/spaces/:id/members',   name: 'listMembers',  spaceParam: 'id' },
  { method: 'POST', pattern: '/spaces/:id/rename',    name: 'renameSpace',  spaceParam: 'id' },
  { method: 'POST', pattern: '/spaces/:id/delete',    name: 'deleteSpace',  spaceParam: 'id' },

  { method: 'POST', pattern: '/invites',              name: 'createInvite' },
  { method: 'POST', pattern: '/invites/redeem',       name: 'redeemInvite' },
  { method: 'POST', pattern: '/invites/revoke',       name: 'revokeInvite' },
  { method: 'GET',  pattern: '/invites/open',         name: 'openInvites' },

  { method: 'POST', pattern: '/members/remove',       name: 'removeMember' },
  { method: 'POST', pattern: '/members/leave',        name: 'leaveSpace' },
  { method: 'POST', pattern: '/members/transfer',     name: 'transferAdmin' },

  { method: 'POST', pattern: '/devices',              name: 'registerDevice' },
  { method: 'POST', pattern: '/devices/adopt',        name: 'adoptDevice' },
  { method: 'POST', pattern: '/devices/revoke',       name: 'revokeDevice' },

  { method: 'POST', pattern: '/pair/offer',           name: 'pairOffer' },
  { method: 'GET',  pattern: '/pair/:rid',            name: 'pairGet' },
  { method: 'POST', pattern: '/pair/answer',          name: 'pairAnswer' },
  { method: 'POST', pattern: '/pair/deliver',         name: 'pairDeliver' },
]);

/** Every handler name the registry may carry. Frozen; a typo is a startup failure, not a 404. */
export const ROUTE_NAMES = Object.freeze(ROUTES.map((r) => r.name));

const SEGMENTS = ROUTES.map((r) => ({ ...r, parts: r.pattern.slice(1).split('/') }));

/**
 * Split a path into segments, percent-decoding each one. A segment that decodes to something
 * containing a separator, a space or a dot-run is rejected rather than re-split: that is the
 * classic traversal shape, and the file adapter turns rids and space ids into map keys.
 * @param {string} path @returns {string[]|null}
 */
function segmentsOf(path) {
  const out = [];
  for (const raw of path.split('/')) {
    if (raw === '') continue;
    let dec;
    try { dec = decodeURIComponent(raw); } catch { return null; }
    if (dec.includes('/') || dec.includes('\\') || dec.includes(' ')) return null;
    if (dec === '.' || dec === '..') return null;
    out.push(dec);
  }
  return out;
}

/**
 * Match a request line against the table.
 *
 * @param {string} method
 * @param {string} path full path INCLUDING the `/api/v1` prefix; a query string is tolerated
 * @returns {{route:Object, params:Object<string,string>}|null} null when nothing matches
 * @throws {HttpError} 405 when the path matches a pattern under a different method
 */
export function matchRoute(method, path) {
  if (typeof method !== 'string' || typeof path !== 'string') return null;
  const q = path.indexOf('?');
  const clean = q >= 0 ? path.slice(0, q) : path;
  if (!clean.startsWith(API_PREFIX + '/') && clean !== API_PREFIX) return null;
  const segs = segmentsOf(clean.slice(API_PREFIX.length));
  if (!segs) return null;

  const upper = method.toUpperCase();
  let pathMatchedOtherMethod = false;

  for (const r of SEGMENTS) {
    if (r.parts.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i++) {
      const p = r.parts[i];
      if (p.startsWith(':')) params[p.slice(1)] = segs[i];
      else if (p !== segs[i]) { ok = false; break; }
    }
    if (!ok) continue;
    if (r.method !== upper) { pathMatchedOtherMethod = true; continue; }
    return { route: r, params };
  }
  if (pathMatchedOtherMethod) throw fail('method_not_allowed');
  return null;
}

/**
 * Build the shared entry point.
 *
 * `handlers` is a plain object keyed by `ROUTE_NAMES`. It is deliberately NOT imported here:
 * LZP-201 ships the table, LZP-202..207 ship the handlers, and this file never changes again.
 * A route with no handler yet answers `501 not_implemented` — a visible, machine-readable gap
 * rather than a 404 that reads like "this endpoint was never specified".
 *
 * @param {Object<string, (req:Object, ctx:Object) => Promise<Object>>} handlers
 * @returns {(ctx:Object, req:Object) => Promise<{status:number, headers:Object, body:any}>}
 */
export function createRouter(handlers) {
  const registry = handlers || {};
  for (const name of Object.keys(registry)) {
    if (!ROUTE_NAMES.includes(name)) throw new HttpError(500, 'internal', { unknownHandler: name });
  }
  return async function route(ctx, req) {
    const m = matchRoute(req.method, req.path);
    if (!m) throw fail('not_found');
    const handler = registry[m.route.name];
    if (typeof handler !== 'function') throw fail('not_implemented', { route: m.route.name });
    return handler({ ...req, params: m.params, routeName: m.route.name }, ctx);
  };
}

/**
 * The routes that are scoped to a single space and therefore must run auth step 7
 * (ADR 003 §2: the member is not a member of spaceId -> 403 not_a_member). The space id may
 * arrive in the path, the query or the body depending on the route, so this exports the fact
 * rather than the extraction — LZP-202 owns the extraction and this owns the enumeration, so a
 * new space-scoped route cannot be added without appearing here.
 */
export const SPACE_SCOPED = Object.freeze({
  fetchKeys: 'param:id', rotateEpoch: 'param:id', listMembers: 'param:id',
  renameSpace: 'param:id', deleteSpace: 'param:id',
  pushOps: 'body:space', pullOps: 'query:space',
  createInvite: 'body:spaceId', revokeInvite: 'body:spaceId', openInvites: 'query:spaceId',
  removeMember: 'body:spaceId', leaveSpace: 'body:spaceId', transferAdmin: 'body:spaceId',
});
