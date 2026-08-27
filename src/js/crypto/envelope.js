// src/js/crypto/envelope.js — the op envelope.  LZP-304 · ADR 002 §5 (§5.1-§5.4), ADR 004 §2.4.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2). The CSPRNG and the SubtleCrypto arrive as
// injected ports; the key ring, the attestation table and ADR 004's projection seam arrive as
// arguments. Nothing here reads a clock — deliberately, and see "NO AUTHORING TIME" below.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS
// ─────────────────────────────────────────────────────────────────────────────
//
// One op goes out through `sealOp` and one op comes back through `openOp`, and those are the only
// two doors. Everything the relay ever sees of a family's calendar is what `sealOp` decided to
// put in an `Envelope`'s NINE plaintext fields:
//
//     { v, sp, ep, dv, oid, wit, iv, ct, sig }
//
// There is no tenth field, and adding one is a wire-format change. In particular there is
// **NO AUTHORING TIME** anywhere outside the ciphertext (ADR 002 §5.1, §11 rule 5): `op.ts` — the
// HLC stamp — lives inside `ct`, and `opId` is 128 random bits with no time component precisely so
// that the idempotency key does not leak a wall clock (ADR 001 §1.2). The relay keeps `receivedAt`,
// which it cannot avoid knowing. It does not learn that an op was authored three weeks ago on a
// train. `tests/tier1/crypto-envelope.test.js` asserts the nine-field shape and asserts that no
// plaintext header field carries the stamp.
//
// ─────────────────────────────────────────────────────────────────────────────
// SIGN THE CIPHERTEXT, VERIFY BEFORE DECRYPT
// ─────────────────────────────────────────────────────────────────────────────
//
//     sig = ECDSA-P256/SHA-256( IK_sig.private, aad ‖ iv ‖ ct )
//
// Encrypt-then-sign, never sign-then-encrypt. A failed signature never reaches the AES path, so a
// forged or mangled ciphertext is refused by a cheap public-key check rather than by GCM's tag on
// bytes we have already fed to the cipher. `openOp`'s P3 is that check and it runs BEFORE P4 even
// looks for a key.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE AAD BINDS `v ‖ sp ‖ ep ‖ dv ‖ oid ‖ wit`, AND IS NEVER EMPTY
// ─────────────────────────────────────────────────────────────────────────────
//
// Every one of those six fields is a lever the relay would otherwise hold (ADR 002 §5.1):
//
//   v    version confusion — a downgrade to a suite we no longer trust
//   sp   replay a PERSONAL op into the FAMILY stream hoping a client opens it under the wrong key
//   ep   relabel a stale-epoch op as current, or pin a client to a compromised epoch
//   dv   RE-ATTRIBUTE an op to another device — "von Mama" is rendered from this chain (17.6)
//   oid  ENVELOPE SPLICING — rewrite the outer idempotency key to make one op look like two, or
//        suppress a delete by colliding its id
//   wit  rewrite what a device claimed to have seen (§5.4)
//
// The same six bytes are inside the signature, so re-attributing an op breaks the GCM tag **and**
// the signature. The AAD is a JSON array beginning with the fixed tag `'lzp/v2/op'`, so it is
// non-empty by construction — which is engine rule 2's requirement and `suite.aesgcm()`'s.
//
// ─────────────────────────────────────────────────────────────────────────────
// PADDING IS A SECURITY MEASURE, NOT A FORMATTING DETAIL (§5.3)
// ─────────────────────────────────────────────────────────────────────────────
//
//     varint(len) ‖ utf8(canonicalJSON(op)) ‖ zeros      -> a multiple of PAD_BUCKET (256)
//
// Without it a **Belegt** op (no `pub.text`) is visibly shorter on the wire, and in the `ct`
// column, than a **Geteilt** op — and T1, the curious relay, can distinguish *"she shared the
// details"* from *"she only marked herself busy"*. Story 16.7 explicitly promises not to enable
// that inference. `tests/tier1/crypto-envelope.test.js` asserts the two are byte-for-byte the same
// LENGTH, which is the only form of that promise a test can hold.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ENGINE-DIFFERENCE RULES THIS FILE TOUCHES (ADR 002 §1)
// ─────────────────────────────────────────────────────────────────────────────
//
//   1. Never compare signature bytes. ECDSA is non-deterministic in BOTH engines, so two seals of
//      the same op differ in `sig` AND in `iv` AND therefore in `ct`. `sealOp` is NOT a pure
//      function of its inputs and nothing may treat an envelope as a content address. The only
//      correct assertion about `sig` is `openOp` succeeding.
//   2. Never sign or verify a zero-length payload. `aad ‖ iv ‖ ct` is never empty (the AAD alone
//      is ~60 bytes) but both call sites still go through `assertSignable`.
//   3. Never branch on error NAMES. Every WebCrypto call below is wrapped at a try/catch BOUNDARY
//      and the boundary decides the outcome; no `err.name` is ever read. That is why a GCM
//      failure becomes one `EnvelopeError` with our own message instead of Node's
//      `OperationError` / WebKit's — which are not the same string.
//   4. HKDF salt — not used here (no derivation in the envelope path).
//   5. Peer ECDH import — not used here.
//   6. AES-KW — never used, here or anywhere.
//   7. `indexedDB` / `isSecureContext` — `platform/keystore.js` owns that asymmetry.
//
// ─────────────────────────────────────────────────────────────────────────────
// PARKS ARE RETURNED. PROTOCOL VIOLATIONS ARE THROWN. THAT ASYMMETRY IS DELIBERATE.
// ─────────────────────────────────────────────────────────────────────────────
//
// `openOp` returns a discriminated result — `{status:'opened', op, attestation}` or
// `{status:'park', parkReason, reason}` — and throws `EnvelopeError` for a protocol violation.
// Two reasons for the split, and both are load-bearing:
//
//   · A park is ORDINARY. There is no causal delivery in this system (ADR 001 §2), so a member's
//     first content op overtaking their own `member.set{dev.*}` is normal traffic, not an attack
//     (ADR 002 §5.2.5, finding F-6). Rejecting it is silent data loss on first contact and on
//     every partial pull. Ordinary outcomes must not be exceptions.
//   · Because the success case is a WRAPPER, a caller cannot accidentally use a park as an op.
//     `const op = await openOp(...)` followed by `op.f` is a `TypeError` on the very first park,
//     at the seam, instead of a `undefined` three layers away.
//
// A protocol violation — P2, P3, or any of the five post-decrypt identity checks — is a throw,
// because it is not re-evaluable: no later op makes a bad signature good.

import { b64u, ub64, CodecError } from '../core/b64.js';
import { canonicalBytes, canonicalJSON, utf8Decode, varint, readVarint, CanonError } from '../core/canon.js';
import { devOf, isStamp } from '../core/stamp.js';
import { isDeviceShort, defaultRandom } from '../core/ids.js';
import {
  isSpaceId, isOpId, isMemberId, isDeviceId, parseEntityKey, VISIBILITY_LEVELS,
} from '../core/entities.js';
import { FIELDS, PARK_REASONS, spaceClassOf, validateOp } from '../core/ops.js';
import {
  AEAD, ENVELOPE_V, PAD_BUCKET, aesgcm, assertSignable,
} from './suite.js';
import { defaultSubtle, importSigPublic, signBytes, verifyBytes, deviceShortOfB64u } from './identity.js';

const subtleOf = (ports) => (ports && ports.subtle) || defaultSubtle();
const randomOf = (ports) => (ports && ports.random) || defaultRandom;

// ─────────────────────────────────────────────────────────────────────────────
// 0. Errors, and the park vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} KeyRing  (`docs/v2/contracts/crypto.contract.js` §3 — LZP-303's, not this
 *   file's; `envelope.js` only ever calls `get`, and calls it SYNCHRONOUSLY.)
 * @property {(space:string, epoch:number) => (CryptoKey|null)} get
 * @property {(space:string, epoch:number, k:CryptoKey) => void} [put]
 * @property {(space:string) => number} [currentEpoch]
 * @property {(space:string) => number[]} [epochs]
 */
