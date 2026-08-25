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
import {
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
//
// What it DOES include: the acting member (so two members migrating the same shared export do
// not collide), the global index (so a hand-edited board with two entries sharing an id still
// gets two distinct op ids) and the entity key.
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

/** @param {string} act @param {number} index @param {string} kind @param {string} entityKey */
function deriveOpId(act, index, kind, entityKey) {
  return derive('lzp.migrate.op', [MIGRATION_LABEL, act, String(index), kind, entityKey]);
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
 * (`store.js:60`) — that is where the v0→v1 branch, the reference repair and the 7.5 Ferien
 * normalisation live, and none of them can be reproduced here because they need `defaultState()`,
 * which mints random uuids. A rawer board is still accepted and still migrates: every field is
 * taken defensively, and anything that cannot be represented produces a warning rather than an
 * exception. What it will NOT do is invent the four default categories, because inventing them
 * needs `crypto.randomUUID()` and that would make two migrations of the same file differ.
 *
 * @param {Object} v1board
 * @param {MigrateCtx} ctx
 * @returns {{ops: Object[], warnings: string[], lossy: boolean, index: number}}
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
    newOpId: () => deriveOpId(act, index, cursor.kind, cursor.key),
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
      const value = entry[name];
      if (value === undefined) continue;                 // absent in v1 stays absent in v2
      if (!fieldAccepted(kind, name, value)) {
        warn(
          `${where}: field ${q(name)} = ${q(value)} is not representable in v2 and was DROPPED ` +
          '(hand-edited or imported board.json)',
          true,
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
      warn(`${where}: unknown v1 field ${q(name)} has no v2 register and was DROPPED`, true);
    }
    return f;
  };

  // ── 1. categories ─────────────────────────────────────────────────────────
  // First, because `categories[0]` is v1's dangling-reference fallback (`store.js:84`) and §5
  // step 7 resolves it by `(_born asc, id asc)` — so the category the fallback picks after
  // migration is the same one v1 picked before it.
  const categories = takeArray(v1board.categories, 'categories', warn);
  const catIds = new Set();
  for (const c of categories) {
    const id = entityIdOf(c, 'category', warn);
    if (id === null) continue;
    if (catIds.has(id)) {
      // Two registers cannot share an entity key: the second would LWW over the first. v1
      // tolerates duplicate ids in an array; v2 cannot, and pretending otherwise would silently
      // merge two categories.
      warn(`category ${q(id)} appears more than once; only the first was migrated`, true);
      continue;
    }
    catIds.add(id);
    emit('cat', `cat:${id}`, (o) => catSet(o, id, buildPatch('cat', c, `category ${q(id)}`), { born: true }));
  }
  if (categories.length && catIds.size === 0) {
    warn('no category survived migration; every entry will fall back to a category that does not exist', true);
  }
  if (!categories.length) {
    // v1's migrate() substitutes `defaultState().categories` here, minting four random uuids.
    // Migration must not: random ids would make two migrations of the same file diverge (R12).
    warn('board carries no categories; run v1 migrate() first if the four defaults are wanted', false);
  }

  // ── 2. notes ──────────────────────────────────────────────────────────────
  const seen = { note: new Set(), bar: new Set() };
  for (const [kind, list, plural] of [
    ['note', takeArray(v1board.notes, 'notes', warn), 'note'],
    ['bar', takeArray(v1board.bars, 'bars', warn), 'bar'],
  ]) {
    for (const entry of list) {
      const id = entityIdOf(entry, plural, warn);
      if (id === null) continue;
      if (seen[kind].has(id)) {
        warn(`${plural} ${q(id)} appears more than once; only the first was migrated`, true);
        continue;
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
        warn(`${plural} ${q(id)} will not be renderable after migration (ADR 001 §5 step 3): ` +
             `it is missing ${kind === 'note' ? 'a date or a text' : 'a start or an end date'}`, true);
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
  // Object key order is the enumeration order of the parsed JSON, i.e. the file's own order. That
  // is what feeds the index counter, so two migrations of the same FILE agree; two boards with
  // the same pads written in a different order legitimately produce different indices, and
  // §5 step 5 sorts scratchpad keys anyway before anything user-visible reads them.
  const pads = isPlainObject(v1board.scratchpads) ? v1board.scratchpads : {};
  if (v1board.scratchpads !== undefined && !isPlainObject(v1board.scratchpads)) {
    warn(`scratchpads is not an object (${q(typeof v1board.scratchpads)}); treated as empty`, true);
  }
  for (const month of Object.keys(pads)) {
    const text = pads[month];
    if (!isMonthKey(month)) {
      warn(`scratchpad key ${q(month)} is not YYYY-MM and was DROPPED`, true);
      continue;
    }
    if (typeof text !== 'string') {
      warn(`scratchpad ${q(month)} is not a string and was DROPPED`, true);
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
    warn(`settings is not an object (${q(typeof v1board.settings)}); treated as empty`, true);
  }
  const flat = {};
  for (const key of Object.keys(settings)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      warn(`settings key ${q(key)} is forbidden in a field patch and was DROPPED`, true);
      continue;
    }
    try {
      // One key at a time, so a single bad key costs one key and not the whole settings object.
      Object.assign(flat, flattenPref({ [key]: settings[key] }));
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      warn(`setting ${q(key)}: ${e.message}; DROPPED`, true);
    }
  }
  for (const name of Object.keys(flat)) {
    if (!fieldAccepted('pref', name, flat[name])) {
      warn(`setting ${q(name)} = ${q(flat[name])} is not a JSON scalar and was DROPPED`, true);
      delete flat[name];
    }
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

  return { ops, warnings, lossy, index };
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
  let space = PERSONAL_PLACEHOLDER;
  if (ctx.personalSpaceId !== undefined && ctx.personalSpaceId !== null) {
    if (!isSpaceId(ctx.personalSpaceId) || !String(ctx.personalSpaceId).startsWith('psp_')) {
      throw new MigrationError(`migrateV1: ctx.personalSpaceId must be a psp_… id, got ${q(ctx.personalSpaceId)}`);
    }
    space = ctx.personalSpaceId;
  }
  return { act: ctx.memberId, dev: ctx.deviceId, space };
}

/** @returns {Object[]} */
function takeArray(v, name, warn) {
  if (Array.isArray(v)) return v.filter((e) => {
    if (isPlainObject(e)) return true;
    warn(`${name}: entry ${q(e)} is not an object and was DROPPED`, true);
    return false;
  });
  if (v !== undefined && v !== null) warn(`${name} is not an array (${q(typeof v)}); treated as empty`, true);
  return [];
}

/** @returns {string|null} */
function entityIdOf(entry, what, warn) {
  const id = entry.id;
  if (!isEntityUuid(id)) {
    // Never invent one: a random id here would break byte-identical double migration, and an
    // id derived from the content would make two entries with the same content collide.
    warn(`${what} with unusable id ${q(id)} was DROPPED`, true);
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
//      (`replaceAllOps`, ADR 001 §8.5), which is a later work package.
//   3. It is the place to say, once, that a `board.reset{state}` op was considered and REJECTED
//      (§8.5): a non-register primitive in a pure-register log has no fold rule and no defined
//      behaviour under reordering or under two concurrent resets.
// ─────────────────────────────────────────────────────────────────────────────

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
