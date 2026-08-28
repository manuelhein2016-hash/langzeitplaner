// tests/helpers/crypto-domains.js — THE INPUT DOMAINS OF THE CRYPTO LAYER, WRITTEN DOWN AS DATA.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
//
// `tests/helpers/domains.js` is the same idea one layer down, and its header says why: an
// enumeration of BRANCHES is a description of the code that exists; an enumeration of INPUTS is a
// description of the world, and the world does not shrink when someone adds an `else if`.
//
// The E3 red team's verdict is the frame for this file, and it is worth quoting exactly, because
// it says what a crypto-layer domain has to be a domain OF:
//
//   > 21.2 / 20.5 — "no role, including admin, grants insight into anyone else's private
//   > entries": TRUE OF THE ROLE, FALSE OF THE CODE AS BUILT. The four barriers are real,
//   > independent and structural — but they all answer "which key opens which envelope", and
//   > finding S1 changes WHICH KEY THE VICTIM USES, walking past all four without touching any.
//
// Four barriers, four correct answers, and the question was wrong. That is exactly the failure
// mode the domains method exists for: every barrier was chosen against an enumeration of the ways
// an ENVELOPE can arrive, and nobody had written down the ways a KEY can arrive. So C1 below is
// that enumeration, and C2, C3 and C4 are the three other places where an input reaches the
// crypto layer and nobody wrote the domain down either:
//
//   C1  a WRAP ROW arriving at `admitWraps`         — which key I will use
//   C2  a BACKUP FILE's bytes                       — which of them are authenticated
//   C3  an ATTESTATION reaching the fold            — which key verifies which device
//   C4  a PATCH reaching `sealOp`                   — which level decides what may be published
//   C5  a `pub.set` reaching the FOLD               — which content survives the entity's level
//
// C5 was added last, by the integrator, and its provenance is worth keeping: C4 closed the AUTHOR
// side of the redaction question and the agent that closed it REPORTED that the receiving side was
// untouched — every barrier lives in `sealOp`, and the attacker owns the Mac that runs `sealOp`.
// A domain that stops at the seal path describes the honest client, which is the one participant
// no threat model gets to assume.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTRACT OF AN ENTRY — identical to `domains.js`, deliberately.
//
//   { id, value, label, expect, openFinding, note? }
//
//   id            stable, unique across the whole file. Quote it in a fix, in a commit, in a row.
//   value         THE INPUT. Data, never a closure.
//   label         one line a human can read in a failure report.
//   expect        THE REQUIRED BEHAVIOUR. Its shape is fixed per domain and documented at the
//                 head of that domain. NEVER the current behaviour. Many of the `expect` values
//                 below are, today, wrong about this build; that is the point.
//   openFinding   the finding id that predicts this entry FAILS today, or null when the entry is
//                 expected to hold. A null that fails is NEWS — a regression, or a domain member
//                 nobody had looked at. `tests/property/crypto-domains.test.js` reports the two
//                 separately, and reports a `openFinding` that now HOLDS as STALE.
//
// ZERO DEPENDENCIES. NO KEY MATERIAL IN A VALUE — every entry here is a DESCRIPTION of an input
// (`{sender:'unattested', scope:'personal', …}`), and the property builds the real bytes from it
// with the real `src/js/crypto/` API. A domain file that carried a `CryptoKey` would be a
// fixture, and a fixture goes stale silently.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Freeze a literal all the way down. Shared with `domains.js` in spirit; copied, not imported,
 *  so this file stays a leaf and a change to one domain file cannot move the other. */
const deep = (x) => {
  if (Array.isArray(x)) return Object.freeze(x.map(deep));
  if (!x || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.getOwnPropertyNames(x)) {
    const d = Object.getOwnPropertyDescriptor(x, k);
    if (d && 'value' in d && d.writable) x[k] = deep(d.value);
  }
  return Object.freeze(x);
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FINDING REGISTER
//
// Every `openFinding` in this file names a row in here, and every row names the adversarial test
// that PROVED it. A finding id with no runnable proof is a rumour.
//
// ⚠ THE S-NUMBERS. The verdict handed down three ids by name — S1, S2(c) and S5 — and did not
// number the backup findings. Those therefore carry the red team's own ROW ids (`M-B2`, `M-B4`,
// `M-B5`, `M-B6`) rather than an S-number invented here: a work order that guesses at an id is
// worse than one that quotes the row. If the register later assigns them S-numbers, rename them
// here and nowhere else — the property reads these keys.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const FINDINGS = deep({
  S1: {
    id: 'S1',
    title: '`admitWraps` admits a space key from a sender it never authenticates',
    where: 'src/js/crypto/spacekeys.js:admitWraps',
    provedBy: [
      'tests/attack/crypto-relay-keyinjection.test.js — all four rows',
      'tests/attack/crypto-member-read.test.js — M-R6, M-R6b',
    ],
    oneLine:
      '`unwrapSpaceKey`\'s contract says `theirKexPub` is "the sender\'s ECDH public key, FROM '
      + 'THEIR VERIFIED ATTESTATION". Its only caller takes it off `row.senderKexPubRaw`, a field '
      + 'of the untrusted row, and verifies nothing. `admitWraps` has no parameter through which '
      + 'a caller COULD supply the verified set, so this is a check with nowhere to live.',
    // ⚠ CLOSED 2026-08-28. Kept, not deleted: the register is the map from a finding to the rows
    // that prove it, and a closed finding still has to say which rows now hold it closed.
    closed: {
      on: '2026-08-28',
      by: 'src/js/crypto/spacekeys.js §6b — `admissibleSenders()` + a REQUIRED `ctx.senders`',
      how:
        'The admissible SENDER set for a space is the SAME branded list the wrapping side uses, '
        + 'built by `personalRecipients()`/`familyRecipients()` and verified by the same '
        + '`recipientProblem` (brand, attestation, and the `att.kexPubRaw` binding). '
        + '`row.senderKexPubRaw` became an INDEX into that set — it selects a sender and can no '
        + 'longer supply one, so relay bytes never reach `deriveBits`. The parameter has no '
        + 'default: omitting it throws rather than admitting.',
      invertedRows: [
        'tests/attack/crypto-relay-keyinjection.test.js — every row, plus 5 new ones',
        'tests/attack/crypto-member-read.test.js — M-R6, M-R6b, M-R3b',
      ],
      residual:
        'A device\'s FIRST family sync cannot fold the family stream, so its roster comes from '
        + 'relay coordination data. A relay that wants an admission must now invent a whole '
        + 'MEMBER — recovery key, device, attestation — which surfaces in the member list (15.4). '
        + 'That is ADR 002 §8.5\'s already-accepted phantom member, not S1. Runnable row: '
        + '`crypto-relay-keyinjection.test.js` — "OPEN (ADR 002 §8.5) — the bootstrap residual". '
        + 'The PERSONAL space has no bootstrap: its sender set is my own pairing record.',
    },
  },
  'S2(b)': {
    id: 'S2(b)',
    title: 'a squatted `deviceShort` parks every envelope the victim will ever seal, permanently',
    where: 'src/js/core/authz.js:attestationOf / shortCollisions',
    provedBy: ['tests/attack/crypto-member-impersonate.test.js — M-I3a, M-I3b, M-I3d'],
    oneLine:
      'The contest is deliberately not resolved (§2.3, and that is right), but `dev.*` is '
      + 'write-once and there is no revocation, so the park is FOREVER and one op buys it. The '
      + 'ADR says "a squatter can stall a peer\'s envelopes"; the honest word is permanently.',
    // ⚠ CLOSED 2026-08-28. Kept, not deleted: see the note on S1.
    closed: {
      on: '2026-08-28',
      by: 'src/js/core/authz.js stage 0a — the possession proof `devOf(cell.stamp) === att.deviceShort`',
      how:
        'FINDINGS §4.5 option (a), first-claim binding on the pair `(sigPubRaw, deviceShort)`, '
        + 'with the strengthening the red team\'s own measurement forced: the claim only counts '
        + 'when it is PROVED, and then "first" is not a race, because only one claimant can ever '
        + 'prove it. A `dev.<S>` register is a credential only if the op that WROTE it was itself '
        + 'stamped by the device it attests. `openOp`\'s P2, P3 and check 4 together mean an op '
        + 'stamped with S was signed by the holder of the key that hashes to S — `sigPubRaw` is '
        + 'public and copyable, which is exactly why P2 alone never closed this, but the '
        + 'SIGNATURE is not, and the stamp is where it shows through into the plaintext the fold '
        + 'sees. The squat is admitted, reported on the new `AuthzResult.unprovenShorts`, and '
        + 'never resolved; the victim\'s own register is untouched and his envelopes open.',
      invertedRows: [
        'tests/attack/crypto-member-impersonate.test.js — M-I3b, M-I3d, M-I4',
        'tests/attack/round5-attestation.test.js — R5-7b, R5-7d',
        'tests/tier1/core-authz.test.js — both I-3 rows',
      ],
      residual:
        'The park is not gone, it is RE-AIMED: a genuine 16-character collision — two devices, '
        + 'two real keys, one short — is still refused outright, because two proven claims is not '
        + 'a contest a fold may pick a winner in. That is an 80-bit event, not an attack. And the '
        + 'FIRST family sync of a brand-new device still cannot fold its own attestation out of a '
        + 'stream it needs that attestation to open (ADR 001 §4.0\'s bootstrap); the possession '
        + 'proof does not create that gap and does not close it. Owner: WP-9.',
    },
  },
  'S2(c)': {
    id: 'S2(c)',
    title: 'the pre-collision window converts the victim\'s traffic from PARKED to DROPPED',
    where: 'src/js/core/authz.js:attestationOf → src/js/crypto/envelope.js:openOp check 5',
    provedBy: ['tests/attack/crypto-member-impersonate.test.js — M-I3c'],
    oneLine:
      'Before the victim\'s own `member.set{dev.*}` has been folded — a partial pull, a fresh '
      + 'joiner, any batch boundary — `attestationOf` resolves the SQUATTER\'s blob, P2 passes '
      + '(she copied a public key and told the truth about it), P3 passes, the decrypt SUCCEEDS, '
      + 'and check 5 THROWS. §5.2.5 says a rejection is final and the op is dropped without being '
      + 'appended. A park is re-evaluable; a drop is silent data loss.',
    // ⚠ CLOSED 2026-08-28, by the same line as S2(b) — and this is the half that proves the fix
    // is at the right seam. The drop was fixed WITHOUT touching `openOp`\'s check 5, which is
    // still a throw and should stay one: check 5 is a genuine protocol violation when the
    // attestation is a credential. What was wrong was that a blob nobody could back had been
    // ADMITTED AS ONE. Take that away and the envelope never gets past P1, so it parks.
    closed: {
      on: '2026-08-28',
      by: 'src/js/core/authz.js stage 0a — the same possession proof; envelope.js unchanged',
      how:
        'In the pre-collision window the squat is the ONLY claim on the victim\'s short, so no '
        + 'contest exists to detect and no ordering rule could have helped. It is refused because '
        + 'it is unproven, not because it is contested — which is why this cell, and not the two '
        + 'contested ones, is the cell that pinned down what the fix had to be.',
      invertedRows: ['tests/attack/crypto-member-impersonate.test.js — M-I3c'],
      residual: 'none for this cell; see S2(b)\'s residual for the bootstrap gap next door.',
    },
  },
  S5: {
    id: 'S5',
    title: 'the caller-supplied `pub.level` wins over the authenticated one (barrier 4)',
    where: 'src/js/crypto/envelope.js:assertProjected',
    provedBy: ['tests/attack/crypto-member-read.test.js — M-R7c'],
    status: 'CLOSED 2026-08-28 — `const level = folded`; a declared level is a claim checked '
      + 'against the map. M-R7c is INVERTED in place, tier 1 carries the whole (declared × folded) '
      + 'cross, tier 2 proves it in WebKit, and ADR 004 §2.2 barrier 4 is amended: its `??` formula '
      + 'named `currentPubLevel` — the level a transition moves AWAY from — which is what made a '
      + 'fallback onto the caller look necessary. `ctx.levelOf` now answers from the entity\'s '
      + 'authenticated `visibility` truth register. STILL OPEN, and another agent\'s: the RECEIVER '
      + 'side. `geteiltOnly` is enforced at seal time only and `core/authz.js` never reads it.',
    oneLine:
      '`const level = declared === undefined || declared === null ? folded : declared;` — the '
      + 'caller\'s value WINS whenever the caller supplies one, and a projection supplies one on '
      + 'every legitimate transition. `brand.level === level` is then satisfied by the same caller '
      + 'having lied twice. The line\'s own comment says "re-derive the level from the '
      + 'AUTHENTICATED register map, NEVER from the caller".',
  },
  'M-B2': {
    id: 'M-B2',
    title: 'there is no passphrase floor and no strength signal on the backup export',
    where: 'src/js/crypto/backup.js:passphraseBytes / exportBackup',
    provedBy: ['tests/attack/crypto-member-backup.test.js — M-B2'],
    status: 'CLOSED 2026-08-28 (S7) — as the WEAKER of the two available rules, on purpose. '
      + '`passphraseStrength()` is exported, pure and synchronous; `PASSPHRASE_FLOOR` names the '
      + 'numbers (12 code points, 5 distinct); `EXPORT_SHEET_COPY.passphrase` carries the DE+EN '
      + 'copy the sheet shows BEFORE anything is typed, and the confirm button says „Trotzdem so '
      + 'sichern". The floor is SOFT: a hard refusal pushes the user onto „Nur Einträge sichern", '
      + 'which trades a weak passphrase for NO recovery artefact at all, and that is strictly '
      + 'worse. `PASSPHRASE_FLOOR.hard = true` plus flipping `exported` on C2d-3…7 is the whole '
      + 'of the other decision, and it is the PO\'s (D8). M-B2 is INVERTED in place.',
    oneLine:
      '„Wer diese Datei und dein Passwort hat, ist du" is the whole security model of the file, '
      + 'and the model has no opinion about what a Passwort is. 600 000 PBKDF2 rounds protect a '
      + '4-digit PIN by a factor of 600 000 — 6e9 rounds, minutes on one laptop.',
  },
  'M-B4': {
    id: 'M-B4',
    title: 'the `board` block is outside the AAD (ADR 002 E3-6, and it is exploitable)',
    where: 'src/js/crypto/backup.js:sealAad',
    provedBy: ['tests/attack/crypto-member-backup.test.js — M-B4'],
    status: 'CLOSED 2026-08-28 (S3) — the AAD now carries `board: {digest, hash}`, a SHA-256 over '
      + '`boardDigestInput(file.board)` recomputed on BOTH sides. Not a field of the file: there '
      + 'is nothing to strip and no wire format to version (§7.2\'s `identity` shape is '
      + 'unchanged). E3-6\'s objection is answered rather than overruled — the guarantee is stated '
      + 'per path (`LIMITS.board.withIdentity` / `.boardOnly`), and `boardDigestInput` is a TOTAL '
      + 'function over everything `JSON.stringify` can write, so the float in `settings` that '
      + '`canonicalJSON` would have refused cannot cost the user their export. M-B4 is INVERTED.',
    oneLine:
      '`sealAad()` enumerates seven fields and `board` is not among them, so anyone who finds the '
      + 'file can rewrite, add or delete entries and the import still returns a fully valid '
      + 'identity beside her board. `inspectBackup` then reports HER counts as fact.',
  },
  'M-B5': {
    id: 'M-B5',
    title: 'a half-written key store is refused for ever, with no repair path',
    where: 'src/js/crypto/backup.js:assertKeyStoreIsFree',
    provedBy: ['tests/attack/crypto-member-backup.test.js — M-B5'],
    status: 'CLOSED 2026-08-28 (S4) — `prepareKeyStore` (was `assertKeyStoreIsFree`) still '
      + 'REFUSES the attempt that meets a partial store, and now clears the residue on the way '
      + 'out, so the retry meets an empty store and succeeds. It deletes only what is provably '
      + 'dead on two independent grounds: the triple is partial (every reader in `identity.js` '
      + 'refuses it by construction) AND no readable meta names another member — which is now '
      + 'checked even on a PARTIAL triple, i.e. strictly stricter than before. It runs at step 4, '
      + 'after the AEAD tag: a thief with your Mac and a random file never reaches the delete. '
      + '`SAY[\'keystore-partial\']` changed with it — „muss neu gekoppelt werden" was true of a '
      + 'module that never deleted. M-B5 is INVERTED in place; M-B5b (the benign shape) and M-B5c '
      + '(somebody else\'s store) are unchanged and still pass.',
    oneLine:
      '`KeyStore.put` is one record at a time, so a crash between the two recovery writes leaves '
      + '2 of 3 records — a state `assertKeyStoreIsFree` classifies as `keystore-partial` and '
      + 'REFUSES on every retry. `importBackup` never deletes; there is no supported way to '
      + 'finish the restore.',
  },
  'M-B6': {
    id: 'M-B6',
    title: 'the restored space id and epoch ring are taken from the file and nothing reports the gaps',
    where: 'src/js/crypto/backup.js:importSpaces',
    provedBy: ['tests/attack/crypto-member-backup.test.js — M-B6'],
    status: 'HALF CLOSED 2026-08-28. The EPOCH half (S8) is closed: `result.spaces.<which>.'
      + 'missingEpochs` is present only when the ring has holes, and `consequence` becomes '
      + '`identity-restored-keys-pending` (§7.3 step 6\'s „Schlüssel ausstehend"). C2b-2 and C2b-3 '
      + 'now hold. The KREIS half (C2c-2) is NOT closable here and the domain proves why: C2c-1 '
      + 'and C2c-2 are the SAME INPUT — two fresh well-formed `fsp_` ids — because the difference '
      + 'lives in the member list, not in the file. `result.familyBinding` says the honest thing '
      + 'unconditionally („dieser Mac kann es nicht nachprüfen") and C2c-2 is CARRIED to §7.3 '
      + 'step 5\'s `POST /api/v1/devices/adopt`, which is the only authority that can contradict '
      + 'a file. Owner: `server/`.',
    oneLine:
      'The WRAPPING side refuses a partial ring loudly (`wrapRingToRecipients`); the RESTORING '
      + 'side accepts a sparse one without comment, so a restored Mac silently cannot read epochs '
      + '1-3 and says nothing. `family.id` is a payload field and the authority that could '
      + 'contradict it arrives later — refusing here would need I/O, but REPORTING does not.',
  },
});

