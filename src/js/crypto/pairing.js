// src/js/crypto/pairing.js — device pairing.  LZP-306 · story 19.5 · ADR 002 §6.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2). No transport lives here: the relay, the
// polling, the screens and the German are LZP-503's (WP-8). What lives here is the PROTOCOL, as
// a pure state machine over injected ports — `subtle`, `random` and `now`. There is deliberately
// no default clock: a session that cannot measure 180 seconds cannot enforce the TTL, and a
// silent `Date.now()` here would also break `tests/tier1/core-purity.test.js`.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE THREAT MODEL, IN THE CODE — ADR 002 §0 T4 and §6.1
// ═════════════════════════════════════════════════════════════════════════════
//
// THE RELAY IS THE ADVERSARY. It may read, modify, drop, replay and reorder every message, and
// it may run the protocol with both sides at once. Physical access to an unlocked Mac and
// shoulder-surfing of the pairing screen are out of scope (§6.1).
//
// THE SAS IS THE DEFENCE. NOT THE CODE. §0's T4 row says so in one line and §6.4 spends a
// paragraph on it, so it is worth being blunt about WHY, because the reason is not obvious:
//
//   * A relay that does NOT know the code can do nothing at all. `ck` is derived from the whole
//     60-bit code, both boxes are sealed under it, and the ephemeral public keys are INSIDE the
//     boxes. So the relay cannot substitute an ephemeral key without breaking AES-GCM. Its only
//     move is to corrupt or drop, which fails closed and burns an attempt.
//   * A relay that DOES know the code — shoulder-surfed, leaked over the channel the code was
//     read out on, or recovered by the 2^60 offline attack §6.4 prices at months — can seal its
//     own boxes and substitute its own ephemeral keys toward each side. Then, and only then, is
//     it a real MITM.
//   * Even then it does not win, because A and B now agree keys with the RELAY and not with each
//     other. Their ECDH shared secrets differ, so their six-digit SAS values differ, and the
//     human comparing two screens on one desk sees two different numbers. The attacker's chance
//     collapses to 10^-6 per attempt with NO offline path: it must commit to a guess before the
//     human looks.
//
// So the honest statement of what this module buys is: **the SAS is the defence that survives
// total compromise of the pairing code.** The code's 60 bits buy the online-guessing margin;
// the SAS buys everything else. That is why `confirmSasMatch()` exists, why it takes exactly
// `true` and has no default, and why `deliver()` and `receive()` refuse without it.
//
//   ⚠ A downstream agent who "simplifies" pairing by auto-confirming when the boxes decrypt has
//   removed the only MITM defence in the product (ADR 002 §6.4's boxed warning). Decryption
//   succeeding proves the peer knows the CODE. It proves nothing whatsoever about who the peer
//   is — and in the one scenario that matters, the attacker knows the code by assumption.
//   `tests/tier1/crypto-pairing.test.js` asserts BOTH halves of that: that an honest run
//   refuses, and that a forced auto-confirm hands the relay every key. The second test is there
//   so nobody can call this check decorative.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE NUMBERS (ADR 002 §6.2), WRITTEN DOWN AND EXPORTED
// ═════════════════════════════════════════════════════════════════════════════
//
//   pairing code   12 Crockford base32 characters = 60 bits, shown XXXX-XXXX-XXXX
//   rid            b64u(HKDF(code, '', 'lzp/v2/pair/rid', 16)) — from the WHOLE code, so the
//                  relay's offline work factor is 2^60 and not 2^40
//   TTL            180 s, single use
//   attempts       5 failed opens per rid, then the rendezvous is burned
//                  20 `pair/get` per IP per hour (ADR 002 §6.2)
//                  ADR 003 §6.1 adds: 10 pair sessions per member per hour, and 5 failed rid
//                  lookups per IP per minute. See `PAIRING` below — the two ADRs count
//                  different things and both numbers are carried.
//   SAS            6 decimal digits, shown on BOTH devices, confirmed on BOTH
//
// ═════════════════════════════════════════════════════════════════════════════
// THE SEVEN ENGINE-DIFFERENCE RULES (ADR 002 §1) AS THEY BITE HERE
// ═════════════════════════════════════════════════════════════════════════════
//   1  no signature bytes are compared — this module signs nothing at all
//   2  no zero-length payload is ever encrypted: every plaintext is `canonicalBytes(object)`
//   3  no branch on an error NAME. `openPairBox` returns `null` from a try/catch BOUNDARY; a
//      wrong code and a tampered box are the same GCM failure and must stay indistinguishable
//   4  every `hkdf()` call passes a salt positionally — `NO_SALT` for §6.3's `HKDF(C, '', …)`
//   5  a peer's ephemeral ECDH public key is imported through `importKexPublic`, `keyUsages: []`
//   6  nothing is AES-KW'd. The delivered recovery PKCS#8 is 138 bytes and travels inside one
//      AES-GCM box, which is rule 6's whole point
//   7  no `isSecureContext`, no database: this file is a state machine and a pile of derivations
//   9  the restored `RK_sig` / `RK_kex` private halves are imported with `USAGES.sigPrivate` /
//      `USAGES.kexPrivate` — the private usages ONLY. This is the restore path, which is exactly
//      where engine difference 9 bites and where a developer looks last.

import { b64u, ub64, CodecError, CROCKFORD_ALPHABET, crockNormalize } from '../core/b64.js';
import { canonicalBytes, utf8, utf8Decode } from '../core/canon.js';
import { deviceId as mintDeviceId, defaultRandom, isDeviceShort } from '../core/ids.js';
import {
  KEX,
  USAGES,
  AEAD,
  INFO,
  PAD_BUCKET,
  RAW_PUBKEY_BYTES,
  PKCS8_P256_BYTES,
  SYMMETRIC_KEY_BYTES,
  DEVICE_KEY_EXTRACTABLE,
  RECOVERY_KEY_EXTRACTABLE,
  SIG,
  hkdf,
  NO_SALT,
  aesgcm,
} from './suite.js';
import { pad, unpad } from './envelope.js';
import { isSpaceId } from './spacekeys.js';
import {
  generateDeviceKeys,
  exportRawPublic,
  importKexPublic,
  deviceShortOf,
  buildDeviceAttestation,
  attestDevice,
  KEYSTORE_IDS,
} from './identity.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Parameters — ADR 002 §6.2, plus ADR 003 §6.1's server-side counterparts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The pairing constants, exported so the UI (LZP-503) and the relay (WP-7) read the same numbers
 * this module enforces, rather than each re-typing them from the ADR.
 *
 * ⚠ THE TWO ADRs COUNT DIFFERENT THINGS AND BOTH COUNTS ARE HERE.
 *   ADR 002 §6.2  "5 failed decrypts per `rid`, then the rendezvous is burned" — a property of
 *                 the PAIRING SESSION. The relay cannot observe a failed decrypt (it holds no
 *                 key), so this counter is necessarily client-reported: the new device tells the
 *                 relay "that did not open" and the relay burns the rendezvous on the fifth.
 *                 `maxFailedOpens` is what this module counts locally.
 *   ADR 002 §6.2  "20 `pair/get` per IP per hour" — a property of the RELAY.
 *   ADR 003 §6.1  "10 pair sessions per member per hour; 5 failed `rid` lookups per IP per
 *                 minute" — also the relay, a per-minute burst limit rather than an hourly cap.
 * They are not in conflict, but they are not the same number either, and a reader who saw only
 * one would implement the wrong limiter. Both are carried; WP-7 owns reconciling them into one
 * `RateBucket` policy.
 */
export const PAIRING = Object.freeze({
  /** 12 Crockford characters. Crockford already excludes I, L, O and U. */
  codeChars: 12,
  /** 12 * log2(32) — the number §6.4's "2^60" refers to. */
  codeBits: 60,
  /** Displayed XXXX-XXXX-XXXX. */
  codeGroup: 4,
  /** §6.2. Single use. */
  ttlSeconds: 180,
  /** The same TTL in the unit `ports.now()` returns. */
  ttlMs: 180 * 1000,
  /** §6.2 — failed opens per rid, counted by the session, enforced by the relay's burn. */
  maxFailedOpens: 5,
  /** §6.2 — relay-side, per IP. */
  relayGetPerIpPerHour: 20,
  /** ADR 003 §6.1 — relay-side, per member. */
  sessionsPerMemberPerHour: 10,
  /** ADR 003 §6.1 — relay-side burst limit on lookups of a rid that does not exist. */
  failedRidLookupsPerIpPerMinute: 5,
  /** §6.2 — the short authentication string. Six decimal digits, on BOTH screens. */
  sasDigits: 6,
  /** …derived from this many HKDF output bytes (§6.3 step 6). */
  sasBytes: 4,
  /** §6.2. A rendezvous is consumed once and never re-run. */
  singleUse: true,
});

