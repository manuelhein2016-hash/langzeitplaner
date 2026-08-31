// src/js/family/membersui.js — the member list, my own name and colour, and the legend's
// „Familie" half.  LZP-603 · stories 15.4, 15.6, 17.3 · amendment A3 · deliverable 16.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE THREE SURFACES IN THIS FILE, AND WHY THEY ARE ONE FILE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   „Familie" in ⚙          the member list (15.4) and MY OWN name + colour (15.6). One row per
//                           member: colour, initial, name. Exactly one row has controls on it.
//   the legend's second half A3 / 17.3 — the members as colour + initial, each one a visibility
//                           toggle, sitting next to „Meine Kategorien" in the same 40 px row.
//   the member popover      what the legend's `· n` opener opens: the same list, read-only, for
//                           the moment you need the name behind a chip.
//
// They are one module because they are one QUESTION — "who is in this circle and what colour are
// they?" — answered from one reader (`readMembers`) over one source of truth (the op log). Two
// modules would be two readers, and the failure mode of two readers is a legend chip and a
// settings row disagreeing about somebody's colour, which is unfalsifiable at a glance.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHERE A MEMBER'S NAME COMES FROM, AND WHY IT IS NOT THE RELAY
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `server/core/handlers/members.js`'s `memberProjection` publishes `memberId`, `colorRef`,
// `joinedAt`, `removedAt`, the recovery public keys and the device rows. It does NOT publish a
// display name, and `invites.js`'s `FORBIDDEN_RESPONSE_FIELDS` lists `displayName` among the
// field names that may never appear in a response. That is not an oversight to work around: the
// name travels inside the E2EE op stream as `member:<id>.displayName`, so the relay does not
// hold it and cannot be asked for it.
//
// Therefore `readMembers()` reads the REGISTER MAP, and the roster is at most a second opinion
// about `colorRef`. When the two disagree the log wins here, because the log is what
// `materialize.js` renders foreign entries from (17.2) and a legend that disagreed with the
// board would be worse than a legend that disagreed with the relay.
//
// ── THE CASE THIS PRODUCES, WHICH IS D9's AND HAS TO BE DESIGNED RATHER THAN DISCOVERED ─────
//
// A joiner is a member the moment she redeems (ADR 002 §7.1 step 2) and holds NO epoch key until
// another member's Mac wraps to her (step 4). Between those two moments every `member.set` op in
// the space is ciphertext to her — so her member list has colours and NO NAMES, because the
// colours come from the roster in the clear and the names do not.
//
// That state renders as itself: a row per member, the colour, `·` where an initial would be, and
// ONE calm line above the list. It is not an error, it carries no spinner, and it does not ask
// her to go and get somebody to open a laptop. See `MEMBERS_COPY.waiting`, and D9's
// "Not-negotiable follow-on" in DESIGN-DECISIONS.md.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// FINDING R14 — THE LEGEND DOES NOT FIT EIGHT MEMBERS.  THIS FILE'S ANSWER, MEASURED.
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `app.css:130`: `.legend { display:flex; gap:10px; flex:1; min-width:0; overflow:hidden }`
// inside a 40 px toolbar. It CLIPS; it does not wrap. PLAN.md R14 hands deliverable 16 three
// options — a disclosure popover, a second row at ~22 px of vertical budget, or swatch-only
// categories — and says it is a design decision.
//
// THE DECISION: members render as INITIAL CHIPS, never as names, and the section collapses into
// a disclosure when even those do not fit. Categories keep their names untouched.
//
// THE NUMBERS ARE MEASURED, NOT ESTIMATED. `tests/tier2/family-members.dom.js` §5 renders both
// alternatives into the REAL toolbar in the SAME WebKit the app ships in and prints the widths;
// these are that run's, for the eight-name fixture („Mama", „Papa", „Oma", „Opa", „Lena",
// „Jonas", „Ümit" — seven others plus me, and I am not in the family half, see `sortForLegend`):
//
//     the family section, 8 members, as INITIAL CHIPS       186 px
//     the same 8 members as NAME CHIPS (`.legend-item`)     380 px
//     the family section, 2 members                          66 px
//
// So the family half costs 186 px at the top of the scale instead of 380 — under half — leaving
// the categories the ~200 px they need to keep their names on a 1280-wide window, and it costs
// ZERO PIXELS OF VERTICAL BUDGET, which is the option R14 explicitly prices at 22 px. The test
// asserts the toolbar is still exactly 40 px tall with eight members in it. Density is v1's
// principle 1 and it is the thing being defended.
//
// WHAT IT COSTS, SAID RATHER THAN HIDDEN: the legend no longer NAMES the members. The name is in
// the tooltip, in ⚙ → „Familie", and one click away in the popover the `· n` opener opens.
//
// WHY THAT IS THE RIGHT THING TO GIVE UP, AND NOT MERELY THE CHEAPEST: story 17.2 renders
// another member's entry as their colour plus an INITIAL CHIP — never their name. The legend's
// job for the family half is therefore to teach `colour + initial → person`, and a name chip
// teaches a mapping the board never shows. The chip in the legend is the same object as the chip
// on the board, at the same size. A name there would be a third vocabulary.
//
// THE OVERFLOW, because 223 px is a promise about a window width and not a law: after every
// render `applyOverflow()` measures the real row, and if it still overflows the whole family
// section becomes just the `· 8` opener that is on the row either way. That is R14's disclosure
// option, reached by measurement rather than by a guessed breakpoint, and it is v1's own „+n"
// idiom (2.4) rather than a new one.
//
// THE SECTION HAS NO LABEL, and that is a decision rather than an omission: v1 ships a default
// category called „Familie", so a „Familie" heading here put the same word twice in one 40 px row
// meaning two different things. The alternative was renaming a category that is already in every
// existing user's board. See `renderFamilyLegend`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE MAY NOT DO
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//  · IT MAY NOT SYNC A CATEGORY. A3 is explicit — "Categories are never synced; they remain a
//    private organisational system." Nothing here reads or writes `cat:*`.
//  · IT MAY NOT IMPLY THAT AN ADMIN CAN SEE MORE. Story 20.5: even the admin structurally cannot
//    see another member's private entries, "enforced by encryption, not by policy".
//    `MEMBERS_COPY.adminMeans` is the sentence, and it is next to the badge rather than in a
//    help page.
//  · IT MAY NOT PUT A MEMBER'S VISIBILITY TOGGLE ON THE WIRE. 17.3's toggle is device-local —
//    „so I can hide Papa's entries the same way I hide a category" — and Principle 9 forbids
//    surveillance mechanics in either direction. It is a `pref`, in the `local` space, which
//    `ops.js`'s pref table and `applyRemote`'s F-7 filter already keep off every wire.
//  · IT MAY NOT WRITE `member.set` ITSELF. See `MembersPort` below.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THE COPY IS IN THIS FILE AND NOT IN `i18n.js`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `i18n.js` is in the BOOT GRAPH — `main.js` imports it on every launch, solo or not — and this
// module's copy is thirty-odd strings in two languages that a solo Mac must never pay for.
// Principle 7 ("nothing in solo mode gets heavier because family mode exists") is the argument,
// and the precedent is already the house style: `crypto/backup.js`'s `EXPORT_SHEET_COPY`,
// `crypto/probe.js`'s `unavailableMessage()` and `platform/net.js`'s `insecureOriginMessage()`
// are all `{de, en}` pairs exported from behind the one dynamic door and rendered through the
// same `say()` helper `familysettings.js` uses. Both languages are here, in full, in one place,
// which is the property „every string in both languages" is actually about.

