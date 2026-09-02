// src/js/family/conflict.js — THE LOST-EDIT NOTICE (deliverable 23 · story 18.5 · LZP-904).
//
// ADR 004 §8 (co-editing, and the notice as "a UI observation of the fold"), §7 (no surveillance
// mechanics), §4.1 (the promotion asymmetry) · ADR 001 §5 step 2, §6 (the total order) ·
// ADR 002 §7.4 (the copy contract) · Principles 9 and 10 · glossary §13.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE STORY, AND THE FOUR THINGS IT ASKS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   18.5 — "If two people edit the same co-editable entry near-simultaneously, the later change
//   wins PER FIELD, attribution updates (17.6), and ONLY the person whose in-flight edit lost
//   sees a quiet inline notice — conflicts at family scale are rare and must be treated as
//   boring."
//
// Requirement by requirement, and where each one actually lives:
//
//   1. PER-FIELD LWW — `core/registers.js`. Not here. This file contains no comparison of two
//      writes, no timestamp arithmetic and no notion of "later"; it asks
//      `registers.js:displacedBy()`, which is the same `≺` and the same promotion rule that drew
//      the board. See that function's header for why a second resolution rule is the failure
//      mode worth engineering against.
//
//   2. ATTRIBUTION UPDATES — `family/sharing.js:attributionLine`, driven by `updatedBy` /
//      `updatedAt`, which `materialize.js` reads off the winning register. It updates because the
//      fold moved, not because anything here told it to. This file must not touch it.
//
//   3. ONLY THE LOSER, AND ONLY IF THEIR EDIT WAS IN FLIGHT — the ledger below, and it is
//      structural rather than a filter (see "WHY A THIRD PARTY CANNOT BE TOLD").
//
//   4. ONE LINE, INLINE, DISMISSES ITSELF — §4 below, and it is the only conflict UI in the
//      product.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE DESIGN TEST: "CONFLICTS AT FAMILY SCALE ARE RARE AND MUST BE TREATED AS BORING"
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// An implementation that is correct and still makes a conflict feel like an EVENT has failed. So
// the whole of the visual design is a list of things this file refuses to build, and each refusal
// is enforced by there being no code for it:
//
//   · no dialog and no modal            — nothing here calls `showModal`, and nothing blocks.
//   · no merge view, no diff, no        — the notice says WHO, and never WHAT. That is ADR 004
//     "changed from … to …"               §7.3's rule for attribution, and a lost edit is not a
//                                         reason to invent a level history the product otherwise
//                                         does not have.
//   · no history pane                   — 8.4's history is elsewhere and is not opened from here.
//   · no badge and no counter           — a badge persists, and a persistent mark makes a rare
//                                         event permanent furniture. This has a 6-second life.
//   · no button, no link, no "undo"     — `pointer-events: none`. It is not clickable, so it
//                                         cannot become a conversation (Principle 10, "the board
//                                         is not a messenger"). It also cannot be MISclicked into
//                                         a drag on the entry underneath it.
//   · no sound, no pulse, no loop       — one 120 ms fade in, one fade out, and
//                                         `prefers-reduced-motion` removes even those.
//   · no row of its own                 — it is `position: fixed` over the board, so it displaces
//                                         nothing. v1 principle 1 is that density is the feature;
//                                         a notice that pushed a day row down would cost the user
//                                         real information to report a rare one.
//   · the word „Konflikt" appears       — the copy is one plain sentence about what happened. The
//     nowhere in the copy                 word names a drama the product does not have.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY A THIRD PARTY CANNOT BE TOLD — and why that is not a filter somebody can forget
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// "A conflict notice on a third party's screen would be a surveillance mechanic" — it would say
// „Mama hat Papas Änderung überschrieben", which is Principle 9 („no surveillance mechanics — in
// EITHER direction") broken in one line, and ADR 004 §7 already forbids the whole family of such
// messages: "there is no op kind for a read receipt, a presence signal, or a visibility-change
// notification … that is how Principle 9 is enforced — by the absence of a mechanism".
//
// The same discipline, here: **the only input to the notice is MY OWN outbox.** The ledger is
// seeded from `store.outbox()` / `store.familyOutbox()`, both of which return exclusively lines
// whose `op.dev === this._device` — ops THIS MAC AUTHORED. A device that did not author a write
// has no ledger row for that cell, therefore `displacedBy()` is never asked about it, therefore
// no notice can be constructed. There is no branch that decides not to show one. There is nothing
// to show.
//
// Two consequences follow, and both are wanted:
//
//   · The winner is told nothing. They wrote, they won, their board is right. Silence is correct.
//   · Neither is a bystander told, including the admin. There is no admin x-ray here either.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FOUR THINGS THE LEDGER REFUSES TO HOLD, AND WHY EACH IS A PRODUCT RULE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//  1. **GOVERNING FIELDS** (`pub.level`, `pub.coEdit`, `pub.alive`, `visibility`, `coEdit`,
//     `_alive`, `_born`). `admits()` reads `ops.js`'s `FIELDS` table — the SAME marks
//     `promoteEntity` reads — and keeps only `coEdit: true` fields. This is what stops an ADMIN
//     UNSHARE (18.3) from being announced as a lost edit: ADR 004 §7 forbids an "X made an entry
//     private" notification outright, and 18.3 is moderation, not a race. It also stops a remote
//     DELETION (18.6, `_alive`/`pub.alive`) from producing a line, because 18.6's answer to a
//     deletion is ⌘Z, not a notice.
//
//  2. **ANYTHING I DID NOT AUTHOR IN THIS SESSION.** At install the current outbox is marked
//     SEEN and recorded NOWHERE — a Mac that quit with unpushed edits and relaunches into a
//     changed world says nothing, because on launch nothing is in flight. "In flight" means "I
//     was here, watching, when I wrote it".
//
//  3. **ANYTHING OLDER THAN 30 SECONDS.** ADR 004 §8 fixes the window: the notice "fires when a
//     field I wrote WITHIN THE LAST 30 s is subsequently overwritten by a remote write with a
//     greater stamp". Past that the edit is not in flight, it is history, and 17.6's attribution
//     line is the right and quieter place to learn that somebody else has been in the entry.
//
//  4. **MY OWN PUBLICATION.** A `pub.set` on `fnote:<me>/<uuid>` is a projection of my truth, not
//     an edit to it (ADR 004 §4.1). Holding one turned an ADMIN UNSHARE into a lost-edit line —
//     the exact notification ADR 004 §7 forbids. Found red by row F1 of the tier-1 suite; the
//     full account is on `admits()` below, which is where the refusal lives.
//
// It is BEST-EFFORT by design and ADR 004 §8 says so: it only fires if my client is running when
// the winning op arrives, and it never fires for the peer whose op arrived second at my machine.
// Stated as a known weakness in ADR 001 §13.1 rather than engineered around — a guaranteed notice
// would need durable per-field intent records, i.e. a second log, to report an event the design
// says is rare.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// SOLO MODE EVALUATES NONE OF THIS
//
// `install()` is called from the circle's mount path only, and every evaluation begins by asking
// for a MemberId. `store.diagnostics().identity.memberId` is this device's member id; with no
// durable identity and no Familienkreis there are no `fnote:`/`fbar:` registers, no co-editable
// foreign entity, and no second author — so even a wired install on a solo Mac produces nothing.
// (Principle 7: nothing in solo mode gets heavier because family mode exists.)
// ═════════════════════════════════════════════════════════════════════════════════════════════

