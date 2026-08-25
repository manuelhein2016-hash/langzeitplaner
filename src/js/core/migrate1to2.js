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
import { utf8 } from './canon.js';
import { isMemberId, isDeviceId, isSpaceId, isMonthKey, isEntityUuid, renderable } from './entities.js';
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
function rekeyed(kind, id, taken) {
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
function defaultCategories() {
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
function truncateToFit(kind, name, value) {
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
  const buildPatch = (kind, entry, where) => {
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
        if (!(kind === 'note' && name === 'text')) continue;   // absent in v1 stays absent in v2
        value = '';
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
        loss(
          `${where}: field ${q(name)} = ${q(value)} is not representable in v2 and was DROPPED ` +
          '(hand-edited or imported board.json)',
          where, name, 'dropped', { value },
        );
        continue;
      }
      f[name] = value;
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

  // ── 1. categories ─────────────────────────────────────────────────────────
  // First, because `categories[0]` is v1's dangling-reference fallback (`store.js:84`) and §5
  // step 7 resolves it by `(_born asc, id asc)` — so the category the fallback picks after
  // migration is the same one v1 picked before it.
  const categories = takeArray(v1board.categories, 'categories', loss);
  const catIds = new Set();
  const emitCat = (c, id, where) =>
    emit('cat', `cat:${id}`, (o) => catSet(o, id, buildPatch('cat', c, where), { born: true }));

  for (const c of categories) {
    let id = entityIdOf(c, 'category', loss);
    if (id === null) continue;
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
      let id = entityIdOf(entry, plural, loss);
      if (id === null) continue;
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
      const patch = buildPatch(kind, entry, `${plural} ${q(id)}`);
      // ADR 001 §5 step 3 checks renderability against EXPLICIT fields and never infers it from
      // absence. v1 is laxer: it renders a text-less note as "…" (`popover.js:193`) and a bar
      // with no end date lands in `assignLanes` regardless. So an entry that arrives here
      // incomplete WILL migrate and then WILL NOT be shown, and the user is entitled to know
      // that before the original file is gone. The op is still emitted: the register set is
      // complete the moment the missing field is supplied, and dropping the op would make that
      // unrecoverable.
      if (!renderable(kind, patch)) {
        loss(`${plural} ${q(id)} will not be renderable after migration (ADR 001 §5 step 3): ` +
             `it is missing ${kind === 'note' ? 'a date or a text' : 'a start or an end date'}`,
        `${plural} ${q(id)}`, null, 'not-renderable', { patch });
      }
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
    if (typeof text !== 'string') {
      loss(`scratchpad ${q(month)} is not a string and was DROPPED`,
        `scratchpad ${q(month)}`, 'text', 'dropped', { value: text });
      continue;
    }
    if (text === '') continue;                            // §8.2: non-empty keys only
    emit('pad', `pad:${month}`, (o) => padSet(o, month, buildPatch('pad', { text }, `scratchpad ${q(month)}`), { born: true }));
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
      if (!(e instanceof OpError)) throw e;
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

/** @returns {string|null} */
function entityIdOf(entry, what, loss) {
  const id = entry.id;
  if (!isEntityUuid(id)) {
    // Never invent one HERE: an id for an entry that has none would have to come from the content
    // (two identical entries would then collide) or from a CSPRNG (two migrations of the file
    // would differ, R12). A DUPLICATE id is a different problem with a different answer — see
    // `rekeyed`, where there is a real id to derive a replacement from.
    loss(`${what} with unusable id ${q(id)} was DROPPED`, what, 'id', 'unusable-id', { entry });
    return null;
  }
  return id;
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