/** @typedef {import('./identity.js').DeviceAttestation} DeviceAttestation */

/**
 * A protocol violation at the envelope seam: a bad signature, a self-inconsistent attestation, a
 * plaintext that does not match its own authenticated header. NOT re-evaluable — no later op
 * makes any of these good — so it is a throw and never a park.
 *
 * It carries a machine-readable `check` (`'P2'`, `'P3'`, `'C1'`…`'C5'`, `'shape'`, `'aead'`,
 * `'padding'`, `'canonical'`) so a caller can report WHICH invariant failed **without reading an
 * engine's error name** (rule 3). The `message` is ours, in our words, in both engines.
 */
export class EnvelopeError extends Error {
  /** @param {string} message @param {string} [check] */
  constructor(message, check = 'shape') {
    super(message);
    this.name = 'EnvelopeError';
    this.check = check;
  }
}

/**
 * ADR 004's barrier refusing to seal. Named to match §2.2's `RedactionError` so that the loud
 * failure path §2.3 requires — stop the sync loop, set the `error` sync state, never
 * log-and-skip — can catch one class.
 *
 * `src/js/core/project.js` (WP-10) will export its own `RedactionError`; the two are siblings, not
 * rivals. This one is raised by the SEAL seam (barriers 3 and 4), that one by the PROJECTION seam
 * (barriers 1 and 2). A caller that catches `RedactionError` by NAME catches both, which is the
 * behaviour §2.3 wants; a caller that catches by identity should catch both classes.
 */
export class RedactionError extends Error {
  /** @param {string} message @param {string} [barrier] */
  constructor(message, barrier = '') {
    super(message);
    this.name = 'RedactionError';
    this.barrier = barrier;
  }
}

/**
 * The two reasons `openOp` parks, mapped onto ADR 001 §7.4's vocabulary.
 *
 * `EPOCH` and `VERSION` already exist in `src/js/core/ops.js`'s `PARK_REASONS` and are re-exported
 * from there rather than re-spelled, so the two can never drift apart.
 *
 * ⚠ `ATTESTATION` DOES NOT YET EXIST IN `ops.js` — it is finding **F-6**, owned by WP-8, and
 * ADR 002 §5.2.5 says it "must exist in `ops.js`'s `PARK_REASONS` before WP-8 pulls from a real
 * peer". `src/js/core/ops.js` is not this work package's file, so the constant is defined here
 * with the value `ops.js` must adopt (`'attestation'`), and `PARK_REASONS_NEEDED` below states the
 * obligation in code so the day it lands is a one-line deletion rather than an archaeology
 * exercise. Until then a caller writing this reason into the op log will fail `isParkReason` —
 * which is the correct, loud symptom of an unfinished seam, not something to work around here.
 */
export const ENVELOPE_PARK = Object.freeze({
  /** P1: `attestationOf(env.dv)` is null — ABSENT, or CONTESTED (§2.3 "Two shorts, no winner"). */
  ATTESTATION: 'attestation',
  /** P4: the key ring does not hold `env.ep`. Re-evaluated on the next key fetch (§4.4). */
  EPOCH: PARK_REASONS.EPOCH,
  /** `env.v` is not `ENVELOPE_V`. Re-evaluated after an app update (§1 "versioning, not negotiation"). */
  VERSION: PARK_REASONS.VERSION,
  /** The decrypted op's kind is unknown to this build (ADR 001 §7.4). */
  UNKNOWN_KIND: PARK_REASONS.UNKNOWN_KIND,
  /** The decrypted op names a field this build does not know. Parked WITH ITS OP. */
  UNKNOWN_FIELD: PARK_REASONS.UNKNOWN_FIELD,
  /** The decrypted op names a space form this build does not recognise. */
  UNKNOWN_SPACE: PARK_REASONS.UNKNOWN_SPACE,
});

/**
 * What `openOp` needs from another module and does not have. Read by
 * `tests/tier1/crypto-envelope.test.js`, which asserts the gap is still real — so the test turns
 * green-and-wrong into red the moment WP-8 lands the reason and this list is not updated.
 */
export const PARK_REASONS_NEEDED = Object.freeze([
  Object.freeze({
    reason: 'attestation',
    owner: 'WP-8',
    finding: 'F-6',
    why: 'ADR 002 §5.2.5 / ADR 001 §7.4 — an op from a device whose attestation has not arrived '
       + 'is PARKED, not rejected. `authz.js:671` still rejects and `store.js:699-703` drops the '
       + 'rejected op without appending it, so it is never re-evaluated.',
  }),
]);

// ─────────────────────────────────────────────────────────────────────────────
// 1. The AAD  (ADR 002 §5.1)
// ─────────────────────────────────────────────────────────────────────────────

const TE = new TextEncoder();

/** The fixed first element. It is what makes the AAD non-empty even for an all-empty header. */
export const AAD_TAG = 'lzp/v2/op';

/** The nine plaintext fields of an envelope, in wire order. There is no tenth. */
export const ENVELOPE_FIELDS = Object.freeze(['v', 'sp', 'ep', 'dv', 'oid', 'wit', 'iv', 'ct', 'sig']);

/** The six header fields the AAD binds, in the order §5.1 lists them. */
export const AAD_FIELDS = Object.freeze(['v', 'sp', 'ep', 'dv', 'oid', 'wit']);

/** base64url, the alphabet every b64u field on the wire uses. */
const B64U_RE = /^[A-Za-z0-9_-]*$/;

/**
 * The chain witness (§5.4). Diagnostic-only, best-effort, and it NEVER blocks sync in v2 — a
 * false positive that broke a family's board would be far worse than the attack it detects.
 *
 * ⚠ AN ADR AMBIGUITY, RESOLVED CONSERVATIVELY. §5.4 defines the chain as
 * `SHA-256(prevChainHash ‖ opId)` — 32 bytes, 43 base64url characters — while §5.1's example
 * shows a 22-character value, and `server.contract.js`'s `OpRow.witness` is simply `Bytes?`.
 * The width is the RELAY's to fix (it computes the chain), not this seam's, so this file pins the
 * ALPHABET and an upper bound and does not pin the width. What matters here is only that the value
 * is ASCII: see `aadOf`.
 */
const WIT_MAX_CHARS = 86;

/**
 * `AAD = TE.encode(JSON.stringify(['lzp/v2/op', v, sp, ep, dv, oid, wit]))`. ALWAYS non-empty.
 *
 * ⚠ WHY `JSON.stringify` AND NOT `canonicalJSON`, WHICH THIS PROJECT USES EVERYWHERE ELSE.
 * ADR 002 §5.1 spells the expression literally, and the AAD is WIRE FORMAT: two clients that
 * disagree about one byte of it disagree about every GCM tag, and the symptom three layers away is
 * "this family member's ops will not decrypt". So the ADR's expression is reproduced verbatim.
 *
 * That is only safe because a JSON array has no key order to canonicalise and because
 * `assertHeader` has already refused any field that is not drawn from a restricted ASCII alphabet
 * — so NFC normalisation is a no-op, a lone surrogate is impossible, and `canonicalJSON` would
 * produce the identical bytes. `tests/tier1/crypto-envelope.test.js` asserts exactly that
 * equivalence over generated headers, in both engines, so the shortcut can never quietly become a
 * different function from the canonical one.
 *
 * @param {{v:number, sp:string, ep:number, dv:string, oid:string, wit:string}} hdr
 * @returns {Uint8Array} never empty
 */
export function aadOf(hdr) {
  assertHeader(hdr, 'aadOf');
  return TE.encode(JSON.stringify([AAD_TAG, hdr.v, hdr.sp, hdr.ep, hdr.dv, hdr.oid, hdr.wit]));
}

