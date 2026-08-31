// src/js/family/sharing.js — THE SHARING CLUSTER (deliverable 18 · A7 · LZP-702).
//
// Stories 16.2, 16.3, 16.5, 16.6, 16.7 · 17.6 · 18.1, 18.2 · A4, A7 · glossary §13.
// ADR 004 §2 (the projection), §5 (transitions), §6 (the exposure badge), §7 (no surveillance
// mechanics), §8 (co-editing) · ADR 002 §7.4 (the copy contract) · ADR 001 §3.1 (the register
// split).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The addendum calls the three-state control "the emotional core of v2". It is also the one
// control in the product a user reaches for when they are worried. So the whole design here is
// organised around ONE property, and it is not a visual one:
//
//   ⚠ THIS FILE NEVER BUILDS A FAMILY PATCH. It writes exactly one thing — the entity's own
//     `visibility` / `coEdit` TRUTH registers, in the PERSONAL space, through `store.txn`.
//     Everything that leaves the device is built by `core/project.js:projectForFamily` from
//     those registers, on the store's publish path, and there is no second path. A UI module
//     that assembled `pub.*` fields would be a second projection — the exact thing ADR 004 §2's
//     "single choke point" exists to make impossible — and it would have to be branded to be
//     sealable, which means forging `Symbol.for('lzp/v2/family-patch')`. Nothing here does.
//
//     The test that guards it is not a grep: `tests/tier2/sharing-control.dom.js` §4 drives the
//     real control against the real store and asserts on the EMITTED OPS — every op the cluster
//     can produce is a `note.set`/`bar.set` in the personal space whose field patch is a subset
//     of `{visibility, coEdit}`. ADR 004's headline invariant is asserted on emitted ops and
//     sealed bytes, never on the rendering, and this is that assertion at this seam.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// FIVE DECISIONS THAT ARE NOT COSMETIC
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//  1. ROW ECONOMICS (v1 principle 1: density is the feature; rows are ~22 px). The cluster costs
//     ZERO rows in its resting state: the trigger is one glyph in the popover row's existing
//     `.act` slot, beside `↻` and `✕`. The strip is a DISCLOSURE inserted `afterend` of the row —
//     `toggleSwatches`' exact precedent (ADR 004 §4.3 names it) — so the popover is the same
//     height it was until somebody asks about sharing, and only ever for ONE entry at a time.
//     Two clicks from a closed popover row to a changed level, which is 16.3's budget exactly.
//
//  2. HUE IS NEVER THE ONLY CHANNEL (`palette.js`'s own rule). The three states differ in
//     SILHOUETTE first — a closed padlock, an open padlock with a half-filled body, two people
//     and no lock at all — in the ink ramp second (`--ink-3` → `--ink-2` → `--ink-1`: more ink,
//     more eyes), and in the WORD third, because the segmented control is labelled. Take the
//     colour away and the control still reads; take the shape away and it still reads.
//
//  3. THE COPY IS A CONTRACT, NOT A DRAFT. ADR 002 §7.4 fixes two strings this file must render
//     verbatim (the downgrade sentence and the Belegt tooltip) and four phrases it may never
//     render at all. They live in `TXT` below as `downgradeNote` / `belegtWhat` and in
//     `FORBIDDEN_CLAIMS`, and the DOM suite sweeps every string this module can produce for the
//     forbidden four. Retraction is client-cooperative (ADR 004 §5.3, §11.2); a UI that said
//     „zurückgezogen" would be making a promise the cryptography cannot keep.
//
//  4. THE EXPOSURE THE CONTROL TALKS ABOUT IS WHAT REACHED THE LOG, NOT WHAT I INTENDED
//     (ADR 004 §6). `exposedLevel()` below takes the HIGHER of the acked level and the folded
//     `pub.level`, so both of its error directions point the same way: it may warn about a
//     downgrade that was not needed, and it can never stay quiet about one that was.
//
//  5. `coEdit` EXISTS ONLY AT GETEILT (ADR 004 §8), AND THAT IS MADE STRUCTURAL HERE RATHER THAN
//     REMEMBERED. Leaving Geteilt writes `coEdit: false` to the TRUTH register in the same
//     transaction as the level. See `planVisibilityChange` for why, and for the ADR
//     disagreement it resolves.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// SOLO MODE EVALUATES NONE OF THIS, STRUCTURALLY
//
// `store._project()` runs `stripV2Fields` while `familySpaceId === null`, and `visibility` is not
// in `V1_ENTRY_FIELDS` — so on a solo board an entry HAS NO `visibility` FIELD AT ALL.
// `sharingApplies()` is that absence, read as an answer. It is not a flag anybody sets and there
// is no way to get the cluster onto a board with no Familienkreis, including by mistake: there is
// nothing for it to render. (16.1 — private by default costs zero bytes AND zero pixels.)
// ═════════════════════════════════════════════════════════════════════════════════════════════