import { getLang } from '../i18n.js';
import { displacedBy } from '../core/registers.js';
import { parseEntityKey, isMemberId, isFamilyKind, FAMILY_OF } from '../core/entities.js';
import { coEditableFields, PERSONAL_PLACEHOLDER } from '../core/ops.js';
import { FORBIDDEN_CLAIMS } from './sharing.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Copy — German-first, English second (13.7)
// ─────────────────────────────────────────────────────────────────────────────

const say = (pair, lang) => ((lang || getLang()) === 'en' ? pair.en : pair.de);

/**
 * Every string this module can put on screen. Exported so the DOM suite can sweep it in BOTH
 * languages against `FORBIDDEN_CLAIMS` and against its own "no drama" list, rather than eyeball
 * the one line that happens to render.
 *
 * THE SENTENCE, TAKEN APART:
 *
 *   „Mama hat das gerade auch geändert — die neuere Änderung gilt."
 *    └─ who ──┘ └── when ─┘ └── what ─┘   └────── the rule, in plain German ──────┘
 *
 *   · WHO, because 17.6's vocabulary is already "von Mama" and a nameless "someone" would make a
 *     rare, harmless event feel anonymous and therefore sinister.
 *   · „auch", because that one word is the entire situation: we both did it. Without it the line
 *     reads as an accusation.
 *   · NEVER WHAT. No field name, no old value, no new value. ADR 004 §7.3's rule for attribution
 *     — "who and when, never what" — is the same rule here, and it is also what keeps the line
 *     from being a diff view in one sentence.
 *   · „die neuere Änderung gilt" states requirement 1 (per-field LWW) in words a parent reads
 *     once and never has to think about again. It does not say "yours was discarded"; it says
 *     which one counts. Same fact, no loss framing, and it is true of the winner too.
 *   · NO CALL TO ACTION. There is nothing to do. Offering one would imply the board expects a
 *     reply, which is Principle 10.
 */
