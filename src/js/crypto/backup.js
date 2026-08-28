// src/js/crypto/backup.js — backup v2, the recovery artifact.  LZP-305 · ADR 002 §7.2/§7.3 · A2.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2). This module builds and opens an OBJECT; it
// never reads a clock, never picks a filename, never opens a dialog and never writes a file. The
// day (`exportedAt`), the app version, the CSPRNG and the SubtleCrypto all arrive as injected
// ports, and the KeyStore is an interface. `src/js/backup.js` — the v1 UI file — is owned by
// another ticket and is not touched from here; the seam between the two is §7 at the bottom.
//
// ─────────────────────────────────────────────────────────────────────────────
// PO DECISION D8 — THE ONE RULE THIS FILE EXISTS TO ENFORCE
// ─────────────────────────────────────────────────────────────────────────────
//
//   The `identity` block is encrypted under a passphrase — PBKDF2-SHA-256, 600 000 iterations,
//   then AES-256-GCM — **or it is OMITTED ENTIRELY. It is NEVER written in plaintext.**
//
// Two of the three architectures reviewed for v2 shipped raw PKCS#8 recovery keys inside a file
// the onboarding actively tells the user to mail to themselves. That file is a complete, silent,
// permanent takeover of a member identity, sitting in a mail archive forever, and §8.12 records
// that a recovery key has no revocation and no leak detection — so there is no "and then we
// rotate it" to fall back on. This design refuses that outcome at the cost of one field in the
// export sheet.
//
// The rule is enforced three ways, deliberately overlapping:
//   1. there is exactly ONE place in this file that attaches `identity`, and it is downstream of
//      the seal (`sealIdentity`); the board-only path never constructs one;
//   2. `exportBackup` re-reads its own output before returning it and asserts that no secret it
//      just handled appears anywhere in the serialized file (`assertNoPlaintextSecrets`); and
//   3. `tests/tier1/crypto-backup.test.js` asserts the same thing from the outside, over the
//      bytes, for both paths.
// (2) is the one that matters: it is a check on the RESULT rather than on the code path, so a
// future refactor that adds a third path cannot slip past it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FILE (ADR 002 §7.2)
// ─────────────────────────────────────────────────────────────────────────────
//
//   {
//     "_README_de": "DIES IST DEIN SCHLÜSSEL. …",     ← says what it is, in both languages
//     "_README_en": "THIS FILE IS YOUR KEY. …",
//     "format": "langzeitplaner-backup", "v": 2,
//     "exportedAt": "2026-08-27", "app": "2.0.0",
//     "board": { "schemaVersion": 2, notes, bars, categories, scratchpads, settings, _v2 },
//     "identity": {                                   ← OMITTED ENTIRELY without a passphrase
//       "kdf": { "name":"PBKDF2", "hash":"SHA-256", "iterations":600000, "salt":"b64u32" },
//       "memberId": "mem_…",
//       "sealed": "b64u"
//     }
//   }
//
// A2 — WHOSE DATA IS IN IT. Mine. Private entries, my shared/Belegt entries WITH THEIR FLAGS,
// categories, settings, scratchpads. **Other members' entries are not exported**; they re-arrive
// via sync, and a backup that carried them would put a peer's plaintext into a file its owner is
// told to mail around. `ownBoardOnly()` enforces this here rather than trusting a caller to have
// filtered — the caller is a UI file and this is the last place with a memberId in scope.
//
// ─────────────────────────────────────────────────────────────────────────────
// FOUR THINGS ADR 002 §7.2 LEAVES OPEN, AND HOW THIS FILE RESOLVES THEM
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. **Where the AES-GCM IV lives.** §7.2 shows `sealed` as one b64url string and lists no `iv`
//    field, while §3's `WrapBlob` carries `{salt, iv, ct}` explicitly. Adding a field to a
//    normative shape is a wire-format change; choosing the encoding of one opaque string is not.
//    So: `sealed = b64u(iv ‖ ciphertext‖tag)`, IV first, exactly `AEAD.ivBytes` = 12 bytes of it.
//    `SEALED_IV_BYTES` and `unpackSealed()` are the only two places that know.
//
// 2. **Where `INFO.backup` ('lzp/v2/backup') is used.** §3 fixes it as part of the wire format,
//    and a label in a frozen wire-format list with no user is a label somebody deletes. §7.2's
//    "PBKDF2 → AES-256-GCM" is the stretching step; the derivation primitive §1 names is
//    HKDF-SHA-256. The chain is therefore
//        PBKDF2-SHA-256(passphrase, salt, iterations) → 256 bits
//          → HKDF-SHA-256(salt, info='lzp/v2/backup') → AES-256-GCM key
//    which keeps §7.2 true, gives the label a load-bearing job (change it and no file opens),
//    and is domain-separated from any other use of the same passphrase. It is DETERMINISTIC, so
//    unlike a signature it can be pinned by a golden vector — and it is, in the tier-1 file.
//
// 3. **What the AAD binds.** `aesgcm()` refuses an empty AAD (§1 rule 2 / §11 rule 3), so there
//    has to be one. It is `canonicalBytes` of the file's ENTIRE PLAINTEXT HEADER — both READMEs,
//    `format`, `v`, `exportedAt`, `app`, `identity.memberId`, every `identity.kdf` field **and a
//    SHA-256 digest of the whole `board` block**. Three consequences worth having: a `sealed`
//    blob cannot be relabelled under another member's id or re-stamped with a different
//    iteration count without the tag failing, the honesty copy in the header cannot be stripped
//    from a file that still opens, and — finding **S3** — **an identity-bearing file's entries
//    cannot be rewritten by whoever finds the file.**
//
//    **S3, and why the earlier answer was wrong.** E3-6 left the board unbound, and the argument
//    was: "the board-only file has no key at all, so board authentication could exist on only one
//    of the two paths, and a guarantee that holds on one path is worse than one stated plainly."
//    That is true OF THE BOARD-ONLY FILE and says nothing about the identity-bearing one. The
//    file that says „DIES IST DEIN SCHLÜSSEL" is the one an attacker goes looking for on the
//    family NAS, and half of it was unsigned: Mama rewrites `board.notes`, adds one, DELETES one,
//    puts the file back, Papa restores after a disk failure with HIS passphrase, and her board
//    comes back as his — with `identityRestored: true` beside it (M-B4). Two paths with two
//    DIFFERENT, STATED guarantees is not the failure the old argument feared; ONE path silently
//    weaker than the file's own README is. `LIMITS.board` now carries both sentences, separately,
//    in both languages, and `README.boardOnly` already tells the user which file she is holding.
//
//    THE DIGEST IS NOT A FIELD OF THE FILE, and that is deliberate. It is recomputed from
//    `file.board` on both sides and only ever appears inside the AAD, so there is nothing to
//    strip, nothing to downgrade, and no wire-format field to version. §7.2's `identity` shape is
//    unchanged; only the AAD's derivation is, and `sealAad()` is the single place that knows.
//
//    §7.2's other objection — "an export could fail on a board whose `settings` picked up a
//    float, since `canonicalJSON` refuses non-integers" — was a real cost and it is paid rather
//    than argued away: `boardDigestInput()` does NOT use `canonicalJSON`. It is a total function
//    over every value `JSON.stringify` can write, floats included, because losing a user's export
//    to a stray setting would be the worse failure. See its own comment for why it round-trips.
//
// 4. **How the recovery PUBLIC halves come back.** §7.2 seals `recSigPkcs8` / `recKexPkcs8`, and
//    PKCS#8 imports to a PRIVATE `CryptoKey` only — but every consumer needs a `CryptoKeyPair`.
//    Rather than add fields or parse DER by offset, the private key is re-exported as JWK (it is
//    extractable by construction, §2.1) and the public half is imported from the same `x`/`y`.
//    Then it is CHECKED, cryptographically, in both directions: a signature made by the restored
//    `RK_sig` private key must verify under the reconstructed public key, and an ECDH against an
//    ephemeral pair must agree from both sides. A reconstruction that is merely plausible is not
//    good enough for the one key that has no revocation.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ENGINE-DIFFERENCE RULES THIS FILE TOUCHES (ADR 002 §1, and §2 of the contract)
// ─────────────────────────────────────────────────────────────────────────────
//   rule 2 — nothing zero-length is ever sealed or opened; `assertSealable()` is the guard.
//   rule 3 — NOTHING here branches on an error name. A wrong passphrase and a tampered file both
//            arrive as "the AES-GCM tag did not verify", from a `try`/`catch` BOUNDARY, and are
//            reported as one honest code (`cannot-open`) because the crypto genuinely cannot
//            tell them apart. Node says `OperationError` and so does WebKit — and this file does
//            not look at either.
//   rule 4 — the HKDF salt is a required positional through `suite.hkdf(salt, label)`.
//   rule 6 — the recovery keys are wrapped with **AES-GCM**, never AES-KW: a P-256 PKCS#8 is 138
//            bytes, which is not a multiple of 8. Here they are not even `wrapKey`'d — they are
//            exported and encrypted as part of one canonical JSON payload, which is the same
//            arithmetic-free answer one layer up.
//   diff 9 — `importKey` of a PRIVATE EC key carries ONLY the private usages
//            (`USAGES.sigPrivate` / `USAGES.kexPrivate`); `verify` in the list is a `SyntaxError`
//            in both engines. This file is exactly the RESTORE path that trap was written about.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE DOES NOT DO
// ─────────────────────────────────────────────────────────────────────────────
//   · it does not apply the board — `importBackup` RETURNS one, and only on complete success.
//     Applying it is ADR 001 §5.4's diff transaction, through `store.replaceAll` (LZP-1004).
//     That is what "never half-applies" means here: there is no partial return.
//   · it does not POST `/api/v1/devices/adopt` (§7.3 step 5). It returns the attestation and the
//     blob; the request and its signature are ADR 003 §2's.
//   · it does not close finding I-3 / R5-7 and assumes nothing about it. The only attestation it
//     mints is a SELF-attestation over keys it just generated on this machine.

import { b64u, ub64, CodecError } from '../core/b64.js';
import { canonicalBytes, utf8, utf8Decode } from '../core/canon.js';
import { isMemberId, isSpaceId } from '../core/entities.js';
import { V1_ENTRY_FIELDS } from '../core/materialize.js';
import {
  AEAD,
  BACKUP_KDF,
  HASH,
  INFO,
  KDF,
  PKCS8_P256_BYTES,
  RAW_PUBKEY_BYTES,
  SALT_BYTES,
  SIG,
  KEX,
  SYMMETRIC_KEY_BYTES,
  USAGES,
  RECOVERY_KEY_EXTRACTABLE,
  aesgcm,
  hkdf,
  infoBytes,
  pbkdf2,
} from './suite.js';
import {
  KEYSTORE_IDS,
  defaultSubtle,
  ensureAttestedDevice,
  exportRawPublic,
  signBytes,
  verifyBytes,
} from './identity.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Ports
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} BackupPorts
 * @property {SubtleCrypto} [subtle] defaults to the platform SubtleCrypto
 * @property {(n:number) => Uint8Array} [random] defaults to `crypto.getRandomValues`
 * @property {number} [iterations] PBKDF2 rounds, for TESTS ONLY. Production is `BACKUP_KDF`'s
 *           600 000 and nothing in the app may pass this.
 */

const subtleOf = (ports) => (ports && ports.subtle) || defaultSubtle();