import { el, toast, openSheet } from '../ui.js';
import { getLang } from '../i18n.js';
import { store } from '../store.js';
import { PALETTE, colorOf, paletteName } from '../palette.js';
// `legend.js` is v1's and is in the boot graph. The edge goes THIS way — see `setFamilyLegend`.
import { setFamilyLegend } from '../legend.js';

/** Whichever of a `{de, en}` pair the UI is currently speaking. German is the default (13.7). */
const say = (pair) => (getLang() === 'en' ? pair.en : pair.de);

/**
 * A `.hint` that is SECTION PROSE rather than a field annotation.
 *
 * `app.css:496` gives `.hint` a `margin-left: 178px` so it lines up under the control column of a
 * `.field`. Every sentence in this module explains a LIST or a SECTION, not a control, and at
 * 178 px they render as a narrow right-hand column with the list orphaned beside them. The
 * override is one property and it is the same one `adminpanel.js`'s `hint()` makes, for the same
 * reason and in the same round.
 */
const prose = (text) => {
  const p = el('p', 'hint member-prose', text);
  return p;
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. Copy — German first, English complete
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const MEMBERS_COPY = Object.freeze({
  title: { de: 'Familie', en: 'Family' },
  listHint: {
    de: 'Alle im Kreis. Name und Farbe kommen von der Person selbst.',
    en: 'Everyone in the circle. Name and colour come from the person themselves.',
  },
  empty: {
    de: 'Nur du. Lade jemanden mit einem Code ein.',
    en: 'Only you. Invite someone with a code.',
  },
  you: { de: 'du', en: 'you' },
  admin: { de: 'Verwaltung', en: 'Admin' },

  // 20.5, and the one sentence that keeps the whole panel honest. It sits under the member list,
  // where the „Verwaltung" badge is visible, and not in an About page nobody opens.
  adminMeans: {
    de: 'Die Verwaltung pflegt den Kreis — nicht die Menschen darin. Auch sie sieht private '
      + 'Einträge der anderen nicht: das verhindert die Verschlüsselung, keine Regel.',
    en: 'The admin looks after the circle — not the people in it. Even the admin does not see '
      + 'anyone else’s private entries: the encryption prevents that, not a rule.',
  },

  // ── my own row (15.6) ──────────────────────────────────────────────────────────────────────
  meTitle: { de: 'Mein Name und meine Farbe', en: 'My name and my colour' },
  nameLabel: { de: 'Name', en: 'Name' },
  colorLabel: { de: 'Farbe', en: 'Colour' },
  propagates: {
    de: 'Änderungen erscheinen von selbst auf allen Boards im Kreis. Niemand muss sie freigeben.',
    en: 'Changes appear by themselves on every board in the circle. Nobody has to approve them.',
  },
  nameEmpty: { de: 'Ein Name darf nicht leer sein.', en: 'A name cannot be empty.' },
  colorTakenBy: {
    de: (who) => `Diese Farbe hat schon ${who}.`,
    en: (who) => `${who} already has this colour.`,
  },
  colorTakenAnon: {
    de: 'Diese Farbe hat schon jemand anderes im Kreis.',
    en: 'Someone else in the circle already has this colour.',
  },
  noFreeColor: {
    de: 'Alle zehn Töne sind vergeben. Bitte jemanden, seinen zu wechseln.',
    en: 'All ten tones are taken. Ask somebody to change theirs.',
  },
  saved: { de: 'Gesichert.', en: 'Saved.' },
  saveFailed: {
    de: (why) => `Das hat nicht geklappt: ${why}`,
    en: (why) => `That did not work: ${why}`,
  },
  // The read-only case: `mount.js` has not handed us a write port this launch. Said out loud,
  // because a text field that silently does nothing is worse than a field that is not there.
  readOnly: {
    de: 'Name und Farbe lassen sich hier gerade nicht ändern.',
    en: 'Name and colour cannot be changed here right now.',
  },

  // ── D9's waiting state (ADR 002 §7.1, DESIGN-DECISIONS § D9) ───────────────────────────────
  //
  // Three rules from D9, and every word below is picked against them: never an error, never a
  // spinner, and never „bitte jemanden, seinen Mac aufzuklappen".
  waiting: {
    de: 'Du bist im Kreis. Die Namen und die Einträge der anderen erscheinen von selbst, '
      + 'sobald der nächste Mac aus dem Kreis synchronisiert.',
    en: 'You are in the circle. The others’ names and entries appear by themselves as soon as '
      + 'the next Mac in the circle syncs.',
  },
  waitingNoName: { de: '—', en: '—' },

  // ── the legend half (A3 / 17.3) ────────────────────────────────────────────────────────────
  //
  // NO `legendLabel`, and no key that could become one. The section is a divider, the chips and a
  // `· n` opener — see `renderFamilyLegend` for why „Familie" may not be a heading in a legend that
  // already has a category by that name, and why the CATEGORY is not the half that moves.
  legendHint: {
    de: 'Farbe und Anfangsbuchstabe — genau so stehen die Einträge der anderen auf dem Board.',
    en: 'Colour and initial — exactly how the others’ entries appear on the board.',
  },
  hideMember: {
    de: (who) => `${who} ausblenden`,
    en: (who) => `Hide ${who}`,
  },
  showMember: {
    de: (who) => `${who} wieder einblenden`,
    en: (who) => `Show ${who} again`,
  },
  hiddenSuffix: { de: 'ausgeblendet', en: 'hidden' },
  hiddenIsLocal: {
    de: 'Ausblenden gilt nur auf diesem Mac. Die andere Person erfährt nichts davon.',
    en: 'Hiding applies on this Mac only. The other person is never told.',
  },
  openFamily: { de: 'Familie im Kreis anzeigen', en: 'Show the family circle' },
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. The port — what the flow owner must hand this module
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} MemberRow
 * @property {string} memberId
 * @property {string|null} displayName  null while the ops that carry it are still ciphertext (D9)
 * @property {string|null} colorRef     a `PALETTE` ref; null before anything has been published
 * @property {string} initial           one grapheme, upper-cased; `·` when there is no name yet
 * @property {boolean} alive            `member._alive`; a removed member is kept and marked
 * @property {boolean} isMe
 * @property {boolean} isAdmin
 * @property {boolean} hidden           17.3, device-local
 */

/**
 * @typedef {Object} MembersPort
 * @property {() => string|null} [me]           my MemberId
 * @property {() => string|null} [adminId]      the admin's MemberId, from the `space:` register
 * @property {() => boolean} [keysPending]      D9: I am a member and hold no epoch key yet
 * @property {(profile:{displayName:string, colorRef:string}) => Promise<void>} [setProfile]
 * @property {() => Array<{memberId:string, colorRef:string|null, removedAt:string|null}>} [roster]
 * @property {() => Map} [registers]  the RegisterMap to read members out of. Defaults to
 *           `store.registers()`, which is what the shipped app passes nothing for. It exists so
 *           `tests/tier2/family-members.dom.js` can drive eight members through the REAL legend
 *           in the REAL toolbar without first standing up a family space — the same reason
 *           `sync-status.dom.js` injects a fake engine into `initSyncStatus`.
 *
 * **`setProfile` is a port and not a `store.apply()` call, and that is a report, not a taste.**
 * `core/ops.js`'s `MUTATIONS` table is exactly v1's 22 `store.mutate()` sites; there is no
 * `member.set` mutation, so `store.apply('setMyProfile', …)` would throw `unknown mutation`.
 * Writing 15.6 therefore needs one new entry in `core/ops.js` and one publish path in
 * `family/engine.js` — both owned elsewhere this round. Until that lands this module renders the
 * list, the legend and the toggles from the log (all of which need no new vocabulary, because a
 * peer's `member.set` already arrives through `store.applyRemote`), and the two fields on MY row
 * are disabled with `MEMBERS_COPY.readOnly` under them rather than pretending to save.
 */

/** @type {MembersPort|null} */
let port = null;
/** The legend host. `.legend` in the shipped page; overridable so a test can mount its own. */
let legendSelector = '.legend';
let notifyChange = () => {};

/**
 * Mount the member surfaces over a flow. No arguments unmounts, which is what a teardown wants.
 *
 * @param {{port?:MembersPort|null, legendHost?:string, onChange?:Function, legend?:boolean}} deps
 *        `legend` installs the `legend.js` seam described on `initFamilyLegend`. Off by default
 *        so a test renders exactly once per call and nothing races it.
 */
export function initMembersUI({
  port: p = null, legendHost = '.legend', onChange = null, legend = false,
} = {}) {
  teardownFamilyLegend();
  port = p;
  legendSelector = typeof legendHost === 'string' && legendHost ? legendHost : '.legend';
  notifyChange = typeof onChange === 'function' ? onChange : () => {};
  if (p && legend) initFamilyLegend();
}

/** Present only where a flow has been mounted. In solo mode the whole feature is absent. */
export const membersSupported = () => !!port;

/** Whether MY row can actually be written this launch. See `MembersPort`. */
export const selfEditSupported = () => !!(port && typeof port.setProfile === 'function');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. The reader — RegisterMap → MemberRow[]
// ═════════════════════════════════════════════════════════════════════════════════════════════

const EMPTY_CELLS = new Map();
/** `null` is a CLEARED register and never a value (ADR 001 §5 step 1). */
const carried = (cell) => (cell && cell.value !== null && cell.value !== undefined ? cell.value : null);

/**
 * One grapheme, upper-cased — the chip on the board (17.2) and the chip in the legend.
 *
 * `[...name]` and not `name[0]`: a name beginning with an emoji or an astral character would
 * otherwise put half a surrogate pair in a 16 px circle, which renders as a replacement glyph on
 * every member's board and cannot be diagnosed from the outside.
 *
 * `·` for "no name yet" rather than `?`: D9's pre-wrap list is not a question and must not look
 * like one.
 *
 * @param {string|null|undefined} name @returns {string}
 */
export function initialOf(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  if (!s) return '·';
  return [...s][0].toLocaleUpperCase(getLang() === 'en' ? 'en' : 'de');
}

/**
 * Every member the log knows, as rows.
 *
 * PURE over `(regs, ctx)` so the two surfaces and the tests read the same function. It reads
 * `member:<id>` and nothing else — no `cat:`, no `fnote:`, no `pref:` beyond the hidden set the
 * caller passes in.
 *
 * A member with registers but no `displayName` is KEPT, not skipped: that is exactly D9's joiner
 * seen from an established Mac before her profile op has been folded, and dropping her would
 * make the person who just joined invisible to the circle she just joined.
 *
 * @param {Map<string, Map<string, {value:*, stamp:string}>>} regs a RegisterMap; `store.registers()`
 * @param {{me?:string|null, adminId?:string|null, hidden?:Set<string>,
 *          roster?:Array<{memberId:string, colorRef?:string|null, removedAt?:string|null}>}} [ctx]
 * @returns {MemberRow[]} sorted by memberId — see `sortForLegend` / `sortForList`
 */
export function readMembers(regs, ctx = {}) {
  const me = ctx.me ?? null;
  const adminId = ctx.adminId ?? null;
  const hidden = ctx.hidden instanceof Set ? ctx.hidden : new Set(ctx.hidden || []);
  const rows = new Map();

  for (const key of regs ? regs.keys() : []) {
    if (typeof key !== 'string' || !key.startsWith('member:')) continue;
    const memberId = key.slice('member:'.length);
    if (!memberId) continue;
    const cells = (regs.get(key)) || EMPTY_CELLS;
    const displayName = typeof carried(cells.get('displayName')) === 'string'
      ? String(carried(cells.get('displayName'))).trim() || null
      : null;
    const colorRef = typeof carried(cells.get('colorRef')) === 'string'
      ? String(carried(cells.get('colorRef')))
      : null;
    // `_alive` absent means alive: a member record whose only op so far is `dev.<short>` (the
    // attestation a joining device writes first) is a member, not a tombstone.
    const aliveCell = carried(cells.get('_alive'));
    rows.set(memberId, {
      memberId,
      displayName,
      colorRef,
      initial: initialOf(displayName),
      alive: aliveCell !== false,
      isMe: me !== null && memberId === me,
      isAdmin: adminId !== null && memberId === adminId,
      hidden: hidden.has(memberId),
    });
  }

  // THE ROSTER IS A SECOND OPINION AND ONLY ABOUT COLOUR. It is the one member fact the relay
  // legitimately holds in the clear (`memberProjection`), and it is what makes D9's pre-wrap
  // list render as colours-with-no-names instead of as an empty panel. It may ADD a member the
  // log has not decrypted yet and may FILL an absent colour; it may never overwrite a colour the
  // log states, because the log is what the board renders from (17.2).
  for (const r of ctx.roster || []) {
    const id = r && r.memberId;
    if (typeof id !== 'string' || !id) continue;
    const existing = rows.get(id);
    if (existing) {
      if (!existing.colorRef && typeof r.colorRef === 'string') existing.colorRef = r.colorRef;
      if (r.removedAt) existing.alive = false;
      continue;
    }
    rows.set(id, {
      memberId: id,
      displayName: null,
      colorRef: typeof r.colorRef === 'string' ? r.colorRef : null,
      initial: '·',
      alive: !r.removedAt,
      isMe: me !== null && id === me,
      isAdmin: adminId !== null && id === adminId,
      hidden: hidden.has(id),
    });
  }

  return [...rows.values()].sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));
}