export const FINDING_IDS = deep(Object.keys(FINDINGS).sort());

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C1 — A WRAP ROW ARRIVING AT `admitWraps`.  THE DOMAIN NOBODY WROTE DOWN.
//
// `GET /api/v1/spaces/:id/keys` returns an ARRAY OF ROWS, written by the relay, in an order the
// relay chooses, and `admitWraps` turns each row into an entry in the KeyRing. A KeyRing entry is
// a `CryptoKey`, and a `CryptoKey` carries no provenance — so once a row is admitted, nothing
// downstream can ever ask where the key came from. `sealOp` seals under it. `openOp` opens with
// it. The four barriers of ADR 004 §2.2 and the two of ADR 002 §3 all run AFTER this point and
// all take the ring as given.
//
// So this is the domain, and it is crossed four ways because all four axes change the answer:
//
//   SENDER  who the row SAYS wrapped it (`row.senderKexPubRaw`), which is the ECDH counterparty
//           the KEK is derived from. This is the axis with the finding on it.
//   SCOPE   personal or family. The two have DIFFERENT admissible sender sets, and that is the
//           cell everyone forgets: my Privat space has exactly one legitimate group of senders —
//           my own attested devices — and today it accepts a key from anybody.
//   EPOCH   held / lacking / never minted / below the ring's floor. First-write-wins means the
//           epoch decides whether an injection lands at all.
//   ORDER   before or after the honest row. The relay writes the array, so the relay writes the
//           order, and `ring.has` short-circuits.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE REQUIRED RULE, IN ONE SENTENCE, WITH NO EXCEPTIONS:
//
//     A KEY MAY ENTER THE RING ONLY IF THE ROW'S SENDER KEY IS BOUND TO A VERIFIED DEVICE
//     ATTESTATION OF A DEVICE THAT IS ENTITLED TO WRAP THIS SPACE'S KEY — for a family space, an
//     attested device of a current member; for a personal space, one of MY OWN attested devices,
//     and nobody else's, ever.
//
// and the second half of it, which is what the rule is FOR:
//
//     EVERY ENTRY IN THE RING MAY BE TRUSTED TO SEAL MY OWN PRIVATE CONTENT. There is no such
//     thing as a ring entry that is good enough to try and not good enough to use: `sealOp` picks
//     `currentEpoch`, and `currentEpoch` is the ring's max.
//
// ADR 002 §4.2 step 2 puts exactly this check on the WRAPPING side ("verify the device
// attestation of every current member device, THEN wrap") and `recipientProblem` implements it
// down to binding `att.kexPubRaw` to the key the wrap is addressed to. There is no equivalent on
// the RECEIVING side, and the receiving side is the one that decides which key it will use.
//
// ⚠ CLOSING THIS NEEDS A NEW PARAMETER, NOT A NEW BRANCH. `admitWraps(ring, rows, ctx)` has
// nowhere to put the verified set: no `attestationOf`, no member list, no allowlist of sender
// keys. `openOp` takes `attestationOf` for precisely this reason one seam over. A fix that only
// adds an `if` inside the loop has nothing to compare against and will be relocated by the next
// adversary.
//
// ✔ CLOSED 2026-08-28, that way. `ctx.senders` is a REQUIRED parameter carrying the branded
// `Recipient[]` from `personalRecipients()`/`familyRecipients()`; `admissibleSenders()` verifies
// it with the wrapping side's own `recipientProblem` and indexes the keys IT imported, so the row
// selects a sender rather than supplying one. All 30 cells below now hold, and they hold because
// of the shape of the parameter rather than the position of an `if`: the personal space's sender
// set cannot contain another member's device, because `personalRecipients` refuses to build one.
//
// expect = {
//   row       'admitted' | 'refused' | 'duplicate'   what must happen to THIS row
//   slot      what the row's own `(space, epoch)` slot holds once the batch is done:
//             'the-honest-key'  the key the entitled peer wrapped
//             'this-row'        the key THIS row carried, which is legitimate only when the
//                               sender is entitled
//             'nothing'         the slot stays empty
//             ('the-attacker-key' is never a required value. It is what the property MEASURES.)
//   trusted   may that slot be trusted to seal my own private content? REQUIRED true, in every
//             cell of this domain, without exception. This is 20.5 and 21.2, restated as a
//             property of the ring rather than of the envelope.
// }
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * THE SENDER AXIS — who the row says wrapped it.
 *
 * `entitled(scope)` is the REQUIRED answer to "may this sender put a key into that space's ring".
 * `opens` says whether the blob decrypts at all, which is the only question the code asks today:
 * the two columns being different is the whole finding, and the rows where they AGREE are the
 * controls that stop the property from being vacuous.
 */