/**
 * Refuse a header that could produce an ambiguous or non-ASCII AAD.
 *
 * This is not defensive decoration. Every field below ends up inside the authenticated data of a
 * GCM tag and inside an ECDSA signature; a field this seam accepted loosely would be a field two
 * clients could spell differently while both believing they had agreed.
 *
 * @param {any} hdr @param {string} who
 * @returns {{v:number, sp:string, ep:number, dv:string, oid:string, wit:string}}
 */
export function assertHeader(hdr, who = 'envelope') {
  if (hdr === null || typeof hdr !== 'object' || Array.isArray(hdr)) {
    throw new EnvelopeError(`${who}: the header must be an object`, 'shape');
  }
  if (hdr.v !== ENVELOPE_V) {
    throw new EnvelopeError(
      `${who}: header v must be ${ENVELOPE_V}, got ${JSON.stringify(hdr.v)}. There is one suite, ` +
      'pinned by Envelope.v, and no downgrade-negotiation surface (ADR 002 §1).', 'shape');
  }
  if (!isSpaceId(hdr.sp)) {
    throw new EnvelopeError(`${who}: header sp must be a SpaceId, got ${JSON.stringify(hdr.sp)}`, 'shape');
  }
  if (!Number.isSafeInteger(hdr.ep) || hdr.ep < 1) {
    throw new EnvelopeError(`${who}: header ep must be an epoch >= 1, got ${JSON.stringify(hdr.ep)}`, 'shape');
  }
  if (!isDeviceShort(hdr.dv)) {
    throw new EnvelopeError(
      `${who}: header dv must be 16 Crockford characters (ADR 001 §1.2), got ${JSON.stringify(hdr.dv)}`,
      'shape');
  }
  if (!isOpId(hdr.oid)) {
    throw new EnvelopeError(`${who}: header oid must be a 22-char opId, got ${JSON.stringify(hdr.oid)}`, 'shape');
  }
  if (typeof hdr.wit !== 'string' || hdr.wit.length > WIT_MAX_CHARS || !B64U_RE.test(hdr.wit)) {
    throw new EnvelopeError(
      `${who}: header wit must be base64url (or '' on the first push), got ${JSON.stringify(hdr.wit)}`,
      'shape');
  }
  return hdr;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Padding  (ADR 002 §5.3)
//
//     varint(len) ‖ utf8(canonicalJSON(op)) ‖ zeros    -> a multiple of PAD_BUCKET
//
// The varint is what lets `unpad` find the boundary WITHOUT trusting the zero run, so a plaintext
// that legitimately ends in a zero byte still round-trips. `core/canon.js` owns the varint and
// refuses a non-minimal encoding, which would otherwise give one length two spellings — and two
// spellings of one length is a covert channel that survives the GCM tag.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The padded size of `n` payload bytes plus their length prefix.
 *
 * ⚠ AN ADR AMBIGUITY, RESOLVED. §5.3 says "padded to the next multiple of 256 bytes" and does not
 * say what happens when the prefixed length is ALREADY a multiple of 256. Two readings: pad to the
 * smallest multiple that is >= the length (a 256-byte input stays 256), or always add at least one
 * byte (a 256-byte input becomes 512). **The ceiling reading is taken**, because it is the one that
 * makes §5.3's own claim true: "ops of 1–256 plaintext bytes — the overwhelming majority — are
 * indistinguishable in length" is a statement about a CLOSED interval, and the alternative reading
 * would push a 256-byte op into a bucket of its own and make it the most distinguishable op on the
 * wire. Nothing is lost: the boundary is observable under either reading, and the ceiling puts more
 * ops in the first bucket.
 *
 * @param {number} n payload bytes
 * @returns {number} a positive multiple of PAD_BUCKET
 */
export function paddedLength(n) {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new EnvelopeError(`envelope.paddedLength: ${n} is not a positive payload length`, 'padding');
  }
  const total = varint(n).length + n;
  return Math.ceil(total / PAD_BUCKET) * PAD_BUCKET;
}

/**
 * `varint(len) ‖ bytes ‖ zeros`, to a multiple of `PAD_BUCKET`.
 *
 * @param {Uint8Array} plaintextBytes `canonicalBytes(op)` — non-empty
 * @returns {Uint8Array} length is a positive multiple of PAD_BUCKET
 */
export function pad(plaintextBytes) {
  if (!(plaintextBytes instanceof Uint8Array)) {
    throw new EnvelopeError('envelope.pad: expected the canonical plaintext bytes', 'padding');
  }
  if (plaintextBytes.length === 0) {
    // An op that canonicalises to nothing is not an op. Refusing here also keeps rule 2's promise
    // one layer up: an empty payload could never produce an empty signing input, but it would mean
    // something upstream handed us a value it never checked.
    throw new EnvelopeError('envelope.pad: refusing a zero-length plaintext', 'padding');
  }
  const prefix = varint(plaintextBytes.length);
  const out = new Uint8Array(paddedLength(plaintextBytes.length));
  out.set(prefix, 0);
  out.set(plaintextBytes, prefix.length);
  return out;
}

/**
 * The inverse. STRICT, on purpose — and the strictness is a security measure, not tidiness.
 *
 * GCM authenticates the padded bytes, so a *relay* cannot alter them. But a family member CAN
 * (T5): she authors the plaintext herself, and any byte of the padding she is allowed to choose is
 * a channel that reaches every honest client's disk while looking like an ordinary op. So three
 * things are checked and every one of them throws:
 *
 *   · the total length is a positive multiple of PAD_BUCKET;
 *   · the declared length fits inside the block, with a MINIMAL varint (`core/canon.js` enforces
 *     minimality, which is what stops one length having two spellings); and
 *   · **every trailing byte is zero.** This is the one that closes the channel.
 *
 * @param {Uint8Array} paddedBytes
 * @returns {Uint8Array} the payload
 */
export function unpad(paddedBytes) {
  if (!(paddedBytes instanceof Uint8Array)) {
    throw new EnvelopeError('envelope.unpad: expected bytes', 'padding');
  }
  const n = paddedBytes.length;
  if (n === 0 || n % PAD_BUCKET !== 0) {
    throw new EnvelopeError(
      `envelope.unpad: padded length ${n} is not a positive multiple of ${PAD_BUCKET}`, 'padding');
  }
  let head;
  try {
    head = readVarint(paddedBytes, 0);
  } catch (err) {
    // `CanonError` covers truncation, an over-long varint and a NON-MINIMAL encoding. Caught at the
    // boundary and re-raised in our words — rule 3, and the caller must not have to know that
    // `core/canon.js` is what refused it.
    if (err instanceof CanonError) {
      throw new EnvelopeError(`envelope.unpad: bad length prefix — ${err.message}`, 'padding');
    }
    throw err;
  }
  const start = head.bytesRead;
  const end = start + head.value;
  if (head.value < 1 || end > n) {
    throw new EnvelopeError(
      `envelope.unpad: declared payload length ${head.value} does not fit in ${n} bytes`, 'padding');
  }
  for (let i = end; i < n; i++) {
    if (paddedBytes[i] !== 0) {
      throw new EnvelopeError(
        `envelope.unpad: padding byte ${i} is 0x${paddedBytes[i].toString(16)}, not zero — the ` +
        'pad is not a place to carry data (ADR 002 §5.3)', 'padding');
    }
  }
  return paddedBytes.slice(start, end);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ADR 004 §2.4 — the branded-patch precondition
//
// "Plaintext leaves a device through exactly one function, and that function is
//  projectForFamily()." — ADR 002 §0's design axiom.
//
// `sealOp` is the door that axiom is about, so `sealOp` is where the axiom is ENFORCED. ADR 004
// §2.2 lists four independent barriers; two of them live here:
//
//   barrier 3  sealOp accepts only a BRANDED patch for a family-space `pub.set`.
//   barrier 4  sealOp re-derives `level` from the AUTHENTICATED register map and never trusts a
//              caller-supplied one. A caller that passes 'geteilt' for a Belegt entry does not get
//              its text sealed.
//
// `src/js/core/project.js` is WP-10's and DOES NOT EXIST YET. Everything below is therefore
// written as a SEAM with a stated contract, and today's behaviour is REFUSAL: a family-space
// `pub.set` cannot be sealed at all until WP-10 both brands its patches and injects
// `assertFamilyPatch`. That is the right default — the failure of an unbuilt module must be "you
// cannot publish", never "you publish unchecked".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ THE BRAND IS A GLOBAL-REGISTRY SYMBOL, AND THAT IS A DELIBERATE STRUCTURAL CHOICE.
 *
 * ADR 004 §2 requires `project.js` to import **nothing outside `core/`**, and ADR 005 §2's import
 * direction forbids `core/ -> crypto/` besides. So `project.js` cannot import a brand token from
 * this file, and this file cannot import one from `project.js` without inverting the direction the
 * purity gate enforces. `Symbol.for` is the one token both sides can name without importing
 * anything: it is resolved out of the cross-realm global symbol registry, so
 * `Symbol.for('lzp/v2/family-patch')` in `core/project.js` and here are the SAME symbol.
 *
 * **What this brand is, and what it is not.** It is not a capability and it is not unforgeable —
 * any caller can write the symbol onto an object. It is not trying to be: barrier 3's job, in
 * ADR 004's own words, is that *"no future caller can bypass the allowlist, including one written
 * by a downstream agent who never read this document"*. A downstream agent does not stumble into
 * `Symbol.for('lzp/v2/family-patch')` with a correct `FamilyPatchBrand` beside it; they either read
 * ADR 004 or they get a `RedactionError`. Someone who deliberately forges the brand has to restate
 * the redaction decision in the evidence — and `sealOp` then checks that restatement against the
 * authenticated register map (barrier 4) and against `FIELDS`' `geteiltOnly` marks (the backstop
 * below), so the forgery buys nothing that a level confusion did not already have to survive.
 */