export const TXT = Object.freeze({
  /** `%s` is the member's display name (17.6's own resolution order — see `nameOf`). */
  lost: {
    de: '%s hat das gerade auch geändert — die neuere Änderung gilt.',
    en: '%s changed this too just now — the newer change stands.',
  },
  /** The 17.6 fallback, verbatim from `sharing.js:TXT.someone`, so the two never drift. */
  someone: { de: 'Ein Mitglied', en: 'A member' },
});

/**
 * Words that would turn a rare, boring event into an event. Swept by the DOM suite alongside ADR
 * 002 §7.4's `FORBIDDEN_CLAIMS`, which is imported rather than restated.
 *
 * „Konflikt" / "conflict" is on the list even though it is this file's own name: the ticket may
 * call it a conflict, the user may not be told there was one. „überschrieben" / "overwritten" is
 * on it because it describes the machine's action rather than the family's, and „verloren" /
 * "lost" because nothing was — the other version is on the board and ⌘Z still holds mine.
 */
export const FORBIDDEN_DRAMA = Object.freeze([
  'Konflikt', 'conflict', 'überschrieben', 'overwritten', 'verloren', 'lost', 'Fehler', 'error',
]);

/** The one line, in the current language. @param {string} who @param {string} [lang] */
export const lostLine = (who, lang) => say(TXT.lost, lang).replace('%s', who);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The pure model — no DOM, no store, exhaustively testable
// ─────────────────────────────────────────────────────────────────────────────

/** ADR 004 §8, verbatim: "a field I wrote within the last 30 s". */
export const IN_FLIGHT_MS = 30_000;

/** How long the line stays. Long enough to read twice; short enough not to become furniture. */
export const NOTICE_MS = 6_000;

/**
 * May a write to `(entityKey, field)` enter the ledger at all?
 *
 * ONE TABLE, NOT TWO. The answer is `ops.js`'s `coEdit` mark on the field — the same mark
 * `authz.js` stage 3b admits a co-editor's op by and `registers.js:promoteEntity` promotes by. A
 * list of field names here would be a second table, and the day somebody adds a co-editable field
 * this file would silently stop reporting it while the fold happily raced on it.
 *
 * Both namespaces are accepted and are translated to ONE question, because the same human race
 * produces different keys depending on which side of it you are standing on (ADR 004 §1):
 *
 *   · I OWN the entry     → my write is `note:<uuid>` / `text` in the personal space
 *   · I am a CO-EDITOR    → my write is `fnote:<owner>/<uuid>` / `pub.text` in the family space
 *
 * `pub.` is stripped and the truth kind's table is consulted, so `pub.text` is admitted exactly
 * when `text` is. Governing fields (`pub.level`, `pub.coEdit`, `pub.alive`, `_alive`, `_born`,
 * `visibility`, `coEdit`) fail on both sides — see the header, refusal 1.
 *
 * ═══ MY OWN PUBLICATION IS NOT AN EDIT — the promotion asymmetry, restated at the ledger ═══════
 *
 * A family key whose OWNER IS ME (`fnote:<me>/<uuid>`) is refused outright, and this is the
 * fourth thing the ledger will not hold. `registers.js:promoteRegister` puts it best and the
 * sentence is required verbatim in that source: my `pub.*` writes "are projections *of* the
 * truth, not edits *to* it". The truth row (`note:<uuid>` / `text`) is my edit, it is already in
 * the ledger, and §B3 of the tier-1 suite shows it reports the owner's loss correctly through
 * promotion. The publication row adds nothing — and it is not harmless:
 *
 *   ⚠ FOUND BY ROW F1 OF `tests/tier1/conflict.test.js`, WHICH WENT RED THE FIRST TIME IT RAN.
 *     An ADMIN UNSHARE (18.3) writes `pub.text: null` into MY publication at a newer stamp.
 *     `registers.js:withdrawnByOther` keeps that null off my truth, so my board stays right and
 *     the truth row reports nothing — but the publication CELL was genuinely displaced, by the
 *     admin, and a ledger row on it turned 18.3 into „Papa hat das gerade auch geändert."
 *     That is precisely the "X made an entry private" notification ADR 004 §7 forbids by name,
 *     and Principle 9 in one line. The refusal below is what makes it unconstructible.
 *
 * The corollary is the useful half: the ONLY family-key rows the ledger can hold are on entities
 * somebody else owns — i.e. genuine co-editor writes, which is exactly what 18.5 is about.
 *
 * @param {string} entityKey
 * @param {string} field
 * @param {string} [me] MemberId. Optional only so the predicate stays callable as a pure field
 *        test; WITHOUT it every family key is refused, because "is this my own publication?" is
 *        unanswerable and the safe answer to an unanswerable question here is silence.
 * @returns {boolean}
 */