function randomOf(ports) {
  if (ports && typeof ports.random === 'function') return ports.random;
  return (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The shape of the file
// ─────────────────────────────────────────────────────────────────────────────

/** `BackupV2.format`. A file that does not say this is not one of ours. */
export const BACKUP_FORMAT = 'langzeitplaner-backup';

/** `BackupV2.v`. Bumping this is a wire-format change and needs a new ADR section. */
export const BACKUP_V = 2;

/** Resolution 1 above: the AES-GCM IV is the first 12 bytes of `identity.sealed`. */
export const SEALED_IV_BYTES = AEAD.ivBytes;

/**
 * An upper bound on `identity.sealed` before we even base64-decode it, so a hostile file cannot
 * make the app chew through a gigabyte of "ciphertext". Two P-256 PKCS#8 keys plus a few thousand
 * epoch keys fit inside a few hundred kilobytes; 1 MiB is generous by a wide margin.
 */
export const MAX_SEALED_B64_CHARS = 1024 * 1024;

/**
 * The iteration count `importBackup` will accept from a FILE.
 *
 * `kdf.iterations` is read from the file rather than assumed, because a file written by a future
 * build with a higher count must still open. It is also attacker-controlled input, and PBKDF2 is
 * a loop: `{"iterations": 1e12}` is a denial of service that looks exactly like a slow import. So
 * it is clamped, and the AAD binds the value, so tampering with the count on OUR file makes the
 * tag fail rather than the loop run.
 */
export const MAX_KDF_ITERATIONS = 10_000_000;

/**
 * The entry fields a v2 backup carries: v1's own product fields, plus the two TRUTH flags A2
 * asks for by name ("my shared/Belegt entries **with their flags**").
 *
 * WHY A WHITELIST AND NOT A BLACKLIST. `core/materialize.js`'s `stripV2Fields` argues it in full
 * and the argument is the same one here: a blacklist that misses a key LEAKS it into a file the
 * onboarding tells the user to mail to themselves, and a whitelist that misses a key LOSES it and
 * goes red the same day. Both are caught by a test; only one of them is a privacy incident, so
 * the strip is built to fail in the other direction. `V1_ENTRY_FIELDS` is imported rather than
 * re-typed so the two lists cannot drift apart.
 *
 * WHAT IS DELIBERATELY ABSENT, and why each one:
 *   `ownerId`     — a MemberId. It is mine, and it is already in `identity.memberId`; on the
 *                   board-only path there is no reason to put a stable personal identifier into a
 *                   file that carries no keys.
 *   `_born`       — its last 16 characters are this device's `deviceShort` fingerprint (ATT-80/81).
 *   `entityKey`   — carries the owner segment, same objection.
 *   `updatedBy`   — a device fingerprint.
 *   `level`       — what the FAMILY currently sees. It is a projection of the family space, not a
 *                   truth register, and a restored board that has not re-joined anything yet would
 *                   be asserting "others can see this" about a space it is not in. INV-R3 says the
 *                   owner sees the truth; `visibility` IS the truth, and re-publication follows
 *                   from re-joining, not from a stale copy in a file.
 *   `isForeign`, `redacted`, `memberColorRef`, `initial`, `exposure`, `isNew` — all derived, and
 *                   `isForeign` entries are dropped outright by A2 anyway.
 *   `createdAt` / `updatedAt` — derived from stamps that are not in the file.
 */
export const BACKUP_ENTRY_FIELDS = Object.freeze({
  note: Object.freeze([...V1_ENTRY_FIELDS.note, 'visibility', 'coEdit']),
  bar: Object.freeze([...V1_ENTRY_FIELDS.bar, 'visibility', 'coEdit']),
  cat: Object.freeze([...V1_ENTRY_FIELDS.cat]),
});

/** The five collections a board is made of, and the type each must have to count as one. */
const BOARD_SHAPE = Object.freeze([
  ['notes', Array.isArray],
  ['bars', Array.isArray],
  ['categories', Array.isArray],
  ['scratchpads', isPlainObject],
  ['settings', isPlainObject],
]);

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Copy — deliverable 24's honesty moment, in both languages
//
// The strings live HERE, next to the code paths they describe, and not in `i18n.js`, for one
// reason: they are the only place the product states the consequence of a choice the crypto makes
// irreversible. LZP-1003 audits STRINGS, not only code, and a string that drifts away from the
// branch it documents is exactly what that audit is looking for. `src/js/backup.js` (another
// ticket) renders them; it does not get to rewrite them.
//
// §7.4's copy contract governs everything here. Nothing below promises „gelöscht bei allen",
// „zurückgezogen", „niemand kann es mehr sehen" or „live", and nothing implies that losing the
// passphrase is recoverable — because it is not (§8.11, addendum §3's Option-B trade).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The file's own header comment. §7.2 fixes the German for the identity-bearing file verbatim;
 * this file keeps it word for word.
 *
 * THERE ARE TWO OF THEM, and that is a correction to §7.2 rather than an embellishment: writing
 * „DIES IST DEIN SCHLÜSSEL" across the top of a file that contains no key is a lie the user would
 * act on — she would guard it as if it restored her Familienkreis, and discover at the worst
 * possible moment that it does not. The board-only header says what that file actually is and
 * what it will not do.
 */
export const README = Object.freeze({
  withIdentity: Object.freeze({
    de:
      'DIES IST DEIN SCHLÜSSEL. Wer diese Datei und dein Passwort hat, ist du. Ohne diese Datei ' +
      'und ohne deine Macs sind die Daten unwiederbringlich — niemand sonst hat die Schlüssel.',
    en:
      'THIS FILE IS YOUR KEY. Whoever has this file and your password is you. Without this file ' +
      'and without your Macs the data is gone for good — nobody else holds the keys.',
  }),
  boardOnly: Object.freeze({
    de:
      'DIES IST EINE SICHERUNG DEINER EINTRÄGE — OHNE DEINE SCHLÜSSEL. Sie stellt dein Board ' +
      'wieder her, aber nicht deine Mitgliedschaft im Familienkreis: geht dein letzter Mac ' +
      'verloren, musst du neu eingeladen werden. Für eine vollständige Sicherung exportiere ' +
      'noch einmal mit Passwort.',
    en:
      'THIS IS A BACKUP OF YOUR ENTRIES — WITHOUT YOUR KEYS. It restores your board, but not ' +
      'your membership in the Familienkreis: if you lose your last Mac you have to be invited ' +
      'again. For a complete backup, export once more with a password.',
  }),
});

/**
 * The export sheet. **Two buttons, and neither is silent** (§7.2, D8).
 *
 * One line each saying what the user GETS and what they LOSE, plus the sentence the addendum
 * requires and the one D8 requires. The sheet itself is another ticket; this is its copy, and the
 * two `code` values are the two arguments `exportBackup` accepts for `passphrase` — a string, or
 * `null`. There is no third button and no default.
 */
export const EXPORT_SHEET_COPY = Object.freeze({
  title: Object.freeze({
    de: 'Backup erstellen',
    en: 'Create a backup',
  }),
  withPassword: Object.freeze({
    code: 'with-identity',
    label: Object.freeze({ de: 'Backup mit Passwort sichern', en: 'Protect the backup with a password' }),
    gain: Object.freeze({
      de: 'Stellt dein Board und deine Mitgliedschaft im Familienkreis wieder her — auch wenn kein Mac mehr da ist.',
      en: 'Restores your board and your membership in the Familienkreis — even if no Mac is left.',
    }),
    lose: Object.freeze({
      de: 'Das Passwort kann niemand zurücksetzen. Ist es weg, ist dieses Backup weg.',
      en: 'Nobody can reset the password. If it is gone, this backup is gone.',
    }),
    /** S3 — the guarantee this button buys that the other one does not. */
    sealsEntriesToo: Object.freeze({
      de: 'Auch die Einträge sind versiegelt: eine veränderte Datei lässt sich nicht mehr öffnen.',
      en: 'The entries are sealed too: an altered file no longer opens.',
    }),
  }),
  boardOnly: Object.freeze({
    code: 'board-only',
    label: Object.freeze({ de: 'Nur Einträge sichern', en: 'Back up entries only' }),
    gain: Object.freeze({
      de: 'Stellt dein Board wieder her — ohne Passwort, ohne Risiko, es zu vergessen.',
      en: 'Restores your board — no password, nothing to forget.',
    }),
    lose: Object.freeze({
      de: 'Deine Schlüssel sind nicht in der Datei: geht dein letzter Mac verloren, musst du dem Familienkreis neu beitreten.',
      en: 'Your keys are not in the file: if you lose your last Mac you have to join the Familienkreis again.',
    }),
    /** S3 — and the honest other half of it, on the button it is true of. */
    entriesNotSealed: Object.freeze({
      de: 'Ohne Passwort sind die Einträge nicht versiegelt: wer die Datei ändert, ändert dein Board.',
      en: 'Without a password the entries are not sealed: whoever edits the file edits your board.',
    }),
  }),
  /**
   * S7 — the passphrase field's own copy. **`hint` is shown BEFORE anything is typed**, because a
   * requirement that only appears as a rejection is a requirement the user argues with; `weak` is
   * shown when `passphraseStrength(pw).weak` is true, and it is a WARNING, not a wall.
   *
   * Deliberately not scolding, and deliberately concrete. „Mindestens 12 Zeichen" with a red
   * border produces „Sommer2026!" on a sticky note; three words the user already associates
   * produce something they can type and nobody can guess.
   */
  passphrase: Object.freeze({
    hint: Object.freeze({
      de:
        'Nimm drei Wörter, die nur du miteinander verbindest — „Kirschbaum-Sonntag-Regenschirm". '
        + 'Das ist leichter zu merken und deutlich schwerer zu raten als ein kurzes kompliziertes '
        + 'Passwort.',
      en:
        'Take three words only you connect — "cherry-tree-sunday-umbrella". Easier to remember '
        + 'and far harder to guess than a short complicated password.',
    }),
    weak: Object.freeze({
      de:
        'Dieses Passwort ist kurz genug, um durchprobiert zu werden. Diese Datei ist der '
        + 'Ersatzschlüssel für alles — hier ist ein längeres wirklich der Unterschied.',
      en:
        'This password is short enough to be guessed by brute force. This file is the spare key '
        + 'to everything — a longer one genuinely is the difference here.',
    }),
    /** Shown next to `weak`, so the user can decide rather than be told. */
    weakAnyway: Object.freeze({
      de: 'Trotzdem so sichern',
      en: 'Save it anyway',
    }),
  }),
  /** Addendum §3 — this is not an account password, and the sheet has to say so. */
  notAnAccount: Object.freeze({
    de:
      'Das ist kein Konto-Passwort. Es liegt nur auf dieser Datei. Es geht nie an einen Server, '
      + 'und niemand außer dir kennt es.',
    en:
      'This is not an account password. It sits on this file alone. It never reaches a server, '
      + 'and nobody but you knows it.',
  }),
  /** §8.11 — both halves of the single-point-of-failure, said out loud at export time. */
  singlePointOfFailure: Object.freeze({
    de:
      'Mit Passwort: Passwort verloren, Backup verloren. Ohne Passwort: letzten Mac verloren, '
      + 'Familienkreis verloren. Beides lässt sich nicht rückgängig machen.',
    en:
      'With a password: lose the password, lose the backup. Without one: lose your last Mac, lose '
      + 'the Familienkreis. Neither can be undone.',
  }),
});

/**
 * What an import actually did, in words, every time — never silent (the ticket's own wording:
 * "the consequence reported rather than silent").
 *
 * `importBackup` returns one of these on `result.consequence` on EVERY success, including the
 * happy path, so a caller cannot report the good case and forget the reduced one.
 */
export const IMPORT_CONSEQUENCE = Object.freeze({
  identityRestored: Object.freeze({
    code: 'identity-restored',
    de:
      'Dein Board ist zurück und deine Schlüssel auch. Dieser Mac ist wieder Teil deines '
      + 'Familienkreises; die geteilten Einträge der anderen kommen beim nächsten Abgleich von '
      + 'selbst dazu.',
    en:
      'Your board is back and so are your keys. This Mac is part of your Familienkreis again; '
      + 'the others’ shared entries arrive by themselves at the next sync.',
  }),
  /**
   * S8 — the same restore, when the ring in the file does not cover every epoch `1..e`.
   *
   * §7.3 step 6's „Schlüssel ausstehend" is the string this is written from, and it is the
   * RESTORE side of a rule the WRAPPING side already enforces loudly: §4.3 and §7.1 step 5 make
   * "all epochs 1..e" what lets a member read Oma's birthday from three years ago.
   * `result.spaces.<which>.missingEpochs` carries the numbers; this carries the sentence.
   */
  identityRestoredWithGaps: Object.freeze({
    code: 'identity-restored-keys-pending',
    de:
      'Dein Board ist zurück und deine Schlüssel auch — aber nicht alle. Für einen Teil der '
      + 'älteren geteilten Einträge fehlt der Schlüssel; sie bleiben leer, bis er ankommt '
      + '(„Schlüssel ausstehend"). Alles andere ist da.',
    en:
      'Your board is back and so are your keys — but not all of them. Some of the older shared '
      + 'entries are missing their key; they stay blank until it arrives ("keys pending"). '
      + 'Everything else is here.',
  }),
  /**
   * M-B6 / C2c-2, said rather than checked. `importBackup` is I/O-free and CANNOT know whether
   * the Kreis this file names is the Kreis this member belongs to — the member list is the fold's
   * and arrives later, and §7.3 step 5's `POST /devices/adopt` is the only thing that can
   * contradict a file. "Cannot check" and "does not mention" are different, and only the first is
   * forced by the design. So the id is on `result.spaces.family.id` and this is the sentence that
   * goes beside it, on EVERY family restore — including the honest one, because the module cannot
   * tell the honest one from „ich hab dir dein Backup wiederhergestellt".
   */
  familyBindingUnverified: Object.freeze({
    code: 'family-binding-unverified',
    de:
      'Diese Datei trägt dich in einen Familienkreis ein. Welcher es ist, steht in der Datei — '
      + 'dieser Mac kann es nicht nachprüfen. Wenn dir jemand anderes diese Datei gegeben hat, '
      + 'sieh im Familienkreis nach, ob es deiner ist.',
    en:
      'This file enrols you in a Familienkreis. Which one is stated in the file — this Mac cannot '
      + 'check it. If somebody else handed you this file, look in the Familienkreis and make sure '
      + 'it is yours.',
  }),
  boardOnly: Object.freeze({
    code: 'no-identity-in-file',
    de:
      'Dein Board ist zurück. Diese Datei enthielt keine Schlüssel, deshalb ist dieser Mac noch '
      + 'nicht Teil deines Familienkreises — dafür brauchst du eine neue Einladung oder ein '
      + 'Backup mit Passwort.',
    en:
      'Your board is back. This file held no keys, so this Mac is not part of your Familienkreis '
      + 'yet — for that you need a new invitation, or a backup made with a password.',
  }),
});

/**
 * §8.11 and §8.12, in the two sentences the Datenschutz copy (21.3, LZP-1001) and deliverable 24
 * are written from. Exported so the audit reads one text rather than three paraphrases.
 */
export const LIMITS = Object.freeze({
  /** §8.11 */
  passphraseLoss: Object.freeze({
    de: 'Es gibt keine Wiederherstellung des Passworts. Das ist Absicht, nicht ein fehlendes Feature.',
    en: 'There is no password recovery. That is by design, not a missing feature.',
  }),
  /**
   * Resolution 3 above, in the two sentences S3 split it into. TWO PATHS, TWO STATED
   * GUARANTEES — which is the shape the E3-6 argument actually permits, and the shape the user
   * can act on: `README.boardOnly` already tells her which of the two files she is holding.
   *
   * `boardNotAuthenticated` is kept as an ALIAS of `board.boardOnly` because that key is quoted
   * by name in `docs/v2/FINDINGS.md`, `docs/v2/STATUS.md` and `docs/v2/E3-VERIFICATION.md`, and a
   * dangling reference in an audit document is a worse outcome than one extra key here. It now
   * says the smaller true thing: it is about the file WITHOUT keys.
   */
  board: Object.freeze({
    withIdentity: Object.freeze({
      de:
        'Auch die Einträge in dieser Datei sind versiegelt: wer sie verändert — ein Wort, ein '
        + 'zusätzlicher Eintrag, ein gelöschter Eintrag — kann sie danach nicht mehr öffnen. Es '
        + 'kommt entweder dein Board zurück oder gar keins.',
      en:
        'The entries in this file are sealed as well: whoever changes one — a word, an added '
        + 'entry, a deleted entry — can no longer open the file at all. Either your board comes '
        + 'back, or none does.',
    }),
    boardOnly: Object.freeze({
      de:
        'Diese Datei enthält keine Schlüssel, deshalb sind die Einträge darin nicht signiert: wer '
        + 'die Datei verändert, verändert das Board, das beim Import zurückkommt. Ein Backup mit '
        + 'Passwort ist auch hier versiegelt.',
      en:
        'This file holds no keys, so the entries in it are not signed: whoever edits the file '
        + 'edits the board that comes back on import. A backup made with a password is sealed '
        + 'here too.',
    }),
  }),
  /** @deprecated alias of `LIMITS.board.boardOnly` — see above. */
  boardNotAuthenticated: Object.freeze({
    de:
      'Diese Datei enthält keine Schlüssel, deshalb sind die Einträge darin nicht signiert: wer '
      + 'die Datei verändert, verändert das Board, das beim Import zurückkommt. Ein Backup mit '
      + 'Passwort ist auch hier versiegelt.',
    en:
      'This file holds no keys, so the entries in it are not signed: whoever edits the file '
      + 'edits the board that comes back on import. A backup made with a password is sealed '
      + 'here too.',
  }),
  /**
   * S7 / D8's UX, said once so the sheet and the audit read the same sentence. The floor is a
   * FLOOR ON WHAT WE SAY, not a gate on what we accept — `PASSPHRASE_FLOOR` explains why.
   */
  passphraseFloor: Object.freeze({
    de:
      '600 000 Rechenrunden machen ein kurzes Passwort nicht lang. Eine vierstellige PIN hat '
      + '10 000 Möglichkeiten — das ist auf einem Laptop eine Sache von Minuten, und es gibt kein '
      + 'zweites Schloss dahinter.',
    en:
      '600 000 rounds do not make a short password long. A four-digit PIN has 10 000 candidates — '
      + 'minutes on one laptop, and there is no second lock behind it.',
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Errors
//
// One error class with a stable machine-readable `code` and the German/English sentence that goes
// with it. RULE 3 applies to ENGINE error names, and this is not one: `BackupError.code` is our
// own vocabulary, fixed here, and it is the ONLY thing a caller may branch on. Nothing in this
// file reads `err.name` or `err.message` from WebCrypto.
// ─────────────────────────────────────────────────────────────────────────────

/** Every code `BackupError` can carry. A caller's switch is exhaustive against this list. */
export const BACKUP_ERROR_CODES = Object.freeze([
  'not-a-backup',
  'v1-board',
  'unsupported-version',
  'board-damaged',
  'identity-damaged',
  'passphrase-required',
  'passphrase-empty',
  // S7. Reachable ONLY when `PASSPHRASE_FLOOR.hard` is true, which it is not — it exists so that
  // making the floor hard really is the one-line change §5a promises, rather than a one-line
  // change plus a new code plus a new sentence plus a caller whose switch is no longer exhaustive.
  'passphrase-too-weak',
  'cannot-open',
  'sealed-damaged',
  'keystore-conflict',
  'keystore-partial',
]);

const CODE_SET = new Set(BACKUP_ERROR_CODES);

export class BackupError extends Error {
  /**
   * @param {string} code one of `BACKUP_ERROR_CODES`
   * @param {string} message developer-facing, English, never shown to a user
   * @param {{de:string, en:string}} say the user-facing sentence in both languages
   */
  constructor(code, message, say) {
    super(message);
    if (!CODE_SET.has(code)) throw new Error(`BackupError: unknown code ${JSON.stringify(code)}`);
    this.name = 'BackupError';
    this.code = code;
    this.say = Object.freeze({ de: say.de, en: say.en });
    Object.freeze(this);
  }
}

/** The user-facing sentence for each code, so the UI never has to invent one. */
const SAY = Object.freeze({
  'not-a-backup': {
    de: 'Diese Datei ist kein LangzeitPlaner-Backup.',
    en: 'This file is not a LangzeitPlaner backup.',
  },
  'v1-board': {
    de: 'Das ist ein Board aus einer früheren Version. Es lässt sich importieren, aber nicht über diesen Weg.',
    en: 'This is a board from an earlier version. It can be imported, just not through this door.',
  },
  'unsupported-version': {
    de: 'Dieses Backup stammt aus einer neueren Version des Programms. Bitte zuerst aktualisieren.',
    en: 'This backup comes from a newer version of the app. Please update first.',
  },
  'board-damaged': {
    de: 'Diese Datei ist beschädigt — die Einträge darin sind nicht lesbar. Es wurde nichts verändert.',
    en: 'This file is damaged — the entries in it cannot be read. Nothing was changed.',
  },
  'identity-damaged': {
    de: 'Der Schlüsselteil dieser Datei ist beschädigt. Es wurde nichts verändert.',
    en: 'The key part of this file is damaged. Nothing was changed.',
  },
  'passphrase-required': {
    de: 'Dieses Backup enthält deine Schlüssel und ist mit einem Passwort gesichert.',
    en: 'This backup holds your keys and is protected by a password.',
  },
  'passphrase-empty': {
    de: 'Bitte ein Passwort eingeben. Ein leeres Passwort schützt nichts.',
    en: 'Please enter a password. An empty one protects nothing.',
  },
  'passphrase-too-weak': {
    de:
      'Dieses Passwort ist zu kurz, um diese Datei zu schützen. Nimm drei Wörter, die nur du '
      + 'miteinander verbindest.',
    en:
      'This password is too short to protect this file. Take three words only you connect with '
      + 'each other.',
  },
  // ONE code for two causes, because the crypto cannot tell them apart and pretending otherwise
  // would be a guess dressed as a diagnosis. The AES-GCM tag fails identically for a wrong
  // passphrase and for a file whose header, salt or ciphertext was altered or truncated.
  'cannot-open': {
    de:
      'Der Schlüsselteil lässt sich nicht öffnen. Entweder stimmt das Passwort nicht, oder die '
      + 'Datei wurde verändert. Es wurde nichts verändert und nichts importiert.',
    en:
      'The key part will not open. Either the password is wrong, or the file was altered. '
      + 'Nothing was changed and nothing was imported.',
  },
  'sealed-damaged': {
    de: 'Der Schlüsselteil dieser Datei ist beschädigt. Es wurde nichts verändert.',
    en: 'The key part of this file is damaged. Nothing was changed.',
  },
  'keystore-conflict': {
    de:
      'Auf diesem Mac liegt bereits eine andere Identität. Ein Backup wird nie über eine '
      + 'bestehende Identität geschrieben.',
    en:
      'This Mac already holds a different identity. A backup is never written over an existing '
      + 'one.',
  },
  // S4 — the sentence changed WITH the behaviour. It used to say „muss neu gekoppelt werden",
  // which was true of a module that never deleted and is now false: the unusable residue of an
  // interrupted write is cleared, and the next attempt goes through. Say what happened and what
  // to do, in that order.
  'keystore-partial': {
    de:
      'Ein früherer Import wurde mittendrin unterbrochen und hat einen unbrauchbaren Rest auf '
      + 'diesem Mac hinterlassen. Der Rest wurde entfernt — es wurde keine gültige Identität '
      + 'überschrieben. Bitte den Import noch einmal starten.',
    en:
      'An earlier import was interrupted part way through and left an unusable remainder on this '
      + 'Mac. The remainder has been removed — no valid identity was overwritten. Please start '
      + 'the import once more.',
  },
});

function fail(code, message) {
  throw new BackupError(code, message, SAY[code]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. A2 — the board filter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **My entries and nobody else's** (A2). PURE — no clock, no crypto, no store.
 *
 * Two independent tests, because they fail in different situations and neither implies the other:
 *
 *   1. `isForeign === true` — what `core/materialize.js` stamps on an entry projected from a
 *      peer's `pub.*` registers. This is the ordinary case and it catches every foreign entry a
 *      materialized board can hold.
 *   2. `ownerId` is a non-empty string that is not mine — the belt to (1)'s braces. A hand-built
 *      board, a board that came back through a snapshot, or a future materializer that stops
 *      setting `isForeign` would slip past (1) alone, and the failure would be silent and in the
 *      wrong direction: a peer's plaintext inside a file its owner is told to mail to herself.
 *
 * An entry with NO `ownerId` at all is mine. That is not a guess: a solo board has never had a
 * MemberId on it (v1 shape), and the only writer of `ownerId` is `materialize` setting it to
 * `ctx.me` for a local entity.
 *
 * @param {Object} board a materialized v2 state, or a v1-shaped board
 * @param {string} memberId MY member id
 * @returns {Object} a new board object; `board` is not touched
 */
export function ownBoardOnly(board, memberId) {
  if (!isPlainObject(board)) {
    fail('board-damaged', 'ownBoardOnly: the board must be an object');
  }
  if (typeof memberId !== 'string' || memberId.length === 0) {
    throw new Error('ownBoardOnly: memberId is required — A2 cannot be enforced without one');
  }

  const mine = (e) => {
    if (!isPlainObject(e)) return false;
    if (e.isForeign === true) return false;
    if (typeof e.ownerId === 'string' && e.ownerId.length > 0 && e.ownerId !== memberId) return false;
    return true;
  };
  const keepOnly = (kind) => {
    const allow = BACKUP_ENTRY_FIELDS[kind];
    return (e) => {
      const o = {};
      for (const k of allow) if (Object.prototype.hasOwnProperty.call(e, k)) o[k] = e[k];
      return o;
    };
  };

  const notes = asArray(board.notes).filter(mine).map(keepOnly('note'));
  const bars = asArray(board.bars).filter(mine).map(keepOnly('bar'));
  const categories = asArray(board.categories).filter(isPlainObject).map(keepOnly('cat'));

  const settings = isPlainObject(board.settings) ? { ...board.settings } : {};
  if (isPlainObject(settings.layers)) settings.layers = { ...settings.layers };

  const out = {
    schemaVersion: BACKUP_V,
    notes,
    bars,
    categories,
    scratchpads: isPlainObject(board.scratchpads) ? { ...board.scratchpads } : {},
    settings,
  };
  // `_v2` is carried THROUGH, never invented — it is the lineage the board was bound to when it
  // was exported, and it is provenance a support conversation wants. `importBackup` strips it
  // again and reports it as `result.lineage`, because a restored board on a NEW Mac must not
  // claim a lineage that machine's op log has never seen (ADR 006 §5.5: only an ABSENT board may
  // adopt a log).
  if (isPlainObject(board._v2)) out._v2 = { ...board._v2 };
  return out;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Key derivation and the seal
// ─────────────────────────────────────────────────────────────────────────────

/** RULE 2, one layer up from a signature: nothing zero-length is ever sealed or opened. */
function assertSealable(bytes, who) {
  if (!(bytes instanceof Uint8Array)) throw new Error(`${who}: expected bytes`);
  if (bytes.length === 0) throw new Error(`${who}: refusing a zero-length payload (ADR 002 §1 rule 2)`);
  return bytes;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5a. S7 — the passphrase floor
//
// `passphraseBytes` refused the empty string and whitespace-only and NOTHING ELSE, so `'1'`,
// `'a'`, `'1234'` and `'passwort'` all sealed a real identity, and the red team cracked a
// `'1234'` file with a four-entry dictionary (M-B2). 600 000 PBKDF2 rounds is the RIGHT number
// and it is not a substitute for entropy: a 4-digit PIN is 10 000 candidates — 6e9 rounds, which
// is minutes on one laptop — against the file whose own README says „Wer diese Datei und dein
// Passwort hat, ist du."
//
// ⚠ THE FLOOR IS SOFT, AND THAT IS THE DECISION, NOT AN OMISSION.
//
// A hard refusal on THIS artefact has a failure mode that is strictly worse than the one it
// prevents: the user who cannot get past the passphrase field clicks „Nur Einträge sichern"
// instead, and now has no recovery artefact at all — no keys, no Familienkreis, one dead Mac away
// from nothing. (The other well-known outcome is the sticky note, which moves the secret from a
// KDF to a desk.) A weak passphrase behind 600 000 rounds is a bad lock on a real door; the
// board-only file is no door. So: the module has a floor, states it, measures every passphrase
// against it, and hands the verdict to the sheet — and the sheet says „Trotzdem so sichern"
// rather than „Nein".
//
// EVERYTHING THAT WOULD HAVE TO CHANGE TO MAKE IT HARD IS IN ONE PLACE: set
// `PASSPHRASE_FLOOR.hard = true` and `exportBackup` refuses `weak` with `passphrase-too-weak`.
// The domain rows that decide it are `C2d-3…7` in `tests/helpers/crypto-domains.js` — flip
// `exported: true → false` there and the property names every place the decision lands. That is
// a PO decision (D8's UX) and this module does not make it; it makes it a one-line change.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What this module considers a passphrase, in numbers rather than in adjectives.
 *
 * `minChars` counts CODE POINTS, not UTF-16 units — „Schlüsselbund" is 13 either way, but an
 * emoji is one character to the user and two to `String.length`, and a floor that disagrees with
 * the user about how long their password is loses that argument every time.
 */
export const PASSPHRASE_FLOOR = Object.freeze({
  minChars: 12,
  minDistinct: 5,
  /** below this length, digits alone are a PIN or a date in practice */
  digitsOnlyBelow: 20,
  /** false ⇒ a weak passphrase is REPORTED and accepted. See the block comment above. */
  hard: false,
});

/**
 * THE WEAKNESSES, AS DATA. Each row is a total predicate over the measurement, so adding one is
 * adding a row rather than editing a chain of `if`s — and `reasons` comes back as the list of
 * codes that fired, so a caller can say WHICH one without re-deriving it.
 *
 * `empty` is first and is the only one that is also a refusal (`passphrase-empty`), because a
 * passphrase that is nothing at all does not produce a file that "looks protected and is not" —
 * it produces no protection to describe.
 */
const PASSPHRASE_WEAKNESSES = Object.freeze([
  Object.freeze({ code: 'empty', of: (m) => m.blank }),
  Object.freeze({ code: 'too-short', of: (m) => m.chars < PASSPHRASE_FLOOR.minChars }),
  Object.freeze({ code: 'too-few-distinct', of: (m) => m.distinct < PASSPHRASE_FLOOR.minDistinct }),
  Object.freeze({ code: 'one-character-repeated', of: (m) => m.chars > 1 && m.distinct === 1 }),
  Object.freeze({
    code: 'digits-only',
    of: (m) => m.digitsOnly && m.chars < PASSPHRASE_FLOOR.digitsOnlyBelow,
  }),
]);

/**
 * @typedef {Object} PassphraseStrength
 * @property {'ok'|'weak'|'empty'} code
 * @property {boolean} weak  true for BOTH 'weak' and 'empty' — the sheet's one question
 * @property {number} chars  code points, after NFC
 * @property {number} distinct  distinct code points
 * @property {string[]} reasons  which `PASSPHRASE_WEAKNESSES` fired, in order
 * @property {{de:string,en:string}|null} say  the sentence to show, or `null` when there is none
 */

/**
 * Measure a passphrase. **PURE, SYNCHRONOUS, NO CRYPTO** — so the export sheet can call it on
 * every keystroke, which is the only way the answer arrives before the user has committed.
 *
 * It is deliberately EXPORTED and deliberately not called from inside the seal: a module that
 * silently downgraded a user's choice would be making the product decision it just said it does
 * not make. `exportBackup` calls it once, to report; the sheet calls it to decide what to show.
 *
 * @param {any} passphrase
 * @returns {PassphraseStrength}
 */
export function passphraseStrength(passphrase) {
  const s = typeof passphrase === 'string' ? passphrase.normalize('NFC') : '';
  const points = [...s];
  const m = {
    blank: typeof passphrase !== 'string' || s.trim().length === 0,
    chars: points.length,
    distinct: new Set(points).size,
    digitsOnly: points.length > 0 && points.every((c) => c >= '0' && c <= '9'),
  };
  // `empty` SUBSUMES the rest rather than joining them. Every other predicate is also true of the
  // empty string, and „zu kurz, zu wenig verschiedene Zeichen, nur Ziffern" under an empty field
  // is three sentences that all mean "you have not typed anything yet".
  const reasons = m.blank
    ? ['empty']
    : PASSPHRASE_WEAKNESSES.filter((w) => w.of(m)).map((w) => w.code);
  const code = m.blank ? 'empty' : reasons.length > 0 ? 'weak' : 'ok';
  return Object.freeze({
    code,
    weak: code !== 'ok',
    chars: m.chars,
    distinct: m.distinct,
    reasons: Object.freeze(reasons),
    say: code === 'empty' ? SAY['passphrase-empty']
      : code === 'weak' ? EXPORT_SHEET_COPY.passphrase.weak
        : null,
  });
}

/**
 * The passphrase, as bytes.
 *
 * **NFC-normalised first, and that is not cosmetic.** A German passphrase can reach this function
 * as NFC or NFD depending on how it was typed and which text field it came from — macOS produces
 * decomposed umlauts on some input paths. Two byte sequences for „Schlüssel" would derive two
 * different keys, and the symptom would be a backup that opens on the Mac that made it and
 * nowhere else, months later, with no way to tell why. `core/canon.js` normalises for exactly
 * this class of reason and its `utf8()` is reused rather than a second encoder written here.
 *
 * The passphrase is NOT trimmed — leading and trailing spaces are part of what the user typed —
 * but a passphrase that is empty or nothing but whitespace is refused, because it is not a
 * password and would produce a file that looks protected and is not.
 */
function passphraseBytes(passphrase) {
  if (typeof passphrase !== 'string') {
    throw new Error('backup: the passphrase must be a string, or null for a board-only export');
  }
  if (passphrase.trim().length === 0) {
    fail('passphrase-empty', 'backup: refusing an empty or whitespace-only passphrase');
  }
  return utf8(passphrase.normalize('NFC'));
}

/**
 * `PBKDF2-SHA-256(passphrase, salt, iterations) → HKDF-SHA-256(salt, 'lzp/v2/backup') → AES-256-GCM`
 *
 * Resolution 2 in this file's header. Deterministic, therefore pinnable by a golden vector —
 * `tests/tier1/crypto-backup.test.js` does pin it, which is the tripwire that makes a future
 * change to this chain a red test rather than a fleet of files that stop opening.
 *
 * The stretched bits are zeroed after use. That is hygiene rather than a defence — a JS engine
 * makes no promise about copies — but it costs one line and it is the difference between a heap
 * snapshot that contains the derived material once and one that contains it indefinitely.
 *
 * @param {string} passphrase
 * @param {Uint8Array} salt 32 bytes
 * @param {number} iterations
 * @param {BackupPorts} [ports]
 * @returns {Promise<CryptoKey>} AES-256-GCM, non-extractable, encrypt+decrypt
 */
export async function deriveBackupKey(passphrase, salt, iterations, ports) {
  const S = subtleOf(ports);
  const pw = passphraseBytes(passphrase);

  // `pbkdf2()` and `hkdf()` are suite.js's guards: a non-empty salt is required by the first
  // (rule 4's sibling) and a MANDATORY positional salt by the second (rule 4 itself).
  const base = await S.importKey('raw', pw, BACKUP_KDF.name, false, ['deriveBits']);
  const stretched = new Uint8Array(await S.deriveBits(pbkdf2(salt, iterations), base, 256));
  try {
    const ikm = await S.importKey('raw', stretched, KDF.name, false, ['deriveKey']);
    return await S.deriveKey(
      hkdf(salt, INFO.backup),
      ikm,
      { name: AEAD.name, length: AEAD.length },
      false,
      [...USAGES.aead]
    );
  } finally {
    stretched.fill(0);
  }
}

/**
 * S3 — THE BYTES THE BOARD DIGEST IS TAKEN OVER.
 *
 * Not `canonicalJSON`, and the reason is the one E3-6 used as an argument against binding the
 * board at all: `canonicalJSON` refuses floats, non-safe integers, `undefined`, `NaN` and
 * anything that is not a plain object. `board.settings` is a bag the product writes into, and
 * losing a user's ENTIRE EXPORT because one setting picked up a `0.5` would be a worse failure
 * than the one this defends against. So this is a TOTAL function over every value
 * `JSON.stringify` can write — which is exactly the set of values that can survive in the file.
 *
 * **It must satisfy one equation and only one:**
 *
 *     boardDigestInput(b) === boardDigestInput(JSON.parse(JSON.stringify(b)))
 *
 * because the export side hashes the board it built and the import side hashes the board that
 * came back through the file. `JSON.stringify` is what makes that true: every value it writes
 * parses back to a value it writes identically (numbers via ECMA-262's shortest round-trip
 * `ToString`, strings with well-formed escapes since ES2019), and every value it DROPS —
 * `undefined`, functions, symbols — is dropped on both sides.
 *
 * The replacer sorts object keys so insertion order cannot change the digest. Integer-like keys
 * are then re-ordered ahead of the rest by `OrdinaryOwnPropertyKeys`, in both engines, which is
 * deterministic and therefore harmless. Arrays are left alone: order is content in a board.
 *
 * `utf8()` here is `core/canon.js`'s plain `TextEncoder` — it does NOT normalise, so the digest
 * is over exactly the code units the file carries.
 *
 * @param {any} board
 * @returns {Uint8Array} never empty — `{}` is two bytes
 */
export function boardDigestInput(board) {
  const sorted = (key, value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = value[k];
    return out;
  };
  let text;
  try {
    text = JSON.stringify(board, sorted);
  } catch (err) {
    // A cycle, or a `toJSON` that threw. Both mean the board cannot become a file at all, so
    // this is the same failure the caller's own `JSON.stringify` is one step from having.
    throw new Error(`backup: the board cannot be serialized (${err && err.message})`);
  }
  if (typeof text !== 'string') {
    throw new Error('backup: the board is not JSON-serializable — it has no digest');
  }
  return assertSealable(utf8(text), 'boardDigestInput');
}

/**
 * `b64u(SHA-256(boardDigestInput(board)))` — the value that goes INTO the AAD, and nowhere else.
 * @param {SubtleCrypto} S @param {any} board @returns {Promise<string>}
 */
async function boardDigest(S, board) {
  return b64u(new Uint8Array(await S.digest(HASH, boardDigestInput(board))));
}

/**
 * The AAD — resolution 3. `canonicalBytes` of the file's ENTIRE plaintext header, plus a digest
 * of its ENTIRE board.
 *
 * Built from one function so that the export side and the import side cannot disagree about a
 * single field: `sealAad(header, …)` is called with the object that was written, and again with
 * the object that was read. Any difference at all makes the tag fail, which is precisely the
 * point.
 *
 * **S3 — the board digest is a THIRD ARGUMENT, not a field of the file.** It is recomputed from
 * `file.board` on both sides, so there is no field to strip, no field to downgrade, and no wire
 * format to version: §7.2's `identity` shape is untouched. Rewrite one character of one note and
 * the AAD changes, the tag fails, and the import comes back `cannot-open` — the same honest code
 * a wrong passphrase gets, because from outside the module the two are the same event: this file
 * is not the file it claims to be.
 *
 * @param {{_README_de:string,_README_en:string,format:string,v:number,exportedAt:string,app:string}} header
 * @param {{memberId:string, kdf:Object}} idHeader
 * @param {string} boardSha the b64url SHA-256 of `boardDigestInput(file.board)`
 * @returns {Uint8Array} never empty — `aesgcm()` refuses an empty AAD
 */
function sealAad(header, idHeader, boardSha) {
  if (typeof boardSha !== 'string' || boardSha.length === 0) {
    throw new Error(
      'sealAad: the board digest is REQUIRED. The board is inside the AAD (finding S3); a caller '
      + 'that omits it would silently rebuild the exact hole S3 closed.'
    );
  }
  return canonicalBytes({
    _README_de: header._README_de,
    _README_en: header._README_en,
    app: header.app,
    board: { digest: boardSha, hash: HASH },
    exportedAt: header.exportedAt,
    format: header.format,
    kdf: {
      hash: idHeader.kdf.hash,
      iterations: idHeader.kdf.iterations,
      name: idHeader.kdf.name,
      salt: idHeader.kdf.salt,
    },
    memberId: idHeader.memberId,
    v: header.v,
  });
}

/** `sealed = b64u(iv ‖ ct)`. Resolution 1. */
function packSealed(iv, ct) {
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64u(out);
}

/** The inverse, refusing anything too short to be an IV plus a GCM tag. */
function unpackSealed(sealed) {
  if (typeof sealed !== 'string' || sealed.length === 0) return null;
  if (sealed.length > MAX_SEALED_B64_CHARS) return null;
  let raw;
  try {
    raw = ub64(sealed);
  } catch (err) {
    if (err instanceof CodecError) return null;
    throw err;
  }
  const minimum = SEALED_IV_BYTES + AEAD.tagLength / 8;
  if (raw.length <= minimum) return null;
  return { iv: raw.slice(0, SEALED_IV_BYTES), ct: raw.slice(SEALED_IV_BYTES) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Export  (ADR 002 §7.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SpaceBundle
 * @property {string} id  `psp_…` / `fsp_…`
 * @property {number} [epoch] the space's CURRENT epoch. §7.2 lists it on `family` only; it is
 *           accepted on both and carried only where it was given, so the sealed payload matches
 *           the ADR's shape rather than a superset of it.
 * @property {Map<number,CryptoKey|Uint8Array>|Object} epochs EVERY epoch key this member holds,
 *           `1..e`. A backup that carried only the current epoch would restore a member who
 *           cannot read Oma's birthday from three years ago (A4, 17.1, §7.1 step 5).
 */

/**
 * @typedef {Object} BackupV2
 * @property {string} _README_de @property {string} _README_en
 * @property {'langzeitplaner-backup'} format @property {2} v
 * @property {string} exportedAt @property {string} app
 * @property {Object} board
 * @property {{kdf:Object, memberId:string, sealed:string}} [identity] OMITTED without a passphrase
 */

/**
 * Build the backup file. **The `identity` block is sealed or absent — never plaintext (D8).**
 *
 * @param {Object} board a materialized v2 state (or a v1-shaped board). Filtered to MY entries
 *        HERE, by `ownBoardOnly` — a caller is not trusted to have done it.
 * @param {import('./identity.js').Identity} identity must carry `memberId`; must additionally
 *        carry `recSig` and `recKex` when a passphrase is given (they are what gets sealed).
 * @param {{personal?:SpaceBundle|null, family?:SpaceBundle|null}|null} spaces the key ring, or
 *        `null` for a member who is not in a Familienkreis yet.
 * @param {string|null} passphrase `null` ⇒ the `identity` block is OMITTED, not written in the
 *        clear. There is no third option and no default: the export sheet's two buttons
 *        (`EXPORT_SHEET_COPY`) are exactly these two arguments.
 * @param {{exportedAt:string, app:string, salt?:Uint8Array, iv?:Uint8Array} & BackupPorts} opts
 *        `exportedAt` ('YYYY-MM-DD') and `app` are REQUIRED and INJECTED — nothing under
 *        `src/js/crypto/` reads a clock or a bundle version (ADR 005 §2).
 * @returns {Promise<BackupV2>}
 */
export async function exportBackup(board, identity, spaces, passphrase, opts = {}) {
  const { exportedAt, app } = opts;
  if (typeof exportedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(exportedAt)) {
    throw new Error("exportBackup: an injected exportedAt, 'YYYY-MM-DD', is required");
  }
  if (typeof app !== 'string' || app.length === 0) {
    throw new Error('exportBackup: an injected app version string is required');
  }
  const memberId = identity && identity.memberId;
  if (typeof memberId !== 'string' || memberId.length === 0) {
    throw new Error('exportBackup: identity.memberId is required — A2 cannot be enforced without it');
  }
  // The shape too, and at the SOURCE: a file written with a mis-shaped MemberId would import
  // "successfully" and then produce a device attestation `parseAttestationBlob` refuses on every
  // machine. Refusing to write it is better than refusing to read it. See `inspectBackup`.
  if (!isMemberId(memberId)) {
    throw new Error(`exportBackup: identity.memberId ${JSON.stringify(memberId)} is not a MemberId (core/ids.js memberId())`);
  }

  const withIdentity = passphrase !== null && passphrase !== undefined;
  // Validated HERE, before a single private key is exported. An empty passphrase discovered three
  // calls later would mean the PKCS#8 bytes had already been materialised in the JS heap for a
  // file that is then never written — work that D8 says should not happen at all on that path.
  if (withIdentity) {
    passphraseBytes(passphrase).fill(0);
    // S7 — measured on the way past, never silently. `PASSPHRASE_FLOOR.hard` is false, so this
    // REPORTS; the sheet decides what to do with it (§5a, §9). The optional port exists so that
    // "the caller was told" is a testable fact rather than a convention.
    const strength = passphraseStrength(passphrase);
    if (strength.weak) {
      if (PASSPHRASE_FLOOR.hard) {
        fail('passphrase-too-weak', `exportBackup: the passphrase is below the floor (${strength.reasons.join(', ')})`);
      }
      if (typeof opts.onWeakPassphrase === 'function') opts.onWeakPassphrase(strength);
    }
  }

  const file = {
    _README_de: withIdentity ? README.withIdentity.de : README.boardOnly.de,
    _README_en: withIdentity ? README.withIdentity.en : README.boardOnly.en,
    format: BACKUP_FORMAT,
    v: BACKUP_V,
    exportedAt,
    app,
    board: ownBoardOnly(board, memberId),
  };

  if (!withIdentity) {
    // THE BOARD-ONLY PATH TOUCHES NO KEY AT ALL. It does not export PKCS#8 "and then not write
    // it"; the private material never enters this function's scope. There is nothing here to
    // forget to delete.
    assertNoIdentityBlock(file);
    return Object.freeze(file);
  }

  const { block, secrets } = await sealIdentity(identity, spaces, passphrase, file, opts);
  file.identity = block;
  // Guard (2) from the header: a check on the RESULT, not on the path.
  assertNoPlaintextSecrets(file, secrets);
  secrets.length = 0;
  return Object.freeze(file);
}

/**
 * The ONLY place an `identity` block is constructed, and it is downstream of the AES-GCM.
 * @returns {Promise<{block:Object, secrets:string[]}>} `secrets` are the b64u spellings of every
 *          piece of private material this call handled, for the post-condition check.
 */
async function sealIdentity(identity, spaces, passphrase, header, opts) {
  const S = subtleOf(opts);
  const random = randomOf(opts);

  const recSig = identity.recSig;
  const recKex = identity.recKex;
  if (!recSig?.privateKey || !recKex?.privateKey) {
    throw new Error(
      'exportBackup: a passphrase was given but identity.recSig / identity.recKex are missing. '
      + 'The recovery pair is what makes this file the recovery artifact (ADR 002 §7.2).'
    );
  }

  const recSigPkcs8 = await exportPkcs8(S, recSig.privateKey, 'recSig');
  const recKexPkcs8 = await exportPkcs8(S, recKex.privateKey, 'recKex');

  const payload = {
    family: await bundleFor(S, spaces?.family, 'family'),
    personal: await bundleFor(S, spaces?.personal, 'personal'),
    recKexPkcs8: b64u(recKexPkcs8),
    recSigPkcs8: b64u(recSigPkcs8),
  };

  const salt = takeBytes(opts.salt, () => random(SALT_BYTES), SALT_BYTES, 'salt');
  const iv = takeBytes(opts.iv, () => random(AEAD.ivBytes), AEAD.ivBytes, 'iv');
  const iterations = iterationsFor(opts);

  const idHeader = {
    kdf: {
      name: BACKUP_KDF.name,
      hash: BACKUP_KDF.hash,
      iterations,
      salt: b64u(salt),
    },
    memberId: identity.memberId,
  };

  const plaintext = assertSealable(canonicalBytes(payload), 'sealIdentity');
  const key = await deriveBackupKey(passphrase, salt, iterations, opts);
  // S3 — `header.board` is already the filtered, exported board at this point (`exportBackup`
  // sets it before it calls here), so this hashes the bytes the file will actually carry.
  const boardSha = await boardDigest(S, header.board);
  const ct = new Uint8Array(
    await S.encrypt(aesgcm(iv, sealAad(header, idHeader, boardSha)), key, plaintext)
  );

  const secrets = [
    payload.recSigPkcs8,
    payload.recKexPkcs8,
    ...epochSecretsOf(payload.personal),
    ...epochSecretsOf(payload.family),
  ];
  // The canonical payload bytes are the plaintext; zero them before the object leaves scope.
  plaintext.fill(0);
  recSigPkcs8.fill(0);
  recKexPkcs8.fill(0);

  return {
    block: { kdf: idHeader.kdf, memberId: idHeader.memberId, sealed: packSealed(iv, ct) },
    secrets,
  };
}

function epochSecretsOf(bundle) {
  return bundle ? Object.values(bundle.epochs) : [];
}

async function exportPkcs8(S, privateKey, who) {
  const bytes = new Uint8Array(await S.exportKey('pkcs8', privateKey));
  if (bytes.length !== PKCS8_P256_BYTES) {
    throw new Error(
      `exportBackup: ${who} PKCS#8 is ${bytes.length} bytes, expected ${PKCS8_P256_BYTES}. `
      + 'That is not a P-256 private key (ADR 002 §9.2).'
    );
  }
  return bytes;
}

/**
 * Normalise one space's key ring into the sealed payload's shape.
 *
 * Accepts a `Map<number, …>` or a plain object, and a key as either an EXTRACTABLE AES-GCM
 * `CryptoKey` or 32 raw bytes. The `CryptoKey` branch requires `extractable: true`, which a space
 * key already has to be: §3's `wrapSpaceKey` calls `wrapKey('raw', spaceKey, …)`, and `wrapKey`
 * of a non-extractable key is refused by both engines. So this adds no new requirement on
 * LZP-303 — it depends on one that §3 already made.
 */
async function bundleFor(S, bundle, which) {
  if (bundle === null || bundle === undefined) return null;
  if (!isPlainObject(bundle)) throw new Error(`exportBackup: spaces.${which} must be an object or null`);
  // The prefix is checked PER SLOT, not merely for well-formedness. §3 barrier 2 keeps the
  // personal and family wrapping paths non-overlapping; a backup that swapped the two ids would
  // restore a key ring in which `PSK` sits under the family space id, and the first thing that
  // read it would be a resolver that is supposed to be incapable of seeing it.
  if (!isSpaceId(bundle.id) || !bundle.id.startsWith(which === 'personal' ? 'psp_' : 'fsp_')) {
    throw new Error(
      `exportBackup: spaces.${which}.id must be a ${which === 'personal' ? 'psp_' : 'fsp_'} SpaceId `
      + `(core/ids.js spaceId('${which}')), got ${JSON.stringify(bundle.id)}`
    );
  }

  const entries = bundle.epochs instanceof Map
    ? [...bundle.epochs.entries()]
    : Object.entries(bundle.epochs ?? {});
  if (entries.length === 0) {
    throw new Error(
      `exportBackup: spaces.${which}.epochs is empty. A backup carries EVERY epoch 1..e — one `
      + 'that carried only the current epoch would restore a member who cannot read the history '
      + '(A4, 17.1, ADR 002 §7.1 step 5).'
    );
  }

  const epochs = {};
  for (const [k, v] of entries) {
    const n = typeof k === 'number' ? k : Number(k);
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new Error(`exportBackup: spaces.${which} has a non-positive epoch ${JSON.stringify(k)}`);
    }
    epochs[String(n)] = b64u(await rawSpaceKey(S, v, which, n));
  }

  const out = { epochs, id: bundle.id };
  if (bundle.epoch !== undefined && bundle.epoch !== null) {
    if (!Number.isSafeInteger(bundle.epoch) || bundle.epoch < 1) {
      throw new Error(`exportBackup: spaces.${which}.epoch must be a positive integer`);
    }
    out.epoch = bundle.epoch;
  }
  return out;
}

async function rawSpaceKey(S, v, which, n) {
  if (v instanceof Uint8Array) {
    if (v.length !== SYMMETRIC_KEY_BYTES) {
      throw new Error(`exportBackup: spaces.${which} epoch ${n} is ${v.length} bytes, expected ${SYMMETRIC_KEY_BYTES}`);
    }
    return v;
  }
  if (!v || typeof v !== 'object' || typeof v.type !== 'string') {
    throw new Error(`exportBackup: spaces.${which} epoch ${n} is neither a CryptoKey nor 32 bytes`);
  }
  const raw = new Uint8Array(await S.exportKey('raw', v));
  if (raw.length !== SYMMETRIC_KEY_BYTES) {
    throw new Error(`exportBackup: spaces.${which} epoch ${n} exported ${raw.length} bytes, expected ${SYMMETRIC_KEY_BYTES}`);
  }
  return raw;
}

function takeBytes(given, make, want, who) {
  if (given === undefined) {
    const b = make();
    if (!(b instanceof Uint8Array) || b.length !== want) {
      throw new Error(`exportBackup: the random port must return ${want} bytes for the ${who}`);
    }
    return b;
  }
  if (!(given instanceof Uint8Array) || given.length !== want) {
    throw new Error(`exportBackup: an injected ${who} must be exactly ${want} bytes`);
  }
  return given;
}

/**
 * 600 000 (D8, the OWASP 2023 PBKDF2-SHA-256 floor) unless a test injects otherwise.
 * Lowering this in the app is a security change and needs a new decision, not an argument.
 */
function iterationsFor(opts) {
  const n = opts.iterations;
  if (n === undefined) return BACKUP_KDF.iterations;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_KDF_ITERATIONS) {
    throw new Error(`exportBackup: iterations must be an integer in 1..${MAX_KDF_ITERATIONS}`);
  }
  return n;
}

/**
 * GUARD (2) — the post-condition that makes D8 a property of the OUTPUT rather than of the code
 * path that produced it.
 *
 * Serialize the finished file and assert that not one of the b64url strings this call handled
 * appears anywhere in it. The sealed blob is ciphertext, so a match can only mean a plaintext
 * copy leaked into some field — which is the exact failure D8 exists to prevent, and the one a
 * future refactor is most likely to reintroduce.
 */
function assertNoPlaintextSecrets(file, secrets) {
  const text = JSON.stringify(file);
  for (const s of secrets) {
    if (typeof s === 'string' && s.length > 0 && text.includes(s)) {
      throw new Error(
        'exportBackup: PANIC — private key material appeared in the exported file in plaintext. '
        + 'PO decision D8: the identity block is encrypted or omitted, NEVER written in the clear.'
      );
    }
  }
}

function assertNoIdentityBlock(file) {
  if (Object.prototype.hasOwnProperty.call(file, 'identity')) {
    throw new Error('exportBackup: PANIC — a board-only export grew an identity block');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Reading the file — the pure, passphrase-free half
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} BackupInspection
 * @property {string} format @property {number} v
 * @property {string} exportedAt @property {string} app
 * @property {boolean} hasIdentity  does this file carry keys at all?
 * @property {boolean} needsPassphrase  === hasIdentity; named for the caller's question
 * @property {string|null} memberId  present only when `hasIdentity`
 * @property {{name:string,hash:string,iterations:number}|null} kdf
 * @property {{notes:number, bars:number, categories:number}} counts
 * @property {{de:string,en:string}} consequence what importing THIS file will and will not do
 */

/**
 * What is this file, and what will importing it do? **Pure, synchronous, no passphrase.**
 *
 * The export sheet's mirror image: the import sheet has to know whether to ask for a passphrase
 * BEFORE it asks, and it has to be able to say — before the user commits — that a file without
 * keys will not bring the Familienkreis back. Throwing `passphrase-required` from the middle of
 * `importBackup` would make that a surprise instead of a choice.
 *
 * @param {any} file the parsed JSON
 * @returns {BackupInspection}
 * @throws {BackupError} `not-a-backup` · `v1-board` · `unsupported-version` · `board-damaged`
 *         · `identity-damaged`
 */
export function inspectBackup(file) {
  if (!isPlainObject(file)) fail('not-a-backup', 'inspectBackup: not an object');

  if (file.format !== BACKUP_FORMAT) {
    // A v1 export is `{schemaVersion:1, notes, bars, …}` with no `format` at all. Saying so is
    // worth a code of its own: the file is perfectly good and there IS a door for it, just not
    // this one. "Not a backup" would send the user to delete it.
    if (looksLikeBoard(file)) fail('v1-board', 'inspectBackup: this is a bare board, not a backup v2 file');
    fail('not-a-backup', `inspectBackup: format is ${JSON.stringify(file.format)}`);
  }
  if (file.v !== BACKUP_V) {
    fail('unsupported-version', `inspectBackup: backup version ${JSON.stringify(file.v)} is not ${BACKUP_V}`);
  }
  if (!isPlainObject(file.board) || !looksLikeBoard(file.board)) {
    fail('board-damaged', 'inspectBackup: the board block carries none of a board\'s collections');
  }

  const hasIdentity = Object.prototype.hasOwnProperty.call(file, 'identity');
  let kdf = null;
  let memberId = null;
  if (hasIdentity) {
    const id = file.identity;
    if (!isPlainObject(id)) fail('identity-damaged', 'inspectBackup: identity is not an object');
    // THE SHAPE, not merely the presence — found by running this module in the real engine.
    //
    // `identity.memberId` is what `importBackup` restores the member as, and it is what
    // `ensureAttestedDevice` writes into the attestation payload. `core/authz.js`'s
    // `parseAttestationBlob` validates that payload with `isMemberId`, so a file carrying a
    // memberId of the wrong SHAPE produces a device attestation that every verifier on every
    // machine silently returns `null` for — the import reports success, the adopt request is
    // rejected without a reason the client can read, and the member never joins anything. The
    // one plausible cause of a mis-shaped id is the file having been edited by hand, which is
    // exactly what "damaged" means.
    if (!isMemberId(id.memberId)) {
      fail('identity-damaged', `inspectBackup: identity.memberId ${JSON.stringify(id.memberId)} is not a MemberId`);
    }
    if (!isPlainObject(id.kdf)) fail('identity-damaged', 'inspectBackup: identity.kdf is missing');
    if (id.kdf.name !== BACKUP_KDF.name || id.kdf.hash !== BACKUP_KDF.hash) {
      fail('identity-damaged', `inspectBackup: identity.kdf is not ${BACKUP_KDF.name}/${BACKUP_KDF.hash}`);
    }
    if (!Number.isSafeInteger(id.kdf.iterations) || id.kdf.iterations < 1
        || id.kdf.iterations > MAX_KDF_ITERATIONS) {
      // Clamped, not trusted — see MAX_KDF_ITERATIONS.
      fail('identity-damaged', `inspectBackup: identity.kdf.iterations is out of 1..${MAX_KDF_ITERATIONS}`);
    }
    if (saltBytes(id.kdf.salt) === null) {
      fail('identity-damaged', `inspectBackup: identity.kdf.salt is not ${SALT_BYTES} b64url bytes`);
    }
    if (unpackSealed(id.sealed) === null) {
      fail('identity-damaged', 'inspectBackup: identity.sealed is missing, malformed or too short');
    }
    kdf = { name: id.kdf.name, hash: id.kdf.hash, iterations: id.kdf.iterations };
    memberId = id.memberId;
  }

  return Object.freeze({
    format: file.format,
    v: file.v,
    exportedAt: typeof file.exportedAt === 'string' ? file.exportedAt : '',
    app: typeof file.app === 'string' ? file.app : '',
    hasIdentity,
    needsPassphrase: hasIdentity,
    memberId,
    kdf,
    counts: Object.freeze({
      notes: asArray(file.board.notes).length,
      bars: asArray(file.board.bars).length,
      categories: asArray(file.board.categories).length,
    }),
    consequence: hasIdentity ? IMPORT_CONSEQUENCE.identityRestored : IMPORT_CONSEQUENCE.boardOnly,
  });
}

function looksLikeBoard(o) {
  if (!isPlainObject(o)) return false;
  for (const [key, wellTyped] of BOARD_SHAPE) {
    if (Object.prototype.hasOwnProperty.call(o, key) && wellTyped(o[key])) return true;
  }
  return false;
}

function saltBytes(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  let raw;
  try {
    raw = ub64(s);
  } catch (err) {
    if (err instanceof CodecError) return null;
    throw err;
  }
  return raw.length === SALT_BYTES ? raw : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Import  (ADR 002 §7.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ImportResult
 * @property {Object} board  MY board, `_v2` stripped. Apply it through ADR 001 §5.4's diff
 *           transaction (`store.replaceAll`), never by assignment.
 * @property {{lineageId:string, gen:number}|null} lineage  what `board._v2` said, reported rather
 *           than applied — see `ownBoardOnly`.
 * @property {boolean} identityRestored
 * @property {import('./identity.js').Identity|null} identity  fresh DEVICE keys, restored
 *           RECOVERY keys. `null` when the file carried none.
 * @property {{personal:Object|null, family:Object|null}|null} spaces  epoch keys as `CryptoKey`s.
 *           Each bundle carries `{id, epoch?, epochs}` and, **only when the ring has holes**,
 *           `missingEpochs: number[]` — S8. Its ABSENCE is the "complete" signal.
 * @property {Object|null} attestation  this machine's SELF-attestation under the restored RK_sig
 * @property {string|null} blob  the `dev.<deviceShort>` register value — §7.3 step 4
 * @property {{code:string, de:string, en:string}} consequence  ALWAYS present. `identityRestored`
 *           or, when any ring has holes, `identityRestoredWithGaps` (§7.3 step 6).
 * @property {{spaceId:string, verified:false, say:Object}|null} familyBinding  M-B6 — the Kreis
 *           this file enrols the Mac in, and the statement that NOTHING HERE VERIFIED IT.
 *           `null` when the file carries no family bundle.
 */

/**
 * Restore. **Nothing is applied until everything has been read, decrypted and checked.**
 *
 * The order below is the whole of "never half-applies", and each step is where it is on purpose:
 *
 *   1. inspect the file — pure, no passphrase, no store (§7 above);
 *   2. no `identity` block ⇒ return the board with the REDUCED consequence, having touched the
 *      key store not at all;
 *   3. derive, decrypt (the AES-GCM tag catches a wrong passphrase and a tampered or truncated
 *      file alike), parse the payload, import every key — ALL IN MEMORY;
 *   4. only now look at the KeyStore, and refuse a conflicting or partial one BEFORE writing a
 *      byte — clearing the dead residue of an interrupted earlier write on the way out, so the
 *      retry is not refused for ever (S4; `prepareKeyStore` argues the whole of it);
 *   5. write the recovery records, keys first and metadata last — the same order and the same
 *      canonical bytes `identity.js` writes, so a crash between them leaves a PARTIAL store that
 *      `ensureRecoveryIdentity` refuses loudly rather than one that is silently wrong;
 *   6. mint FRESH non-extractable device keys and self-attest (§7.3 step 3/4). Never restore a
 *      device identity: a device is a machine, not a person.
 *
 * Steps 5 and 6 are the only writes, and a failure anywhere in 1–4 means the store was never
 * opened. The BOARD is never applied here at all — it is returned, and only on complete success,
 * so a caller cannot receive half of one.
 *
 * §7.3 step 5's `POST /api/v1/devices/adopt` is NOT done here (this module is I/O-free): the
 * caller sends `blob` and signs the request with `identity.recSig.privateKey` per ADR 003 §2.
 *
 * @param {BackupV2} file the parsed JSON
 * @param {string|null} passphrase
 * @param {import('./identity.js').KeyStore} ks
 * @param {{deviceId:string, createdAt:string} & BackupPorts} opts `deviceId` and `createdAt` are
 *        REQUIRED and INJECTED whenever the file carries an identity — minting needs them and
 *        nothing here reads a clock.
 * @returns {Promise<ImportResult>}
 * @throws {BackupError}
 */
export async function importBackup(file, passphrase, ks, opts = {}) {
  const seen = inspectBackup(file);                                              // step 1
  const board = { ...file.board };
  const lineage = isPlainObject(board._v2) ? { ...board._v2 } : null;
  delete board._v2;

  if (!seen.hasIdentity) {                                                       // step 2
    return Object.freeze({
      board,
      lineage,
      identityRestored: false,
      identity: null,
      spaces: null,
      attestation: null,
      blob: null,
      consequence: IMPORT_CONSEQUENCE.boardOnly,
      familyBinding: null,
    });
  }

  if (passphrase === null || passphrase === undefined) {
    fail('passphrase-required', 'importBackup: this file carries an identity block and needs a passphrase');
  }

  const S = subtleOf(opts);
  const id = file.identity;
  const salt = saltBytes(id.kdf.salt);
  const parts = unpackSealed(id.sealed);

  // step 3 — everything below is in memory. `ks` has not been touched.
  let plain;
  try {
    const key = await deriveBackupKey(passphrase, salt, id.kdf.iterations, opts);
    // S3 — the SAME digest, over the board that arrived. A rewritten note, an added entry, a
    // deleted entry or a rewritten `_v2` lineage all change this string, and the AEAD tag then
    // refuses the whole file. Nothing downstream has to remember to check the board, because
    // nothing downstream runs.
    const boardSha = await boardDigest(S, file.board);
    plain = new Uint8Array(
      await S.decrypt(
        aesgcm(parts.iv, sealAad(file, { memberId: id.memberId, kdf: id.kdf }, boardSha)),
        key,
        parts.ct
      )
    );
  } catch (err) {
    // RULE 3 — a try/catch BOUNDARY, never an error name. A `BackupError` from
    // `passphraseBytes` (an empty passphrase) is ours and passes through; anything else is the
    // engine refusing to authenticate, and the engine cannot tell us WHY.
    if (err instanceof BackupError) throw err;
    fail('cannot-open', 'importBackup: AES-GCM refused the sealed block');
  }

  const payload = parsePayload(plain);
  plain.fill(0);

  const restored = await importRecoveryPair(S, payload);
  const spaces = await importSpaces(S, payload);

  await prepareKeyStore(ks, id.memberId);                                        // step 4

  const { createdAt, deviceId } = opts;
  if (typeof createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(createdAt)) {
    throw new Error("importBackup: an injected createdAt, 'YYYY-MM-DD', is required to restore an identity");
  }
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error('importBackup: an injected deviceId (core/ids.js deviceId()) is required');
  }

  await putRecoveryIdentity(ks, id.memberId, restored, createdAt);               // step 5

  const minted = await ensureAttestedDevice(                                     // step 6
    ks,
    id.memberId,
    restored.recSig.privateKey,
    { deviceId, createdAt, ...opts }
  );

  // S8 — the consequence follows the RING, not the happy path. `IMPORT_CONSEQUENCE` is the one
  // thing this module promises to say on every success (§7.3 step 6, "reported rather than
  // silent"), and „alles ist zurück" over a ring with a hole in it is the silence S8 is about.
  const gaps = ['personal', 'family']
    .map((w) => (spaces[w] && spaces[w].missingEpochs ? spaces[w].missingEpochs.length : 0))
    .reduce((a, b) => a + b, 0);

  return Object.freeze({
    board,
    lineage,
    identityRestored: true,
    identity: Object.freeze({
      ...minted.identity,
      recSig: restored.recSig,
      recKex: restored.recKex,
    }),
    spaces,
    attestation: minted.attestation,
    blob: minted.blob,
    consequence: gaps > 0 ? IMPORT_CONSEQUENCE.identityRestoredWithGaps : IMPORT_CONSEQUENCE.identityRestored,
    // M-B6 / C2c-2 — WHAT THIS MODULE CANNOT CHECK, NAMED RATHER THAN OMITTED.
    //
    // `family.id` is a payload field. Whether this member is still in that Kreis, or ever was, is
    // the fold's to know and arrives later; §7.3 step 5's `POST /devices/adopt` is the only thing
    // that can contradict a file. So the CALLER — which does know which Kreis this Mac expects,
    // or can ask — gets the id and the sentence, on every family restore. This is deliberately
    // NOT conditional: a file naming somebody else's Kreis is indistinguishable here from one
    // naming your own, and a warning that only appeared on the bad one would be a claim this
    // module cannot make. `null` when the file carries no family bundle at all.
    familyBinding: spaces.family
      ? Object.freeze({
        spaceId: spaces.family.id,
        verified: false,
        say: IMPORT_CONSEQUENCE.familyBindingUnverified,
      })
      : null,
  });
}

/**
 * The sealed payload, after the tag has already vouched for it. These checks are therefore not a
 * defence against an attacker — they are a defence against OUR OWN future bug, a payload written
 * by a build that changed the shape, and they turn "undefined is not a function" three frames
 * later into one named failure at the seam.
 */
function parsePayload(bytes) {
  let text;
  try {
    text = utf8Decode(bytes);
  } catch {
    fail('sealed-damaged', 'importBackup: the sealed payload is not valid UTF-8');
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    fail('sealed-damaged', 'importBackup: the sealed payload is not JSON');
  }
  if (!isPlainObject(obj)) fail('sealed-damaged', 'importBackup: the sealed payload is not an object');
  for (const f of ['recSigPkcs8', 'recKexPkcs8']) {
    if (typeof obj[f] !== 'string' || obj[f].length === 0) {
      fail('sealed-damaged', `importBackup: the sealed payload has no ${f}`);
    }
  }
  return obj;
}

/**
 * Rebuild both recovery `CryptoKeyPair`s from PKCS#8 — resolution 4 in this file's header.
 *
 * ENGINE DIFFERENCE 9 lives on this exact line: the private half is imported with ONLY the
 * private usages. `['sign','verify']` is fine at `generateKey`, which splits the list across the
 * pair, and is a `SyntaxError` at `importKey`, which does not. This is the restore path — the one
 * a developer exercises last — so the trap is spelled out where it bites.
 *
 * The public halves are reconstructed from the same JWK's `x`/`y` and then CHECKED against the
 * private keys, in both algorithms. A recovery identity has no revocation (§8.12): a public key
 * that merely looked right would attest devices that nothing can ever verify, and nobody would
 * find out until the next Mac.
 */
async function importRecoveryPair(S, payload) {
  const recSig = await pairFromPkcs8(S, payload.recSigPkcs8, SIG, USAGES.sigPrivate, USAGES.peerSig, 'recSig');
  const recKex = await pairFromPkcs8(S, payload.recKexPkcs8, KEX, USAGES.kexPrivate, USAGES.peerKex, 'recKex');

  // Check 1 — the reconstructed RK_sig public key really verifies what the private key signs.
  // Rule 1: this asserts `verify() === true`, never a byte comparison; rule 2: the probe is a
  // fixed NON-EMPTY string.
  const probe = utf8('lzp/v2/backup/self-check');
  const sig = await signBytes(recSig.privateKey, probe, { subtle: S });
  if ((await verifyBytes(recSig.publicKey, sig, probe, { subtle: S })) !== true) {
    fail('sealed-damaged', 'importBackup: the restored RK_sig pair does not verify its own signature');
  }

  // Check 2 — the reconstructed RK_kex public key really agrees with the private key. Both
  // directions of one ECDH against a throwaway pair must produce the same secret.
  const eph = await S.generateKey(KEX, false, [...USAGES.kex]);
  const a = new Uint8Array(await S.deriveBits({ name: KEX.name, public: eph.publicKey }, recKex.privateKey, 256));
  const b = new Uint8Array(await S.deriveBits({ name: KEX.name, public: recKex.publicKey }, eph.privateKey, 256));
  if (!sameBytes(a, b)) {
    fail('sealed-damaged', 'importBackup: the restored RK_kex pair does not agree with itself');
  }
  a.fill(0);
  b.fill(0);

  return { recSig, recKex };
}

async function pairFromPkcs8(S, b64, algo, privateUsages, publicUsages, who) {
  let pkcs8;
  try {
    pkcs8 = ub64(b64);
  } catch (err) {
    if (err instanceof CodecError) fail('sealed-damaged', `importBackup: ${who} is not base64url`);
    throw err;
  }
  if (pkcs8.length !== PKCS8_P256_BYTES) {
    fail('sealed-damaged', `importBackup: ${who} is ${pkcs8.length} bytes, expected ${PKCS8_P256_BYTES}`);
  }

  let privateKey;
  try {
    // extractable: the recovery pair must remain re-exportable, because the user must be able to
    // make another backup from a restored Mac (§2.1, RECOVERY_KEY_EXTRACTABLE).
    privateKey = await S.importKey('pkcs8', pkcs8, algo, RECOVERY_KEY_EXTRACTABLE, [...privateUsages]);
  } catch {
    fail('sealed-damaged', `importBackup: ${who} is not an importable ${algo.name} ${algo.namedCurve} private key`);
  }
  pkcs8.fill(0);

  let publicKey;
  try {
    const jwk = await S.exportKey('jwk', privateKey);
    // `d` is the private scalar; `key_ops`/`use` describe the PRIVATE key and would be checked
    // against the public usages we are about to ask for — dropping all three is what makes this
    // a public JWK rather than a private one with a field missing.
    const pub = { crv: jwk.crv, ext: true, kty: jwk.kty, x: jwk.x, y: jwk.y };
    publicKey = await S.importKey('jwk', pub, algo, true, [...publicUsages]);
  } catch {
    fail('sealed-damaged', `importBackup: the public half of ${who} could not be reconstructed`);
  }

  const raw = await exportRawPublic(publicKey, { subtle: S });
  if (raw.length !== RAW_PUBKEY_BYTES) {
    fail('sealed-damaged', `importBackup: ${who} public point is ${raw.length} bytes`);
  }
  return { privateKey, publicKey };
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** Epoch keys back into `CryptoKey`s. Extractable, because §3's `wrapKey('raw', spaceKey, …)` is. */
async function importSpaces(S, payload) {
  const one = async (bundle, which) => {
    if (bundle === null || bundle === undefined) return null;
    if (!isPlainObject(bundle) || !isPlainObject(bundle.epochs)) {
      fail('sealed-damaged', `importBackup: the sealed ${which} bundle is malformed`);
    }
    if (!isSpaceId(bundle.id) || !bundle.id.startsWith(which === 'personal' ? 'psp_' : 'fsp_')) {
      fail('sealed-damaged', `importBackup: the sealed ${which} bundle carries ${JSON.stringify(bundle.id)}, not a ${which} SpaceId`);
    }
    const epochs = new Map();
    for (const [k, v] of Object.entries(bundle.epochs)) {
      const n = Number(k);
      if (!Number.isSafeInteger(n) || n < 1) {
        fail('sealed-damaged', `importBackup: ${which} carries a non-positive epoch ${JSON.stringify(k)}`);
      }
      let raw;
      try {
        raw = ub64(v);
      } catch (err) {
        if (err instanceof CodecError) fail('sealed-damaged', `importBackup: ${which} epoch ${n} is not base64url`);
        throw err;
      }
      if (raw.length !== SYMMETRIC_KEY_BYTES) {
        fail('sealed-damaged', `importBackup: ${which} epoch ${n} is ${raw.length} bytes, expected ${SYMMETRIC_KEY_BYTES}`);
      }
      epochs.set(n, await S.importKey('raw', raw, { name: AEAD.name, length: AEAD.length }, true, [...USAGES.aead]));
      raw.fill(0);
    }
    const out = { id: bundle.id, epochs };
    if (bundle.epoch !== undefined) out.epoch = bundle.epoch;

    // S8 — A SPARSE RING IS NO LONGER ACCEPTED IN SILENCE.
    //
    // §4.3 and §7.1 step 5 make "every epoch 1..e" the rule that lets a member read Oma's
    // birthday from three years ago, and the WRAPPING side already refuses a partial ring loudly
    // (`wrapRingToRecipients`). The restoring side accepted one without a word, so a restored Mac
    // could not read epochs 1–3 and said nothing — the two sides disagreed about the same rule.
    //
    // REPORTED, NOT REFUSED, and the asymmetry is deliberate: refusing would throw away a
    // restore that recovers everything from epoch 4 onward, on a Mac whose owner may have nothing
    // else left. §7.3 step 6 already describes the right behaviour for keys that have not arrived
    // — the ops are PARKED and the status says „Schlüssel ausstehend" — and this is the number
    // that status needs. The field is ABSENT when the ring is complete, so its presence is the
    // signal and a caller cannot read `[]` as „alles da" by accident.
    const missing = missingEpochsOf(epochs, bundle.epoch);
    if (missing.length > 0) out.missingEpochs = Object.freeze(missing);
    return Object.freeze(out);
  };
  return Object.freeze({
    personal: await one(payload.personal, 'personal'),
    family: await one(payload.family, 'family'),
  });
}

/**
 * Which of `1..e` this ring does not hold. `e` is the bundle's own `epoch` when it carries one
 * and the highest epoch present otherwise — a ring that stops at 4 with no `epoch` field is
 * complete for everything it claims to cover, and inventing a higher `e` would report a gap that
 * only the server can know about (§4.4: an epoch the file has never heard of PARKS, it is not
 * missing from the file).
 *
 * @param {Map<number,CryptoKey>} epochs @param {number|undefined} epoch
 * @returns {number[]} ascending, possibly empty
 */
function missingEpochsOf(epochs, epoch) {
  const held = [...epochs.keys()];
  if (held.length === 0) return [];
  const top = Number.isSafeInteger(epoch) && epoch > 0 ? Math.max(epoch, ...held) : Math.max(...held);
  const gaps = [];
  for (let n = FIRST_BACKUP_EPOCH; n <= top; n++) if (!epochs.has(n)) gaps.push(n);
  return gaps;
}

/** `1`. Named rather than spelled, because `bundleFor` and `importSpaces` both refuse below it. */
const FIRST_BACKUP_EPOCH = 1;

/**
 * Step 4 — refuse BEFORE writing, and **S4: leave a store a retry can succeed on.**
 *
 * `ensureRecoveryIdentity` would refuse a partial store too, but it would refuse it AFTER this
 * function's caller had already decided to go ahead, and `ensureAttestedDevice` would refuse a
 * mismatched device store after the recovery records were written. Checking both up front is what
 * keeps the failure atomic.
 *
 * The one case that is NOT a conflict: this exact member's identity already present, with the
 * same recovery public key. Re-importing the same backup twice is a thing users do, and it must
 * be idempotent rather than a scary error. The public halves ARE comparable — they are public —
 * so this is a real check and not a shrug. (Rule 1 does not apply: these are key bytes, not
 * signature bytes.)
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * S4 — WHY THIS FUNCTION NOW DELETES, AND EXACTLY WHAT IT WILL DELETE
 *
 * `KeyStore.put` writes one record at a time. §7.3's ordering makes a crash between the writes
 * leave 2 of 3 records rather than a silently wrong identity, which is right — but this function
 * then classified that residue as `keystore-partial` and refused it **on every retry, for ever**,
 * and nothing in this module ever deleted. A user holding a half-written store and their own
 * backup file had no supported way to finish: the Mac was intact, the file was intact, and the
 * restore was impossible. (`C2e-8` is the proof that this was a gap and not a law of nature: the
 * OTHER half-apply shape — a complete recovery triple and no device records — has always
 * completed idempotently.)
 *
 * THE RESIDUE IT CLEARS IS PROVABLY DEAD, on two independent grounds, and it clears nothing else:
 *
 *   1. **It is partial**, 1 or 2 of 3. Every reader in `identity.js` refuses a partial triple by
 *      construction, so no code path in this product can ever turn it back into an identity. It
 *      is not "someone's keys"; it is the wreckage of an interrupted write.
 *   2. **No readable metadata in the store names anyone else.** A `recMeta`/`devMeta` naming a
 *      different member is a `keystore-conflict` — checked FIRST, below, and now checked even
 *      when the triple is partial, which is strictly stricter than before. Somebody else's Mac
 *      is refused, permanently, and untouched.
 *
 * And it still REFUSES this attempt. The retry is what succeeds. That ordering is the point:
 * nothing is written over anything in the same breath as discovering it, the user is told the
 * store was broken and that it has been cleared (`SAY['keystore-partial']`), and the second
 * attempt meets an empty store and behaves exactly like a first-ever restore.
 *
 * ⚠ WHERE THIS FUNCTION IS CALLED FROM IS PART OF THE ARGUMENT. It runs at step 4, i.e. AFTER the
 * AES-GCM tag has already authenticated the file under the user's passphrase. Somebody who finds
 * your Mac and a random file cannot reach the delete — they never get past step 3.
 */
async function prepareKeyStore(ks, memberId) {
  for (const m of ['get', 'put', 'del', 'list']) {
    if (typeof ks?.[m] !== 'function') {
      throw new Error(`importBackup: the KeyStore port must implement get/put/del/list (missing ${m})`);
    }
  }

  // THE TWO HALVES, AS DATA. One description per half, so the recovery half and the device half
  // cannot drift into two slightly different policies — which is how the device half came to be
  // the benign one and the recovery half the one that bricked the Mac.
  const halves = [
    {
      which: 'recovery',
      ids: [KEYSTORE_IDS.recSig, KEYSTORE_IDS.recKex, KEYSTORE_IDS.recMeta],
      conflict: (who) => `importBackup: this store already holds the recovery identity of ${who}`,
    },
    {
      which: 'device',
      ids: [KEYSTORE_IDS.devSig, KEYSTORE_IDS.devKex, KEYSTORE_IDS.devMeta],
      conflict: (who) => `importBackup: this Mac already has a device identity belonging to ${who}`,
    },
  ];

  const seen = [];
  for (const half of halves) {
    const values = await Promise.all(half.ids.map((id) => ks.get(id)));
    const present = values.filter((v) => v !== null && v !== undefined).length;
    const meta = readMeta(values[2]);
    seen.push({ half, present, meta });
  }

  // PASS 1 — CONFLICTS, before anything is deleted. A store belonging to someone else is refused
  // whole, and a partial store that still names someone else counts: 2 of 3 of THEIR records is
  // not this member's wreckage to tidy up.
  for (const { half, present, meta } of seen) {
    if (meta && meta.memberId !== memberId) {
      fail('keystore-conflict', half.conflict(meta.memberId));
    }
    if (present === 3 && !meta) {
      fail('keystore-conflict', half.conflict('(unreadable metadata)'));
    }
  }

  // PASS 2 — the dead residue, cleared, and this attempt refused all the same.
  for (const { half, present } of seen) {
    if (present === 0 || present === 3) continue;
    for (const id of half.ids) await ks.del(id);
    fail(
      'keystore-partial',
      `importBackup: the key store held ${present} of 3 ${half.which} records — an interrupted `
      + 'write. The residue has been cleared; retrying this import now succeeds (S4).'
    );
  }
}

const TD = new TextDecoder('utf-8', { fatal: true });

function readMeta(bytes) {
  if (!(bytes instanceof Uint8Array)) return null;
  try {
    const v = JSON.parse(TD.decode(bytes));
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Step 5. The record ids, the value shapes and the WRITE ORDER are `identity.js`'s, deliberately:
 * a later `ensureRecoveryIdentity(ks, memberId)` must ADOPT what this wrote rather than see a
 * foreign layout and refuse. `canonicalBytes({memberId, createdAt})` is byte-for-byte what
 * `ensureRecoveryIdentity` writes on its own minting path.
 *
 * Keys first, metadata last — so a crash in between leaves 2 of 3 records, which every reader in
 * `identity.js` turns into a loud, actionable failure instead of a silently regenerated second
 * identity (and a recovery key regenerated silently orphans the member from their own
 * Familienkreis, with no revocation to undo it — §8.12).
 */
async function putRecoveryIdentity(ks, memberId, restored, createdAt) {
  await ks.put(KEYSTORE_IDS.recSig, restored.recSig);
  await ks.put(KEYSTORE_IDS.recKex, restored.recKex);
  await ks.put(KEYSTORE_IDS.recMeta, canonicalBytes({ memberId, createdAt }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. The seam for `src/js/backup.js` (another ticket) — stated, not built
//
// The v1 UI file owns the dialogs, the filename and the confirmation sheet, and it is not touched
// from here. What it needs from this module, and in what order:
//
//   EXPORT
//     1. `probeCrypto()` / `isSuiteAvailable()` only if a passphrase is on offer — a board-only
//        export needs no crypto at all and must stay available on an engine that has none.
//     2. show `EXPORT_SHEET_COPY`: two buttons, `gain` and `lose` under each, plus
//        `notAnAccount` and `singlePointOfFailure`. Neither button is the silent default.
//        S3: `withPassword.sealsEntriesToo` and `boardOnly.entriesNotSealed` are the one line
//        that distinguishes the two files' guarantees — show them under their own button.
//     2a. **S7 — the passphrase field.** Show `EXPORT_SHEET_COPY.passphrase.hint` BEFORE anything
//        is typed. On every change call `passphraseStrength(value)`; when `.weak` is true show
//        `.say` (= `EXPORT_SHEET_COPY.passphrase.weak`) beside the field and label the confirm
//        button `passphrase.weakAnyway`. **It is a warning, not a wall** — `PASSPHRASE_FLOOR.hard`
//        is false and §5a says why at length. Passing `{ onWeakPassphrase }` in `opts` is the
//        belt to that braces: it fires from inside `exportBackup`, so „the sheet forgot to ask"
//        is a testable condition rather than a review comment.
//     3. `exportBackup(store.state, identity, keyring, passphraseOrNull,
//                      { exportedAt: todayISO(), app: APP_VERSION })`
//     4. `JSON.stringify(file, null, 2)` → the native save dialog. The filename is v1's
//        `store.exportFilename()` shape; this module deliberately does not pick one.
//
//   IMPORT
//     1. `inspectBackup(JSON.parse(text))` — pure. `code: 'v1-board'` means hand the text to v1's
//        `confirmAndReplace` instead; that file is still the right door for a v1 board.
//     2. `needsPassphrase` decides whether to ask, BEFORE the confirmation sheet, so the reduced
//        outcome is a choice and not a surprise.
//     3. the „Board ersetzen?" confirmation (11.3) — unchanged, still explicit.
//     4. `importBackup(file, passphraseOrNull, keyStore, { deviceId: deviceId(), createdAt: todayISO() })`
//     5. apply `result.board` through `store.replaceAll` (ADR 001 §5.4's diff transaction; undo
//        and redo are cleared there, not here). `result.board` is `schemaVersion: 2` and carries
//        `visibility` / `coEdit`, which the transaction writes as TRUTH registers — it is not a
//        v1 board and must not go through `migrateV1`.
//     6. show `result.consequence` — ALWAYS, on both paths. That is the ticket's "reported rather
//        than silent", and `boardOnly` is the sentence that says the Familienkreis did not come
//        back. S8: the identity path has TWO sentences now — `identity-restored` and
//        `identity-restored-keys-pending` — and the second one is chosen for you when a ring has
//        holes. `result.spaces.<which>.missingEpochs` carries the numbers behind it and is the
//        input to §7.3 step 6's „Schlüssel ausstehend" status.
//     6a. **M-B6 — `result.familyBinding`.** Non-null on every family restore. Show
//        `familyBinding.say` with `familyBinding.spaceId` beside it. Nothing at this seam can
//        verify that id, so the sentence is unconditional and must not be suppressed for the
//        „normal" case: this module cannot tell the normal case from „ich hab dir dein Backup
//        wiederhergestellt". The thing that CAN contradict a file is step 7's
//        `POST /devices/adopt`, and until that exists this line is the only check there is.
//     7. if `result.identityRestored`: `POST /api/v1/devices/adopt` with `result.blob`, signed
//        with `result.identity.recSig.privateKey` (ADR 003 §2), then load `result.spaces` into
//        the key ring and pull from seq 0. Newer ops the epoch keys do not cover are PARKED, not
//        lost, and the sync status says „Schlüssel ausstehend" (§7.3 step 6).
//
// WHAT THIS MODULE NEEDS FROM LZP-303 (reported, not reached into):
//   `KeyRing` must be able to hand over `{id, epoch?, epochs}` per space with each epoch key as
//   an EXTRACTABLE AES-256-GCM `CryptoKey` or as 32 raw bytes. Both forms are accepted here.
//   Extractability is not a new requirement — §3's `wrapSpaceKey` already calls
//   `wrapKey('raw', spaceKey, …)`, which both engines refuse over a non-extractable key.
// ─────────────────────────────────────────────────────────────────────────────