export const FAMILY_PATCH_BRAND = Symbol.for('lzp/v2/family-patch');

/**
 * @typedef {Object} FamilyPatchBrand
 * @property {1} v
 * @property {'projectForFamily'} source   who built the patch. One producer, named (ADR 004 §2).
 * @property {'fnote'|'fbar'} kind
 * @property {'belegt'|'geteilt'} level    the level the projection APPLIED, restated so barrier 4
 *                                         has something to compare the register map against
 * @property {string[]} fields             the allowlist rows the projection emitted
 */

/**
 * Attach the brand. Exported so `src/js/core/project.js` MAY use it — but it cannot import it
 * (see above), so the canonical form for WP-10 is the four lines this function performs:
 *
 * ```js
 * Object.defineProperty(patch, Symbol.for('lzp/v2/family-patch'), {
 *   value: Object.freeze({ v: 1, source: 'projectForFamily', kind, level, fields }),
 *   enumerable: false, writable: false, configurable: false,
 * });
 * ```
 *
 * **Non-enumerable is required, not stylistic.** `canonicalJSON` walks `Object.keys`, so an
 * enumerable brand would be sealed into the ciphertext and become wire format; and a symbol key is
 * never enumerated by `Object.keys` anyway, so the two protections agree. `writable:false,
 * configurable:false` means a patch cannot be re-branded at a different level after the projection
 * decided — which is barrier 4's attack, one step earlier.
 *
 * @param {Object} patch @param {FamilyPatchBrand} evidence @returns {Object} the same patch
 */
export function brandFamilyPatch(patch, evidence) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new RedactionError('brandFamilyPatch: a patch must be a plain object', 'brand');
  }
  const ev = Object.freeze({
    v: 1,
    source: 'projectForFamily',
    kind: evidence && evidence.kind,
    level: evidence && evidence.level,
    fields: Object.freeze([...((evidence && evidence.fields) || Object.keys(patch))]),
  });
  Object.defineProperty(patch, FAMILY_PATCH_BRAND, {
    value: ev, enumerable: false, writable: false, configurable: false,
  });
  return patch;
}

/**
 * Read the brand back. `null` when absent or malformed — the caller decides what that means, and
 * for `sealOp` it means refusal.
 * @param {any} patch @returns {FamilyPatchBrand|null}
 */
export function familyPatchBrand(patch) {
  if (patch === null || typeof patch !== 'object') return null;
  const ev = patch[FAMILY_PATCH_BRAND];
  if (ev === null || typeof ev !== 'object') return null;
  if (ev.v !== 1 || ev.source !== 'projectForFamily') return null;
  if (ev.kind !== 'fnote' && ev.kind !== 'fbar') return null;
  if (!VISIBILITY_LEVELS.includes(ev.level)) return null;
  if (!Array.isArray(ev.fields)) return null;
  return ev;
}

/**
 * THE EXACT CONTRACT WP-10 MUST SATISFY, in code so it can be read from a test rather than from a
 * commit message. `tests/tier1/crypto-envelope.test.js` asserts each clause against a stand-in
 * projection, so the day `core/project.js` lands there is a specification to run it against.
 */
export const PROJECT_CONTRACT = Object.freeze({
  module: 'src/js/core/project.js',
  owner: 'WP-10',
  adr: 'ADR 004 §2, §2.2 barriers 1-4, §2.4',
  clauses: Object.freeze([
    'projectForFamily(kind, truth, level, lastPublished) returns the family field patch, or null.',
    'Every returned patch carries the brand Symbol.for("lzp/v2/family-patch") as a NON-ENUMERABLE, '
      + 'non-writable, non-configurable own property whose value is a frozen '
      + '{v:1, source:"projectForFamily", kind, level, fields}. `envelope.brandFamilyPatch` is the '
      + 'reference implementation; project.js may not import it (ADR 004 §2 forbids importing '
      + 'outside core/, ADR 005 §2 forbids core/ -> crypto/), so it must inline the four lines.',
    'brand.level is the level the projection ACTUALLY applied — never the caller\'s argument, '
      + 'once §2.2 barrier 4 has re-derived it.',
    'project.js also exports assertFamilyPatch(patch, kind, level), which throws RedactionError. '
      + 'The seal path INJECTS it as ctx.assertFamilyPatch; sealOp REFUSES to seal a family-space '
      + 'pub.set without it, so it can never be an optional check.',
    'The seal path injects ctx.levelOf(entityKey) -> "privat"|"belegt"|"geteilt"|null, read from '
      + 'the AUTHENTICATED register map (the folded pub.level of that entity), so sealOp can '
      + 're-derive the level rather than trust the caller (barrier 4).',
    'A patch whose brand.level disagrees with the re-derived level is REFUSED, not corrected: the '
      + 'disagreement means the projection and the register map are looking at different entities, '
      + 'and guessing which one is right is how a Belegt entry gets its text published.',
  ]),
});

/** Field names that must never appear in a family patch under any level (A3). */
const CATEGORY_SPELLINGS = Object.freeze(['categoryId', 'pub.categoryId', 'cat', 'pub.cat']);

/**
 * The backstop. Deliberately WEAKER than `assertFamilyPatch` and derived from a different source,
 * so the two can never disagree — only one can fail to catch what the other catches.
 *
 * `assertFamilyPatch` checks the patch against ADR 004's per-level allowlists
 * (`GETEILT_FIELDS` / `BELEGT_FIELDS`), which live in `project.js`. This function checks it against
 * `core/ops.js`'s `FIELDS`, which is a strict SUPERSET of both (it carries `pub.coEdit` and `_born`
 * at every level), plus the `geteiltOnly` marks that `FIELDS` already records for `pub.text` and
 * `pub.label`. Anything this refuses, `assertFamilyPatch` refuses too. Duplicating the allowlist
 * itself would be the mistake ADR 004 warns about — two answers to "may this field be published" is
 * one answer too many — so it is not duplicated.
 *
 * @param {Object} patch @param {'fnote'|'fbar'} kind @param {string} level
 */