export const C1_SENDERS = deep([
  {
    id: 'member',
    label: 'an ATTESTED device of a member of THIS space (family: a fellow member · personal: my own second Mac)',
    wellFormed: true, opens: true,
    entitled: { personal: true, family: true },
    note: 'THE CONTROL. §7.1 step 4\'s ordinary case — two member devices both wrapping the ring '
      + 'to a joiner — lives here, and it must keep working. If this row ever refuses, every '
      + 'refusal below is vacuous.',
  },
  {
    id: 'other-member',
    label: 'an attested device of ANOTHER member — attested, real, and not a member of THIS space',
    wellFormed: true, opens: true,
    entitled: { personal: false, family: false },
    note: 'The sharpest instance is the PERSONAL space: Mama is a real, attested, current member '
      + 'of the Kreis, and she has no business at all in my Privat ring. In the family space the '
      + 'instance is a member of a DIFFERENT Kreis — the same shape, and the reason "attested" '
      + 'is not the whole of the question. Attested BY WHOM, INTO WHAT, is.',
  },
  {
    id: 'unattested',
    label: 'an UNATTESTED device: a throwaway ECDH keypair, no attestation, no member record, no signature',
    wellFormed: true, opens: true,
    entitled: { personal: false, family: false },
    note: 'S1 in its purest form. The attacker needs one keypair and the victim\'s IK_kex, which '
      + 'is a public key published in the victim\'s own attestation inside the E2EE stream.',
  },
  {
    id: 'removed',
    label: 'a device of a member who was REMOVED — her attestation still verifies, her membership does not',
    wellFormed: true, opens: true,
    entitled: { personal: false, family: false },
    note: 'The T2 shape. §8.1 lets her keep everything she already held and §4.1 rotates so she '
      + 'reads nothing new — both of which are about HER ring. This row is about MINE: a removed '
      + 'member must not be able to put a key into it, and an attestation is not a membership.',
  },
  {
    id: 'myself',
    label: 'MYSELF — the row names my own agreement key as the sender',
    wellFormed: true, opens: true,
    entitled: { personal: true, family: true },
    note: 'THE SECOND CONTROL, and it is a real one rather than a formality. A row whose sender '
      + 'key is my own public point derives its KEK as ECDH(myPriv, myPub), which nobody without '
      + 'myPriv can compute — so a self-addressed row that OPENS really did come from me. This is '
      + 'the one cell where "the blob decrypted" IS an authentication, and enumerating it is what '
      + 'stops a fix from over-refusing.',
  },
  {
    id: 'absent',
    label: '`senderKexPubRaw` ABSENT — the field is not there at all',
    wellFormed: false, opens: false,
    entitled: { personal: false, family: false },
  },
  {
    id: 'malformed',
    label: '`senderKexPubRaw` MALFORMED — not base64url, or not 65 bytes',
    wellFormed: false, opens: false,
    entitled: { personal: false, family: false },
  },
  {
    id: 'nobody',
    label: 'a VALID P-256 point BELONGING TO NOBODY — well-formed, importable, and not the key that wrapped this blob',
    wellFormed: true, opens: false,
    entitled: { personal: false, family: false },
    note: 'The row that separates the two refusals. This one is refused TODAY, by the AEAD, '
      + 'because the KEK derives to the wrong bytes — not because anybody asked who the sender '
      + 'was. `unattested` is the same row with the arithmetic done right, and it is admitted. '
      + 'A fix that makes this refusal "stronger" has fixed nothing.',
  },
]);

/**
 * THE SCOPE AXIS. `spaceKindOf` derives this from the id and never takes it from a caller, which
 * is right and is not what this axis is about: the two kinds have different ADMISSIBLE SENDER
 * SETS, and `admitWraps` applies neither.
 */
export const C1_SCOPES = deep([
  { id: 'personal', label: 'my PERSONAL space (`psp_…`) — the one 20.5 is about', prefix: 'psp_' },
  { id: 'family', label: 'the FAMILY space (`fsp_…`)', prefix: 'fsp_' },
]);

/**
 * THE EPOCH AXIS, expressed as the ring's PRE-STATE plus the epoch the row names. The honest
 * peer's row is always present in the batch, at `honestEpoch`, so `order` below always means
 * something.
 */
export const C1_EPOCHS = deep([
  {
    id: 'held', prefill: [4], rowEpoch: 4, honestEpoch: 4,
    label: 'an epoch I ALREADY HOLD — first-write-wins has already decided',
    note: 'The cell where the design protects itself for free, and it is why the finding is about '
      + 'ORDER as much as about authentication.',
  },
  {
    id: 'lacking', prefill: [], rowEpoch: 4, honestEpoch: 4,
    label: 'an epoch I LACK, which the honest peer is wrapping in the same batch',
    note: 'The contested slot. Whoever the relay lists first wins it, permanently.',
  },
  {
    id: 'nonexistent', prefill: [], rowEpoch: 99, honestEpoch: 4,
    label: 'an epoch that DOES NOT EXIST — nobody ever minted it',
    note: 'THE WORST CELL AND THE LEAST OBVIOUS ONE. `currentEpoch` is the ring\'s MAX, so a row '
      + 'admitted at 99 becomes the current epoch and the outbox seals its very next op into it. '
      + 'No honest row will ever contest the slot, because no honest row exists.',
  },
  {
    id: 'below-floor', prefill: [4, 5], rowEpoch: 1, honestEpoch: 4,
    label: 'an epoch BELOW MY RING\'S FLOOR — the back-catalogue a sparse restore is missing',
    note: 'The benign reading is §4.3 / §7.1 step 5: a member restored from a backup needs 1..e '
      + 'to read Oma\'s birthday, and those wraps arrive later than the current epoch. The other '
      + 'reading is that a slot nothing will ever contest is a slot an attacker can have — and '
      + 'what it costs is not sealing but ATTRIBUTION: ops from epoch 1 open under her key and '
      + 'are then folded as history.',
  },
]);

export const C1_ORDERS = deep([
  { id: 'before', label: 'the row arrives BEFORE the honest one', first: 'row' },
  { id: 'after', label: 'the row arrives AFTER the honest one', first: 'honest' },
]);

/**
 * The required behaviour of one cell, derived from the axes rather than written out 128 times.
 *
 * Deriving it is deliberate. A hand-written table of 128 cells is a table somebody will edit one
 * cell at a time, which is the failure this whole method exists to stop; a derivation is a RULE,
 * and a rule that is wrong is wrong visibly and everywhere at once.
 */
function c1Expect(sender, scope, epoch, order) {
  const entitled = sender.entitled[scope.id];
  const shared = epoch.rowEpoch === epoch.honestEpoch;
  const prefilled = epoch.prefill.includes(epoch.rowEpoch);

  // 1. The slot is already occupied — first-write-wins, and it is not an error (§7.1 step 4).
  if (prefilled) return { row: 'duplicate', slot: 'the-honest-key', trusted: true };
  // 2. The honest row took the shared slot first. Same rule, one instant later.
  if (shared && order.first === 'honest') return { row: 'duplicate', slot: 'the-honest-key', trusted: true };
  // 3. A row whose sender is not entitled to wrap this space's key is REFUSED — whether the blob
  //    opens or not. That is the whole of C1's rule, and it is one line because it is one rule.
  if (!entitled) {
    return { row: 'refused', slot: shared ? 'the-honest-key' : 'nothing', trusted: true };
  }
  // 4. Entitled, well-formed, and it opens.
  if (!sender.wellFormed || !sender.opens) {
    return { row: 'refused', slot: shared ? 'the-honest-key' : 'nothing', trusted: true };
  }
  // An entitled sender wraps the key that legitimately belongs to that slot, so at the shared
  // epoch the slot's CONTENT is the honest key however the relay orders the two rows.
  return { row: 'admitted', slot: shared ? 'the-honest-key' : 'this-row', trusted: true };
}

/**
 * WHICH CELLS S1 OWNED — kept as a derivation after the fix, deliberately.
 *
 * Before 2026-08-28 `admitWraps` asked exactly one question — "does the blob open under
 * `row.senderKexPubRaw`" — so a cell deviated precisely when an UNENTITLED sender's blob OPENED
 * and the slot was free. Everything else was either already refused (by the AEAD, or by `rawOf`)
 * or already a duplicate (by first-write-wins), and those cells HELD.
 *
 * That distinction is the reason this stayed a function rather than becoming a constant: it is
 * what separates "refused because nobody asked who you were, and the arithmetic happened to go
 * wrong" from "refused because you are not one of us". A future weakening of the sender check
 * that let the AEAD do the work again would put these same 30 cells back, and `C1_S1_CELLS` names
 * them so the regression can say so by id instead of by count.
 */
function c1WasS1(sender, scope, epoch, order) {
  const req = c1Expect(sender, scope, epoch, order);
  if (req.row !== 'refused') return false;
  if (!sender.opens) return false;             // the AEAD already refused it
  if (!sender.wellFormed) return false;        // `rawOf` already refused it
  return true;
}

/**
 * Which finding predicts this cell fails today.
 *
 * **S1 IS CLOSED** (`spacekeys.js` §6b — `admissibleSenders` + a required `ctx.senders`), so this
 * is `null` for every cell of C1 and the whole domain is expected to hold. If any cell of C1 ever
 * deviates again it arrives as UNEXPECTED, loudest bucket, by id — which is the right report for
 * a barrier that was already broken once.
 */
function c1Finding() {
  return null;
}

export const C1 = deep((() => {
  const out = [];
  for (const s of C1_SENDERS) {
    for (const sc of C1_SCOPES) {
      for (const e of C1_EPOCHS) {
        for (const o of C1_ORDERS) {
          out.push({
            id: `C1-${s.id}/${sc.id}/${e.id}/${o.id}`,
            value: { sender: s.id, scope: sc.id, epoch: e.id, order: o.id },
            label: `${s.label} — into the ${sc.id} ring, at ${e.label}, ${o.label}`,
            senderId: s.id, scopeId: sc.id, epochId: e.id, orderId: o.id,
            expect: c1Expect(s, sc, e, o),
            openFinding: c1Finding(),
            wasS1: c1WasS1(s, sc, e, o),
            note: s.note ?? null,
          });
        }
      }
    }
  }
  return out;
})());

/**
 * The 30 cells finding S1 owned, by id. 3 unentitled-but-opening senders × 2 scopes × the 5
 * (epoch, order) pairs where the slot was free and no honest row had taken it first.
 *
 * A regression that re-opened S1 partially — family-only, or "before"-order only — would show up
 * here as a subset rather than as a number, which is the difference between a work order and a
 * count.
 */
