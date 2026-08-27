// src/js/core/migrate1to2.js — v1 `board.json` → v2 ops (ADR 001 §8 · LZP-403 · story 11.6)
//
// DOM-free, I/O-free, wall-clock-free, CSPRNG-free (ADR 005 §2). Everything this module needs in
// order to be reproducible is either a constant or comes in through `ctx`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS PARANOID ABOUT DETERMINISM — risk R12, ADR 001 §8.1
//
// The failure this design exists to prevent is a SILENT OVERWRITE, not a crash:
//
//     Mac A migrates board.json at T0 and I edit a note at T1.
//     Mac B migrates the SAME exported file at T2 > T1.
//     If B's migration op is stamped with B's wall clock, it writes the OLD text at a GREATER
//     stamp, and LWW discards the edit I made on A. Nothing errors. The text just reverts.
//
// So a migrated field is stamped with a constant that encodes only the v1 array index:
//
//     GENESIS(i) = '0000000000000.' + pad6(i) + '.' + '0'.repeat(16)
//
//   * `ms = 0`            ⇒ everything pre-existing loses to every future edit on every device.
//   * all-zeros device    ⇒ a true minimum, because every Crockford character sorts at or above
//                           '0' (ADR 001 §1.2). Even the tiebreak loses.
//   * `i`, one global counter running categories → notes → bars → scratchpads (→ prefs), is what
//     preserves v1's insertion order through §5's `_born` sort. A constant GENESIS for every
//     entity would make every comparison fall through to uuid-lexicographic order, which is
//     unrelated to v1 insertion order — visibly changing which note hides behind "+n"
//     (`layout.js:209`) and how bars are rescued into lanes (`layout.js:162-177`) on the user's
//     existing board. That is a v1 regression, and this is how we avoid causing it.
//
// The same reasoning applies one level up, to the op ids: see `deriveOpId` below.
// ─────────────────────────────────────────────────────────────────────────────

import { fmt, MAX_STAMP_CTR } from './stamp.js';
import { ZERO_DEVICE_SHORT, isDeviceShort, sha256 } from './ids.js';
import { b64u } from './b64.js';
import { canonicalJSON, utf8 } from './canon.js';
import {
  isMemberId, isDeviceId, isSpaceId, isMonthKey, isEntityUuid, isDateString, renderable,
  categoryVisibilityOf, noteOccurrences, iso, EARLIEST_DATE, LATEST_DATE,
} from './entities.js';
import { stripV2Fields } from './materialize.js';
import {
  FIELDS,
  fieldsOf,
  noteSet,
  barSet,
  catSet,
  padSet,
  prefSet,
  flattenPref,
  makeOp,
  opKindForEntity,
  OpError,
  PERSONAL_PLACEHOLDER,
} from './ops.js';

/** Thrown when migration cannot proceed at all. Never thrown for recoverable board damage — that
 *  produces a warning and a `lossy` flag, because refusing to open a user's board is worse than
 *  opening it with one hand-edited field dropped. */
export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * Thrown when the migration COMPLETED but could not do so without loss, and the caller never
 * said what to do about that (ATT-82).
 *
 * WHY A THROW AND NOT JUST A FLAG. `lossy` was a boolean on a returned object, and
 * `const { ops } = migrateV1(board, ctx)` — the shortest thing a store can write, and the thing
 * a store WILL write — silently discards it. The whole point of the flag is the one morning it
 * is true: the user launches v2, one of eleven years of notes was hand-edited or imported and
 * carries something v2 cannot store, and nothing on screen says so. A boolean nobody is obliged
 * to read is not a safety mechanism.
 *
 * So the obligation is moved into the type system's only enforcement mechanism here, control
 * flow: a caller must either hand in `ctx.onLossy` (a function that RECEIVES the report — what
 * the app does, so it can put it in front of the user) or set `ctx.acceptLossy: true` (an
 * explicit "I have read this and I am proceeding" — what a test or a CLI does).
 *
 * NOTHING IS DISCARDED WHEN THIS THROWS. The complete result, ops included, is on `.result`, so
 * a caller that catches it can still open the user's board. Refusing to open a board is worse
 * than opening it with a warning (see MigrationError above); this refuses to open it *quietly*.
 */
