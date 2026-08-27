// src/js/crypto/probe.js — the capability probe.  ADR 002 §1 ("a guard, not a gate"), §9.1.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHEN THIS RUNS — AND THE ONE RULE ABOUT IT THAT IS NOT NEGOTIABLE
// ─────────────────────────────────────────────────────────────────────────────
//
// `probeCrypto()` runs at the moment the user first touches
//
//     „Familienkreis erstellen"   „Familienkreis beitreten"   „Gerät koppeln"
//
// and NOWHERE ELSE. **Never in solo mode. Never on first run.** (Principle 7, story 15.1,
// ADR 002 §1 and §2.4.) Solo mode must not get one instruction heavier because family mode
// exists — the first-run screen mints a `memberId` and a `deviceShort` and generates no keys,
// makes no network request, and does not probe anything.
//
// That is a real rule with a real failure mode, so it is enforced mechanically rather than
// remembered: `tests/tier1/crypto-identity.test.js` walks the import graph of `boot.js` and
// `firstrun.js` and fails if anything under `src/js/crypto/` is reachable from either. Calling
// this from a boot path is therefore a red test, not a code review comment.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A PROBE AT ALL, GIVEN THE SUITE HAS SHIPPED SINCE SAFARI 11
// ─────────────────────────────────────────────────────────────────────────────
//
// Because the failure it catches is not "an old Safari" — it is an INSECURE CONTEXT. WebCrypto's
// `crypto.subtle` is `undefined` outside a secure context, and the shipping shell's
// `app://localhost` scheme is secure (verified: `isSecureContext === true` in the real
// WKWebView) while a plain `file://` or `http://` dev serve is not. A developer, or a future
// packaging change, can silently move the app into a context where every family feature would
// fail at its second step with an unreadable TypeError. The probe turns that into one plain
// German sentence at the door, with solo mode completely unaffected.
//
// It is ~1 ms: five key operations, none of them a PBKDF2 at production cost (the PBKDF2 row
// runs 1 000 iterations, not 600 000 — it is asking whether the algorithm EXISTS).
//
// ─────────────────────────────────────────────────────────────────────────────
// RULE 3 LIVES HERE: NEVER BRANCH ON ERROR NAMES
// ─────────────────────────────────────────────────────────────────────────────
//
// Node says `InvalidAccessException` where WebKit says `InvalidAccessError`; both engines throw
// differently-shaped things for a missing algorithm. So every row below is a bare
// `try { ...; return true } catch { return false }` — a try/catch BOUNDARY, never a name test.
// The probe reports booleans and never reports a reason drawn from an engine's error text.

import { SUITE_ID, SIG, KEX, AEAD, KDF, BACKUP_KDF } from './suite.js';

/** The five primitives `LZP-CRYPTO-1` needs. Reported in this order, and gated as a set. */
export const PROBE_ROWS = Object.freeze(['aesgcm', 'hkdf', 'pbkdf2', 'ecdsa', 'ecdh']);

/** Cheap enough to be honest about, expensive enough to prove PBKDF2 exists. */
const PROBE_PBKDF2_ITERATIONS = 1000;

/**
 * @typedef {Object} ProbeResult
 * @property {boolean} ok       there is a SubtleCrypto at all — this is ADR 002 §9.1's `ok`
 * @property {string}  [why]    present only when `ok` is false
 * @property {boolean} [aesgcm]
 * @property {boolean} [hkdf]
 * @property {boolean} [pbkdf2]
 * @property {boolean} [ecdsa]
 * @property {boolean} [ecdh]
 * @property {string}  suite    always `SUITE_ID` — the LZP-1003 self-audit records which suite
 * @property {boolean} usable   ok AND all five rows true. **THIS is the gate.**
 * @property {string[]} missing the rows that came back false, sorted; `[]` when usable
 */