export function admits(entityKey, field, me) {
  const parsed = parseEntityKey(entityKey);
  if (!parsed || typeof field !== 'string') return false;
  if (isFamilyKind(parsed.kind)) {
    if (!isMemberId(me) || parsed.owner === me) return false;   // ← see the block above
    if (!field.startsWith('pub.')) return false;
    const truthKind = Object.keys(FAMILY_OF).find((k) => FAMILY_OF[k] === parsed.kind);
    return !!truthKind && coEditableFields(truthKind).includes(field.slice(4));
  }
  if (!FAMILY_OF[parsed.kind]) return false;          // cat / pad / pref: nothing is ever shared
  return coEditableFields(parsed.kind).includes(field);
}

/**
 * @typedef {Object} InFlight
 * @property {string} entity  the entity key the op named
 * @property {string} uuid    the entity's uuid — the SAME for `note:<u>` and `fnote:<m>/<u>`, and
 *                            therefore what one entry's several lost fields group by
 * @property {string} field   the field name the op wrote
 * @property {string} stamp   `op.ts`
 * @property {string|null} op `op.id`
 * @property {any}   value    what I wrote — `cmpWrites`' third key, carried so the comparison
 *                            here is bit-for-bit the comparison the fold made
 * @property {number} at      WALL-CLOCK ms when this device noticed the write. Not `msOf(stamp)`:
 *                            a stamp can be up to 24 h ahead of the local clock (`ops.js`'s
 *                            future clamp) and "in flight" is a fact about THIS session, not
 *                            about the sender's clock.
 */

/**
 * The in-flight ledger. Small, ordinary, and the only state this module keeps.
 *
 * `seen` is an id set and never shrinks below the ledger, which is what makes `record()`
 * idempotent: `harvest()` runs on EVERY store emit and re-reads an outbox that still holds the
 * same lines, so without it one edit would enter the ledger a dozen times and, worse, have its
 * `at` refreshed each time — an edit that never expired.
 *
 * @param {{now?: () => number, me?: () => string|null}} [ports]
 *        `me` is a GETTER, not a value: a Mac can join a Familienkreis in the middle of a session
 *        (`family/createjoin.js`), and a ledger holding a member id from before the join would
 *        refuse every family row for the rest of the launch.
 */
export function createLedger(ports = {}) {
  const now = typeof ports.now === 'function' ? ports.now : () => Date.now();
  const meOf = typeof ports.me === 'function' ? ports.me : () => null;
  /** @type {Map<string, InFlight>} */
  const rows = new Map();
  const seen = new Set();

  const keyOf = (entity, field) => `${entity} ${field}`;

  return {
    /**
     * Mark an op id as already known WITHOUT recording it. This is how `install()` neutralises the
     * outbox it inherits (header, refusal 2) and how a reported loss is retired.
     */
    ignore(opId) { if (typeof opId === 'string' && opId !== '') seen.add(opId); },

    /**
     * Record one op's admissible fields. Returns how many rows it added.
     * A second write to the same cell REPLACES the row — a person who types, pauses and types
     * again has one in-flight edit, not two, and the newer one is the one a peer can lose to.
     */
    record(op) {
      if (!op || typeof op !== 'object') return 0;
      if (typeof op.id !== 'string' || seen.has(op.id)) return 0;
      seen.add(op.id);
      const parsed = parseEntityKey(op.e);
      if (!parsed || !op.f || typeof op.f !== 'object') return 0;
      const at = now();
      const me = meOf();
      let n = 0;
      for (const field of Object.keys(op.f)) {
        if (!admits(op.e, field, me)) continue;
        rows.set(keyOf(op.e, field), Object.freeze({
          entity: op.e, uuid: parsed.id, field, stamp: op.ts, op: op.id, value: op.f[field], at,
        }));
        n += 1;
      }
      return n;
    },

    /** Drop everything older than `IN_FLIGHT_MS`. @returns {number} rows dropped */
    prune() {
      const cutoff = now() - IN_FLIGHT_MS;
      let n = 0;
      for (const [k, r] of rows) if (r.at <= cutoff) { rows.delete(k); n += 1; }
      return n;
    },

    /** Retire the rows a notice has already accounted for, so it can never fire twice. */
    retire(list) { for (const r of list || []) rows.delete(keyOf(r.entity, r.field)); },

    /** @returns {InFlight[]} newest first */
    entries() { return [...rows.values()].sort((a, b) => b.at - a.at); },
    size() { return rows.size; },
    clear() { rows.clear(); seen.clear(); },
  };
}