import { getLang } from '../i18n.js';
import { VISIBILITY_LEVELS } from '../core/entities.js';
import { isStamp, msOf } from '../core/stamp.js';
import { WD_DE, WD_EN } from '../dates.js';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Copy — German-first, English second (13.7), glossary §13 terms verbatim
// ─────────────────────────────────────────────────────────────────────────────

const say = (pair) => (getLang() === 'en' ? pair.en : pair.de);

/**
 * Every string this module can put on screen. Exported so `tests/tier2/sharing-control.dom.js`
 * can walk it — both languages — rather than eyeball the three states it happens to render.
 *
 * The glossary terms are FIXED (addendum §13): Privat / Belegt / Geteilt · „Sichtbarkeit" ·
 * „Familie darf bearbeiten". They are not paraphrased anywhere below.
 */
export const TXT = Object.freeze({
  visibility: { de: 'Sichtbarkeit', en: 'Visibility' },

  privat: { de: 'Privat', en: 'Private' },
  belegt: { de: 'Belegt', en: 'Busy' },
  geteilt: { de: 'Geteilt', en: 'Shared' },

  // What each level actually discloses, in the second person, present tense. 16.7's whole point
  // is that "I'm away, don't plan with me" must work WITHOUT explanation — so the explanation is
  // one line, and it is about what OTHERS see, never about what the app does.
  privatWhat: {
    de: 'Nur du siehst diesen Eintrag.',
    en: 'Only you can see this entry.',
  },
  // ⚠ ADR 002 §7.4 REQUIRED STRING — "Belegt tooltip on the owner's own board", verbatim.
  belegtWhat: {
    de: 'Andere sehen: Datum, deinen Namen, deine Farbe — keinen Text.',
    en: 'Others see: the date, your name, your colour — no text.',
  },
  geteiltWhat: {
    de: 'Andere sehen den Eintrag ganz — mit Text.',
    en: 'Others see the entry in full — text included.',
  },

  // ⚠ ADR 002 §7.4 REQUIRED STRING — "First visibility downgrade", verbatim. Both halves are
  // load-bearing: the first is the mechanism (one pull cycle, ADR 004 §5.3), the second is the
  // honesty (§11.2 — retraction is client-cooperative; what was seen was seen).
  downgradeNote: {
    de: 'Ab dem nächsten Abgleich verschwindet der Eintrag von den anderen Boards. '
      + 'Was schon sichtbar war, wurde schon gesehen.',
    en: 'From the next sync the entry disappears from the other boards. '
      + 'What was already visible has already been seen.',
  },

  coEdit: { de: 'Familie darf bearbeiten', en: 'Family can edit' },
  coEditOnlyGeteilt: {
    de: 'Nur bei „Geteilt“.',
    en: 'Only at “Shared”.',
  },

  // 16.6 / ADR 004 §6 — a pending publication shows the OLD exposure plus this marker. It is a
  // statement about the log, not a spinner (19.3: no spinner on the board).
  pending: { de: 'noch nicht abgeglichen', en: 'not synced yet' },

  // 17.6 — attribution shows who and when, NEVER what (ADR 004 §7.3). There is no level history
  // here, no diff and no „war geteilt": nothing in this file can render one, because nothing
  // computes one.
  by: { de: 'von', en: 'by' },
  someone: { de: 'einem Mitglied', en: 'a member' },
  changed: { de: 'geändert', en: 'edited' },
  changedBy: { de: 'zuletzt geändert von', en: 'last edited by' },

  // 18.1 — the viewer's half of the cluster. A foreign entry has no control at all; saying so is
  // better than an inert control the user will click at.
  foreignNote: {
    de: 'Die Sichtbarkeit bestimmt die Person, der der Eintrag gehört.',
    en: 'Visibility is set by the person the entry belongs to.',
  },
});

