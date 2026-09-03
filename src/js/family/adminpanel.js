// src/js/family/adminpanel.js — „Familienkreis verwalten".  LZP-605 · story 20.1 · addendum
// deliverable 22 · ADR 003 §3 (`handlers/invites.js`, `handlers/lifecycle.js`) · ADR 002 §7.1
// (PO decision D9).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// A SECTION INSIDE SETTINGS, NOT A CONSOLE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The addendum's design note under F20 is unusually prescriptive about the shape:
//
//   > "The admin panel is a section inside settings, not a separate 'console': member list with
//   >  roles, invite management, danger zone (transfer, delete space) behind confirmations."
//
// So this file exports `buildAdminSection(body, api)` with exactly the signature the other two
// family sections have — `createjoin.js`'s `buildFamilyCircleSection` and `membersui.js`'s
// `buildMembersSection` — and draws into the sheet everybody already knows how to open. There is
// no window, no tab bar, no „Verwaltung" mode. A family of four people who know each other does
// not need an admin surface with its own navigation; it needs four rows and three buttons in the
// place where the row height and the Bundesland already live.
//
// The order is the order a person needs them: the name of the thing, then who is in it, then how
// somebody else gets in, and last — under its own heading, behind confirmations — the three
// things that cannot be undone.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE OWNS, AND WHAT IT DELIBERATELY BORROWS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Three modules landed in the same round and the seams between them are drawn on purpose:
//
//   `createjoin.js`   owns the CIRCLE: `familyCircle()` is the one answer to "what is this Mac a
//                     member of", `CIRCLE_PREFS` is where it is written, and `deriveInvite` /
//                     `newInviteCode` / `formatInviteCode` / `invitationText` are the ONE
//                     definition of an invite code. This file imports every one of them rather
//                     than re-deriving anything: two spellings of ADR 002 §7.1's HKDF input are
//                     two different invite ids, and the symptom is „der Code passt nicht" on a
//                     correctly typed code.
//
//   `membersui.js`    owns the MEMBER LIST (15.4/15.6/17.3) and `membersUIState()` is its reader.
//                     The roster below is the same function's output, re-laid-out for management:
//                     role, and — for the admin — one button. Two lists that could disagree about
//                     who is in the circle would be worse than one list in the wrong place, so
//                     there is exactly one source and this is a second VIEW of it.
//
//   this file         owns 20.1's four verbs (invite, revoke, rename, transfer) and the frame
//                     around 20.2/20.3/20.4, whose confirmations are `leavedelete.js`'s.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// 20.5 IS A CONSTRAINT ON THE COPY OF THIS FILE, NOT ONLY ON ITS CODE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   > "Even as admin, I structurally CANNOT see other members' private entries or the contents of
//   >  their Belegt entries — the admin role grants space management, not surveillance; this is
//   >  enforced by encryption, not by policy."
//
// The failure mode here is not a bug, it is a sentence. A panel that lists people, puts a
// „Entfernen" button beside each one and says nothing else reads as a moderation console, and a
// person who reads it that way will assume the seat comes with sight. So `ADMIN_COPY.cannotSee`
// sits directly under the member list — the exact place where that assumption would form — and
// `ADMIN_COPY.roleNote` is the section's subtitle. Neither is decorative, and
// `tests/tier2/family-admin.dom.js` §4 asserts both in both languages.
//
// Nothing in this panel reads another member's content, because there is nothing here to read it
// with. The only network data it fetches is the relay's coordination data: invite ids, an epoch
// number and two timestamps. Names and colours come from the op stream every member decrypts
// identically, through `membersUIState()`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ADMIN GATE HERE IS PRESENTATIONAL, AND SAYING SO IS THE HONEST PART
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `isAdmin` hides the rename field, the remove buttons, the transfer control and the delete
// button. That is a UI decision and NOT a security boundary — `handlers/lifecycle.js` says why in
// its own header (finding E2-L1): the relay has no `role` column and cannot have one, because the
// admin is resolved from the in-log chain inside the ciphertext (ADR 001 §4.1, ADR 003 §5.1). So
// **any current member can call `/members/remove` and `/spaces/:id/delete`**, whatever this panel
// draws.
//
// What bounds that is not this file. It is that every member's list (15.4) shows the same
// membership, so a removal without the matching in-log op is visible as an inconsistency rather
// than a fait accompli — and that 20.4's outcome, everyone back to a fully intact solo board,
// makes the destructive endpoint survivable by construction. This panel does not pretend to be
// the enforcement; it draws what the current admin is *supposed* to reach, which is what a UI is
// for.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// D9, WHERE IT LANDS ON THIS SCREEN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// An invite carries no key material, so a joiner is a member instantly and her board fills in
// later. The joiner's half of that is `createjoin.js`'s waiting state. The ADMIN's half is this:
// the invite section must not promise instant arrival, and must not ask the admin to *do*
// anything afterwards — ADR 002 §7.1 step 4 is "any existing member device, not only the admin's,
// wraps the ring on its next ordinary sync". `ADMIN_COPY.afterJoin` is that sentence and it is
// written in the indicative („das geschieht von selbst"), never the imperative. There is no
// „Schlüssel senden" button in this panel and there must never be one: a button would make a
// person believe that not pressing it leaves somebody stranded, which is exactly the belief D9's
// follow-on rule forbids.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS OUT OF SCOPE, AND WHERE ITS SEAM IS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// LZP-608 — removal end to end — HAS LANDED, and it landed exactly where this file said it would:
// `ports.afterRemove` is now `family/removal.js#afterRemove`, and nothing else in this file
// changed. That module performs ADR 002 §4.1's rotation to `e+1` and publishes the in-log
// `member.set{_alive:false}` that takes the removed member's entries off every family board.
//
// The copy is still the server's claim and not one word more: access ends, the ops are purged,
// the wraps are deleted, the outstanding invites are revoked. What the removal ADDS to that is
// stated by `removal.js#REMOVAL_COPY` at the moment the outcome is known — including, always,
// Addendum §6's honesty line, which is `sync/keys.js#ROTATION_HONESTY` by identity rather than by
// a second spelling. This panel does not restate any of it.

import { el, field, toast } from '../ui.js';
import { t, getLang } from '../i18n.js';
import { colorOf } from '../palette.js';
import { store } from '../store.js';
import {
  familyCircle, CIRCLE_PREFS, CIRCLE_ROLE, INVITE_UI, circleTransport,
  newInviteCode, deriveInvite, formatInviteCode, invitationText,
} from './createjoin.js';
import { membersUIState } from './membersui.js';
import {
  confirmRemoveMember, confirmLeaveCircle, confirmDeleteSpace, confirmTransferAdmin,
  openCosignSign, COSIGN_COPY,
} from './leavedelete.js';
import { afterRemove } from './removal.js';
import { b64u } from '../core/b64.js';
import { chooseKeyStore } from '../platform/keystore.js';
import { openDeviceIdentity } from '../platform/device-identity.js';
import { signBytes, KEYSTORE_IDS } from '../crypto/identity.js';