/**
 * The legend's order: BY MEMBER ID, which is the relay's own order and carries no information
 * about who joined when.
 *
 * It is not sorted by name on purpose. A legend is a fixed set of positions the eye learns; if it
 * re-sorted on a rename, every chip would move the moment somebody edited their own name (15.6),
 * on everybody's Mac, for no reason the person watching could see.
 */
export const sortForLegend = (rows) => rows.filter((r) => r.alive && !r.isMe);

/** The settings list: me first, then by name, then by id. A list is read, not scanned. */
export function sortForList(rows) {
  const lang = getLang() === 'en' ? 'en' : 'de';
  return [...rows].sort((a, b) => {
    if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
    if (a.alive !== b.alive) return a.alive ? -1 : 1;
    const an = a.displayName, bn = b.displayName;
    if (an && bn && an !== bn) return an.localeCompare(bn, lang);
    if (!!an !== !!bn) return an ? -1 : 1;
    return a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0;
  });
}

/**
 * The member ids hidden ON THIS MAC (17.3).
 *
 * `settings.hiddenMembers.<memberId>` — `ops.js:673` names the shape, `materialize.js` rebuilds
 * the nesting, and the whole subtree is a `pref` in the `local` space, which `applyRemote`'s F-7
 * filter refuses in both directions. Truthy is hidden; a cleared or `false` register is not.
 *
 * @returns {Set<string>}
 */