/**
 * @typedef {Object} LostEdit
 * @property {string} uuid   the entity whose edit lost
 * @property {string} by     the MEMBER who now holds the field(s)
 * @property {InFlight[]} rows  every in-flight row of that entity that lost — retired together
 */

/**
 * Read the fold and answer: which of my in-flight writes is no longer standing?
 *
 * **The arithmetic is entirely `registers.js:displacedBy`.** This function decides only two
 * things, and both are product decisions rather than merge decisions:
 *
 *   · **ONE ENTRY, ONE LINE.** A drag writes `startDate` and `endDate`; a downgrade-then-retype
 *     writes several fields. Losing three fields of one bar is ONE thing that happened, and 18.5
 *     asks for one line. So rows are grouped by `uuid` — the segment `note:<u>` and
 *     `fnote:<m>/<u>` share — rather than by entity key, which would split one entry in two the
 *     moment the two namespaces both had something to say about it.
 *
 *   · **AT MOST ONE ENTRY IS REPORTED**, the one I touched most recently. Two entries losing at
 *     once is a scenario the design does not have (18.5's "near-simultaneously" is about one
 *     entry), and answering it with two lines would be the first step towards a notification
 *     stack. The other entry's rows are still retired, so it is silent, not pending.
 *
 * @param {Map} regs   the store's register map — THE AUTHORIZED FOLD (`store.registers()`)
 * @param {InFlight[]} inFlight
 * @param {string} me  MemberId
 * @returns {{report: LostEdit|null, retire: InFlight[]}}
 */
export function readLosses(regs, inFlight, me) {
  if (!isMemberId(me)) return { report: null, retire: [] };
  /** @type {Map<string, {uuid:string, by:string, stamp:string, rows:InFlight[], at:number}>} */
  const groups = new Map();
  const retire = [];
  for (const row of inFlight) {
    let d = null;
    try { d = displacedBy(regs, row.entity, row.field, row, me); }
    catch { d = null; }                     // a row whose entity key the fold cannot parse is not
    if (d === null) continue;               // a conflict; it is a bug, and it is not this line's.
    retire.push(row);
    const g = groups.get(row.uuid);
    if (g === undefined) {
      groups.set(row.uuid, { uuid: row.uuid, by: d.by, stamp: d.stamp, rows: [row], at: row.at });
      continue;
    }
    g.rows.push(row);
    g.at = Math.max(g.at, row.at);
    // Several fields can be lost to several people at once. The line names the author of the
    // NEWEST winning write — the same "later wins" the sentence itself states.
    if (d.stamp > g.stamp) { g.by = d.by; g.stamp = d.stamp; }
  }
  if (groups.size === 0) return { report: null, retire };
  let best = null;
  for (const g of groups.values()) if (best === null || g.at > best.at) best = g;
  return { report: { uuid: best.uuid, by: best.by, rows: best.rows }, retire };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The line — one element, and nothing else this file can draw
// ─────────────────────────────────────────────────────────────────────────────

export const CONFLICT_CSS_ID = 'lzp-conflict-css';

const CONFLICT_CSS = `
/* Deliverable 23. ONE line. It is fixed over the board, so it displaces no row: v1 principle 1
   is that density is the feature, and a rare event may not cost the user a day row. */
.lzp-conflict {
  position: fixed; z-index: 60; max-width: 300px;
  padding: 3px 7px; border-radius: 3px;
  background: var(--surface); box-shadow: 0 1px 4px rgba(32, 18, 51, .14), inset 0 0 0 1px var(--line-1);
  font: 400 9.5px var(--font); color: var(--ink-2); line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  /* NOT CLICKABLE, ON PURPOSE. Principle 10 — the board is not a messenger, so the notice may
     not become a conversation; and a target floating over a bar would swallow a drag. */
  pointer-events: none;
  animation: lzp-conflict-in 120ms ease-out;
}
.lzp-conflict.is-going { opacity: 0; transition: opacity 320ms ease-in; }
@keyframes lzp-conflict-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .lzp-conflict { animation: none !important; }
  .lzp-conflict.is-going { transition: none !important; }
}
`;

/** Idempotent. One `<style>`, injected on first use, never rebuilt. */
export function ensureConflictCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(CONFLICT_CSS_ID)) return;
  const s = document.createElement('style');
  s.id = CONFLICT_CSS_ID;
  s.textContent = CONFLICT_CSS;
  document.head.appendChild(s);
}