/**
 * ADR 002 §7.4's "Never" list. A claim the cryptography cannot keep is worse than no copy at all,
 * and LZP-1003 audits STRINGS as well as code — so the list is data here, and the DOM suite
 * sweeps every rendered string in both languages against it.
 */
export const FORBIDDEN_CLAIMS = Object.freeze([
  'gelöscht bei allen',
  'zurückgezogen',
  'niemand kann es mehr sehen',
  'live',
]);

/** The addendum's own 17.6 example, kept as the oracle for `attributionLine`. */
export const ATTRIBUTION_EXAMPLE = 'von Mama · geteilt · geändert So.';

/** The level word, in the current language. @param {string} level @returns {string} */
export const levelWord = (level) => (TXT[level] ? say(TXT[level]) : String(level));

/** The one-line disclosure statement for a level, in the current language. */
export const levelWhat = (level) => say(TXT[`${level}What`] ?? TXT.privatWhat);

// ─────────────────────────────────────────────────────────────────────────────
// 2. The pure model — no DOM, no store, exhaustively testable
// ─────────────────────────────────────────────────────────────────────────────

/** Increasing disclosure. Indexes into `VISIBILITY_LEVELS`, which is core's ONE list. */
const rank = (level) => VISIBILITY_LEVELS.indexOf(level);

/**
 * Does this entry have a sharing cluster at all?
 *
 * The answer is the PRESENCE OF THE TRUTH REGISTER, not a flag: `stripV2Fields` removes
 * `visibility` from every entry while there is no family space (see the header). So a solo board
 * answers `false` for every entry with no code path to override, and a family board answers
 * `true` for exactly the entries that have a level to change.
 * @param {Object} entry a materialized note or bar @returns {boolean}
 */
export function sharingApplies(entry) {
  return !!entry && VISIBILITY_LEVELS.includes(entry.visibility);
}

/**
 * Does this entry get a CLUSTER — a control, or the viewer's half of one?
 *
 * A foreign entry has no `visibility` truth register (it was never transmitted — ADR 004 §4.2),
 * only the folded `pub.level`. It still earns the cluster, because 17.6's attribution and the
 * plain sentence explaining that the level is someone else's to set are exactly what a viewer
 * needs and cannot get anywhere else. `sharingApplies` stays the narrower question — "is there a
 * control here that is MINE to use" — and every write path below asks that one.
 * @param {Object} entry @returns {boolean}
 */
export function clusterApplies(entry) {
  if (sharingApplies(entry)) return true;
  return !!entry && entry.isForeign === true && VISIBILITY_LEVELS.includes(entry.level);
}

/**
 * 18.1 — by default only the owner edits. A foreign entry is editable iff its owner opted it into
 * co-editing (18.2), which arrives as the promoted `pub.coEdit` → `coEdit`.
 *
 * ⚠ THE POPOVER NEEDS THIS FOR A REASON THAT IS NOT POLICY. A foreign entry's `id` IS its entity
 * key (`fnote:mem_…/uuid`, `materialize.js:foreignCandidate`), so `tx.note(entry.id).set(…)`
 * would mint `note:fnote:mem_…/uuid` in MY personal space — a register for an entity that cannot
 * exist. The guard is therefore load-bearing before it is a permission.
 * @param {Object} entry @returns {boolean}
 */
export function canEditEntry(entry) {
  if (!entry) return false;
  if (!entry.isForeign) return true;
  return entry.coEdit === true;
}