const TE = new TextEncoder();

/** Whichever of a `{de, en}` pair the sheet is currently speaking. */
const say = (pair) => (getLang() === 'en' ? pair.en : pair.de);
const lang = () => (getLang() === 'en' ? 'en' : 'de');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE COPY — German first, English complete (13.7)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// It lives in the module rather than in `i18n.js` for the reason `crypto/backup.js`'s
// `EXPORT_SHEET_COPY` and `crypto/probe.js`'s `unavailableMessage()` do: `i18n.js` is in the boot
// graph of every solo Mac and this is family-mode copy behind the one dynamic door. Both
// languages are complete and every entry is a `{de, en}` pair, so folding it into `i18n.js` later
// is mechanical and a missing translation is a missing property rather than a German sentence in
// an English sheet.

export const ADMIN_COPY = Object.freeze({
  section: Object.freeze({ de: 'Kreis verwalten', en: 'Manage the circle' }),
  /** The subtitle. F20's own first line, and the frame for everything under it. */
  roleNote: Object.freeze({
    de: 'Der Verwalter verwaltet den Kreis, nicht die Menschen darin.',
    en: 'The admin manages the circle, never the people in it.',
  }),
  /** 20.5. Directly under the member list, where the opposite would otherwise be assumed. */
  cannotSee: Object.freeze({
    de: 'Auch als Verwalter siehst du die privaten Einträge der anderen nicht und liest die '
      + 'Inhalte ihrer Belegt-Einträge nicht. Das verhindert die Verschlüsselung, keine Regel.',
    en: "Even as admin you do not see other members' private entries and you do not read the "
      + 'contents of their Belegt entries. Encryption prevents that, not a rule.',
  }),

  // ── the name (20.1) ───────────────────────────────────────────────────────────────────────
  name: Object.freeze({ de: 'Name des Kreises', en: 'Name of the circle' }),
  nameHint: Object.freeze({
    de: 'Der Name gehört dem Kreis. Auf dem Server steht er nirgends.',
    en: 'The name belongs to the circle. It is stored nowhere on the server.',
  }),
  nameEmpty: Object.freeze({ de: 'Ein Kreis braucht einen Namen.', en: 'A circle needs a name.' }),
  nameSaved: Object.freeze({
    de: (n) => `Der Kreis heißt jetzt „${n}“.`,
    en: (n) => `The circle is called “${n}” now.`,
  }),

  // ── members (15.4, 20.1, 20.2) ────────────────────────────────────────────────────────────
  members: Object.freeze({ de: 'Mitglieder', en: 'Members' }),
  roleAdmin: Object.freeze({ de: 'Verwalter', en: 'Admin' }),
  roleMember: Object.freeze({ de: 'Mitglied', en: 'Member' }),
  you: Object.freeze({ de: 'du', en: 'you' }),
  gone: Object.freeze({ de: 'nicht mehr dabei', en: 'no longer here' }),
  remove: Object.freeze({ de: 'Entfernen', en: 'Remove' }),
  onlyYou: Object.freeze({
    de: 'Nur du bist im Kreis. Lade jemanden ein — gleich hier darunter.',
    en: 'You are the only one in the circle. Invite somebody — right below this.',
  }),
  noNameYet: Object.freeze({
    de: 'Name noch nicht angekommen',
    en: 'name has not arrived yet',
  }),

  // ── invites (15.2, 15.5) ──────────────────────────────────────────────────────────────────
  invites: Object.freeze({ de: 'Einladungen', en: 'Invites' }),
  create: Object.freeze({ de: 'Einladung erstellen', en: 'Create invite' }),
  rules: Object.freeze({
    de: (d) => `Der Code gilt ${d} Tage und lässt sich genau einmal einlösen.`,
    en: (d) => `The code is good for ${d} days and can be redeemed exactly once.`,
  }),
  /** D9, stated as a property of the code rather than as a caveat about it. */
  noKeys: Object.freeze({
    de: 'Der Code allein öffnet nichts. Er lässt jemanden in den Kreis — Schlüssel trägt er keine.',
    en: 'The code alone opens nothing. It lets somebody into the circle — it carries no keys.',
  }),
  /** D9's follow-on rule: it resolves itself, and nobody is asked to do anything. */
  afterJoin: Object.freeze({
    de: 'Wer beitritt, ist sofort Mitglied. Die Einträge des Kreises erscheinen auf ihrem Board, '
      + 'sobald irgendein Mac aus dem Kreis das nächste Mal synchronisiert. Das geschieht von selbst.',
    en: "Whoever joins is a member right away. The circle's entries appear on their board as soon "
      + 'as any Mac in the circle next syncs. That happens by itself.',
  }),
  copied: Object.freeze({
    de: (code) => `Einladung kopiert: ${code}`,
    en: (code) => `Invitation copied: ${code}`,
  }),
  shownOnce: Object.freeze({
    de: 'Der Code steht jetzt in der Zwischenablage. Später lässt er sich nicht noch einmal '
      + 'anzeigen — dann hilft nur eine neue Einladung.',
    en: 'The code is on the clipboard now. It cannot be shown again later — a new invite is the '
      + 'only way back to one.',
  }),
  revoke: Object.freeze({ de: 'Zurückziehen', en: 'Revoke' }),
  revoked: Object.freeze({ de: 'Die Einladung ist zurückgezogen.', en: 'The invite is revoked.' }),
  noInvites: Object.freeze({ de: 'Keine offene Einladung.', en: 'No open invite.' }),
  expiresIn: Object.freeze({
    de: (d) => (d <= 0 ? 'läuft heute ab' : d === 1 ? 'läuft morgen ab' : `läuft in ${d} Tagen ab`),
    en: (d) => (d <= 0 ? 'expires today' : d === 1 ? 'expires tomorrow' : `expires in ${d} days`),
  }),
  byYou: Object.freeze({ de: 'von dir', en: 'by you' }),
  byOther: Object.freeze({ de: 'von jemand anderem', en: 'by somebody else' }),

  // ── the three things that cannot be undone ────────────────────────────────────────────────
  danger: Object.freeze({ de: 'Nicht rückgängig', en: 'Cannot be undone' }),
  transferLabel: Object.freeze({ de: 'Rolle übergeben', en: 'Hand over the role' }),
  transferPick: Object.freeze({ de: 'Verwalter-Rolle', en: 'Admin role' }),
  transferNobody: Object.freeze({
    de: 'Dafür muss noch jemand anderes im Kreis sein.',
    en: 'Somebody else has to be in the circle first.',
  }),
  // ⚠ E6 INTEGRATION, and the reason this control is switched off rather than merely honest.
  //
  // Driving the transfer end to end against the real relay showed it is not "correct but local":
  // it is a ONE-WAY DEMOTION. `POST /members/transfer` answers `{authoritative:false,
  // stored:'nothing'}` — by design, the relay has no role column (ADR 003, `handlers/lifecycle.js`)
  // — so the authoritative record is a `space.set{admin, adminPrev}` op in the log. That op has an
  // in-log meaning (`core/authz.js`'s admin chain reads it) and NO CLIENT MUTATION to emit it.
  //
  // The observed result on two real Macs: the outgoing admin writes `role: 'member'` to his own
  // prefs, the successor is never told, and the circle ends with NO ADMIN ANYWHERE — no rename, no
  // invites, no removal, no delete, and no route back, because promoting somebody requires the
  // admin seat that just disappeared. A button that can only ever destroy the seat is worse than
  // an absent one, so it is disabled with the reason, in the house's own pattern
  // (`membersui.js`'s `readOnly` for the same missing-mutation cause). Deleting these six lines
  // is the whole of the re-enable, once `space.set` has a mutation and a publish path.
  transferBlocked: Object.freeze({
    de: 'Die Verwalter-Rolle lässt sich noch nicht übergeben: der Wechsel würde diesen Mac zum '
      + 'Mitglied machen, ohne beim anderen anzukommen — der Kreis bliebe ohne Verwaltung zurück.',
    en: 'The admin role cannot be handed over yet: the change would make this Mac a member '
      + 'without reaching the other one, and the circle would be left with nobody managing it.',
  }),
  leave: Object.freeze({ de: 'Kreis verlassen', en: 'Leave circle' }),
  deleteCircle: Object.freeze({ de: 'Kreis löschen', en: 'Delete circle' }),
  adminOnly: Object.freeze({
    de: 'Einladen, entfernen, umbenennen und löschen kann der Verwalter. Verlassen kann jede und jeder.',
    en: 'Inviting, removing, renaming and deleting are the admin’s. Leaving is anybody’s.',
  }),
  busy: Object.freeze({ de: 'Einen Moment …', en: 'One moment …' }),
  loadFailed: Object.freeze({
    de: 'Die Einladungen lassen sich gerade nicht vom Server abfragen. Am Kreis ändert das nichts.',
    en: 'The invites cannot be read from the server right now. Nothing about the circle changes.',
  }),
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE PORTS
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Same shape and the same reasoning as `createjoin.js`'s: clock, clipboard, transport and the two
// local writes, injectable so `tests/tier2/family-admin.dom.js` can drive the whole panel against
// a fake relay in a real engine, with the product's own defaults.
//
// `arm` WAS a duplicate of `createjoin.js`'s private `armForRelay()` and is no longer one: that
// file now exports the transport half as `circleTransport()` and this is a one-line delegation
// (E6 integration). One spelling of "open this Mac's identity and sign with it" — which also
// means an identity injected into `initCreateJoin` reaches these calls, so a test cannot arm the
// two halves of the lifecycle differently without noticing.

const DEFAULT_PORTS = Object.freeze({
  now: () => Date.now(),
  today: () => new Date().toISOString().slice(0, 10),
  invoke: () => globalThis.window?.__TAURI__?.core?.invoke,
  clipboard: (text) => globalThis.navigator?.clipboard?.writeText?.(text),
  reload: () => globalThis.location?.reload?.(),
  /** @returns {Promise<{request:Function}>} a transport signed by this Mac's device key */
  arm: (origin) => circleTransport(origin),
  /**
   * **THE ONLY PORT THAT TOUCHES A RECOVERY KEY, and it reads — it never mints.**
   *
   * ADR 003 §3.7's co-signature is a signature under `Member.recoveryPubSig`, so the co-signing
   * Mac has to open `RK_sig`. `circleTransport()` deliberately hands back only the transport
   * (`createjoin.js`: "adminpanel.js needs a signed transport and nothing else"), so this is the
   * one place that opens the identity itself.
   *
   * `ks.get(recSig)` runs FIRST and a null answer refuses before `openDeviceIdentity` is called,
   * because that function MINTS when the store is empty (ADR 002 §2.4 restricts key generation to
   * the family opt-in moment, and pressing „Mitunterschreiben" is not that moment). On a Mac that
   * is in a circle the record is always there; on one that is not, the section this button lives
   * in never renders. The guard is for the third case — a key store that has been cleared under a
   * live circle — where the honest answer is „dieser Mac hat keinen Schlüssel" and not a brand-new
   * identity nobody has ever heard of.
   *
   * @returns {Promise<Object|null>} what `openDeviceIdentity` returns, or null when there is no key
   */
  openRecovery: async () => {
    const { store: ks, kind: custody } = chooseKeyStore({ invoke: ports.invoke() });
    const have = await ks.get(KEYSTORE_IDS.recSig);
    if (!have) return null;
    return openDeviceIdentity(ks, { today: ports.today(), custody, allowMemoryCustody: false });
  },
  /** The circle, and the members, from the two modules that own them. */
  circle: () => familyCircle(),
  members: () => membersUIState(),
  /** The two local writes. `pref.set` is a local-space op; settings are never synced (rule U6). */
  setSettings: (patch) => store.setSettings(patch),
  persist: () => (typeof store.persistNow === 'function' ? store.persistNow() : Promise.resolve()),
  /**
   * **THE TWO 20.1 OPS, AS PORTS — because they are the half the relay cannot hold.**
   *
   * `POST /spaces/:id/rename` stores nothing and `POST /members/transfer` answers
   * `{authoritative:false, stored:'nothing'}`: ADR 003 §5.1 gives the relay no name column and no
   * role column, deliberately, so that a compromised relay cannot rewrite either. The
   * authoritative record for both is an op in the encrypted log — `space.set{name}` and
   * `space.set{admin, adminPrev}` — and `core/ops.js` rows 25 and 27 are what build them.
   *
   * They are PORTS and not bare `store` calls for the same reason `setSettings` is: this panel is
   * driven in a real WebKit against a fake relay, and a test that injects a relay must be able to
   * observe what was authored without arming a whole circle in the store first.
   */
  apply: (name, args) => store.apply(name, args),
  /** ADR 001 §4.1 — the head of the accepted admin chain; `transferAdmin`'s `adminPrev`. */
  adminSeat: () => (typeof store.familyAdmin === 'function' ? store.familyAdmin() : { admin: null, headOpId: null, isMe: false }),
  /**
   * LZP-608's seat, FILLED. Handed the relay's body, `rotateRequired` included.
   *
   * `family/removal.js#afterRemove` performs ADR 002 §4.1's rotation to `e+1` — wrapped to every
   * remaining member, with the relay's own `assertCoverage` refusing an incomplete one — and then
   * publishes the in-log `member.set{_alive:false}` that takes the removed member's shared and
   * Belegt entries off every family board (ADR 001 §4.2, story 20.2). It returns a verdict and
   * never throws for an ordinary failure; see `removeMember` below.
   *
   * It is a lambda and not the bare reference so a test can still replace the whole port, and so
   * this file states the ONE argument it passes.
   */
  afterRemove: (relayBody) => afterRemove(relayBody),
});

let ports = { ...DEFAULT_PORTS };

/**
 * Mount (or, with no arguments, reset) the admin panel's collaborators.
 * @param {Partial<typeof DEFAULT_PORTS>} [deps]
 */
/**
 * Whether handing over the admin role REACHES the successor.
 *
 * **`true` since `core/ops.js` grew `transferAdmin` and `claimAdmin` and the family publish path
 * carries them.** It was `false` for one round because driving the transfer across two real Macs
 * showed the control was a ONE-WAY DEMOTION: `POST /members/transfer` answers
 * `{authoritative:false, stored:'nothing'}` by design — the relay has no role column and cannot
 * have one (ADR 003 §5.1) — so the outgoing admin's own prefs flipped to `member`, the successor
 * was never promoted, and the circle ended with no admin anywhere and no route back.
 *
 * What makes it true now is the op, not the button: `space.set{admin, adminPrev}` (ADR 001 §4.1's
 * transfer link) is the authoritative record, every peer folds it through `foldAuthorized`, and
 * `store.familyAdmin()` reads the accepted head back. **`claimAdmin` is a precondition** — a
 * transfer names the link it supersedes, and on a circle with no genesis link there is nothing to
 * name and `transferAdmin` refuses rather than minting a rootless assertion.
 *
 * It stays a named constant: the control it gates is irreversible, and a reader of it should find
 * the argument beside the switch.
 *
 * @see ADMIN_COPY.transferBlocked
 */
export const TRANSFER_PROPAGATES = true;

export function initAdminPanel(deps = {}) {
  ports = { ...DEFAULT_PORTS, ...deps };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. THE RELAY CALLS — 20.1's four verbs plus the three of `leavedelete.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** One place decides what a non-200 means, so no caller has to invent an error shape. */
async function call(origin, method, path, query, body) {
  const transport = await ports.arm(origin);
  const res = await transport.request(method, path, query, body);
  if (res.status !== 200) {
    const detail = res.json && res.json.error ? res.json.error : String(res.status);
    const e = new Error(`${method} ${path} → ${res.status} ${detail}`);
    e.status = res.status;
    e.body = res.json;
    throw e;
  }
  return res.json || {};
}

/**
 * The port `leavedelete.js`'s four confirmations call. Built per render so it closes over the
 * circle that was on screen when the sheet was drawn — a circle that changed under it is a
 * `not_a_member` from the relay, which is the correct answer and not a stale-state bug.
 *
 * @param {Object} circle `familyCircle()`
 */
export function createAdminPort(circle) {
  const { origin, spaceId } = circle;
  return Object.freeze({
    spaceId,
    spaceName: () => (ports.circle()?.name || circle.name || ''),

    // ── the co-signature's four collaborators (ADR 003 §3.7) ────────────────────────────────
    //
    // They are on the AdminPort rather than inside `leavedelete.js` for the reason every other
    // seam in this pair is drawn that way: that file owns the copy and the sheets, this one owns
    // the network, the key store and the member list. A sheet that reached for a Keychain would
    // be a sheet a test could not drive.

    /**
     * This Mac's member id — the `presenter` in the signed bytes.
     *
     * It is `CIRCLE_PREFS.member`, which `createjoin.js` writes from `id.forStore.memberId` at
     * create and at join, so it is the same value the relay resolves from the authenticated
     * device. `coSign` asserts the two still agree rather than trusting that sentence.
     */
    myMemberId: () => circle.memberId || '',

    /** The clipboard, as the sheets' one convenience. Never load-bearing — the block is on screen. */
    copy: (text) => ports.clipboard(text),

    /**
     * A member's name out of THIS Mac's own member list — the log every member decrypts
     * identically. Never out of a pasted block: a name in text somebody else wrote is a name
     * somebody else chose for the person you are about to act against.
     */
    nameOf: (memberId) => {
      const view = ports.members();
      const rows = (view && view.supported ? view.members : []) || [];
      const m = rows.find((r) => r.memberId === memberId);
      return m && m.displayName ? m.displayName : '';
    },

    /**
     * How many live members could co-sign an act against `targetId` — everyone alive who is
     * neither me nor the target. `null` when this Mac's member view is not mounted and the answer
     * is genuinely UNKNOWN.
     *
     * The difference matters exactly once, and it is the T5-M3 caveat: **zero** is the
     * founder-less two-member circle, where the rule is unsatisfiable and the honest sentence is
     * „hier lässt sich niemand mehr entfernen". Reporting an unknown count as zero would tell a
     * five-person family it was stuck, so it is `null` and the sheet offers the request anyway.
     *
     * @param {string|null} targetId the member being removed, or null for `space.delete`
     */
    eligibleCosigners: (targetId) => {
      const view = ports.members();
      if (!view || !view.supported) return null;
      const me = circle.memberId || '';
      return (view.members || []).filter((m) => m.alive !== false
        && m.memberId !== me && m.memberId !== targetId).length;
    },

    /**
     * Sign `lzp/admin/2 …` with THIS Mac's own recovery key.
     *
     * The one crypto call in the co-signature flow, and everything about it is deliberately
     * narrow: it takes a finished string (built by `leavedelete.js#adminProofString`, which
     * mirrors `server/core/auth.js`), it signs, and it returns the two fields the relay's
     * `adminProof` object has. It cannot be asked to sign for anybody else, because the only
     * private key it can reach is the one in this Mac's key store.
     *
     * @param {string} signedString @returns {Promise<{by:string, sig:string}>}
     */
    async coSign(signedString) {
      const id = await ports.openRecovery();
      if (!id || !id.recovery || !id.recovery.recSig) {
        throw new Error('cosign: this Mac holds no recovery key');
      }
      // A Mac whose prefs name one member and whose keys are another's would mint a proof over
      // bytes the relay never assembles — a `401 bad_signature` and a phone call to work out why.
      // Loud here instead.
      if (circle.memberId && id.forStore.memberId !== circle.memberId) {
        throw new Error(`cosign: this Mac's keys belong to ${id.forStore.memberId}, its circle says ${circle.memberId}`);
      }
      const sig = await signBytes(id.recovery.recSig.privateKey, TE.encode(signedString));
      return { by: id.forStore.memberId, sig: b64u(sig) };
    },

    /** 15.5 — the open invites of this circle: un-redeemed, un-revoked, un-expired. */
    async openInvites() {
      const body = await call(origin, 'GET', '/api/v1/invites/open', { spaceId }, undefined);
      const me = circle.memberId;
      return (body.invites || []).map((i) => ({ ...i, mine: i.createdBy === me }));
    },

    /**
     * 15.2/15.5 — mint locally, publish only the two opaque derivatives.
     * The CODE is returned and is stored nowhere: not in the log, not in settings, not on the
     * relay. That is why the sheet says the code cannot be shown again.
     */
    async createInvite() {
      const code = newInviteCode();
      const invite = await deriveInvite(code);
      const body = await call(origin, 'POST', '/api/v1/invites', undefined, {
        spaceId, inviteId: invite.inviteId, verifier: invite.verifier,
      });
      return { code, inviteId: invite.inviteId, expiresAt: body.expiresAt };
    },

    revokeInvite: (inviteId) =>
      call(origin, 'POST', '/api/v1/invites/revoke', undefined, { spaceId, inviteId }),

    /**
     * 20.2. The relay ends the access; `ports.afterRemove` does the other two halves — the
     * epoch rotation ADR 002 §4.1 requires, and the in-log `member.set{_alive:false}` that takes
     * the removed member's entries off every family board (LZP-608, `family/removal.js`).
     *
     * The relay's body is handed over VERBATIM, `rotateRequired` included, and the outcome rides
     * back on `res.removal` so the confirmation can say what actually happened rather than
     * assuming. A port that throws must not turn a completed removal into „das hat nicht
     * geklappt": the member IS out, the relay said so, and `afterRemove` answers with a verdict
     * instead of an exception for exactly that reason.
     */
    async removeMember(memberId, proof) {
      // ⚠ **THE BODY CARRIES THE SIGNATURE AND NEVER THE PRESENTER.** `adminProof` is `{by, sig}`
      // and nothing else: the relay assembles `act`, `spaceId`, `target`, `epoch` and `presenter`
      // out of values it already holds (`handlers/lifecycle.js` — "note what is NOT read from the
      // body"), and a presenter in a body field would be a claim it had to trust. The proof is
      // OMITTED rather than sent as null when there is none, so an ordinary removal is still the
      // two-key body it always was.
      const body = proof ? { spaceId, memberId, adminProof: { by: proof.by, sig: proof.sig } } : { spaceId, memberId };
      const res = await call(origin, 'POST', '/api/v1/members/remove', undefined, body);
      if (typeof ports.afterRemove === 'function') {
        try {
          const outcome = await ports.afterRemove(res);
          if (outcome) res.removal = outcome;
        } catch (e) {
          // The relay half is done and is not undone by a client-side failure. Reported loudly,
          // never raised: raising here would make the panel claim nothing had changed.
          console.warn('[admin] the removal completed on the server; the follow-up did not', e);
        }
      } else if (res.rotateRequired) {
        // Only reachable when a caller injects `afterRemove: null` on purpose. The default port
        // is `family/removal.js#afterRemove`.
        console.warn('[admin] removal done; nothing is wired to perform ADR 002 §4.1\'s rotation');
      }
      return res;
    },

    /**
     * 20.1 — hand over. The relay checks the successor exists and is current, and stores NOTHING:
     * there is no role column and there cannot be one (ADR 003 §5.1). The record is the in-log
     * `space.set{admin, adminPrev}` op, which `core/ops.js` has no mutation for yet — see the
     * seam note in this file's return value. What we can write today is this Mac's own view of
     * the role, so the panel stops offering admin controls to somebody who just gave them away.
     */
    async transferAdmin(memberId) {
      // ── THE AUTHORITATIVE RECORD, AND IT GOES FIRST ──────────────────────────────────────────
      //
      // ADR 001 §4.1's transfer link. `adminPrev` is the opId of the link this one supersedes and
      // `store.familyAdmin()` is the ONLY supported source of it — the constructor refuses a
      // `null` prev (a rootless assertion hands the seat to nobody) and refuses an author who is
      // not the sitting admin.
      //
      // **BEFORE the relay call, deliberately.** The relay stores nothing here and its answer is
      // advisory; the op is the fact. Ordering it second would mean a relay hiccup demoted this
      // Mac's own prefs while the promotion never entered the log — which is exactly the
      // headless-circle outcome E6-2 measured. Ordering it first means the worst case is an op
      // that promotes her and a relay that never heard about it, and the op is what every Mac
      // folds.
      ports.apply('transferAdmin', { admin: memberId, adminPrev: ports.adminSeat().headOpId });
      const res = await call(origin, 'POST', '/api/v1/members/transfer', undefined, { spaceId, memberId });
      ports.setSettings({ [CIRCLE_PREFS.role]: CIRCLE_ROLE.member });
      await ports.persist();
      return res;
    },

    /** 20.1 — the rename. Local first, because that is where the name lives. */
    async rename(name) {
      // 20.1's authoritative half. Without it the name is a PER-MAC FACT: Papa's circle read
      // „Familie Weber-Schmidt" and Mama's read „—", which is what E6-VERIFICATION §3.4 measured.
      // The local pref stays as well, because it is what renders before the op has folded and on
      // a Mac whose keys have not arrived (D9).
      // The local pref is written EVEN IF the op cannot be authored, and the failure is loud
      // rather than fatal — the same shape as the relay ping ten lines down. A Mac whose circle
      // has no admin chain yet (`claimAdmin` not folded) can still name its own board; what it
      // cannot do is tell anyone else, and the console says exactly that. Swallowing this
      // silently would restore finding E6-1's rename-is-a-per-Mac-fact, so it is never quiet.
      try {
        ports.apply('renameSpace', { name });
      } catch (e) {
        console.warn('[admin] the rename could not be authored into the family log, so it is a '
          + 'fact on THIS Mac only and will not reach the other members (20.1):', e.message);
      }
      ports.setSettings({ [CIRCLE_PREFS.name]: name });
      await ports.persist();
      try {
        await call(origin, 'POST', `/api/v1/spaces/${spaceId}/rename`, undefined, {});
      } catch (e) {
        // The rename already happened where the name lives. An unreachable relay does not undo a
        // local write, and reporting a failure would be a lie about which side holds the name.
        console.warn('[admin] the rename ping did not reach the relay; the name is local anyway', e);
      }
    },

    /** 20.3 — leave, then forget the circle on this Mac. */
    async leaveSpace() {
      const res = await call(origin, 'POST', '/api/v1/members/leave', undefined, { spaceId });
      await forgetCircle();
      return res;
    },

    /**
     * 20.4 — delete. `handlers/lifecycle.js` requires `confirm === spaceId`; the human typed the
     * NAME, which is the only one of the two they can read, and `confirmDeleteSpace` checked it.
     * This is the machine half of the same confirmation.
     */
    async deleteSpace(proof) {
      // The second key, same shape as the removal's. `handlers/lifecycle.js` requires it whenever
      // the space has ever had more than one member row — which is every real Familienkreis, so
      // the un-proofed call below is the FIRST half of the flow and not the honest path: it is
      // what earns the 403 that names the terms. Only a `psp_` personal space, or a circle nobody
      // ever joined, is deleted without one.
      const body = proof
        ? { confirm: spaceId, adminProof: { by: proof.by, sig: proof.sig } }
        : { confirm: spaceId };
      const res = await call(origin, 'POST', `/api/v1/spaces/${spaceId}/delete`, undefined, body);
      await forgetCircle();
      return res;
    },
  });
}

/**
 * What 20.3 and 20.4 do to THIS Mac: the circle stops existing here.
 *
 * Every `CIRCLE_PREFS` key is cleared — including `pending`, so a Mac that left while waiting for
 * D9's wrap does not keep waiting for a circle it is no longer in — and the board is reloaded,
 * because `familyCircle()` is read at render and half the app was armed from it at boot.
 *
 * Deliberately NOT cleared: `syncOrigin`. It is shared with the personal space (`FAMILY_PREFS`,
 * `engine.js`) and clearing it would silently unpair somebody's second Mac (19.4) as a side effect
 * of leaving a family circle. Two features, two decisions.
 *
 * The board itself is untouched, which is 20.3's whole promise: „meine eigenen Einträge bleiben
 * bei mir". Nothing here deletes an entry.
 */
async function forgetCircle() {
  ports.setSettings({
    [CIRCLE_PREFS.space]: '',
    [CIRCLE_PREFS.name]: '',
    [CIRCLE_PREFS.role]: '',
    [CIRCLE_PREFS.member]: '',
    [CIRCLE_PREFS.display]: '',
    [CIRCLE_PREFS.color]: '',
    [CIRCLE_PREFS.pending]: false,
    [CIRCLE_PREFS.joinedAt]: '',
  });
  await ports.persist();
  ports.reload();
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. THE PURE VIEW MODELS — asserted without a DOM
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `membersUIState().members` laid out for management: admin first, then alive members by name,
 * then the ones who are gone.
 *
 * A member with no `displayName` is KEPT and shown with its initial placeholder — that is D9's
 * joiner seen from an established Mac before her profile op has folded, and hiding the newest
 * arrival is precisely the wrong moment to be quiet (15.4: "everyone knows who's in the circle").
 *
 * @param {Array<Object>} rows `MemberRow[]`
 * @param {'de'|'en'} l
 * @returns {Array<Object>}
 */
export function manageRows(rows, l) {
  const out = (rows || []).map((m) => ({
    memberId: m.memberId,
    name: m.displayName || ADMIN_COPY.noNameYet[l === 'en' ? 'en' : 'de'],
    hasName: !!m.displayName,
    colorRef: m.colorRef || 'schiefer',
    initial: m.initial || '·',
    isMe: !!m.isMe,
    isAdmin: !!m.isAdmin,
    removed: m.alive === false,
  }));
  out.sort((a, b) => {
    if (a.removed !== b.removed) return a.removed ? 1 : -1;
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

/** `· Verwalter · du` — the role line beside a name. */
export function roleWord(m, l) {
  const parts = [m.isAdmin ? ADMIN_COPY.roleAdmin[l] : ADMIN_COPY.roleMember[l]];
  if (m.isMe) parts.push(ADMIN_COPY.you[l]);
  if (m.removed) parts.push(ADMIN_COPY.gone[l]);
  return `· ${parts.join(' · ')}`;
}

/**
 * „läuft in 3 Tagen ab".
 *
 * CALENDAR days, not elapsed ones, and the difference is the whole design of this line. An invite
 * minted at 14:00 expires at 14:00 seven days later; `floor(elapsed/24h)` calls that "6 days" and
 * the admin who just read „der Code gilt sieben Tage" one line above reads an off-by-one. And
 * `ceil` is worse in the other direction — it promises a whole day to a code with four hours left.
 * Whole days between the two DATES answers both: seven for the fresh invite, „läuft heute ab" for
 * the one expiring this afternoon, which is the sentence that gets the invitation sent.
 *
 * This is the same arithmetic v1 uses everywhere it counts days, and for the same reason: the
 * board has no times of day, so neither does anything that talks to it.
 *
 * @param {string} expiresAt ISO @param {number} now ms @param {'de'|'en'} l
 */
export function expiryLabel(expiresAt, now, l) {
  const at = Date.parse(String(expiresAt || ''));
  if (!Number.isFinite(at)) return '';
  const midnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((midnight(at) - midnight(now)) / 86400000);
  return ADMIN_COPY.expiresIn[l === 'en' ? 'en' : 'de'](Math.max(0, days));
}

/** Everything the section believes, without touching the DOM. For tests, and for one warning. */
export function adminPanelState() {
  const circle = ports.circle();
  if (!circle) return Object.freeze({ present: false, isAdmin: false, members: [] });
  const view = ports.members();
  return Object.freeze({
    present: true,
    spaceId: circle.spaceId,
    name: circle.name,
    isAdmin: circle.role === CIRCLE_ROLE.admin,
    members: manageRows(view.supported ? view.members : [], lang()),
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. THE SECTION
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Draw „Kreis verwalten" into an open settings sheet.
 *
 * Signature-compatible with `buildFamilyCircleSection` and `buildMembersSection`, which is what
 * `familysettings.js` calls them all with. It draws NOTHING when this Mac is in no circle: a solo
 * Mac and a Mac with only a personal space both see exactly what they saw before (Principle 7,
 * story 15.1).
 *
 * @param {HTMLElement} body the sheet body
 * @param {{rebuild:Function, close:Function}} api
 */
export function buildAdminSection(body, api) {
  const circle = ports.circle();
  if (!circle) return;                        // no Familienkreis on this Mac — silently

  const l = lang();
  const isAdmin = circle.role === CIRCLE_ROLE.admin;
  const port = createAdminPort(circle);
  const rows = manageRows(memberRowsOf(circle), l);

  body.appendChild(el('div', 'section-title', say(ADMIN_COPY.section)));
  body.appendChild(hint(say(ADMIN_COPY.roleNote)));

  buildNameRow(body, circle, port, isAdmin, api);
  buildMemberList(body, rows, port, isAdmin, api, l);
  if (isAdmin) buildInvites(body, circle, port, l);
  buildDangerZone(body, circle, port, rows, isAdmin, api, l);
}

/**
 * The member rows, from `membersui.js` where it is mounted and from the circle itself where it is
 * not.
 *
 * The fallback is not a stub: `membersUIState()` reports `supported: false` until a flow mounts a
 * port over it, and on a Mac that has just created a circle the only member IS me. Drawing one
 * honest row beats drawing an empty list under a „Mitglieder" heading.
 */
function memberRowsOf(circle) {
  const view = ports.members();
  if (view && view.supported && view.members.length) return view.members;
  return [{
    memberId: circle.memberId || 'me',
    displayName: circle.displayName || '',
    colorRef: circle.colorRef,
    initial: (circle.displayName || '·').trim() ? [...circle.displayName.trim()][0].toLocaleUpperCase() : '·',
    alive: true,
    isMe: true,
    isAdmin: circle.role === CIRCLE_ROLE.admin,
    hidden: false,
  }];
}

/** A `.hint` paragraph without the 178 px field indent — section prose, not a field annotation. */
function hint(text) {
  const p = el('p', 'hint', text);
  p.style.marginLeft = '0';
  return p;
}

// ── the name (20.1) ──────────────────────────────────────────────────────────────────────────

function buildNameRow(body, circle, port, isAdmin, api) {
  const current = circle.name || '';
  if (!isAdmin) {
    body.appendChild(field(say(ADMIN_COPY.name), [el('span', 'val-wide', current || '—')]));
    body.appendChild(hint(say(ADMIN_COPY.nameHint)));
    return;
  }
  const input = el('input');
  input.type = 'text';
  input.className = 'txt';
  input.value = current;
  input.maxLength = INVITE_UI.maxCircleName;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.style.cssText = 'flex:1;min-width:0;height:26px;padding:0 7px;border:1px solid var(--field-border);border-radius:5px;font:400 12px var(--font)';
  // On ⏎ and on blur, never on every keystroke: a name is a fact the whole circle reads, and one
  // write per character would be a sync storm for a five-letter change of mind.
  const commit = async () => {
    const next = input.value.trim();
    if (next === current) return;
    if (!next) { toast(say(ADMIN_COPY.nameEmpty)); input.value = current; return; }
    try {
      await port.rename(next);
      toast(say(ADMIN_COPY.nameSaved)(next));
      api.rebuild();
    } catch (e) {
      console.warn('[admin] rename failed', e);
      input.value = current;
    }
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  body.appendChild(field(say(ADMIN_COPY.name), [input]));
  body.appendChild(hint(say(ADMIN_COPY.nameHint)));
}

// ── the member list, as management (15.4, 20.2) ──────────────────────────────────────────────

function buildMemberList(body, rows, port, isAdmin, api, l) {
  body.appendChild(el('div', 'section-title', say(ADMIN_COPY.members)));
  const box = el('div', 'admin-members');
  for (const m of rows) {
    const row = el('div', 'snap-row');
    row.dataset.member = m.memberId;

    const who = el('div');
    who.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0';

    // 17.2's initial chip in the member's own colour — the same badge family the board and the
    // legend use, at the size a settings row can afford (deliverable 17).
    const chip = el('span', 'member-chip', m.initial);
    chip.style.cssText =
      'flex:none;width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;'
      + `justify-content:center;font:600 10px var(--font);color:#fff;background:${colorOf(m.colorRef)}`;
    who.appendChild(chip);

    const name = el('span', 'member-name', m.name);
    name.style.cssText = 'font:500 12px var(--font);color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    if (!m.hasName) name.style.color = 'var(--ink-3)';
    if (m.removed) name.style.textDecoration = 'line-through';
    who.appendChild(name);

    const role = el('span', 'member-role', roleWord(m, l));
    role.style.cssText = 'font:400 11px var(--font);color:var(--ink-3);white-space:nowrap';
    who.appendChild(role);
    row.appendChild(who);

    // 20.2 — never on yourself. Removing yourself is „Kreis verlassen" one section down, and the
    // relay refuses `memberId === auth.memberId` with `use_leave` for the same reason: two
    // stories, two sentences, two confirmations.
    if (isAdmin && !m.isMe && !m.removed) {
      const rm = el('button', 'btn-ghost btn-danger', say(ADMIN_COPY.remove));
      rm.type = 'button';
      rm.style.cssText = 'height:24px;padding:0 9px;font:500 11px var(--font)';
      rm.addEventListener('click', () => confirmRemoveMember({
        port, member: m, onDone: () => api.rebuild(),
      }));
      row.appendChild(rm);
    }
    box.appendChild(row);
  }
  body.appendChild(box);
  if (rows.length <= 1) body.appendChild(hint(say(ADMIN_COPY.onlyYou)));
  // 20.5, in the one place the opposite would otherwise be assumed.
  body.appendChild(hint(say(ADMIN_COPY.cannotSee)));

  // ── „Mitunterschrift geben" (ADR 003 §3.7) ─────────────────────────────────────────────────
  //
  // **Every member's, not the admin's.** The whole point of the second key is that it belongs to
  // somebody who is not the person asking, and in a founder-less circle the person asking is
  // usually not the admin either — the relay has no role column and the gate is a two-ROW rule.
  // Hiding this behind `isAdmin` would leave the one control that makes the gate satisfiable
  // reachable only by the seat the gate does not know about.
  //
  // It sits under the member list because that is where a person looks when somebody phones and
  // says „kannst du das mitunterschreiben?" — and it opens a sheet rather than growing a field
  // here, so a settings section that draws no text input for a non-admin still draws none.
  const cosign = el('button', 'btn-ghost admin-cosign', say(COSIGN_COPY.signEntry));
  cosign.type = 'button';
  cosign.style.cssText = 'height:24px;padding:0 9px;font:500 11px var(--font);margin:2px 0 4px';
  cosign.addEventListener('click', () => openCosignSign({ port }));
  body.appendChild(cosign);
}

// ── invites (15.2, 15.5) ─────────────────────────────────────────────────────────────────────

function buildInvites(body, circle, port, l) {
  body.appendChild(el('div', 'section-title', say(ADMIN_COPY.invites)));
  body.appendChild(hint(say(ADMIN_COPY.rules)(INVITE_UI.ttlDays)));
  body.appendChild(hint(say(ADMIN_COPY.noKeys)));
  body.appendChild(hint(say(ADMIN_COPY.afterJoin)));

  const listBox = el('div', 'admin-invites');

  const acts = el('div', 'acts');
  acts.style.cssText = 'display:flex;gap:8px;margin:2px 0 10px';
  const mint = el('button', 'btn-primary', say(ADMIN_COPY.create));
  mint.type = 'button';
  mint.addEventListener('click', async () => {
    mint.disabled = true;
    try {
      const inv = await port.createInvite();
      // ⚠ **THE COPY IS A CONVENIENCE AND MAY NOT DESTROY THE INVITE.** Measured in a real
      // browser: `navigator.clipboard.writeText` threw `NotAllowedError: Document is not focused`,
      // the rejection escaped to the catch below, and the panel reported „…fehlgeschlagen" and
      // then drew „Keine offene Einladung" — while the invite HAD been minted on the relay. The
      // code the admin was about to send existed, was shown nowhere, and could not be recovered:
      // `POST /invites` stores a verifier, never the code (ADR 002 §7.1), so a code that is not
      // read out of this response is gone for ever and the row has to be revoked and re-minted.
      //
      // The clipboard is a permissioned API that can refuse for reasons that have nothing to do
      // with the circle — focus, Safari's user-gesture rule, a locked pasteboard. So the mint is
      // committed first, the list is drawn first, and a copy failure becomes ITS OWN message.
      let copied = true;
      try {
        // The whole invitation, not the bare code: `invitationText` is the artifact 22.1 designs
        // and it carries the relay's address, which a code alone does not. Nothing in it is key
        // material — an address and a code is exactly what ADR 002 §7.1 permits an invite to carry.
        await ports.clipboard(invitationText({
          origin: circle.origin, code: inv.code, name: circle.name,
        }));
      } catch (copyErr) {
        copied = false;
        console.warn('[admin] the invitation could not be copied to the clipboard; the code is '
          + 'shown instead and the invite itself is unaffected:', copyErr);
      }
      body.insertBefore(hint(say(ADMIN_COPY.shownOnce)), listBox);
      await renderInvites(listBox, port, l);
      // Shown either way. When the copy worked this is the confirmation; when it did not, it is
      // the ONLY place the code appears, so it is never conditional on the clipboard.
      toast(copied
        ? say(ADMIN_COPY.copied)(formatInviteCode(inv.code))
        : formatInviteCode(inv.code));
    } catch (e) {
      console.warn('[admin] createInvite failed', e);
      toast(t('familyFailed', String((e && e.message) || e)));
    } finally {
      mint.disabled = false;
    }
  });
  acts.appendChild(mint);
  body.appendChild(acts);

  body.appendChild(listBox);
  renderInvites(listBox, port, l);
}

async function renderInvites(box, port, l) {
  box.textContent = '';
  box.appendChild(hint(say(ADMIN_COPY.busy)));
  let invites = [];
  try {
    invites = await port.openInvites();
  } catch (e) {
    console.warn('[admin] openInvites failed', e);
    box.textContent = '';
    box.appendChild(hint(say(ADMIN_COPY.loadFailed)));
    return;
  }
  box.textContent = '';
  if (!invites.length) { box.appendChild(hint(say(ADMIN_COPY.noInvites))); return; }

  for (const inv of invites) {
    const row = el('div', 'snap-row');
    row.dataset.invite = inv.inviteId;

    const left = el('div');
    left.style.cssText = 'display:flex;flex-direction:column;gap:1px;min-width:0';
    // The invite ID, never the code: the code exists only wherever the admin sent it, and this
    // list is what „welche Einladung ziehe ich zurück?" is answered from.
    const idn = el('span', null, `#${String(inv.inviteId).slice(0, 6)}`);
    idn.style.cssText = 'font:500 11px var(--mono);color:var(--ink-2)';
    left.appendChild(idn);
    const meta = el('span', null, `${expiryLabel(inv.expiresAt, ports.now(), l)} · `
      + say(inv.mine ? ADMIN_COPY.byYou : ADMIN_COPY.byOther));
    meta.style.cssText = 'font:400 11px var(--font);color:var(--ink-3)';
    left.appendChild(meta);
    row.appendChild(left);

    const rv = el('button', 'btn-ghost', say(ADMIN_COPY.revoke));
    rv.type = 'button';
    rv.style.cssText = 'height:24px;padding:0 9px;font:500 11px var(--font)';
    rv.addEventListener('click', async () => {
      rv.disabled = true;
      try {
        await port.revokeInvite(inv.inviteId);
        toast(say(ADMIN_COPY.revoked));
        await renderInvites(box, port, l);
      } catch (e) {
        rv.disabled = false;
        console.warn('[admin] revokeInvite failed', e);
        toast(t('familyFailed', String((e && e.message) || e)));
      }
    });
    row.appendChild(rv);
    box.appendChild(row);
  }
}

// ── the three things that cannot be undone (20.1, 20.3, 20.4) ────────────────────────────────

function buildDangerZone(body, circle, port, rows, isAdmin, api, l) {
  body.appendChild(el('div', 'section-title', say(ADMIN_COPY.danger)));
  const others = rows.filter((m) => !m.isMe && !m.removed);

  if (isAdmin) {
    // 20.1 — a picker plus a button rather than a per-row action: handing over the role is a
    // decision about one person, and a per-row shape invites a mis-click on the row you were
    // only reading.
    const pick = document.createElement('select');
    pick.className = 'admin-transfer';
    for (const m of others) {
      const o = document.createElement('option');
      o.value = m.memberId;
      o.textContent = m.name;
      pick.appendChild(o);
    }
    const go = el('button', 'btn-ghost', say(ADMIN_COPY.transferLabel));
    go.type = 'button';
    // `TRANSFER_PROPAGATES` is now true — `port.transferAdmin` authors ADR 001 §4.1's transfer
    // link before it pings the relay, so the successor is promoted in the log every Mac folds.
    // The gate stays, because a circle with nobody else in it still has nobody to hand it to.
    const canTransfer = TRANSFER_PROPAGATES && others.length > 0;
    if (!canTransfer) { pick.disabled = true; go.disabled = true; }
    go.addEventListener('click', () => {
      const m = others.find((x) => x.memberId === pick.value);
      if (!m || !canTransfer) return;
      confirmTransferAdmin({ port, member: m, onDone: () => api.rebuild() });
    });
    body.appendChild(field(say(ADMIN_COPY.transferPick), [pick, go]));
    if (!TRANSFER_PROPAGATES) body.appendChild(hint(say(ADMIN_COPY.transferBlocked)));
    else if (!others.length) body.appendChild(hint(say(ADMIN_COPY.transferNobody)));
  } else {
    body.appendChild(hint(say(ADMIN_COPY.adminOnly)));
  }

  const acts = el('div', 'acts');
  acts.style.cssText = 'display:flex;gap:8px;margin-top:4px';

  // 20.3 — everybody's, the admin included. An admin who cannot leave is a person the product has
  // trapped; the confirmation tells them the seat is about to be empty (`leavedelete.js`).
  const live = rows.filter((m) => !m.removed).length;
  const leave = el('button', 'btn-ghost btn-danger', say(ADMIN_COPY.leave));
  leave.type = 'button';
  leave.className = 'btn-ghost btn-danger admin-leave';
  leave.addEventListener('click', () => confirmLeaveCircle({
    port,
    spaceName: circle.name || '',
    isAdmin,
    lastOneOut: live <= 1,
    // THE T5-M3 CAVEAT, MET BEFORE IT BITES. Leaving a circle of three leaves two behind, and a
    // founder-less pair cannot remove anybody — only leave. Said at the moment the person is
    // about to CAUSE that state, and phrased as a condition, because this Mac cannot know
    // whether the founder is still in the circle (the relay does not publish `founderMemberId`).
    leavesTwoBehind: live === 3,
    onDone: () => api.close(),
  }));
  acts.appendChild(leave);

  // 20.4 — admin only in the UI. The relay cannot check that (see this file's header); what makes
  // it survivable is that every board stays complete.
  if (isAdmin) {
    const del = el('button', 'btn-ghost btn-danger admin-delete', say(ADMIN_COPY.deleteCircle));
    del.type = 'button';
    del.addEventListener('click', () => confirmDeleteSpace({
      port, spaceName: circle.name || '', onDone: () => api.close(),
    }));
    acts.appendChild(del);
  }
  body.appendChild(acts);

  // ── the caveat, standing, in the circle small enough to fall into it ───────────────────────
  //
  // Once `Space.founderMemberId` no longer names a live member, EVERY removal needs a second
  // member row (T5-M3) — and in a two-member circle the only possible co-signer is the target,
  // so the rule cannot be satisfied at all. This Mac cannot tell whether that has already
  // happened; what it can see is the size of the circle, which is the half that makes it bite.
  //
  // At TWO, because that is the size at which the rule becomes unsatisfiable. A healthy circle of
  // four is not warned about a state it is two departures away from — a caveat shown to everybody
  // is a caveat nobody reads, and the person one step away meets it on the leave confirmation
  // instead (`LIFECYCLE_COPY.leave.leavesTwoBehind`).
  if (live <= 2) body.appendChild(hint(say(COSIGN_COPY.strandNote)));
}