export function hiddenMemberIds() {
  const raw = store.state?.settings?.hiddenMembers;
  const out = new Set();
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, v] of Object.entries(raw)) if (v) out.add(id);
  return out;
}

/**
 * Flip one member's visibility on THIS Mac.
 *
 * ABSOLUTE, not a toggle at the op layer — `legend.js`'s own comment on `toggleCategory` (ops.js
 * #17) applies verbatim: the site reads the current value and writes the NEW one, so two devices
 * cannot cancel each other out. Here the register is device-local so convergence is moot, but the
 * shape is kept identical because the two toggles sit next to each other in the same row and a
 * reviewer must not have to ask whether they behave differently.
 *
 * `false` and not `null`: a cleared pref with no default projects as ABSENT (`materialize.js`
 * REG-8), which is the same visible outcome, but `false` keeps the register readable in
 * `board.json` — 11.4 says that file is human-readable, and "Papa is not hidden" is more legible
 * than the absence of a line.
 *
 * @param {string} memberId @returns {boolean} the new hidden state
 */
export function setMemberHidden(memberId, hide) {
  // ⚠ **THE SPREAD IS THE FIX FOR FINDING E6-6, AND IT IS NOT DEFENSIVE STYLE.** `setSettings` is
  // v1's WHOLESALE OBJECT REPLACEMENT — `store-persistence.test.js:757` pins that — so the
  // one-key literal this used to pass REPLACED the whole map. Reproduced: `{A:true}` then
  // `{B:true}` leaves `{"B":true}`. **Hiding a second member un-hid the first**, silently, on the
  // one gesture 17.3 exists for, and the legend and the board agreed with each other about the
  // wrong answer so nothing looked broken.
  //
  // Read fresh on every call rather than held: the sheet is rebuilt between clicks and another
  // surface (the popover's member filter) writes the same map.
  const current = (store.state && store.state.settings && store.state.settings.hiddenMembers) || {};
  store.setSettings({ hiddenMembers: { ...current, [memberId]: !!hide } });
  notifyChange('members');
  return !!hide;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. Colour — the same ten tones as categories, a different namespace
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Addendum §9: "Member colors and category colors draw from the same ~10-tone palette but are
// separate namespaces; no two members share a color". So `PALETTE` is imported and
// `store.state.categories` is NOT consulted: my category „Reisen" being türkis has nothing to do
// with whether Mama may be türkis, and a rule that mixed them would make one person's private
// organisation constrain another person's identity.

/**
 * The refs another member already holds. `except` is my own id on the self-edit path, so keeping
 * my current colour is never reported as a collision with myself.
 *
 * @param {MemberRow[]} rows @param {{except?:string|null}} [opts] @returns {Map<string,MemberRow>}
 */
export function takenColorRefs(rows, { except = null } = {}) {
  const out = new Map();
  for (const r of rows) {
    if (!r.alive) continue;                 // a removed member's tone is free again
    if (except !== null && r.memberId === except) continue;
    if (r.colorRef) out.set(r.colorRef, r);
  }
  return out;
}

/**
 * The first tone nobody in the circle is using — the value the join flow (15.3) should offer as
 * its pre-selection, and the repair this panel offers when my own colour turns out to be taken.
 *
 * Exported for `LZP-602`: the join flow "prevents picking a colour another member already has"
 * (F15 design notes), and it must prevent it with THIS function and not a second copy of the
 * rule, or the two screens will disagree about whether a removed member's tone is free.
 *
 * @param {MemberRow[]} rows @param {{except?:string|null}} [opts]
 * @returns {string|null} null when all ten are taken — which needs nine members and cannot
 *          happen inside the 2–8 scale target, but is a state and not an exception.
 */
export function freeMemberColorRef(rows, opts = {}) {
  const taken = takenColorRefs(rows, opts);
  const free = PALETTE.find((p) => !taken.has(p.ref));
  return free ? free.ref : null;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. The current view — one place the three surfaces agree
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The empty view when nothing is mounted. Solo mode never leaves this. */
const EMPTY_VIEW = Object.freeze({
  supported: false, me: null, adminId: null, keysPending: false, members: Object.freeze([]),
});

/**
 * Everything the surfaces render, computed once. Exported so a test can assert what the module
 * believes without reading the DOM.
 * @returns {{supported:boolean, me:string|null, adminId:string|null, keysPending:boolean,
 *            members:MemberRow[]}}
 */
export function membersUIState() {
  if (!port) return EMPTY_VIEW;
  const me = typeof port.me === 'function' ? port.me() : null;
  const adminId = typeof port.adminId === 'function' ? port.adminId() : null;
  const roster = typeof port.roster === 'function' ? port.roster() : [];
  const regs = typeof port.registers === 'function' ? port.registers() : store.registers();
  const members = readMembers(regs, {
    me, adminId, hidden: hiddenMemberIds(), roster,
  });
  return Object.freeze({
    supported: true,
    me: me ?? null,
    adminId: adminId ?? null,
    keysPending: typeof port.keysPending === 'function' ? port.keysPending() === true : false,
    members,
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6. „Familie" in the settings sheet — 15.4 and 15.6
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * @param {HTMLElement} body the sheet body
 * @param {{rebuild:Function, close:Function}} api the `{rebuild, close}` every section takes
 */
export function buildMembersSection(body, api) {
  ensureCss();
  const view = membersUIState();
  if (!view.supported) return;                 // solo mode: the section does not exist at all

  body.appendChild(el('div', 'section-title', say(MEMBERS_COPY.title)));

  // D9's line goes FIRST and only when it is true, because it is the explanation for what the
  // list below looks like. `sync.contract.js`'s pending register, not an error register: one
  // line, no icon, no retry, nothing that moves.
  if (view.keysPending) {
    const w = prose(say(MEMBERS_COPY.waiting));
    w.classList.add('member-waiting');
    body.appendChild(w);
  }

  const list = el('div', 'member-list');
  const rows = sortForList(view.members);
  for (const r of rows) list.appendChild(memberRow(r, view));
  body.appendChild(list);

  body.appendChild(prose(say(rows.length > 1 ? MEMBERS_COPY.listHint : MEMBERS_COPY.empty)));
  if (view.adminId) body.appendChild(prose(say(MEMBERS_COPY.adminMeans)));

  buildSelfEdit(body, api, view);
}

/** One read-only row: swatch, initial, name, and at most two quiet badges. */
function memberRow(r, view) {
  const row = el('div', 'member-row');
  row.dataset.memberId = r.memberId;
  row.dataset.alive = String(r.alive);
  row.appendChild(chipNode(r, { interactive: false }));

  const name = el('span', 'member-name', r.displayName || say(MEMBERS_COPY.waitingNoName));
  if (!r.displayName) name.classList.add('member-name-pending');
  row.appendChild(name);

  const tags = el('span', 'member-tags');
  if (r.isMe) tags.appendChild(el('span', 'member-tag', say(MEMBERS_COPY.you)));
  if (r.isAdmin) tags.appendChild(el('span', 'member-tag', say(MEMBERS_COPY.admin)));
  if (r.hidden) tags.appendChild(el('span', 'member-tag member-tag-off', say(MEMBERS_COPY.hiddenSuffix)));
  row.appendChild(tags);
  void view;
  return row;
}

/**
 * 15.6 — my own name and colour, and nothing else on this panel is editable.
 *
 * "without admin involvement" is a property of the WRITE PATH, not of this form: the op is
 * `member.set` authored by me about `member:<me>`, which `core/authz.js` admits from the member
 * themselves and from nobody else. There is no approval step to leave out.
 */
function buildSelfEdit(body, api, view) {
  const mine = view.members.find((r) => r.isMe);
  if (!mine) return;

  body.appendChild(el('div', 'section-title', say(MEMBERS_COPY.meTitle)));
  const writable = selfEditSupported();

  const nameRow = el('div', 'field');
  nameRow.appendChild(el('label', null, say(MEMBERS_COPY.nameLabel)));
  const nameCtl = el('div', 'ctl');
  const input = el('input');
  input.type = 'text';
  input.className = 'txt';
  input.value = mine.displayName || '';
  input.maxLength = 40;
  input.spellcheck = false;
  input.disabled = !writable;
  nameCtl.appendChild(input);
  nameRow.appendChild(nameCtl);
  body.appendChild(nameRow);

  const taken = takenColorRefs(view.members, { except: mine.memberId });
  const sws = el('div', 'swatches member-swatches');
  for (const p of PALETTE) {
    const holder = taken.get(p.ref) || null;
    const sw = el('button', 'sw');
    sw.type = 'button';
    sw.style.background = p.hex;
    sw.dataset.ref = p.ref;
    sw.setAttribute('aria-pressed', String(p.ref === mine.colorRef));
    // THE COLLISION IS PREVENTED, NOT REPORTED AFTERWARDS. F15's design note asks the JOIN flow
    // to prevent it; the same rule has to hold here or 15.6 becomes the back door into the state
    // 15.3 refuses. A taken tone is disabled and says whose it is on hover — naming the person
    // rather than saying „vergeben", because „Diese Farbe hat schon Mama" is actionable and
    // „vergeben" is an argument with the software.
    if (holder) {
      sw.disabled = true;
      sw.classList.add('sw-taken');
      sw.title = holder.displayName
        ? say(MEMBERS_COPY.colorTakenBy)(holder.displayName)
        : say(MEMBERS_COPY.colorTakenAnon);
    } else {
      sw.title = paletteName(p.ref, getLang());
    }
    if (!writable) sw.disabled = true;
    sw.addEventListener('click', () => {
      if (p.ref === mine.colorRef) return;             // clicking the active tone is not an edit
      commitProfile(api, { displayName: input.value, colorRef: p.ref }, mine);
    });
    sws.appendChild(sw);
  }
  const colorRow = el('div', 'field');
  colorRow.appendChild(el('label', null, say(MEMBERS_COPY.colorLabel)));
  const colorCtl = el('div', 'ctl');
  colorCtl.appendChild(sws);
  colorRow.appendChild(colorCtl);
  body.appendChild(colorRow);

  if (taken.size >= PALETTE.length) body.appendChild(prose(say(MEMBERS_COPY.noFreeColor)));

  input.addEventListener('change', () => {
    const v = input.value.trim();
    if (!v) { toast(say(MEMBERS_COPY.nameEmpty)); input.value = mine.displayName || ''; return; }
    if (v === (mine.displayName || '')) return;        // no change, no op — v1's decline protocol
    commitProfile(api, { displayName: v, colorRef: mine.colorRef }, mine);
  });

  body.appendChild(prose(say(writable ? MEMBERS_COPY.propagates : MEMBERS_COPY.readOnly)));
}

/** The one write this module makes, and it goes through the port. */
async function commitProfile(api, next, mine) {
  if (!selfEditSupported()) { toast(say(MEMBERS_COPY.readOnly)); return; }
  const displayName = String(next.displayName || '').trim();
  if (!displayName) { toast(say(MEMBERS_COPY.nameEmpty)); return; }
  const colorRef = next.colorRef || mine.colorRef || freeMemberColorRef([mine]);
  try {
    await port.setProfile({ displayName, colorRef });
    toast(say(MEMBERS_COPY.saved));
    notifyChange('members');
    renderFamilyLegend();
    api.rebuild();
  } catch (e) {
    toast(say(MEMBERS_COPY.saveFailed)(String((e && e.message) || e)));
  }
}

/**
 * The popover the legend's „Familie" label opens — the same list, read-only.
 *
 * It is the answer to "whose chip is that?" and it is deliberately NOT the settings panel: this
 * is a glance during work, and putting an editable field under a name you are only trying to read
 * is how a legend click becomes an accidental rename.
 */
export function openFamilyPopover() {
  const view = membersUIState();
  if (!view.supported) return null;
  return openSheet({
    title: say(MEMBERS_COPY.title),
    narrow: true,
    build: (body) => {
      ensureCss();
      if (view.keysPending) {
        const w = prose(say(MEMBERS_COPY.waiting));
        w.classList.add('member-waiting');
        body.appendChild(w);
      }
      const list = el('div', 'member-list');
      for (const r of sortForList(membersUIState().members)) list.appendChild(memberRow(r, view));
      body.appendChild(list);
      body.appendChild(prose(say(MEMBERS_COPY.hiddenIsLocal)));
    },
  });
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7. The legend's „Familie" half — A3 / 17.3, and R14's answer
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The id of the family section inside `.legend`. Stable, so a re-render replaces rather than adds. */
export const FAMILY_LEGEND_ID = 'legend-family';

/**
 * Install the legend half and keep it installed.
 *
 * ── THE SEAM LANDED, AND THE MutationObserver IS GONE ─────────────────────────────────────────
 *
 * `legend.js:renderLegend()` opens with `legendEl.textContent = ''` and rebuilds, so anything
 * this module appends is erased on the next category toggle, the next „bearbeiten", and every
 * `flashCategory`. This module used to answer that with a `MutationObserver` that re-appended
 * when its own node had gone — which worked, and which was a BRIDGE, in its own words: it made
 * the family half arrive one frame late and only ever as a repair.
 *
 * `legend.js` now has `setFamilyLegend(fn)`, the same seam `settings.js` has as
 * `setFamilySections` and with the same inverted direction: `legend.js` is in the boot graph and
 * may not import this module, so this module — which is evaluated only behind `family/mount.js`,
 * the one dynamic door — hands it a callback. `renderLegend()` calls it INSIDE the rebuild, so
 * there is no frame in which the second section is missing.
 *
 * The observer is DELETED rather than kept as a fallback. Two mechanisms that both re-append one
 * node is how it gets appended twice.
 *
 * @param {{host?:string}} [opts]
 */
export function initFamilyLegend({ host } = {}) {
  if (typeof host === 'string' && host) legendSelector = host;
  setFamilyLegend(renderFamilyLegend);
}

/** Take the family half back out of `legend.js`, and off the screen with it. */
function teardownFamilyLegend() {
  setFamilyLegend(null);
  const n = document.getElementById(FAMILY_LEGEND_ID);
  if (n) n.remove();
}

/**
 * Draw (or redraw) the family half of the legend. Idempotent; safe to call on every redraw.
 *
 * @returns {HTMLElement|null} the section, or null when there is nothing to draw
 */
export function renderFamilyLegend() {
  const host = document.querySelector(legendSelector);
  const existing = document.getElementById(FAMILY_LEGEND_ID);
  const view = membersUIState();
  const rows = view.supported ? sortForLegend(view.members) : [];

  // NOTHING TO SAY, NOTHING ON SCREEN. Solo mode, and equally a circle of one — a „Familie"
  // heading over an empty space is the kind of permanent reminder Principle 7 exists to prevent.
  if (!host || rows.length === 0) {
    if (existing) existing.remove();
    return null;
  }
  ensureCss();

  const sec = existing || el('span', 'legend-fam');
  sec.id = FAMILY_LEGEND_ID;
  sec.textContent = '';

  // A3's "two sections" made visible with the toolbar's own divider rather than a second label.
  // A „Meine Kategorien" heading would cost ~85 px of the exact row R14 is about, and the rule
  // plus a named second section already says which half is which.
  sec.appendChild(el('span', 'tb-sep legend-fam-rule'));

  // ── THE „Familie" COLLISION, AND WHY THE LABEL IS THE HALF THAT GOES ────────────────────────
  //
  // v1 SHIPS A DEFAULT CATEGORY CALLED „Familie". With a section label the German legend read
  //
  //     Arbeit · Familie · Reisen · bearbeiten │ Familie ⬤⬤⬤
  //
  // — the same word twice in one 40 px row, meaning two different things (a category of MY
  // entries; the people in the circle), and the second one immediately after a divider that a
  // reader has no reason to trust as a change of subject. It is the worst kind of ambiguity,
  // because both readings are correct somewhere on the row.
  //
  // TWO WAYS OUT WERE ON THE TABLE. Rename the default category, or drop the section label and
  // let the divider carry A3's two sections. **THE LABEL GOES**, and the reason is not
  // aesthetics:
  //
  //   · A CATEGORY IS USER DATA. „Familie" is in every v1 board that has ever been created, in
  //     `cat:*` registers with stamps, and a person has spent a year putting entries in it. An
  //     upgrade that renames it is an upgrade that edits the user's board — a v1 regression, and
  //     one that would arrive silently on somebody who has never heard of a Familienkreis.
  //     Renaming only the DEFAULT for new boards would be worse still: two products, and the
  //     collision still shipped to everyone who upgraded.
  //   · THE DIVIDER ALREADY CARRIES THE SPLIT, and this file already argued that for the FIRST
  //     section eight lines up: no „Meine Kategorien" heading, because the rule says which half
  //     is which for ~85 px less. Spending the argument on one section and not the other was the
  //     inconsistency; A3's "two sections" is one rule, applied twice.
  //   · IT BUYS ~48 px of the exact row finding R14 is about, which pushes the eight-member
  //     measurement further inside its budget rather than nearer to it.
  //
  // WHAT REPLACES IT AS THE POPOVER'S DOOR. The `· n` disclosure `applyOverflow` already builds
  // is promoted from "only when the row overflows" to ALWAYS — a count, not a word, so it can
  // collide with no category anybody has ever named. „whose chip is that?" keeps its one-click
  // answer, the tooltip still says „Familie im Kreis anzeigen" in full (a tooltip is not a legend
  // label and cannot be read as one), and the collapsed case is unchanged: the chips go, the
  // opener stays.
  const chips = el('span', 'legend-fam-chips');
  for (const r of rows) chips.appendChild(chipNode(r, { interactive: true }));
  sec.appendChild(chips);
  sec.appendChild(familyOpener(rows.length));

  if (!existing) host.appendChild(sec);
  else if (sec.parentElement !== host) host.appendChild(sec);
  applyOverflow(host, sec, chips, rows.length);
  return sec;
}

/** The section's one word-free affordance: `· n`, opening the read-only popover. */
function familyOpener(count) {
  const more = el('button', 'legend-fam-more', `· ${count}`);
  more.id = `${FAMILY_LEGEND_ID}-more`;
  more.type = 'button';
  more.title = say(MEMBERS_COPY.openFamily);
  more.setAttribute('aria-label', more.title);
  more.addEventListener('click', () => openFamilyPopover());
  return more;
}

/**
 * One 16 px chip: the member's colour, their initial, and — in the legend — their toggle.
 *
 * The hidden state reuses `legend.js`'s own vocabulary verbatim: transparent fill plus an inset
 * ring in `currentColor` (`app.css:139`). Somebody who has learnt what a hollow category swatch
 * means has already learnt what a hollow member chip means, which is the whole reason 17.3 says
 * "the same way I hide a category".
 */
function chipNode(r, { interactive }) {
  const tag = interactive ? 'button' : 'span';
  const chip = el(tag, 'member-chip', r.initial);
  chip.dataset.memberId = r.memberId;
  chip.dataset.visible = String(!r.hidden);
  const hex = r.colorRef ? colorOf(r.colorRef) : null;
  // No colour yet (D9, pre-wrap, pre-roster) is a NEUTRAL chip and never a guessed tone: putting
  // `PALETTE[0]` here would tell everyone that the new member is blue, and she is not yet
  // anything.
  if (hex) { chip.style.background = hex; chip.style.color = '#fff'; }
  else chip.classList.add('member-chip-unknown');
  if (r.hidden && hex) { chip.style.background = 'transparent'; chip.style.color = hex; }
  if (!r.alive) chip.classList.add('member-chip-gone');

  const who = r.displayName || say(MEMBERS_COPY.waitingNoName);
  if (!interactive) { chip.title = who; return chip; }

  chip.type = 'button';
  chip.setAttribute('aria-pressed', String(!r.hidden));
  chip.title = r.hidden ? say(MEMBERS_COPY.showMember)(who) : say(MEMBERS_COPY.hideMember)(who);
  chip.setAttribute('aria-label', chip.title);
  chip.addEventListener('click', () => {
    // ABSOLUTE, like the category toggle one section over: read the current value, write the new
    // one. Re-render rather than mutate the node in place so the tooltip, the ARIA state and the
    // fill can never drift apart.
    setMemberHidden(r.memberId, !hiddenMemberIds().has(r.memberId));
    renderFamilyLegend();
  });
  return chip;
}

/**
 * R14's disclosure, reached by MEASUREMENT.
 *
 * `.legend` is `overflow:hidden`, so an overflowing row does not report itself anywhere a user
 * can see — it silently loses whatever was last. This asks the layout the one question that
 * matters (`scrollWidth > clientWidth`) and, if the answer is yes, HIDES the chips, leaving the
 * `· n` opener that is on the row either way.
 *
 * A guessed breakpoint would have been wrong for the case that actually produces the overflow:
 * it is not the member count, it is the member count TIMES the length of the category names in
 * whichever language is on, and „Meine Kategorien" is a user-authored list.
 *
 * The measurement runs after the node is in the document, and it is cheap: one forced layout per
 * legend render, on family Macs only.
 */
function applyOverflow(host, sec, chips, count) {
  void count;                                     // the opener carries it now; see `familyOpener`
  sec.classList.remove('legend-fam-collapsed');
  chips.hidden = false;
  if (!host || typeof host.scrollWidth !== 'number') return;
  if (host.scrollWidth <= host.clientWidth) return;

  // The chips go and the `· n` opener stays — which is what it was before, except that the
  // opener no longer has to be BUILT here, so the collapsed and expanded rows can no longer
  // disagree about what it says or what it opens.
  chips.hidden = true;
  sec.classList.add('legend-fam-collapsed');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8. CSS — shipped by the module, like `syncstatus.js`'s
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `src/css/app.css` is loaded by every launch including a solo one, and every rule below is for a
// surface a solo Mac never draws. `syncstatus.js` set the precedent (`SYNC_CSS`) and the argument
// is the same one: this is family mode's chrome, it lives behind the one dynamic door, and it is
// injected once, on mount.

export const MEMBERS_CSS_ID = 'lzp-membersui-css';

export const MEMBERS_CSS = `
/* ── the legend's second section (A3, 17.3, finding R14) ───────────────────── */
.legend-fam { display: inline-flex; align-items: center; gap: 6px; flex: none; }
.legend-fam-rule { margin: 0 2px 0 0; }
.legend-fam-chips { display: inline-flex; align-items: center; gap: 4px; }
/* A class rule that sets display BEATS the UA stylesheet's [hidden] rule, so the collapsed chips
   kept their box and the disclosure sat next to a 140 px hole. Found in the browser and not in
   the DOM test, because node.hidden === true was already true — which is exactly the difference
   between asserting a property and asserting a pixel. */
.legend-fam-chips[hidden] { display: none; }
.legend-fam-more {
  font: 500 11px var(--font); color: var(--ink-3); white-space: nowrap; cursor: pointer;
  background: none; border: 0; padding: 0 2px;
}
.legend-fam-more:hover { color: var(--ink-1); }

/* ── the chip, which is the SAME OBJECT as 17.2's chip on the board ────────── */
.member-chip {
  flex: none; box-sizing: border-box;
  width: 16px; height: 16px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font: 700 9px/1 var(--font); letter-spacing: 0;
  border: 0; padding: 0; background: var(--chip); color: var(--ink-2);
  cursor: default;
}
button.member-chip { cursor: pointer; }
button.member-chip:hover { filter: brightness(1.08); }
/* Hidden reads exactly as a hidden category swatch does (app.css:139): no fill, an inset ring in
   the member's own tone. Learn it once, know it in both halves of the row. */
.member-chip[data-visible="false"] {
  background: transparent !important;
  box-shadow: inset 0 0 0 1.5px currentColor;
  opacity: .75;
}
.member-chip-unknown { background: var(--chip); color: var(--ink-3); box-shadow: inset 0 0 0 1px var(--line-1); }
.member-chip-gone { opacity: .4; }

/* ── the list in ⚙ and in the popover ─────────────────────────────────────── */
.member-list { display: flex; flex-direction: column; gap: 2px; margin: 2px 0 8px; }
.member-row {
  display: flex; align-items: center; gap: 8px; min-height: 24px;
  padding: 2px 4px; border-radius: 5px;
}
.member-row[data-alive="false"] { opacity: .5; }
.member-name { font: 500 12px var(--font); color: var(--ink-1); min-width: 0; flex: 1; }
.member-name-pending { color: var(--ink-3); }
.member-tags { display: inline-flex; gap: 5px; flex: none; }
.member-tag {
  font: 400 10px var(--font); color: var(--ink-3);
  background: var(--chip); border-radius: 3px; padding: 1px 5px; white-space: nowrap;
}
.member-tag-off { background: transparent; box-shadow: inset 0 0 0 1px var(--line-1); }

/* Section prose, not a field annotation — see prose() above and app.css:496. */
.hint.member-prose { margin-left: 0; margin-top: 0; }
/* D9's line. The ink hierarchy's ordinary hint tone — NOT amber, NOT red: a member waiting for a
   wrap is not in an error state, and the one thing this line may never look like is a warning. */
.hint.member-waiting { margin: 0 0 10px; }

.member-swatches .sw.sw-taken { opacity: .25; cursor: not-allowed; }

/* Nothing here moves. A pulsing chip would be a spinner (19.3), and a chip that animated on
   arrival would turn a quiet change from another member into an event (Principle 10). */
@media (prefers-reduced-motion: reduce) {
  .member-chip { transition: none !important; animation: none !important; }
}
`;

function ensureCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(MEMBERS_CSS_ID)) return;
  const s = document.createElement('style');
  s.id = MEMBERS_CSS_ID;
  s.textContent = MEMBERS_CSS;
  document.head.appendChild(s);
}