/**
 * THE LEVEL THE FAMILY MAY ALREADY HAVE SEEN — ADR 004 §6, applied to a sentence instead of a
 * badge.
 *
 * `exposure.level` is the last ACKED `pub.level` (restricted to ops carrying a server `seq`);
 * `entry.level` is the folded `pub.level`, acked or not. The HIGHER of the two is taken on
 * purpose: this value decides only whether to show the §7.4 downgrade sentence, and of the two
 * ways to be wrong, warning about a downgrade that changed nothing is free, while staying quiet
 * about one that reached three other Macs is the failure the sentence exists to prevent.
 *
 * @param {Object} entry @returns {'privat'|'belegt'|'geteilt'}
 */
export function exposedLevel(entry) {
  const acked = entry && entry.exposure && typeof entry.exposure.level === 'string'
    ? entry.exposure.level : null;
  const folded = entry && typeof entry.level === 'string' ? entry.level : null;
  let best = 'privat';
  for (const l of [acked, folded]) {
    if (VISIBILITY_LEVELS.includes(l) && rank(l) > rank(best)) best = l;
  }
  return best;
}

/** 16.6 — the publication has not reached the server yet. */
export const exposurePending = (entry) => !!(entry && entry.exposure && entry.exposure.pending);

/**
 * PLAN A VISIBILITY CHANGE. Pure. Returns `null` when there is nothing to do, which is v1's
 * decline protocol (`store.js:150`) and keeps a no-op click off the undo stack.
 *
 * ── WHY `coEdit: false` RIDES ALONG WHEN THE LEVEL LEAVES GETEILT ────────────────────────────
 *
 * ADR 004 disagrees with itself here, and the disagreement is worth stating rather than picking
 * a side silently:
 *
 *   · §5's transition table, Belegt → Geteilt, publishes a LITERAL `'pub.coEdit': false`.
 *   · `core/project.js:TRUTH_SOURCE` maps `'pub.coEdit' → 'coEdit'`, i.e. the projection
 *     republishes whatever the TRUTH register holds.
 *
 * Both cannot be true unless the truth register is `false` at that moment. Left alone, the truth
 * `coEdit` survives a Geteilt → Belegt → Geteilt round trip and the family SILENTLY REGAINS write
 * access to an entry the owner un-shared and re-shared — a grant nobody re-made, restored by a
 * control the user was using to disclose LESS. Writing it in the same transaction as the level
 * makes §8's sentence ("`pub.coEdit` exists only at Geteilt") true of the truth registers too,
 * structurally, and makes §5's literal `false` the natural output of the projection rather than a
 * special case the projection does not implement. Reported as an ADR wording gap.
 *
 * It is one transaction and therefore one ⌘Z (18.4), and it is a personal-space governing field:
 * it discloses nothing by itself.
 *
 * @param {Object} entry a materialized note or bar (its `visibility` is the truth register)
 * @param {'privat'|'belegt'|'geteilt'} level the level the user asked for
 * @returns {{patch: Object, from: string, to: string, downgrade: boolean}|null}
 */
export function planVisibilityChange(entry, level) {
  if (!sharingApplies(entry)) return null;
  if (!VISIBILITY_LEVELS.includes(level)) return null;
  if (entry.isForeign) return null;                 // 18.1 — not mine to set
  const from = entry.visibility;
  const leavingGeteilt = from === 'geteilt' && level !== 'geteilt';
  const clearCoEdit = level !== 'geteilt' && entry.coEdit === true;
  if (from === level && !clearCoEdit) return null;  // the v1 decline protocol, verbatim

  const patch = { visibility: level };
  if (clearCoEdit) patch.coEdit = false;

  return {
    patch,
    from,
    to: level,
    leavingGeteilt,
    // Against what the family may already have seen (ADR 004 §6), never against local intent.
    downgrade: rank(level) < rank(exposedLevel(entry)),
  };
}

/**
 * PLAN A CO-EDIT CHANGE (18.2). Pure. `null` when it declines.
 *
 * ADR 004 §8: the flag exists only at Geteilt — "co-editing dates you can see while the text
 * stays hidden is incoherent". The control DISABLES it below Geteilt; this refuses it as well, so
 * a caller that misses the disabled attribute still cannot set it.
 * @param {Object} entry @param {boolean} on
 * @returns {{patch: Object}|null}
 */
