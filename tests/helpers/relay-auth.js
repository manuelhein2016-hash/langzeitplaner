// tests/helpers/relay-auth.js — the RELAY'S OWN verifier, exposed to tier 1.
//
// WHY THIS IS A HELPER.
// `tests/tier1/suite-integrity.test.js` requires every tier-1 TEST file to import only `node:`,
// `../../src/js/…` or a helper — the rule that stops the suite quietly testing a stand-in. This
// helper exists to satisfy that rule while doing the OPPOSITE of what it guards against: it
// imports `server/core/auth.js`, the real handler-side code that runs in production, so that
// `tests/tier1/platform-net.test.js` can assert the client's `Authorization` header verifies
// under the relay's own parser and its own signature check rather than under a second
// implementation written to agree with the first.
//
// This matters more than it looks. ADR 003 §2 leaves the percent-encoding and the sort domain of
// `sortedQuery` unstated; `server/core/auth.js` pins both and records the pin as E2-202-3.
// `src/js/platform/net.js` has to pin them identically, and the only assertion that can prove it
// is one that runs both. Two files agreeing with the same prose is not the same as two files
// agreeing with each other.

import {
  parseAuthorization, signedBytes, verifySignature, canonicalQuery, signedString, deviceShortOfRaw,
} from '../../server/core/auth.js';

export { canonicalQuery as serverCanonicalQuery, signedString as serverSignedString, deviceShortOfRaw };

/**
 * Verify a client request exactly as `server/core/auth.js` does: parse the header strictly, then
 * check the P-256 signature over the bytes the SERVER reconstructs from method, path, query and
 * `rawBody`.
 *
 * @param {{method:string, path:string, query:Object, rawBody:Uint8Array,
 *          headers:Object<string,string>}} req  as an entry point would build it
 * @param {Uint8Array} sigPubRaw 65 bytes — the device's public signing key
 * @returns {Promise<{ok:boolean, device?:string, ts?:number, reason?:string}>}
 */
export async function verifyAsRelay(req, sigPubRaw) {
  const header = Object.keys(req.headers).find((k) => k.toLowerCase() === 'authorization');
  if (!header) return { ok: false, reason: 'no Authorization header' };
  let cred;
  try {
    cred = parseAuthorization(req.headers[header]);
  } catch (e) {
    return { ok: false, reason: `parseAuthorization refused it: ${e.code || e.message}` };
  }
  const bytes = await signedBytes(req, {}, cred);
  const ok = await verifySignature(sigPubRaw, cred.sigBytes, bytes, {});
  return ok
    ? { ok: true, device: cred.device, ts: cred.tsMs }
    : { ok: false, reason: 'the relay refused the signature', device: cred.device };
}
