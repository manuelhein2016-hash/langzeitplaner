// src/js/core/visibility.js — THE LEVEL AND ITS POLICY. `project.js` owns the BYTES.
//
// ADR 004 §2.1 (the disclosure table), §3 (16.4, the category default), §5 (16.5, transitions),
// §7 (Principle 9, no surveillance mechanics), §9 (A4, series-level visibility) ·
// addendum F16 16.1–16.7, F18 18.2, A4, A7 · ADR 001 §3.1 (the truth / `pub.*` split).
//
// DOM-free, side-effect-free, and — see below — a LEAF.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE IS NOT `project.js`, AND WHY `project.js` IS NOT THIS FILE
//
//   `core/project.js` answers ONE question: given a level, WHICH BYTES MAY LEAVE THE DEVICE.
//   It is the redaction boundary and it is the most security-critical file in the project.
//
//   This file answers every OTHER question about the level itself, and none about bytes:
//     · which levels exist, and in what order of disclosure          (16.2)
//     · what a new entry's level is                                  (16.1, 16.4 / LZP-703)
//     · what a level discloses, as a policy claim independent of any field list   (16.7)
//     · what a CHANGE of level consists of, and what it withdraws    (16.5 / LZP-704)
//     · that a change of level tells nobody anything                 (Principle 9)
//     · that a series has one level and can never have twelve        (A4)
//
//   THE SPLIT IS THE POINT AND IT IS NOT COSMETIC. If the level policy lived inside
//   `project.js`, every product question — "what does the segmented control offer?", "what does
//   a category default to?", "is this a downgrade?" — would be a reason to edit the redaction
//   boundary. Files that get edited for cosmetic reasons stop being reviewed line by line, and
//   ADR 004's whole argument is that this one is reviewed line by line. So the boundary gets to
//   be small and boring, and the churn lands here.
//
//   THE CONSEQUENCE, STATED SO NOBODY UNDOES IT: **THIS FILE NEVER PRODUCES A PATCH.** Not a
//   partial one, not a "simple" one, not a convenience wrapper. `projectForFamily` and
//   `retractPatch` are the only producers in the codebase and there is no second path. What this
//   file offers instead is `planTransition`, which PREDICTS whether there will be a family op —
//   which is a thing the store must know BEFORE it builds the transaction group — and the
//   prediction is checked against the real projection over the whole input domain in
//   `tests/tier1/visibility.test.js` (rows `X2-*`). A prediction that drifts goes red; a second
//   producer would not have.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THIS MODULE IMPORTS NOTHING, AND THAT IS LOAD-BEARING
//
//   `core/entities.js` imports from HERE (`projectedToPeers`, `isRedacted`, and the levels
//   themselves), because `projectable()` and `renderableNote()` were spelling `'privat'` and
//   `'belegt'` inline — a viewer-side privacy decision written as a string comparison in a
//   renderability predicate. `entities.js` is imported by `ops.js`, `registers.js`,
//   `materialize.js`, `project.js` and `authz.js`, so ANY import added to this file becomes an
//   import cycle through nearly the whole of `core/`. There is nothing here that needs one:
//   levels are three strings and the rest is arithmetic on their index.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ONE ASYMMETRY IN THIS FILE, AND IT IS DELIBERATE: PREDICATES ANSWER, ORDERINGS REFUSE
//
//   `showsContent('oeffentlich')` returns **false**. `rankOf('oeffentlich')` **throws**.
//
//   They are not inconsistent; they are two different questions asked by two different callers.
//
//   A PREDICATE is asked by a RENDERER — `entities.js:projectable`, a badge, a filter — about a
//   level that arrived over the wire and folded into a register. A renderer must never throw:
//   ADR 004 §2.3's loud failure path catches `RedactionError` on the PUBLISH path, and there is
//   no equivalent catch around the board draw, so an exception there is a blank calendar. And
//   there is exactly one safe answer to "does this unknown level disclose anything?" — no. Every
//   predicate below is total and fails CLOSED, which is barrier 4's own rule ("an answer outside
//   `privat|belegt|geteilt` is a REFUSAL, never a fallback") applied on the viewing side.
//
//   AN ORDERING is asked by a PLANNER — is this a downgrade, does it withdraw, what op follows.
//   There is no safe answer for an unknown level: ranking it below `privat` invents a withdrawal
//   and ranking it above `geteilt` invents a disclosure. So it refuses, loudly, before any op is
//   built.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// PRINCIPLE 9 IS ENFORCED HERE BY WHAT IS ABSENT, NOT BY WHAT IS WRITTEN
//
//   Addendum §6: "downgrading visibility produces no notification to others; entries simply
//   aren't there anymore — the app never reports on anyone's privacy choices."
//
//   Three absences carry it, and each has a test row and a mutant:
//     · `planTransition` returns a FROZEN object with an exactly-pinned key set. There is no
//       `notify`, no `announce`, no `previousLevel` to put on the wire — and `notifies: false`
//       is present as a literal so that adding the mechanism means changing a value a test
//       already reads, rather than adding a field nobody is looking for.
//     · `retractPatch(kind)` — in `project.js`, and asserted from here — takes the KIND and
//       NOTHING ELSE. A Geteilt→Privat and a Belegt→Privat retraction are therefore the same
//       bytes, and a peer cannot recover what the entry was downgraded FROM, because the
//       function that builds the bytes was never told.
//     · There is no op kind for it. ADR 004 §7: "The eight kinds in ADR 001 §3 are the whole
//       vocabulary." Nothing here mints an op at all.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Thrown when a level, or a transition between levels, is not one this model has.
 *
 * A SEPARATE CLASS FROM `project.js:RedactionError`, on purpose and in both directions. Neither
 * module may import the other (this one imports nothing at all), so they could not share a class
 * even if that were desirable — and it is not: `RedactionError` means *a leak was prevented* and
 * ADR 004 §2.3 requires the store to stop the sync loop when it sees one. A malformed level
 * handed to a planner is a caller bug on this device, and widening the sync-stopping catch to
 * cover it would make the loud path fire for something that never approached the wire.
 *
 * Callers that catch either must therefore catch by NAME (`err.name === 'VisibilityError'`), not
 * by `instanceof` across a module boundary.
 */
