// tests/helpers/mitm.js — a hostile relay for the pairing protocol.  ADR 002 §0 T4, §6.1, §6.4.
//
// ADR 002 §6.4's boxed warning names this file:
//   "`tests/fleet/pairing-mitm.test.js` drives the protocol through `tests/helpers/mitm.js` — an
//    active-attacker transport that substitutes ephemeral keys — and asserts SAS divergence and
//    a refused pairing."
// The fleet suite does not exist yet, so the driver currently lives in
// `tests/tier1/crypto-pairing.test.js`. Nothing here depends on which file drives it.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS FILE DELIBERATELY DOES NOT IMPORT `src/js/crypto/pairing.js`
// ═════════════════════════════════════════════════════════════════════════════
//
// An attacker built out of the victim's own helpers cannot find a bug in them. If `pairing.js`
// derived `ck` with the wrong HKDF label, an attacker that called `derivePairing()` would derive
// the same wrong key and the test would pass. So every primitive the adversary needs is
// re-implemented here against raw WebCrypto, and the four wire-format strings it needs are
// written out as literals rather than imported:
//
//     'lzp/v2/pair/rid'   'lzp/v2/pair/ck'   'lzp/v2/pair/sas'   'lzp/v2/pair/kek'
//
// If a future edit changes one of those in `suite.js`, this attacker stops being able to attack
// and several tests below fail LOUDLY — which is the correct alarm for an unannounced change to
// a wire format. The same goes for the AAD construction, the `b64u(iv).b64u(ct)` framing and the
// 256-byte padding: all three are re-derived here from the ADR, not borrowed.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FIVE TRANSPORTS
// ═════════════════════════════════════════════════════════════════════════════
//
//   honestRelay()        a correct, untrusted-but-passive relay: TTL, single use, the 5-failed-
//                        open burn, and a full transcript of everything it ever held. Used to
//                        prove the happy path AND to prove the relay never sees plaintext.
//   activeMitm({code})   T4 in full: knows the code, runs the protocol with both sides, and
//                        substitutes a DIFFERENT ephemeral key toward each of them.
//   blindMitm()          T4 without the code: the realistic hostile Wi-Fi case. It can only
//                        corrupt, and corruption fails closed.
//   replayRelay()        records a transcript and re-serves it — into the wrong slot, into a
//                        second rendezvous, and to a session that already completed.
//   downgradeRelay()     rewrites what it can reach: the wire version, the message slot.
//
// Each exposes the same six-method transport, so a test can swap one for another and change
// nothing else. None of them is a mock of `pairing.js`: they hold strings and hand strings back.

const S = globalThis.crypto.subtle;

// ─────────────────────────────────────────────────────────────────────────────
// 0. The wire format, re-derived
// ─────────────────────────────────────────────────────────────────────────────

const TE = new TextEncoder();
const TD = new TextDecoder('utf-8', { fatal: true });

/** ADR 002 §3's label table, written out rather than imported. See the header. */
export const ATTACKER_LABELS = Object.freeze({
  rid: 'lzp/v2/pair/rid',
  ck: 'lzp/v2/pair/ck',
  sas: 'lzp/v2/pair/sas',
  kek: 'lzp/v2/pair/kek',
});

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A random well-formed 12-character code. What an online guesser sends, one guess at a time. */
export function attackerGuessCode() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  let out = '';
  for (const x of b) out += CROCK[x & 31];
  return out;
}

