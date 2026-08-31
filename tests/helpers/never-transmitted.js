// tests/helpers/never-transmitted.js — ADR 004 §10.1's end-to-end leak test, as a recorder.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS IS, IN ADR 004's OWN WORDS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   > The fleet harness records, per device: EVERY PRE-SEAL PLAINTEXT handed to `sealOp`, EVERY
//   > SEALED BYTE handed to the transport, and EVERY STORED SERVER ENVELOPE. Then:
//   >
//   >     fleet.assertNeverTransmitted('Zahnarzt', { except: ['papa-desktop', 'papa-laptop'] });
//   >
//   > It fails if the UTF-8 of the string appears in any recorded plaintext or any sealed byte
//   > outside the excepted devices, AND it additionally decrypts the whole family log with EACH
//   > EPOCH KEY and fails if any resulting object carries a key outside the level's allowlist.
//   >
//   > This is the only check in the design that covers the whole pipeline — projection,
//   > assertion, sealing, transport, storage and decryption — rather than one stage of it.
//   > **Run it in every Belegt scenario.**
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY IT IS HERE AND NOT IN `fleet.js`, WHICH IS WHERE ADR 005 §1.1 NAMES IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `tests/helpers/fleet.js` is M1's fleet: ONE member with several Macs, over a PERSONAL space.
// Its `createFleet()` mints one `psp_…`, its identity gate asserts `new Set(memberIds).size === 1`
// ("M1 is ONE member with several Macs"), and nothing in it can express a Familienkreis. Every
// clause above is about the FAMILY log, so putting the function there would mean either a second
// fleet inside the first or an assertion with nothing to assert against.
//
// So it is a RECORDER rather than a method: anything that seals through `crypto/envelope.js` can
// hand it what it sealed, and the assertion is the same wherever the ops came from. `fleet.js`
// can adopt it the day it grows a family space, by handing its own recordings to the same
// function. Reported as an ADR 005 §1.1 gap rather than papered over.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE THREE HALVES, AND WHY EACH IS A DIFFERENT CLAIM
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//  1. THE PRE-SEAL PLAINTEXT is what the projection produced. A hit here means the redaction
//     boundary let the string through — the barrier failed, and the crypto below it is irrelevant
//     because it is about to encrypt a secret it was never given the right to hold.
//
//  2. THE SEALED BYTES are what the transport carried. A hit here after a clean (1) means
//     something OUTSIDE the projection put the string on the wire: an unencrypted field, a header,
//     a debug echo, a second path. It is astronomically unlikely to fire through AES-GCM, and
//     that is exactly why it is worth running — it is the check that catches the path that did
//     not go through AES-GCM at all.
//
//  3. THE DECRYPTION WITH EVERY EPOCH KEY is the only one of the three that can see a leak the
//     other two structurally cannot: a field that IS encrypted, correctly, and should never have
//     been in the object. It reads every envelope back under every key the family has ever held —
//     because "the current epoch is clean" is not the claim; the claim is that the LOG is clean,
//     and a log outlives its keys (ADR 002 §4).
//
// Zero npm dependencies. No `node:fs`. Nothing here reaches the network.

import { openOp } from '../../src/js/crypto/envelope.js';

const TE = new TextEncoder();

/** `b64url -> Uint8Array`, total: a malformed field is "no bytes", never a throw. */
function unb64u(s) {
  if (typeof s !== 'string') return new Uint8Array(0);
  const pad = s.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return new Uint8Array(0); }
}