export class VisibilityError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'VisibilityError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The three levels (16.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three visibility levels, IN INCREASING ORDER OF DISCLOSURE (16.1–16.7).
 *
 * THE ORDER IS DATA, NOT DECORATION. Every rank, comparison, upgrade/downgrade classification
 * and withdrawal test below is `indexOf` into this array. Reordering it re-defines what a
 * downgrade is, which is why nothing else in the file writes a rank down.
 *
 * DEFINED HERE AND RE-EXPORTED BY `core/entities.js`. It used to be defined there, one line
 * under the entity-kind tables, where `ops.js`, `crypto/envelope.js` and `core/project.js` all
 * reach for it. Moving the definition costs those importers nothing (the name and the value are
 * unchanged) and buys the one thing that mattered: the levels and the rules about the levels are
 * now the same file, so a fourth level cannot be added to the array without landing next to
 * every predicate that would have to answer for it.
 * @type {ReadonlyArray<'privat'|'belegt'|'geteilt'>}
 */
export const VISIBILITY_LEVELS = Object.freeze(['privat', 'belegt', 'geteilt']);

/**
 * 16.1 — PRIVATE BY DEFAULT, and the global default is not configurable.
 *
 * "Everything I create is private by default — joining a family changes nothing about existing or
 * new entries until I explicitly share them — so oversharing is structurally impossible." A
 * category may raise the default for ITS OWN new entries (16.4, §3 below); nothing raises this
 * one, and `core/replace.js` treats it as "the privacy floor a file may not raise" (RECHECK-40-3).
 */
export const DEFAULT_VISIBILITY = 'privat';

/**
 * level → rank. A NULL-PROTOTYPE object, and that is not fussiness.
 *
 * ADR 004 §2.2's own printed barrier had this bug: `k in FIELDS[kind]` is `true` for `'toString'`
 * because the table inherits `Object.prototype`. A rank table built with `Object.fromEntries` has
 * the same shape, so `LEVEL_RANK['constructor']` would be a FUNCTION rather than `undefined`, and
 * any `?? ` or truthiness guard downstream would read it as a rank. `Object.create(null)` means
 * the only keys are the three that were put there.
 *
 * `rankOf` does not read this table at all — it uses `indexOf`, so the table cannot disagree with
 * the array it was built from. It is exported because a UI that lays out a segmented control
 * left-to-right wants the order as data, and building a second one is how orders drift.
 * @type {Readonly<Object<string, number>>}
 */