export const C1_S1_CELLS = deep(C1.filter((e) => e.wasS1).map((e) => e.id));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C2 — A BACKUP FILE'S BYTES
//
// The backup is the one artefact the onboarding tells the user to carry OFF the machine: „Wer
// diese Datei und dein Passwort hat, ist du." So its input domain is not "a file we wrote" — it
// is "a file that came back", and every byte of it is attacker-reachable.
//
// Five sub-domains, because five different things arrive in one file and only one of them is
// under the AEAD tag:
//
//   C2a  THE FIELD MAP        which fields are inside the AAD and which are not
//   C2b  THE EPOCH RING       a sparse, empty or malformed ring inside the sealed payload
//   C2c  THE SPACE IDS        a `family.id` naming another Kreis
//   C2d  THE PASSPHRASE       from the empty string up through a 4-digit PIN to a real one
//   C2e  THE KEY STORE        free, conflicting, partially written
//
// THE REQUIRED RULE FOR C2a, IN ONE SENTENCE:
//
//     IF THE FILE CLAIMS TO BE „dein Schlüssel", EVERY FIELD OF IT IS AUTHENTICATED. There is no
//     half of a recovery artefact that anyone may rewrite. `sealAad()` enumerates seven fields;
//     the file has more than seven.
//
// The file's own header argues the opposite and the argument is worth answering rather than
// ignoring: "the board-only file has no key at all, so board authentication could exist on one
// path and not the other, and a guarantee that holds on one path is worse than one stated
// plainly." That is true of the BOARD-ONLY file and says nothing about the identity-bearing one.
// The requirement below is therefore conditional on `hasIdentity`, which is exactly the shape
// that argument permits — and E3-6 is filed as an open PO question, so this domain is where the
// answer gets recorded when it comes.
//
// expect (C2a) = { tagRefuses: boolean, rewritable: boolean }
//   `tagRefuses`  does mutating this field make the AEAD TAG fail? That is what "inside the AAD"
//                 means from outside the module, and it is measurable: the import comes back
//                 `cannot-open`. `false` is not automatically a defect — three fields are
//                 refused EARLIER, by `inspectBackup`'s shape pass, and a refusal is a refusal.
//   `rewritable`  can an attacker who holds the file change this and have the import SUCCEED?
//                 REQUIRED false for every field of an identity-bearing file, with no exceptions.
//                 This is the one that carries the requirement; `tagRefuses` says by which
//                 mechanism, and a fix that moves a field from one refusing mechanism to another
//                 is visible here rather than silent.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Every field of an identity-bearing backup file, with what a rewrite of it must cost. */
export const C2_FIELDS = deep([
  { id: 'C2a-01', value: { path: '_README_de', how: 'replace' },
    label: 'the German README — the sentence the user is told to read',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null,
    note: 'In the AAD, and deliberately: the file\'s own explanation of what it is may not be '
      + 'rewritten by whoever finds it.' },
  { id: 'C2a-02', value: { path: '_README_en', how: 'replace' },
    label: 'the English README',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null },
  { id: 'C2a-03', value: { path: 'app', how: 'replace' },
    label: 'the app version that wrote the file',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null },
  { id: 'C2a-04', value: { path: 'exportedAt', how: 'replace' },
    label: 'the export date',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null },
  { id: 'C2a-05', value: { path: 'format', how: 'replace' },
    label: 'the format tag',
    expect: { tagRefuses: false, rewritable: false }, openFinding: null,
    note: 'Refused by `inspectBackup` before the tag is ever reached — a different mechanism '
      + 'reaching the required answer. Enumerated with `tagRefuses: false` so that "the shape '
      + 'guard is what holds this one" is written down rather than assumed.' },
  { id: 'C2a-06', value: { path: 'v', how: 'replace' },
    label: 'the format version',
    expect: { tagRefuses: false, rewritable: false }, openFinding: null },
  { id: 'C2a-07', value: { path: 'identity.memberId', how: 'replace-member-id' },
    label: 'the MemberId the file restores — replaced with ANOTHER well-shaped MemberId',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null,
    note: 'Replaced with a valid MemberId rather than with rubbish, so the shape pass lets it '
      + 'through and the AAD is what actually answers. A mutation that a cheaper guard catches '
      + 'measures the cheaper guard.' },
  { id: 'C2a-08', value: { path: 'identity.kdf.iterations', how: 'replace' },
    label: 'the PBKDF2 round count — attacker-controlled input to a loop',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null },
  { id: 'C2a-09', value: { path: 'identity.kdf.salt', how: 'flip-first-char' },
    label: 'the KDF salt — one character, so it stays 32 well-formed bytes',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null },
  { id: 'C2a-10', value: { path: 'identity.kdf.name', how: 'replace' },
    label: 'the KDF name',
    expect: { tagRefuses: false, rewritable: false }, openFinding: null },
  { id: 'C2a-11', value: { path: 'identity.kdf.hash', how: 'replace' },
    label: 'the KDF hash',
    expect: { tagRefuses: false, rewritable: false }, openFinding: null },
  { id: 'C2a-12', value: { path: 'identity.sealed', how: 'flip-mid-char' },
    label: 'the sealed block itself — one character, in the middle of the ciphertext',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null,
    note: 'The ciphertext is what the tag is OVER rather than what it is BOUND TO, and from '
      + 'outside the module the two are indistinguishable — both come back `cannot-open`. The row '
      + 'is here so nobody reads `tagRefuses` as a claim about `sealAad()`\'s field list.' },

  // ── the board block — every one of these is E3-6 / M-B4 ───────────────────────────────────
  { id: 'C2a-13', value: { path: 'board.notes.0.text', how: 'replace' },
    label: 'the TEXT of an entry — Mama rewrites „Zahnarzt" to „Scheidungsanwalt"',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null,
    note: 'Measured: the import succeeds, `identityRestored: true`, and the board that comes back '
      + 'is hers. This is the row the PO question E3-6 is about, in the shape it takes on a '
      + 'family NAS.' },
  { id: 'C2a-14', value: { path: 'board.notes', how: 'append-entry' },
    label: 'an entry ADDED to the board',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null },
  { id: 'C2a-15', value: { path: 'board.notes', how: 'empty-array' },
    label: 'every entry DELETED — the quieter shape, and the one with no count to compare against',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null,
    note: 'There is no number anywhere the user could check, because the number `inspectBackup` '
      + 'renders is DERIVED FROM THE BLOCK BEING ATTACKED.' },
  { id: 'C2a-16', value: { path: 'board.categories', how: 'append-entry' },
    label: 'a category added',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null },
  { id: 'C2a-17', value: { path: 'board.settings', how: 'replace' },
    label: 'the settings block',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null },
  { id: 'C2a-18', value: { path: 'board.scratchpads', how: 'replace' },
    label: 'the Notizzettel',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null },
  { id: 'C2a-19', value: { path: 'board._v2', how: 'replace' },
    label: 'the LINEAGE — which op log this board is bound to (ADR 006 §4.1)',
    expect: { tagRefuses: true, rewritable: false }, openFinding: null,
    note: 'The sharpest member of the board class, because it is not content: a rewritten lineage '
      + 'is `domains.js` D1-b18\'s input arriving through the restore door, and D1-b18 costs the '
      + 'calendar rather than one note.' },

  // ── the counter-example, and the row that says WHAT A REWRITE IS ─────────────────────────
  { id: 'C2a-20', value: { path: 'board', how: 'reorder-keys' },
    label: 'the SAME board through a different JSON writer — every key re-ordered, nothing changed',
    expect: { tagRefuses: false, rewritable: true }, openFinding: null,
    note: 'ADDED 2026-08-28, BY A MUTANT THE DOMAIN DID NOT KILL. The S3 fix binds a digest of '
      + 'the board into the AAD, and a mutant that dropped the digest\'s KEY SORT was caught by '
      + 'tier 1 and by M-B4 and by NO CELL IN HERE — because C2a enumerated the ways a field can '
      + 'be CHANGED and never the way a file can be re-written without being changed. That mutant '
      + 'makes every honest re-serialisation of the file unopenable: a user\'s own backup, saved '
      + 'again by a tool that emits keys in a different order, would come back `cannot-open` and '
      + 'look exactly like tampering. '
      + 'THIS IS THE ONE MEMBER OF C2a WHERE `rewritable: true` IS REQUIRED, and it is not an '
      + 'exception to the rule — it is the rule\'s definition. `rewritable` asks "can somebody '
      + 'change this and have the import succeed"; JSON object key order is not something there '
      + 'is to change. Order in an ARRAY is (C2a-14 covers that). A fix that made this row refuse '
      + 'would be authenticating the serializer, not the board.' },
]);

/**
 * C2b — THE EPOCH RING INSIDE THE SEALED PAYLOAD.
 *
 * expect = { imported: boolean, reported: boolean }
 *   `reported` is the requirement M-B6 is filed against: a restore that cannot read epochs 1-3
 *   must SAY SO. Refusing would need I/O and this module is I/O-free by design; reporting does
 *   not, and §7.3 step 6's „Schlüssel ausstehend" is the string that is waiting for it.
 */
export const C2_RINGS = deep([
  { id: 'C2b-1', value: { epochs: [1, 2, 3, 4], epoch: 4 },
    label: 'a COMPLETE ring, 1..4 — the control',
    expect: { imported: true, reported: false }, openFinding: null },
  { id: 'C2b-2', value: { epochs: [4], epoch: 4 },
    label: 'a SPARSE ring: epoch 4 only, no 1-3',
    expect: { imported: true, reported: true }, openFinding: null,
    note: '§4.3 and §7.1 step 5 make "all epochs 1..e" the rule that lets a member see Oma\'s '
      + 'birthday. The wrapping side refuses a partial ring loudly; the restoring side accepts '
      + 'this one in silence.' },
  { id: 'C2b-3', value: { epochs: [1, 3], epoch: 3 },
    label: 'a ring with a HOLE in the middle: 1 and 3, no 2',
    expect: { imported: true, reported: true }, openFinding: null },
  { id: 'C2b-4', value: { epochs: [], epoch: 1 },
    label: 'an EMPTY epoch map — a space bundle carrying no keys at all',
    expect: { imported: false, reported: true }, openFinding: null,
    note: 'THE ROW THAT PROVES C2b-2 IS A CHOICE AND NOT AN OVERSIGHT. `bundleFor` refuses this '
      + 'one at the EXPORT seam, loudly, and its message is: "A backup carries EVERY epoch 1..e — '
      + 'one that carried only the current epoch would restore a member who cannot read the '
      + 'history (A4, 17.1, ADR 002 §7.1 step 5)." That is a verbatim description of C2b-2, which '
      + 'the same function accepts in silence. The requirement is already written down; it is '
      + 'enforced at zero and nowhere else.' },
  { id: 'C2b-5', value: { epochs: [0], epoch: 0 },
    label: 'epoch ZERO — below `FIRST_EPOCH`',
    expect: { imported: false, reported: true }, openFinding: null },
  { id: 'C2b-6', value: { epochs: [-1], epoch: -1 },
    label: 'a NEGATIVE epoch',
    expect: { imported: false, reported: true }, openFinding: null },
  { id: 'C2b-7', value: { epochs: ['nicht-eine-zahl'], epoch: 1 },
    label: 'an epoch key that is not a number',
    expect: { imported: false, reported: true }, openFinding: null },
  { id: 'C2b-8', value: { epochs: [1], epoch: 1, keyBytes: 16 },
    label: 'an epoch whose key is 16 bytes, not 32',
    expect: { imported: false, reported: true }, openFinding: null },
]);

/**
 * C2c — THE SPACE IDS INSIDE THE SEALED PAYLOAD.
 *
 * expect = { imported: boolean, reported: boolean }
 *   `reported` here means: does the result tell its caller that the Kreis binding in this file is
 *   UNVERIFIED? `importBackup` cannot check it — that needs the member list, which is the fold's
 *   and arrives later — but "cannot check" and "does not mention" are different, and only the
 *   first is forced by the I/O-free design.
 */
export const C2_SPACE_IDS = deep([
  { id: 'C2c-1', value: { family: 'own', personal: 'own' },
    label: 'the ids this member really holds — the control',
    expect: { imported: true, reported: false }, openFinding: null },
  { id: 'C2c-2', value: { family: 'another-kreis', personal: 'own' },
    label: 'a `family.id` naming ANOTHER Kreis — „ich hab dir dein Backup wiederhergestellt"',
    expect: { imported: true, reported: true }, openFinding: 'M-B6',
    note: 'The honest scenario is a family member restoring your Mac for you. The file names the '
      + 'Kreis, the recovery identity, and the epoch keys; nothing at this seam can contradict any '
      + 'of it, and §7.3 step 5\'s `POST /devices/adopt` — the only thing that could — is in a '
      + '`server/` that holds `vercel.json` and nothing else.' },
  { id: 'C2c-3', value: { family: 'personal-shaped', personal: 'own' },
    label: 'a PERSONAL id (`psp_…`) in the family slot',
    expect: { imported: false, reported: true }, openFinding: null },
  { id: 'C2c-4', value: { family: 'own', personal: 'family-shaped' },
    label: 'a FAMILY id (`fsp_…`) in the personal slot',
    expect: { imported: false, reported: true }, openFinding: null },
  { id: 'C2c-5', value: { family: 'malformed', personal: 'own' },
    label: 'a `family.id` that is not a SpaceId at all',
    expect: { imported: false, reported: true }, openFinding: null },
  { id: 'C2c-6', value: { family: null, personal: 'own' },
    label: 'NO family bundle — a solo member who never joined a Kreis',
    expect: { imported: true, reported: false }, openFinding: null },
]);