export function planCoEditChange(entry, on) {
  if (!sharingApplies(entry)) return null;
  if (entry.isForeign) return null;                 // never mine to grant (ADR 004 §8)
  if (entry.visibility !== 'geteilt') return null;
  const next = !!on;
  if ((entry.coEdit === true) === next) return null;
  return { patch: { coEdit: next } };
}

/**
 * 17.6 — „von Mama · geteilt · geändert So."  WHO and WHEN, never WHAT.
 *
 * Three shapes, and nothing else can be produced:
 *   · a FOREIGN entry     → „von <name> · <level> · geändert <Wd>."
 *   · MY entry last written by somebody else (18.5's co-edit case)
 *                         → „zuletzt geändert von <name> · <Wd>."
 *   · MY entry, mine alone → `null`. "von mir" is noise, and a line that is always there is a
 *                            line nobody reads.
 *
 * ⚠ THE LEVEL WORD IS LOWER-CASED HERE AND CAPITALISED IN THE CONTROL, because the addendum's own
 * 17.6 example is „von Mama · geteilt · geändert So." — running text, not a glossary term.
 * `ATTRIBUTION_EXAMPLE` pins it so the two spellings cannot drift apart unnoticed.
 *
 * @param {Object} entry
 * @param {{nameOf?: (memberId:string)=>string|null, lang?: string}} [opts]
 *        `nameOf` is a PORT. There is no member roster carrying display names on this device yet
 *        (`store._project` passes `members: new Map()`), so the default resolves to the entry's
 *        `initial` and then to „einem Mitglied" — honest, and it becomes a name the day the
 *        roster lands, with no change here.
 * @returns {string|null}
 */