function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function ub64(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** ADR 002 §6.2's normalisation: separators out, upper case, I/L -> 1, O -> 0, U left alone. */
export function attackerNormalize(code) {
  let out = '';
  for (const ch of String(code)) {
    if (ch === '-' || ch === ' ' || ch === '\u00A0' || ch === '\t') continue;
    const u = ch.toUpperCase();
    out += u === 'I' || u === 'L' ? '1' : u === 'O' ? '0' : u;
  }
  return out;
}

/**
 * The AAD `pairing.js` uses, re-derived from ADR 002 §5.1's "always non-empty" rule and the
 * four-element construction the module documents. Canonical JSON of a four-element array of
 * scalars is unambiguous, so this needs no canonicaliser: sorted keys do not apply to arrays and
 * there is no whitespace.
 */
function aad(type, rid) {
  return TE.encode(JSON.stringify(['lzp/v2/pair', 1, type, rid]));
}

function gcm(iv, additionalData) {
  return { name: 'AES-GCM', iv, additionalData, tagLength: 128 };
}

/** LEB128, unsigned — ADR 002 §5.3's length prefix. */
function varint(n) {
  const out = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Uint8Array.from(out);
}

function readVarint(bytes) {
  let value = 0;
  let scale = 1;
  let i = 0;
  for (;;) {
    const b = bytes[i];
    value += (b & 0x7f) * scale;
    i++;
    if ((b & 0x80) === 0) return { value, bytesRead: i };
    scale *= 128;
  }
}

function pad(bytes, bucket = 256) {
  const len = varint(bytes.length);
  const total = len.length + bytes.length;
  const out = new Uint8Array(Math.ceil(total / bucket) * bucket);
  out.set(len, 0);
  out.set(bytes, len.length);
  return out;
}

function unpad(padded) {
  const { value, bytesRead } = readVarint(padded);
  return padded.subarray(bytesRead, bytesRead + value);
}

async function hkdfBits(ikm, label, bits) {
  const k = await S.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await S.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: TE.encode(label) }, k, bits
  ));
}

async function hkdfAesKey(ikm, label) {
  const k = await S.importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return S.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: TE.encode(label) },
    k, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. What an attacker who has the code can do
// ─────────────────────────────────────────────────────────────────────────────

/** rid and ck, from the whole 12-character code. The attacker's copy of §6.3 step 1. */
export async function attackerDerive(code) {
  const canonical = attackerNormalize(code);
  const ikm = TE.encode(canonical);
  const rid = b64u(await hkdfBits(ikm, ATTACKER_LABELS.rid, 128));
  const ck = await hkdfAesKey(ikm, ATTACKER_LABELS.ck);
  return { rid, ck };
}

export async function attackerOpen(key, type, rid, box) {
  try {
    const dot = box.indexOf('.');
    const iv = ub64(box.slice(0, dot));
    const ct = ub64(box.slice(dot + 1));
    const padded = new Uint8Array(await S.decrypt(gcm(iv, aad(type, rid)), key, ct));
    return JSON.parse(TD.decode(unpad(padded)));
  } catch {
    return null;
  }
}

export async function attackerSeal(key, type, rid, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await S.encrypt(
    gcm(iv, aad(type, rid)), key, pad(TE.encode(JSON.stringify(obj)))
  ));
  return `${b64u(iv)}.${b64u(ct)}`;
}

/** §6.3 step 6, the attacker's copy: what SAS a party WOULD see given a transcript. */
export async function attackerSas(shared, aEphRaw, bEphRaw) {
  const ikm = new Uint8Array(shared.length + aEphRaw.length + bEphRaw.length);
  ikm.set(shared, 0);
  ikm.set(aEphRaw, shared.length);
  ikm.set(bEphRaw, shared.length + aEphRaw.length);
  const out = await hkdfBits(ikm, ATTACKER_LABELS.sas, 32);
  let n = 0;
  for (const b of out) n = n * 256 + b;
  return String(n % 1000000).padStart(6, '0');
}

async function ephemeral() {
  const kp = await S.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits', 'deriveKey']);
  return { priv: kp.privateKey, raw: new Uint8Array(await S.exportKey('raw', kp.publicKey)) };
}