/**
 * C2d — THE PASSPHRASE, from the empty string up.
 *
 * expect = { exported: boolean, weaknessSurfaced: boolean }
 *
 * THE REQUIRED RULE IS THE WEAKER OF THE TWO AVAILABLE ONES, DELIBERATELY. A hard floor is a
 * product decision this file may not make; what it may insist on is that a module whose entire
 * security model is „Wer diese Datei und dein Passwort hat, ist du" has an OPINION about the
 * Passwort and hands it to the sheet that shows `EXPORT_SHEET_COPY`. So: an accepted passphrase
 * below the floor must come back with its weakness SURFACED, not merely accepted.
 *
 * If the PO instead rules a hard floor, this domain is where that is recorded: change
 * `exported: true` to `false` on the weak rows and the property's STALE/UNEXPECTED split will
 * point at every place the decision has to land.
 */
export const C2_PASSPHRASES = deep([
  { id: 'C2d-1', value: '', label: 'the EMPTY STRING',
    expect: { exported: false, weaknessSurfaced: true }, openFinding: null },
  { id: 'C2d-2', value: '   ', label: 'whitespace only',
    expect: { exported: false, weaknessSurfaced: true }, openFinding: null },
  { id: 'C2d-3', value: '1', label: 'ONE CHARACTER',
    expect: { exported: true, weaknessSurfaced: true }, openFinding: null },
  { id: 'C2d-4', value: 'a', label: 'one letter',
    expect: { exported: true, weaknessSurfaced: true }, openFinding: null },
  { id: 'C2d-5', value: '1234', label: 'a 4-DIGIT PIN — 10 000 candidates, i.e. 6e9 PBKDF2 rounds',
    expect: { exported: true, weaknessSurfaced: true }, openFinding: null,
    note: 'Minutes on one laptop. The red team ran the dictionary for real over four guesses and '
      + 'cracked it (M-B2). 600 000 rounds is the RIGHT number and it is not a substitute for '
      + 'entropy.' },
  { id: 'C2d-6', value: 'passwort', label: 'a dictionary word',
    expect: { exported: true, weaknessSurfaced: true }, openFinding: null },
  { id: 'C2d-7', value: '        x', label: 'whitespace with one character in it — trimmed it would be empty, and it is NOT trimmed',
    expect: { exported: true, weaknessSurfaced: true }, openFinding: null,
    note: 'Not trimming is CORRECT — leading and trailing spaces are part of what the user typed '
      + '— and it is also how a passphrase that looks like a refusal case slips past the one '
      + 'guard that exists.' },
  { id: 'C2d-8', value: 'Kirschbaum-Sonntag-Regenschirm-41', label: 'a real passphrase — the control',
    expect: { exported: true, weaknessSurfaced: false }, openFinding: null },
  { id: 'C2d-9', value: 'Schlüsselbund-2026', label: 'a real passphrase with a decomposable umlaut (NFC/NFD)',
    expect: { exported: true, weaknessSurfaced: false }, openFinding: null,
    note: 'The control for the normalisation: macOS produces decomposed umlauts on some input '
      + 'paths, and two byte sequences for „Schlüssel" would derive two different keys.' },
]);

/**
 * C2e — THE KEY STORE THE IMPORT LANDS IN.
 *
 * expect = { code, repairable }
 *   `code`       the `BackupError.code` the import must answer with, or `null` for success.
 *   `repairable` does retrying the SAME import of the SAME file on the SAME store succeed?
 *                Measured, not asserted about intent. REQUIRED true for every state that is this
 *                user's own Mac and this user's own file — „es geht nicht mehr" is not an outcome
 *                this product may have — and REQUIRED FALSE for a store that belongs to somebody
 *                else, where refusing is the point and a retry that suddenly worked would be the
 *                defect.
 */
export const C2_KEYSTORES = deep([
  { id: 'C2e-1', value: { rec: 0, dev: 0 },
    label: 'a FREE store — the ordinary restore',
    expect: { code: null, repairable: true }, openFinding: null },
  { id: 'C2e-2', value: { rec: 3, dev: 3, who: 'same-member' },
    label: 'this member\'s own identity already present — re-importing the same backup twice',
    expect: { code: null, repairable: true }, openFinding: null,
    note: 'Idempotent by design, and it must stay idempotent: users do this.' },
  { id: 'C2e-3', value: { rec: 3, dev: 0, who: 'another-member' },
    label: 'ANOTHER member\'s recovery identity already in the store',
    expect: { code: 'keystore-conflict', repairable: false }, openFinding: null,
    note: 'A refusal, and the right one. The contrast with C2e-5 is the whole of the C2e domain: '
      + 'both are permanent, and only one of them is somebody else\'s Mac.' },
  { id: 'C2e-4', value: { rec: 3, dev: 3, who: 'another-member' },
    label: 'another member\'s device identity as well',
    expect: { code: 'keystore-conflict', repairable: false }, openFinding: null },
  { id: 'C2e-5', value: { rec: 2, dev: 0 },
    label: 'PARTIALLY WRITTEN: 2 of 3 recovery records — a crash between the two `put`s',
    expect: { code: 'keystore-partial', repairable: true }, openFinding: null,
    note: 'Measured: refused on every retry, for ever, and `importBackup` never deletes. The Mac '
      + 'and the file are both intact and the restore is impossible. This is the one cell in C2 '
      + 'that costs the user everything rather than costing them privacy.' },
  { id: 'C2e-6', value: { rec: 1, dev: 0 },
    label: 'partially written: 1 of 3 recovery records',
    expect: { code: 'keystore-partial', repairable: true }, openFinding: null },
  { id: 'C2e-7', value: { rec: 3, dev: 2, who: 'same-member' },
    label: 'the recovery triple complete and 2 of 3 DEVICE records',
    expect: { code: 'keystore-partial', repairable: true }, openFinding: null },
  { id: 'C2e-8', value: { rec: 3, dev: 0, who: 'same-member' },
    label: 'the recovery triple complete, no device records — the BENIGN half-apply',
    expect: { code: null, repairable: true }, openFinding: null,
    note: 'The control that says the partial class is not all one thing: this shape completes '
      + 'idempotently today, which is what proves C2e-5 is a gap and not a law of nature.' },

  // ── the two rows that say WHAT THE REPAIR MAY DELETE ─────────────────────────────────────
  //
  // ADDED 2026-08-28, BY A MUTANT THE DOMAIN DID NOT KILL. S4's fix clears the dead residue of an
  // interrupted write so the retry is not refused for ever. Whether it may do so turns on ONE
  // question — does anything in the store still NAME somebody else — and C2e crossed `who` only
  // with COMPLETE triples, so the mutant that weakened the ownership check to `present === 3`
  // (i.e. stopped checking it on a partial store) was caught by tier 1 and by no cell in here.
  //
  // The pair below is the whole of the rule, stated as two inputs rather than as a sentence:
  // a residue that names another member is refused for ever, and a residue that names NOBODY is
  // cleared — because it is unusable by every reader in `identity.js`, and because refusing it
  // for ever is exactly the defect C2e-5 records.
  { id: 'C2e-9', value: { rec: 3, dev: 0, who: 'another-member', del: ['recSig'] },
    label: 'ANOTHER member\'s recovery identity, PARTIAL — 2 of 3, and the meta still names them',
    expect: { code: 'keystore-conflict', repairable: false }, openFinding: null,
    note: 'Partial AND somebody else\'s. The count says "dead", the metadata says "not yours", '
      + 'and the second one wins: this is `keystore-conflict`, permanently, and NOTHING is '
      + 'deleted. Before S4 this was `keystore-partial` — the same code as the user\'s own '
      + 'wreckage — which was a weaker answer to a sharper input.' },
  { id: 'C2e-10', value: { rec: 2, dev: 0, who: 'another-member' },
    label: 'a 2-of-3 residue with NO metadata — nothing in the store says whose it is',
    expect: { code: 'keystore-partial', repairable: true }, openFinding: null,
    note: 'THE HONEST LIMIT OF THE REPAIR, written down rather than discovered later. The store '
      + 'holds two key records and no name. They may have been anybody\'s; they are usable by '
      + 'NOBODY — `ensureRecoveryIdentity` refuses a partial triple on every read, for ever, so '
      + 'no code path in this product can turn them back into an identity. Clearing them is the '
      + 'same judgement as C2e-5 and it is measured here rather than assumed: if the rule ever '
      + 'becomes "never delete without a name", this row is where that decision lands.' },
]);

