// src/js/family/leavedelete.js — F20's four irreversible moments, and the sentences that come
// before them.  LZP-606 (20.3) · LZP-607 (20.4) · the confirmations for 20.1 and 20.2 · addendum
// deliverable 22 · ADR 002 §7.4 · ADR 003 §3 (`handlers/lifecycle.js`).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE COPY IS THE DELIVERABLE. THE DIALOGS ARE THE PACKAGING.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The addendum's design note under F20 is one sentence long and it is the whole ticket:
//
//   > "Removal/leave confirmations must state the consequences of 20.2/20.3 in one plain
//   >  sentence."
//
// So `LIFECYCLE_COPY` below is not strings-for-a-dialog; it is the product's answer to four
// questions a person is entitled to have answered before they press a button they cannot unpress,
// and `consequencesOf()` is a pure function so those answers can be asserted in a test without a
// DOM. The dialogs are forty lines of `openSheet`. If this file is ever refactored, the copy is
// the part that must survive intact.
//
// ── THE FOUR SENTENCES, AND WHERE EACH ONE COMES FROM ────────────────────────────────────────
//
//   20.2  removal  "their shared/Belegt entries leave every family board and their access ends —
//                   their private data on their own machine is untouched, BECAUSE IT WAS NEVER
//                   OURS."   The last clause is not reassurance, it is architecture: the relay
//                   only ever held that member's shared and Belegt ciphertext, and
//                   `purgeMember()` deletes exactly that. There is no endpoint that could reach
//                   a Privat entry, because a Privat entry never left the Mac it was typed on.
//
//   20.3  leaving  "others' shared entries disappear from my board, my own entries all revert to
//                   private and stay with me — NOBODY EVER LOSES THEIR OWN DATA BY LEAVING."
//                   Symmetric with 20.2 and self-initiated. `leaveSpace` runs the same
//                   `purgeMember` and additionally deletes the space when the leaver was the last
//                   one in it, which is a consequence this file states rather than discovers.
//
//   20.4  delete   "server data is purged and EVERY MEMBER REVERTS TO A FULLY INTACT SOLO BOARD."
//                   True because every device holds a complete replica (ADR 003 §6.3). This is
//                   the one destructive-looking action in the product that destroys no user data
//                   at all, and the copy has to carry that or the button never gets pressed.
//
//   20.1  transfer "nothing about the entries changes — including who can see what." A role is
//                   not a key. 20.5 is untouched by a transfer, and saying so here is what keeps
//                   the danger zone from implying that the admin seat is a viewing seat.
//
// ── THE HONESTY THE DESIGN DEMANDS, IN EVERY ONE OF THEM (addendum §6, ADR 002 §7.4) ─────────
//
//   > "unsharing is not unremembering: once synced, others' devices held a copy; 16.5 removes it
//   >  from their boards, but a screenshot is forever."
//
// Both the removal and the leave confirmation carry the second line — „Geteiltes lässt sich
// zurücknehmen, Gesehenes nicht." — and the relay agrees with it in as many words: every
// lifecycle response carries `alreadyDeliveredIsIrrevocable: true`, which ADR 002 §7.4 put there
// so that "the client cannot claim something stronger on screen". `assertRelayAgrees()` below
// checks it and warns when a response has stopped saying so, because copy that outlives the
// behaviour it describes is the failure mode this whole product is written against.
//
// ── WHAT THIS FILE DELIBERATELY DOES NOT SAY ─────────────────────────────────────────────────
//
//  · It never says a removal reaches into anyone's Mac. It does not.
//  · It never says the removed member "can no longer read what they had". They can. What ends is
//    access to anything NEW.
//  · It never phrases the admin role as sight (20.5). See `adminpanel.js`'s `cannotSee` line.
//
// ── THE ONE SEAM THAT IS OUT OF SCOPE, NAMED WHERE IT BITES ──────────────────────────────────
//
// LZP-608 — the epoch rotation that must follow a removal (ADR 002 §4.1/§4.2) — is a parallel
// round's. Every relay response already carries `rotateRequired: true`, and `runRemove()` passes
// it to `port.afterRemove()` rather than swallowing it, so the day 608 lands it has a caller and
// a value waiting for it and nothing in this file changes. Until then the copy claims exactly
// what the server does: access ends, the ops are purged, the wraps are deleted, the outstanding
// invites are revoked. It claims nothing about future ciphertext, because without the rotation
// that claim would be false.

// ── THE CO-SIGNATURE SCREEN — read this before touching any of the three sheets ──────────────
//
// **A shipping prerequisite, not an owed nicety.** `handlers/lifecycle.js` requires a second
// member row's recovery signature in three states, two of which a normal family reaches without
// anybody attacking anything:
//
//   · `POST /spaces/:id/delete` whenever the space has ever had more than one member row — i.e.
//     for every real Familienkreis, always;
//   · `POST /members/remove` when the target IS the founder;
//   · `POST /members/remove` for EVERY removal once `Space.founderMemberId` no longer names a
//     LIVE member — which the shipped `transferAdmin` + `/members/leave` path produces routinely
//     (finding T5-M3). Until this file existed, such a circle could not remove anybody at all
//     through the UI: the gate worked and the product could not use it.
//
// `COSIGN_COPY` and the four pure functions below are the deliverable; the sheets are packaging,
// exactly as for the four confirmations above.
//
// ── WHAT THE SCREEN MAY SAY, AND THE WORDS IT MUST USE ───────────────────────────────────────
//
// `handlers/lifecycle.js` exports `PROVES` / `PROVES_NOT` so that no screen is ever built on
// „von zwei Personen bestätigt" when the relay only counted ROWS. Those two sentences are
// translated here — `COSIGN_COPY.proves` and `COSIGN_COPY.provesNot` — and they are shown to
// BOTH people: to the one who asks, and to the one who signs. The strong sentence is:
//
//     *zwei verschiedene Mitglieds-Einträge dieses Kreises haben je einen
//      Wiederherstellungs-Schlüssel hinter diesen Schritt gestellt*
//
// and never anything about two people. `tests/tier2/cosign.dom.js` §5 sweeps every leaf of
// `COSIGN_COPY` for the claim this file must not make, in both languages.
//
// ── WHAT MAKES „A SECOND HUMAN ON A SECOND DEVICE" CONCRETE, AND WHERE IT STOPS ──────────────
//
// Concrete, and structural rather than promised:
//
//   1. the signature is minted from `RK_sig` — the recovery private key in the SIGNER's own key
//      store. This Mac holds exactly one, its own;
//   2. `verifyAdminProof` refuses `by === callerMemberId` before it spends a verification, so a
//      proof minted on the asking Mac is worthless by construction, not by policy;
//   3. the round trip is out-of-band on purpose. The request block and the co-signature block
//      are text the two people send each other; **nothing in this flow touches the network** —
//      no pending-request store, no relay round trip, no notification. `cosign.dom.js` §2 pins
//      the zero-call property, because it is simultaneously the Principle 9 property and the
//      reason one person cannot script the second half;
//   4. the co-signer's sheet refuses to sign a request whose `presenter` is this Mac's own
//      member id — the one shape that would be a person co-signing for herself.
//
// Where it stops, said here because the copy is not allowed to imply otherwise: **finding
// T5-M2.** One person who invites herself, redeems as a second member and keeps both recovery
// keys in her own Keychain satisfies the two-row rule alone. No screen can close that — the
// closes are a signed invite chain or the co-signature in the op log, and both are protocol work
// in somebody else's file. This screen must not make it worse and does not: it adds no way to
// hold a second member's key, and it never claims a second person.
//
// ── PRINCIPLE 9 — A REMOVAL IS NOT A CAMPAIGN ────────────────────────────────────────────────
//
// ADR 002 §4.1 and F20 set the tone and this screen keeps it. There is **no** notification to the
// target, **no** "X möchte Y entfernen" broadcast, **no** vote count, **no** list of pending
// requests, and nothing is persisted anywhere: `settings`, the op log and the relay are all
// untouched until the act itself. One person asks; one person signs. And the sheet refuses to
// ask the TARGET for her own co-signature — the relay would take it (she is a live row and not
// the caller), and taking it would turn this into the lobbying surface F20 forbids. That refusal
// is presentational and says so in the code; what it protects is not.
//
// ── ONE PROOF, ONE ACT (finding T5-M4) ───────────────────────────────────────────────────────
//
// The signed bytes bind act, space, TARGET, epoch and presenter, and `removeMember` refuses a
// proof for an act that already happened. So a co-signature is spent when it is used and is
// bytes for any other target. The sheet therefore holds one `terms` object for its whole life,
// checks a pasted co-signature against exactly those terms before it will send it, and offers
// nothing to reuse: closing the sheet is the whole of the disposal. The relay's
// `admin_proof_target_already_removed` 400 is a SUCCESS SYNONYM — „ist bereits entfernt" — and
// is rendered as one.
//
// ── THE CAVEAT, MET BEFORE IT BITES ──────────────────────────────────────────────────────────
//
// In a founder-less TWO-member circle the rule is unsatisfiable: the only possible co-signer is
// the target. `COSIGN_COPY.nobody` is that sentence, and `adminpanel.js` also shows
// `COSIGN_COPY.strandNote` standing in the danger zone of a small circle and adds
// `leave.leavesTwoBehind` to the leave confirmation — so a person meets it as a plain sentence
// before she is in it, and not as a 403.
//
// ── FINDING F-SHELL-2, AND THE FIX FOR IT THAT CANNOT BE BUILT HERE ──────────────────────────
//
// The shell pass (`docs/v2/SHELL-VERIFICATION.md` §5) measured that sentence NOT firing in the
// one state it was written for: in a real founder-less two-member circle
// `adminpanel.js#eligibleCosigners` returned **2**, not 0, so the person met
// `403 founder_gone_every_removal_needs_second_key` instead of the paragraph that explains it.
// The cause is that `eligibleCosigners` counts from THIS Mac's folded member log — correctly,
// because that is the list the sheet shows — and a REMOVAL writes `member.set{_alive:false}`
// into that log while a LEAVE writes nothing.
//
// **The obvious repair — have `confirmLeaveCircle` publish `member.set{me}{_alive:false}` just
// before `port.leaveSpace()` — does not work, and the reason is on the relay, not here.**
// `POST /api/v1/members/leave` runs `purgeMember`, whose first act is
//
//     server/core/handlers/lifecycle.js:229
//     const purgedOps = … await tx.deleteOpsByDevices(spaceId, own.deviceShorts)
//
// — every op authored by the leaver's devices, deleted in the same transaction as the leave,
// with no filter on op kind (`server/adapters/memory.js:241`, `server/adapters/prisma.js:278`).
// A departure op published a millisecond earlier is deleted a millisecond later, and
// `tests/server/lifecycle.test.js` already measures exactly that — the row
// „20.3 — leaving is self-service, and the last member out deletes the space" seeds `op_m` from
// Mama's device, has Mama leave, and asserts `purgedOps === 1` and that the ops that survive are
// `['op_p']`. It is green on both adapters, which is the proof and it is not mine to write.
// Publishing one from here would be an op every peer would have to pull inside the gap between
// two calls in the same handler — i.e. a doomed op, which is the failure
// `family/removal.js#REMOVAL_PATCH` and `core/ops.js#attestMyDevice` both exist to make loud.
//
// So the leaver structurally cannot announce her own departure, and the fix belongs where the
// count is taken. The relay's `removedAt` column is ALREADY on this Mac:
// `family/mount.js#refreshRoster` reads it off `GET /spaces/:id/members` into `rosterCache` and
// hands it to `membersui.js` as `port.roster()`. The repair is one intersection inside
// `adminpanel.js#eligibleCosigners` — a member the log calls alive but the roster stamps
// `removedAt` is not a co-signer — plus the one line that gives `adminpanel.js` the same roster
// port `membersui.js` already gets. `core/authz.js` needs NO change: stage 2's SELF branch
// already admits a member's write to their own record and its `onlyAlive` branch already admits
// the admin's, so nothing about the fold is in the way. Owner: `src/js/family/adminpanel.js`
// and `src/js/family/mount.js`. Recorded here because this is the file the next person opens.