export class MigrationLossyError extends MigrationError {
  /** @param {Object} result the full `migrateV1` result — `.ops` is on it, nothing was dropped */
  constructor(result) {
    super(
      `migrateV1: this board cannot be migrated without loss (${result.report.losses.length} ` +
      `loss${result.report.losses.length === 1 ? '' : 'es'}), and the caller did not say what to ` +
      'do about it. Pass ctx.onLossy (a function) to receive the report, or ctx.acceptLossy: true ' +
      'to proceed anyway. The complete result — ops included — is on error.result; nothing has ' +
      `been discarded. First: ${result.warnings[0] ?? '(none)'}`,
    );
    this.name = 'MigrationLossyError';
    /** @type {{ops: Object[], warnings: string[], lossy: boolean, index: number, report: Object}} */
    this.result = result;
    this.warnings = result.warnings;
    this.report = result.report;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GENESIS  (ADR 001 §8.1)
// ─────────────────────────────────────────────────────────────────────────────

/** The wall-clock component of every migrated stamp. Zero, so migration loses to everything. */
export const GENESIS_MS = 0;

/** The largest index a GENESIS stamp can carry: pad6 is fixed width, so 999999 is the ceiling. */
export const MAX_GENESIS_INDEX = MAX_STAMP_CTR;

/**
 * The migration stamp for the entity at global index `i`.
 *
 * Deliberately NOT `'0'.repeat(13) + String(i).padStart(6,'0') + …` written out by hand: it goes
 * through `stamp.fmt`, so the width, the alphabet and the range check are the ones the rest of
 * the system uses. An index that does not fit is a loud RangeError rather than a 38-character
 * string that would silently break the fixed-width total order for every stamp in the product.
 *
 * @param {number} index 0 … 999999
 * @returns {string} a 37-char stamp
 */
export function GENESIS(index) {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`GENESIS: index must be a non-negative integer, got ${JSON.stringify(index)}`);
  }
  if (index > MAX_GENESIS_INDEX) {
    throw new RangeError(
      `GENESIS: index ${index} exceeds ${MAX_GENESIS_INDEX}; a board this large cannot be migrated ` +
      'with index-carrying stamps (ADR 001 §8.1)',
    );
  }
  return fmt(GENESIS_MS, index, ZERO_DEVICE_SHORT);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Deterministic ids
//
// ADR 001 §1.2 mints `opId` and `groupId` from a CSPRNG. Migration cannot: two migrations of the
// same file on my two Macs must not differ, and `opId` is the SERVER'S IDEMPOTENCY KEY. Deriving
// it means the second Mac's push of an op the first Mac already pushed is deduped by the server
// instead of stored twice — which is precisely the "pairing two already-migrated Macs converges
// immediately, with no spurious conflicts" property §8.1 asks for.
//
// WHAT THE DERIVATION DELIBERATELY DOES NOT INCLUDE:
//
//   * the op's `f` — the field values. `opId` is visible to the relay (ADR 001 §1.2 point 1);
//     hashing the payload into it would hand the relay a confirmation oracle for guessed note
//     text. The op body is encrypted precisely so that it cannot do that.
//   * `op.dev` — the authoring device. Including it would make the two Macs mint different ids
//     for the same migrated field, which is the whole thing we are trying to avoid.
//   * `op.act` — the acting member. THIS ONE WAS A DEFECT (M2) and is worth spelling out, because
//     including it looked like the careful choice.
//
//     Solo mode has no family and therefore no minted MemberId (§11): the id each Mac uses is a
//     local placeholder, and my two Macs do not agree on it until they pair. Feeding it into the
//     derivation made §8.1 property 2 — "two independent migrations of the same board.json are
//     BYTE-IDENTICAL" — false for the single most common configuration in the product. The
//     symptom was not a crash: the stamps still agreed, so the values still converged, but every
//     migrated register was attributed to whichever member id won an opId tiebreak, and 17.6's
//     „geändert von …" line then named the wrong person on the user's own eleven-year-old notes.
//
//     The collision that including `act` was meant to prevent is not a hazard: migration ops are
//     written to the PERSONAL space (or its placeholder), never to a shared one, so two different
//     members' migrations never meet in one space. Where they DO meet — my own two Macs — a
//     collision is precisely the goal, because `opId` is the server's idempotency key.
//
// What it DOES include, and all it includes: the global index (so a hand-edited board with two
// entries sharing an id still gets two distinct op ids), the op kind and the entity key. Every
// one of those is a function of the FILE, so the op id is too.
// ─────────────────────────────────────────────────────────────────────────────

/** The label ADR 001 §8.2 gives the migration transaction. Not the gid — `gid` is a GroupId. */
export const MIGRATION_LABEL = 'migrate:v1';

const SEP = '\u0000';

/** 22 base64url characters (128 bits) from a domain-separated SHA-256. */
function derive(domain, parts) {
  const digest = sha256(utf8([domain, ...parts].join(SEP)));
  return b64u(digest.subarray(0, 16));
}

/**
 * The single transaction group every migration op carries (ADR 001 §8.2: "one `gid` labelled
 * `migrate:v1`"). A `gid` is a 22-char GroupId by contract, so the LABEL is a label and the gid
 * is derived from it. It is constant, which is exactly right for a group that never leaves the
 * device and must never be pushed onto the undo stack.
 */
export const MIGRATION_GID = derive('lzp.migrate.gid', [MIGRATION_LABEL]);

/**
 * Every top-level key of a `board.json` this build understands. `_v2` is ADR 001 §8.4's one
 * additive key.
 *
 * EXPORTED, and `replace.js` imports it rather than declaring its own, because a key that is
 * "unknown" on one door and known on the other is precisely the two-doors defect class: the same
 * bytes would be reported as a loss through import and discarded in silence through migration
 * (RECHECK-82-6). One list, one answer, both doors.
 */
export const V1_BOARD_KEYS = Object.freeze([
  'schemaVersion', 'notes', 'bars', 'categories', 'scratchpads', 'settings', '_v2',
]);

/** @param {number} index @param {string} kind @param {string} entityKey */
function deriveOpId(index, kind, entityKey) {
  return derive('lzp.migrate.op', [MIGRATION_LABEL, String(index), kind, entityKey]);
}

/**
 * A fresh, DETERMINISTIC entity uuid for an entry whose own id is already taken (ATT-90).
 *
 * v1 tolerates two entries sharing an id — it renders both — and v2 cannot: one entity key is one
 * register set, so the second entry would LWW over the first and one of the user's entries would
 * be gone. Discarding it (the old behaviour) is the same loss with a warning attached.
 *
 * Re-keying is safe because a v1 entity id is OPAQUE: nothing outside the entry itself references
 * a note or bar id, and a category id is referenced only by `categoryId`, which keeps pointing at
 * the FIRST occurrence — exactly the category v1's own `find()` would have resolved it to.
 *
 * Derived, not minted: `crypto.randomUUID()` here would make two migrations of the same file
 * disagree, which is the R12 failure this whole module is shaped around.
 *
 * @param {string} kind @param {string} id the colliding v1 id @param {Set<string>} taken
 * @returns {string} 22 base64url characters, unused
 */
export function rekeyed(kind, id, taken) {
  for (let n = 2; n < 1000; n++) {
    const fresh = derive('lzp.migrate.rekey', [kind, id, String(n)]);
    if (!taken.has(fresh)) return fresh;
  }
  throw new MigrationError(`migrate1to2: could not find a free re-key for ${kind} ${q(id)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The field map  (ADR 001 §8.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The v1 product fields carried verbatim, per kind, in the order `FIELDS` declares them. `id` is
 * not here: in v2 the id is the ENTITY KEY, not a field (ADR 001 §1.1).
 * @type {Object<string, string[]>}
 */
export const V1_FIELDS = Object.freeze({
  note: Object.freeze(['date', 'text', 'categoryId', 'repeatsYearly']),
  bar: Object.freeze(['startDate', 'endDate', 'label', 'categoryId']),
  cat: Object.freeze(['name', 'nameEn', 'paletteRef', 'visible']),
  pad: Object.freeze(['text']),
});

/**
 * What migration adds to every entity (ADR 001 §8.2).
 *
 * `visibility: 'privat'` on every note and bar is story 16.1 stated as a constant: joining a
 * family later changes nothing about entries that already exist. There is no path here that
 * reads a category's `defaultVisibility` and publishes an old entry by inference.
 * @type {Object<string, Object>}
 */
export const V2_ADDITIONS = Object.freeze({
  note: Object.freeze({ visibility: 'privat', coEdit: false, _alive: true }),
  bar: Object.freeze({ visibility: 'privat', coEdit: false, _alive: true }),
  cat: Object.freeze({ defaultVisibility: 'privat', _alive: true }),
  pad: Object.freeze({ _alive: true }),
});

/** `_born` is written by `makeOp({born:true})` from the op's own stamp, never listed above. */
const BORN = '_born';

// ─────────────────────────────────────────────────────────────────────────────
// 3a. v1's OWN repairs (`store.js:82-88`), reproduced here — ATT-41 / ATT-14 / ATT-15
//
// v1 runs `migrate()` over EVERY board it ever loads and over every board that comes in through
// `replaceAll()` — an import (11.3) and a snapshot restore (11.5) included. Four repairs live in
// that block, and a v1 board that has been through it therefore satisfies four invariants that
// the rest of v1 relies on without checking:
//
//   1. `categories` is never empty            → `store.category(x)` never returns undefined, so
//                                                `legend.js` and `popover.js` never read
//                                                `.paletteRef` off undefined and throw.
//   2. every category has a `paletteRef`      → `colorOf(undefined)` would silently paint
//                                                everything blue instead.
//   3. no `categoryId` dangles                → an entry always has a legend row.
//   4. `settings.lastCategoryId` is live      → the next note created lands somewhere real.
//
// Core reproduced (3) and (4) — ADR 001 §5 step 7 lifts them into the PROJECTION, which is
// strictly better than v1's rewrite-on-load because it is idempotent and it survives a category
// deleted on one Mac concurrently with an entry created in it on the other. But the projection's
// repair is written `if (categories.length)`, and (1) and (2) had no home at all. A board with
// `categories: []` — every internal build before the legend shipped, and any hand-edited or
// imported file — therefore migrated into a board with no legend, no repair target and a
// `lastCategoryId` pointing at nothing, which is not a board v1 can produce or v1's UI survive.
//
// So (1) and (2) are done HERE, where a repair can still be deterministic, and (3) and (4) stay
// where §5 step 7 put them. (4) is additionally repaired here so that the LOG, not only the
// projection, carries a live id — a `pref` register is device-local and never re-derived.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `nextFreeRef([])` (`palette.js:33`) with an empty used-set is `PALETTE[0].ref`, so v1's
 * back-fill at `store.js:88` always writes exactly this one string. Held as a constant rather
 * than imported: `core/` may not depend on a v1 module (ADR 005 §1.1). `core-migrate.test.js`
 * asserts the constant still equals what v1 would compute, so the two cannot drift.
 */
export const DEFAULT_PALETTE_REF = 'blau';

/**
 * `defaultState().categories` (`store.js:19-24`) minus the four `crypto.randomUUID()` ids, which
 * migration cannot use: two migrations of the same file would then disagree (R12). The ids are
 * DERIVED instead — see `defaultCategories()`.
 */
export const V1_DEFAULT_CATEGORIES = Object.freeze([
  Object.freeze({ name: 'Arbeit', nameEn: 'Work', paletteRef: 'blau', visible: true }),
  Object.freeze({ name: 'Familie', nameEn: 'Family', paletteRef: 'gruen', visible: true }),
  Object.freeze({ name: 'Reisen', nameEn: 'Travel', paletteRef: 'orange', visible: true }),
  Object.freeze({ name: 'Deadlines', nameEn: 'Deadlines', paletteRef: 'magenta', visible: true }),
]);

/** The four defaults with deterministic ids — the same four on both of my Macs, forever. */
export function defaultCategories() {
  return V1_DEFAULT_CATEGORIES.map((c) => ({ ...c, id: derive('lzp.migrate.defaultcat', [c.name]) }));
}

/**
 * Every field of every migrated kind is accounted for exactly once. Asserted here rather than
 * only in the test file: if a later work package adds a field to `FIELDS.note`, migration must
 * be told what to do with it, and a module that fails to import is a louder signal than a board
 * that quietly migrates without it.
 */
for (const kind of Object.keys(V1_FIELDS)) {
  const declared = fieldsOf(kind).slice().sort();
  const covered = [...V1_FIELDS[kind], ...Object.keys(V2_ADDITIONS[kind]), BORN].sort();
  if (declared.join(',') !== covered.join(',')) {
    throw new MigrationError(
      `migrate1to2: FIELDS.${kind} declares [${declared}] but migration covers [${covered}]. ` +
      'A field was added to the op vocabulary without deciding what a migrated v1 board puts in it.',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Probing the real validator
//
// A hand-edited or imported board.json can carry a value v1 tolerated and v2's field table does
// not: `visible: "yes"`, a 300-character note text (v1's 80-char limit is a DOM `maxLength`
// attribute — `interact.js:466`, `popover.js:146` — and does not apply to a file), a categoryId
// that is not a string. Rather than re-implement `ops.js`'s type checks here and let the two
// copies drift, a rejected field is identified by asking the REAL constructor about it.
//
// The same oracle also decides HOW MUCH of a too-long string fits, so the 80 and the 40 are never
// written down twice — see `truncateToFit`, and ATT-82 for why a rejected `text` is truncated
// rather than dropped.
// ─────────────────────────────────────────────────────────────────────────────

const PROBE_ACT = 'mem_AAAAAAAAAAAAAAAAAAAAAA';
const PROBE_DEV = 'dev_AAAAAAAAAAAAAAAAAAAAAA';
const PROBE_ID = 'AAAAAAAAAAAAAAAAAAAAAA';
const PROBE_UUID = 'probe';
const PROBE_MONTH = '2000-01';
const probeCtx = Object.freeze({
  act: PROBE_ACT,
  dev: PROBE_DEV,
  gid: PROBE_ID,
  mint: () => GENESIS(0),
  newOpId: () => PROBE_ID,
  space: PERSONAL_PLACEHOLDER,
});
const probeKey = (kind) => {
  if (kind === 'pad') return `pad:${PROBE_MONTH}`;
  if (kind === 'pref') return 'pref:app';
  return `${kind}:${PROBE_UUID}`;
};

/**
 * Would `ops.js` accept `{[name]: value}` on this kind? Uses the real constructor, so there is
 * exactly one definition of "a legal field value" in the system.
 * @returns {boolean}
 */
function fieldAccepted(kind, name, value) {
  try {
    makeOp(probeCtx, opKindForEntity(kind), probeKey(kind), { [name]: value });
    return true;
  } catch (e) {
    if (e instanceof OpError) return false;
    throw e;
  }
}

/**
 * The longest prefix of `value` that `ops.js` accepts for this field — ATT-82 / ATT-83.
 *
 * WHY TRUNCATE AT ALL, AND WHY THIS IS NOT A CONTRACT VIOLATION. v1's 80 characters is a DOM
 * `maxLength` attribute on an input element (`interact.js:466`, `popover.js:146`). It has never
 * applied to a file, to an import, or to any build that predates that attribute, so a real
 * `board.json` can legitimately hold a 140-character note — and v1 loads it, renders it and
 * prints it. v2's `str80` is a REGISTER type and rejects it. Dropping the field then dropped the
 * note off the board entirely, because `text` is half of a note's renderability (§5 step 3): the
 * user's note did not get shorter on upgrade day, it disappeared. That is the single worst thing
 * in this file's blast radius and it is what this function exists to prevent.
 *
 * Truncating loses the tail. That is real loss, it is reported as such — the exact characters are
 * carried in the loss report so nothing is unrecoverable — but the ENTRY survives, in place, on
 * the right day, in the right category, and the user can see what happened and fix it.
 *
 * The limit is not written down here. It is discovered by asking the REAL constructor about
 * successively shorter prefixes (binary search, ~7 probes), so `ops.js` stays the only definition
 * of "a legal field value" in the system and a future `str120` needs no edit here.
 *
 * Only `str40`/`str80` fields are eligible. A malformed DATE is deliberately NOT truncated: the
 * longest accepted prefix of `'2026-01-01T09:00'` is a perfectly plausible `'2026-01-01'`, and
 * inventing a date the user never wrote is worse than dropping a value they cannot see anyway.
 *
 * @returns {{kept: string, dropped: string}|null} null when no prefix is acceptable
 */
/**
 * Per kind, the fields whose ABSENCE (or null) makes the entity unrenderable — ADR 001 §5 step 3,
 * discovered by asking the real `renderable()` rather than restating its rule.
 *
 * A null register is skipped by `materialize`, so writing `null` into one of these fields is
 * indistinguishable from never having written it, and the entry silently leaves the board. Every
 * other field may hold a null quite happily and does (`cat.nameEn`, ADR 001 §2).
 *
 * @type {Object<string, Set<string>>}
 */
const RENDER_REQUIRED = (() => {
  const out = {};
  for (const kind of ['note', 'bar']) {
    const full = {};
    for (const name of fieldsOf(kind)) {
      const spec = FIELDS[kind][name];
      if (!spec) continue;
      if (spec.t === 'date') full[name] = '2026-03-01';
      else if (spec.t === 'bool') full[name] = true;
      else if (String(spec.t).startsWith('str')) full[name] = 'x';
    }
    if (!renderable(kind, full)) continue;                 // the probe itself is broken; say nothing
    const req = new Set();
    for (const name of Object.keys(full)) {
      if (!String(FIELDS[kind][name].t).startsWith('str')) continue;
      if (!renderable(kind, { ...full, [name]: null })) req.add(name);
    }
    out[kind] = req;
  }
  return out;
})();

/**
 * A TEXT field the file holds as something other than a string, rendered the way v1 renders it.
 *
 * REG-5 / REG-6, and the same argument as ATT-82 one step further along. `truncateToFit` covers
 * the LENGTH failure only — it returns null for a non-string — so `text: 12345` and `text: null`
 * took the "drop the field" path, `text` was then absent, `renderable()` (ADR 001 §5 step 3)
 * failed, and the note was gone from the board AND from the next export. That is verbatim the
 * disaster ATT-82's own comment says it exists to prevent: "the user's note did not get shorter
 * on upgrade day, it disappeared."
 *
 * v1 keeps and draws all of them, through one expression: `popover.js:193` is `n.text || '…'`.
 * So this is that expression, and nothing more:
 *
 *   · FALSY (`null`, `0`, `false`, `''`) → `''`, which is v1's „…" and is exactly what ATT-53
 *     already established for an ABSENT text. Three spellings of "no usable text" now have one
 *     outcome instead of three.
 *   · TRUTHY non-string (`12345`, an object, an array) → `String(value)`, which is the string v1
 *     actually paints into the cell.
 *
 * TEXT FIELDS ONLY (`str`, `str40`, `str80`). A malformed DATE is still not repaired: the whole
 * reason `truncateToFit` refuses dates is that inventing one the user never wrote is worse than
 * dropping a value they cannot see anyway, and `String()` of a date-shaped object would be
 * inventing one. `_alive`, `visibility` and the rest are governed elsewhere and are never guessed.
 *
 * The original value is not lost: every caller reports it in the loss record.
 *
 * AND `null` IS NOT A NON-STRING HERE. `null` is a first-class register value (ADR 001 §2) and a
 * hand-edited `nameEn: null` is carried to the log verbatim — that is a decision this module
 * already made and it stays made. The exception is the one field where carrying it costs the
 * whole entry: `materialize` skips a null register, so a null `note.text` fails renderability and
 * the note leaves the board. Which fields those are is not written down here — it is PROBED from
 * the real `renderable()` (see `RENDER_REQUIRED`), the same way the length limit is probed from
 * the real constructor, so a later change to §5 step 3 cannot leave a stale list behind.
 *
 * @param {string} kind @param {string} name @param {unknown} value
 * @returns {{kept: string}|null} null when the field is not a text field, or already a string
 */
export function coerceToV1Text(kind, name, value) {
  if (typeof value === 'string') return null;              // `truncateToFit`'s business, not this
  if (value === undefined) return null;                    // absence is ATT-53's business
  if (value === null && !RENDER_REQUIRED[kind]?.has(name)) return null;   // null is a value (§2)
  const spec = FIELDS[kind]?.[name];
  if (!spec || (spec.t !== 'str' && spec.t !== 'str40' && spec.t !== 'str80')) return null;
  let text;
  if (!value) text = '';                                   // v1's `|| '…'` branch
  else {
    try { text = String(value); } catch { text = ''; }     // a throwing toString is a falsy result
    if (typeof text !== 'string') text = '';
  }
  // The coerced string may itself be too long for the register (an object with a long toString),
  // in which case the ATT-82 rule applies to it in turn. Only then: `truncateToFit` documents
  // that its caller has ALREADY probed the value and found it rejected, and handing it an
  // accepted string makes its binary search return the empty prefix.
  if (fieldAccepted(kind, name, text)) return { kept: text };
  const cut = truncateToFit(kind, name, text);
  return { kept: cut ? cut.kept : '' };
}

export function truncateToFit(kind, name, value) {
  if (typeof value !== 'string') return null;
  const spec = FIELDS[kind]?.[name];
  if (!spec || (spec.t !== 'str40' && spec.t !== 'str80')) return null;
  let lo = 0;                                   // known-accepted (verified below)
  let hi = value.length;                        // known-rejected (the caller already probed it)
  if (!fieldAccepted(kind, name, '')) return null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fieldAccepted(kind, name, value.slice(0, mid))) lo = mid; else hi = mid;
  }
  // Never cut between a surrogate pair: half of an emoji is not a character, it is mojibake.
  const code = value.charCodeAt(lo - 1);
  if (lo > 0 && code >= 0xd800 && code <= 0xdbff) lo -= 1;
  return { kept: value.slice(0, lo), dropped: value.slice(lo) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4b. COERCE TO v1's MEANING  (A3-H2 — the PO's decision, 2026-08-27)
//
// v2's `FIELDS` is a type table; v1 had none. Five entry shapes v1 opens, keeps and writes back
// were dropped by the type table, and — because in solo mode `board.json` IS the checkpoint — the
// drop was committed to the user's file on the first autosave and the register went with it at
// the next launch. The most user-visible instance did not even look like a loss: `repeatsYearly:
// 'yes'` is truthy in v1 so the birthday repeats, is not a boolean so v2 dropped the key, and the
// renderer then read it as falsy — a yearly entry silently became a one-off.
//
// THE RULE THIS SECTION IMPLEMENTS, and it is a decision, not a preference:
//
//   1. COERCE to what v1 MEANT by the value, never to what looks tidy. v1's meaning is read out
//      of v1's own code, and where that code still lives in this tree the coercion PROBES it
//      rather than restating it (`V1_BOOL_READING` below) — the same discipline `truncateToFit`
//      applies to the length limit and `RENDER_REQUIRED` applies to §5 step 3.
//   2. EVERY coercion is reported to the warnings channel with the entity, the field, the old
//      value and the new one. Auditable, per the decision.
//   3. A value that cannot be coerced without INVENTING meaning does not cost the ENTRY. The
//      field is quarantined — dropped, reported — and the entry stays on the board and in the
//      file. That half is enforced one module away, in `entities.js:renderableNote`.
//   4. BOTH DOORS. `replace.js` imports every function below rather than growing a second copy;
//      property P13 asserts the two doors build the same board from the same bytes, and a
//      coercion that existed on one door and not the other is precisely the class it exists for.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How v1 READS a boolean field — probed from the v1 expressions this tree still carries, because
 * the two carried booleans do not agree and guessing gets one of them wrong:
 *
 *   · `cat.visible` is `c.visible !== false` (`layout.js:111`, `legend.js:25`, `print.js:71`,
 *     v1 `store.js:901`). Only a LITERAL `false` hides a category, so `visible: 'ja'` is visible
 *     and — the one a `Boolean(v)` shortcut would get wrong — so is `visible: 0`.
 *   · `note.repeatsYearly` is plain truthiness (`layout.js:71`, `if (!n.repeatsYearly)`), so
 *     `'yes'` and `'nein'` both repeat and `0` does not.
 *
 * Neither rule is restated here: `categoryVisibilityOf` and `noteOccurrences` in `entities.js`
 * ARE those two expressions (ADR 005 §3 — one implementation per question), so the table below
 * asks them. A repeat yields one occurrence per year of the window and a one-off exactly one,
 * which is how the second probe reads its answer.
 */
const V1_BOOL_READING = Object.freeze({
  'cat.visible': (v) => categoryVisibilityOf({ categories: [{ id: 'probe', visible: v }] })('probe'),
  'note.repeatsYearly': (v) => noteOccurrences(
    [{ id: 'probe', date: '2026-03-04', repeatsYearly: v }], '2026-01-01', '2027-12-31',
  ).size > 1,
});

/**
 * A carried BOOLEAN field the file holds as something else, read the way v1 read it.
 *
 * `null` is deliberately NOT coerced. It is a legal register value, and it lands on v1's answer
 * without any help: `visible: null` is `null !== false` ⇒ visible, and a null register is skipped
 * by `materialize`, which leaves `visible` absent, which is `!== false` ⇒ visible. Same for
 * `repeatsYearly`, falsy either way. Coercing it would be motion without meaning.
 *
 * @param {string} kind @param {string} name @param {unknown} value
 * @returns {{kept: boolean}|null} null when this is not a boolean field, or nothing to do
 */
export function coerceToV1Bool(kind, name, value) {
  const spec = FIELDS[kind]?.[name];
  if (!spec || spec.t !== 'bool') return null;
  if (typeof value === 'boolean' || value === undefined || value === null) return null;
  const read = V1_BOOL_READING[`${kind}.${name}`];
  if (!read) return null;                                  // pinned by the assertion below
  return { kept: read(value) === true };
}

/**
 * A carried DATE field the file holds in a shape `FIELDS` refuses, read as the DAY IT NAMES.
 *
 * ─── why this file used to refuse, and why the refusal was wrong ───────────────────────────────
 * `truncateToFit`'s docblock says a malformed date is deliberately not repaired, because "the
 * longest accepted prefix of `'2026-01-01T09:00'` is a perfectly plausible `'2026-01-01'`, and
 * inventing a date the user never wrote is worse than dropping a value they cannot see anyway".
 * The first half of that sentence is still true and is why this is a PARSER and not a prefix; the
 * second half was measured and found false. Dropping the date did not drop "a value they cannot
 * see" — it took the whole NOTE off the board (§5 step 3) and then out of `board.json`, so the
 * user lost the text, the category and the entry along with the date they had mistyped.
 *
 * ─── what it will and will not read ────────────────────────────────────────────────────────────
 * Every shape below names exactly one day, with no assumption a reader could get wrong:
 *
 *   · `2026-3-1`, `2026-03-1`      — ISO with an unpadded field. Padding invents nothing.
 *   · `2026-01-01T09:00`           — an ISO datetime with a FLOATING time. The date part is not a
 *                                    guess, it is the date; the time is what has no register.
 *   · `4.3.2026`                   — the German form this product is written in (`i18n.js`, the
 *                                    whole `de` half). Day first, month second — the PO's board
 *                                    is a German board and `4.3.2026` is 4 March.
 *   · `2026/03/04`                 — year first, so the order is unambiguous.
 *   · `20260304` (string or number) — YYYYMMDD, eight digits, the only reading that fits.
 *
 * And what it REFUSES, because there is no single answer: `3/4/2026` (4 March in London, 3 April
 * in New York), a millisecond timestamp, `March 4th`, anything with a two-digit year. Those keep
 * the ENTRY and lose the FIELD (rule 3 above) — a note with no date is one v1 never drew either.
 *
 * ─── R4-9g / R4-9h — the two shapes this used to read WRONG rather than refuse ─────────────────
 * The ISO branch's tail was `(?:[T ].*)?$`, which is not "a time" but "anything at all", and it
 * cost the rule above its one guarantee — that every accepted shape names exactly ONE day:
 *
 *   · `2026-04-01T23:00:00-05:00` — a real instant, with a real UTC offset. In this product's
 *     timezone (Europe/Berlin; this is a German Jahresplaner) that instant is **2 April**. The
 *     offset was matched by `.*` and thrown away, so the migration silently wrote 1 April. The
 *     answer is NOT to honour it: the product's fixed constraint is that a date is a plain
 *     `YYYY-MM-DD` with no time and no zone, ever (DESIGN-DECISIONS „Datum ohne Uhrzeit"), so
 *     „welcher Tag ist das" has no answer here that does not smuggle a timezone into a file
 *     format that has none. A DESIGNATED zone (`Z`, `+HH:MM`, `-HH:MM`) is therefore refused —
 *     the entry is kept, the field is dropped, and the drop is on the warnings channel.
 *   · `2026-03-04 bis 2026-03-09` — a user typing a RANGE into a date field. `.*` swallowed
 *     „bis 2026-03-09" and produced the first day with nothing said about the rest. The tail is
 *     now a time and only a time (`hh:mm`, optional `:ss`, optional fraction), so this falls
 *     through to the refusal path with the whole value quoted back in the warning.
 *
 * The rule that decides both: a FLOATING time is a day in whatever timezone you read it in, so
 * dropping it invents nothing; an OFFSET time is a different day depending on where you stand,
 * so reading it picks one — which is the guessing this whole section exists to refuse.
 *
 * ─── R5-12d — what the tail is, stated as narrowly as it is written ────────────────────────────
 * The tail below is a wall-clock time by SHAPE — `hh:mm`, optionally `:ss`, optionally a
 * fraction — and its fields are deliberately NOT range-checked: `25:00` and `99:99:99` match.
 * Round 5 was right that "a floating wall-clock time and nothing else" claimed more than the
 * regex delivers, and the claim is corrected here rather than the regex tightened, because
 * tightening it would COST something and correcting it costs nothing:
 *
 *   · the tail is DISCARDED. Only `y`, `m` and `d` are read, and the day is then validated by
 *     `isDateString`. An impossible HOUR cannot make the day ambiguous, so `2026-03-04T25:00`
 *     still names exactly one day and the invariant this function is built on — every accepted
 *     shape names exactly ONE day — holds for it.
 *   · refusing it would drop that day. For a note the entry survives and simply is not drawn — v1
 *     drew it on no day either — but for a BAR EDGE the drop is not free at all (see
 *     `coerceToV1BarEdge`). Measured: `endDate: '2026-03-04T25:00'` is painted by v1 in exactly
 *     ONE column, and a refusal moves it to TEN. R5-12e runs both numbers.
 *
 * What the tail must NOT do is change WHICH DAY the value names, and that is why a zone
 * designator (`Z`, `±HH:MM`) and trailing prose stay refused. `R5-12d` pins the accepted
 * behaviour; the words above are now the ones the regex can keep.
 *
 * Calendar validity is NOT checked, only the format, exactly as `ops.js` checks it: v1 can hold
 * `2026-02-30` and `entities.js:reanchorRepeat` produces a Feb-29 anchor in a non-leap year ON
 * PURPOSE (ADR 001 §12.8). Refusing 30 February here would be a second, stricter date rule.
 *
 * @param {string} kind @param {string} name @param {unknown} value
 * @returns {{kept: string}|null} null when this is not a date field, or nothing can be read
 */
export function coerceToV1Date(kind, name, value) {
  const spec = FIELDS[kind]?.[name];
  if (!spec || spec.t !== 'date') return null;
  if (value === undefined || value === null || isDateString(value)) return null;

  const s = typeof value === 'string' ? value.trim()
    : (typeof value === 'number' && Number.isInteger(value) && value >= 10000101 && value <= 99991231)
      ? String(value)
      : null;
  if (s === null) return null;

  let y; let m; let d;
  let mt;
  // The tail is a wall-clock time BY SHAPE and nothing else — see R4-9g / R4-9h and R5-12d
  // above. No `Z`, no `±HH:MM`, no trailing prose: anything that could change which day the
  // value names makes the whole value unreadable rather than a prefix of one. The hour and
  // minute are not range-checked because the tail is discarded and cannot move the day.
  if ((mt = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)?$/.exec(s))) {
    [, y, m, d] = mt;
  } else if ((mt = /^(\d{1,2})\.(\d{1,2})\.(\d{4})\.?$/.exec(s))) {
    [, d, m, y] = mt;                                      // German: day first (de is the default)
  } else if ((mt = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
    [, y, m, d] = mt;
  } else {
    return null;
  }
  const kept = iso(Number(y), Number(m), Number(d));
  return isDateString(kept) ? { kept } : null;             // month 13, day 32 — refuse, do not clamp
}

/**
 * A BAR EDGE the file holds as text that names no day at all, kept as the end of the date
 * alphabet it sorts against — R5-11.
 *
 * ─── the premise finding 5 was closed on, and the half of it that is false ─────────────────────
 * `buildPatch`'s absent-field branch says „ABSENT IN v1 STAYS ABSENT IN v2", and for an absent
 * edge that is exactly right (R5-9 measures it: v1 and v2 paint the same board for all four
 * shapes). But migration does two things, not one: it also turns UNREADABLE into absent, and in
 * `layout.js:133` those are NOT the same bar.
 *
 *     if (b.endDate < mFirst || b.startDate > mLast) continue;
 *
 *   · `undefined < '2026-03-01'` is `false` — the comparison is NaN, so an ABSENT edge is never
 *     skipped and the bar runs to the horizon.
 *   · `'' < '2026-03-01'` is `true` — a STRING that sorts below the range skips EVERY column, so
 *     v1 painted the bar on no day of the year.
 *
 * Measured against the real v1 renderer: `endDate: ''`, `' '`, `'-'`, `'(offen)'`, `'0'` were all
 * painted NOWHERE by v1 and across ten columns by v2 — taking a lane from every bar the user
 * actually made in each of them — and the warning then told the user „that is exactly what v1
 * painted for it, so nothing on your board moves". The mirror is a `startDate` that sorts ABOVE
 * the range (`'zzz'`, `'unbekannt'`): invisible in v1, three columns in v2. The reason this was
 * missed is that `'irgendwann'` — the value everybody reaches for — starts with `i`, sorts ABOVE
 * `'2'`, and is one of the shapes the premise gets right.
 *
 * ─── the rule ──────────────────────────────────────────────────────────────────────────────────
 * v1 does not PARSE a bar edge, it COMPARES it. So the faithful v2 value is not "the day this
 * text means" (it means none) but "a date that sorts where this text sorted", and for the two
 * classes where such a date exists it is the end of `DATE_RE`'s alphabet (`entities.js`):
 *
 *   · below every date v2 can hold ⇒ `EARLIEST_DATE`. As an `endDate` the bar is skipped in every
 *     column, which is what v1 painted; as a `startDate` the bar begins at the near edge and is
 *     marked as continuing before it, which is also what v1 painted.
 *   · above every date v2 can hold ⇒ `LATEST_DATE`. As a `startDate` the bar is skipped in every
 *     column; as an `endDate` it runs to the far edge and is marked as continuing past it — which
 *     is the one shape the absent edge already reproduced, EXCEPT for the continuation chevron
 *     and `col.horizon` (`layout.js:148,151,260`), which an absent edge does not raise and a
 *     string above the range does.
 *
 * ─── what it deliberately does NOT touch ───────────────────────────────────────────────────────
 *   · NOTES. `layout.js:61-79` puts a note on a day by MAP EQUALITY, never by `<`, so every
 *     non-date key — absent, `''` and `'zzz'` alike — lands on no day. Absent already reproduces
 *     v1 there, and a substitute would be worse than motion without meaning: a note with an
 *     invented date and `repeatsYearly` set would be EXPANDED into the window (`layout.js:72`)
 *     and appear on a day the user never wrote.
 *   · NON-STRINGS. `42 < '2026-03-01'` is `false`, and so is every other comparison a number, a
 *     boolean or an object makes — a non-string edge behaves in `layout.js` exactly like an
 *     absent one, so dropping it is already faithful and there is nothing to substitute.
 *   · A VALUE THAT SORTS INSIDE THE RANGE. `'1.3'`, `'2026-03-04 bis 2026-03-09'` — these sort
 *     between two real dates, and no date v2 can hold sorts where they do. They keep today's
 *     behaviour (the field is dropped, the bar runs to the horizon) and the drop is reported with
 *     a warning that does NOT claim v1 painted the same thing, because for this class it did not.
 *     See `gridPlacementWarning` and the register entry.
 *
 * The substituted value is written to `board.json` — that is the point of it — so it is a
 * `loss`-reported COERCION, with the original text quoted back, exactly like every other entry in
 * §4b. It is not an invention of a day the user meant: it is the position their text occupied.
 *
 * @param {string} kind @param {string} name @param {unknown} value
 * @returns {{kept: string, side: 'below'|'above', why: string}|null}
 */
export function coerceToV1BarEdge(kind, name, value) {
  if (kind !== 'bar' || (name !== 'startDate' && name !== 'endDate')) return null;
  const spec = FIELDS[kind]?.[name];
  if (!spec || spec.t !== 'date') return null;             // pinned by the assertion below
  if (typeof value !== 'string' || isDateString(value)) return null;
  const side = value < EARLIEST_DATE ? 'below' : value > LATEST_DATE ? 'above' : null;
  if (side === null) return null;
  const kept = side === 'below' ? EARLIEST_DATE : LATEST_DATE;
  const hides = (name === 'endDate') === (side === 'below');
  const painted = hides
    ? 'so v1 skipped this bar in EVERY column (layout.js:133) and painted it on no day of the year'
    : (name === 'endDate'
      ? 'so v1 ran this bar to the FAR EDGE of the visible year and marked it as continuing past '
        + 'it (layout.js:135,148)'
      : 'so v1 began this bar at the NEAR EDGE of the visible year and marked it as continuing '
        + 'before it (layout.js:134,147)');
  return {
    kept,
    side,
    why: `field ${q(name)} = ${q(value)} names no day at all, so v2 cannot store it — but v1 did `
      + `not read a bar edge, it COMPARED it, and this text sorts ${side === 'below' ? 'BEFORE' : 'AFTER'} `
      + `every date v2 can hold, ${painted}. It was kept as ${q(kept)}, the `
      + `${side === 'below' ? 'earliest' : 'latest'} date v2 can hold — the one value that sorts `
      + `where your text sorted against every month the grid can show, so that v2 paints what v1 `
      + `painted. Dropping it would have ${hides
        ? 'run the bar across the year and taken a lane from every bar you made in it'
        : 'lost the continuation marker v1 drew'} (R5-11)`,
  };
}

/**
 * Both carried bar edges are `date` fields, asserted at load for the same reason
 * `V1_BOOL_READING` is: `coerceToV1BarEdge` reasons about `layout.js:133`'s STRING comparison,
 * and a field that stopped being a date would silently stop being reasoned about.
 */
for (const name of ['startDate', 'endDate']) {
  if (FIELDS.bar?.[name]?.t !== 'date') {
    throw new MigrationError(
      `migrate1to2: bar.${name} is not a date field; coerceToV1BarEdge reasons about the string `
      + 'comparison layout.js:133 makes on exactly these two fields (R5-11).',
    );
  }
}

/**
 * A v1 entity id, or a `categoryId` reference, that is not a STRING but names one.
 *
 * v1 compares ids with `===` and builds `new Set(categories.map((c) => c.id))`, so a numeric
 * `id: 42` works perfectly well in v1 as long as everything that points at it is also the number
 * 42. v2's `ENTITY_UUID_RE` and the `id` field type both want a string. `String(42)` is the same
 * token, and it is applied to the ENTITY id and to the `categoryId` that references it alike —
 * which is what keeps the note in the category v1 had it in. Applying it to only one of the two
 * would silently re-parent every entry in that category to the fallback (§5 step 7).
 *
 * Refused for anything whose string form is not a legal id — an object, an empty string, a `/`
 * or `:` (the family-key separators, ADR 001 §4.4). Those go to `mintedId` instead, which is a
 * different answer to a different question: this one PRESERVES a reference, that one REPLACES a
 * missing token.
 *
 * @param {unknown} value @returns {{kept: string}|null}
 */
export function coerceToV1Id(value) {
  if (typeof value === 'string' || value === undefined || value === null) return null;
  if (typeof value !== 'number' && typeof value !== 'boolean') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const kept = String(value);
  return isEntityUuid(kept) ? { kept } : null;
}

/**
 * A deterministic id for an entry that arrives WITHOUT a usable one (A3-H2).
 *
 * The old comment on `entityIdOf` said an id must never be invented here, because it would have
 * to come either from the content (two identical entries would collide) or from a CSPRNG (two
 * migrations of the same file would differ, R12). Both hazards are real and neither one argues
 * for DROPPING the entry, which is what the code did: v1 keeps an id-less note in its array and
 * paints it, so the drop is a note the user could see before the upgrade and cannot see after it.
 *
 * So the id is derived from the entry's CONTENT plus an occurrence counter, and the collision the
 * first hazard names is the very thing the counter resolves: two byte-identical id-less notes are
 * two notes, they get `n = 1` and `n = 2`, and both survive. Both doors walk the same collections
 * in the same order over the same file, so both hand the same entry the same `n` — which is what
 * P13 needs and what a CSPRNG could never give.
 *
 * `canonicalJSON` sorts keys, so the id does not depend on the order the file was written in. A
 * value it refuses (a float, an unpaired surrogate, a cycle) is not a reason to fail: the shape
 * degrades to a constant and the counter carries the whole distinction.
 *
 * @param {string} kind @param {Object} entry @param {Set<string>} taken ids already used
 * @returns {string} 22 base64url characters, unused
 */
export function mintedId(kind, entry, taken) {
  let shape;
  try { shape = canonicalJSON(entry); } catch { shape = ' unserialisable'; }
  for (let n = 1; n < 1000; n++) {
    const fresh = derive('lzp.migrate.mintid', [kind, shape, String(n)]);
    if (!taken.has(fresh)) return fresh;
  }
  throw new MigrationError(`migrate1to2: could not mint a free id for an id-less ${kind}`);
}

/**
 * WHERE THE GRID PUTS THIS ENTRY — the warning, stated in terms that are true of the renderer
 * that is actually shipping (R4-10, round 4).
 *
 * ─── why this replaced `notDrawnReason` outright ───────────────────────────────────────────────
 * The old function answered one question — "is anything missing?" — and its caller wrapped the
 * answer in one sentence: „… is on the board but will not be DRAWN on any day". Round 4 measured
 * that sentence against `src/js/layout.js`, which is the same file in both builds and is the only
 * oracle that can answer "where did v1 paint this", and it is FALSE for every bar it was written
 * about:
 *
 *   · a bar with only a `startDate` is painted in NINE column-segments (its start to the far
 *     edge of the visible year), not zero;
 *   · a bar with only an `endDate` in FOUR;
 *   · a bar with NEITHER is painted as a full-height stripe in ALL TWELVE columns, and takes a
 *     lane from every other bar while it is at it (`layout.js:50`, where `undefined` clashes with
 *     everything).
 *
 * A warning that says an entry is invisible when the renderer draws it twelve times is worse than
 * no warning: it is the only thing the user is told, and it tells them to go looking for
 * something that is in front of them. So each shape now describes what the user will SEE.
 *
 * NOT `lossy`, on every branch: the entry is on the board, in the file and in every export, and
 * it is drawn exactly where v1 drew it. Nothing was lost; something needs explaining.
 *
 * ─── R5-11 — the sentence that was false for a whole class, and the two things that fixed it ───
 * The tail below („that is exactly what v1 painted for it … nothing on your board moves") is true
 * of an edge the file never carried, and it was printed for an edge the file carried and this
 * module DROPPED. Those are different bars in `layout.js:133`: an absent edge is a NaN comparison
 * and runs to the horizon; a dropped one may have been a string v1 compared and skipped in every
 * column. Two changes, together:
 *
 *   1. the class where a faithful value EXISTS no longer reaches this function with a hole in the
 *      patch at all — `coerceToV1BarEdge` writes the end of the date alphabet the text sorted
 *      against, and the new „NOT DRAWN" branch below explains what that value does;
 *   2. the class where it does not (`'1.3'` — a text that sorts between two real dates) still
 *      arrives here as a missing edge, and is now told apart from an absent one by `dropped`, so
 *      the v1-fidelity claim is made only where it is true.
 *
 * @param {'note'|'bar'} kind
 * @param {string} singular the noun for the message („note", „bar")
 * @param {string} id       the entity id, for the message
 * @param {Object} patch    the patch built so far — the fields that will actually reach the log
 * @param {Set<string>|null} [dropped] field names the file CARRIED and this door could not store.
 *        Absent from the file and dropped by the door look identical in `patch` and are different
 *        bars on the grid, so the door has to say which one it is. Omitted ⇒ nothing was dropped.
 * @returns {string|null} the complete warning, or null when the entry lands the ordinary way
 */
export function gridPlacementWarning(kind, singular, id, patch, dropped = null) {
  const who = `${singular} ${q(id)}`;
  const wasDropped = (name) => !!dropped && dropped.has(name);
  if (kind === 'note') {
    if (isDateString(patch.date)) return null;
    return `${who} is on the board but will not be DRAWN on any day: it has no date, so no day row `
      + 'can hold it — v1 kept it in the file and did not draw it either. It is on the board and '
      + 'in every export; give it a date and it appears';
  }
  if (kind !== 'bar') return null;
  const hasStart = isDateString(patch.startDate);
  const hasEnd = isDateString(patch.endDate);
  // R5-11. Both edges are present and the bar is still painted NOWHERE, because one of them is
  // the end of the alphabet `layout.js:133` compares against. Stated as a fact about the VALUE,
  // not about how it got there: a file that carries `endDate: "0000-01-01"` by hand is the same
  // bar, and v1 skipped that one in every column too.
  if (hasStart && hasEnd && (patch.endDate === EARLIEST_DATE || patch.startDate === LATEST_DATE)) {
    const which = patch.endDate === EARLIEST_DATE
      ? `its end date is ${q(EARLIEST_DATE)}, the earliest date v2 can hold, and layout.js:133 `
        + 'skips a bar in every column whose month begins after that end'
      : `its start date is ${q(LATEST_DATE)}, the latest date v2 can hold, and layout.js:133 skips `
        + 'a bar in every column whose month ends before that start';
    return `${who} is NOT DRAWN on any day: ${which} — which is every month of the grid except the `
      + 'one containing that date. It is on the board and in every export; give it dates inside '
      + 'the year you want to see and it appears';
  }
  if (hasStart && hasEnd) return null;
  const tail = (wasDropped('startDate') || wasDropped('endDate'))
    // R5-11, the class with no faithful value: the text sorted BETWEEN two real dates, so v1
    // placed the bar by comparing it and v2 cannot. Nothing is claimed about v1 here, because
    // depending on the text v1 drew more of the year than this, or none of it.
    ? 'v1 did not read that text as a date either — it COMPARED it against the first and last day '
      + 'of each month (layout.js:133-135) and drew the bar wherever the comparison let it '
      + 'through. v2 cannot store the text, so where the bar lands is no longer decided by it. '
      + 'Give it'
    : 'That is exactly what v1 painted for it (layout.js:133-135), so nothing on your '
      + 'board moves — but it is not what you probably meant. Give it';
  if (!hasStart && !hasEnd) {
    return `${who} IS DRAWN, and it is drawn EVERYWHERE: it has no date at either end, so it has `
      + 'no span, and it is painted as a full-height stripe down all twelve columns — taking a '
      + `lane from every other bar in every month. ${tail} two dates and it lands where you want it`;
  }
  if (!hasEnd) {
    return `${who} IS DRAWN from ${q(patch.startDate)} to the FAR EDGE of the visible year, and `
      + 'the far edge moves with today: it has no endDate, so it has no end. '
      + `${tail} an end date and it stops where you want it`;
  }
  return `${who} IS DRAWN from the NEAR EDGE of the visible year to ${q(patch.endDate)}, and the `
    + 'near edge moves with today: it has no startDate, so it has no beginning. '
    + `${tail} a start date and it begins where you want it`;
}

/**
 * Every carried boolean has a v1 reading, asserted at load. A field added to `FIELDS` later
 * without one would otherwise be coerced by whatever `coerceToV1Bool` happened to fall through
 * to, which is exactly the guessing this section exists to prevent.
 */
for (const kind of Object.keys(V1_FIELDS)) {
  for (const name of V1_FIELDS[kind]) {
    if (FIELDS[kind][name].t !== 'bool') continue;
    if (V1_BOOL_READING[`${kind}.${name}`]) continue;
    throw new MigrationError(
      `migrate1to2: ${kind}.${name} is a carried boolean with no entry in V1_BOOL_READING. ` +
      'How v1 read it has to be established from v1, not guessed at the door (A3-H2).',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. migrateV1
// ─────────────────────────────────────────────────────────────────────────────

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A v1 entity id, escaped for a warning message. */
const q = (v) => JSON.stringify(v);

/**
 * @typedef {Object} MigrateCtx
 * @property {string} memberId            the acting member — `op.act`
 * @property {string} deviceId            the authoring device — `op.dev`. The ONLY part of the
 *                                        output that legitimately differs between two Macs.
 * @property {string} [deviceShort]       accepted and validated, but NOT used: migration stamps
 *                                        carry the all-zeros device short by construction (§8.1).
 * @property {(report: Object) => void} [onLossy]  called with the migration report IF, and only
 *                                        if, the board could not be migrated without loss. A
 *                                        migration that loses something may not complete
 *                                        silently: without this (or `acceptLossy`) migrateV1
 *                                        THROWS `MigrationLossyError`, which carries the whole
 *                                        result on `.result` so nothing is lost by the throw.
 * @property {boolean} [acceptLossy]      "I know it is lossy, proceed and return normally."
 *                                        For tests and tools; the app passes `onLossy`.
 * @property {string} [personalSpaceId]   a `psp_…` id. Omitted in solo mode, where there is no
 *                                        personal space and no key, so the ops carry the
 *                                        `'personal'` placeholder and are rewritten the first
 *                                        time a personal space is created (ADR 001 §8.2, §11).
 */

/**
 * v1 `board.json` → v2 ops. PURE and DETERMINISTIC: for a given `(v1board, ctx)` the output is
 * byte-identical on every machine, every run, forever.
 *
 * The intended input is a board that has already been through v1's own `migrate()`
 * (`store.js:60`). A rawer board — an import, a snapshot payload, a hand-edited file, a pre-v1
 * build — is accepted and migrates just as well: every field is taken defensively, anything that
 * cannot be represented produces a warning rather than an exception, and v1's four load-time
 * REPAIRS are reproduced here rather than assumed to have already run (§3a above). The four ids
 * v1 mints with `crypto.randomUUID()` for its default categories are DERIVED instead, because a
 * random id would make two migrations of the same file differ (R12) — which is why the repair
 * used to be skipped, and why skipping it was wrong.
 *
 * Loss is possible (a 300-character note text cannot fit in an 80-character register) and it is
 * REPORTED, never silent: see `MigrationLossyError` and `ctx.onLossy`.
 *
 * @param {Object} v1board
 * @param {MigrateCtx} ctx
 * @returns {{ops: Object[], warnings: string[], lossy: boolean, index: number, report: Object}}
 * @throws {MigrationLossyError} when the migration lost something and the caller neither passed
 *         `ctx.onLossy` nor set `ctx.acceptLossy` — the full result is on `error.result`.
 */
export function migrateV1(v1board, ctx) {
  const { act, dev, space } = checkCtx(ctx);

  if (!isPlainObject(v1board)) {
    throw new MigrationError(`migrateV1: expected a parsed board object, got ${q(v1board)}`);
  }
  // ADR 001 §8.4 — "Idempotent. Migration keys off `schemaVersion === 1 && !opsLogExists()`.
  // Running it twice is refused, loudly." The half of that predicate this pure function can see
  // is the schema version; the op-log half belongs to the caller (`shouldMigrate` below).
  const sv = v1board.schemaVersion;
  if (sv !== undefined && sv !== null) {
    if (!Number.isInteger(sv)) {
      throw new MigrationError(`migrateV1: schemaVersion must be an integer, got ${q(sv)}`);
    }
    if (sv >= 2) {
      throw new MigrationError(
        `migrateV1: board is already at schemaVersion ${sv}; migrating it again would re-stamp ` +
        'every field at GENESIS and discard every edit made since (ADR 001 §8.4)',
      );
    }
  }

  const warnings = [];
  const losses = [];
  const repairs = [];
  let lossy = false;
  const ops = [];
  let index = 0;

  /** The op-building ctx. `mint` and `newOpId` are read once each, in that order, by `makeOp`. */
  let cursor = { kind: '', key: '' };
  const opCtx = {
    act,
    dev,
    gid: MIGRATION_GID,
    space,
    mint: () => GENESIS(index),
    newOpId: () => deriveOpId(index, cursor.kind, cursor.key),
  };

  /** Build one op at the current index, then advance. Returns the op, or null if it was dropped. */
  const emit = (kind, key, build) => {
    cursor = { kind, key };
    const op = build(opCtx);
    // Belt and braces: if `makeOp`'s call order ever changed, the stamp/index correspondence —
    // the single thing this module exists to guarantee — would break silently.
    if (op.ts !== GENESIS(index)) {
      throw new MigrationError(`migrate1to2: op ${op.e} was stamped ${op.ts}, expected ${GENESIS(index)}`);
    }
    ops.push(op);
    index += 1;
    return op;
  };

  const warn = (msg, isLossy) => {
    warnings.push(msg);
    if (isLossy) lossy = true;
  };

  /**
   * Something the user had is not in the ops. Recorded STRUCTURALLY as well as in prose, because
   * a warning string is for a person and the report is for the store: `detail.dropped` carries
   * the exact characters a truncation cut, so „nichts geht verloren" (principle 6) survives even
   * the one case where the register cannot hold what the file held.
   */
  const loss = (msg, where, field, reason, detail) => {
    warn(msg, true);
    losses.push(Object.freeze({ where, field, reason, ...detail }));
  };

  /** v1's own `migrate()` would have done this. Not a loss, and NOT lossy — but not silent. */
  const repair = (msg, what) => {
    warnings.push(msg);
    repairs.push(Object.freeze({ what, message: msg }));
  };

  // ── the patch builder, shared by note / bar / cat / pad ────────────────────
  //
  // The field ORDER is `FIELDS[kind]`'s declaration order, so the JSON bytes of an op are a
  // function of the vocabulary and not of the order somebody happened to write a literal in.
  //
  // `dropped` is an OUT-parameter, not a return value, because the only caller that needs it is
  // the one that also needs the patch, and threading a second return through four call sites for
  // one of them is how the two doors drift. It collects the fields the FILE CARRIED and this door
  // could not store — which `gridPlacementWarning` cannot tell from a field the file never had,
  // and which is a different bar on the grid (R5-11).
  const buildPatch = (kind, entry, where, dropped = new Set()) => {
    const add = V2_ADDITIONS[kind];
    const carried = V1_FIELDS[kind];
    const f = {};
    for (const name of fieldsOf(kind)) {
      if (name === BORN) continue;                       // written by makeOp from the op's stamp
      if (Object.prototype.hasOwnProperty.call(add, name)) {
        f[name] = add[name];
        continue;
      }
      if (!carried.includes(name)) continue;             // unreachable — pinned by the check above
      let value = entry[name];
      if (value === undefined) {
        // ATT-53. `text` is the one absent field that changes whether the entity is on the board
        // at all: §5 step 3 makes a note with no `text` unrenderable, while v1 renders it as „…"
        // (`popover.js:193`, `n.text || '…'`) and gives it a line. `''` renders as „…" in v1 too,
        // so migrating the absence AS an empty string is what preserves v1's rendering exactly —
        // and it is not an invention, because `''` is the value v1's own inline create writes.
        if (kind === 'note' && name === 'text') {
          value = '';
        } else {
          // ABSENT IN v1 STAYS ABSENT IN v2 — including a bar edge, R4-10.
          //
          // This branch used to ANCHOR a one-ended bar to the edge the file did carry, on the
          // reasoning that a bar needs both ends to be drawn at all. Two things were wrong with
          // it, and round 4's oracle found both:
          //
          //   1. THE PREMISE EXPIRED. `entities.js:renderableBar` already keeps an OWN bar with
          //      no dates at all, precisely so that `layout.js` — the same file in both builds —
          //      can paint it the way it always did. A one-ended bar needed no rescue.
          //   2. THE RESCUE WAS A REGRESSION. v1 paints `{startDate: '2026-04-10'}` from 10 April
          //      to the far edge of the window: NINE column-segments. The anchor turned that into
          //      ONE DAY — and wrote an `endDate` into the user's `board.json` that the file never
          //      carried, which in solo mode (where `board.json` IS the checkpoint) is permanent
          //      at the first autosave.
          //
          // Leaving the edge absent reproduces v1 exactly, invents nothing, reads no clock, and
          // makes `board.json` a FIXED POINT for this shape instead of rewriting it. The horizon
          // is not migrated because it is not DATA: it is what `layout.js` does with an absent
          // edge, and it does it in v2 too. `gridPlacementWarning` tells the user what they will
          // see; nothing is lost, so nothing here is a `loss`.
          continue;
        }
      }
      {
        // BEFORE `fieldAccepted`, on purpose. A literal `null` in a v1 file PASSES validation —
        // `null` is a legal register value, the one that means "cleared" — so `text: null` used
        // to be written as a cleared register, which `materialize` skips, which makes the note
        // unrenderable, which takes it off the board (REG-6). In a v1 FILE there is nothing to
        // clear: `null` there just means "no text", and v1 draws „…" for it exactly as it does
        // for an absent one (ATT-53). Same field, same meaning, same outcome.
        const coerced = coerceToV1Text(kind, name, value);
        if (coerced) {
          // REG-5 / REG-6 — see `coerceToV1Text`. v1 renders this; dropping it deletes the note.
          loss(
            `${where}: field ${q(name)} is ${typeof value === 'object' && value !== null ? 'an object' : q(value)}, `
            + `which v2 cannot store; it was kept as the text v1 paints for it (${q(coerced.kept)}) `
            + 'rather than dropped, which would have removed the entry from the board',
            where, name, 'coerced', { value, kept: coerced.kept },
          );
          f[name] = coerced.kept;
          continue;
        }
      }
      if (!fieldAccepted(kind, name, value)) {
        const cut = truncateToFit(kind, name, value);
        if (cut) {
          // ATT-82 / ATT-83 — TRUNCATE, never drop. Dropping `text` deletes the note from the
          // board; dropping `label` leaves the user's bar unnamed. Both are silent on a file the
          // original of which is gone the moment migration succeeds.
          loss(
            `${where}: field ${q(name)} is ${value.length} characters and v2 stores at most ` +
            `${cut.kept.length}; it was TRUNCATED, not dropped (${cut.dropped.length} character` +
            `${cut.dropped.length === 1 ? '' : 's'} cut — they are in the migration report). ` +
            "v1's limit was a DOM maxLength and never applied to a file",
            where, name, 'truncated', { kept: cut.kept, dropped: cut.dropped },
          );
          f[name] = cut.kept;
          continue;
        }
        // R5-11 — BEFORE `coerceToV1Date`, and the order is load-bearing. `coerceToV1Date` trims,
        // so `" 2026-03-04"` reads as a perfectly good date there — and a leading space is
        // exactly the class this branch exists for: v1 compared the raw text, it sorted below
        // every month, and v1 painted the bar nowhere. The edge rule sees the untrimmed value and
        // gets the first word.
        const asEdge = coerceToV1BarEdge(kind, name, value);
        if (asEdge) {
          loss(`${where}: ${asEdge.why}`, where, name, 'coerced',
            { value, kept: asEdge.kept, side: asEdge.side });
          f[name] = asEdge.kept;
          continue;
        }
        // A3-H2 — COERCE TO v1's MEANING (§4b). Each of these reads the value the way v1's own
        // code read it; each is reported with the old value and the new one.
        const asV1 = coerceToV1Bool(kind, name, value)
          ?? coerceToV1Date(kind, name, value)
          ?? (FIELDS[kind][name].t === 'id' ? coerceToV1Id(value) : null);
        if (asV1) {
          loss(
            `${where}: field ${q(name)} = ${q(value)} is not a v2 ${FIELDS[kind][name].t}; v1 read `
            + `it as ${q(asV1.kept)} and it was COERCED to that rather than dropped`,
            where, name, 'coerced', { value, kept: asV1.kept },
          );
          f[name] = asV1.kept;
          continue;
        }
        // A bar edge that cannot be READ *and* cannot be POSITIONED is the last stop, and R5-11
        // narrowed it to what it can honestly hold: a text that sorts BETWEEN two real dates
        // (`'1.3'`, `'2026-03-04 bis 2026-03-09'`). Everything that sorts outside the alphabet
        // was taken by `coerceToV1BarEdge` above, because for those v1's rendering IS
        // reproducible; for these it is not, since no date v2 can hold sorts where the text does.
        // The drop is recorded so `gridPlacementWarning` does not tell the user that v1 painted
        // the same thing — it is the one class where that sentence was false (R5-11b).
        dropped.add(name);
        loss(
          `${where}: field ${q(name)} = ${q(value)} is not representable in v2 and the FIELD was ` +
          'DROPPED (hand-edited or imported board.json). The entry itself is kept',
          where, name, 'dropped', { value },
        );
        continue;
      }
      f[name] = value;
    }
    // A3-H2 — the one coercion that has to see the whole patch. v1 expands a repeating note with
    // `Number(n.date.slice(0, 4))` (`layout.js:72`), which THROWS on a note whose date is missing
    // or unreadable and takes the entire board down with it: there is no v1 rendering of that
    // shape to preserve, only a v1 crash. So the flag follows the anchor. `entities.js`
    // additionally refuses to project such an entry, so a hand-written op cannot recreate it.
    if (kind === 'note' && f.repeatsYearly === true && !isDateString(f.date)) {
      loss(
        `${where}: it is marked as repeating yearly and has no usable date to repeat FROM; v1 `
        + 'cannot draw that board at all (layout.js:72 throws), so the repeat was turned off and '
        + 'the entry kept. Give it a date and switch the repeat back on',
        where, 'repeatsYearly', 'coerced', { value: true, kept: false },
      );
      f.repeatsYearly = false;
    }
    // Anything v1 carried that v2 has no register for. v1's own migrate() keeps unknown keys on
    // an entry object verbatim (`store.js:71-74` copies the arrays wholesale), so this really can
    // happen, and losing it silently would be exactly the "nothing is ever lost" violation the
    // product's principle 6 forbids.
    for (const name of Object.keys(entry)) {
      if (name === 'id' || carried.includes(name)) continue;
      loss(`${where}: unknown v1 field ${q(name)} has no v2 register and was DROPPED`,
        where, name, 'unknown-field', { value: entry[name] });
    }
    return f;
  };

  // ── 0. whole sections this build has no register for ──────────────────────
  //
  // RECHECK-82-6. `replace.js` has always reported these and migration did not, which made the
  // asymmetry worst exactly where it hurts most: after a successful migration the v1 file is no
  // longer the board, so a `holidays` or `customLayers` section discarded here is discarded for
  // good — and with `lossy` false, `MigrationLossyError` never fires and nobody is asked.
  //
  // It is a LOSS, not a repair: v1's own `migrate()` keeps an unknown top-level key on the state
  // object (`store.js:69-76` rebuilds the six it knows, and the export writes back whatever the
  // state carries), so a section this build drops is a section the user really had.
  for (const key of Object.keys(v1board)) {
    if (V1_BOARD_KEYS.includes(key)) continue;
    loss(`the board carries an unknown top-level key ${q(key)}; it has no v2 register and was DROPPED`,
      'board', key, 'unknown-section', { value: v1board[key] });
  }

  // ── 1. categories ─────────────────────────────────────────────────────────
  // First, because `categories[0]` is v1's dangling-reference fallback (`store.js:84`) and §5
  // step 7 resolves it by `(_born asc, id asc)` — so the category the fallback picks after
  // migration is the same one v1 picked before it.
  const categories = takeArray(v1board.categories, 'categories', loss);
  const catIds = new Set();
  const emitCat = (c, id, where) =>
    emit('cat', `cat:${id}`, (o) => catSet(o, id, buildPatch('cat', c, where), { born: true }));

  for (const c of categories) {
    let id = entityIdOf(c, 'cat', 'category', catIds, repair);
    if (catIds.has(id)) {
      // Two registers cannot share an entity key: the second would LWW over the first. v1
      // tolerates duplicate ids in an array and renders both, so discarding the second was a
      // category the user could see before the upgrade and cannot see after it (ATT-90).
      const fresh = rekeyed('cat', id, catIds);
      repair(
        `category ${q(id)} appears more than once; the second copy was RE-KEYED to ${q(fresh)} ` +
        'so that both survive (a v1 id is opaque; nothing else refers to it)',
        'rekeyed',
      );
      id = fresh;
    }
    let entry = c;
    if (!c.paletteRef) {
      // v1's `store.js:88` back-fill, verbatim: `nextFreeRef([])` is always `PALETTE[0].ref`.
      // Without it the legend row and every entry in this category paint with `colorOf(undefined)`.
      entry = { ...c, paletteRef: DEFAULT_PALETTE_REF };
      repair(`category ${q(id)} had no paletteRef; back-filled with ${q(DEFAULT_PALETTE_REF)} (v1 store.js:88)`, 'paletteRef');
    }
    catIds.add(id);
    emitCat(entry, id, `category ${q(id)}`);
  }

  // ATT-15 / ATT-41 — v1's `store.js:73` substitutes `defaultState().categories` for an empty
  // list, and every other v1 site is written as if that substitution has already happened:
  // `store.category()` never returns undefined, so `legend.js` and `popover.js` read `.paletteRef`
  // off it without a guard. A board that migrates with NO categories is therefore not merely
  // degraded, it is a board the v1 UI throws on — and there is nothing for §5 step 7 to repair
  // the dangling `categoryId`s to either. The reason this was not done before is real (the four
  // v1 ids come from `crypto.randomUUID()` and would break R12) and the answer is to DERIVE them,
  // not to skip the repair.
  if (catIds.size === 0) {
    for (const c of defaultCategories()) {
      catIds.add(c.id);
      emitCat(c, c.id, `default category ${q(c.name)}`);
    }
    repair(
      categories.length
        ? 'no category in the file was usable; v1\'s four default categories were substituted (store.js:73)'
        : 'board carries no categories; v1\'s four default categories were substituted (store.js:73)',
      'defaultCategories',
    );
  }
  /** v1's dangling-reference fallback (`store.js:84`): the FIRST category, after the sort. */
  const fallbackCatId = ops.length ? ops[0].e.slice('cat:'.length) : null;

  // ── 2. notes ──────────────────────────────────────────────────────────────
  const seen = { note: new Set(), bar: new Set() };
  for (const [kind, list, plural] of [
    ['note', takeArray(v1board.notes, 'notes', loss), 'note'],
    ['bar', takeArray(v1board.bars, 'bars', loss), 'bar'],
  ]) {
    for (const entry of list) {
      let id = entityIdOf(entry, kind, plural, seen[kind], repair);
      if (seen[kind].has(id)) {
        // ATT-90 again: v1 renders both, so both must survive. The re-key is derived, so two
        // migrations of the same file give the duplicate the same new id.
        const fresh = rekeyed(kind, id, seen[kind]);
        repair(
          `${plural} ${q(id)} appears more than once; the second copy was RE-KEYED to ${q(fresh)} ` +
          'so that both survive (a v1 id is opaque; nothing else refers to it)',
          'rekeyed',
        );
        id = fresh;
      }
      seen[kind].add(id);
      const dropped = new Set();
      const patch = buildPatch(kind, entry, `${plural} ${q(id)}`, dropped);
      // A3-H2. This used to read "will not be renderable after migration", and it was a LOSS,
      // because the projection refused such an entry and it left the board and then the file.
      // It no longer leaves anything: `entities.js:renderableNote` keeps an own entry in the
      // ARRAY the way v1's `state.notes` did, and `renderableBar` does the same for a bar with
      // one edge or none. What remains true is that the grid places it somewhere the user did not
      // ask for — which is exactly what v1 did with it too — so it is reported, in the words
      // `gridPlacementWarning` works out from the patch, and it is NOT lossy: nothing the user
      // could see in v1 is missing in v2. (R4-10d: the sentence used to be false for three of the
      // four bar shapes it was written about.)
      const placement = gridPlacementWarning(kind, plural, id, patch, dropped);
      if (placement) warn(placement, false);
      const set = kind === 'note' ? noteSet : barSet;
      emit(kind, `${kind}:${id}`, (o) => set(o, id, patch, { born: true }));
    }
  }

  // ── 3. scratchpads ────────────────────────────────────────────────────────
  // ADR 001 §8.2: "one `pad.set` per NON-EMPTY scratchpad key". v1 deletes the key when the text
  // is blank (`interact.js:619,634`), so an empty value only reaches us from a hand-edited file
  // or an import; migrating it would create a live-but-blank pad register that v1 never had.
  //
  // M1 — the keys are walked SORTED, not in the parsed file's own order. `Object.keys()` order
  // is the order the JSON happened to be written in, and it fed the index counter: the same three
  // pads written in a different order produced different `_born` stamps and different op ids, so
  // ADR 001 §8.1 property 2 („two independent migrations of the same board.json are
  // byte-identical") did not hold for a board that had been through an editor, a re-export or any
  // other whole-file rewrite. The settings patch below was already sorted for exactly this
  // reason; the pads were the one place the same one-line rule had not been applied.
  const pads = isPlainObject(v1board.scratchpads) ? v1board.scratchpads : {};
  if (v1board.scratchpads !== undefined && !isPlainObject(v1board.scratchpads)) {
    loss(`scratchpads is not an object (${q(typeof v1board.scratchpads)}); treated as empty`,
      'scratchpads', null, 'dropped', { value: v1board.scratchpads });
  }
  for (const month of Object.keys(pads).sort()) {
    const text = pads[month];
    if (!isMonthKey(month)) {
      loss(`scratchpad key ${q(month)} is not YYYY-MM and was DROPPED`,
        `scratchpad ${q(month)}`, null, 'dropped', { value: text });
      continue;
    }
    // A3-H2. A pad the file holds as something other than a string used to be DROPPED, and a
    // scratchpad is a month of the user's typing. v1 paints it through `state.scratchpads[key] ||
    // ''` (`layout.js:259`), so `42` is the two characters „42" in the textarea and `null` is an
    // empty one — which is `coerceToV1Text`'s rule exactly, on the field it was written for.
    let padText = text;
    if (typeof padText !== 'string') {
      const coerced = coerceToV1Text('pad', 'text', padText);
      if (coerced) {
        loss(
          `scratchpad ${q(month)} is ${typeof padText === 'object' && padText !== null ? 'an object' : q(padText)}, `
          + `which v2 cannot store; it was kept as the text v1 paints for it (${q(coerced.kept)})`,
          `scratchpad ${q(month)}`, 'text', 'coerced', { value: padText, kept: coerced.kept },
        );
        padText = coerced.kept;
      } else {
        // `null` and `undefined`: v1 paints an EMPTY textarea for both (`|| ''`), which is the
        // same board as no pad at all — and §8.2 emits no op for an empty pad. Said once, not
        // lossy, because nothing that was ever on screen is missing.
        warn(`scratchpad ${q(month)} is ${q(padText)}; v1 painted an empty month for it and so `
          + 'does v2 — no scratchpad register was written', false);
        padText = '';
      }
    }
    // §8.2: non-empty keys only.
    //
    // R4-11a. This was a bare `continue`, and it was the ONE drop in the whole door that reached
    // the warnings channel in some spellings and not in others: a pad the file held as `null` was
    // reported („painted an empty month"), a pad the file held as `0` was reported („kept as the
    // text v1 paints for it"), and a pad the file held as `''` — the one spelling a human writes
    // — was dropped in silence. §4b rule 2 is „EVERY coercion is reported so it is auditable",
    // and a rule with one silent case is a rule with a hole in it.
    //
    // Still not `lossy`, and the reason is unchanged: v1 paints a pad as
    // `state.scratchpads[key] || ''` (`layout.js:259`), so `''` and absent are the same empty
    // textarea, and v1's own editor DELETES the key when the text is blank
    // (`interact.js:620,634`). What the user loses is a key in an export, not a month of typing —
    // so it is said out loud and it is not called a loss. `replace.js` says the same sentence for
    // the same bytes (REG-23).
    if (padText === '') {
      if (text === '') {
        warn(`scratchpad ${q(month)} is an empty string in the file; §8.2 writes no register for `
          + 'an empty month, so the KEY is not carried into v2 — v1 painted an empty textarea for '
          + "it and so does v2, and v1's own editor deletes a blank key too (interact.js:620)",
        false);
      }
      continue;
    }
    emit('pad', `pad:${month}`, (o) => padSet(o, month, buildPatch('pad', { text: padText }, `scratchpad ${q(month)}`), { born: true }));
  }

  // ── 4. settings → one `pref.set` in the `local` space ─────────────────────
  // ADR 001 §3.3: settings are device-local presentation state and emit no synced op, ever.
  // `pref.set` carries no gid (rule U6) and is never undone — `makeOp` enforces both.
  const settings = isPlainObject(v1board.settings) ? v1board.settings : {};
  if (v1board.settings !== undefined && !isPlainObject(v1board.settings)) {
    loss(`settings is not an object (${q(typeof v1board.settings)}); treated as empty`,
      'settings', null, 'dropped', { value: v1board.settings });
  }
  const flat = {};
  for (const key of Object.keys(settings)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      loss(`settings key ${q(key)} is forbidden in a field patch and was DROPPED`,
        'settings', key, 'dropped', {});
      continue;
    }
    try {
      // One key at a time, so a single bad key costs one key and not the whole settings object.
      Object.assign(flat, flattenPref({ [key]: settings[key] }));
    } catch (e) {
      // A `RangeError` is caught alongside `OpError` deliberately, and it is the door policy
      // rather than defensiveness: `flattenPref` recurses once per level of nesting, so a
      // hand-edited `settings` nested a few thousand deep overflows the stack — an EXTERNALLY
      // SOURCED input that must be refused-and-warned, never thrown out of the migration door.
      // One key at a time is what makes it cost one key.
      if (!(e instanceof OpError) && !(e instanceof RangeError)) throw e;
      loss(`setting ${q(key)}: ${e.message}; DROPPED`, 'settings', key, 'dropped', { value: settings[key] });
    }
  }
  for (const name of Object.keys(flat)) {
    if (!fieldAccepted('pref', name, flat[name])) {
      loss(`setting ${q(name)} = ${q(flat[name])} is not a JSON scalar and was DROPPED`,
        'settings', name, 'dropped', { value: flat[name] });
      delete flat[name];
    }
  }
  // ── v1's two settings repairs (`store.js:86,90`) ──────────────────────────
  // Both are done on the FLATTENED patch, i.e. on what actually reaches the log. §5 step 7 also
  // repairs `lastCategoryId` in the projection, and that stays: this one additionally keeps the
  // LOG honest, because a `pref` register is device-local, is never re-derived from anything, and
  // is what the next „neue Notiz" reads to decide which category it lands in.
  if (Object.prototype.hasOwnProperty.call(flat, 'lastCategoryId')
      && fallbackCatId !== null && !catIds.has(flat.lastCategoryId)) {
    repair(
      `settings.lastCategoryId ${q(flat.lastCategoryId)} names no category; repaired to ` +
      `${q(fallbackCatId)} (v1 store.js:86)`,
      'lastCategoryId',
    );
    flat.lastCategoryId = fallbackCatId;
  }
  // 7.5 — „ein Ferien-Layer ohne Bundesland kann nichts bedeuten". v1 normalises this on every
  // load (`store.js:90`), so a board written before the default changed shows the toggle OFF in
  // v1 and would have shown it ON, shading nothing, in v2.
  if (flat['layers.schulferien'] === true && !flat.bundesland) {
    repair('settings.layers.schulferien is on with no Bundesland; normalised to off (7.5, v1 store.js:90)', 'schulferien');
    flat['layers.schulferien'] = false;
  }

  // Sorted, so the op's bytes depend on the SETTINGS, not on the key order the JSON file
  // happened to be written in. Nothing downstream reads a register map in order; this is purely
  // to make "the same settings migrate the same way" true of the bytes as well as the meaning.
  const sortedFlat = {};
  for (const name of Object.keys(flat).sort()) sortedFlat[name] = flat[name];
  if (Object.keys(sortedFlat).length) {
    emit('pref', 'pref:app', (o) => prefSet(o, sortedFlat));
  } else {
    warn('board carries no settings; no pref.set was emitted', false);
  }

  /**
   * The migration report. `warnings` is prose for a person; this is the same events as data, so
   * the store can put a list in front of the user, write it next to the pre-migration backup, or
   * both. `losses[].dropped` carries the exact characters a truncation cut.
   */
  const report = Object.freeze({
    lossy,
    warnings,
    losses: Object.freeze(losses),
    repairs: Object.freeze(repairs),
  });
  const result = Object.freeze({ ops, warnings, lossy, index, report });

  // ATT-82 — a lossy migration may not COMPLETE SILENTLY. See MigrationLossyError.
  if (lossy) {
    if (typeof ctx.onLossy === 'function') ctx.onLossy(report);
    else if (ctx.acceptLossy !== true) throw new MigrationLossyError(result);
  }
  return result;
}

/** @returns {{act:string, dev:string, space:string}} */
function checkCtx(ctx) {
  if (!isPlainObject(ctx)) throw new MigrationError('migrateV1: a ctx {memberId, deviceId} is required');
  if (!isMemberId(ctx.memberId)) {
    throw new MigrationError(`migrateV1: ctx.memberId must be a MemberId, got ${q(ctx.memberId)}`);
  }
  if (!isDeviceId(ctx.deviceId)) {
    throw new MigrationError(`migrateV1: ctx.deviceId must be a DeviceId, got ${q(ctx.deviceId)}`);
  }
  // Accepted for signature compatibility with ops.contract.js §9 and validated so a caller
  // passing junk finds out here — but NOT used: a migration stamp carries the all-zeros device
  // short by construction, or two Macs would not agree (ADR 001 §8.1).
  if (ctx.deviceShort !== undefined && !isDeviceShort(ctx.deviceShort)) {
    throw new MigrationError(`migrateV1: ctx.deviceShort must be 16 Crockford characters, got ${q(ctx.deviceShort)}`);
  }
  if (ctx.onLossy !== undefined && typeof ctx.onLossy !== 'function') {
    throw new MigrationError(`migrateV1: ctx.onLossy must be a function, got ${q(ctx.onLossy)}`);
  }
  if (ctx.acceptLossy !== undefined && typeof ctx.acceptLossy !== 'boolean') {
    throw new MigrationError(`migrateV1: ctx.acceptLossy must be a boolean, got ${q(ctx.acceptLossy)}`);
  }
  let space = PERSONAL_PLACEHOLDER;
  if (ctx.personalSpaceId !== undefined && ctx.personalSpaceId !== null) {
    if (!isSpaceId(ctx.personalSpaceId) || !String(ctx.personalSpaceId).startsWith('psp_')) {
      throw new MigrationError(`migrateV1: ctx.personalSpaceId must be a psp_… id, got ${q(ctx.personalSpaceId)}`);
    }
    space = ctx.personalSpaceId;
  }
  return { act: ctx.memberId, dev: ctx.deviceId, space };
}

/** @param {Function} loss the structured recorder from `migrateV1` @returns {Object[]} */
function takeArray(v, name, loss) {
  if (Array.isArray(v)) return v.filter((e) => {
    if (isPlainObject(e)) return true;
    loss(`${name}: entry ${q(e)} is not an object and was DROPPED`, name, null, 'dropped', { value: e });
    return false;
  });
  if (v !== undefined && v !== null) {
    loss(`${name} is not an array (${q(typeof v)}); treated as empty`, name, null, 'dropped', { value: v });
  }
  return [];
}

/**
 * The entity id to migrate this entry under — A3-H2.
 *
 * This used to DROP an entry whose id v2 could not use, on the reasoning that an id must never be
 * invented here. The reasoning was about DETERMINISM and it is still right; the conclusion was
 * about the ENTRY and it was wrong. v1 keeps an id-less note in its array and paints it, so the
 * drop was an entry the user could see before the upgrade and could not see after it — and, in
 * solo mode, could not get back, because the file was rewritten without it. Two answers, in
 * order:
 *
 *   1. If the id is not a string but NAMES one — the number `42`, say — it is `String`-ed
 *      (`coerceToV1Id`). That preserves the reference, because the `categoryId`s pointing at it
 *      go through the same coercion in `buildPatch`.
 *   2. Otherwise a fresh id is DERIVED from the entry's content plus an occurrence counter
 *      (`mintedId`), which is reproducible on both of my Macs and through both doors.
 *
 * Neither is a LOSS: nothing the user had is gone, an opaque token they never see has changed.
 * Both are reported as repairs, exactly like `rekeyed`.
 *
 * @param {Object} entry @param {string} kind @param {string} what prose name for the warning
 * @param {Set<string>} taken ids already used by this collection
 * @param {(msg:string, what:string) => void} repair
 * @returns {string}
 */
function entityIdOf(entry, kind, what, taken, repair) {
  const id = entry.id;
  if (isEntityUuid(id)) return id;
  const asString = coerceToV1Id(id);
  if (asString) {
    repair(
      `${what} has the id ${q(id)}, which is not a string; it was carried as ${q(asString.kept)} ` +
      '— the same token, and every reference to it was coerced the same way',
      'coercedId',
    );
    return asString.kept;
  }
  const fresh = mintedId(kind, entry, taken);
  repair(
    `${what} has no usable id (${q(id)}); it was MINTED the derived id ${q(fresh)} so that the ` +
    'entry survives. v1 kept it and drew it; dropping it was the loss (A3-H2)',
    'mintedId',
  );
  return fresh;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Snapshots  (ADR 001 §8.4 · story 11.5)
//
// "snapshots.json stays BYTE-IDENTICAL in the v1 shape, and 11.5's restore UI
// (settings.js:224-254) is untouched. Restore goes through §8.5."
//
// So snapshots are NOT converted into ops, and this function is deliberately an identity. Three
// reasons it is a function at all rather than nothing:
//
//   1. LZP-403's definition of done says "the last 7 daily snapshots migrate too. A migration
//      that strips the safety net defeats its purpose." Something has to be answerable for that,
//      and "the migration returns them untouched" is a claim a test can hold.
//   2. A snapshot is a whole v1 board. Turning one into ops would need seven more GENESIS index
//      spaces and would make "restore" mean "fold an older board over a newer one at a LOWER
//      stamp" — which does nothing at all. Restore is a DIFF TRANSACTION at FRESH stamps
//      (`replaceAllOps`, ADR 001 §8.5), implemented in `src/js/core/replace.js`.
//   3. It is the place to say, once, that a `board.reset{state}` op was considered and REJECTED
//      (§8.5): a non-register primitive in a pure-register log has no fold rule and no defined
//      behaviour under reordering or under two concurrent resets.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE SEAM ADR 001 §8.4 PROMISED AND NOTHING PROVIDED — ATT-101.
 *
 * §8.4 says „`snapshots.json` stays BYTE-IDENTICAL in the v1 shape, and 11.5's restore UI
 * (`settings.js:224-254`) is untouched". That is a claim about a file the store writes once a
 * day, and the store's roll (`store.js:229`) writes `structuredClone(this._persisted)` — the
 * materialized state, verbatim. From the first v2 launch that state carries `_born`, `ownerId`,
 * `visibility`, `entityKey`, `updatedBy` and `schemaVersion: 2` on every entry, so the very first
 * daily snapshot is v2-shaped: the promise is broken by DEFAULT, on day one, silently, and the
 * restore UI is left reading a shape it was never written for. Worse, a snapshot is the safety
 * net for exactly the situation where the rest of the system has already gone wrong.
 *
 * The store cannot be expected to re-derive „which fields are v2 additions" — that list lives in
 * `materialize.js` and grows with the model — so this is the one call `rollSnapshot()` has to
 * make, named for the job it does.
 *
 *     this.snapshots.unshift({ day, at, state: toV1Snapshot(this._persisted ?? this.state) });
 *
 * @param {Object} state a materialized v2 board
 * @returns {Object} the same board in the v1 shape: `schemaVersion: 1`, no v2 entry fields, no
 *                   foreign entries (v1 has no representation for one)
 */
export function toV1Snapshot(state) {
  if (!isPlainObject(state)) {
    throw new MigrationError(`toV1Snapshot: expected a materialized board, got ${q(state)}`);
  }
  for (const key of ['notes', 'bars', 'categories']) {
    if (!Array.isArray(state[key])) {
      throw new MigrationError(`toV1Snapshot: state.${key} must be an array, got ${q(state[key])}`);
    }
  }
  return stripV2Fields(state);
}

/**
 * Is this board in the v1 shape — i.e. would `settings.js`'s restore UI and a v1 build both read
 * it correctly? Used by `migrateSnapshots` to notice a `snapshots.json` that has already been
 * written in the wrong shape, and available to WP-3 as an assertion at the write site.
 *
 * @param {unknown} state @returns {string[]} the reasons it is NOT v1-shaped; empty means it is
 */
export function v1ShapeViolations(state) {
  const bad = [];
  if (!isPlainObject(state)) return ['not an object'];
  if (state.schemaVersion !== undefined && state.schemaVersion !== 1) {
    bad.push(`schemaVersion is ${q(state.schemaVersion)}, not 1`);
  }
  const stripped = isPlainObject(state) && Array.isArray(state.notes) && Array.isArray(state.bars)
    && Array.isArray(state.categories) ? stripV2Fields(state) : null;
  if (!stripped) return bad.concat('not a board (notes/bars/categories must be arrays)');
  for (const key of ['notes', 'bars', 'categories']) {
    for (let i = 0; i < state[key].length; i++) {
      const entry = state[key][i];
      if (!isPlainObject(entry)) continue;
      const extra = Object.keys(entry).filter((k) => !Object.prototype.hasOwnProperty.call(stripped[key][i] ?? {}, k));
      if (extra.length) bad.push(`${key}[${i}] carries v2 field${extra.length === 1 ? '' : 's'} ${extra.map(q).join(', ')}`);
    }
  }
  return bad;
}

/**
 * @param {unknown} snapshots the parsed `snapshots.json`
 * @returns {{snapshots: Object[], warnings: string[], ops: Object[]}} the SAME array, untouched
 */
export function migrateSnapshots(snapshots) {
  const warnings = [];
  if (snapshots === undefined || snapshots === null) return { snapshots: [], warnings, ops: [] };
  if (!Array.isArray(snapshots)) {
    return {
      snapshots: [],
      warnings: [`snapshots.json is not an array (${q(typeof snapshots)}); no snapshots are available to restore`],
      ops: [],
    };
  }
  for (const s of snapshots) {
    if (!isPlainObject(s) || typeof s.day !== 'string' || !isPlainObject(s.state)) {
      warnings.push(`snapshot ${q(isPlainObject(s) ? s.day : s)} is malformed; it is kept as-is but may not restore`);
      continue;
    }
    // A snapshot written by a v2 build that forgot `toV1Snapshot` (ATT-101). Reported, never
    // rewritten: this file's contract is that migration does not touch it.
    const bad = v1ShapeViolations(s.state);
    if (bad.length) {
      warnings.push(`snapshot ${q(s.day)} is not in the v1 shape (${bad[0]}); ADR 001 §8.4 requires ` +
        'snapshots.json to stay v1-shaped — the writer must go through toV1Snapshot()');
    }
  }
  // Returned BY REFERENCE and unmodified. Anything else — a clone, a normalisation, a re-sort —
  // would be a change to a file whose contract is that migration does not change it.
  return { snapshots, warnings, ops: [] };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. The idempotence gate  (ADR 001 §8.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "Migration keys off `schemaVersion === 1 && !opsLogExists()`" — both halves, in one place, so
 * the store cannot accidentally implement only the version half.
 *
 * @param {Object} board            the parsed board.json
 * @param {{opsLogExists: boolean}} env
 * @returns {{migrate: boolean, reason: string}}
 */
export function shouldMigrate(board, env) {
  if (!isPlainObject(env) || typeof env.opsLogExists !== 'boolean') {
    throw new MigrationError('shouldMigrate: env.opsLogExists (boolean) is required — the op log is half the predicate');
  }
  if (!isPlainObject(board)) return { migrate: false, reason: 'board is not an object' };
  if (env.opsLogExists) return { migrate: false, reason: 'an op log already exists; migration has already run' };
  const sv = board.schemaVersion ?? 0;
  if (!Number.isInteger(sv)) return { migrate: false, reason: `schemaVersion ${q(board.schemaVersion)} is not an integer` };
  if (sv >= 2) return { migrate: false, reason: `board is already at schemaVersion ${sv}` };
  return { migrate: true, reason: `schemaVersion ${sv} and no op log` };
}

/** The version `board.json` carries once migration has run (ADR 001 §8: SCHEMA_VERSION 1 → 2). */
export const SCHEMA_VERSION_V2 = 2;