export const C2 = deep([
  ...C2_FIELDS, ...C2_RINGS, ...C2_SPACE_IDS, ...C2_PASSPHRASES, ...C2_KEYSTORES,
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C3 — AN ATTESTATION REACHING THE FOLD
//
// ADR 002 §2.3's four acceptance conditions, as the ADR states them:
//
//   (1) the op writing it is admissible — `op.act === memberId`, the record's own member;
//   (2) the register NAME equals `att.deviceShort`;
//   (3) `att.memberId` equals the housing member; and
//   (4) the signature verifies under THAT HOUSING MEMBER's recovery key.
//
// The ADR's own amendment already concedes that these four ARGUE a function and do not ENFORCE
// one, because nothing pure and synchronous can check §5.2.2's P2. This domain enumerates the
// blobs that satisfy them anyway, crosses each with WHEN it arrives relative to the victim's own
// attestation, and records the two things that follow: what `attestationOf` returns, and what
// `openOp` then does to the victim's OWN envelope.
//
// The arrival axis is not a refinement. It is where finding S2(c) lives:
//
//   ALONE   the squat has been folded and the victim's own `member.set{dev.*}` has NOT. A partial
//           pull, a fresh joiner, any batch boundary. There is no causal delivery (ADR 001 §2),
//           pulls are batched, and a joiner starts from seq 0 — so this window is ORDINARY.
//   BEFORE  both present, the squat stamped earlier.
//   AFTER   both present, the squat stamped later.
//
// In BEFORE and AFTER the contest is visible and `attestationOf` returns `null`, which is §2.3's
// ruling and is a park. In ALONE there is nothing to contest: the squatter's blob resolves, P2
// passes (she copied a public key and told the truth about it), P3 passes, the AEAD SUCCEEDS, and
// check 5 THROWS. §5.2.5 says a rejection is final and `store.js` drops a rejected op without
// appending it. The same one op therefore costs the victim a PARK on a client that has folded
// both and a DROP on a client that has folded one.
//
// THE TWO REQUIRED RULES:
//   1. `attestationOf` NEVER returns the squatter's blob for the victim's short. Not ordered, not
//      resolved, not "the earlier one wins" — never.
//   2. A CONTEST NEVER COSTS THE VICTIM AN OP. `retained` is REQUIRED true in every cell: an
//      envelope whose attestation is contested, missing or wrong is PARKED, and a park is
//      re-evaluable (§5.2.5). A throw at check 5 caused by a contested short is a rejection of the
//      VICTIM for something the ATTACKER did, and it is final.
//
// and the third, which is the one §2.3 does not currently offer:
//   3. `recoverable` — the victim must have a way BACK. `dev.*` is write-once and there is no
//      revocation, so today one op parks a Mac for the lifetime of the board. That is S2(b).
//
// ── AMENDED 2026-08-28, BY MEASUREMENT, AFTER FINDINGS §4.5 OPTION (a) LANDED ────────────────
//
// S2(b) and S2(c) are CLOSED, and the fix is stronger than the three rules above asked for, so
// two cells had to be re-stated rather than merely re-measured. `authz.js` now requires a
// possession proof before a `dev.<S>` register becomes a credential — `devOf(cell.stamp) === S`,
// i.e. the op that filed the register was itself stamped by the device it attests, which every
// honest flow already does (§6.3 step 8, §7.3 step 4) and which the squatter cannot do without
// the private key. So:
//
//   · `squat-short/alone` — the pre-collision window — no longer resolves the squatter's blob at
//     all, so `openOp` parks at P1 instead of resolving, decrypting and THROWING at check 5.
//     That was S2(c), and the throw-shaped drop is gone. CLOSED.
//   · `squat-short/before` and `/after` no longer CONTEST anything. The squat is an unproven
//     claim; the victim's own register is proven; the short resolves to the victim and his
//     envelope OPENS. This domain originally required `nobody` + `park:attestation` for these two
//     cells because it was written against §2.3's ruling — "the contest is not resolved" — which
//     §4.5 option (a) replaces. `nobody` was the safest answer available while the fold could not
//     tell the two claims apart; it is not the required one now that it can. THE RULE STANDS
//     UNCHANGED — `attestationOf` still never returns the squatter's blob — and `recoverable` is
//     now trivially true, because the victim never lost anything to recover.
//
// `contests` below is therefore `false` for every shape, and it stays as a named predicate rather
// than being deleted: the next adversary should be able to see, in one line, where a shape would
// re-acquire the power to contest.
//
// expect = {
//   mints          can the blob be MINTED by `attestDevice` at all, or does it need a forged
//                  signature from a modified client? 'yes' | 'forged' | 'refused'
//   foldsAs        'admitted' | 'rejected:<REJECT_REASONS value>'
//   resolves       what `attestationOf(victimShort)` must return:
//                  'the-victim' | 'nobody' | ('the-squatter' is never a required value)
//   victimEnvelope what `openOp` must do with an envelope the VICTIM sealed:
//                  'opened' | 'park:attestation'
//   retained       may that envelope be dropped? REQUIRED false, i.e. retained === true.
//   recoverable    can the victim get out of it? REQUIRED true.
// }
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const C3_SHAPES = deep([
  {
    id: 'honest',
    label: 'THE CONTROL — the victim\'s own attestation, in the victim\'s own record',
    conditions: { c1: true, c2: true, c3: true, c4: true },
    mints: 'yes',
  },
  {
    id: 'squat-short',
    label: 'THE SQUAT — the squatter files the VICTIM\'S short, carrying the VICTIM\'S sigPubRaw, in HER OWN record',
    conditions: { c1: true, c2: true, c3: true, c4: true },
    mints: 'yes',
    note: 'All four conditions pass and P2 passes, because `sigPubRaw` is a PUBLIC key travelling '
      + 'in the victim\'s own register inside the E2EE stream every member can read. `attestDevice` '
      + 'MINTS it: its one guard is P2, and P2 is satisfied. §2.3\'s stated remedy — "attestOpen '
      + '(WP-6) MUST enforce P2, which closes this at the root" — is therefore provably '
      + 'ineffective, and `identity.js`\'s own header says why. ALL OF THAT IS STILL TRUE AS OF '
      + '2026-08-28 and none of it is what changed: the blob still mints, still verifies, still '
      + 'passes all four conditions and still folds. What changed is one line further on — the '
      + 'fold now asks who FILED the register, not just what it says, and she cannot author an '
      + 'op stamped with his short. She can copy every public field; she cannot copy a signature '
      + 'she cannot make.',
  },
  {
    id: 'squat-short-copied-key-own-short',
    label: 'the victim\'s `sigPubRaw` filed under the SQUATTER\'S OWN short — one key, two shorts',
    conditions: { c1: true, c2: true, c3: true, c4: false },
    mints: 'forged',
    note: 'MEASURED 2026-08-28, AND THE MEASUREMENT CHANGED THIS ROW. It was enumerated expecting '
      + 'all four conditions to pass and the fold\'s `shortOfSigPub` check to contest BOTH shorts '
      + '— which would have parked the victim without ever naming the victim\'s short, a second '
      + 'and cheaper route to S2(b). It does not happen, and the reason is worth the row: '
      + '`verifyAttestation` — the built `attestOpen` — enforces P2, so condition (4) is not "the '
      + 'bytes were signed" but "the bytes were signed AND the short certifies the key". A blob '
      + 'carrying somebody else\'s `sigPubRaw` under its own short fails it, and the fold refuses '
      + 'the write outright: `badAttestation`, before `shortOfSigPub` ever sees it. '
      + 'SO §2.3\'S STATED REMEDY IS EFFECTIVE HERE AND PROVABLY INEFFECTIVE AGAINST '
      + '`squat-short`, AND THE DIFFERENCE IS EXACTLY WHAT P2 BINDS: P2 ties a short to a key, '
      + 'and the squat tells the TRUTH about that tie — it copies the key AND the short together. '
      + 'A remedy that binds two fields cannot catch an attacker who copies both. That is one '
      + 'sentence, it is the whole of finding I-3, and this is the row that proves it by contrast '
      + 'rather than by argument. `shortOfSigPub` is therefore defence in depth against a blob '
      + 'that reaches the fold some other way, not the live check it looks like.',
  },
  {
    id: 'name-mismatch',
    label: 'an honest attestation filed under the VICTIM\'S register name — condition (2) fails',
    conditions: { c1: true, c2: false, c3: true, c4: true },
    mints: 'yes',
  },
  {
    id: 'peer-device-id',
    label: 'an honest attestation carrying the VICTIM\'S `deviceId` — the label squat (R4-13a)',
    conditions: { c1: true, c2: true, c3: true, c4: true },
    mints: 'yes',
    note: '`deviceId` is bound by NONE of the four conditions. §2.3\'s fix was to remove the '
      + 'forgeable resolver rather than guard it, so this is admitted, reported on '
      + '`deviceIdCollisions`, and buys its author nothing — which is exactly what makes it a fix. '
      + 'The row is here as the CONTRAST to `squat-short`: the same dishonesty, a different field, '
      + 'and no cost to the victim at all.',
  },
  {
    id: 'into-victims-record',
    label: 'the squatter\'s own honest blob written INTO THE VICTIM\'S record — condition (1) fails',
    conditions: { c1: false, c2: true, c3: true, c4: true },
    mints: 'yes',
  },
  {
    id: 'victims-blob-into-hers',
    label: 'the victim\'s blob copied VERBATIM into the squatter\'s record — conditions (3) and (4) fail',
    conditions: { c1: true, c2: true, c3: false, c4: false },
    mints: 'yes',
  },
]);

export const C3_ARRIVALS = deep([
  { id: 'alone', label: 'the victim\'s own attestation has NOT been folded yet — the pre-collision window',
    victimPresent: false },
  { id: 'before', label: 'both folded, the other one stamped EARLIER', victimPresent: true, squatFirst: true },
  { id: 'after', label: 'both folded, the other one stamped LATER', victimPresent: true, squatFirst: false },
]);

/**
 * The required behaviour of one C3 cell.
 *
 * The rule is short because the requirement is short: the victim's short resolves to the victim
 * or to nobody, and the victim's own envelope is never dropped.
 */
function c3Expect(shape, arrival) {
  // NOTHING IN THIS DOMAIN CONTESTS THE VICTIM'S SHORT ANY MORE — measured 2026-08-28, see the
  // amendment in the block above. Enumerating four shapes that look as if they could was what
  // made it possible to say that precisely: `squat-short` was the one that did, and the
  // possession proof took it away without touching the other three, which never could. A shape
  // regains this power only by being able to author an op stamped with the victim's short.
  const contests = false;
  const wellFormed = shape.conditions.c1 && shape.conditions.c2
    && shape.conditions.c3 && shape.conditions.c4;

  const foldsAs = shape.conditions.c1 === false ? 'rejected:notSelf'
    : (shape.conditions.c2 === false || shape.conditions.c3 === false || shape.conditions.c4 === false)
      ? 'rejected:badAttestation'
      : 'admitted';

  // What must `attestationOf(victimShort)` answer?
  //  · the victim's own attestation present and uncontested ⇒ the victim's.
  //  · contested ⇒ nobody. NEVER the squatter's, at any arrival, in any order.
  //  · the victim's absent and nothing legitimate claims the short ⇒ nobody.
  const resolves = (arrival.victimPresent && !contests) ? 'the-victim' : 'nobody';

  return {
    mints: shape.mints,
    foldsAs,
    resolves,
    victimEnvelope: resolves === 'the-victim' ? 'opened' : 'park:attestation',
    retained: true,
    recoverable: true,
    wellFormed,
  };
}

function c3Finding() {
  // CLOSED 2026-08-28. Both halves of I-3 — S2(b), the permanent park, and S2(c), the hard drop
  // in the pre-collision window — die on the same line in `src/js/core/authz.js`: a `dev.<S>`
  // register is a credential only if the op that filed it was stamped by the device it attests.
  // The rows that proved them are inverted in `tests/attack/crypto-member-impersonate.test.js`
  // (M-I3b, M-I3c, M-I3d) and `tests/attack/round5-attestation.test.js` (R5-7b, R5-7c, R5-7d).
  return null;
}

export const C3 = deep((() => {
  const out = [];
  for (const s of C3_SHAPES) {
    for (const a of C3_ARRIVALS) {
      out.push({
        id: `C3-${s.id}/${a.id}`,
        value: { shape: s.id, arrival: a.id },
        label: `${s.label} — ${a.label}`,
        shapeId: s.id, arrivalId: a.id, conditions: s.conditions,
        expect: c3Expect(s, a),
        openFinding: c3Finding(s, a),
        note: s.note ?? null,
      });
    }
  }
  return out;
})());

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C4 — A PATCH REACHING `sealOp`
//
// ADR 004 §2.2 barrier 4, and `envelope.js`'s own comment on the line it lives on:
//
//   > re-derive the level from the AUTHENTICATED register map, NEVER from the caller.
//
// What the code DID, and what S5 was:
//
//   const declared = op.f['pub.level'] ?? undefined;
//   const folded   = ctx.levelOf(op.e);
//   const level    = declared === undefined || declared === null ? folded : declared;
//
// The caller's value WON whenever the caller supplied one — and a projection must supply one on
// every legitimate transition, so it supplied one nearly always. `brand.level === level` was then
// satisfied by the SAME CALLER having lied twice, and the backstop was handed the lie as its
// level. The authenticated register map was consulted only for a patch that omitted `pub.level`
// entirely.
//
// THE REQUIRED RULE — and, since 2026-08-28, the implemented one:
//
//     THE LEVEL IS THE FOLDED ONE. A declared level is a CLAIM TO BE CHECKED AGAINST IT, never a
//     substitute for it: `declared` present and different from `folded` is a REFUSAL, exactly as
//     a `brand.level` that disagrees is already a refusal, and for the identical reason the code
//     already gives — "refusing rather than picking one; a guess here is how a Belegt entry gets
//     its text published".
//
// The fix was one line — `const level = folded` — plus the sentence that makes it survivable:
// **`ctx.levelOf` reads the entity's authenticated `visibility` TRUTH register, not the
// last-published `pub.level`.** That distinction is the whole of it. The published level is the
// one a transition is moving AWAY from, so a `levelOf` wired to it would make every legitimate
// share a refusal — which is exactly why the old formula needed a fallback onto the caller, and
// exactly the reasoning that made the hole look like a feature. Wired to the truth register, the
// transition agrees with the map (the visibility op is folded before the publish microtask runs,
// ADR 001 §0.9) and there is nothing left for the caller to assert.
//
// What was NOT one line is knowing which cells that changes, which is what this cross is for: it
// named 35, and all 35 moved together.
//
// FOUR AXES, and the fourth is not decoration: the backstop only fires on a field marked
// `geteiltOnly`, so a domain that carried one payload would measure barrier 4 or the backstop but
// never both, and the S5 cell is precisely the one where a lie at barrier 4 lets a `pub.text`
// past the backstop.
//
// expect = {
//   outcome  'sealed' | 'barrier3' | 'barrier4' | 'backstop'
//   level    the level that was APPLIED, observed at the seam barrier 2 is injected into —
//            `ctx.assertFamilyPatch(patch, kind, level)` is handed it, so it is measurable rather
//            than inferred. `null` for a refusal that never reached that seam, which is every
//            barrier-3 and barrier-4 refusal. That asymmetry is not bookkeeping: a barrier-4
//            refusal APPLIES no level, and a domain that recorded one would be describing the
//            code's local variable instead of the input's consequence.
// }
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** ADR 004's three levels, restated rather than imported so a change to the set shows up here as
 *  a disagreement instead of silently widening the domain. */
export const LEVELS = deep(['privat', 'belegt', 'geteilt']);

/** `op.f['pub.level']` — what the CALLER declares. `ABSENT` means the key is not in the patch. */
export const C4_DECLARED = deep([
  { id: 'absent', value: undefined, present: false, label: 'the patch is SILENT — no `pub.level` key at all' },
  { id: 'null', value: null, present: true, label: '`pub.level: null` — present and empty' },
  { id: 'privat', value: 'privat', present: true, label: 'the caller declares `privat`' },
  { id: 'belegt', value: 'belegt', present: true, label: 'the caller declares `belegt`' },
  { id: 'geteilt', value: 'geteilt', present: true, label: 'the caller declares `geteilt`' },
  { id: 'lie', value: 'oeffentlich', present: true, label: 'the caller declares a level that does not exist' },
]);

/** `ctx.levelOf(op.e)` — what the AUTHENTICATED register map says. */
export const C4_FOLDED = deep([
  { id: 'absent', value: undefined, label: 'the register map has no answer (`undefined`)' },
  { id: 'null', value: null, label: 'the register map answers `null` — the entity is unknown to it' },
  { id: 'privat', value: 'privat', label: 'the register map says PRIVAT' },
  { id: 'belegt', value: 'belegt', label: 'the register map says BELEGT' },
  { id: 'geteilt', value: 'geteilt', label: 'the register map says GETEILT' },
  { id: 'lie', value: 'oeffentlich', label: 'the register map answers something outside the set' },
]);

/**
 * The brand, `Symbol.for('lzp/v2/family-patch')`. Three values, and the middle one is the attack:
 * a projection that lied about the level lies in its evidence too, because the evidence is the
 * same object it just built.
 */
export const C4_BRANDS = deep([
  { id: 'matching', from: 'folded', label: 'branded at the AUTHENTICATED level — the honest projection' },
  { id: 'lying', from: 'declared', label: 'branded at the DECLARED level — the projection restates its own lie' },
  { id: 'absent', from: null, label: 'no brand at all — a hand-built patch' },
]);

/**
 * The payload. `pub.text` is `FIELDS.fnote`'s `geteiltOnly` field and is therefore the one the
 * backstop reads; `pub.date` is not, so it separates barrier 4's refusals from the backstop's.
 */
export const C4_PAYLOADS = deep([
  { id: 'withdrawal', fields: { 'pub.date': null, 'pub.text': null }, carriesValue: false, carriesGeteiltOnly: false,
    label: 'a WITHDRAWAL — explicit nulls and nothing else (§5.1, INV-R4)' },
  { id: 'date-only', fields: { 'pub.date': '2026-09-10' }, carriesValue: true, carriesGeteiltOnly: false,
    label: 'a date — the Belegt payload: something is booked, and nothing says what' },
  { id: 'date+text', fields: { 'pub.date': '2026-09-10', 'pub.text': 'Scheidungsanwalt 14:30' },
    carriesValue: true, carriesGeteiltOnly: true,
    label: 'a date AND the TEXT — the payload 16.7 and INV-R1 exist to keep off the wire below Geteilt' },
]);

function c4Expect(declared, folded, brand, payload) {
  const brandLevel = brand.from === null ? undefined
    : brand.from === 'folded' ? folded.value : declared.value;

  // BARRIER 3 — the brand must be present and well-formed. `familyPatchBrand` answers null for a
  // `level` outside `VISIBILITY_LEVELS`, and a null brand is barrier 3's refusal, not barrier 4's.
  if (brand.from === null || !LEVELS.includes(brandLevel)) return { outcome: 'barrier3', level: null };

  // BARRIER 4, first clause — the level comes from the register map. If the map has no usable
  // answer there IS no level, and no declared value may supply one.
  if (!LEVELS.includes(folded.value)) return { outcome: 'barrier4', level: null };
  const level = folded.value;

  // BARRIER 4, second clause — THE FIX. A declared level that disagrees with the authenticated
  // one is refused, not preferred. (`absent` and `null` are silence, not disagreement.)
  if (declared.present && declared.value !== null && declared.value !== level) {
    return { outcome: 'barrier4', level: null };
  }

  // BARRIER 4, third clause — a Privat entry produces no family op at all; the one thing that
  // legitimately travels at `privat` is a withdrawal.
  if (level === 'privat' && payload.carriesValue) return { outcome: 'barrier4', level: null };

  // BARRIER 4, fourth clause — the projection's own restatement must agree with the map.
  if (brandLevel !== level) return { outcome: 'barrier4', level: null };

  // BARRIER 2 is injected by the caller and is REQUIRED; the property injects a stub, because
  // `core/project.js` is WP-10 and until it lands no family `pub.set` can be sealed at all.

  // THE BACKSTOP — content in a `geteiltOnly` field below Geteilt.
  if (payload.carriesGeteiltOnly && level !== 'geteilt') return { outcome: 'backstop', level };

  return { outcome: 'sealed', level };
}

/**
 * S5 — **CLOSED 2026-08-28.** No C4 cell carries an open finding any more.
 *
 * WHAT IT WAS. `envelope.js` read `level = declared ?? folded`, so a cell deviated exactly when
 * the declared value was USABLE AS A LEVEL, differed from the folded one, and the brand backed
 * the lie — a brand that told the truth would then disagree with `level` and be refused anyway.
 * 35 of the 324 cells. The predicate is kept below, disabled, because it is the thing that says
 * WHICH cells the fix had to move, and a work order that has been deleted cannot be re-run.
 *
 * WHAT CLOSED IT. `assertProjected` now assigns `const level = folded` — `declared` appears in no
 * expression that produces the level — and refuses a `declared` that is present, non-null and
 * different from it. The legitimate transition survives because `ctx.levelOf` is specified
 * against the entity's authenticated `visibility` TRUTH register (which already carries the new
 * level when the publish microtask runs, ADR 001 §0.9), not against the last-published
 * `pub.level`. ADR 004 §2.2 barrier 4 is amended to match; the old `??` formula was the ADR's
 * own wording and it named the wrong register.
 *
 * THE TEN COINCIDENCE CELLS ARE STILL COINCIDENCES, and they are now the only reason to read
 * this function: `declared:'privat'` with a payload carrying a value is refused by barrier 4's
 * PRIVAT clause, which is looking at a different question. They were never S5's, they hold for a
 * reason that is not the fix, and if the privat clause ever moves they turn UNEXPECTED — the
 * correct alarm, because the guard holding them was never theirs.
 */
const S5_CLOSED = true;
function c4Finding(declared, folded, brand, payload) {
  if (S5_CLOSED) return null;
  /* c8 ignore start — the closed predicate, kept so the work order can be re-run, not re-derived */
  if (brand.from !== 'declared') return null;              // the honest brand refuses the lie for us
  if (!declared.present || declared.value === null) return null;   // silence consults the map already
  if (!LEVELS.includes(declared.value)) return null;       // a level outside the set dies either way
  if (declared.value === folded.value) return null;        // no disagreement, nothing to prefer
  if (declared.value === 'privat' && payload.carriesValue) return null;   // the coincidence, above
  return 'S5';
  /* c8 ignore stop */
}

export const C4 = deep((() => {
  const out = [];
  for (const d of C4_DECLARED) {
    for (const f of C4_FOLDED) {
      for (const b of C4_BRANDS) {
        for (const p of C4_PAYLOADS) {
          out.push({
            id: `C4-${d.id}/${f.id}/${b.id}/${p.id}`,
            value: { declared: d.id, folded: f.id, brand: b.id, payload: p.id },
            label: `patch declares ${d.label} · ${f.label} · ${b.label} · ${p.label}`,
            declaredId: d.id, foldedId: f.id, brandId: b.id, payloadId: p.id,
            expect: c4Expect(d, f, b, p),
            openFinding: c4Finding(d, f, b, p),
          });
        }
      }
    }
  }
  return out;
})());

/**
 * The one C4 input that is not a cell of the cross, because it is about `ctx` rather than about
 * the patch: no `levelOf` at all. It is enumerated so that "the level must be re-derived, and
 * injecting it is the outbox's obligation" is a runnable row and not only a docblock.
 */
export const C4_NO_LEVELOF = deep([
  { id: 'C4-no-levelOf', value: { levelOf: 'absent' },
    label: 'the seal path injects NO `ctx.levelOf` — there is no authenticated level to re-derive',
    expect: { outcome: 'barrier4', level: null }, openFinding: null,
    note: 'A security check that is skipped when absent is not a security check, and this is the '
      + 'row that says so about barrier 4 specifically. Its sibling — no `ctx.assertFamilyPatch` '
      + '— is barrier 2 and is asserted by M-R7 in the attack suite.' },
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C5 — A `pub.set` REACHING THE FOLD: WHICH CONTENT SURVIVES THE ENTITY'S LEVEL
//
// ADDED 2026-08-28, by the integrator, on the redaction agent's report. C4 is the AUTHOR side of
// the same question and it is now closed; this is the half that was left open, and the report
// that opened it says exactly why it is not a duplicate:
//
//   > Barriers 3, 4 and the backstop are all AUTHOR-side: a member running a patched build has
//   > no seal path to defeat. `geteiltOnly` (`core/ops.js` FIELDS) is enforced at seal time only
//   > and `src/js/core/authz.js` never reads it, so a peer applies whatever arrives.
//
// So C4's subject is `sealOp` on MY Mac and C5's subject is `foldAuthorized` on EVERYBODY ELSE'S.
// The two domains share the `geteiltOnly` mark and nothing else: C4 asks "may I publish this",
// C5 asks "must I apply what I was sent", and the second question survives the first being
// answered correctly, because the attacker owns the machine that asks it.
//
// ── WHY THE LEVEL AXIS HAS A `source`, AND WHY THAT IS THE POINT ─────────────────────────────
//
// The naive receiver-side check is "refuse a geteiltOnly value if the level AT THIS OP'S STAMP
// is not geteilt". That check is worthless, and `later-op` is the input that says so: an op that
// was ENTIRELY LEGITIMATE when it was sealed (the entry really was Geteilt at T1) becomes a leak
// the moment the owner downgrades at T2. Under LWW the downgrade only clears `pub.text` if the
// downgrading patch remembered to carry `'pub.text': null` — and a patched build, an older
// build, or a replayed T1 envelope all produce a state where `pub.level` says belegt and
// `pub.text` still holds the value, on every device, for ever.
//
// So the required rule reads the FINAL folded level, exactly as stage 3b's co-edit predicate
// already does, and for the same stated reason: admissibility must not depend on which op the
// folding device saw first. `later-op` is the cell that makes that non-optional rather than
// tasteful, and it is the cell a branch-by-branch reading does not have.
//
// ── WHY `date` IS MEASURED ALONGSIDE `text` ──────────────────────────────────────────────────
//
// It is the whole difference between the two implementable rules. REJECTING the offending op
// drops its `pub.date` too — and at Belegt a date is not content above level, it is the entire
// legitimate Belegt payload. So a rule that rejects makes a later downgrade silently destroy the
// booking it was supposed to keep. NULLING OUT the offending FIELD keeps it. `date` is the
// column where those two rules disagree, and no cell of C4 could have shown it.
//
// expect = {
//   admitted   did the op reach the register map at all (false = rejected or parked by an
//              EXISTING stage-3 gate — C5 must not change which ops are admissible)
//   text       the folded `pub.text` register AFTER the fold: 'value' | 'null' | 'none'
//              ('none' = no register — either never written, or written and dropped)
//   date       the folded `pub.date` register, same alphabet. The survival column.
//   reported   the result NAMES the drop, so the panel can say content was withheld rather
//              than silently disagreeing with the sender about what was published
// }
//
// THE LAW OVER THE WHOLE DOMAIN, asserted once rather than per cell: `text === 'value'` implies
// `level === 'geteilt'`. That is INV-R1 restated as a property of the ENUMERATION, which is the
// form that cannot be relocated by an `else if`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Who authored the content op, relative to the entity's owner. The two stage-3 paths. */
export const C5_WRITERS = deep([
  { id: 'owner', label: 'the entity\'s OWNER — stage 3a admits it without consulting a register' },
  { id: 'coeditor', label: 'a CO-EDITOR — stage 3b, gated on the folded `pub.coEdit` and `pub.level`' },
]);

/** The content op's payload. Same three shapes as C4, so the two halves stay comparable. */
export const C5_PAYLOADS = deep([
  { id: 'withdrawal', fields: { 'pub.date': null, 'pub.text': null },
    carriesValue: false, carriesGeteiltOnly: false,
    label: 'a WITHDRAWAL — explicit nulls (§5.1, INV-R4): legal at every level, by construction' },
  { id: 'date-only', fields: { 'pub.date': '2026-09-10' },
    carriesValue: true, carriesGeteiltOnly: false,
    label: 'a date — the Belegt payload: the slot is taken, and nothing says by what' },
  { id: 'date+text', fields: { 'pub.date': '2026-09-10', 'pub.text': 'Scheidungsanwalt 14:30' },
    carriesValue: true, carriesGeteiltOnly: true,
    label: 'a date AND the TEXT — the geteiltOnly value INV-R1 keeps off every peer below Geteilt' },
]);

/**
 * The entity's level, and WHERE IT COMES FROM. Ten valid pairs, not twelve: a level that no op
 * ever wrote is `none`, and `none` has no source to vary.
 *
 * `same-op`    the content op itself carries `pub.level`. For the OWNER this is the ordinary
 *              transition (ADR 004 §5 writes level and content in one patch). For a CO-EDITOR it
 *              is an attack — `pub.level` is `gov`, so the op is not a co-edit at all — and the
 *              cell exists to prove the co-editor cannot unlock the field by asserting the level,
 *              which is precisely S5's move re-tried on the receiving side.
 * `earlier-op` an owner gov op set the level BEFORE the content op.
 * `later-op`   the content op is sealed first, at Geteilt, entirely legitimately — and an owner
 *              gov op afterwards moves the level. THE RETROACTIVE CELL. See the header.
 */
export const C5_LEVELS = deep([
  { id: 'none', level: undefined, source: 'none',
    label: 'NO `pub.level` register at all — the entity has never been published' },
  ...['privat', 'belegt', 'geteilt'].flatMap((lv) =>
    ['same-op', 'earlier-op', 'later-op'].map((src) => ({
      id: `${lv}/${src}`, level: lv, source: src,
      label: `the folded level is ${lv.toUpperCase()}, written by the ${src.replace('-', ' ')}`,
    }))),
]);

/**
 * THE REQUIRED BEHAVIOUR. Derived from the two AUTHOR-side rules already in the codebase and
 * from nothing else — a receiver-side rule invented here rather than mirrored would be a second
 * answer to "what may exist at this level", which is the mistake ADR 004 warns about:
 *
 *   `assertNoContentAboveLevel` (the backstop) — a `geteiltOnly` field may not carry a value
 *                                                below Geteilt. An explicit null always may.
 *   barrier 4's PRIVAT clause                  — a Privat entity publishes no value at all.
 *
 * Read together and keyed on the FOLDED level, that is: at `geteilt` nothing is above; at
 * `belegt` the `geteiltOnly` fields are; at `privat` — and where there is no level at all —
 * every non-governing `pub.*` field is. Governing registers (`pub.level`, `pub.coEdit`,
 * `pub.alive`, `_born`) are never content and are never dropped: they are HOW a withdrawal is
 * expressed, and a rule that dropped them could not be undone by the admin unshare that has to
 * survive it.
 */
function c5Expect(writer, payload, lv) {
  const p = payload.fields;
  const has = (f) => Object.prototype.hasOwnProperty.call(p, f);
  const cell = (v) => (v === undefined ? 'none' : v === null ? 'null' : 'value');

  // ── Which ops are ADMISSIBLE is decided by gates that already exist, and C5 must not move
  // them. A co-editor is refused unless the entity is co-editable AND Geteilt (stage 3b), and a
  // co-editor op that carries `pub.level` is not a co-edit at all (stage 3a, NOT_OWNER).
  if (writer.id === 'coeditor') {
    const admissible = lv.source !== 'same-op' && lv.level === 'geteilt';
    if (!admissible) {
      // Nothing of the co-editor's op lands. What the registers hold is whatever the OWNER's own
      // gov op wrote, and a gov op writes no content — so both content columns are empty.
      return { admitted: false, text: 'none', date: 'none', reported: false };
    }
  }

  // ── The op passes the gates that already exist. Now: what survives the level?
  const level = lv.level;                     // `undefined` when no op ever wrote one
  const dropped = (field, geteiltOnly) => {
    if (!has(field) || p[field] === null) return false;   // absent, or an explicit withdrawal
    if (level === 'geteilt') return false;                // nothing is above Geteilt
    if (level === 'belegt') return geteiltOnly;           // only the geteiltOnly fields are
    return true;                                          // privat, or no level: all content is
  };
  const dropText = dropped('pub.text', true);
  const dropDate = dropped('pub.date', false);

  // WHETHER ANYTHING OF THE OP SURVIVES. `pub.level` is governing and is never dropped, so an op
  // that carries the transition as well as the content still has a body after the redaction —
  // which is why `same-op` is an axis and not a convenience. When the redaction empties the
  // patch there is nothing applicable left: `applyOp` refuses an op that writes nothing
  // (`registers.js:applicabilityError`), so it cannot be admitted, and stage 3b already sets the
  // precedent of rejecting a whole `pub.set` whose fields do not pass.
  const survivors = Object.keys(p).filter((f) =>
    !(f === 'pub.text' ? dropText : f === 'pub.date' ? dropDate : false)).length
    + (lv.source === 'same-op' ? 1 : 0);                  // the `pub.level` this op carries

  return {
    admitted: survivors > 0,
    text: dropText ? 'none' : cell(has('pub.text') ? p['pub.text'] : undefined),
    date: dropDate ? 'none' : cell(has('pub.date') ? p['pub.date'] : undefined),
    reported: dropText || dropDate,
  };
}

/**
 * S5(r) — the receiver-side half of S5, OPEN when this domain was written.
 *
 * Every cell where the fold is required to drop something is a cell the build fails today,
 * because `core/authz.js` contains no occurrence of `geteiltOnly` at all — which is asserted
 * literally, as a grep, by `crypto-member-read.test.js` M-R7c. There is no branch to point at;
 * that is the finding.
 */
const S5R_CLOSED = true;
function c5Finding(writer, payload, lv) {
  if (S5R_CLOSED) return null;
  /* c8 ignore start — the closed predicate, kept so the work order can be re-run, not re-derived */
  const e = c5Expect(writer, payload, lv);
  return e.reported ? 'S5(r)' : null;
  /* c8 ignore stop */
}

export const C5 = deep((() => {
  const out = [];
  for (const w of C5_WRITERS) {
    for (const p of C5_PAYLOADS) {
      for (const lv of C5_LEVELS) {
        out.push({
          id: `C5-${w.id}/${p.id}/${lv.id}`,
          value: { writer: w.id, payload: p.id, level: lv.level ?? null, source: lv.source },
          label: `${w.label} · ${p.label} · ${lv.label}`,
          writerId: w.id, payloadId: p.id, levelId: lv.id,
          level: lv.level ?? null, source: lv.source,
          expect: c5Expect(w, p, lv),
          openFinding: c5Finding(w, p, lv),
        });
      }
    }
  }
  return out;
})());

/** The cells S5(r) had to move — named by id, so a partial fix shows as a SUBSET, not a count. */
export const C5_S5R_CELLS = deep(C5.filter((e) => e.expect.reported).map((e) => e.id));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE INDEX
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const DOMAINS = deep({
  C1: {
    id: 'C1',
    title: 'a wrap row arriving at `admitWraps` — WHICH KEY THE VICTIM USES',
    entries: C1,
    subject: 'spacekeys.admitWraps → unwrapSpaceKey → KeyRing.put → envelope.sealOp',
  },
  C2: {
    id: 'C2',
    title: 'a backup file\'s bytes',
    entries: C2,
    subject: 'backup.sealAad / inspectBackup / importBackup → importSpaces / assertKeyStoreIsFree',
  },
  C3: {
    id: 'C3',
    title: 'an attestation reaching the fold',
    entries: C3,
    subject: 'identity.attestDevice → authz.foldAuthorized (§2.3 conditions 1-4) → attestationOf → envelope.openOp',
  },
  C4: {
    id: 'C4',
    title: 'a patch reaching `sealOp` — WHICH LEVEL DECIDES WHAT MAY BE PUBLISHED',
    entries: [...C4, ...C4_NO_LEVELOF],
    subject: 'envelope.assertProjected — ADR 004 §2.2 barriers 3 and 4, and the backstop',
  },
  C5: {
    id: 'C5',
    title: 'a `pub.set` reaching the FOLD — WHICH CONTENT SURVIVES THE ENTITY\'S LEVEL',
    entries: C5,
    subject: 'authz.foldAuthorized stage 3c — INV-R1 on the RECEIVING device (the mirror of C4)',
  },
});

export const DOMAIN_IDS = deep(['C1', 'C2', 'C3', 'C4', 'C5']);

/** Every entry across every domain, tagged with the domain it came from. */
export const ALL = deep(DOMAIN_IDS.flatMap((d) => DOMAINS[d].entries.map((e) => ({ domain: d, ...e }))));

/** The entries a finding id predicts will fail — the work order, per row. */
export function byFinding(finding) {
  return ALL.filter((e) => e.openFinding !== null && String(e.openFinding).startsWith(finding));
}

/** Every finding id named anywhere in this file, sorted. */
export const OPEN_FINDINGS = deep([...new Set(ALL.map((e) => e.openFinding).filter(Boolean))].sort());