/**
 * 17.6's own name-resolution order, so the notice and the attribution line call the same person
 * the same thing: the roster's display name, else the fallback („Ein Mitglied" / "A member").
 * There is no initial fallback here — an initial is a chip on the board, not a subject of a
 * sentence.
 * @param {string} memberId @param {(id:string)=>string|null} [port] @param {string} [lang]
 */
export function nameOf(memberId, port, lang) {
  const n = typeof port === 'function' && memberId ? port(memberId) : null;
  return typeof n === 'string' && n.trim() ? n.trim() : say(TXT.someone, lang);
}

/**
 * Build the line. Returned rather than mounted, so the element is testable on its own and so
 * there is exactly one implementation of it no matter who ends up placing it.
 * @param {{by: string, nameOf?: (id:string)=>string|null, lang?: string}} opts
 * @returns {HTMLElement}
 */
export function conflictLine(opts) {
  ensureConflictCss();
  const n = document.createElement('div');
  n.className = 'lzp-conflict';
  // `status` + `polite`: announced once, after whatever the user is doing, and never interrupting.
  // `alert`/`assertive` would be a screen-reader popup, which is the modal this design refuses.
  n.setAttribute('role', 'status');
  n.setAttribute('aria-live', 'polite');
  n.textContent = lostLine(nameOf(opts.by, opts.nameOf, opts.lang), opts.lang);
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Placing it — anchored to the entry, or not shown at all
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The entry's node on the board, or null.
 *
 * TWO IDS ARE TRIED because `materialize.js` gives an entry a different `id` depending on whose
 * it is: my own entries carry the bare uuid, a foreign one carries the whole entity key
 * (`fnote:<owner>/<uuid>` — `materialize.js:foreignCandidate`). A co-editable bar is exactly the
 * case where I can be on either side of that, so both are asked for.
 *
 * A bar's LABEL is preferred over its lane rectangle: the label is where the text I just typed
 * is, it is where the user's eye already is, and the lane is 6 px wide.
 */
export function anchorFor(uuid, entityKey, root) {
  const doc = root || (typeof document !== 'undefined' ? document : null);
  if (!doc) return null;
  const ids = [uuid, entityKey].filter((v) => typeof v === 'string' && v !== '');
  for (const id of ids) {
    const q = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(id) : id.replace(/"/g, '\\"');
    const hit = doc.querySelector(`#board .bar-label[data-bar-id="${q}"]`)
      || doc.querySelector(`#board [data-bar-id="${q}"]`)
      || doc.querySelector(`#board [data-note-id="${q}"]`);
    if (hit) return hit;
  }
  return null;
}

/**
 * ═══ WHY "NO ANCHOR" MEANS "NO NOTICE", AND THAT IS THE DESIGN RATHER THAN A SHORTCUT ═══
 *
 * The deliverable is an INLINE notice. Inline to what? To the entry — that is the whole of
 * "inline" in a product with no notification area. If the entry is not on screen (scrolled out of
 * the twelve visible months, hidden behind a member toggle, or gone because the winning op also
 * deleted it), a line with nothing to point at is not an inline notice; it is a banner, and a
 * banner is the "event" this design exists to refuse.
 *
 * The cost is bounded and small: the loser wrote to this entry within the last 30 seconds, so it
 * was on their screen 30 seconds ago. ADR 004 §8 already calls the notice best-effort, and this is
 * one more edge of the same best effort — stated here so nobody later "fixes" it into a toast.
 */
export function placeNotice(node, anchor) {
  const r = anchor.getBoundingClientRect();
  // THE BOUNDS ARE THE BOARD'S VIEWPORT, WITH THE WINDOW AS THE FALLBACK — and the fallback is
  // not defensive padding. `.board-wrap` is `flex: 1; min-height: 0`, so in any context where the
  // page has not been given a height it measures 0 × 0: a hidden or unrendered tab, a headless
  // capture, the moment before first layout. Measured in a real browser whose pane was not on
  // screen — the anchor had a perfectly good rect and the wrap had none, so every notice was
  // refused as "scrolled out of view". A degenerate wrap means "the board's viewport is not a
  // usable answer", and the window is.
  const wrap = document.getElementById('board-wrap');
  const wr = wrap ? wrap.getBoundingClientRect() : null;
  const usable = wr && wr.width > 0 && wr.height > 0;
  const w = usable ? wr : {
    left: 0, top: 0,
    right: document.documentElement.clientWidth || window.innerWidth || 0,
    bottom: document.documentElement.clientHeight || window.innerHeight || 0,
  };
  if (r.bottom < w.top || r.top > w.bottom || r.right < w.left || r.left > w.right) return false;
  node.style.visibility = 'hidden';
  node.style.left = '0px';
  node.style.top = '0px';
  const nw = node.offsetWidth || 0;
  const nh = node.offsetHeight || 0;
  // Under the entry by default; above it when there is no room below, so the line never leaves
  // the board area and never covers the entry it is about.
  const below = r.bottom + 3;
  const top = (below + nh <= w.bottom) ? below : Math.max(w.top, r.top - nh - 3);
  const left = Math.min(Math.max(r.left, w.left + 2), Math.max(w.left + 2, w.right - nw - 2));
  node.style.left = `${Math.round(left)}px`;
  node.style.top = `${Math.round(top)}px`;
  node.style.visibility = '';
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The install — the ONE wiring call, and everything it deliberately does not need
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Watch the store, and show at most one line when one of my in-flight edits stops standing.
 *
 * It needs NO new store API. Four public methods and nothing else:
 *   · `subscribe(fn)`      — v1's own listener seam; `fn(state, reason)` runs after every emit.
 *   · `outbox({space})` /
 *     `familyOutbox()`     — MY ops, both spaces. Their `op.dev === this._device` filter is what
 *                            makes "only the loser" structural (see the header). The `space`
 *                            argument is not optional here — see `myOutboxes` below.
 *   · `personalSpaceId()`  — which pile the personal half is in.
 *   · `registers()`        — the AUTHORIZED fold. `applyRemote` gates every arrival through
 *                            `foldAuthorized` before a line reaches the log, so a hostile peer's
 *                            op is not in here to displace anything.
 *
 * `me` defaults to `store.diagnostics().identity.memberId`. It is read through `diagnostics()`
 * rather than by importing `family/engine.js`, because a UI module pulling the sync engine into
 * its import graph is exactly what ADR 005 §2 and Principle 7 keep out of the solo board.
 *
 * @param {Object} opts
 * @param {Object} opts.store
 * @param {(id:string)=>string|null} [opts.nameOf]  the roster port (17.6's, same as `sharing.js`)
 * @param {() => string|null} [opts.me]
 * @param {() => number} [opts.now]
 * @param {(fn:Function, ms:number) => any} [opts.schedule]
 * @param {(h:any) => void} [opts.unschedule]
 * @returns {{stop:Function, ledger:Object, evaluate:Function, current:Function}}
 */
export function installConflictNotice(opts) {
  const { store } = opts;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const schedule = typeof opts.schedule === 'function' ? opts.schedule : ((f, ms) => setTimeout(f, ms));
  const unschedule = typeof opts.unschedule === 'function' ? opts.unschedule : ((h) => clearTimeout(h));
  const meOf = typeof opts.me === 'function' ? opts.me : () => {
    try { return store.diagnostics().identity.memberId; } catch { return null; }
  };
  const ledger = createLedger({ now, me: meOf });

  let node = null;
  let timer = null;
  let going = null;
  let reposition = null;
  let offRedraw = null;

  const dismiss = () => {
    if (timer !== null) { unschedule(timer); timer = null; }
    if (going !== null) { unschedule(going); going = null; }
    if (reposition) {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      reposition = null;
    }
    if (offRedraw) { offRedraw(); offRedraw = null; }
    if (node && node.parentNode) node.parentNode.removeChild(node);
    node = null;
  };

  /**
   * MY OWN OPS, BOTH SPACES — and the personal half needs the placeholder, which is the whole of
   * this comment.
   *
   * ⚠ `store.outbox()` with no argument reads `this._personalSpaceId`, and returns `[]` the
   * moment that is `null`. **A Mac that joined a Familienkreis but never opted into 19.4
   * own-device sync has no personal space id** — that is Mama's Mac, the modal v2 install — so
   * the bare call finds NOTHING and the OWNER's half of 18.5 goes silent on exactly the
   * configuration the story is written for. Her `note.set` ops are in the log all the same,
   * carrying `space: 'personal'`, the placeholder `ops.js` stamps on a personal op before a real
   * `psp_…` is adopted (`PERSONAL_PLACEHOLDER`, `spaceFor`). Measured in the WebKit harness, not
   * reasoned about: `store.outbox()` → 0, `store.outbox({space: 'personal'})` → 1, for one note
   * created on a circle-only Mac.
   *
   * `personalSpaceId() ?? PERSONAL_PLACEHOLDER` therefore reads the right pile on both kinds of
   * Mac, and the constant is imported rather than spelled, so a future rename moves this with it.
   */
  const myOutboxes = () => {
    const out = [];
    try {
      const sp = (typeof store.personalSpaceId === 'function' ? store.personalSpaceId() : null)
        ?? PERSONAL_PLACEHOLDER;
      out.push(...store.outbox({ space: sp }));
    } catch { /* a store with no log yet has no ops to offer; that is not an error */ }
    try {
      if (typeof store.familyOutbox === 'function') out.push(...store.familyOutbox());
    } catch { /* same */ }
    return out;
  };

  const harvest = () => {
    for (const line of myOutboxes()) ledger.record(line.op);
    ledger.prune();
  };

  /** Read the fold and, if one of my writes lost, show the one line. @returns {LostEdit|null} */
  const evaluate = () => {
    const me = meOf();
    if (!isMemberId(me)) return null;
    ledger.prune();
    const { report, retire } = readLosses(store.registers(), ledger.entries(), me);
    // RETIRED EVEN WHEN NOTHING IS SHOWN. A row that lost has lost; leaving it in the ledger
    // would re-report the same race on every subsequent emit for the rest of its 30 seconds.
    ledger.retire(retire);
    if (report === null) return null;
    const entity = report.rows[0].entity;
    if (!anchorFor(report.uuid, entity)) return null;           // see `placeNotice`'s header
    dismiss();
    node = conflictLine({ by: report.by, nameOf: opts.nameOf });
    document.body.appendChild(node);
    // THE ANCHOR IS RE-RESOLVED, NEVER CACHED. `board.js` rebuilds the whole DOM on every emit
    // (v1's own design, `board.js:26`), so a node captured now is detached by the next sync tick
    // — and a detached node's rect is all zeros, which would read as "scrolled away" and dismiss
    // the notice for an unrelated redraw. Looking it up again costs one `querySelector` per
    // scroll frame of a line that lives six seconds.
    const put = () => {
      const a = anchorFor(report.uuid, entity);
      return !!a && placeNotice(node, a);
    };
    if (!put()) { dismiss(); return null; }
    reposition = () => { if (node && !put()) dismiss(); };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    // The board redrew under us — reposition, or let go if the entry has gone.
    offRedraw = store.subscribe(() => { if (node) reposition(); });
    // "Dismisses itself" — 18.5's design note, and the only exit there is.
    timer = schedule(() => {
      timer = null;
      if (!node) return;
      node.classList.add('is-going');
      going = schedule(dismiss, 340);
    }, NOTICE_MS);
    return report;
  };

  // The inherited outbox is marked SEEN and recorded nowhere — header, refusal 2.
  for (const line of myOutboxes()) ledger.ignore(line.op && line.op.id);

  const off = store.subscribe((_state, reason) => {
    harvest();
    // `'remote'` is the only emit that can have moved a cell out from under me: it is the one
    // `applyRemote` fires after folding an arrival. Evaluating on my own emits would be asking
    // whether I displaced myself, which refusal 2 of `displacedBy` already answers.
    if (reason === 'remote') evaluate();
  });

  return {
    stop() { off(); dismiss(); ledger.clear(); },
    ledger,
    evaluate,
    current: () => node,
  };
}

/** Re-exported so a single sweep in the DOM suite covers both contracts. */
export { FORBIDDEN_CLAIMS };