export const LEVEL_RANK = Object.freeze(
  VISIBILITY_LEVELS.reduce((acc, level, i) => { acc[level] = i; return acc; }, Object.create(null)),
);

/**
 * Is this one of the three? Total, and `false` for everything else — including `undefined`,
 * `null`, `'Privat'` (the UI spelling, 13's glossary; the register holds the lowercase id) and
 * any level a future protocol version might add.
 * @param {any} level @returns {boolean}
 */
export const isLevel = (level) => typeof level === 'string' && VISIBILITY_LEVELS.includes(level);

/**
 * The rank, or a refusal. See the header's asymmetry note: an ordering has no safe answer for an
 * unknown level, so it does not invent one.
 * @param {any} level @returns {0|1|2}
 * @throws {VisibilityError}
 */
export function rankOf(level) {
  const i = isLevel(level) ? VISIBILITY_LEVELS.indexOf(level) : -1;
  if (i < 0) {
    throw new VisibilityError(
      `rankOf: ${JSON.stringify(level)} is not a visibility level. Ranking an unknown level below `
      + '`privat` invents a withdrawal and ranking it above `geteilt` invents a disclosure, so '
      + 'there is no safe default and this refuses instead (ADR 004 §2.2 barrier 4).');
  }
  return /** @type {0|1|2} */ (i);
}

/**
 * `< 0` when `a` discloses less than `b`. The comparator the three-state control sorts by.
 * @param {string} a @param {string} b @returns {number}
 */
export const cmpLevels = (a, b) => rankOf(a) - rankOf(b);

/** Strictly less disclosure than before — the transition that WITHDRAWS (16.5, INV-R4). */
export const isDowngrade = (from, to) => cmpLevels(to, from) < 0;
/** Strictly more disclosure than before. */
export const isUpgrade = (from, to) => cmpLevels(to, from) > 0;

// ─────────────────────────────────────────────────────────────────────────────
// 2. What each level discloses — the POLICY table (16.2, 16.7, ADR 004 §2.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠ THIS IS A SECOND, INDEPENDENT STATEMENT OF ADR 004 §2.1, AND IT IS SUPPOSED TO BE.
 *
 * `project.js` states the same table as FIELD LISTS — `GETEILT_FIELDS` minus `BELEGT_FIELDS` is
 * exactly `{pub.text|pub.label, pub.coEdit}`. This states it as CLAIMS: Belegt discloses
 * existence and not content; Geteilt discloses both; Privat discloses nothing. Neither table is
 * derived from the other, and `tests/tier1/visibility.test.js` rows `X1-*` assert that they agree
 * for every (kind, level) pair.
 *
 * Two tables that must agree is the same construction A3 uses for the category — "two independent
 * tables, neither of which can name a category, and no filter to forget". A single table read
 * twice cannot catch the edit that widens it; two tables checked against each other can, and the
 * check costs six assertions.
 *
 * `existence` is 16.7's deliberate leak, named so nobody reads it as an oversight: "duration and
 * owner are deliberately visible, the content deliberately not". `coEdit` is 18.2 and ADR 004 §8
 * — "co-editing dates you can see while the text stays hidden is incoherent", so it exists at
 * Geteilt and nowhere else.
 *
 * Null-prototype for `LEVEL_RANK`'s reason.
 * @type {Readonly<Object<string, Readonly<{existence: boolean, content: boolean, coEdit: boolean}>>>}
 */
export const DISCLOSURE = Object.freeze(Object.assign(Object.create(null), {
  privat: Object.freeze({ existence: false, content: false, coEdit: false }),
  belegt: Object.freeze({ existence: true, content: false, coEdit: false }),
  geteilt: Object.freeze({ existence: true, content: true, coEdit: true }),
}));

/**
 * What an unknown level discloses. The fail-closed row, named rather than written as three
 * `false`s at three call sites — so a mutant that flips one of them flips all three and the
 * whole `X3` block goes red together, and so that "an unknown level is Privat, for viewing
 * purposes" is a sentence somebody wrote on purpose.
 */
const DISCLOSES_NOTHING = DISCLOSURE.privat;