export function attributionLine(entry, opts = {}) {
  if (!entry) return null;
  const lang = opts.lang || getLang();
  const nameOf = typeof opts.nameOf === 'function' ? opts.nameOf : () => null;
  const t = (pair) => (lang === 'en' ? pair.en : pair.de);
  const who = (memberId) => {
    const n = memberId ? nameOf(memberId) : null;
    if (typeof n === 'string' && n.trim()) return n.trim();
    if (typeof entry.initial === 'string' && entry.initial.trim()) return entry.initial.trim();
    return t(TXT.someone);
  };
  const when = () => {
    if (!isStamp(entry.updatedAt)) return null;
    const WD = lang === 'en' ? WD_EN : WD_DE;
    const d = new Date(msOf(entry.updatedAt));
    return Number.isFinite(d.getTime()) ? `${WD[d.getDay()]}.` : null;
  };

  if (entry.isForeign) {
    const parts = [`${t(TXT.by)} ${who(entry.ownerId)}`];
    const lv = typeof entry.level === 'string' && TXT[entry.level]
      ? t(TXT[entry.level]).toLocaleLowerCase(lang === 'en' ? 'en' : 'de')
      : null;
    if (lv) parts.push(lv);
    const w = when();
    if (w) parts.push(`${t(TXT.changed)} ${w}`);
    return parts.join(' · ');
  }

  // My own entry. Only a FOREIGN last writer is worth a line (18.5 / ADR 004 §4.1's promotion).
  const editor = entry.updatedBy;
  if (!editor || editor === entry.ownerId) return null;
  const w = when();
  const head = `${t(TXT.changedBy)} ${who(editor)}`;
  return w ? `${head} · ${w}` : head;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The glyphs — silhouette first, ink ramp second (see decision 2)
// ─────────────────────────────────────────────────────────────────────────────

const SVGNS = 'http://www.w3.org/2000/svg';

const svg = (tag, attrs) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/**
 * A 12×12 glyph for one level, at `size` px.
 *
 * The three silhouettes are deliberately as different as three 10-px marks can be, because at
 * this size a colour difference is the FIRST thing a display, a projector or a colour-blind
 * reader loses, and `palette.js`' rule ("hue is deliberately never the only channel") is a rule
 * about exactly this:
 *
 *   privat   a CLOSED padlock — solid body, closed shackle. Nothing gets out.
 *   belegt   an OPEN padlock — shackle lifted and hinged right, body OUTLINED with only its lower
 *            half filled. "Half" is the whole meaning of Belegt: the day is out, the text is not.
 *   geteilt  TWO PEOPLE and no lock at all. The absence of the lock is the message.
 *
 * @param {'privat'|'belegt'|'geteilt'} level @param {number} [size]
 * @returns {SVGElement}
 */
export function levelGlyph(level, size = 10) {
  const s = svg('svg', {
    viewBox: '0 0 12 12', width: size, height: size,
    class: `share-glyph share-glyph-${level}`, 'aria-hidden': 'true', focusable: 'false',
  });
  if (level === 'geteilt') {
    s.appendChild(svg('circle', { cx: 4.1, cy: 3.5, r: 1.7, fill: 'currentColor' }));
    s.appendChild(svg('path', { d: 'M0.9 10.6a3.2 3.2 0 0 1 6.4 0z', fill: 'currentColor' }));
    s.appendChild(svg('circle', { cx: 8.9, cy: 4.3, r: 1.35, fill: 'currentColor' }));
    s.appendChild(svg('path', { d: 'M6.4 10.6a2.5 2.5 0 0 1 5 0z', fill: 'currentColor' }));
    return s;
  }
  if (level === 'belegt') {
    // shackle: open, hinged on the RIGHT, so the left leg is visibly missing
    s.appendChild(svg('path', {
      d: 'M8.6 5.2V3.4a2.1 2.1 0 0 0-4.2 0v0.7',
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round',
    }));
    s.appendChild(svg('rect', {
      x: 2.6, y: 5.2, width: 6.8, height: 5.6, rx: 1.2,
      fill: 'none', stroke: 'currentColor', 'stroke-width': 1.1,
    }));
    s.appendChild(svg('rect', { x: 3.7, y: 7.9, width: 4.6, height: 1.9, rx: 0.5, fill: 'currentColor' }));
    return s;
  }
  // privat — closed padlock, solid
  s.appendChild(svg('path', {
    d: 'M3.9 5.2V3.5a2.1 2.1 0 0 1 4.2 0v1.7',
    fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round',
  }));
  s.appendChild(svg('rect', { x: 2.6, y: 5.2, width: 6.8, height: 5.6, rx: 1.2, fill: 'currentColor' }));
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Styles — injected once, the house pattern for `src/js/family/*` UI
//    (`pairingui.js`, `createjoin.js`, `syncstatus.js`, `membersui.js` all do this)
// ─────────────────────────────────────────────────────────────────────────────

/** The `<style>` id, exported so a test can assert exactly one of them exists. */
export const SHARING_CSS_ID = 'lzp-sharing-css';

const SHARING_CSS = `
/* ── the trigger: one glyph in the popover row's existing .act slot; ZERO extra rows ── */
.pop-row .share-trig { display: inline-flex; align-items: center; padding: 0 2px; line-height: 0; }
.pop-row .share-trig .share-glyph { display: block; }
.share-glyph-privat  { color: var(--ink-3); }
.share-glyph-belegt  { color: var(--ink-2); }
.share-glyph-geteilt { color: var(--ink-1); }
.pop-row .share-trig:hover .share-glyph,
.pop-row .share-trig[aria-expanded="true"] .share-glyph { color: var(--ink-1); }
/* 16.6 — a pending publication is HOLLOW, never animated. ADR 004 §6, 19.3 (no spinner). */
.pop-row .share-trig.is-pending .share-glyph { opacity: .45; }

/* ── the disclosure strip: .pop-cat's geometry, so it sits in the popover like a sibling ── */
.pop-share {
  margin-top: 6px; padding-top: 5px; border-top: 1px solid var(--hover);
  display: flex; flex-direction: column; gap: 4px;
}
.share-label { font: 600 8.5px var(--font); color: var(--ink-3); letter-spacing: .3px; }

.share-seg { display: flex; gap: 3px; }
.share-opt {
  flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 3px;
  padding: 2px 1px; border-radius: 3px; cursor: pointer;
  font: 400 9px var(--font); color: var(--ink-2);
  box-shadow: inset 0 0 0 1px var(--line-1);
}
.share-opt:hover { background: var(--hover); }
.share-opt .share-lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.share-opt[aria-checked="true"] {
  background: var(--chip); color: var(--ink-1); font-weight: 600;
  box-shadow: inset 0 0 0 1.5px var(--ink-1);
}
.share-opt:focus-visible { outline: 2px solid var(--accent-a); outline-offset: 1px; }

.share-what { font: 400 9px var(--font); color: var(--ink-2); line-height: 1.35; }
.share-pending { color: var(--ink-3); }

.share-coedit { display: flex; align-items: center; gap: 4px; font: 400 9px var(--font); color: var(--ink-1); cursor: pointer; }
.share-coedit input { width: 10px; height: 10px; margin: 0; accent-color: var(--ink-1); }
.share-coedit.is-off { color: var(--ink-4); cursor: default; }
.share-coedit.is-off input { cursor: default; }
.share-coedit-hint { font: 400 8.5px var(--font); color: var(--ink-4); }

.share-attr { font: 400 8.5px var(--font); color: var(--ink-3); }
.share-note { font: 400 8.5px var(--font); color: var(--ink-2); line-height: 1.35; }
.share-foreign { font: 400 9px var(--font); color: var(--ink-3); line-height: 1.35; }

/* The strip appears; nothing pulses, nothing slides, nothing loops. */
.pop-share { animation: share-in 90ms ease-out; }
@keyframes share-in { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .pop-share { animation: none !important; }
  .share-opt { transition: none !important; }
}
`;

/** Idempotent. One `<style>`, injected on first use, never rebuilt. */
export function ensureSharingCss() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SHARING_CSS_ID)) return;
  const s = document.createElement('style');
  s.id = SHARING_CSS_ID;
  s.textContent = SHARING_CSS;
  document.head.appendChild(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The control
// ─────────────────────────────────────────────────────────────────────────────

const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

/**
 * The strip: segmented control + co-edit flag + attribution. A7's "one sharing cluster".
 *
 * It is built as ONE element with no knowledge of the popover, so 16.3's second home — the
 * entry's SELECTED STATE, which lives in `interact.js` and is not this ticket's file — mounts the
 * identical control by calling this and appending the result. There is deliberately no second
 * implementation for the second site.
 *
 * @param {Object} opts
 * @param {Object} opts.entry     the materialized entry
 * @param {(level:string)=>void} opts.onLevel   called with a level the user picked
 * @param {(on:boolean)=>void}  [opts.onCoEdit] called with the co-edit flag the user set
 * @param {(memberId:string)=>string|null} [opts.nameOf]  the display-name port (see `attributionLine`)
 * @param {{level:string, to:string}|null} [opts.lastChange]  the transition just made, so the
 *        §7.4 downgrade sentence can be shown at the moment it is true
 * @returns {HTMLElement}
 */
export function sharingStrip(opts) {
  ensureSharingCss();
  const { entry } = opts;
  const strip = el('div', 'pop-share');
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', say(TXT.visibility));

  // ── 18.1 — a foreign entry has no control, and says why. An inert control the user can click
  //    at is a worse answer than a sentence.
  if (entry.isForeign) {
    strip.appendChild(el('div', 'share-label', say(TXT.visibility).toUpperCase()));
    const lv = typeof entry.level === 'string' && TXT[entry.level] ? say(TXT[entry.level]) : null;
    if (lv) strip.appendChild(el('div', 'share-what', `${lv} — ${levelWhat(entry.level)}`));
    strip.appendChild(el('div', 'share-foreign', say(TXT.foreignNote)));
    const attr = attributionLine(entry, { nameOf: opts.nameOf });
    if (attr) strip.appendChild(el('div', 'share-attr', attr));
    return strip;
  }

  strip.appendChild(el('div', 'share-label', say(TXT.visibility).toUpperCase()));

  // ── the three-state control ────────────────────────────────────────────────
  const seg = el('div', 'share-seg');
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', say(TXT.visibility));
  const buttons = [];
  for (const level of VISIBILITY_LEVELS) {
    const b = el('button', 'share-opt');
    b.type = 'button';
    b.dataset.level = level;
    b.setAttribute('role', 'radio');
    const on = entry.visibility === level;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;                  // roving tabindex — one stop for the whole group
    b.title = levelWhat(level);
    b.appendChild(levelGlyph(level, 9));
    b.appendChild(el('span', 'share-lbl', levelWord(level)));
    b.addEventListener('click', () => opts.onLevel(level));
    buttons.push(b);
    seg.appendChild(b);
  }
  // ← → move and select, the way a real radiogroup does. The control is the emotional core; it
  // should not be the one thing in the popover a keyboard cannot reach.
  seg.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (i < 0) return;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % buttons.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + buttons.length) % buttons.length;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    buttons[next].focus();
    opts.onLevel(buttons[next].dataset.level);
  });
  strip.appendChild(seg);

  // ── what this level actually discloses (16.7) + the pending marker (16.6) ──
  const what = el('div', 'share-what', levelWhat(entry.visibility));
  if (exposurePending(entry)) {
    what.appendChild(document.createTextNode(' '));
    what.appendChild(el('span', 'share-pending', `· ${say(TXT.pending)}`));
  }
  strip.appendChild(what);

  // ── 18.2 — the co-edit flag, live only at Geteilt (ADR 004 §8) ─────────────
  const geteilt = entry.visibility === 'geteilt';
  const lab = el('label', `share-coedit${geteilt ? '' : ' is-off'}`);
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = geteilt && entry.coEdit === true;
  cb.disabled = !geteilt;
  cb.addEventListener('change', () => {
    if (typeof opts.onCoEdit === 'function') opts.onCoEdit(cb.checked);
  });
  lab.appendChild(cb);
  lab.appendChild(el('span', null, say(TXT.coEdit)));
  if (!geteilt) lab.appendChild(el('span', 'share-coedit-hint', say(TXT.coEditOnlyGeteilt)));
  strip.appendChild(lab);

  // ── ADR 002 §7.4's downgrade sentence, at the moment it is true ────────────
  //
  // It is shown on EVERY downgrade rather than only the first. "First visibility downgrade" is
  // the ADR's name for the MOMENT, and remembering "have I said this before?" would need a new
  // device-local pref — a new key in `settings`, which `board.json` is asserted byte-identical
  // to (11.4) and which `exportJSON` carries. Repeating one quiet 9-px line inside a popover the
  // user opened themselves is cheaper than that, and it errs toward honesty rather than toward a
  // promise. `role="status"` so a screen reader hears it without the focus moving.
  if (opts.lastChange && opts.lastChange.downgrade) {
    const note = el('div', 'share-note', say(TXT.downgradeNote));
    note.setAttribute('role', 'status');
    strip.appendChild(note);
  }

  // ── 17.6 — attribution, if there is anything to attribute ─────────────────
  const attr = attributionLine(entry, { nameOf: opts.nameOf });
  if (attr) strip.appendChild(el('div', 'share-attr', attr));

  return strip;
}