import { el, openSheet, toast } from '../ui.js';
import { t, getLang } from '../i18n.js';

/** Whichever of a `{de, en}` pair the app is currently speaking. Same one-liner as
 *  `familysettings.js` — deliberately duplicated rather than shared, so neither file imports the
 *  other for four tokens. */
const say = (pair) => (getLang() === 'en' ? pair.en : pair.de);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE COPY
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// German first, English complete — 13.7. Every entry is either a `{de, en}` pair of strings or a
// `{de, en}` pair of functions with identical arity, so `say()` works on all of them and a
// missing translation is a missing property rather than a German sentence in an English sheet.
//
// It lives here rather than in `i18n.js` for the reason `crypto/backup.js`'s `EXPORT_SHEET_COPY`
// and `crypto/probe.js`'s `unavailableMessage()` live in their modules: this is family-mode copy
// behind the one dynamic door (`family/mount.js`), and `i18n.js` is in the boot graph of every
// solo Mac. Folding it into `i18n.js` later is mechanical; the pairs are already complete.

export const LIFECYCLE_COPY = Object.freeze({

  // ── 20.2 · removing somebody else ─────────────────────────────────────────────────────────
  remove: Object.freeze({
    title: Object.freeze({
      de: (name) => `${name} aus dem Familienkreis entfernen?`,
      en: (name) => `Remove ${name} from the family circle?`,
    }),
    /** The one plain sentence the addendum asks for. */
    consequence: Object.freeze({
      de: (name) =>
        `Die geteilten und die Belegt-Einträge von ${name} verschwinden von allen Familien-Boards `
        + 'und der Zugang zum Kreis endet sofort — die privaten Einträge auf dem eigenen Mac '
        + 'bleiben unberührt, denn sie waren nie bei uns.',
      en: (name) =>
        `${name}'s shared and Belegt entries leave every family board and access to the circle `
        + 'ends immediately — the private entries on their own Mac stay untouched, because they '
        + 'were never ours.',
    }),
    /** Addendum §6. Never omitted, in either language. */
    honesty: Object.freeze({
      de: 'Was ihr Mac schon geladen hat, bleibt auf ihrem Mac. Geteiltes lässt sich zurücknehmen, Gesehenes nicht.',
      en: 'What their Mac has already loaded stays on their Mac. Sharing can be taken back; having been seen cannot.',
    }),
    confirm: Object.freeze({ de: 'Entfernen', en: 'Remove' }),
    done: Object.freeze({
      de: (name) => `${name} ist nicht mehr im Kreis.`,
      en: (name) => `${name} is no longer in the circle.`,
    }),
    already: Object.freeze({
      de: (name) => `${name} war schon nicht mehr im Kreis.`,
      en: (name) => `${name} was already out of the circle.`,
    }),
  }),

  // ── 20.3 · leaving, self-initiated ────────────────────────────────────────────────────────
  leave: Object.freeze({
    title: Object.freeze({
      de: (space) => `„${space}“ verlassen?`,
      en: (space) => `Leave “${space}”?`,
    }),
    consequence: Object.freeze({
      de: () =>
        'Die geteilten Einträge der anderen verschwinden von deinem Board, und deine eigenen '
        + 'Einträge werden alle wieder privat und bleiben bei dir — beim Verlassen verliert '
        + 'niemand seine eigenen Daten.',
      en: () =>
        "The others' shared entries disappear from your board, and your own entries all revert "
        + 'to private and stay with you — nobody ever loses their own data by leaving.',
    }),
    honesty: Object.freeze({
      de: 'Was die anderen Macs schon geladen haben, bleibt dort. Geteiltes lässt sich zurücknehmen, Gesehenes nicht.',
      en: "What the others' Macs have already loaded stays there. Sharing can be taken back; having been seen cannot.",
    }),
    /** Only when it is true: `handlers/lifecycle.js` deletes a space whose last member leaves. */
    lastOneOut: Object.freeze({
      de: 'Du bist die letzte Person im Kreis. Mit dir wird auch der Kreis auf dem Server gelöscht.',
      en: 'You are the last person in the circle. Leaving deletes the circle on the server as well.',
    }),
    /** Only when it is true. Not a block — a fact, offered before the fact becomes a surprise. */
    youAreAdmin: Object.freeze({
      de: 'Du bist Verwalter. Übergib die Rolle vorher an jemanden, sonst bleibt der Kreis ohne Verwalter zurück.',
      en: 'You are the admin. Hand the role to somebody first, or the circle is left without one.',
    }),
    /**
     * THE T5-M3 CAVEAT, MET BEFORE IT BITES — only when exactly two people would remain.
     *
     * `handlers/lifecycle.js`: once `Space.founderMemberId` no longer names a live member, every
     * removal in that space needs a second member row — and in a two-member circle the only
     * possible co-signer is the target, so the rule is unsatisfiable. Leaving is what produces
     * that state, so this is the moment to say it, and it is said conditionally rather than
     * always: a sentence shown on every leave is a sentence nobody reads on the one leave that
     * causes it.
     *
     * It is phrased as a CONDITION („falls … nicht mehr dabei ist") and never as a fact, because
     * the relay does not publish `founderMemberId` and this Mac genuinely cannot know whether the
     * person who created the circle is still in it. Claiming to know would be the one thing worse
     * than the caveat.
     */
    leavesTwoBehind: Object.freeze({
      de: 'Danach sind noch zwei Menschen im Kreis. Falls die Person, die den Kreis angelegt hat, '
        + 'dann nicht mehr dabei ist, können sich diese beiden nicht mehr gegenseitig entfernen — '
        + 'jede von beiden kann den Kreis aber weiterhin selbst verlassen, und beide Boards bleiben '
        + 'vollständig.',
      en: 'Two people will be left in the circle. If the person who created it is no longer among '
        + 'them, those two can no longer remove each other — either of them can still leave, and '
        + 'both boards stay complete.',
    }),
    confirm: Object.freeze({ de: 'Verlassen', en: 'Leave' }),
    done: Object.freeze({
      de: 'Du bist aus dem Kreis. Dein Board gehört wieder dir allein.',
      en: 'You are out of the circle. Your board is yours alone again.',
    }),
  }),

  // ── 20.4 · deleting the whole circle ──────────────────────────────────────────────────────
  delete: Object.freeze({
    title: Object.freeze({
      de: (space) => `„${space}“ löschen?`,
      en: (space) => `Delete “${space}”?`,
    }),
    consequence: Object.freeze({
      de: () =>
        'Alle Daten des Kreises auf dem Server werden gelöscht, und jedes Mitglied behält ein '
        + 'vollständig intaktes Board für sich allein — niemand verliert einen einzigen eigenen '
        + 'Eintrag.',
      en: () =>
        "All of the circle's data on the server is purged, and every member keeps a fully intact "
        + 'board of their own — nobody loses a single entry of their own.',
    }),
    honesty: Object.freeze({
      de: 'Danach ist der Kreis für alle weg. Ein neuer lässt sich anlegen; dieser kommt nicht zurück.',
      en: 'After this the circle is gone for everyone. A new one can be made; this one does not come back.',
    }),
    /** The typed confirmation. `handlers/lifecycle.js` requires `confirm === spaceId` on the
     *  wire; a person types the NAME, which is the only one of the two they can read. */
    typeToConfirm: Object.freeze({
      de: 'Tippe den Namen des Kreises, um zu bestätigen.',
      en: 'Type the name of the circle to confirm.',
    }),
    mismatch: Object.freeze({
      de: 'Der Name stimmt noch nicht.',
      en: 'That is not the name yet.',
    }),
    confirm: Object.freeze({ de: 'Endgültig löschen', en: 'Delete for good' }),
    done: Object.freeze({
      de: 'Der Kreis ist gelöscht. Jedes Board bleibt vollständig — deins auch.',
      en: 'The circle is deleted. Every board stays complete — yours too.',
    }),
  }),

  // ── 19.4 · giving the private room back ───────────────────────────────────────────────────
  //
  // NOT a Familienkreis action, and the copy must never imply it is: this is the `psp_` space
  // from „Server & eigene Geräte", shared with nobody but this person's own Macs. It is in this
  // register anyway because it is a lifecycle action with a consequence and an honesty line, and
  // splitting it out would mean two spellings of „kein einziger Eintrag geht verloren".
  dissolvePersonal: Object.freeze({
    title: Object.freeze({
      de: () => 'Privaten Raum auflösen?',
      en: () => 'Dissolve the private space?',
    }),
    consequence: Object.freeze({
      // `paired` is how many OTHER Macs of this person are in the room. The second sentence only
      // appears when there is a second Mac to lose, because warning about one that does not exist
      // is how a person decides not to press a button they wanted.
      de: (ctx) =>
        'Alles, was dieser Raum auf dem Server liegen hat, wird gelöscht. Dein Board auf diesem '
        + 'Mac bleibt vollständig — kein einziger Eintrag geht verloren.'
        + (ctx && ctx.paired
          ? ' Dein anderer Mac gleicht danach nicht mehr ab; sein eigenes Board bleibt ebenfalls '
            + 'vollständig.'
          : ''),
      en: (ctx) =>
        "Everything this space is holding on the server is deleted. Your board on this Mac stays "
        + 'complete — not a single entry is lost.'
        + (ctx && ctx.paired
          ? ' Your other Mac will stop syncing; its own board stays complete too.'
          : ''),
    }),
    honesty: Object.freeze({
      de: 'Danach ist dieser Raum weg. Einen neuen kannst du einrichten; dieser kommt nicht zurück.',
      en: 'After this the space is gone. You can set up a new one; this one does not come back.',
    }),
    /** The typed gate. A private room has no NAME — the only thing on that row a person can read
     *  is this Mac's short — so that is what is typed. See `confirmDissolvePersonal`. */
    typeToConfirm: Object.freeze({
      de: 'Tippe die Kennung dieses Macs, um zu bestätigen.',
      en: "Type this Mac's identifier to confirm.",
    }),
    mismatch: Object.freeze({
      de: 'Die Kennung stimmt noch nicht.',
      en: 'That is not the identifier yet.',
    }),
    confirm: Object.freeze({ de: 'Endgültig auflösen', en: 'Dissolve for good' }),
    done: Object.freeze({
      de: 'Der private Raum ist aufgelöst. Dieser Mac gleicht nichts mehr ab — dein Board ist vollständig.',
      en: 'The private space is dissolved. This Mac syncs nothing now — your board is complete.',
    }),
  }),

  // ── 20.1 · handing over the admin role ────────────────────────────────────────────────────
  transfer: Object.freeze({
    title: Object.freeze({
      de: (name) => `Verwalter-Rolle an ${name} übergeben?`,
      en: (name) => `Hand the admin role to ${name}?`,
    }),
    consequence: Object.freeze({
      de: (name) =>
        `${name} kann danach einladen, Einladungen zurückziehen, Mitglieder entfernen und den `
        + 'Kreis löschen. Du bleibst Mitglied wie alle anderen.',
      en: (name) =>
        `${name} will then be able to invite, revoke invites, remove members and delete the `
        + 'circle. You stay a member like everybody else.',
    }),
    /** 20.5, said at the exact moment somebody might assume the opposite. */
    honesty: Object.freeze({
      de: 'An den Einträgen ändert sich nichts — auch nicht daran, wer was sehen kann. Die Rolle verwaltet den Kreis, sie liest ihn nicht.',
      en: 'Nothing about the entries changes — including who can see what. The role manages the circle; it does not read it.',
    }),
    confirm: Object.freeze({ de: 'Übergeben', en: 'Hand over' }),
    done: Object.freeze({
      de: (name) => `${name} verwaltet den Kreis jetzt.`,
      en: (name) => `${name} manages the circle now.`,
    }),
  }),

  /** One sentence for every way the relay can say no. `familyFailed` already exists in i18n and
   *  carries the detail; this is the calm frame around it. */
  failed: Object.freeze({
    de: 'Das hat nicht geklappt. Am Kreis hat sich nichts geändert.',
    en: 'That did not work. Nothing about the circle has changed.',
  }),
  offline: Object.freeze({
    de: 'Dieser Mac ist gerade nicht mit dem Server verbunden. Am Kreis hat sich nichts geändert.',
    en: 'This Mac cannot reach the server right now. Nothing about the circle has changed.',
  }),
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CO-SIGNATURE COPY — ADR 003 §3.7, `handlers/lifecycle.js` PROVES / PROVES_NOT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// German first, English complete, every entry a `{de, en}` pair — the same rule as
// `LIFECYCLE_COPY`, and for the same reason.
//
// `proves` and `provesNot` are translations of the relay's own two sentences and are the reason
// this constant exists as data rather than as strings in a builder: `cosign.dom.js` §5 walks
// every leaf and asserts that nothing here claims two PEOPLE, in either language.

export const COSIGN_COPY = Object.freeze({

  // ── what the second signature does and does not establish (PROVES / PROVES_NOT) ───────────
  /** `PROVES.admin_proof`, in the product's voice. Rows, never people. */
  proves: Object.freeze({
    de: 'Damit stehen zwei verschiedene Mitglieds-Einträge dieses Kreises mit je einem '
      + 'Wiederherstellungs-Schlüssel hinter diesem Schritt.',
    en: 'Two different member records of this circle then each stand behind this step with a '
      + 'recovery key.',
  }),
  /** `PROVES_NOT`, in full, and never softened: it is the honest half. */
  provesNot: Object.freeze({
    de: 'Der Server kann nicht sehen, ob hinter zwei Mitglieds-Einträgen auch zwei Menschen '
      + 'stehen, und er kann nicht sehen, wer den Kreis verwaltet. Beides bleibt ihm verborgen — '
      + 'er zählt Einträge, er kennt euch nicht.',
    en: 'The server cannot see whether two member records mean two humans, and it cannot see who '
      + 'manages the circle. Both stay hidden from it — it counts records; it does not know you.',
  }),

  // ── the asking half ───────────────────────────────────────────────────────────────────────
  askTitle: Object.freeze({ de: 'Eine zweite Unterschrift', en: 'A second signature' }),
  /** One sentence per relay `reason`. The relay decides which; this file never guesses. */
  whyFounder: Object.freeze({
    de: 'Du möchtest die Person entfernen, die diesen Kreis angelegt hat. Das ist die eine '
      + 'Entfernung, die den Kreis für alle beschädigt — deshalb braucht sie eine zweite '
      + 'Unterschrift.',
    en: 'You want to remove the person who created this circle. That is the one removal that '
      + 'damages the circle for everybody — so it takes a second signature.',
  }),
  whyFounderGone: Object.freeze({
    de: 'Die Person, die diesen Kreis angelegt hat, ist nicht mehr dabei. Seitdem braucht jede '
      + 'Entfernung eine zweite Unterschrift, damit nicht eine einzelne Person den Kreis '
      + 'leerräumen kann.',
    en: 'The person who created this circle is no longer in it. Since then every removal takes a '
      + 'second signature, so that no single person can empty the circle.',
  }),
  whyDelete: Object.freeze({
    de: 'Ein Familienkreis gehört der Familie. Deshalb kann ihn niemand allein löschen — es '
      + 'braucht die Unterschrift eines zweiten Mitglieds.',
    en: 'A family circle belongs to the family. So nobody can delete it alone — it takes a second '
      + "member's signature.",
  }),
  /** The fallback, when the relay names a reason this build does not know. Says so, calmly. */
  whyOther: Object.freeze({
    de: 'Für diesen Schritt verlangt der Server die Unterschrift eines zweiten Mitglieds.',
    en: 'The server requires a second member’s signature for this step.',
  }),
  /** The instruction. Indicative about where the signature comes from — that is the whole point. */
  how: Object.freeze({
    de: 'Gib diesen Text an ein anderes Mitglied weiter. Es fügt ihn in seiner App unter '
      + '„Mitunterschrift geben“ ein und unterschreibt auf seinem eigenen Mac, mit seinem eigenen '
      + 'Schlüssel. Dieser Mac hier kann das nicht für jemand anderen tun.',
    en: 'Pass this text to another member. They paste it into their own app under “Give a '
      + 'co-signature” and sign on their own Mac, with their own key. This Mac cannot do that for '
      + 'somebody else.',
  }),
  /** Principle 9, stated where somebody might otherwise assume a notification went out. */
  quiet: Object.freeze({
    de: 'Diese Anfrage geht über keinen Server und benachrichtigt niemanden. Sie steht nur in dem '
      + 'Text, den ihr euch schickt.',
    en: 'This request goes over no server and notifies nobody. It exists only in the text the two '
      + 'of you send each other.',
  }),
  copyRequest: Object.freeze({ de: 'Anfrage kopieren', en: 'Copy the request' }),
  requestCopied: Object.freeze({ de: 'Die Anfrage ist in der Zwischenablage.', en: 'The request is on the clipboard.' }),
  pasteAnswer: Object.freeze({
    de: 'Die Mitunterschrift hier einfügen',
    en: 'Paste the co-signature here',
  }),
  /** T5-M4, as a property of the thing rather than as a warning about it. */
  oneUse: Object.freeze({
    de: 'Eine Mitunterschrift gilt für genau diesen einen Schritt und ist danach verbraucht.',
    en: 'A co-signature is good for this one step and is spent afterwards.',
  }),
  /**
   * THE CAVEAT THE ANCHOR CARRIES, when it is no longer a caveat but the state you are in.
   * A founder-less two-member circle can be left, never curated.
   */
  nobody: Object.freeze({
    de: 'In diesem Kreis ist niemand, der mitunterschreiben könnte: außer dir und der Person, um '
      + 'die es geht, ist niemand mehr dabei. Dann lässt sich hier niemand mehr entfernen. Gehen '
      + 'kann jede und jeder von euch weiterhin — „Kreis verlassen“ —, und beide Boards bleiben '
      + 'dabei vollständig.',
    en: 'There is nobody in this circle who could co-sign: apart from you and the person this is '
      + 'about, nobody is left. So nobody can be removed here any more. Either of you can still '
      + 'leave — “Leave circle” — and both boards stay complete.',
  }),
  /** Standing in the danger zone of a small circle, before anybody is stuck in it. */
  strandNote: Object.freeze({
    de: 'Wenn dieser Kreis auf zwei Menschen schrumpft und die Person, die ihn angelegt hat, dann '
      + 'nicht mehr dabei ist, kann niemand mehr jemanden entfernen — dann bleibt nur noch, selbst '
      + 'zu gehen. Die Boards bleiben dabei vollständig.',
    en: 'If this circle shrinks to two people and the person who created it is no longer among '
      + 'them, nobody can remove anybody any more — the only way out is to leave. The boards stay '
      + 'complete either way.',
  }),

  // ── the signing half ──────────────────────────────────────────────────────────────────────
  signEntry: Object.freeze({ de: 'Mitunterschrift geben', en: 'Give a co-signature' }),
  signTitle: Object.freeze({ de: 'Mitunterschrift geben', en: 'Give a co-signature' }),
  signPaste: Object.freeze({
    de: 'Den Text einfügen, den die andere Person geschickt hat',
    en: 'Paste the text the other person sent',
  }),
  signRead: Object.freeze({
    de: 'Lies nach, worum du gebeten wirst. Deine Unterschrift gilt genau für diesen einen Schritt '
      + 'und für niemanden sonst.',
    en: 'Read what you are being asked for. Your signature is good for this one step and for '
      + 'nobody else.',
  }),
  /** What the pasted request actually says, in one sentence, with the names this Mac can read. */
  askRemove: Object.freeze({
    de: (who, whom) => `${who} bittet darum, ${whom} aus dem Familienkreis zu entfernen.`,
    en: (who, whom) => `${who} is asking to remove ${whom} from the family circle.`,
  }),
  askDelete: Object.freeze({
    de: (who) => `${who} bittet darum, den ganzen Familienkreis zu löschen.`,
    en: (who) => `${who} is asking to delete the whole family circle.`,
  }),
  signConfirm: Object.freeze({ de: 'Mitunterschreiben', en: 'Co-sign' }),
  signResult: Object.freeze({
    de: 'Das ist deine Mitunterschrift. Schick sie zurück.',
    en: 'This is your co-signature. Send it back.',
  }),
  signCopy: Object.freeze({ de: 'Mitunterschrift kopieren', en: 'Copy the co-signature' }),
  signCopied: Object.freeze({ de: 'Die Mitunterschrift ist in der Zwischenablage.', en: 'The co-signature is on the clipboard.' }),

  // ── the refusals, one calm sentence each ──────────────────────────────────────────────────
  unreadable: Object.freeze({
    de: 'Damit lässt sich nichts anfangen. Bitte den ganzen Text einfügen, den die andere App '
      + 'angezeigt hat — von der ersten Zeile an.',
    en: 'That cannot be read. Please paste the whole text the other app showed, from the first '
      + 'line on.',
  }),
  otherCircle: Object.freeze({
    de: 'Diese Anfrage gehört zu einem anderen Kreis.',
    en: 'This request belongs to a different circle.',
  }),
  /** The one shape that would be one person on one Mac. Refused before anything is signed. */
  fromThisMac: Object.freeze({
    de: 'Diese Anfrage kommt von diesem Mac. Eine zweite Unterschrift braucht einen zweiten '
      + 'Schlüssel, und dieser Mac hat nur seinen eigenen.',
    en: 'This request comes from this Mac. A second signature needs a second key, and this Mac '
      + 'has only its own.',
  }),
  /**
   * The target is a live member row, so the relay WOULD accept her signature. The screen does
   * not offer it: being asked to co-sign your own removal is the lobbying F20 rules out.
   */
  youAreMeant: Object.freeze({
    de: 'Hier geht es um dich. Darum wirst du nicht gebeten. Wenn du gehen möchtest, geht das '
      + 'direkt: „Kreis verlassen“.',
    en: 'This is about you, so you are not asked for it. If you want to go, that is right there: '
      + '“Leave circle”.',
  }),
  noKeyHere: Object.freeze({
    de: 'Dieser Mac hat keinen Schlüssel für einen Familienkreis, also kann er nichts '
      + 'mitunterschreiben.',
    en: 'This Mac holds no key for a family circle, so it cannot co-sign anything.',
  }),
  answerMismatch: Object.freeze({
    de: 'Diese Mitunterschrift gehört zu einem anderen Schritt. Für diesen hier braucht es eine '
      + 'eigene.',
    en: 'This co-signature belongs to a different step. This one needs its own.',
  }),
  /** The 401 the relay answers when the bytes do not verify. Not a shrug — a named outcome. */
  refused: Object.freeze({
    de: 'Der Server hat die Mitunterschrift nicht anerkannt. Am Kreis hat sich nichts geändert.',
    en: 'The server did not accept the co-signature. Nothing about the circle has changed.',
  }),
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE PURE HALF — what a person is told, as data
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** @typedef {'remove'|'leave'|'delete'|'transfer'|'dissolvePersonal'} LifecycleKind */

/**
 * The sentences one confirmation shows, in order, in one language.
 *
 * Pure: no DOM, no clock, no network. This is the function the tier-2 suite asserts against, so
 * that "the removal confirmation states 20.2's consequence and §6's honesty in both languages" is
 * a checkable claim rather than a screenshot somebody looked at once.
 *
 * @param {LifecycleKind} kind
 * @param {'de'|'en'} lang
 * @param {{name?:string, space?:string, isAdmin?:boolean, lastOneOut?:boolean, paired?:boolean}} [ctx]
 * @returns {string[]} at least two sentences: the consequence, then the honesty
 */
export function consequencesOf(kind, lang, ctx = {}) {
  const l = lang === 'en' ? 'en' : 'de';
  const c = LIFECYCLE_COPY[kind];
  if (!c) throw new Error(`leavedelete.consequencesOf: unknown kind ${JSON.stringify(kind)}`);
  const name = ctx.name || (l === 'en' ? 'this member' : 'dieses Mitglied');
  const out = [];

  if (kind === 'remove' || kind === 'transfer') out.push(c.consequence[l](name));
  // 19.4's dissolve is the one kind whose consequence depends on a FACT rather than a name: it
  // says a second sentence only when this person has another Mac paired into the room to lose.
  else if (kind === 'dissolvePersonal') out.push(c.consequence[l](ctx));
  else out.push(c.consequence[l]());

  // The order is deliberate. The consequence answers "what happens", the honesty answers "and
  // what does not" — and the second is the one a person would otherwise assume in our favour.
  out.push(c.honesty[l]);

  if (kind === 'leave') {
    // Both can be true at once (a two-person circle whose admin leaves), and both are shown.
    if (ctx.lastOneOut) out.push(c.lastOneOut[l]);
    else if (ctx.isAdmin) out.push(c.youAreAdmin[l]);
    // …and the T5-M3 caveat is independent of both: it is about the two people who STAY.
    // Appended last so the two existing lines keep their indices — `family-admin.dom.js` reads
    // `lines[1]` and `lines[2]` by position.
    if (ctx.leavesTwoBehind) out.push(c.leavesTwoBehind[l]);
  }
  return out;
}

/**
 * The title of one confirmation, in one language.
 * @param {LifecycleKind} kind @param {'de'|'en'} lang
 * @param {{name?:string, space?:string}} [ctx]
 */
export function titleOf(kind, lang, ctx = {}) {
  const l = lang === 'en' ? 'en' : 'de';
  const c = LIFECYCLE_COPY[kind];
  if (!c) throw new Error(`leavedelete.titleOf: unknown kind ${JSON.stringify(kind)}`);
  if (kind === 'remove' || kind === 'transfer') {
    return c.title[l](ctx.name || (l === 'en' ? 'this member' : 'dieses Mitglied'));
  }
  return c.title[l](ctx.space || (l === 'en' ? 'this circle' : 'diesem Kreis'));
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CO-SIGNATURE, AS DATA — no DOM, no clock, no network, no crypto
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠ **THE SIGNED STRING IS THE RELAY'S, MIRRORED — NOT RE-DERIVED.**
 *
 * Normative source: `server/core/auth.js#adminProofString` + `ADMIN_PROOF_PREFIX`, quoted by
 * `server/core/handlers/lifecycle.js:55`:
 *
 *     "lzp/admin/2\n" + act + "\n" + spaceId + "\n" + target + "\n" + epoch + "\n" + presenter
 *
 * Six components, five separators, `epoch` stringified, and the `/2` is T5-M4's presenter
 * binding — a `/1` proof over four fields can never verify again, which is exactly why the
 * version is in the domain separator and why `COSIGN_BLOCK` carries the same `2`.
 *
 * **The client cannot import the relay's function** (`server/` is not in the shipped bundle and
 * tier 2 runs inside the app), so this is a mirror and mirrors drift. Three things hold it:
 *
 *   1. `cosign.dom.js` §1 pins the exact bytes as a LITERAL, character for character, so an edit
 *      here reddens a row that spells out what the string must be;
 *   2. the presenter binding is asserted separately — a proof minted for one presenter must not
 *      be byte-equal to the same act minted for another;
 *   3. **the real control is the relay.** A wrong byte is a `401 bad_signature` from
 *      `verifyAdminProof` and nothing happens. This was driven end to end against the real
 *      relay, not stubbed — see the workflow report.
 *
 * `presenter` is required and throws when absent, for the same reason the server's version
 * throws: `undefined` would stringify into the bytes and quietly mint an unbound proof.
 *
 * @param {{act:string, spaceId:string, target:string, epoch:number|string, presenter:string}} p
 * @returns {string}
 */
export function adminProofString(p) {
  for (const k of ['act', 'spaceId', 'target', 'presenter']) {
    if (typeof p[k] !== 'string' || p[k].length === 0) {
      throw new TypeError(`adminProofString: ${k} is required (lzp/admin/2)`);
    }
  }
  if (!Number.isInteger(Number(p.epoch))) throw new TypeError('adminProofString: epoch must be an integer');
  return 'lzp/admin/2\n' + p.act + '\n' + p.spaceId + '\n' + p.target + '\n'
    + String(Number(p.epoch)) + '\n' + p.presenter;
}

/** The acts a proof may authorize — `server/core/auth.js#ADMIN_ACTS`, closed there and here. */
export const COSIGN_ACTS = Object.freeze(['space.delete', 'member.remove']);

/**
 * The two block tags. The `2` is the `lzp/admin/2` version: a block from a build that signs
 * different bytes must not parse here, because a co-signature that parses and then fails at the
 * relay costs two people a phone call to discover.
 */
export const COSIGN_BLOCK = Object.freeze({ ask: 'LZP-COSIGN/2', answer: 'LZP-COSIGNED/2' });

/** Ids the relay itself would accept — `requireId` shapes plus `verifyAdminProof`'s 64-char cap. */
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** `server/core/auth.js#B64U_RE`, and a P-256 signature is 64 raw bytes → 86 base64url chars. */
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;

/**
 * The five terms, canonical order. Same order as the signed string, so a reader comparing the
 * block on screen with the ADR reads them in one direction.
 */
const TERM_KEYS = Object.freeze(['act', 'space', 'target', 'epoch', 'presenter']);

/**
 * The request one person hands to another.
 *
 * PLAIN TEXT AND READABLE ON PURPOSE. The co-signer must be able to see, with her own eyes and
 * before she signs, which circle and WHICH PERSON this is about; a base64 blob would make her
 * signature a gesture of trust in the asker, which is the exact thing a second signature is for.
 * It carries nothing secret — every one of the five values is already on the member list every
 * member can read.
 *
 * @param {{act:string, spaceId:string, target:string, epoch:number, presenter:string}} terms
 * @returns {string}
 */
export function encodeCosignRequest(terms) {
  adminProofString(terms);                     // shape-checks the five, or throws
  return [
    COSIGN_BLOCK.ask,
    `act ${terms.act}`,
    `space ${terms.spaceId}`,
    `target ${terms.target}`,
    `epoch ${String(Number(terms.epoch))}`,
    `presenter ${terms.presenter}`,
  ].join('\n');
}

/**
 * The answer: the same five terms, plus the signer and the signature.
 *
 * The terms RIDE BACK deliberately. Without them the asking Mac would have to assume the
 * signature covers what it thinks it covers, and a mis-pasted answer would become a `401` the
 * two people cannot tell from a broken key. With them the asking side refuses locally and says
 * „gehört zu einem anderen Schritt".
 *
 * @param {Object} terms @param {string} by @param {string} sig base64url
 */
export function encodeCosignature(terms, by, sig) {
  if (!ID_RE.test(String(by || ''))) throw new TypeError('encodeCosignature: by');
  if (!SIG_RE.test(String(sig || ''))) throw new TypeError('encodeCosignature: sig');
  return [
    COSIGN_BLOCK.answer,
    ...encodeCosignRequest(terms).split('\n').slice(1),
    `by ${by}`,
    `sig ${sig}`,
  ].join('\n');
}

/** `key value` lines into an object, tolerant of the whitespace a mail client adds. */
function readBlock(text, tag) {
  const lines = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
  if (lines.length === 0 || lines[0] !== tag) return null;
  const out = {};
  for (const line of lines.slice(1)) {
    const sp = line.indexOf(' ');
    if (sp <= 0) return null;
    const k = line.slice(0, sp);
    const v = line.slice(sp + 1).trim();
    if (k in out) return null;                 // a repeated key is two answers to one question
    out[k] = v;
  }
  return out;
}

/** The five terms out of a parsed block, or `null`. Strict: a partial paste is not a request. */
function readTerms(kv) {
  if (!kv) return null;
  for (const k of TERM_KEYS) if (typeof kv[k] !== 'string') return null;
  if (!COSIGN_ACTS.includes(kv.act)) return null;
  if (!ID_RE.test(kv.space) || !ID_RE.test(kv.target) || !ID_RE.test(kv.presenter)) return null;
  if (!/^\d{1,9}$/.test(kv.epoch)) return null;
  return Object.freeze({
    act: kv.act,
    spaceId: kv.space,
    target: kv.target,
    epoch: Number(kv.epoch),
    presenter: kv.presenter,
  });
}

/**
 * Parse a pasted request. `null` for anything that is not exactly one.
 * @param {string} text @returns {Object|null}
 */
export function parseCosignRequest(text) {
  const kv = readBlock(text, COSIGN_BLOCK.ask);
  if (!kv) return null;
  if (Object.keys(kv).length !== TERM_KEYS.length) return null;
  return readTerms(kv);
}

/**
 * Parse a pasted co-signature.
 * @param {string} text @returns {{terms:Object, by:string, sig:string}|null}
 */
export function parseCosignature(text) {
  const kv = readBlock(text, COSIGN_BLOCK.answer);
  if (!kv) return null;
  if (Object.keys(kv).length !== TERM_KEYS.length + 2) return null;
  const terms = readTerms(kv);
  if (!terms) return null;
  if (!ID_RE.test(String(kv.by || '')) || !SIG_RE.test(String(kv.sig || ''))) return null;
  // `verifyAdminProof` refuses `by === callerMemberId` before it spends a verification. Refusing
  // it here too means the two people learn it from a sentence rather than from a 400.
  if (kv.by === terms.presenter) return null;
  return Object.freeze({ terms, by: kv.by, sig: kv.sig });
}

/** Do two term sets name the same act? All five, because all five are in the signed bytes. */
export function sameTerms(a, b) {
  if (!a || !b) return false;
  return a.act === b.act && a.spaceId === b.spaceId && a.target === b.target
    && Number(a.epoch) === Number(b.epoch) && a.presenter === b.presenter;
}

/**
 * Why this Mac must not sign a pasted request — or `null` when it may.
 *
 * Pure, so the four refusals are asserted without a key store. The order is the order a person
 * would want them: wrong circle first, then „das bist du selbst", then the two that are about
 * this Mac's own key.
 *
 * @param {Object|null} terms @param {{spaceId:string|null, memberId:string|null}} me
 * @returns {'unreadable'|'otherCircle'|'fromThisMac'|'youAreMeant'|'noKeyHere'|null}
 */
export function cosignRefusal(terms, me) {
  if (!terms) return 'unreadable';
  if (!me || typeof me.memberId !== 'string' || me.memberId.length === 0) return 'noKeyHere';
  if (me.spaceId && terms.spaceId !== me.spaceId) return 'otherCircle';
  if (terms.presenter === me.memberId) return 'fromThisMac';
  // The relay would take it — she is a live row and is not the caller — and taking it would make
  // this the place where members lobby one another (F20, Principle 9). Presentational, and said
  // so in the module header.
  if (terms.act === 'member.remove' && terms.target === me.memberId) return 'youAreMeant';
  return null;
}

/**
 * One sentence saying what a pasted request asks for, with whatever names this Mac can read.
 *
 * The names come from the co-signer's OWN member list — the log every member decrypts
 * identically — never from the block, which a hostile asker writes. A member id she cannot
 * resolve is shown as the id: an unfamiliar id is information, a made-up name is not.
 *
 * @param {Object} terms @param {'de'|'en'} lang @param {(id:string)=>string} nameOf
 */
export function cosignSummary(terms, lang, nameOf) {
  const l = lang === 'en' ? 'en' : 'de';
  const name = (id) => {
    const n = nameOf ? nameOf(id) : '';
    return n && String(n).trim() ? String(n) : id;
  };
  if (terms.act === 'space.delete') return COSIGN_COPY.askDelete[l](name(terms.presenter));
  return COSIGN_COPY.askRemove[l](name(terms.presenter), name(terms.target));
}

/**
 * Which „warum" sentence belongs to the relay's own `reason`.
 *
 * The relay decides; this maps. An unknown reason falls back to `whyOther` rather than to
 * silence or to a guess — a new reason on the wire must not produce a screen that explains
 * nothing, and must not produce one that explains the wrong thing.
 *
 * @param {string} reason `handlers/lifecycle.js`'s `reason` field on the 403
 * @param {'de'|'en'} lang
 */
export function cosignReason(reason, lang) {
  const l = lang === 'en' ? 'en' : 'de';
  if (reason === 'founder_removal_needs_second_key') return COSIGN_COPY.whyFounder[l];
  if (reason === 'founder_gone_every_removal_needs_second_key') return COSIGN_COPY.whyFounderGone[l];
  if (reason === 'second_member_signature_required') return COSIGN_COPY.whyDelete[l];
  return COSIGN_COPY.whyOther[l];
}

/**
 * Is this failure the relay asking for a second key?
 *
 * `admin_proof_required` is a 403 and every other 403 in this flow means something else entirely
 * (`not_a_member`, `device_revoked`). Branching on the CODE and never on the status is what keeps
 * „das hat nicht geklappt" the answer to the others.
 *
 * ⚠ **THE EPOCH IS CHECKED HERE AND NOT AT THE SHEET.** The epoch is one of the six signed
 * components, so a demand without a usable one cannot produce a co-signature anybody could
 * verify. Found by mutant **M-C7**: dropping the `error` check let a `not_a_member` 403 through,
 * and the only reason nothing visible broke was that the sheet then threw out of its own builder
 * — a refusal by accident. Refusing here makes the ordinary calm sentence the deliberate answer
 * for every 403 that is not this one.
 *
 * @param {*} e an error thrown by `adminpanel.js`'s `call()`
 * @returns {Object|null} the relay's own refusal body, or null
 */
export function proofDemand(e) {
  const b = e && e.body;
  if (!b || typeof b !== 'object') return null;
  if (b.error !== 'admin_proof_required') return null;
  if (!Number.isInteger(Number(b.epoch))) {
    console.warn('[cosign] the relay demanded a second key without a usable epoch; '
      + 'a proof over bytes it did not name could never verify. Reported, not guessed at.', b);
    return null;
  }
  return b;
}

/**
 * ADR 002 §7.4's belt-and-braces: the relay states `alreadyDeliveredIsIrrevocable` so that a
 * client cannot promise more than the system does. We show that sentence unconditionally — it is
 * true whatever the relay says — so this is not a gate. It is a tripwire: a response that has
 * stopped carrying the flag means someone changed the contract, and the copy in this file is
 * downstream of that contract.
 *
 * @param {Object} body a lifecycle response body
 * @param {string} route for the warning
 */
function assertRelayAgrees(body, route) {
  if (body && body.alreadyDeliveredIsIrrevocable === true) return;
  console.warn(
    `[family] ${route} answered without alreadyDeliveredIsIrrevocable. ADR 002 §7.4 requires it; `
    + 'the confirmation copy in leavedelete.js is written against it.',
  );
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE SHEET — one builder, four callers
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `ui.confirmSheet` takes ONE body string, and every confirmation here has at least two
// paragraphs plus, for 20.4, a field. So this builds on `openSheet` directly rather than
// widening a primitive that four other call sites are happy with.
//
// The shape is fixed for all four: a first paragraph in the sheet's normal voice, the honesty
// line quieter beneath it, and the destructive button on the right in `btn-danger`. Cancel is
// first and is the default target of ⎋ (`openSheet` closes on the scrim and the ✕ too), because
// this is the only family sheet where doing nothing is the safe outcome.

/**
 * `canConfirm` + `notYet` are 20.4's typed gate and nothing else uses them; they are a parameter
 * rather than a special case inside the delete caller so that the gate is visible in this
 * builder's signature instead of hidden in one branch of it.
 *
 * @param {{kind:LifecycleKind, ctx:Object, extraNodes?:HTMLElement[],
 *          canConfirm?:() => boolean, notYet?:{de:string, en:string},
 *          onConfirm:() => Promise<void>|void}} spec
 */
function confirmLifecycle(spec) {
  const lang = getLang() === 'en' ? 'en' : 'de';
  const copy = LIFECYCLE_COPY[spec.kind];
  let confirmBtn = null;

  const api = openSheet({
    title: titleOf(spec.kind, lang, spec.ctx),
    narrow: true,
    build: (body) => {
      const lines = consequencesOf(spec.kind, lang, spec.ctx);
      // Line 0 is the consequence: full weight, the sentence the story promises.
      const lead = el('p', null, lines[0]);
      lead.style.cssText = 'margin:0 0 10px;font:400 12.5px/1.6 var(--font);color:var(--ink-1)';
      body.appendChild(lead);
      // Everything after it is context: the §6 honesty, and the two conditional leave lines.
      for (const s of lines.slice(1)) {
        const p = el('p', null, s);
        p.style.cssText = 'margin:0 0 8px;font:400 11.5px/1.6 var(--font);color:var(--ink-3)';
        body.appendChild(p);
      }
      for (const n of spec.extraNodes || []) body.appendChild(n);
    },
    actions: [
      { label: t('cancel'), run: (a) => a.close() },
      {
        label: say(copy.confirm),
        kind: 'danger',
        run: async (a) => {
          if (spec.canConfirm && !spec.canConfirm()) {
            toast(say(spec.notYet || LIFECYCLE_COPY.delete.mismatch));
            return;
          }
          // The button is disabled rather than the sheet closed: a lifecycle call is one round
          // trip and a failure must leave the person exactly where they were, with the sentence
          // they just read still on screen.
          if (confirmBtn) confirmBtn.disabled = true;
          try {
            await spec.onConfirm();
            a.close();
          } catch (e) {
            if (confirmBtn) confirmBtn.disabled = false;
            reportFailure(e);
          }
        },
      },
    ],
  });

  // `openSheet` builds its own footer buttons and hands back no handles, so the danger button is
  // found by position — last child of the footer — rather than by a class the CSS also uses.
  const foot = api.body.parentElement?.querySelector('.sheet-foot');
  confirmBtn = foot ? foot.lastElementChild : null;
  return api;
}

/** One calm sentence for every failure, with the technical detail behind i18n's `familyFailed`. */
function reportFailure(e) {
  const offline = globalThis.navigator && globalThis.navigator.onLine === false;
  toast(offline ? say(LIFECYCLE_COPY.offline) : say(LIFECYCLE_COPY.failed));
  console.warn('[family] lifecycle call failed', e);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE TWO CO-SIGNATURE SHEETS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// One for the person who asks and one for the person who signs, and they are two sheets rather
// than one wizard because they are used on two Macs by two people, minutes or a day apart.
//
// Neither of them calls the relay. The asking sheet's confirm button is the only thing in this
// section that does, and it is the act itself.

/** A read-only block of text a person copies out. Monospace, selectable, never editable. */
function blockBox(text) {
  const ta = el('textarea');
  ta.value = text;
  ta.readOnly = true;
  ta.rows = 7;
  ta.spellcheck = false;
  ta.className = 'cosign-block';
  ta.style.cssText = 'width:100%;box-sizing:border-box;margin:2px 0 10px;padding:7px 8px;'
    + 'border:1px solid var(--field-border);border-radius:5px;resize:none;'
    + 'font:400 11px/1.55 var(--mono);color:var(--ink-2);background:var(--field-bg,transparent)';
  ta.addEventListener('focus', () => ta.select());
  return ta;
}

/** The field a person pastes into. */
function pasteBox(placeholder) {
  const ta = el('textarea');
  ta.rows = 6;
  ta.spellcheck = false;
  ta.autocomplete = 'off';
  ta.placeholder = placeholder;
  ta.className = 'cosign-paste';
  ta.style.cssText = 'width:100%;box-sizing:border-box;margin:2px 0 8px;padding:7px 8px;'
    + 'border:1px solid var(--field-border);border-radius:5px;resize:vertical;'
    + 'font:400 11px/1.55 var(--mono);color:var(--ink-1)';
  return ta;
}

const lead = (s) => {
  const p = el('p', null, s);
  p.style.cssText = 'margin:0 0 10px;font:400 12.5px/1.6 var(--font);color:var(--ink-1)';
  return p;
};
const quietLine = (s) => {
  const p = el('p', null, s);
  p.style.cssText = 'margin:0 0 8px;font:400 11.5px/1.6 var(--font);color:var(--ink-3)';
  return p;
};

/** A `.btn-ghost` that copies one string and says so. Never load-bearing — see `copyIsAGift`. */
function copyButton(label, done, text, copy) {
  const b = el('button', 'btn-ghost', label);
  b.type = 'button';
  b.style.cssText = 'height:24px;padding:0 9px;font:500 11px var(--font);margin-bottom:10px';
  b.addEventListener('click', async () => {
    try {
      await copy(text);
      toast(done);
    } catch (e) {
      // ⚠ THE SAME LESSON `adminpanel.js`'s mint learned: the clipboard is a permissioned API
      // that refuses for reasons that have nothing to do with the circle. The block is ON SCREEN
      // and selectable, so a refusal costs nothing and must never read as a failure of the flow.
      console.warn('[cosign] the clipboard refused; the text is on screen and unaffected', e);
      toast(String((e && e.message) || e));
    }
  });
  return b;
}

/**
 * THE ASKING SHEET. Opened by a 403 `admin_proof_required` and by nothing else.
 *
 * `terms` is fixed for the life of the sheet and comes half from the RELAY (`act`, `epoch`, out
 * of its own refusal body — never guessed here) and half from facts this Mac holds (`spaceId`,
 * `target`, and `presenter`, which is this Mac's own member id).
 *
 * **`presenter` never enters a request body.** It is in the signed bytes and nowhere else: the
 * relay derives it from the authenticated device (`terms.callerMemberId`), and a presenter in a
 * body field would be a claim the relay had to trust. See `handlers/lifecycle.js` §T5-M4.
 *
 * @param {{port:Object, kind:'remove'|'delete', terms:Object, demand:Object,
 *          eligible:number|null, onConfirm:(proof:{by:string, sig:string}) => Promise<void>}} spec
 */
export function openCosignRequest(spec) {
  const l = getLang() === 'en' ? 'en' : 'de';
  const { port, terms } = spec;
  const confirmCopy = spec.kind === 'delete' ? LIFECYCLE_COPY.delete.confirm : LIFECYCLE_COPY.remove.confirm;
  let paste = null;
  let confirmBtn = null;

  // THE UNSATISFIABLE CASE, ANSWERED AS A SENTENCE AND NOT AS A DISABLED BUTTON. A founder-less
  // two-member circle has exactly one live member who is neither the caller nor the target:
  // nobody. There is no request worth copying, so none is offered.
  //
  // `eligible === null` means this Mac's member view is not mounted and the count is UNKNOWN —
  // which is not the same as zero, and must not be rendered as „niemand kann mitunterschreiben".
  // Unknown offers the request: the worst case is a block nobody can use, and the alternative is
  // telling a five-person family it is stuck.
  const stranded = spec.eligible === 0;

  const api = openSheet({
    title: say(COSIGN_COPY.askTitle),
    narrow: true,
    build: (body) => {
      body.appendChild(lead(cosignReason(spec.demand && spec.demand.reason, l)));
      if (stranded) {
        body.appendChild(lead(say(COSIGN_COPY.nobody)));
        body.appendChild(quietLine(say(COSIGN_COPY.provesNot)));
        return;
      }
      body.appendChild(quietLine(say(COSIGN_COPY.how)));
      body.appendChild(blockBox(encodeCosignRequest(terms)));
      body.appendChild(copyButton(
        say(COSIGN_COPY.copyRequest), say(COSIGN_COPY.requestCopied),
        encodeCosignRequest(terms), port.copy,
      ));
      body.appendChild(quietLine(say(COSIGN_COPY.quiet)));
      // The two sentences the relay puts on every 403, in the product's voice. Both, always:
      // the strong one alone is the „von zwei Personen bestätigt" screen this file exists against.
      body.appendChild(quietLine(say(COSIGN_COPY.proves)));
      body.appendChild(quietLine(say(COSIGN_COPY.provesNot)));
      body.appendChild(quietLine(say(COSIGN_COPY.oneUse)));
      paste = pasteBox(COSIGN_BLOCK.answer);
      paste.setAttribute('aria-label', say(COSIGN_COPY.pasteAnswer));
      body.appendChild(quietLine(say(COSIGN_COPY.pasteAnswer)));
      body.appendChild(paste);
    },
    actions: stranded
      ? [{ label: t('close'), run: (a) => a.close() }]
      : [
        { label: t('cancel'), run: (a) => a.close() },
        {
          label: say(confirmCopy),
          kind: 'danger',
          run: async (a) => {
            const answer = parseCosignature(paste ? paste.value : '');
            if (!answer) { toast(say(COSIGN_COPY.unreadable)); return; }
            // BOUND TO THIS ACT AND NO OTHER. All five terms, because all five are in the bytes:
            // a co-signature for a neighbouring epoch or another target is refused HERE, so the
            // two people read a sentence instead of decoding a 401.
            if (!sameTerms(answer.terms, terms)) { toast(say(COSIGN_COPY.answerMismatch)); return; }
            if (confirmBtn) confirmBtn.disabled = true;
            try {
              await spec.onConfirm({ by: answer.by, sig: answer.sig });
              a.close();
            } catch (e) {
              if (confirmBtn) confirmBtn.disabled = false;
              // A 401 here means the bytes did not verify — a real, nameable outcome and not a
              // shrug. Everything else is the ordinary calm sentence.
              if (e && e.status === 401) { toast(say(COSIGN_COPY.refused)); console.warn('[cosign] refused', e); }
              else reportFailure(e);
            }
          },
        },
      ],
  });

  const foot = api.body.parentElement?.querySelector('.sheet-foot');
  confirmBtn = foot ? foot.lastElementChild : null;
  return api;
}

/**
 * THE SIGNING SHEET, on the other person's Mac.
 *
 * Reached from „Mitunterschrift geben" in the member section. It parses, it refuses, it shows
 * one sentence about what is being asked, and only then does it touch a key. Nothing it does
 * reaches the network, and nothing it does is written down.
 *
 * @param {{port:Object, onDone?:Function}} spec
 */
export function openCosignSign(spec) {
  const l = getLang() === 'en' ? 'en' : 'de';
  const { port } = spec;
  let paste = null;
  let signBtn = null;
  let signed = null;                 // the answer block, once minted — never persisted anywhere

  const api = openSheet({
    title: say(COSIGN_COPY.signTitle),
    narrow: true,
    build: (body) => {
      if (signed) {
        body.appendChild(lead(say(COSIGN_COPY.signResult)));
        body.appendChild(blockBox(signed));
        body.appendChild(copyButton(
          say(COSIGN_COPY.signCopy), say(COSIGN_COPY.signCopied), signed, port.copy,
        ));
        body.appendChild(quietLine(say(COSIGN_COPY.proves)));
        body.appendChild(quietLine(say(COSIGN_COPY.provesNot)));
        return;
      }
      body.appendChild(lead(say(COSIGN_COPY.signRead)));
      body.appendChild(quietLine(say(COSIGN_COPY.quiet)));
      paste = pasteBox(COSIGN_BLOCK.ask);
      paste.setAttribute('aria-label', say(COSIGN_COPY.signPaste));
      body.appendChild(quietLine(say(COSIGN_COPY.signPaste)));
      body.appendChild(paste);
      // WHAT AM I SIGNING? Answered live, out of the paste, before the button is pressed — with
      // the names from THIS Mac's own member list and never from the pasted text.
      const what = quietLine('');
      what.style.color = 'var(--ink-1)';
      what.className = 'cosign-what';
      body.appendChild(what);
      body.appendChild(quietLine(say(COSIGN_COPY.proves)));
      body.appendChild(quietLine(say(COSIGN_COPY.provesNot)));
      const restate = () => {
        const terms = parseCosignRequest(paste.value);
        const why = cosignRefusal(terms, { spaceId: port.spaceId, memberId: port.myMemberId() });
        if (paste.value.trim().length === 0) { what.textContent = ''; return; }
        what.textContent = why ? say(COSIGN_COPY[why]) : cosignSummary(terms, l, port.nameOf);
      };
      paste.addEventListener('input', restate);
      restate();
    },
    actions: [
      { label: t('close'), run: (a) => a.close() },
      {
        label: say(COSIGN_COPY.signConfirm),
        kind: 'primary',
        run: async (a) => {
          if (signed) { a.close(); return; }
          const terms = parseCosignRequest(paste ? paste.value : '');
          const why = cosignRefusal(terms, { spaceId: port.spaceId, memberId: port.myMemberId() });
          if (why) { toast(say(COSIGN_COPY[why])); return; }
          if (signBtn) signBtn.disabled = true;
          try {
            // The ONE crypto call in this file, and it is a port: the private half of `RK_sig`
            // is in this Mac's own key store and never crosses a module boundary.
            const { by, sig } = await port.coSign(adminProofString(terms));
            signed = encodeCosignature(terms, by, sig);
            api.rebuild();
            // The button has done its one job. HIDDEN rather than merely disabled, because a
            // greyed „Mitunterschreiben" beside a finished block reads as „das hat nicht
            // geklappt" — and pressing it again must never mint a second signature over the
            // same bytes (T5-M4).
            if (signBtn) signBtn.hidden = true;
            spec.onDone?.();
          } catch (e) {
            console.warn('[cosign] this Mac could not sign', e);
            toast(say(COSIGN_COPY.noKeyHere));
          } finally {
            // Re-armed only while there is still something to sign. Once the block exists the
            // button has done its one job, and pressing it again must not mint a second
            // signature over the same bytes — one act, one proof (T5-M4).
            if (signBtn) signBtn.disabled = signed !== null;
          }
        },
      },
    ],
  });

  const foot = api.body.parentElement?.querySelector('.sheet-foot');
  signBtn = foot ? foot.lastElementChild : null;
  return api;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FOUR CALLERS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Each takes the `AdminPort` (see `adminpanel.js`) and a `member` view-model, does the round trip
// and reports. None of them touches the store: what a leave or a delete does to THIS Mac's board
// is `port.afterLeave` / `port.afterDelete`, which `family/mount.js` supplies, because the
// membership and the key ring live in the handle that module holds.

/**
 * A removal or a delete that the relay finished, reported.
 *
 * `admin_proof_target_already_removed` is the ONE 400 in this flow that is a SUCCESS SYNONYM
 * (finding T5-M4): a proofed removal whose response was lost and is retried gets it instead of
 * the 200 no-op, and `handlers/lifecycle.js` carries the contract that a client must render it
 * as „ist bereits entfernt" and never as a failed removal. So it is caught here, once, rather
 * than at each of the two call sites.
 *
 * @param {Function} run @param {(res:Object|null, already:boolean)=>void} report
 */
async function runOrAlreadyDone(run, report) {
  try {
    const res = await run();
    report(res, !!(res && res.alreadyRemoved));
  } catch (e) {
    const b = e && e.body;
    if (b && b.reason === 'admin_proof_target_already_removed') { report(null, true); return; }
    throw e;
  }
}

/**
 * 20.2 — remove another member.
 *
 * Two outcomes and both are ordinary: the relay does it, or the relay asks for a second member
 * row's signature (`403 admin_proof_required`) and the co-signature sheet opens on the relay's
 * own terms. The second is not an error path — in a circle whose founder has left it is the
 * ONLY path, and before this sheet existed it was a dead end.
 *
 * @param {{port:Object, member:{memberId:string, name:string}, onDone?:Function}} spec
 */
export function confirmRemoveMember(spec) {
  const { port, member } = spec;
  const done = (res, already) => {
    if (res) assertRelayAgrees(res, 'members/remove');
    // `alreadyRemoved` is a success, not an error: `handlers/lifecycle.js` makes the endpoint
    // idempotent precisely so a lost response never costs a second confirmation dialogue.
    toast(already
      ? say(LIFECYCLE_COPY.remove.already)(member.name)
      : say(LIFECYCLE_COPY.remove.done)(member.name));
    spec.onDone?.(res);
  };
  return confirmLifecycle({
    kind: 'remove',
    ctx: { name: member.name },
    onConfirm: async () => {
      try {
        await runOrAlreadyDone(() => port.removeMember(member.memberId), done);
      } catch (e) {
        const demand = proofDemand(e);
        if (!demand) throw e;
        // The act, the epoch and the reason are the RELAY's, out of its own refusal. Nothing
        // here re-derives when the gate applies; the relay already answered that question.
        openCosignRequest({
          port,
          kind: 'remove',
          demand,
          eligible: port.eligibleCosigners(member.memberId),
          terms: {
            act: demand.act || 'member.remove',
            spaceId: port.spaceId,
            target: member.memberId,
            epoch: demand.epoch,
            presenter: port.myMemberId(),
          },
          onConfirm: (proof) => runOrAlreadyDone(() => port.removeMember(member.memberId, proof), done),
        });
      }
    },
  });
}

/**
 * 20.3 — leave the circle.
 * @param {{port:Object, spaceName:string, isAdmin:boolean, lastOneOut:boolean,
 *          onDone?:Function}} spec
 */
export function confirmLeaveCircle(spec) {
  const { port } = spec;
  return confirmLifecycle({
    kind: 'leave',
    ctx: { space: spec.spaceName, isAdmin: !!spec.isAdmin, lastOneOut: !!spec.lastOneOut },
    onConfirm: async () => {
      const res = await port.leaveSpace();
      assertRelayAgrees(res, 'members/leave');
      toast(say(LIFECYCLE_COPY.leave.done));
      spec.onDone?.(res);
    },
  });
}

/**
 * 19.4 — dissolve the private room, which until now could be armed and not given up.
 *
 * Typed, for the same reason 20.4 is typed: it is irreversible on the relay. What is typed is the
 * DEVICE SHORT and not a name, because a `psp_` space has no name — the id is the one thing on
 * that settings row a person cannot reasonably read back, and the short is already on screen two
 * lines above the button (`familysettings.js`'s „Dieser Mac: …").
 *
 * No co-signature path, unlike `confirmDeleteSpace`: `handlers/lifecycle.js` requires the second
 * key only when the roster is bigger than one, and a private room holds exactly one member
 * however many of this person's Macs are paired into it. A `proofDemand` here would mean the
 * relay disagrees about that, and it is surfaced rather than swallowed.
 *
 * @param {{port:Object, deviceShort:string, paired?:boolean, onDone?:Function}} spec
 */
export function confirmDissolvePersonal(spec) {
  const { port } = spec;
  const wanted = String(spec.deviceShort || '').trim();

  const field = el('div', 'field');
  const label = el('label', null, say(LIFECYCLE_COPY.dissolvePersonal.typeToConfirm));
  label.style.cssText = 'width:auto;flex:none;font:400 11.5px/1.5 var(--font);color:var(--ink-2)';
  const input = el('input');
  input.type = 'text';
  input.className = 'txt';
  input.placeholder = wanted;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.style.cssText = 'flex:1;min-width:0;height:26px;padding:0 7px;border:1px solid var(--field-border);border-radius:5px;font:400 12px var(--font)';
  field.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0 0';
  field.appendChild(label);
  field.appendChild(input);
  setTimeout(() => input.focus(), 0);

  return confirmLifecycle({
    kind: 'dissolvePersonal',
    ctx: { paired: !!spec.paired },
    extraNodes: [field],
    // Case-insensitive, because the short is Crockford base32 and shown uppercase: a person who
    // types what they read in lower case has typed the right thing.
    canConfirm: () => wanted.length > 0 && input.value.trim().toUpperCase() === wanted.toUpperCase(),
    notYet: LIFECYCLE_COPY.dissolvePersonal.mismatch,
    onConfirm: async () => {
      const res = await port.dissolvePersonal();
      if (res && res.localBoardsUnaffected !== true) {
        console.warn('[family] spaces/:id/delete answered without localBoardsUnaffected');
      }
      toast(say(LIFECYCLE_COPY.dissolvePersonal.done));
      spec.onDone?.(res);
    },
  });
}

/**
 * 20.4 — delete the circle. The only confirmation in the product with a typed gate, because it
 * is the only action whose blast radius is other people's boards rather than one's own.
 *
 * @param {{port:Object, spaceName:string, onDone?:Function}} spec
 */
export function confirmDeleteSpace(spec) {
  const { port } = spec;
  const wanted = String(spec.spaceName || '').trim();

  const field = el('div', 'field');
  const label = el('label', null, say(LIFECYCLE_COPY.delete.typeToConfirm));
  label.style.cssText = 'width:auto;flex:none;font:400 11.5px/1.5 var(--font);color:var(--ink-2)';
  const input = el('input');
  input.type = 'text';
  input.className = 'txt';
  input.placeholder = wanted;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.style.cssText = 'flex:1;min-width:0;height:26px;padding:0 7px;border:1px solid var(--field-border);border-radius:5px;font:400 12px var(--font)';
  field.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0 0';
  field.appendChild(label);
  field.appendChild(input);
  setTimeout(() => input.focus(), 0);

  return confirmLifecycle({
    kind: 'delete',
    ctx: { space: wanted },
    extraNodes: [field],
    // Whitespace-tolerant and case-sensitive: „familie weber" is not the name, and a trailing
    // space from a copy-paste is not a different circle.
    canConfirm: () => input.value.trim() === wanted && wanted.length > 0,
    notYet: LIFECYCLE_COPY.delete.mismatch,
    onConfirm: async () => {
      const done = (res) => {
        // 20.4's own promise, echoed by the relay so a client cannot render this as data loss.
        if (res && res.localBoardsUnaffected !== true) {
          console.warn('[family] spaces/:id/delete answered without localBoardsUnaffected');
        }
        toast(say(LIFECYCLE_COPY.delete.done));
        spec.onDone?.(res);
      };
      try {
        done(await port.deleteSpace());
      } catch (e) {
        const demand = proofDemand(e);
        if (!demand) throw e;
        // `POST /spaces/:id/delete` requires the proof whenever the space has ever had more than
        // one member row — that is EVERY real Familienkreis, always, and it is why the typed
        // confirmation alone was never enough to delete one. The target of a `space.delete`
        // proof is the SPACE (`handlers/lifecycle.js`: `target: spaceId`).
        openCosignRequest({
          port,
          kind: 'delete',
          demand,
          eligible: port.eligibleCosigners(null),
          terms: {
            act: demand.act || 'space.delete',
            spaceId: port.spaceId,
            target: port.spaceId,
            epoch: demand.epoch,
            presenter: port.myMemberId(),
          },
          onConfirm: async (proof) => { done(await port.deleteSpace(proof)); },
        });
      }
    },
  });
}

/**
 * 20.1 — hand the admin role over. Not destructive, and still behind a confirmation: it is the
 * one action in the panel a person cannot undo alone afterwards.
 *
 * @param {{port:Object, member:{memberId:string, name:string}, onDone?:Function}} spec
 */
export function confirmTransferAdmin(spec) {
  const { port, member } = spec;
  return confirmLifecycle({
    kind: 'transfer',
    ctx: { name: member.name },
    onConfirm: async () => {
      const res = await port.transferAdmin(member.memberId);
      // The relay checked that the successor exists and is current, and stored NOTHING — the
      // admin chain is an in-log op (ADR 001 §4.1). `port.transferAdmin` writes that op; this
      // only reports. A relay that claims to have recorded a role is a relay to distrust.
      if (res && res.authoritative === true) {
        console.warn('[family] members/transfer claimed to be authoritative; ADR 003 §5.1 says it cannot be');
      }
      toast(say(LIFECYCLE_COPY.transfer.done)(member.name));
      spec.onDone?.(res);
    },
  });
}