const disclosureOf = (level) => (isLevel(level) ? DISCLOSURE[level] : DISCLOSES_NOTHING);

/**
 * Do others see that this entry EXISTS — the day/range being taken, and by whom (16.7)?
 *
 * This is the viewer-side gate `entities.js:projectable` applies to a foreign entry, and it is
 * also the answer to "will publishing at this level put any byte on the wire at all" (16.1: a
 * Privat entry produces no family op).
 * @param {any} level @returns {boolean}
 */
export const showsExistence = (level) => disclosureOf(level).existence;

/** Do others see the TEXT / LABEL (16.2 Geteilt)? False at every other level — INV-R1. */
export const showsContent = (level) => disclosureOf(level).content;

/** May the entry carry `pub.coEdit` (18.2, ADR 004 §8)? Geteilt only. */
export const allowsCoEdit = (level) => disclosureOf(level).coEdit;

/**
 * 16.7's neutral block: others see THAT, never WHAT. Exactly `belegt` today, and written as
 * `existence && !content` rather than `=== 'belegt'` so that a level added between them is
 * classified by what it discloses rather than by its name.
 * @param {any} level @returns {boolean}
 */
export const isRedacted = (level) => showsExistence(level) && !showsContent(level);

/**
 * ADR 004 §4.2's viewer-side gate, **AS SHIPPED** — and it is NOT `showsExistence`.
 *
 *     projectedToPeers(level)   ≡  level is present and is not 'privat'
 *     showsExistence(level)     ≡  level is 'belegt' or 'geteilt'
 *
 * They differ on exactly one input class: a level OUTSIDE the enum. `showsExistence` says no
 * (fail closed, the header's rule); this says yes.
 *
 * ⚠ THE DIFFERENCE IS DELIBERATE AND IT IS SOMEBODY ELSE'S DECISION, RECORDED HERE RATHER THAN
 * OVERRULED. `core/materialize.js` and `tests/tier1/core-materialize.test.js:757` ("a foreign
 * entry at an UNKNOWN future level does not render as Geteilt") characterize forward
 * compatibility: a level this build has never heard of is NOT treated as the most permissive one
 * it knows — `redacted` stays false so `board.js` cannot print it as a Belegt block — but the
 * entry is not dropped either, because dropping a family member's entry is data loss on the
 * viewer's board and the design chose visibility over silence there.
 *
 * The reason that choice is SAFE, and the reason it deserves a second look anyway, are both
 * worth writing down:
 *
 *   · SAFE TODAY, through the honest path. `ops.js` types `pub.level` as an enum, so no op this
 *     build accepts can write `'orange'`; and `authz.js` stage 3c drops any `geteiltOnly` field
 *     carrying a non-null value while the folded level is not `geteilt`, so an entry at an
 *     unknown level reaching `renderableNote` HAS NO `pub.text` and is invisible anyway. The
 *     cited test reaches its second assertion by writing the register directly, past both.
 *
 *   · WORTH A SECOND LOOK. The moment a future protocol version adds a level BETWEEN Belegt and
 *     Geteilt, an old client folding a stale `pub.text` beside it would print the text. That is a
 *     leak, and it is the one input class where these two predicates disagree. Reported as a
 *     finding for the owner of `materialize.js` / `core-materialize.test.js`; not changed here,
 *     because a privacy widening and a data-loss narrowing are the same edit seen from two sides
 *     and it is not this work package's to make unilaterally. Row `X4-viewer-gate` pins BOTH
 *     predicates and the input they disagree on, so the day somebody chooses, they choose once.
 *
 * @param {any} level @returns {boolean}
 */
export const projectedToPeers = (level) => !!level && level !== 'privat';

/**
 * Does an entry at this level have anything to publish AT ALL?
 *
 * 16.1 made structural: at Privat the answer is no, so `projectForFamily` returns `null` and
 * "private by default costs zero bytes on the wire" is a property of the projection rather than
 * a filter somebody applies. It is an alias of `showsExistence` and it is a separate name because
 * the two questions are asked by different code for different reasons, and a future level could
 * make them differ.
 * @param {any} level @returns {boolean}
 */
export const publishesAnything = (level) => showsExistence(level);