/**
 * The row trigger: one glyph, no row cost. Click discloses the strip (16.3's first click).
 * @param {Object} entry @returns {HTMLButtonElement}
 */
export function sharingTrigger(entry) {
  ensureSharingCss();
  const b = el('button', 'act share-trig');
  b.type = 'button';
  b.dataset.share = 'trigger';
  b.setAttribute('aria-expanded', 'false');
  b.setAttribute('aria-haspopup', 'true');
  paintTrigger(b, entry);
  return b;
}

/** Repaint a trigger for a (possibly changed) entry. Same node, so focus survives. */
export function paintTrigger(btn, entry) {
  const level = VISIBILITY_LEVELS.includes(entry.visibility) ? entry.visibility
    : (VISIBILITY_LEVELS.includes(entry.level) ? entry.level : 'privat');
  btn.textContent = '';
  btn.appendChild(levelGlyph(level, 10));
  btn.classList.toggle('is-pending', !entry.isForeign && exposurePending(entry));
  const word = levelWord(level);
  const pend = !entry.isForeign && exposurePending(entry) ? ` (${say(TXT.pending)})` : '';
  btn.setAttribute('aria-label', `${say(TXT.visibility)}: ${word}${pend}`);
  // The Belegt tooltip is ADR 002 §7.4's required string, verbatim, on the owner's own board.
  btn.title = entry.isForeign ? `${say(TXT.visibility)}: ${word}` : `${word} — ${levelWhat(level)}`;
  return btn;
}