async function agree(priv, peerRaw) {
  const pub = await S.importKey('raw', peerRaw, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return new Uint8Array(await S.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The transports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} Transport
 * @property {(rid:string, boxA:string) => Promise<void>} offer      A -> relay   (POST /pair/offer)
 * @property {(rid:string) => Promise<string|null>} get              relay -> B   (GET  /pair/:rid)
 * @property {(rid:string, boxB:string) => Promise<void>} answer     B -> relay   (POST /pair/answer)
 * @property {(rid:string) => Promise<string|null>} poll             relay -> A
 * @property {(rid:string, blob:string) => Promise<void>} deliver    A -> relay   (POST /pair/deliver)
 * @property {(rid:string) => Promise<string|null>} fetchDelivery    relay -> B
 * @property {(rid:string) => Promise<void>} reportFailedOpen        §6.2's client-reported burn
 * @property {() => Object} transcript                               everything the relay ever held
 */

function baseTranscript() {
  return { offers: [], answers: [], deliveries: [], gets: 0, polls: 0, fetches: 0, failedOpens: 0, burned: false };
}

/**
 * A correct relay that is still UNTRUSTED. It enforces §6.2's three operational controls — the
 * 180 s TTL, single use, and the burn after five reported failed opens — and it keeps every byte
 * it ever held, so a test can assert what it did and did not learn.
 *
 * ⚠ §6.2 SAYS "5 FAILED DECRYPTS PER rid" AND THE RELAY CANNOT SEE A DECRYPT. It holds no key.
 * So the counter is necessarily client-reported: the new device tells the relay that the box did
 * not open, and the relay burns the rendezvous on the fifth report. That is modelled faithfully
 * here — including its consequence, which is that anyone who knows a rid can burn it. Knowing a
 * rid means knowing the code, so the DoS is bounded by the same secret; it is noted rather than
 * fixed because fixing it is WP-7's call, not this helper's.
 *
 * @param {{now:() => number, ttlMs?:number, maxFailedOpens?:number}} opts
 */
export function honestRelay({ now, ttlMs = 180000, maxFailedOpens = 5 }) {
  const sessions = new Map();
  const t = baseTranscript();

  const live = (rid) => {
    const s = sessions.get(rid);
    if (!s) return null;
    if (s.burned) return null;
    if (now() - s.createdAt > ttlMs) return null;
    return s;
  };

  return {
    async offer(rid, boxA) {
      if (sessions.has(rid)) throw new Error('relay: rid already offered — single use (§6.2)');
      sessions.set(rid, { createdAt: now(), boxA, boxB: null, delivery: null, failed: 0, burned: false, consumed: false });
      t.offers.push({ rid, boxA });
    },
    async get(rid) {
      t.gets += 1;
      return live(rid)?.boxA ?? null;
    },
    async answer(rid, boxB) {
      const s = live(rid);
      if (!s) throw new Error('relay: no live rendezvous');
      if (s.boxB) throw new Error('relay: already answered — single use (§6.2)');
      s.boxB = boxB;
      t.answers.push({ rid, boxB });
    },
    async poll(rid) {
      t.polls += 1;
      return live(rid)?.boxB ?? null;
    },
    async deliver(rid, blob) {
      const s = live(rid);
      if (!s) throw new Error('relay: no live rendezvous');
      s.delivery = blob;
      t.deliveries.push({ rid, blob });
    },
    async fetchDelivery(rid) {
      t.fetches += 1;
      const s = live(rid);
      if (!s || s.consumed) return null;
      s.consumed = true;         // §6.2 single use: the rendezvous is burned once consumed
      s.burned = true;
      return s.delivery;
    },
    async reportFailedOpen(rid) {
      t.failedOpens += 1;
      const s = sessions.get(rid);
      if (!s) return;
      s.failed += 1;
      if (s.failed >= maxFailedOpens) {
        s.burned = true;
        t.burned = true;
      }
    },
    transcript: () => t,
  };
}

/**
 * **T4 in full — the adversary ADR 002 §0 names and §6.4 prices.**
 *
 * This relay KNOWS THE PAIRING CODE. That is the worst case, and it is the case the whole design
 * is aimed at: shoulder-surfed, read out over a channel the attacker can hear, or recovered by
 * §6.4's 2^60 offline attack on box_A. Knowing the code, it can open both boxes and re-seal them,
 * so it substitutes a DIFFERENT ephemeral public key toward each side:
 *
 *     A  ──A_eph──►  [ M_a … M_b ]  ──M_a──►  B
 *     A  ◄──M_b───   [           ]  ◄─B_eph──  B
 *
 *     A agrees with M_b        S_A = ECDH(a, M_b)      = ECDH(m_b, A_eph)   ← the relay has it
 *     B agrees with M_a        S_B = ECDH(b, M_a)      = ECDH(m_a, B_eph)   ← and this one
 *
 * Both sides now hold a real shared secret with the RELAY, and none with each other. Everything
 * downstream — the delivery `kek`, the whole key ring — is readable by the relay. There is
 * exactly one thing standing in the way:
 *
 *     A's SAS = decimal6(HKDF(S_A ‖ A_eph ‖ M_b ))
 *     B's SAS = decimal6(HKDF(S_B ‖ M_a  ‖ B_eph))
 *
 * different secrets over different transcripts, therefore different digits, therefore a human
 * looking at two screens on one desk sees two different numbers. The attacker's only remaining
 * move is to guess six digits — 10^-6, once, with no offline path, before the human looks.
 *
 * `sasSeenBy('A')` / `sasSeenBy('B')` let a test assert the divergence from the ATTACKER's side
 * as well as from the victims', and `decryptDelivery()` proves what it would have won.
 *
 * `code` may be a string or a zero-argument function, because the attacker usually learns it a
 * moment AFTER the session that will use it was constructed — `drivePairing`'s `learnCode` hook
 * models exactly that: the digits go up on the first Mac's screen and the attacker reads them.
 *
 * @param {{code:string|(() => string), now:() => number, ttlMs?:number,
 *          reuseOneEphemeral?:boolean}} opts
 */
export function activeMitm({ code, now, ttlMs = 180000, reuseOneEphemeral = false }) {
  const t = baseTranscript();
  let ck = null;
  let rid = null;
  let createdAt = null;
  let mToB = null;      // the ephemeral the relay shows to B, standing in for A
  let mToA = null;      // the ephemeral the relay shows to A, standing in for B
  let aEphRaw = null;   // what A really sent
  let bEphRaw = null;   // what B really sent
  let boxAToB = null;
  let boxBToA = null;
  let delivery = null;
  let reEncrypted = null;

  async function ensure(ridIn) {
    if (ck === null) {
      const d = await attackerDerive(typeof code === 'function' ? code() : code);
      ck = d.ck;
      rid = d.rid;
      if (ridIn && ridIn !== rid) throw new Error('activeMitm: the rid does not match the code it was given');
    }
  }

  return {
    async offer(ridIn, boxA) {
      await ensure(ridIn);
      createdAt = now();
      t.offers.push({ rid: ridIn, boxA });
      const opened = await attackerOpen(ck, 'offer', ridIn, boxA);
      if (!opened) throw new Error('activeMitm: could not open box_A — the code it was given is wrong');
      aEphRaw = ub64(opened.aEph);
      mToB = await ephemeral();
      mToA = reuseOneEphemeral ? mToB : await ephemeral();
      // Everything else in box_A is passed through untouched: the relay wants B to believe it is
      // talking to the real member, and A's device id and member id are exactly what sell that.
      boxAToB = await attackerSeal(ck, 'offer', ridIn, { ...opened, aEph: b64u(mToB.raw) });
    },
    async get(ridIn) {
      t.gets += 1;
      if (createdAt !== null && now() - createdAt > ttlMs) return null;
      return boxAToB;
    },
    async answer(ridIn, boxB) {
      t.answers.push({ rid: ridIn, boxB });
      const opened = await attackerOpen(ck, 'answer', ridIn, boxB);
      if (!opened) throw new Error('activeMitm: could not open box_B');
      bEphRaw = ub64(opened.bEph);
      boxBToA = await attackerSeal(ck, 'answer', ridIn, { ...opened, bEph: b64u(mToA.raw) });
    },
    async poll() {
      t.polls += 1;
      return boxBToA;
    },
    async deliver(ridIn, blob) {
      t.deliveries.push({ rid: ridIn, blob });
      delivery = blob;
      // A full MITM does not merely READ the transfer; it re-seals it under the secret it shares
      // with B so that the pairing appears to succeed and the attacker is now one of my devices.
      const sA = await agree(mToA.priv, aEphRaw);
      const sB = await agree(mToB.priv, bEphRaw);
      const kekA = await hkdfAesKey(sA, ATTACKER_LABELS.kek);
      const kekB = await hkdfAesKey(sB, ATTACKER_LABELS.kek);
      const payload = await attackerOpen(kekA, 'deliver', ridIn, blob);
      if (payload) reEncrypted = await attackerSeal(kekB, 'deliver', ridIn, payload);
    },
    async fetchDelivery() {
      t.fetches += 1;
      return reEncrypted;
    },
    async reportFailedOpen() {
      t.failedOpens += 1;
    },
    transcript: () => t,

    /** What the six digits look like on one side's screen, computed by the ATTACKER. */
    async sasSeenBy(side) {
      if (side === 'A') return attackerSas(await agree(mToA.priv, aEphRaw), aEphRaw, mToA.raw);
      if (side === 'B') return attackerSas(await agree(mToB.priv, bEphRaw), mToB.raw, bEphRaw);
      throw new Error("sasSeenBy: 'A' or 'B'");
    },

    /** The prize, if the humans do not compare. `null` if no delivery was ever made. */
    async decryptDelivery() {
      if (delivery === null) return null;
      const kekA = await hkdfAesKey(await agree(mToA.priv, aEphRaw), ATTACKER_LABELS.kek);
      return attackerOpen(kekA, 'deliver', rid, delivery);
    },

    /** True once the relay has substituted a key toward at least one side. */
    substituted: () => mToA !== null || mToB !== null,
  };
}

/**
 * **T4 without the code — the realistic hostile-Wi-Fi case.**
 *
 * This is the attacker §6.4 calls "passive relay … safe": it sees `rid`, two ciphertexts and
 * nothing else. `ck` is out of reach, and both ephemeral public keys are INSIDE the boxes, so it
 * cannot substitute a key at all. Its entire repertoire is corruption, and corruption fails
 * closed: an AES-GCM tag check is not a warning.
 *
 * `flip` says which message to corrupt and by how much; `drop` says which to withhold entirely.
 *
 * @param {{flip?:'offer'|'answer'|'deliver'|null, drop?:'offer'|'answer'|'deliver'|null}} [opts]
 */
export function blindMitm({ flip = null, drop = null } = {}) {
  const t = baseTranscript();
  let boxA = null;
  let boxB = null;
  let delivery = null;

  /** Flip one bit in the ciphertext half, leaving the framing intact. */
  const corrupt = (box) => {
    const dot = box.indexOf('.');
    const ct = ub64(box.slice(dot + 1));
    ct[Math.floor(ct.length / 2)] ^= 0x01;
    return `${box.slice(0, dot)}.${b64u(ct)}`;
  };

  return {
    async offer(rid, box) { t.offers.push({ rid, box }); boxA = flip === 'offer' ? corrupt(box) : box; },
    async get() { t.gets += 1; return drop === 'offer' ? null : boxA; },
    async answer(rid, box) { t.answers.push({ rid, box }); boxB = flip === 'answer' ? corrupt(box) : box; },
    async poll() { t.polls += 1; return drop === 'answer' ? null : boxB; },
    async deliver(rid, blob) { t.deliveries.push({ rid, blob }); delivery = flip === 'deliver' ? corrupt(blob) : blob; },
    async fetchDelivery() { t.fetches += 1; return drop === 'deliver' ? null : delivery; },
    async reportFailedOpen() { t.failedOpens += 1; },
    transcript: () => t,
    /** Everything this attacker ever holds is ciphertext. Proving that is the point. */
    heldPlaintext: () => null,
  };
}

/**
 * A relay that records a transcript and re-serves it.
 *
 * Three distinct replays, because they fail for three different reasons and a test that only
 * tried one would not know which check was carrying it:
 *   `crossSlot`    serve box_A where box_B is expected. The AAD binds the SLOT, so the tag fails.
 *   `crossRid`     serve a box from another rendezvous. The AAD binds the RID, so the tag fails.
 *   `reserve`      serve the same delivery twice. The SESSION is single-use, so the second call
 *                  finds a terminal state — this one is not a crypto check at all, and that is
 *                  exactly why it is worth asserting separately.
 *
 * @param {{mode:'crossSlot'|'crossRid'|'replayDelivery', foreign?:Object}} opts
 */
export function replayRelay({ mode, foreign = null }) {
  const t = baseTranscript();
  let boxA = null;
  let boxB = null;
  let delivery = null;

  return {
    async offer(rid, box) { t.offers.push({ rid, box }); boxA = box; },
    async get() {
      t.gets += 1;
      if (mode === 'crossRid' && foreign?.boxA) return foreign.boxA;
      return boxA;
    },
    async answer(rid, box) { t.answers.push({ rid, box }); boxB = box; },
    async poll() {
      t.polls += 1;
      if (mode === 'crossSlot') return boxA;          // the offer, offered as an answer
      if (mode === 'crossRid' && foreign?.boxB) return foreign.boxB;
      return boxB;
    },
    async deliver(rid, blob) { t.deliveries.push({ rid, blob }); delivery = blob; },
    async fetchDelivery() { t.fetches += 1; return delivery; },   // always re-serves
    async reportFailedOpen() { t.failedOpens += 1; },
    transcript: () => t,
    recorded: () => ({ boxA, boxB, delivery }),
  };
}

/**
 * A relay that rewrites what it can reach.
 *
 * There is no downgrade-negotiation surface in this protocol (ADR 002 §1), so a downgrade is not
 * a matter of offering a weaker option — there is none to offer. What is left to an attacker is
 * to lie about the version or the slot, and both of those live in the AAD, which is never
 * transmitted: the receiver reconstructs it from what it EXPECTS. So the lie cannot be told at
 * all, and the attempt shows up as a tag failure.
 *
 * `swapSlotLabels` re-seals a box under the AAD of a different slot — the strongest form of this
 * attack available to someone who has the code, and the reason the slot is in the AAD.
 *
 * @param {{code?:string|null, mode:'swapSlotLabels'|'bumpVersion'}} opts
 */
export function downgradeRelay({ code = null, mode }) {
  const t = baseTranscript();
  let ck = null;
  let rid = null;
  let boxA = null;
  let boxB = null;
  let delivery = null;

  const ensure = async () => {
    if (ck === null && code) {
      const d = await attackerDerive(code);
      ck = d.ck;
      rid = d.rid;
    }
  };

  return {
    async offer(ridIn, box) {
      await ensure();
      t.offers.push({ rid: ridIn, box });
      boxA = box;
      if (!ck) return;
      const opened = await attackerOpen(ck, 'offer', ridIn, box);
      if (!opened) return;
      if (mode === 'bumpVersion') boxA = await attackerSeal(ck, 'offer', ridIn, { ...opened, v: 2 });
      if (mode === 'swapSlotLabels') boxA = await attackerSeal(ck, 'answer', ridIn, opened);
    },
    async get() { t.gets += 1; return boxA; },
    async answer(ridIn, box) {
      t.answers.push({ rid: ridIn, box });
      boxB = box;
      if (!ck) return;
      const opened = await attackerOpen(ck, 'answer', ridIn, box);
      if (!opened) return;
      if (mode === 'bumpVersion') boxB = await attackerSeal(ck, 'answer', ridIn, { ...opened, v: 2 });
      if (mode === 'swapSlotLabels') boxB = await attackerSeal(ck, 'offer', ridIn, opened);
    },
    async poll() { t.polls += 1; return boxB; },
    async deliver(ridIn, blob) { t.deliveries.push({ rid: ridIn, blob }); delivery = blob; },
    async fetchDelivery() { t.fetches += 1; return delivery; },
    async reportFailedOpen() { t.failedOpens += 1; },
    transcript: () => t,
    rid: () => rid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The online-guessing budget — §6.4's numbers, computed rather than asserted
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far an online attacker gets against the code inside one 180-second window, under one of
 * the published rate limits.
 *
 * This exists so the brute-force test asserts ARITHMETIC over the ADR's own numbers rather than
 * an opinion about what "effectively impossible" means. If someone later shortens the code, or
 * loosens the limiter, the number moves and the test says by how much.
 *
 * @param {{ttlSeconds?:number, codeBits?:number, ratePerHour?:number, ratePerMinute?:number}} opts
 * @returns {{guesses:number, space:number, probability:number}}
 */
export function bruteForceBudget({ ttlSeconds = 180, codeBits = 60, ratePerHour = null, ratePerMinute = null }) {
  if (ratePerHour === null && ratePerMinute === null) {
    throw new Error('bruteForceBudget: give a rate');
  }
  const perSecond = ratePerHour !== null ? ratePerHour / 3600 : ratePerMinute / 60;
  const guesses = Math.floor(perSecond * ttlSeconds);
  const space = 2 ** codeBits;
  return { guesses, space, probability: guesses / space };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Driving a full pairing over any of the transports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run ADR 002 §6.3 end to end over an arbitrary transport, with the human's answer supplied by
 * the caller.
 *
 * `humanCompares` is the whole experiment. Passing the default — a real comparison of the two
 * screens — is the honest run. Passing `() => true` is the "an agent simplified pairing by
 * auto-confirming" run that ADR 002 §6.4's boxed warning describes, and the tests use it to show
 * exactly what that costs.
 *
 * Returns everything an assertion could want, and never throws for a protocol refusal: the
 * refusal IS the result.
 *
 * `learnCode` is the shoulder-surf: it is called with the pairing code the instant the first Mac
 * puts it on screen, before anything is posted. That is precisely how a §6.4 active MITM comes
 * by the code, and giving the attacker the code for free is the right default posture — the SAS
 * is supposed to hold even then, and a test that withheld the code would be testing the easy
 * case.
 *
 * @param {{A:Object, B:Object, transport:Object,
 *          humanCompares?:(sasA:string, sasB:string) => boolean,
 *          learnCode?:(code:string) => void, payload?:Object}} run
 */
export async function drivePairing({ A, B, transport, humanCompares = (x, y) => x === y, learnCode, payload }) {
  const out = {
    sasA: null, sasB: null, sasMatched: null, delivered: null, restored: null,
    error: null, errorCode: null, stateA: null, stateB: null, rid: null, code: null,
  };
  try {
    const offered = await A.beginAsExisting();
    out.rid = offered.rid;
    out.code = offered.code;
    if (learnCode) learnCode(offered.code);
    await transport.offer(offered.rid, offered.boxA);

    const seen = await transport.get(offered.rid);
    if (seen === null) throw new Error('transport: the offer was withheld');
    const answered = await B.answerAsNew(offered.display, seen);
    await transport.answer(answered.rid, answered.boxB);

    const polled = await transport.poll(offered.rid);
    if (polled === null) throw new Error('transport: the answer was withheld');
    out.sasA = (await A.confirmExisting(polled)).sas;
    out.sasB = (await B.confirmNew()).sas;

    out.sasMatched = humanCompares(out.sasA, out.sasB) === true;
    A.confirmSasMatch(out.sasMatched);
    B.confirmSasMatch(out.sasMatched);

    const blob = await A.deliver(payload);
    out.delivered = blob;
    await transport.deliver(offered.rid, blob);

    const got = await transport.fetchDelivery(offered.rid);
    if (got === null) throw new Error('transport: the delivery was withheld');
    out.restored = await B.receive(got);
  } catch (err) {
    out.error = err;
    out.errorCode = err && err.code ? err.code : null;
  }
  out.stateA = A.state();
  out.stateB = B.state();
  return out;
}