/**
 * Has this entity ever been published — i.e. does some peer hold registers for it?
 *
 * `null` is "never". `'privat'` is ALSO never, because a `pub.level: 'privat'` register is what a
 * completed retraction looks like and there is nothing left to withdraw. `undefined` is a
 * REFUSAL, not "never": a caller that forgot the argument would otherwise silently perform a
 * first publication, and `project.js` refuses the same shape at the same seam for the same
 * reason.
 * @param {'privat'|'belegt'|'geteilt'|null} lastPublished @returns {boolean}
 * @throws {VisibilityError}
 */
export function wasPublished(lastPublished) {
  if (lastPublished === null) return false;
  if (!isLevel(lastPublished)) {
    throw new VisibilityError(
      `wasPublished: ${JSON.stringify(lastPublished)} is not a level or null. \`undefined\` is not `
      + '"never published" — say `null`, so a missing argument is a refusal rather than a silent '
      + 'first publication (ADR 004 §2, `projectForFamily`\'s own rule).');
  }
  return lastPublished !== 'privat';
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The category default — 16.4, LZP-703, ADR 004 §3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The level a NEW entry in this category starts at.
 *
 * 16.4: "A personal category can set a default visibility for new entries in it (e.g., category
 * 'Familie' ⇒ Geteilt), so routine sharing costs zero extra clicks while the global default
 * stays private."
 *
 * FOUR THINGS THIS FUNCTION IS, EACH OF WHICH IS A RULE SOMEBODY WOULD OTHERWISE HAVE TO REMEMBER:
 *
 *  1. **ARITY 1.** There is no `now`, no `entry`, no "the level I used last". The signature is the
 *     enforcement of ADR 004 §3's "read exactly once, at entry creation": a function that takes
 *     only a category cannot be a live rule, because it has nothing to re-evaluate against.
 *     Row `C4-arity`.
 *
 *  2. **IT IS NOT A LIVE RULE, AND THAT IS A PRIVACY PROPERTY, NOT AN IMPLEMENTATION NOTE.**
 *     ADR 004 §3: "Changing a category's default never re-publishes existing entries — that would
 *     be a bulk disclosure triggered by a settings click, which 16.1 forbids." Nothing in this
 *     module can produce that re-publication, because nothing here reads a category alongside an
 *     existing entry. `CATEGORY_DEFAULT_CONTRACT` states the clause for the create paths.
 *
 *  3. **IT FAILS CLOSED, TWICE.** A missing category (a dangling `categoryId` — v1's tri-state
 *     rule treats an unknown category as VISIBLE, so dangling references really do occur) and a
 *     `defaultVisibility` outside the enum both yield `DEFAULT_VISIBILITY`. Never the last level
 *     used, never `undefined` handed on for somebody else to default. Rows `C4-missing`,
 *     `C4-alien`.
 *
 *     Note the contrast with `project.js:assertTruthAgrees`, which THROWS on an alien
 *     `visibility`. Both are right and the difference is the header's asymmetry: an alien value
 *     on the PUBLISH path means "there is nothing to re-derive from, and I will not guess", while
 *     an alien value in a category record is a creation-time default with a safe floor. Privat is
 *     that floor and choosing it discloses nothing.
 *
 *  4. **IT READS `defaultVisibility` EXACTLY ONCE**, into a `const`. A getter that answers
 *     `'privat'` to a validation and `'geteilt'` to the return is the cheapest way through a
 *     policy that inspects a field twice — the same defence `project.js:readOnce` documents, at
 *     the one other seam where a caller-owned object decides a level.
 *
 * A3 is untouched: `defaultVisibility` is a PERSONAL-space field on the category and categories
 * are never synced. It has no `pub.` counterpart in `ops.js:FIELDS` and cannot acquire one here,
 * because this function returns a LEVEL and never a field.
 *
 * @param {Object|null|undefined} category the materialized category record, or nothing at all
 * @returns {'privat'|'belegt'|'geteilt'}
 */
export function visibilityForNewEntry(category) {
  if (category === null || typeof category !== 'object') return DEFAULT_VISIBILITY;
  const declared = category.defaultVisibility;          // read ONCE — see clause 4
  return isLevel(declared) ? declared : DEFAULT_VISIBILITY;
}