/** Does `hay` contain the byte sequence `needle`? A plain scan — the honest form of the claim. */
function containsBytes(hay, needle) {
  if (needle.length === 0 || hay.length < needle.length) return false;
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * ADR 004 §2's allowlists, TRANSCRIBED FROM THE ADR'S PRINTED CODE BLOCK, not imported.
 *
 * Importing `core/project.js:GETEILT_FIELDS` would make this agree with the implementation by
 * construction: a mutant that widened the allowlist would widen this check in the same breath and
 * every row would stay green. The transcription is the independent statement, and
 * `tests/attack/redaction-invariants.test.js` asserts the two agree as its own row — so a
 * divergence is a failure rather than a silence, in whichever direction it happens.
 */
export const ADR_GETEILT_FIELDS = Object.freeze({
  fnote: Object.freeze(['pub.level', 'pub.alive', 'pub.date', 'pub.repeatsYearly', 'pub.coEdit', 'pub.text']),
  fbar: Object.freeze(['pub.level', 'pub.alive', 'pub.startDate', 'pub.endDate', 'pub.coEdit', 'pub.label']),
});
export const ADR_BELEGT_FIELDS = Object.freeze({
  fnote: Object.freeze(['pub.level', 'pub.alive', 'pub.date', 'pub.repeatsYearly']),
  fbar: Object.freeze(['pub.level', 'pub.alive', 'pub.startDate', 'pub.endDate']),
});
/** Not on either list, and legitimately present: write-once, a stamp, never content (§5). */
export const ADR_STRUCTURAL_FIELDS = Object.freeze(['_born']);

/**
 * The one recorder. Every device that seals hands it what it sealed; the assertions read the
 * whole tape.
 *
 * @returns {{
 *   preSeal: (device: string, op: Object) => void,
 *   sealedBytes: (device: string, env: Object) => void,
 *   stored: (env: Object) => void,
 *   tape: () => Object,
 *   assertNeverTransmitted: (secret: string, opts?: Object) => void,
 * }}
 */
export function createWireRecorder() {
  /** @type {Array<{device:string, op:Object, json:string}>} */
  const plaintexts = [];
  /** @type {Array<{device:string, env:Object, json:string}>} */
  const sealed = [];
  /** @type {Array<Object>} the relay's own copy — a THIRD tape, because a relay that stores more
   *  than it was handed is precisely a thing worth being able to catch. */
  const server = [];

  return {
    preSeal(device, op) {
      plaintexts.push({ device, op, json: JSON.stringify(op) });
    },
    sealedBytes(device, env) {
      sealed.push({ device, env, json: JSON.stringify(env) });
    },
    stored(env) { server.push(env); },
    tape: () => ({ plaintexts, sealed, server }),

    /**
     * @param {string} secret the UTF-8 string that must not have left the excepted devices
     * @param {Object} [opts]
     * @param {string[]} [opts.except] devices that are ALLOWED to hold it in plaintext — the
     *   author's own Macs. An empty list is the strictest form and the default.
     * @param {Array<[string, number, CryptoKey]>} [opts.epochKeys] every `(spaceId, epoch, key)`
     *   the family has ever held. Required for half 3; omitting it makes the function say so
     *   rather than silently skipping the only half that can see an encrypted leak.
     * @param {(dv:string) => Object|null} [opts.attestationOf] `openOp`'s P1 input.
     * @param {(msg:string) => void} [opts.fail] how to report. Defaults to `throw`.
     */
    assertNeverTransmitted(secret, opts = {}) {
      const fail = opts.fail || ((m) => { throw new Error(`assertNeverTransmitted: ${m}`); });
      const except = new Set(opts.except || []);
      const needle = TE.encode(secret);

      // ── HALF 1 — the pre-seal plaintext ────────────────────────────────────────────────────
      for (const rec of plaintexts) {
        if (except.has(rec.device)) continue;
        if (rec.json.includes(secret)) {
          fail(`${JSON.stringify(secret)} is in a PRE-SEAL PLAINTEXT handed to sealOp on ${rec.device}: `
            + `${rec.op.k} ${rec.op.e} ${rec.json.slice(0, 400)}. The redaction boundary let it `
            + 'through — INV-R1 (ADR 004 §2).');
        }
      }

      // ── HALF 2 — the sealed bytes, and the stored envelopes ────────────────────────────────
      // Searched as BYTES rather than as a substring of the JSON, because the ciphertext is
      // base64url and a leak that arrived as raw bytes would not be a substring of anything.
      for (const rec of sealed) {
        if (except.has(rec.device)) continue;
        if (rec.json.includes(secret)) {
          fail(`${JSON.stringify(secret)} is in a SEALED ENVELOPE's own JSON on ${rec.device} — `
            + 'a field outside the ciphertext carries it.');
        }
        for (const field of ['ct', 'iv', 'sig', 'wit', 'oid', 'dv', 'sp']) {
          const v = rec.env[field];
          if (typeof v !== 'string') continue;
          if (containsBytes(unb64u(v), needle)) {
            fail(`${JSON.stringify(secret)} is in the raw bytes of \`${field}\` on ${rec.device}. `
              + 'Something on this path did not go through AES-GCM.');
          }
        }
      }
      for (const env of server) {
        if (JSON.stringify(env).includes(secret)) {
          fail(`${JSON.stringify(secret)} is in a STORED SERVER ENVELOPE. The relay holds it in `
            + 'the clear (ADR 003 §6.3, ADR 002 §8).');
        }
      }

      // ── HALF 3 — decrypt the whole family log with EVERY epoch key ─────────────────────────
      if (!opts.epochKeys) {
        fail('no `epochKeys` were supplied, so the only half that can see an ENCRYPTED leak did '
          + 'not run. ADR 004 §10.1 requires it: "it additionally decrypts the whole family log '
          + 'with each epoch key". Pass every (spaceId, epoch, key) the family has held.');
      }
      return { plaintexts: plaintexts.length, sealed: sealed.length, stored: server.length };
    },

    /**
     * Half 3, alone, because it is `async` and half 1 and 2 are not. Callers `await` it beside the
     * synchronous halves; keeping them separate is what lets `assertNeverTransmitted` be called
     * from a synchronous assertion without every caller becoming a promise.
     *
     * @param {Array<[string, number, CryptoKey]>} epochKeys every key the family has ever held
     * @param {(dv:string) => Object|null} attestationOf
     * @returns {Promise<{opened:number, attempts:number, offList:string[]}>}
     */
    async decryptWithEveryEpochKey(epochKeys, attestationOf) {
      const offList = [];
      let opened = 0;
      let attempts = 0;
      for (const rec of sealed) {
        for (const [, , key] of epochKeys) {
          attempts++;
          // A ring that answers THIS KEY for whatever the envelope asks for. That is what makes it
          // "with each epoch key" rather than "with the ring": a real ring resolves straight to the
          // envelope's own epoch every time, so the loop would try exactly one key per envelope and
          // prove nothing about the others. Here every key is tried against every envelope, and
          // the AAD (which binds `ep`) is what refuses the wrong ones — the refusal is the
          // product's, not the harness's.
          const oneKey = { get: () => key };
          let out;
          try { out = await openOp(rec.env, oneKey, attestationOf, {}); } catch { continue; }
          if (!out || out.status !== 'opened') continue;
          opened++;
          const op = out.op;
          if (op.k !== 'pub.set') continue;
          const kind = String(op.e).split(':')[0];
          const allow = ADR_GETEILT_FIELDS[kind];
          if (!allow) { offList.push(`${op.e}: not a family kind`); continue; }
          const permitted = new Set([...allow, ...ADR_STRUCTURAL_FIELDS]);
          for (const k of Object.keys(op.f || {})) {
            if (!permitted.has(k)) offList.push(`${op.id} ${op.e}: "${k}" is outside the allowlist`);
          }
          // …and the level's own half of it: below `geteilt`, a content field may hold NOTHING
          // but an explicit null.
          const level = op.f['pub.level'];
          if (level !== 'geteilt') {
            for (const k of ['pub.text', 'pub.label']) {
              if (Object.hasOwn(op.f, k) && op.f[k] !== null) {
                offList.push(`${op.id} ${op.e}: a ${level} op carries "${k}" = ${JSON.stringify(op.f[k])}`);
              }
            }
          }
        }
      }
      return { opened, attempts, offList };
    },
  };
}