/** The pairing wire version. There is NO negotiation surface (ADR 002 §1): a peer that offers a
 *  different `v` is refused, not accommodated. It lives in the AAD, so it cannot be edited in
 *  flight without breaking the GCM tag. */
export const PAIR_V = 1;

/** The three message types. The type is bound by the AAD and NEVER carried on the wire, so a
 *  relay cannot re-label an offer as an answer: the receiver reconstructs the AAD from what it
 *  EXPECTS, and a mismatch is an ordinary GCM failure. */
export const PAIR_MSG = Object.freeze({ offer: 'offer', answer: 'answer', deliver: 'deliver' });

/** The AAD domain tag. `aesgcm()` refuses an empty AAD (rule 2 / §5.1); this is never empty. */
export const PAIR_AAD_TAG = 'lzp/v2/pair';

/** The states a session can be in. Every terminal state means NO KEY TRANSFER, permanently. */
export const PAIR_STATE = Object.freeze({
  init: 'init',
  offered: 'offered',     // A has published box_A
  answered: 'answered',   // B has produced box_B / A has opened it
  sas: 'sas',             // the six digits are computed and on screen — awaiting the human
  confirmed: 'confirmed', // the human said the two screens matched
  delivered: 'delivered', // A has sealed the key transfer                      (terminal, ok)
  received: 'received',   // B has opened it                                    (terminal, ok)
  refused: 'refused',     // the human said the screens DIFFERED                (terminal)
  expired: 'expired',     // the 180 s TTL ran out                              (terminal)
  burned: 'burned',       // five failed opens                                  (terminal)
  failed: 'failed',       // a protocol violation: bad state, bad role, bad box (terminal)
});

const TERMINAL = new Set(['delivered', 'received', 'refused', 'expired', 'burned', 'failed']);

/**
 * A pairing failure with a MACHINE-READABLE `code`.
 *
 * Rule 3 forbids branching on an ENGINE's error name, because Node and WebKit disagree about
 * them. It does not forbid us from having our own vocabulary — having one is the alternative
 * rule 3 asks for. Every `PairingError.code` below is chosen by this file and is stable.
 */
export class PairingError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'PairingError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new PairingError(code, message);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Ports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PairPorts
 * @property {SubtleCrypto} [subtle] defaults to the platform SubtleCrypto
 * @property {(n:number) => Uint8Array} [random] defaults to `crypto.getRandomValues`
 * @property {() => number} [now] epoch milliseconds. REQUIRED by `createPairingSession` — see
 *           the file header. Nothing under `src/js/crypto/` may read a clock.
 */

function subtleOf(ports) {
  const s = (ports && ports.subtle) || globalThis.crypto?.subtle;
  if (!s) {
    throw new PairingError(
      'no_subtle',
      'pairing: no SubtleCrypto. Pairing must be gated on probeCrypto() — src/js/crypto/probe.js.'
    );
  }
  return s;
}

const randomOf = (ports) => (ports && ports.random) || defaultRandom;

// ─────────────────────────────────────────────────────────────────────────────
// 2. The pairing code
//
// 60 bits, and they are 60 bits of CHARACTER, not of decoded bytes. That distinction is the one
// trap in this section and it is worth spelling out, because getting it wrong silently costs
// four bits and would make every `rid` in the product derived from 56:
//
//   `uncrock32` of a 12-character code yields floor(12*5/8) = 7 BYTES = 56 bits, and rejects
//   any code whose four spare bits are non-zero — which is 15 codes in 16. So the code is NOT
//   decoded before derivation. The HKDF input keying material is the UTF-8 of the NORMALISED
//   12-character upper-case string, which carries all 60 bits and makes the normalisation
//   (separators stripped, case folded, I/L -> 1, O -> 0) visibly part of the derivation.
//
// ADR 002 §6.3 writes `HKDF(C, …)` without saying which spelling of C, so this is a resolution,
// not a reading. It is recorded here because it is a wire-format decision: the two spellings
// derive different `rid`s and different `ck`s, and the symptom of disagreeing about it is
// "the code is wrong" on a correctly typed code.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 12 Crockford base32 characters = exactly 60 uniform bits.
 *
 * Each character is one random byte masked to 5 bits. 256 is a multiple of 32, so `b & 31` is
 * exactly uniform over the alphabet — no modulo bias, no rejection loop.
 *
 * @param {(n:number) => Uint8Array} [random]
 * @returns {string} 12 characters, no separators
 */
export function generatePairingCode(random = defaultRandom) {
  const bytes = random(PAIRING.codeChars);
  if (!(bytes instanceof Uint8Array) || bytes.length !== PAIRING.codeChars) {
    throw new PairingError('random', 'generatePairingCode: the random port must return the requested length');
  }
  let out = '';
  for (let i = 0; i < PAIRING.codeChars; i++) out += CROCKFORD_ALPHABET[bytes[i] & 31];
  return out;
}

/** `XXXX-XXXX-XXXX` for the screen. Display only — never an input to a derivation.
 *  @param {string} code @returns {string} */
export function formatPairingCode(code) {
  const c = normalizePairingCode(code);
  const g = PAIRING.codeGroup;
  return `${c.slice(0, g)}-${c.slice(g, 2 * g)}-${c.slice(2 * g)}`;
}

/**
 * Fold what a human typed into the one canonical spelling, or refuse it.
 *
 * `crockNormalize` (core/b64.js) strips `-`, space, non-breaking space and tab, upper-cases, and
 * maps I/i/L/l -> 1 and O/o -> 0. It deliberately does NOT map `U`: Crockford reserves it, so a
 * `U` in a code is an error and not a typo we may guess at. A wrong guess here would derive a
 * different `rid` and present as "the code is wrong" on a code the user typed correctly.
 *
 * @param {string} input @returns {string} 12 canonical characters
 * @throws {PairingError} code `'code_invalid'`
 */
export function normalizePairingCode(input) {
  if (typeof input !== 'string') fail('code_invalid', 'pairing code: expected a string');
  let c;
  try {
    c = crockNormalize(input);
  } catch (err) {
    if (err instanceof CodecError) return fail('code_invalid', 'pairing code: not text');
    throw err;
  }
  if (c.length !== PAIRING.codeChars) {
    fail('code_invalid', `pairing code: expected ${PAIRING.codeChars} characters, got ${c.length}`);
  }
  for (const ch of c) {
    if (!CROCKFORD_ALPHABET.includes(ch)) {
      fail('code_invalid', 'pairing code: contains a character Crockford base32 does not use');
    }
  }
  return c;
}

/**
 * `rid` and `ck`, both from the WHOLE code (§6.2): an offline attack on `rid` therefore costs
 * the full 2^60 rather than the 2^40 a prefix-derived rid would cost.
 *
 * RULE 4: §6.3 writes `HKDF(C, '', …)`. `''` means "no salt", and rule 4 says an omitted salt is
 * a `TypeError` in both engines — so `NO_SALT` is passed explicitly, which is what the rule asks
 * for and what makes the intent reviewable.
 *
 * @param {string} code @param {PairPorts} [ports]
 * @returns {Promise<{rid:string, ck:CryptoKey}>}
 */