function assertNoContentAboveLevel(patch, kind, level) {
  const spec = FIELDS[kind];
  for (const name of Object.keys(patch)) {
    if (CATEGORY_SPELLINGS.includes(name)) {
      throw new RedactionError(
        `sealOp: "${name}" would leak a category to the family space (A3, ADR 004 §2.1)`, 'backstop');
    }
    const f = spec[name];
    if (!f) {
      throw new RedactionError(
        `sealOp: "${name}" is not a ${kind} field — it may not be sealed under a family key`, 'backstop');
    }
    // §5's withdrawal escape: an explicit null CLEARS a previously published value and must pass at
    // every level, or a downgrade could never retract a shared text. It can never let a VALUE
    // through, which is the whole distinction.
    if (f.geteiltOnly && level !== 'geteilt' && patch[name] !== null) {
      throw new RedactionError(
        `sealOp: a ${level} payload carries content in "${name}" (INV-R1). Only an explicit null — ` +
        'a withdrawal — is permitted below geteilt.', 'backstop');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. sealOp  (ADR 002 §5.1, §5.3 · ADR 004 §2.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SealCtx
 * @property {(patch:Object, kind:string, level:string) => void} [assertFamilyPatch]
 *           ADR 004 §2.2 barrier 2, injected from `core/project.js`. REQUIRED for a family-space
 *           `pub.set`; its absence is a refusal, never a skip.
 * @property {(entityKey:string) => ('privat'|'belegt'|'geteilt'|null)} [levelOf]
 *           barrier 4 — the authenticated register map's current `pub.level` for that entity.
 * @property {DeviceAttestation} [attestation]
 *           OPTIONAL, and the outbox SHOULD pass it: this device's own attestation. When present,
 *           `sealOp` mirrors the WHOLE far-side gate against the op it is about to seal — P2,
 *           checks 3 and 5, and finally P3 itself, by verifying the signature it just made under
 *           `att.sigPubRaw`. So an op that no honest peer could ever open fails HERE, at authoring
 *           time, on the one machine that can still do something about it, instead of failing
 *           remotely, silently and permanently on every other Mac in the family.
 * @property {SubtleCrypto} [subtle]
 * @property {(n:number) => Uint8Array} [random]
 */

/**
 * Seal one op.
 *
 * The header is authenticated, not derived: the caller supplies `sp`, `ep`, `dv`, `oid` and `wit`,
 * and `sealOp` checks that they agree with the op it was handed rather than quietly rewriting
 * either. Three of §5.2.2's post-decrypt checks are mirrored here — `oid === op.id`,
 * `sp === op.space`, `devOf(op.ts) === dv` — because they are HARD FAILURES on the far side, so an
 * envelope that violates one is an envelope no honest peer will ever open. Catching that at seal
 * time turns a permanent, silent, remote data loss into a local exception.
 *
 * @param {Object} op the plaintext op (ADR 001 §2)
 * @param {KeyRing} keyring
 * @param {CryptoKey} sigPriv this device's `IK_sig` private key
 * @param {{v:1, sp:string, ep:number, dv:string, oid:string, wit:string}} hdr
 * @param {SealCtx} [ctx]
 * @returns {Promise<Object>} the Envelope
 */
export async function sealOp(op, keyring, sigPriv, hdr, ctx = {}) {
  assertHeader(hdr, 'sealOp');

  // ── minimal shape, so the redaction gate below can run first ────────────────
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    throw new EnvelopeError('sealOp: the op must be an object', 'shape');
  }
  if (op.f === null || typeof op.f !== 'object' || Array.isArray(op.f)) {
    throw new EnvelopeError('sealOp: op.f must be an object', 'shape');
  }

  // ── ADR 004 §2.4 — nothing leaves for a family space unprojected ────────────
  //
  // THIS RUNS BEFORE `validateOp`, DELIBERATELY. Both would refuse a patch carrying `categoryId`,
  // but only one of them says WHY: `validateOp` reports "unknown field on fnote", which is true and
  // useless, while the redaction gate reports "a category leaked to the family space (A3)". ADR 004
  // is the most security-critical document in this project and §2.3 requires its failure path to be
  // LOUD; a generic shape complaint shadowing it would be a quieter failure for the one class of
  // bug that must never be quiet.
  if (spaceClassOf(hdr.sp) === 'family' && op.k === 'pub.set') {
    assertProjected(op, ctx);
  }

  // ── the op must be one WE would accept ──────────────────────────────────────
  // We are the author. An op our own build would park or reject is a bug on this machine, and
  // sealing it would publish it to a family who cannot use it. `validateOp` is `core/ops.js`'s one
  // triage; using it here rather than a second opinion keeps seal and open on the same rules.
  const shape = validateOp(op);
  if (!shape.ok) {
    throw new EnvelopeError(
      `sealOp: refusing to seal an op this build would ${shape.park ? 'park' : 'reject'} — ${shape.reason}`,
      'shape');
  }

  // ── header ↔ plaintext agreement (§5.2.2 checks 1, 2 and 4, mirrored) ───────
  if (hdr.oid !== op.id) {
    throw new EnvelopeError(
      `sealOp: header oid ${JSON.stringify(hdr.oid)} !== op.id ${JSON.stringify(op.id)} — ` +
      'the outer idempotency key and the inner op id are one value (§5.2.2 check 1)', 'C1');
  }
  if (hdr.sp !== op.space) {
    throw new EnvelopeError(
      `sealOp: header sp ${JSON.stringify(hdr.sp)} !== op.space ${JSON.stringify(op.space)} ` +
      '(§5.2.2 check 2)', 'C2');
  }
  if (devOf(op.ts) !== hdr.dv) {
    throw new EnvelopeError(
      `sealOp: the stamp's device short ${JSON.stringify(devOf(op.ts))} !== header dv ` +
      `${JSON.stringify(hdr.dv)}. ADR 001 §6.2's proof that ≺ is a strict total order rests on ` +
      'two writes from different devices differing here (§5.2.2 check 4)', 'C4');
  }
  // Checks 3 and 5, when the caller gave us the attestation to check against.
  if (ctx.attestation) {
    const att = ctx.attestation;
    if (att.deviceId !== op.dev) {
      throw new EnvelopeError(
        `sealOp: op.dev ${JSON.stringify(op.dev)} !== this device's attested deviceId ` +
        `${JSON.stringify(att.deviceId)} (§5.2.2 check 3)`, 'C3');
    }
    if (att.memberId !== op.act) {
      throw new EnvelopeError(
        `sealOp: op.act ${JSON.stringify(op.act)} !== this device's attested memberId ` +
        `${JSON.stringify(att.memberId)} (§5.2.2 check 5)`, 'C5');
    }
    if (att.deviceShort !== hdr.dv) {
      throw new EnvelopeError(
        `sealOp: header dv ${JSON.stringify(hdr.dv)} !== this device's attested deviceShort ` +
        `${JSON.stringify(att.deviceShort)} — the far side resolves the key by dv (§5.2.2 P1/P2)`,
        'P2');
    }
  }

  // ── the key ────────────────────────────────────────────────────────────────
  const key = keyRingGet(keyring, hdr.sp, hdr.ep, 'sealOp');
  if (!key) {
    // NOT a park. Parking is an INBOUND concept — it means "come back to this when something
    // arrives". There is nothing to come back for here: we are being asked to author into an epoch
    // this device does not hold, which is a caller bug on this machine.
    throw new EnvelopeError(
      `sealOp: the key ring holds no key for ${hdr.sp} epoch ${hdr.ep}`, 'shape');
  }

  // ── seal ───────────────────────────────────────────────────────────────────
  const aad = aadOf(hdr);
  const plain = pad(canonicalBytes(op));
  const iv = randomOf(ctx)(AEAD.ivBytes);
  if (!(iv instanceof Uint8Array) || iv.length !== AEAD.ivBytes) {
    throw new EnvelopeError(`sealOp: the random port returned ${iv && iv.length} IV bytes`, 'shape');
  }

  const S = subtleOf(ctx);
  let ct;
  try {
    ct = new Uint8Array(await S.encrypt(aesgcm(iv, aad), key, plain));
  } catch (err) {
    // Rule 3 — a try/catch BOUNDARY, not an error name. Node and WebKit do not agree on the string.
    throw new EnvelopeError(`sealOp: AES-GCM encrypt failed (${describe(err)})`, 'aead');
  }

  const signed = assertSignable(concat(aad, iv, ct), 'sealOp');
  const sig = await signBytes(sigPriv, signed, ctx);

  // ── the last mirror: does the key we just signed with belong to the device we claimed to be? ──
  //
  // Only possible when the caller supplied the attestation, because a non-extractable `IK_sig`
  // private key cannot be compared to anything — but its PUBLIC half is in `att.sigPubRaw`, so one
  // verify answers the question. Without this, a device holding two identities (a restored member
  // mid-adoption, a test harness, a future multi-account build) could sign with the wrong half and
  // produce an envelope that fails P3 on every peer and nowhere else. That failure is remote,
  // silent, and permanent; this is one ECDSA verify, on the outbox path, and only when the outbox
  // asked for the check.
  if (ctx.attestation) {
    let pub;
    try {
      pub = await importSigPublic(ub64(ctx.attestation.sigPubRaw), ctx);
    } catch (err) {
      throw new EnvelopeError(
        `sealOp: this device's own attestation carries an unusable sigPubRaw (${describe(err)})`, 'P2');
    }
    if (!(await verifyBytes(pub, sig, signed, ctx))) {
      throw new EnvelopeError(
        'sealOp: the signature does not verify under this device\'s OWN attested public key — ' +
        'sigPriv and ctx.attestation are different identities. Every peer would fail P3 on this ' +
        'envelope and nowhere else would notice.', 'P3');
    }
  }

  // Exactly nine fields, in wire order, and no authoring time among them (§5.1, §11 rule 5).
  return {
    v: hdr.v,
    sp: hdr.sp,
    ep: hdr.ep,
    dv: hdr.dv,
    oid: hdr.oid,
    wit: hdr.wit,
    iv: b64u(iv),
    ct: b64u(ct),
    sig: b64u(sig),
  };
}

/** ADR 004 §2.2 barriers 3 and 4, and the backstop. Throws `RedactionError`. */
function assertProjected(op, ctx) {
  const entity = parseEntityKey(op.e);
  const kind = entity && entity.kind;
  if (kind !== 'fnote' && kind !== 'fbar') {
    throw new RedactionError(
      `sealOp: a family pub.set must address an fnote or an fbar, not ${JSON.stringify(op.e)}`, 'barrier3');
  }

  // BARRIER 3 — only a branded patch.
  const brand = familyPatchBrand(op.f);
  if (!brand) {
    throw new RedactionError(
      'sealOp: refusing an UNBRANDED family patch (ADR 004 §2.2 barrier 3). Plaintext leaves a ' +
      'device through exactly one function and that function is projectForFamily() — see ' +
      'PROJECT_CONTRACT in src/js/crypto/envelope.js for what src/js/core/project.js must do. ' +
      'Hand-building a pub.set patch is not a supported call.', 'barrier3');
  }
  if (brand.kind !== kind) {
    throw new RedactionError(
      `sealOp: the patch was projected as a ${brand.kind} but addresses a ${kind}`, 'barrier3');
  }

  // BARRIER 4 — re-derive the level from the AUTHENTICATED register map, never from the caller.
  if (typeof ctx.levelOf !== 'function') {
    throw new RedactionError(
      'sealOp: no ctx.levelOf — the level must be re-derived from the authenticated register map ' +
      '(ADR 004 §2.2 barrier 4), never taken from an argument. Injecting it is WP-10 / the outbox\'s ' +
      'obligation; see PROJECT_CONTRACT.', 'barrier4');
  }
  const declared = Object.prototype.hasOwnProperty.call(op.f, 'pub.level') ? op.f['pub.level'] : undefined;
  const folded = ctx.levelOf(op.e);
  const level = declared === undefined || declared === null ? folded : declared;
  if (!VISIBILITY_LEVELS.includes(level)) {
    throw new RedactionError(
      `sealOp: cannot re-derive a level for ${JSON.stringify(op.e)} — the patch declares ` +
      `${JSON.stringify(declared)} and the register map says ${JSON.stringify(folded)}`, 'barrier4');
  }
  if (level === 'privat') {
    // A Privat entry produces no family op at all (ADR 004 §1, 16.1). The one thing that legitimately
    // travels at `privat` is a WITHDRAWAL — explicit nulls at a newer stamp (§5.1, INV-R4) — and
    // that is exactly what the backstop below permits and a value does not.
    if (Object.keys(op.f).some((k) => k !== 'pub.level' && op.f[k] !== null)) {
      throw new RedactionError(
        'sealOp: a privat payload carries a value. A downgrade to privat writes explicit nulls and ' +
        'nothing else (ADR 004 §5.1, INV-R4).', 'barrier4');
    }
  }
  if (brand.level !== level) {
    throw new RedactionError(
      `sealOp: the projection applied level ${JSON.stringify(brand.level)} but the authenticated ` +
      `register map says ${JSON.stringify(level)}. Refusing rather than picking one — a guess here ` +
      'is how a Belegt entry gets its text published (ADR 004 §2.2 barrier 4).', 'barrier4');
  }

  // BARRIER 2 — project.js's own allowlist assertion. Injected, and REQUIRED: a security check that
  // is skipped when absent is not a security check.
  if (typeof ctx.assertFamilyPatch !== 'function') {
    throw new RedactionError(
      'sealOp: no ctx.assertFamilyPatch. ADR 004 §2.2 barrier 2 must run before anything is sealed, ' +
      'and src/js/core/project.js — which owns it — has not landed (WP-10). Until it does, a ' +
      'family-space pub.set cannot be sealed at all. See PROJECT_CONTRACT.', 'barrier2');
  }
  ctx.assertFamilyPatch(op.f, kind, level);

  // The backstop — always, independent of the injected assertion. Strictly weaker, differently
  // sourced, so it cannot disagree with the allowlist; only fail to catch what the allowlist does.
  assertNoContentAboveLevel(op.f, kind, level);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. openOp  (ADR 002 §5.2 — the gate and the five checks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} OpenedOp
 * @property {'opened'} status
 * @property {Object} op                                     the plaintext op
 * @property {DeviceAttestation} attestation  the device it came from
 */
/**
 * @typedef {Object} ParkedEnvelope
 * @property {'park'} status
 * @property {string} parkReason  one of `ENVELOPE_PARK`
 * @property {string} reason      a human sentence for the diagnostic pane
 */

/**
 * Open one envelope, or say why it must be parked.
 *
 * ═══ PRE-DECRYPT GATE, IN THIS ORDER, NO EXCEPTIONS (§5.2.2) ═══
 *
 *   P1  att = attestationOf(env.dv);  att === null  ⇒  PARK THE SEALED ENVELOPE, UNOPENED.
 *   P2  deviceShortOf(att.sigPubRaw) === env.dv
 *   P3  verify(sig, aad ‖ iv ‖ ct, att.sigPubRaw)          ← VERIFY BEFORE DECRYPT
 *   P4  the key ring holds epoch env.ep, else PARK
 *
 * **P1 CANNOT BE A POST-DECRYPT CHECK, and an earlier draft of §5.2 said it was.** The attestation
 * is the ONLY source of the verification key: with `att === null` there is no key to verify the
 * signature with and no reason to reach the AES path at all. So what gets parked is a SEALED
 * envelope that has never been decrypted, re-opened when the attesting `member.set{dev.*}` arrives
 * — the same shape §4.4's unknown-epoch park already requires of the inbox.
 *
 * **`att === null` HAS TWO CAUSES AND BOTH ARE PARKS.** Absent (first contact, a partial pull —
 * there is no causal delivery in this system) and CONTESTED (§2.3 "Two shorts, no winner": the fold
 * refuses to resolve a short claimed twice, rather than handing a backdated squatter the lookup and
 * therefore handing this function the squatter's verification key). `openOp` MUST NOT distinguish
 * them: both mean *this envelope cannot be resolved to a device right now*, both are re-evaluable,
 * and turning either into a rejection is the same silent data loss. A caller that wants to REPORT
 * the difference reads `AuthzResult.shortCollisions`.
 *
 * ⚠ **I-3 / R5-7 IS OPEN, AND THIS FUNCTION IS ITS BLAST RADIUS.** A squatter who files a
 * well-formed attestation under a peer's `deviceShort` makes `attestationOf` return `null` for that
 * short for ever — `dev.*` is write-once, there is no revocation anywhere in the fold, and the short
 * is the last 16 characters of every stamp that device has ever written, so it is trivially
 * discoverable. Every sealed envelope from that Mac then parks, permanently. `openOp` treats
 * `attestationOf` as a **PARTIAL FUNCTION** and parks, exactly as §5.2.1's amendment says; it does
 * NOT assume P2 restores liveness on a squatted short, because `sigPubRaw` is a public key
 * travelling in the victim's own register and the squatter can copy it and tell the truth about it
 * (round 5, R5-7c). Closing this needs FINDINGS §4.5 option (a) — first-claim binding on the PAIR
 * `(sigPubRaw, deviceShort)` at fold time — which is `src/js/core/authz.js`'s decision. Nothing at
 * this seam closes it and nothing built on this seam may pretend otherwise.
 *
 * ═══ POST-DECRYPT — ALL FIVE, EVERY ONE A THROW (§5.2.2) ═══
 *
 *   1  op.id        === env.oid          envelope splicing
 *   2  op.space     === env.sp           cross-space replay
 *   3  att.deviceId === op.dev           an authenticated header over a body naming another device
 *   4  devOf(op.ts) === env.dv           ← NOT OPTIONAL; see below
 *   5  att.memberId === op.act           attribution — 17.6 renders this as „von Mama"
 *
 * **Check 4 is the one a reader is tempted to drop.** ADR 001 §6.2's proof that `≺` is a strict
 * total order rests on "two writes from different devices differ in `deviceShort`". A device that
 * stamped its ops with a peer's short would break that premise. Convergence itself survives — the
 * register join falls through to `opId` and then to the canonical value — but merge outcomes would
 * silently stop being ATTRIBUTABLE, and the honest fix is one string comparison here rather than an
 * argument later. It is also the only T5 gap the lookup reading otherwise leaves open: forging a
 * peer's short inside one's own stamps.
 *
 * **THERE IS NO REVOCATION INPUT HERE, AND INVENTING ONE IS NOT THIS SEAM'S JOB.** ADR 002 §2.3
 * "Revocation — the gap, and who owns it" (owner: WP-9): `dev.*` registers are write-once, so an
 * attestation cannot be amended or withdrawn; a stolen laptop stays attested and stays admitted
 * until the epoch bump stops wrapping keys to it, which is a key-DISTRIBUTION measure and not an
 * admissibility one. `openOp` has no `revokedAt` to compare against and does not pretend to.
 *
 * @param {Object} env the Envelope
 * @param {KeyRing} keyring
 * @param {(dv:string) => (DeviceAttestation|null)} attestationOf
 *        `AuthzResult.attestationOf` (`src/js/core/authz.js`), keyed by `deviceShort` ALONE
 * @param {{subtle?:SubtleCrypto}} [ports]
 * @returns {Promise<OpenedOp|ParkedEnvelope>}
 * @throws {EnvelopeError} on a protocol violation. Never on a park.
 */
export async function openOp(env, keyring, attestationOf, ports = {}) {
  // ── shape ──────────────────────────────────────────────────────────────────
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw new EnvelopeError('openOp: the envelope must be an object', 'shape');
  }
  if (env.v !== ENVELOPE_V) {
    // "Versioning, not negotiation" (§1). A client that meets a `v` it does not know PARKS the op
    // and reports a protocol error. There is no downgrade surface to walk down.
    if (Number.isSafeInteger(env.v) && env.v > 0) {
      return park(ENVELOPE_PARK.VERSION, `envelope version ${env.v} is not ${ENVELOPE_V}`);
    }
    throw new EnvelopeError(`openOp: envelope v must be ${ENVELOPE_V}, got ${JSON.stringify(env.v)}`, 'shape');
  }
  assertHeader(env, 'openOp');
  const iv = decodeB64u(env.iv, 'iv');
  if (iv.length !== AEAD.ivBytes) {
    throw new EnvelopeError(`openOp: iv must be ${AEAD.ivBytes} bytes, got ${iv.length}`, 'shape');
  }
  const ct = decodeB64u(env.ct, 'ct');
  if (ct.length === 0) throw new EnvelopeError('openOp: ct is empty', 'shape');
  const sig = decodeB64u(env.sig, 'sig');
  if (sig.length === 0) throw new EnvelopeError('openOp: sig is empty', 'shape');

  // ── P1 — resolve the device. NULL IS A PARK, NEVER A REJECTION. ────────────
  if (typeof attestationOf !== 'function') {
    throw new EnvelopeError(
      'openOp: attestationOf is required — it is AuthzResult.attestationOf, and it is the only ' +
      'source of the verification key (ADR 002 §5.2.1 correction 1)', 'shape');
  }
  const att = attestationOf(env.dv);
  if (att === null || att === undefined) {
    return park(
      ENVELOPE_PARK.ATTESTATION,
      `no attestation resolves deviceShort ${env.dv} — it has not arrived yet, or the short is ` +
      'contested (ADR 002 §2.3, §5.2.5). The sealed envelope is retained, unopened.');
  }

  // ── P2 — the short is self-certifying (ADR 001 §1.2) ───────────────────────
  // This is the ONLY place `att.deviceShort` is ever bound to `att.sigPubRaw`. The authorization
  // fold cannot check it: it is pure and synchronous and the binding is a SHA-256.
  if (deviceShortOfB64u(att.sigPubRaw) !== env.dv) {
    throw new EnvelopeError(
      `openOp: P2 failed — crock32(SHA-256(att.sigPubRaw)[0..10]) is not ${env.dv}. The attestation ` +
      'resolved for this envelope does not certify the short it was filed under.', 'P2');
  }
  // Belt and braces: the payload's own `deviceShort` must agree too, or the object we are about to
  // read `deviceId` and `memberId` off is not internally consistent.
  if (att.deviceShort !== env.dv) {
    throw new EnvelopeError(
      `openOp: P2 failed — att.deviceShort ${JSON.stringify(att.deviceShort)} !== env.dv ` +
      `${JSON.stringify(env.dv)}`, 'P2');
  }

  // ── P3 — VERIFY BEFORE DECRYPT. A failed signature never reaches the AES path. ──
  const aad = aadOf(env);
  const signed = assertSignable(concat(aad, iv, ct), 'openOp');
  let sigPub;
  try {
    sigPub = await importSigPublic(ub64(att.sigPubRaw), ports);
  } catch (err) {
    // P2 already proved this decodes to a 65-byte value; a failure here means the bytes are not a
    // valid P-256 point (both engines raise `DataError`, which we do not read — rule 3).
    throw new EnvelopeError(
      `openOp: P3 failed — att.sigPubRaw is not an importable P-256 public key (${describe(err)})`, 'P3');
  }
  if (!(await verifyBytes(sigPub, sig, signed, ports))) {
    throw new EnvelopeError(
      `openOp: P3 failed — the signature does not verify under the key named by dv ${env.dv}. ` +
      'The AAD binds v, sp, ep, dv, oid and wit, so this is also what a re-attributed, ' +
      'epoch-relabelled or spliced envelope looks like (§5.1).', 'P3');
  }

  // ── P4 — the epoch key. A miss is a PARK (§4.4), not an error. ─────────────
  const key = keyRingGet(keyring, env.sp, env.ep, 'openOp');
  if (!key) {
    return park(
      ENVELOPE_PARK.EPOCH,
      `the key ring holds no key for ${env.sp} epoch ${env.ep}. A member offline across three ` +
      'rotations needs every epoch spanning the ops they have not read (ADR 002 §4.4).');
  }

  // ── decrypt ────────────────────────────────────────────────────────────────
  let padded;
  try {
    padded = new Uint8Array(await subtleOf(ports).decrypt(aesgcm(iv, aad), key, ct));
  } catch (err) {
    // Rule 3. Node and WebKit both raise here for a wrong key, a tampered tag and a mismatched AAD,
    // with names that are not the same string in the two engines. The BOUNDARY is the answer.
    throw new EnvelopeError(
      `openOp: AES-GCM decrypt failed for ${env.sp} epoch ${env.ep} (${describe(err)}). There is no ` +
      '"wrong key, right ciphertext" degradation path — a personal envelope replayed into the ' +
      'family stream fails exactly here (ADR 002 §3 barrier 3).', 'aead');
  }

  // ── unpad, decode, and refuse a non-canonical plaintext ────────────────────
  const body = unpad(padded);
  let text;
  try {
    text = utf8Decode(body);
  } catch (err) {
    throw new EnvelopeError(`openOp: the plaintext is not valid UTF-8 (${describe(err)})`, 'canonical');
  }
  let op;
  try {
    op = JSON.parse(text);
  } catch (err) {
    throw new EnvelopeError(`openOp: the plaintext is not JSON (${describe(err)})`, 'canonical');
  }
  // §5.3 spells the plaintext as `utf8(canonicalJSON(op))`, so a plaintext that is NOT canonical is
  // a protocol violation — and refusing it closes a covert channel the GCM tag cannot see: key
  // order and insignificant whitespace are chosen by the AUTHOR, who in T5 is a family member, and
  // they survive re-serialisation on every honest client's disk.
  let recanonical;
  try {
    recanonical = canonicalJSON(op);
  } catch (err) {
    throw new EnvelopeError(`openOp: the plaintext has no canonical form (${describe(err)})`, 'canonical');
  }
  if (recanonical !== text) {
    throw new EnvelopeError(
      'openOp: the plaintext is not canonical JSON (ADR 002 §5.3). Key order and whitespace are ' +
      'author-chosen and survive the GCM tag; they are not a place to carry data.', 'canonical');
  }

  // ── the five identity checks. ALL FIVE. EVERY ONE A THROW. ─────────────────
  // They run BEFORE the shape triage below, so an op that is later PARKED for version skew has
  // still had its identity bound — otherwise unparking after an app update would apply an op
  // whose attribution was never checked.
  if (op === null || typeof op !== 'object' || Array.isArray(op)) {
    throw new EnvelopeError('openOp: the plaintext is not an op object', 'shape');
  }
  if (!isStamp(op.ts)) {
    throw new EnvelopeError(`openOp: op.ts is not a 37-char stamp — check 4 cannot run`, 'C4');
  }
  if (!isOpId(op.id)) throw new EnvelopeError('openOp: op.id is not an opId — check 1 cannot run', 'C1');
  if (!isMemberId(op.act)) throw new EnvelopeError('openOp: op.act is not a MemberId — check 5 cannot run', 'C5');
  if (!isDeviceId(op.dev)) throw new EnvelopeError('openOp: op.dev is not a DeviceId — check 3 cannot run', 'C3');

  if (op.id !== env.oid) {
    throw new EnvelopeError(
      `openOp: check 1 failed — op.id ${JSON.stringify(op.id)} !== env.oid ${JSON.stringify(env.oid)}. ` +
      'This is envelope splicing: one op made to look like two, or a delete suppressed by ' +
      'colliding its id.', 'C1');
  }
  if (op.space !== env.sp) {
    throw new EnvelopeError(
      `openOp: check 2 failed — op.space ${JSON.stringify(op.space)} !== env.sp ` +
      `${JSON.stringify(env.sp)}`, 'C2');
  }
  if (att.deviceId !== op.dev) {
    throw new EnvelopeError(
      `openOp: check 3 failed — att.deviceId ${JSON.stringify(att.deviceId)} !== op.dev ` +
      `${JSON.stringify(op.dev)}. A valid signer sealed an authenticated header over a body naming ` +
      'a different device.', 'C3');
  }
  if (devOf(op.ts) !== env.dv) {
    throw new EnvelopeError(
      `openOp: check 4 failed — the stamp's device short ${JSON.stringify(devOf(op.ts))} !== env.dv ` +
      `${JSON.stringify(env.dv)}. ADR 001 §6.2's strict total order rests on two writes from ` +
      'different devices differing here; a device stamping with a peer\'s short makes merge ' +
      'outcomes unattributable.', 'C4');
  }
  if (att.memberId !== op.act) {
    throw new EnvelopeError(
      `openOp: check 5 failed — att.memberId ${JSON.stringify(att.memberId)} !== op.act ` +
      `${JSON.stringify(op.act)}. 17.6 renders op.act directly as „von Mama"; attribution is a ` +
      'trust surface.', 'C5');
  }

  // ── shape triage (§5.2.5's last paragraph) ─────────────────────────────────
  // "openOp rejects a field whose VALUE fails its declared type check in FIELDS (a protocol
  //  violation), while an unknown KIND or an unknown FIELD NAME is parked."
  // `core/ops.js`'s `validateOp` is exactly that split, and using it rather than a second opinion
  // keeps seal, open and the fold on one set of rules.
  const shape = validateOp(op);
  if (!shape.ok) {
    if (shape.park) return park(shape.parkReason, shape.reason, shape.fields);
    throw new EnvelopeError(`openOp: ${shape.reason}`, 'shape');
  }
  // A LOCAL op — `pref.set`, the only one — can never reach this line, and the reason is worth
  // writing down rather than guarding twice. `assertHeader` has already required `env.sp` to be a
  // real SpaceId (so `'local'` is refused at the door), check 2 has already required
  // `op.space === env.sp`, and `validateOp` refuses a kind whose declared space class does not
  // match `op.space`. Three independent checks, none of them here, and adding a fourth that can
  // never fire would suggest a hazard this seam actually faces.

  return Object.freeze({ status: 'opened', op, attestation: att });
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Small shared parts
// ─────────────────────────────────────────────────────────────────────────────

function park(parkReason, reason, fields) {
  const out = { status: 'park', parkReason, reason };
  if (fields) out.fields = Object.freeze([...fields]);
  return Object.freeze(out);
}

/** `keyring.get(space, epoch)` with a clear message when the caller passed the wrong shape. */
function keyRingGet(keyring, space, epoch, who) {
  if (!keyring || typeof keyring.get !== 'function') {
    throw new EnvelopeError(`${who}: a KeyRing with a synchronous get(space, epoch) is required`, 'shape');
  }
  const k = keyring.get(space, epoch);
  if (k && typeof k.then === 'function') {
    throw new EnvelopeError(
      `${who}: KeyRing.get must be SYNCHRONOUS — the contract types it as returning CryptoKey|null`,
      'shape');
  }
  return k || null;
}

/** @param {string} s @param {string} field @returns {Uint8Array} */
function decodeB64u(s, field) {
  try {
    return ub64(s);
  } catch (err) {
    if (err instanceof CodecError) {
      throw new EnvelopeError(`openOp: ${field} is not base64url — ${err.message}`, 'shape');
    }
    throw err;
  }
}

/** @param {...Uint8Array} parts @returns {Uint8Array} */
function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * A short, engine-neutral description of a caught error, for a message.
 *
 * RULE 3 lives here as much as anywhere: this function is what lets every catch site say something
 * useful WITHOUT any code branching on the result. Node says `InvalidAccessException` where WebKit
 * says `InvalidAccessError`; both strings may appear in a diagnostic, and neither may appear in an
 * `if`. Nothing in this file compares the return value to anything.
 */
function describe(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