/**
 * ADR 004 §3 as executable clauses, for the six create paths that must obey it and for the test
 * that reads them back. Prose in an ADR is a thing a downstream agent may not have read; a frozen
 * object in the module they are calling is a thing they trip over.
 */
export const CATEGORY_DEFAULT_CONTRACT = Object.freeze({
  readOnce:
    'The category default is read EXACTLY ONCE, at entry creation, by the create paths '
    + '(`interact.js` bar-drag and inline note, `popover.js` note create, and their v2 siblings). '
    + '`visibility: visibilityForNewEntry(store.category(catId))`. Nothing reads it again.',
  notLive:
    'Changing a category default NEVER re-publishes or re-levels an existing entry. That would be '
    + 'a bulk disclosure triggered by a settings click, which 16.1 ("oversharing is structurally '
    + 'impossible") forbids. There is no migration, no sweep and no prompt.',
  neverSynced:
    'A3 — `cat.defaultVisibility` is a personal-space field with no `pub.` counterpart at any '
    + 'level. It decides what a new entry publishes; it is never itself published.',
  floorIsPrivat:
    'The GLOBAL default stays `privat` (16.1) and a category may only raise the default for its '
    + 'own new entries. A missing category, or a `defaultVisibility` outside the enum, yields '
    + '`privat` — never the last level used, and never `undefined` for a caller to default again.',
  orthogonalToHiding:
    'Category VISIBILITY-ON-MY-BOARD (4.3/4.6 `visible`) and category DEFAULT-VISIBILITY-TO-FAMILY '
    + 'are two axes and must never be conflated in the UI (ADR 004 §3). Unhiding a category on '
    + 'create does not touch either default.',
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Transitions — 16.5, LZP-704, ADR 004 §5
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `'upgrade' | 'downgrade' | 'unchanged'`, by rank.
 * @param {string} from @param {string} to @returns {'upgrade'|'downgrade'|'unchanged'}
 * @throws {VisibilityError}
 */
export function classifyTransition(from, to) {
  const d = cmpLevels(to, from);
  return d > 0 ? 'upgrade' : d < 0 ? 'downgrade' : 'unchanged';
}

/**
 * The exact key set of a plan. Pinned as data so `Object.keys(plan)` can be compared against it
 * — Principle 9's first absence (see the header). A field added here is a field a reviewer sees.
 */
export const TRANSITION_PLAN_KEYS = Object.freeze([
  'from', 'to', 'direction', 'truth', 'family', 'withdraws', 'notifies',
]);

/**
 * What a visibility change consists of, decided before any op is built. 16.5, LZP-704.
 *
 * "I can change visibility at any time; a downgrade removes the entry (or its details) from other
 * members' boards at the next sync, so nothing shared is shared forever."
 *
 * ⚠ IT PLANS. IT DOES NOT PRODUCE. The returned `family` field says WHETHER there is a family op
 * and of which shape; the BYTES come from `project.js` and from nowhere else:
 *
 *     const plan = planTransition({ from, to, lastPublished, alive });
 *     tx.note(id).set({ visibility: plan.to });                    // the truth write
 *     if (plan.family !== 'none')                                  // …and at most one pub.set
 *       tx.pub(kind, owner, id).set(projectForFamily(kind, truth, plan.to, lastPublished));
 *
 * `projectForFamily` returns `null` for exactly the inputs this predicts as `'none'`, and returns
 * `retractPatch(kind)` for exactly the inputs this predicts as `'retract'`. That agreement is not
 * a comment: rows `X2-*` walk all 96 (from × to × lastPublished × alive) cells through the REAL
 * projection and compare. If a branch here drifts from a branch there, the domain goes red before
 * anything is sealed.
 *
 * ONE TRANSACTION, TWO WRITES. ADR 004 §5: "Every transition is ONE transaction carrying the
 * truth write plus the publication write", under one `gid`, so ⌘Z reverts both together and a
 * crash between them is impossible.
 *
 * THE `'privat'` ROW IS THE ONE THAT MATTERS. It is `'retract'` — never `'none'` — whenever the
 * entity was ever published, and `retractPatch` writes an EXPLICIT `null` to every withdrawable
 * register. ADR 004 §5.1: "OMISSION IS NOT WITHDRAWAL." A downgrade that merely stopped
 * publishing `pub.text` would perform no register write at all, the peer's LWW fold would keep
 * the old value and its stamp, and the entry would look correctly downgraded on my board while
 * staying fully readable on Mama's — with no owner-side smoke test able to catch it, because the
 * owner's board is right.
 *
 * A DEAD ENTRY THAT WAS NEVER PUBLISHED IS `'none'`. Publishing a tombstone for something no peer
 * ever saw ANNOUNCES THAT IT EXISTED, and the entry it announces is one 16.1 kept off the wire
 * entirely. Same rule and same reasoning as `projectForFamily`'s second `null` case.
 *
 * @param {Object} change
 * @param {'privat'|'belegt'|'geteilt'} change.from  the entity's CURRENT `visibility` truth register
 * @param {'privat'|'belegt'|'geteilt'} change.to    the level the user chose
 * @param {'privat'|'belegt'|'geteilt'|null} change.lastPublished  the folded `pub.level`, or `null`
 * @param {boolean} [change.alive=true]  `false` for the "delete while published" row of §5
 * @returns {Readonly<{from: string, to: string, direction: string,
 *   truth: Readonly<{visibility: string}>, family: 'publish'|'retract'|'none',
 *   withdraws: boolean, notifies: false}>}
 * @throws {VisibilityError}
 */
export function planTransition(change) {
  if (change === null || typeof change !== 'object' || Array.isArray(change)) {
    throw new VisibilityError(
      `planTransition: expected a change object, got ${
        Array.isArray(change) ? 'an array' : JSON.stringify(change)}.`);
  }
  const from = change.from;
  const to = change.to;
  rankOf(from);                       // both must be real levels, or there is no transition to
  rankOf(to);                         // classify — see the header's asymmetry note
  const lastPublished = change.lastPublished;
  const published = wasPublished(lastPublished);

  // `alive !== false` rather than a boolean check, BYTE-FOR-BYTE the third clause of
  // `project.js:aliveOf`. Absence must not read as "maybe dead": only an explicit `false` is a
  // tombstone, and a caller holding an entry from a materialized array is holding a live one.
  // Two seams that decide the same thing must decide it the same way, or `X2` finds the day they
  // disagree — which is why this is spelled the same and not "tightened".
  const alive = change.alive !== false;

  let family;
  if (to === 'privat') family = published ? 'retract' : 'none';   // 16.1 / INV-R4
  else if (!alive && !published) family = 'none';                 // no tombstone for a secret
  else family = 'publish';

  // Does some peer LOSE something it could previously see? A downgrade does; so does a delete of
  // a published entry. An upgrade and a level-preserving republish do not. This is what 16.5's
  // "removes the entry (or its details) from other members' boards" is true of, and what the
  // popover's confirmation copy — if the design ever wants one — must be driven by.
  const withdraws = published && (!alive || rankOf(to) < rankOf(lastPublished));

  return Object.freeze({
    from,
    to,
    direction: classifyTransition(from, to),
    // The personal-space write. `visibility` is a `gov: true` truth register (ADR 001 §3.1) and
    // it is what barrier 4 re-derives the seal level FROM — which is why the store must pass
    // THIS value to both `projectForFamily` and `sealOp`'s `ctx.levelOf`, and never the last
    // published one (ADR 004 §2.2's S5 amendment).
    truth: Object.freeze({ visibility: to }),
    family,
    withdraws,
    // Principle 9, as a literal. There is no notification, no marker, no „X hat einen Eintrag
    // privat gemacht", and no op kind that could carry one. A future agent who wants to add one
    // has to change this value, and `NO_SNITCH_CONTRACT` is what they will read when they try.
    notifies: false,
  });
}

/**
 * Principle 9 / addendum §6 / ADR 004 §7, as clauses. Read by `tests/tier1/visibility.test.js`
 * and owed to LZP-1003's string audit.
 */
export const NO_SNITCH_CONTRACT = Object.freeze({
  noNotification:
    'A downgrade produces NO notification to others. Entries simply are not there any more. There '
    + 'is no op kind for a visibility-change notice, a read receipt or a presence signal — the '
    + 'eight kinds in ADR 001 §3 are the whole vocabulary, and that ABSENCE is the enforcement.',
  noHistory:
    'A Belegt block that was downgraded from Geteilt renders IDENTICALLY to one that was always '
    + 'Belegt. No „war geteilt", no strikethrough, no animation, no level history, no diff.',
  retractionIsAnonymous:
    '`project.js:retractPatch(kind)` takes the KIND AND NOTHING ELSE, so a Geteilt→Privat and a '
    + 'Belegt→Privat retraction are the same bytes. The owner\'s own „→ Privat" and the admin\'s '
    + 'unshare (18.3) are byte-identical too. A peer cannot tell which happened, or what the '
    + 'entry was before — not by policy, but because no function on the path was ever told.',
  dotNeverFiresOnLoss:
    'The quiet „neu" dot (17.5) fires only on content-ADDING changes: `!levelDecreased(e) && '
    + 'pub.alive !== false`. A retraction or a downgrade never dots. Owned by LZP-804; stated '
    + 'here because `planTransition().withdraws` is the predicate it needs.',
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Series-level visibility — A4, ADR 004 §9
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The level of a repeating entry — WHICH IS THE LEVEL OF ITS SERIES, because a repeating note IS
 * its series (9.3, one object).
 *
 * A4: "Series-level visibility (the whole series is Privat/Belegt/Geteilt, no per-year exceptions)
 * keeps 9.3's one-object rule" — and it is "the killer family feature: Oma's birthday entered
 * once, visible to everyone, forever."
 *
 * ⚠ **ARITY 1. THERE IS NO YEAR ARGUMENT AND THERE MAY NEVER BE ONE.** That is the whole of A4 in
 * this module. There is no `seriesId` field, no occurrence entity and no per-occurrence register
 * (ADR 001 §3.1, `ops.js:seriesIdOf` — "`seriesId` is defined as an ALIAS OF THE ENTITY UUID"),
 * so there is exactly one `visibility` register and one `pub.level` register per series and a
 * per-year exception is not something this function refuses — it is something the data model
 * cannot express. `entities.js:noteOccurrences` pushes the SAME note object for every year, which
 * row `A4-one-object` asserts directly: twelve occurrences, one identity, one level.
 *
 * The family key `fnote:<mem>/<uuid>` is uuid-addressed, so moving a repeat's anchor
 * (`reanchorRepeat`) cannot change what the family record points at, and no occurrence op ever
 * crosses the wire — each peer expands locally with `projectYearly`, Feb-29 rule and all.
 *
 * Fails closed for the same reason `visibilityForNewEntry` does: this is a READ for a renderer or
 * a control, not the publish path.
 *
 * @param {Object|null|undefined} entry a note or bar, materialized (`visibility` is the truth)
 * @returns {'privat'|'belegt'|'geteilt'}
 */
export function seriesVisibility(entry) {
  if (entry === null || typeof entry !== 'object') return DEFAULT_VISIBILITY;
  const declared = entry.visibility;                    // read ONCE
  return isLevel(declared) ? declared : DEFAULT_VISIBILITY;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Copy — DELIBERATELY NOT HERE
//
// The three level words, their one-line disclosure statements, the required downgrade sentence
// and ADR 002 §7.4's "Never" list all live in `src/js/family/sharing.js` (`TXT`,
// `FORBIDDEN_CLAIMS`), which is A7's sharing cluster and another work package's file. A first
// draft of this module carried a second copy table — the levels ARE their names, and putting the
// wording beside the policy it states is tempting.
//
// It was removed before it shipped, and the reason is the same one ADR 002 §7.4 exists for: two
// tables of USER-FACING COPY that must agree is drift, not defence. That is the opposite of
// `DISCLOSURE` above, which is a second statement of §2.1 ON PURPOSE — because two tables of
// CLAIMS can be checked against each other by a test (rows `X1-*`), and the check is what makes
// the duplication worth having. There is no test that can hold two spellings of
// „Andere sehen: Datum, deinen Namen, deine Farbe — keinen Text." together across a module
// boundary this file may not cross, and the drafted second spelling was already different from
// the normative one.
//
// So: the level KEYS are `VISIBILITY_LEVELS` and they are the i18n keys too (ADR 004 §4.3 lists
// `belegt`, `geteilt`, `privat` for BOTH tables of `i18n.js`, which does not yet carry them).
// The words are `sharing.js:TXT`. There is one of each.
// ─────────────────────────────────────────────────────────────────────────────