/**
 * ~1 ms. A GUARD, not a gate.
 *
 * TWO BOOLEANS, DELIBERATELY, AND THE DIFFERENCE MATTERS:
 *   · `ok`     — "this engine has a SubtleCrypto". It is ADR 002 §9.1's field, kept with exactly
 *                that meaning so the ADR's snippet and this function cannot drift apart.
 *   · `usable` — "this engine can run `LZP-CRYPTO-1`". It is what the family entry point must
 *                branch on. A caller that gates on `ok` alone would enable family mode on an
 *                engine that has `crypto.subtle` and no ECDH, which is the exact silent failure
 *                this file exists to prevent.
 * `missing` names the rows that failed so the self-audit report (LZP-1003) can say which.
 *
 * @param {{subtle?:SubtleCrypto}} [ports] the SubtleCrypto to interrogate; defaults to the
 *        platform one. Injected so a test can hand it a crippled engine — which is the only way
 *        to characterize the "family entry point stays disabled" branch without an old Mac.
 * @returns {Promise<ProbeResult>}
 */
export async function probeCrypto(ports = {}) {
  const S = 'subtle' in ports ? ports.subtle : globalThis.crypto?.subtle;
  if (!S || typeof S.generateKey !== 'function' || typeof S.importKey !== 'function') {
    return Object.freeze({
      ok: false,
      why: 'no SubtleCrypto (insecure context?)',
      suite: SUITE_ID,
      usable: false,
      missing: [...PROBE_ROWS],
    });
  }

  // RULE 3: a try/catch boundary, and nothing read out of the error.
  const has = async (fn) => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };

  const rows = {
    aesgcm: await has(() => S.generateKey({ name: AEAD.name, length: AEAD.length }, false, ['encrypt'])),
    hkdf: await has(async () => {
      const k = await S.importKey('raw', new Uint8Array(32), KDF.name, false, ['deriveBits']);
      // RULE 4: salt is mandatory. Omitting it here would make the probe report `false` on a
      // perfectly good engine — a probe bug that reads as a platform verdict.
      return S.deriveBits(
        { name: KDF.name, hash: KDF.hash, salt: new Uint8Array(0), info: new Uint8Array(0) },
        k,
        256
      );
    }),
    pbkdf2: await has(async () => {
      const k = await S.importKey('raw', new Uint8Array(8), BACKUP_KDF.name, false, ['deriveBits']);
      return S.deriveBits(
        {
          name: BACKUP_KDF.name,
          hash: BACKUP_KDF.hash,
          salt: new Uint8Array(16),
          iterations: PROBE_PBKDF2_ITERATIONS,
        },
        k,
        256
      );
    }),
    ecdsa: await has(() => S.generateKey(SIG, false, ['sign', 'verify'])),
    ecdh: await has(() => S.generateKey(KEX, false, ['deriveBits'])),
  };

  const missing = PROBE_ROWS.filter((r) => !rows[r]);
  return Object.freeze({
    ok: true,
    ...rows,
    suite: SUITE_ID,
    usable: missing.length === 0,
    missing: Object.freeze(missing),
  });
}

/**
 * The single predicate the family entry point branches on. Exported so no call site has to
 * re-derive it — and so "gate on `ok`" cannot be written by accident.
 * @param {ProbeResult} result
 * @returns {boolean}
 */
export function isSuiteAvailable(result) {
  return !!result && result.ok === true && result.usable === true;
}

/**
 * The one plain sentence the family entry point shows when the probe fails (ADR 002 §1: "the
 * family entry point stays disabled with one plain German sentence; solo mode is completely
 * unaffected"). It deliberately does NOT name an algorithm: the user cannot act on "ECDH is
 * missing", and the honest content is (a) family sharing cannot start here and (b) NOTHING they
 * already have is affected.
 *
 * German first, per the product's language rule. The caller renders whichever the UI language is.
 * @param {ProbeResult} result
 * @returns {{de:string, en:string}}
 */
export function unavailableMessage(result) {
  const usable = isSuiteAvailable(result);
  if (usable) throw new Error('probe.unavailableMessage: the suite IS available — there is nothing to say');
  return Object.freeze({
    de:
      'Auf diesem Mac kann der Familienkreis nicht eingerichtet werden: die Verschlüsselung, ' +
      'die dafür nötig ist, steht hier nicht zur Verfügung. Dein Board und alle Einträge sind ' +
      'davon nicht betroffen und funktionieren wie bisher.',
    en:
      'A Familienkreis cannot be set up on this Mac: the encryption it needs is not available ' +
      'here. Your board and everything on it is unaffected and keeps working exactly as before.',
  });
}