export async function derivePairing(code, ports) {
  const S = subtleOf(ports);
  const canonical = normalizePairingCode(code);
  const ikm = await S.importKey('raw', utf8(canonical), 'HKDF', false, [...USAGES.derive]);
  const ridBits = new Uint8Array(await S.deriveBits(hkdf(NO_SALT, INFO.pairRid), ikm, 16 * 8));
  const ck = await S.deriveKey(
    hkdf(NO_SALT, INFO.pairCk),
    ikm,
    { name: AEAD.name, length: AEAD.length },
    false,
    [...USAGES.aead]
  );
  return { rid: b64u(ridBits), ck };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The boxes
//
// A pairing message is `b64u(iv) '.' b64u(ct)` — the same dotted two-part shape the attestation
// blob uses, so the repository has one spelling of "two byte strings on a wire".
//
// THE AAD IS WHERE THE PROTOCOL'S STRUCTURE LIVES, AND IT IS NOT TRANSMITTED.
//
//   aad = utf8(canonicalJSON(['lzp/v2/pair', PAIR_V, type, rid]))
//
// ADR 002 §6.3 does not specify an AAD for the pairing boxes; §5.1 mandates a non-empty AAD for
// every AES-GCM use in the product and `suite.aesgcm()` refuses an empty one, so one had to be
// chosen. This is the choice, and each of the four elements buys something:
//
//   'lzp/v2/pair'  domain separation from the op envelope's AAD (§5.1). A pairing box can never
//                  be replayed into the op stream, or an envelope into a pairing slot.
//   PAIR_V         a version bump is a hard refusal, not a negotiation (§1). Because the AAD is
//                  reconstructed by the RECEIVER and never read off the wire, a relay cannot
//                  claim a lower version to get a weaker path — there is no weaker path to get.
//   type           the offer/answer/deliver slot. This is what makes the classic replay —
//                  feeding box_A back as box_B — an ordinary GCM failure rather than a subtle
//                  logic bug. The receiver builds the AAD from the slot it is READING.
//   rid            binds the message to THIS rendezvous, so a box captured from one pairing
//                  session cannot be replayed into another even if the same relay serves both.
//
// The plaintext is padded with §5.3's construction — `varint(len) || canonicalJSON(obj) ||
// zeros`, to a multiple of `PAD_BUCKET`. §5.3 is written for op envelopes, but the reason applies
// here verbatim: without it the DELIVERY's length tells the relay how many epoch keys a member
// holds and whether they are in a Familienkreis at all, which is exactly the §8.7 social graph
// the padding exists to blunt.
//
// `pad`/`unpad` are IMPORTED from LZP-304's `envelope.js` rather than re-implemented, because two
// spellings of one wire construction is how a wire construction stops being one. Its `unpad` is
// also strictly better than a local copy would have been: it refuses a non-minimal varint and
// refuses any non-zero trailing byte, which closes a covert channel an author-side attacker could
// otherwise write into the padding. That argument transfers to pairing unchanged — the party who
// chooses this plaintext is the party being trusted.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} type one of `PAIR_MSG`
 * @param {string} rid
 * @returns {Uint8Array} never empty
 */
export function pairAad(type, rid) {
  if (!Object.prototype.hasOwnProperty.call(PAIR_MSG, type)) {
    fail('protocol', `pairAad: ${JSON.stringify(type)} is not a pairing message type`);
  }
  if (typeof rid !== 'string' || rid.length === 0) fail('protocol', 'pairAad: rid is required');
  return canonicalBytes([PAIR_AAD_TAG, PAIR_V, type, rid]);
}

/**
 * Seal one pairing message.
 * @param {CryptoKey} key `ck` for offer/answer, the `kek` for deliver
 * @param {string} type @param {string} rid @param {Object} obj @param {PairPorts} [ports]
 * @returns {Promise<string>} `b64u(iv) + '.' + b64u(ct)`
 */
export async function sealPairBox(key, type, rid, obj, ports) {
  const S = subtleOf(ports);
  const iv = randomOf(ports)(AEAD.ivBytes);
  const plaintext = pad(canonicalBytes(obj));
  const ct = new Uint8Array(await S.encrypt(aesgcm(iv, pairAad(type, rid)), key, plaintext));
  return `${b64u(iv)}.${b64u(ct)}`;
}

/**
 * Open one pairing message, or return `null`.
 *
 * RULE 3 IS THE WHOLE DESIGN OF THIS FUNCTION. It never throws and it never reports a reason.
 * A wrong code, a tampered ciphertext, a box from another rendezvous, a box moved from one slot
 * to another and a truncated blob are ALL the same outcome: `null`. That is not laziness —
 * distinguishing them would be an oracle. "Your code was right but the relay changed the box" is
 * information the caller cannot act on and the attacker would very much like to have.
 *
 * @param {CryptoKey} key @param {string} type @param {string} rid @param {string} box
 * @param {PairPorts} [ports]
 * @returns {Promise<Object|null>}
 */
export async function openPairBox(key, type, rid, box, ports) {
  const S = subtleOf(ports);
  const aad = pairAad(type, rid);
  try {
    if (typeof box !== 'string') return null;
    const dot = box.indexOf('.');
    if (dot <= 0 || dot === box.length - 1) return null;
    const iv = ub64(box.slice(0, dot));
    const ct = ub64(box.slice(dot + 1));
    if (iv.length !== AEAD.ivBytes || ct.length === 0) return null;
    const padded = new Uint8Array(await S.decrypt(aesgcm(iv, aad), key, ct));
    const parsed = JSON.parse(utf8Decode(unpad(padded)));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The short authentication string
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `decimal6` — §6.3 step 6's rendering of four HKDF bytes as six digits.
 *
 * Big-endian uint32, modulo 10^6, zero-padded. THE MODULO BIAS IS REAL AND IS ACCEPTED:
 * 2^32 = 4294967296 = 4294 * 10^6 + 967296, so the first 967296 values occur 4295 times and the
 * rest 4294 times — a relative bias of 1 in 4294, i.e. the attacker's best guess is worth
 * 2.33e-7 instead of 1e-6. That is a factor of 1.00023 and does not move §6.4's 10^-6. Rejection
 * sampling would remove it and would also make the SAS a function of how many bytes happened to
 * be rejected, which is a worse property for something two humans must read aloud. The ADR fixes
 * four bytes; this is what four bytes means.
 *
 * @param {Uint8Array} bytes exactly `PAIRING.sasBytes`
 * @returns {string} exactly six digits
 */
export function sasFromBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== PAIRING.sasBytes) {
    fail('protocol', `sasFromBytes: expected ${PAIRING.sasBytes} bytes`);
  }
  let n = 0;
  for (let i = 0; i < bytes.length; i++) n = n * 256 + bytes[i];
  return String(n % 1000000).padStart(PAIRING.sasDigits, '0');
}

/**
 * `SAS = decimal6(HKDF(S ‖ A_eph ‖ B_eph, '', 'lzp/v2/pair/sas', 4))` — §6.3 step 6.
 *
 * TWO THINGS THIS FUNCTION'S SHAPE ENFORCES, BOTH OF THEM THE POINT OF THE WHOLE PROTOCOL:
 *
 *  1. **The transcript is bound, not just the secret.** The IKM is the shared secret CONCATENATED
 *     with both ephemeral public keys as the caller actually saw them. A MITM ends up agreeing a
 *     different `S` with each side, so the two SAS values differ — but binding the two public
 *     keys as well means that even a relay that somehow forced the same `S` on both sides would
 *     still have to reproduce both transcripts to force the same SAS.
 *  2. **The order is by ROLE, never sorted.** `A_eph` is the EXISTING device's, `B_eph` the new
 *     one's. Both ends know their own role, so the order is unambiguous without a tiebreak.
 *     Sorting the two points would make the SAS blind to which side sent which — a small hole,
 *     but a free one to close.
 *
 * @param {Uint8Array} sharedSecret raw ECDH output
 * @param {Uint8Array} aEphRaw 65 bytes, the EXISTING device's ephemeral public point
 * @param {Uint8Array} bEphRaw 65 bytes, the NEW device's
 * @param {PairPorts} [ports]
 * @returns {Promise<string>} six digits
 */
export async function computeSas(sharedSecret, aEphRaw, bEphRaw, ports) {
  const S = subtleOf(ports);
  assertRawPoint(aEphRaw, 'computeSas: A_eph');
  assertRawPoint(bEphRaw, 'computeSas: B_eph');
  const ikm = new Uint8Array(sharedSecret.length + aEphRaw.length + bEphRaw.length);
  ikm.set(sharedSecret, 0);
  ikm.set(aEphRaw, sharedSecret.length);
  ikm.set(bEphRaw, sharedSecret.length + aEphRaw.length);
  const k = await S.importKey('raw', ikm, 'HKDF', false, [...USAGES.derive]);
  const out = new Uint8Array(await S.deriveBits(hkdf(NO_SALT, INFO.pairSas), k, PAIRING.sasBytes * 8));
  return sasFromBytes(out);
}

function assertRawPoint(raw, who) {
  if (!(raw instanceof Uint8Array) || raw.length !== RAW_PUBKEY_BYTES) {
    fail('protocol', `${who}: expected a ${RAW_PUBKEY_BYTES}-byte uncompressed P-256 point`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The delivery payload — what makes the new Mac MY Mac (§6.3 step 7, story 19.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SpaceKeyRing
 * @property {string} spaceId
 * @property {Map<number,CryptoKey>|Object<string,CryptoKey>} epochs every epoch 1..e
 */

/**
 * @typedef {Object} PairingPayload
 * @property {1} v
 * @property {string} memberId
 * @property {string} recSigPkcs8 b64u, 138 bytes — RK_sig
 * @property {string} recKexPkcs8 b64u, 138 bytes — RK_kex
 * @property {{spaceId:string, epochs:Object<string,string>}} personal PSK, epochs 1..e
 * @property {{spaceId:string, epochs:Object<string,string>}|null} family FSK, epochs 1..e, or null
 */

function epochEntries(epochs, who) {
  const pairs = epochs instanceof Map ? [...epochs.entries()] : Object.entries(epochs || {});
  const out = [];
  for (const [k, v] of pairs) {
    const n = typeof k === 'number' ? k : Number(k);
    if (!Number.isSafeInteger(n) || n < 1) fail('payload', `${who}: epoch ${JSON.stringify(k)} is not a positive integer`);
    out.push([n, v]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/**
 * Every epoch from 1 to e, with no gaps.
 *
 * ADR 002 states this twice for its two other key-delivery paths — §4.2 step 2's rotation wraps
 * every current device, and §7.1 step 5 says in terms that "a wrap that covers only the current
 * epoch is a bug" because Oma's birthday from epoch 1 must still render. Pairing is not called
 * out by name, but 19.4 is the strongest form of the same requirement: the second Mac must be
 * able to read MY PRIVATE ENTRIES, and those go back to epoch 1. A partial ring is a silently
 * half-empty board, so it is refused here rather than discovered in March.
 */
function assertContiguousFromOne(entries, who) {
  if (entries.length === 0) fail('payload', `${who}: no epoch keys — the new device could read nothing`);
  for (let i = 0; i < entries.length; i++) {
    if (entries[i][0] !== i + 1) {
      fail(
        'payload',
        `${who}: epoch coverage must be 1..e with no gaps (ADR 002 §7.1 step 5, story 19.4); ` +
        `got ${entries.map(([n]) => n).join(',')}`
      );
    }
  }
}

async function exportSpace(space, who, ports) {
  if (space === null || space === undefined) return null;
  // `isSpaceId` is LZP-303's single definition of the shape, imported rather than re-typed here.
  // It matters on the RESTORE side more than this one: after a MITM has been through, `spaceId`
  // is attacker-chosen data that becomes a key in the new Mac's key ring.
  if (!isSpaceId(space.spaceId)) {
    fail('payload', `${who}: ${JSON.stringify(space.spaceId)} is not a space id`);
  }
  const entries = epochEntries(space.epochs, who);
  assertContiguousFromOne(entries, who);
  const S = subtleOf(ports);
  const epochs = {};
  for (const [n, key] of entries) {
    const raw = key instanceof Uint8Array ? key : new Uint8Array(await S.exportKey('raw', key));
    if (raw.length !== SYMMETRIC_KEY_BYTES) {
      fail('payload', `${who}: epoch ${n} is not a ${SYMMETRIC_KEY_BYTES}-byte key`);
    }
    epochs[String(n)] = b64u(raw);
  }
  return { spaceId: space.spaceId, epochs };
}

/**
 * Build §6.3 step 7's payload: the identity material the new Mac needs to BE my device, plus the
 * whole key ring.
 *
 * WHAT IS IN HERE AND WHY EACH PIECE IS UNAVOIDABLE:
 *   memberId                the new Mac joins an existing MEMBER, it does not become a new one
 *   RK_sig / RK_kex PKCS#8  §6.3 step 8: the new device SELF-ATTESTS with the restored recovery
 *                           key, and that self-attestation is what mints its `dev.<short>`
 *                           register. Without RK_sig the new Mac could generate keys nobody
 *                           would ever accept an op from
 *   personal epochs 1..e    story 19.4 — my PRIVATE entries, all of them, back to epoch 1
 *   family epochs 1..e      if I am in a Familienkreis, so the second Mac sees the same board
 *
 * WHAT IS DELIBERATELY NOT IN HERE: my device keys. `IK_sig`/`IK_kex` are `extractable: false`
 * and could not be exported even if this function wanted them. A device is a machine, not a
 * person (§7.3 step 3) — the new Mac mints its own, which is why box_B carries their public
 * halves.
 *
 * @param {{memberId:string, recSig:CryptoKeyPair, recKex:CryptoKeyPair,
 *          personal:SpaceKeyRing, family?:SpaceKeyRing|null}} spec
 * @param {PairPorts} [ports]
 * @returns {Promise<PairingPayload>}
 */
export async function buildPairingPayload(spec, ports) {
  const S = subtleOf(ports);
  const { memberId, recSig, recKex, personal, family } = spec || {};
  if (typeof memberId !== 'string' || memberId.length === 0) fail('payload', 'buildPairingPayload: memberId');
  if (!recSig?.privateKey || !recKex?.privateKey) {
    fail(
      'payload',
      'buildPairingPayload: the RECOVERY pair is required. §6.3 step 8 has the new device ' +
      'self-attest with RK_sig; without it the pairing produces a device nobody has attested.'
    );
  }
  const recSigPkcs8 = new Uint8Array(await S.exportKey('pkcs8', recSig.privateKey));
  const recKexPkcs8 = new Uint8Array(await S.exportKey('pkcs8', recKex.privateKey));
  for (const [name, b] of [['RK_sig', recSigPkcs8], ['RK_kex', recKexPkcs8]]) {
    if (b.length !== PKCS8_P256_BYTES) {
      fail('payload', `buildPairingPayload: ${name} PKCS#8 is ${b.length} bytes, expected ${PKCS8_P256_BYTES}`);
    }
  }
  const personalOut = await exportSpace(personal, 'buildPairingPayload: personal', ports);
  if (personalOut === null) {
    fail('payload', 'buildPairingPayload: the personal space is required — story 19.4 is the point of pairing');
  }
  return Object.freeze({
    v: PAIR_V,
    memberId,
    recSigPkcs8: b64u(recSigPkcs8),
    recKexPkcs8: b64u(recKexPkcs8),
    personal: personalOut,
    family: await exportSpace(family ?? null, 'buildPairingPayload: family', ports),
  });
}

/**
 * @typedef {Object} RestoredPairing
 * @property {string} memberId
 * @property {CryptoKey} recSigPriv @property {CryptoKey} recKexPriv
 * @property {{spaceId:string, epochs:Map<number,CryptoKey>}} personal
 * @property {{spaceId:string, epochs:Map<number,CryptoKey>}|null} family
 */

async function importSpace(space, who, ports) {
  if (space === null || space === undefined) return null;
  if (!isSpaceId(space?.spaceId)) fail('payload', `${who}: ${JSON.stringify(space?.spaceId)} is not a space id`);
  const entries = epochEntries(space.epochs, who);
  assertContiguousFromOne(entries, who);
  const S = subtleOf(ports);
  const epochs = new Map();
  for (const [n, b] of entries) {
    let raw;
    try {
      raw = ub64(b);
    } catch (err) {
      if (err instanceof CodecError) return fail('payload', `${who}: epoch ${n} is not base64url`);
      throw err;
    }
    if (raw.length !== SYMMETRIC_KEY_BYTES) fail('payload', `${who}: epoch ${n} is not ${SYMMETRIC_KEY_BYTES} bytes`);
    epochs.set(n, await S.importKey('raw', raw, { name: AEAD.name }, true, [...USAGES.aead]));
  }
  return { spaceId: space.spaceId, epochs };
}

/**
 * Turn the delivered payload back into keys on the new Mac.
 *
 * ENGINE DIFFERENCE 9 LIVES HERE, and this is the exact call site the contract's header warns
 * about: `importKey` of a PRIVATE EC key must carry ONLY the private usages. `generateKey`
 * accepts `['sign','verify']` and splits it across the pair; `importKey` of the private half
 * with `verify` in the list is a `SyntaxError` in BOTH engines. `USAGES.sigPrivate` and
 * `USAGES.kexPrivate` exist for this, and the restore path is where a developer looks last.
 *
 * The restored recovery keys are imported EXTRACTABLE, because §7.2's backup must be able to
 * seal them on this Mac too. The imported epoch keys are extractable because §3's
 * `wrapSpaceKey` does `wrapKey('raw')`, which requires it.
 *
 * @param {PairingPayload} payload @param {PairPorts} [ports]
 * @returns {Promise<RestoredPairing>}
 */
export async function restorePairingPayload(payload, ports) {
  const S = subtleOf(ports);
  if (!payload || typeof payload !== 'object') fail('payload', 'restorePairingPayload: not an object');
  if (payload.v !== PAIR_V) {
    fail(
      'version',
      `restorePairingPayload: payload version ${JSON.stringify(payload.v)} is not ${PAIR_V}. ` +
      'There is no downgrade negotiation surface (ADR 002 §1) — an unknown version is refused.'
    );
  }
  if (typeof payload.memberId !== 'string' || payload.memberId.length === 0) {
    fail('payload', 'restorePairingPayload: memberId');
  }
  let recSigBytes;
  let recKexBytes;
  try {
    recSigBytes = ub64(payload.recSigPkcs8);
    recKexBytes = ub64(payload.recKexPkcs8);
  } catch (err) {
    if (err instanceof CodecError) return fail('payload', 'restorePairingPayload: the recovery keys are not base64url');
    throw err;
  }
  // RULE 3 AT THE MODULE BOUNDARY — finding E10-P1.
  //
  // These two calls used to be bare. 138 base64url bytes that are not a P-256 PKCS#8 are valid
  // input to `ub64` and invalid input to `importKey`, so the engine's own `DataError` escaped
  // `restorePairingPayload` — and therefore escaped `session.receive()`, whose whole contract is
  // that `PairingError.code` is "our own vocabulary … the ONLY thing a caller may branch on".
  // A caller that follows that contract met `err.code === 0` and an `err.name` the two engines
  // spell differently, which is the exact hazard rule 3 was written down to prevent. The rule
  // does not stop applying because the code was written after it.
  let recSigPriv;
  let recKexPriv;
  try {
    recSigPriv = await S.importKey('pkcs8', recSigBytes, SIG, RECOVERY_KEY_EXTRACTABLE, [...USAGES.sigPrivate]);
    recKexPriv = await S.importKey('pkcs8', recKexBytes, KEX, RECOVERY_KEY_EXTRACTABLE, [...USAGES.kexPrivate]);
  } catch (err) {
    if (err instanceof PairingError) throw err;
    return fail('payload', 'restorePairingPayload: the delivered recovery keys are not P-256 private keys');
  }

  const personal = await importSpace(payload.personal, 'restorePairingPayload: personal', ports);
  if (personal === null) fail('payload', 'restorePairingPayload: the personal space is required (story 19.4)');
  const family = await importSpace(payload.family ?? null, 'restorePairingPayload: family', ports);
  return { memberId: payload.memberId, recSigPriv, recKexPriv, personal, family };
}

/**
 * Adapter for LZP-303's `KeyRing` (`src/js/crypto/spacekeys.js`).
 *
 * DUCK-TYPED ON `epochs(space)` AND `get(space, epoch)`, DELIBERATELY. Pairing needs two accessors
 * out of that interface's fourteen, and taking a hard dependency on the class would mean this
 * module could not be exercised — or reasoned about — without the whole rotation machinery. The
 * real `createKeyRing()` satisfies this shape and `tests/tier1/crypto-pairing.test.js` proves it
 * against the actual implementation rather than against a stand-in, which is the part that
 * matters: a structural type nobody checks against the real thing is a guess.
 *
 * @param {{epochs:(s:string)=>number[], get:(s:string,e:number)=>CryptoKey|null}} keyring
 * @param {{personalSpaceId:string, familySpaceId?:string|null}} ids
 * @returns {{personal:SpaceKeyRing, family:SpaceKeyRing|null}}
 */
export function spacesFromKeyRing(keyring, ids) {
  if (typeof keyring?.epochs !== 'function' || typeof keyring?.get !== 'function') {
    fail('payload', 'spacesFromKeyRing: expected a KeyRing with epochs() and get()');
  }
  const collect = (spaceId) => {
    if (!spaceId) return null;
    const epochs = new Map();
    for (const e of keyring.epochs(spaceId)) {
      const k = keyring.get(spaceId, e);
      if (k) epochs.set(e, k);
    }
    return { spaceId, epochs };
  };
  const personal = collect(ids?.personalSpaceId);
  if (personal === null) fail('payload', 'spacesFromKeyRing: personalSpaceId is required');
  return { personal, family: collect(ids?.familySpaceId ?? null) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The session — both roles, one state machine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PairingSession
 * @property {() => Promise<{rid:string, boxA:string, code:string, display:string}>} beginAsExisting
 * @property {(code:string, boxA:string) => Promise<{rid:string, boxB:string, peer:Object}>} answerAsNew
 * @property {(boxB:string) => Promise<{sas:string, peer:Object}>} confirmExisting
 * @property {() => Promise<{sas:string, peer:Object}>} confirmNew
 * @property {(humanSaidTheDigitsMatch:boolean) => {state:string}} confirmSasMatch
 * @property {(payload?:Object) => Promise<string>} deliver
 * @property {(blob:string) => Promise<RestoredPairing>} receive
 * @property {() => string} state
 * @property {() => string|null} role
 * @property {() => string|null} sas
 * @property {() => number} attemptsRemaining
 * @property {() => Object|null} peer
 * @property {() => Object|null} newDeviceKeys
 * @property {() => Object} obligations
 */

/**
 * Both roles of ADR 002 §6.3, as a pure state machine with the transport injected — which here
 * means: not injected at all. Nothing in this object talks to anything. The caller hands it the
 * bytes it got from wherever it got them and takes back the bytes to send. That is what makes
 * `tests/helpers/mitm.js` able to be a genuinely hostile relay rather than a mocked one.
 *
 * ROLE IS LOCKED BY THE FIRST CALL. `beginAsExisting()` makes this the existing device forever;
 * `answerAsNew()` makes it the new one. A session cannot be talked into swapping roles mid-flight,
 * which is the confused-deputy a relay would otherwise reach for.
 *
 * THE TTL IS ENFORCED ON BOTH SIDES, AND THE AUTHORITATIVE ONE IS THE RELAY'S. §6.2's 180 s is a
 * property of the rendezvous, which the relay holds and burns. Each side additionally measures
 * its own 180 s from its own first step, which is defence in depth against a relay that simply
 * declines to expire a session — and, more usefully, against an offline replay of a captured
 * transcript hours later. The two clocks are independent and the module says so rather than
 * pretending B knows when A started.
 *
 * @param {import('./identity.js').Identity|null} identity the EXISTING device's identity, with
 *        `recSig`/`recKex` present. `null` for the new device, which has no identity yet.
 * @param {{personal:SpaceKeyRing, family?:SpaceKeyRing|null}|null} [keyring] what `deliver()`
 *        sends when called with no argument. Ignored in the new-device role.
 * @param {PairPorts} [ports] `now` is REQUIRED
 * @returns {PairingSession}
 */
export function createPairingSession(identity, keyring, ports) {
  const S = subtleOf(ports);
  const random = randomOf(ports);
  const now = ports && ports.now;
  if (typeof now !== 'function') {
    throw new PairingError(
      'no_clock',
      'createPairingSession: a `now` port is REQUIRED. The 180 s TTL is a stated parameter of ' +
      'this protocol (ADR 002 §6.2) and nothing under src/js/crypto/ may read a clock itself.'
    );
  }

  let state = PAIR_STATE.init;
  let role = null;              // 'existing' | 'new'
  let startedAt = null;
  let rid = null;
  let code = null;              // dropped as soon as the boxes are open
  let ck = null;                // dropped as soon as the boxes are open
  let ephPriv = null;
  let aEphRaw = null;
  let bEphRaw = null;
  let sas = null;
  let peer = null;
  let kek = null;
  let newDevice = null;         // the new Mac's own pairs, minted at step 4
  let failedOpens = 0;
  let obligation = Object.freeze({});

  const terminate = (next) => {
    state = next;
    code = null;
    ck = null;
    ephPriv = null;
    kek = null;
    return next;
  };

  const expiredCheck = () => {
    if (startedAt !== null && now() - startedAt > PAIRING.ttlMs) {
      terminate(PAIR_STATE.expired);
      fail('expired', `pairing: the ${PAIRING.ttlSeconds} s window has closed. Start again on the first Mac.`);
    }
  };

  /** A terminal state answers with ITS OWN code, never a generic 'state'. A caller told only
   *  "wrong state" would not know whether to offer a retry; told 'burned' or 'refused' it knows
   *  there is nothing to retry. */
  const notTerminal = (who) => {
    if (TERMINAL.has(state)) {
      fail(state, `${who}: this session ended in state '${state}' and cannot continue`);
    }
  };

  const require_ = (want, who) => {
    notTerminal(who);
    expiredCheck();
    if (state !== want) fail('state', `${who}: expected state '${want}', this session is in '${state}'`);
  };

  const lockRole = (want, who) => {
    if (role !== null && role !== want) {
      terminate(PAIR_STATE.failed);
      fail('role', `${who}: this session is already the ${role} device and cannot also be the ${want} one`);
    }
    role = want;
  };

  const noteFailedOpen = (who) => {
    failedOpens += 1;
    if (failedOpens >= PAIRING.maxFailedOpens) {
      terminate(PAIR_STATE.burned);
      fail(
        'burned',
        `${who}: ${PAIRING.maxFailedOpens} failed attempts — this rendezvous is burned ` +
        '(ADR 002 §6.2). Start again on the first Mac.'
      );
    }
    fail('open_failed', `${who}: that did not open. Either the code is wrong or the message was tampered with — ` +
      'the two are indistinguishable by design.');
  };

  async function ephemeral() {
    const kp = await S.generateKey(KEX, false, [...USAGES.kex]);
    return { priv: kp.privateKey, raw: await exportRawPublic(kp.publicKey, ports) };
  }

  async function agree(peerRaw) {
    // RULE 3, the same hazard as `restorePairingPayload`'s (E10-P1). `assertRawPoint` checks the
    // LENGTH of a peer's ephemeral point and nothing else — deliberately, because both engines
    // validate the point inside `importKey` (§9.2) and a hand-rolled curve check here would be
    // the weaker of the two. But "the engine validates it" is only half a design: the engine's
    // refusal is a `DataError`/`InvalidAccessException` whose name differs BETWEEN engines, and
    // it was escaping `confirmExisting()` / `confirmNew()` raw, leaving the session live in
    // `offered` / `answered` while the caller held an error it may not branch on.
    try {
      const pub = await importKexPublic(peerRaw, ports); // rule 5 — keyUsages: []
      return new Uint8Array(await S.deriveBits({ name: KEX.name, public: pub }, ephPriv, 256));
    } catch (err) {
      if (err instanceof PairingError) throw err;
      terminate(PAIR_STATE.failed);
      return fail('protocol', 'pairing: the peer\'s ephemeral point is not a P-256 public key');
    }
  }

  return {
    state: () => state,
    role: () => role,
    sas: () => sas,
    peer: () => peer,
    attemptsRemaining: () => Math.max(0, PAIRING.maxFailedOpens - failedOpens),
    newDeviceKeys: () => newDevice,

    /**
     * §6.3 steps 1-2, on the EXISTING device. Returns the code to put on screen and the box to
     * POST to `/api/v1/pair/offer`.
     */
    async beginAsExisting() {
      notTerminal('beginAsExisting');
      lockRole('existing', 'beginAsExisting');
      if (state !== PAIR_STATE.init) fail('state', `beginAsExisting: this session is in '${state}'`);
      if (!identity?.memberId || !identity?.deviceId || !identity?.devSig?.publicKey) {
        fail('identity', 'beginAsExisting: the existing device needs an Identity with memberId, deviceId and devSig');
      }
      startedAt = now();
      code = generatePairingCode(random);
      const derived = await derivePairing(code, ports);
      rid = derived.rid;
      ck = derived.ck;
      const eph = await ephemeral();
      ephPriv = eph.priv;
      aEphRaw = eph.raw;
      const sigRaw = await exportRawPublic(identity.devSig.publicKey, ports);
      const boxA = await sealPairBox(ck, PAIR_MSG.offer, rid, {
        v: PAIR_V,
        aEph: b64u(aEphRaw),
        aSigPub: b64u(sigRaw),
        aDevId: identity.deviceId,
        memberId: identity.memberId,
      }, ports);
      state = PAIR_STATE.offered;
      return { rid, boxA, code, display: formatPairingCode(code) };
    },

    /**
     * §6.3 steps 3-4, on the NEW device: derive `rid`/`ck` from the typed code, open box_A, mint
     * this Mac's own device keys, and answer.
     *
     * WHY THE DEVICE KEYS ARE MINTED HERE AND NOT AT STEP 8. §6.3 step 8 says the new device
     * "mints its own non-extractable IK_sig/IK_kex, self-attests with the restored RK_sig". Read
     * literally that would mint them AFTER box_B was already sent — but box_B carries
     * `B_sigPub`/`B_kexPub`, which is what tells the existing Mac the new device's `deviceShort`
     * and what step 9 wraps the rotated PSK to. Minting twice would produce a device whose
     * attested keys are not the keys the first Mac wrapped to: a silently unreadable second Mac.
     * So the keys are minted here, at step 4, and step 8 is the SELF-ATTESTATION of these keys.
     * `adoptPairedDevice()` persists exactly this pair and nothing else.
     */
    async answerAsNew(typedCode, boxA) {
      notTerminal('answerAsNew');
      lockRole('new', 'answerAsNew');
      if (state !== PAIR_STATE.init) fail('state', `answerAsNew: this session is in '${state}'`);
      // B's 180 s runs from ITS OWN first step. It cannot run from A's, because B has no way to
      // know when the code was minted — nothing in the offer is a timestamp and nothing may be,
      // since a relay-supplied one would be attacker-controlled. So the SHARED window is the
      // relay's, which holds the rendezvous and burns it; this clock bounds B's own steps and
      // stops a captured transcript being replayed into a fresh session hours later.
      if (startedAt === null) startedAt = now();
      expiredCheck();
      const canonical = normalizePairingCode(typedCode);
      const derived = await derivePairing(canonical, ports);
      rid = derived.rid;
      ck = derived.ck;

      const opened = await openPairBox(ck, PAIR_MSG.offer, rid, boxA, ports);
      if (opened === null) noteFailedOpen('answerAsNew');
      if (opened.v !== PAIR_V) {
        terminate(PAIR_STATE.failed);
        fail('version', `answerAsNew: the offer claims version ${JSON.stringify(opened.v)}, not ${PAIR_V}`);
      }
      let aRaw;
      let aSigRaw;
      try {
        aRaw = ub64(opened.aEph);
        aSigRaw = ub64(opened.aSigPub);
      } catch (err) {
        if (!(err instanceof CodecError)) throw err;
        terminate(PAIR_STATE.failed);
        return fail('protocol', 'answerAsNew: the offer is malformed');
      }
      assertRawPoint(aRaw, 'answerAsNew: A_eph');
      assertRawPoint(aSigRaw, 'answerAsNew: A_sigPub');
      if (typeof opened.memberId !== 'string' || opened.memberId.length === 0 ||
          typeof opened.aDevId !== 'string' || opened.aDevId.length === 0) {
        terminate(PAIR_STATE.failed);
        fail('protocol', 'answerAsNew: the offer is missing memberId or aDevId');
      }
      aEphRaw = aRaw;

      const eph = await ephemeral();
      ephPriv = eph.priv;
      bEphRaw = eph.raw;

      newDevice = await generateDeviceKeys(ports);
      const bSigRaw = await exportRawPublic(newDevice.devSig.publicKey, ports);
      const bKexRaw = await exportRawPublic(newDevice.devKex.publicKey, ports);
      newDevice = Object.freeze({
        ...newDevice,
        deviceId: mintDeviceId(random),
        deviceShort: deviceShortOf(bSigRaw),
      });

      const boxB = await sealPairBox(ck, PAIR_MSG.answer, rid, {
        v: PAIR_V,
        bEph: b64u(bEphRaw),
        bSigPub: b64u(bSigRaw),
        bKexPub: b64u(bKexRaw),
        bDevId: newDevice.deviceId,
      }, ports);

      peer = Object.freeze({
        memberId: opened.memberId,
        deviceId: opened.aDevId,
        deviceShort: deviceShortOf(aSigRaw),
        sigPubRaw: opened.aSigPub,
      });
      state = PAIR_STATE.answered;
      return { rid, boxB, peer };
    },

    /** §6.3 steps 5-6, on the EXISTING device: open box_B, agree, compute the six digits. */
    async confirmExisting(boxB) {
      require_(PAIR_STATE.offered, 'confirmExisting');
      const opened = await openPairBox(ck, PAIR_MSG.answer, rid, boxB, ports);
      if (opened === null) noteFailedOpen('confirmExisting');
      if (opened.v !== PAIR_V) {
        terminate(PAIR_STATE.failed);
        fail('version', `confirmExisting: the answer claims version ${JSON.stringify(opened.v)}, not ${PAIR_V}`);
      }
      let bRaw;
      let bSigRaw;
      let bKexRaw;
      try {
        bRaw = ub64(opened.bEph);
        bSigRaw = ub64(opened.bSigPub);
        bKexRaw = ub64(opened.bKexPub);
      } catch (err) {
        if (!(err instanceof CodecError)) throw err;
        terminate(PAIR_STATE.failed);
        return fail('protocol', 'confirmExisting: the answer is malformed');
      }
      assertRawPoint(bRaw, 'confirmExisting: B_eph');
      assertRawPoint(bSigRaw, 'confirmExisting: B_sigPub');
      assertRawPoint(bKexRaw, 'confirmExisting: B_kexPub');
      if (typeof opened.bDevId !== 'string' || opened.bDevId.length === 0) {
        terminate(PAIR_STATE.failed);
        fail('protocol', 'confirmExisting: the answer is missing bDevId');
      }
      bEphRaw = bRaw;
      const shared = await agree(bEphRaw);
      sas = await computeSas(shared, aEphRaw, bEphRaw, ports);
      kek = await kekFrom(S, shared);
      // The code and `ck` have done their whole job; nothing after this point needs them.
      code = null;
      ck = null;
      peer = Object.freeze({
        deviceId: opened.bDevId,
        deviceShort: deviceShortOf(bSigRaw),
        sigPubRaw: opened.bSigPub,
        kexPubRaw: opened.bKexPub,
      });
      state = PAIR_STATE.sas;
      return { sas, peer };
    },

    /** §6.3 step 6, on the NEW device. No argument: B already holds both ephemeral points. */
    async confirmNew() {
      require_(PAIR_STATE.answered, 'confirmNew');
      const shared = await agree(aEphRaw);
      sas = await computeSas(shared, aEphRaw, bEphRaw, ports);
      kek = await kekFrom(S, shared);
      code = null;
      ck = null;
      state = PAIR_STATE.sas;
      return { sas, peer };
    },

    /**
     * THE HUMAN'S ANSWER. „Stimmen die Zahlen auf beiden Bildschirmen überein?"
     *
     * There is no default and no truthiness: the argument must be the boolean `true`. Anything
     * else — `false`, `undefined`, `'ja'`, `1` — refuses the pairing, terminally. That asymmetry
     * is deliberate. A caller that forgets to pass the human's answer must fail CLOSED, and a
     * caller that passes a truthy sentinel it happened to have lying around must not be mistaken
     * for a human who looked at two screens.
     *
     * WHAT THIS CANNOT DO. No API can tell whether a person actually compared two screens. What
     * it can do is make the lie a single explicit, greppable line — `confirmSasMatch(true)` with
     * no human anywhere near it — instead of an emergent property of a control flow. ADR 002 §6.4
     * makes this a normative UI requirement: not skippable, not defaulted to „Ja". LZP-503 owns
     * the screen; this is the seam it must not shortcut.
     */
    confirmSasMatch(humanSaidTheDigitsMatch) {
      require_(PAIR_STATE.sas, 'confirmSasMatch');
      if (humanSaidTheDigitsMatch !== true) {
        terminate(PAIR_STATE.refused);
        return { state };
      }
      state = PAIR_STATE.confirmed;
      return { state };
    },

    /**
     * §6.3 step 7, on the EXISTING device. Seals the key transfer under
     * `kek = HKDF(S, '', 'lzp/v2/pair/kek', 32)`.
     *
     * Refuses unless a human confirmed the SAS on THIS device. That refusal is the entire
     * defence against T4 and it is checked here rather than by the caller, so that no UI can
     * forget it.
     */
    async deliver(payload) {
      require_(PAIR_STATE.confirmed, 'deliver');
      if (role !== 'existing') fail('role', 'deliver: only the existing device delivers');
      const built = payload === undefined
        ? await buildPairingPayload({
          memberId: identity.memberId,
          recSig: identity.recSig,
          recKex: identity.recKex,
          personal: keyring?.personal,
          family: keyring?.family ?? null,
        }, ports)
        : payload;
      // Validate whatever we were handed under exactly the rules the far side will apply, so a
      // caller can never deliver a ring the new Mac is then obliged to reject.
      assertPayloadShape(built);
      const blob = await sealPairBox(kek, PAIR_MSG.deliver, rid, built, ports);
      const maxEpoch = Math.max(...Object.keys(built.personal.epochs).map(Number));
      obligation = Object.freeze({
        rotatePersonalSpaceTo: maxEpoch + 1,
        wrapTo: peer,
        note: 'ADR 002 §6.3 step 9 — LZP-303 owns buildRotation(); this module does not rotate.',
      });
      terminate(PAIR_STATE.delivered);
      return blob;
    },

    /** §6.3 step 8's first half, on the NEW device: open the transfer and restore the keys. */
    async receive(blob) {
      require_(PAIR_STATE.confirmed, 'receive');
      if (role !== 'new') fail('role', 'receive: only the new device receives');
      const opened = await openPairBox(kek, PAIR_MSG.deliver, rid, blob, ports);
      if (opened === null) noteFailedOpen('receive');
      // E10-P1's second half — THE DELIVERY LEG FAILS TERMINALLY LIKE THE OTHER TWO.
      //
      // `answerAsNew` and `confirmExisting` `terminate(PAIR_STATE.failed)` on every malformed
      // field of a message that OPENED, because a box that decrypts and then does not parse is a
      // protocol violation and not a typo. This leg — the ONLY one carrying key material — did
      // not: a malformed payload threw and left the session in `confirmed`, i.e. still willing to
      // `receive()` again, while the other Mac had already gone terminal `delivered` and taken on
      // §6.3 step 9's obligation to rotate. That is the half-completed pairing with the two ends
      // disagreeing about whether it is over, and the disagreement is now removed.
      let restored;
      try {
        restored = await restorePairingPayload(opened, ports);
      } catch (err) {
        terminate(PAIR_STATE.failed);
        throw err;
      }
      if (restored.memberId !== peer.memberId) {
        terminate(PAIR_STATE.failed);
        fail(
          'protocol',
          'receive: the delivered memberId is not the one the offer named. Refusing to attach ' +
          'this Mac to a different member than the one whose code was typed.'
        );
      }
      terminate(PAIR_STATE.received);
      return restored;
    },

    /** What §6.3 step 9 obliges the caller to do next. Empty until `deliver()` has run. */
    obligations: () => obligation,
  };
}

async function kekFrom(S, shared) {
  const k = await S.importKey('raw', shared, 'HKDF', false, [...USAGES.derive]);
  return S.deriveKey(hkdf(NO_SALT, INFO.pairKek), k, { name: AEAD.name, length: AEAD.length }, false, [...USAGES.aead]);
}

/**
 * The far side's acceptance rules, applied before sending rather than after.
 *
 * ⚠ THE SENTENCE ABOVE IS A CLAIM, AND IT USED TO BE FALSE — finding E10-P1.
 *
 * `deliver()`'s call site says "so a caller can never deliver a ring the new Mac is then obliged
 * to reject", and four shapes walked straight past it: a `recSigPkcs8` of the wrong length, a
 * `recSigPkcs8` of the right length that is not a key, an epoch value that is not 32 bytes, and
 * an epoch value that is not base64url at all. Each was sealed, sent, and refused by
 * `restorePairingPayload` — after the sending Mac had already gone terminal `delivered` and taken
 * on §6.3 step 9's obligation to rotate its personal space to `e+1`.
 *
 * So the byte-level checks the far side makes are made HERE too. They are cheap (a length and an
 * alphabet), they are exactly what `restorePairingPayload` will apply, and there is no honest
 * payload they can refuse: `buildPairingPayload` already guarantees both lengths at the source.
 * What cannot be checked on this side is whether 138 well-formed bytes are a POINT — that needs
 * `importKey`, which is the far side's job and now fails there with a code rather than a
 * `DataError`.
 */
function assertPayloadShape(p) {
  if (!p || typeof p !== 'object') fail('payload', 'deliver: the payload must be an object');
  if (p.v !== PAIR_V) fail('version', `deliver: payload version must be ${PAIR_V}`);
  if (typeof p.memberId !== 'string' || p.memberId.length === 0) fail('payload', 'deliver: memberId');
  if (typeof p.recSigPkcs8 !== 'string' || typeof p.recKexPkcs8 !== 'string') {
    fail('payload', 'deliver: the recovery keys are required — §6.3 step 8 self-attests with RK_sig');
  }
  for (const [name, b64] of [['RK_sig', p.recSigPkcs8], ['RK_kex', p.recKexPkcs8]]) {
    assertB64uLength(b64, PKCS8_P256_BYTES, `deliver: ${name} PKCS#8`);
  }
  if (!p.personal || typeof p.personal !== 'object') fail('payload', 'deliver: the personal space is required');
  if (!isSpaceId(p.personal.spaceId)) fail('payload', 'deliver: the personal spaceId is not a space id');
  if (p.family && !isSpaceId(p.family.spaceId)) fail('payload', 'deliver: the family spaceId is not a space id');
  for (const which of ['personal', 'family']) {
    if (!p[which]) continue;
    const entries = epochEntries(p[which].epochs, `deliver: ${which}`);
    assertContiguousFromOne(entries, `deliver: ${which}`);
    for (const [n, v] of entries) {
      assertB64uLength(v, SYMMETRIC_KEY_BYTES, `deliver: ${which} epoch ${n}`);
    }
  }
}

/** A base64url string of exactly `want` bytes, or a `PairingError` naming the field. */
function assertB64uLength(value, want, who) {
  if (typeof value !== 'string') fail('payload', `${who}: expected a base64url string`);
  let raw;
  try {
    raw = ub64(value);
  } catch (err) {
    if (!(err instanceof CodecError)) throw err;
    return fail('payload', `${who}: not base64url`);
  }
  if (raw.length !== want) fail('payload', `${who}: ${raw.length} bytes, expected ${want}`);
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Step 8's second half — becoming a device of this member
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist the pairs minted at step 4 and self-attest them with the restored `RK_sig` — ADR 002
 * §6.3 step 8. The returned `blob` is what WP-9 writes to `member:<memberId>` -> `dev.<short>`,
 * and that write is what mints this Mac's device register.
 *
 * WHY THIS IS NOT `ensureAttestedDevice()`. That function MINTS a fresh pair. The new Mac already
 * committed to a pair at step 4 — its public halves are inside box_B, its `deviceShort` is what
 * the first Mac displayed next to the SAS, and its `kexPubRaw` is what step 9's rotation wraps
 * the new PSK to. Minting again here would attest keys nobody wrapped to. So this writes exactly
 * the three records `ensureDeviceIdentity` reads, in exactly its order — keys first, metadata
 * last, so a crash leaves a PARTIAL store that `ensureDeviceIdentity` refuses loudly rather than
 * a second silent identity. `tests/tier1/crypto-pairing.test.js` proves the format cannot drift
 * by running the real `ensureDeviceIdentity` over the store afterwards and asserting it ADOPTS.
 *
 * IT REFUSES A NON-EMPTY STORE. A Mac that already has a device identity is not a new device, and
 * pairing over it would orphan every op the old short authored (`ensureDeviceIdentity`'s header
 * makes the same argument at greater length).
 *
 * @param {import('./identity.js').KeyStore} ks
 * @param {RestoredPairing} restored what `session.receive()` returned
 * @param {{devSig:CryptoKeyPair, devKex:CryptoKeyPair, deviceId:string, deviceShort:string}} newDeviceKeys
 *        `session.newDeviceKeys()` — the pair minted at step 4, not a fresh one
 * @param {{createdAt:string} & PairPorts} opts `createdAt` is injected, never a clock read
 * @returns {Promise<{identity:Object, attestation:Object, blob:string}>}
 */
export async function adoptPairedDevice(ks, restored, newDeviceKeys, opts) {
  for (const m of ['get', 'put', 'del', 'list']) {
    if (typeof ks?.[m] !== 'function') fail('keystore', `adoptPairedDevice: the KeyStore port is missing ${m}`);
  }
  const { createdAt } = opts || {};
  if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(createdAt)) {
    fail('protocol', "adoptPairedDevice: createdAt must be 'YYYY-MM-DD' and is INJECTED, not read from a clock");
  }
  if (!newDeviceKeys?.devSig?.privateKey || !newDeviceKeys?.devKex?.privateKey) {
    fail('protocol', 'adoptPairedDevice: pass session.newDeviceKeys() — the pair minted at step 4');
  }
  if (newDeviceKeys.devSig.privateKey.extractable !== DEVICE_KEY_EXTRACTABLE) {
    fail('protocol', 'adoptPairedDevice: a device signing key must be non-extractable (ADR 002 §2.1)');
  }
  const existing = await Promise.all(
    [KEYSTORE_IDS.devSig, KEYSTORE_IDS.devKex, KEYSTORE_IDS.devMeta,
      KEYSTORE_IDS.recSig, KEYSTORE_IDS.recKex, KEYSTORE_IDS.recMeta].map((id) => ks.get(id))
  );
  if (existing.some((v) => v !== null && v !== undefined)) {
    fail(
      'keystore',
      'adoptPairedDevice: this key store already holds an identity. A Mac that is already ' +
      'someone\'s device is not a new device; refusing to pair over it.'
    );
  }

  const { deviceId, deviceShort, devSig, devKex } = newDeviceKeys;
  if (!isDeviceShort(deviceShort)) fail('protocol', 'adoptPairedDevice: deviceShort');
  const sigRaw = await exportRawPublic(devSig.publicKey, opts);
  if (deviceShortOf(sigRaw) !== deviceShort) {
    fail('protocol', 'adoptPairedDevice: the deviceShort is not the short of the signing key (§5.2.2 P2)');
  }

  // The recovery identity first: it is the thing that survives this machine.
  await ks.put(KEYSTORE_IDS.recSig, { privateKey: restored.recSigPriv, publicKey: await recPublicOf(restored.recSigPriv, SIG, USAGES.peerSig, opts) });
  await ks.put(KEYSTORE_IDS.recKex, { privateKey: restored.recKexPriv, publicKey: await recPublicOf(restored.recKexPriv, KEX, USAGES.peerKex, opts) });
  await ks.put(KEYSTORE_IDS.recMeta, canonicalBytes({ memberId: restored.memberId, createdAt }));

  await ks.put(KEYSTORE_IDS.devSig, devSig);
  await ks.put(KEYSTORE_IDS.devKex, devKex);
  await ks.put(KEYSTORE_IDS.devMeta, canonicalBytes({ memberId: restored.memberId, deviceId, deviceShort, createdAt }));

  const attestation = await buildDeviceAttestation(
    { memberId: restored.memberId, deviceId, createdAt },
    devSig.publicKey,
    devKex.publicKey,
    opts
  );
  const blob = await attestDevice(attestation, restored.recSigPriv, opts);
  return {
    identity: Object.freeze({
      memberId: restored.memberId, deviceId, deviceShort, createdAt, devSig, devKex,
      recSig: { privateKey: restored.recSigPriv },
      recKex: { privateKey: restored.recKexPriv },
    }),
    attestation,
    blob,
  };
}

/**
 * Recover the public half of a restored private key.
 *
 * The delivered PKCS#8 carries the public point, but WebCrypto has no "give me the public half"
 * call, so it is round-tripped through JWK with the private components removed. This is the one
 * genuinely fiddly step on the restore path and it is worth a sentence: `d` is the private
 * scalar; dropping it and clearing `key_ops`/`ext` leaves exactly a public JWK. It runs only on
 * the RECOVERY pair, which is extractable by design (§2.1); a device key could not be exported
 * at all, which is the point of the flag.
 */
async function recPublicOf(privateKey, alg, usages, ports) {
  const S = subtleOf(ports);
  const jwk = await S.exportKey('jwk', privateKey);
  const pub = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true };
  return S.importKey('jwk', pub, alg, true, [...usages]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. What this module does NOT do, and who owns it
//
//   * IT DOES NOT ROTATE. §6.3 step 9 — "A rotates PSK -> e+1 and wraps to every own device" —
//     is LZP-303's `buildRotation()`. `session.obligations()` reports what has to happen and to
//     which device; nothing here performs it.
//   * IT DOES NOT REGISTER. `POST /api/v1/devices` and the relay's self-certifying `deviceShort`
//     check are ADR 003 §2 / WP-7.
//   * IT DOES NOT WRITE THE ATTESTATION INTO THE LOG. `adoptPairedDevice` returns the blob;
//     writing `member:<memberId>` -> `dev.<deviceShort>` is WP-9's op.
//   * IT DOES NOT CLOSE I-3 / R5-7, AND NOTHING BUILT ON IT MAY ASSUME IT DOES. The
//     self-attestation minted at step 8 passes §5.2.2's P2 — its `deviceShort` really is the
//     short of its `sigPubRaw` — and P2 is self-consistency, not identity. A squatter can still
//     copy a public key out of the E2EE stream and file a well-formed attestation under a peer's
//     short (FINDINGS §4.5, option (a), owned by `src/js/core/authz.js`). Pairing gives the new
//     Mac a real, honestly-minted attestation; it does not make the SPACE's short -> attestation
//     map a function, and `openOp` must keep treating `attestationOf` as partial and parking.
//   * IT HAS NO REVOCATION, because there is none anywhere (§2.3 "Revocation — the gap", §8.2a,
//     owner WP-9). Unpairing a Mac cannot withdraw its attestation; the epoch bump stops it
//     receiving future keys and nothing stops it authoring admissible ops. Any UI string about
//     unpairing must say the smaller true thing, not the larger false one.
// ─────────────────────────────────────────────────────────────────────────────
