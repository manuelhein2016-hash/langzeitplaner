// src/js/core/ops.js — the op vocabulary: FIELDS, the op kinds, the constructors, validation.
// ADR 001 §2, §3, §7.4, §10 · ADR 004 §2.1, §3, §5 · ops.contract.js §2.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2).
//
// ONE OP PRIMITIVE: A STAMPED FIELD ASSIGNMENT (ADR 001 §0.1).
// Every mutation in the product — note create, bar resize, category delete-with-reassign,
// scratchpad typing, visibility change, member rename, admin transfer — compiles to a set of
// `(entityKey, field, value, stamp, author)` writes. There is no move op, no create op and no
// delete op at the merge layer. `MUTATIONS` below is therefore not a second vocabulary: it is a
// lookup table from "the thing the user did" to "the field assignments that are". Every one of
// its entries names the v1 `store.mutate()` call site it replaces, so the retrofit (WP-3) is a
// mechanical rewrite and a missed site is a test failure rather than a silent data-loss bug.
//
// EVERY OP CARRIES AN ABSOLUTE VALUE. NOT ONE RELATIVE OP EXISTS IN THIS SYSTEM (ADR 001 §3.2,
// §6). `move-bar` emits the new start and end dates, never a delta: a delta applied twice moves
// twice, and duplicate delivery is not an error condition here, it is Tuesday. This is one of the
// exactly two ways a design like this normally breaks.
//
// UNKNOWN IS PARKED, NEVER DROPPED (ADR 001 §7.4, §10, §12.5).
// An op whose KIND we do not know, whose FIELD NAME we do not know, or whose SPACE we do not
// recognise is retained and re-evaluated after an app update. An op whose field VALUE fails its
// declared type is a protocol violation and is rejected. The difference is load-bearing: parking
// is what makes an old client in a family with a newer sibling degrade to "does not show the new
// thing" instead of "loses the new thing". `classifyOp()` is the explicit API for that decision;
// nothing downstream should be re-deriving it from `validateOp`'s booleans.

import { isStamp, isTooFarFuture } from './stamp.js';
import {
  parseEntityKey, kindOfEntity, ownerOfEntity, familyKey, familyKeyFor,
  localKey, noteKey, barKey, catKey, padKey, memberKey, spaceKey, PREF_KEY,
  isMemberId, isDeviceId, isSpaceId, isOpId, isDateString, VISIBILITY_LEVELS,
  reanchorRepeat, addDays,
} from './entities.js';

// Re-exported so a call site can take the whole op vocabulary from one module, which is how
// ops.contract.js §2 groups them (it lists FIELDS, kindOfEntity, ownerOfEntity and familyKey
// side by side). They are IMPLEMENTED in entities.js because that is where ADR 005 §1.1 puts
// "entityKey helpers"; these are aliases, not copies.
export {
  parseEntityKey, kindOfEntity, ownerOfEntity, familyKey, familyKeyFor,
  localKey, noteKey, barKey, catKey, padKey, memberKey, spaceKey, PREF_KEY,
  reanchorRepeat, addDays,
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. FIELDS — the one field table (ADR 001 §3.1)
//
// "Every downstream agent reads it; nobody invents a field."
//
//   t            the declared type; `validateOp` enforces it
//   coEdit       may a co-editor write it? (ADR 001 §4.3 stage 3b)
//   gov          a GOVERNING field — owner or admin only (stage 3a). A co-editor can never grant
//                themselves co-edit, because `pub.coEdit` is folded in the earlier stage.
//   writeOnce    an ADMISSIBILITY attribute, NOT a merge attribute. The join in
//                `registers.js` is unconditional max-by-`≺` on every field with no
//                exceptions (ADR 001 §12.2), because "the register refuses a second write"
//                is not commutative: with writes W₁ ≺ W₂ to one cell, apply-then-refuse
//                yields W₁ in one delivery order and W₂ in the other. Enforcement therefore
//                lives on the way IN. `authz.js` enforces it for `member['dev.*']`, where a
//                second write is the ADR 002 §2.3 key-injection hole: only the minimal write
//                under `≺` is admissible and later claims are rejected `WRITE_ONCE`.
//                `_born` is deliberately NOT enforced — it rides inside ops that also carry
//                content (`bar.set{_born, startDate, …}`), so rejecting the op would drop a
//                legitimate write and stripping the field would make ops non-atomic. The
//                exposure is nil: `createdAt` is min over ALL of an entity's register stamps
//                (ADR 001 §1.4), so it does not move when the `_born` register does, and only
//                the owner can write it at all. Reported as an ADR §3.1 wording gap.
//   geteiltOnly  content that exists at Geteilt and at no lower level (ADR 004 §2.1)
//   local        `local` space only: persisted, never undoable, NEVER SYNCED (ADR 001 §3.3)
//
// TWO ENTRIES ARE NOT IN ADR 001 §3.1'S CODE BLOCK AND ARE HERE ANYWAY — see the notes at
// `fnote._born` / `fbar._born`. They are required by ADR 001 §4.3 stage 3a and ADR 004 §5, which
// both name `_born` as a family register. The omission from §3.1 is reported as an ADR gap.
// ─────────────────────────────────────────────────────────────────────────────

const V = VISIBILITY_LEVELS;

/** @type {Object<string, Object<string, Object>>} */
export const FIELDS = deepFreeze({
  note: {                                       // personal space — THE TRUTH
    date: { t: 'date', coEdit: true },
    text: { t: 'str80', coEdit: true },
    categoryId: { t: 'id', coEdit: false },     // A3: never published, at any level
    repeatsYearly: { t: 'bool', coEdit: true },
    visibility: { t: 'enum', values: V, gov: true },
    coEdit: { t: 'bool', gov: true },
    _alive: { t: 'bool', gov: true },
    _born: { t: 'stamp', writeOnce: true },
  },
  bar: {
    startDate: { t: 'date', coEdit: true },
    endDate: { t: 'date', coEdit: true },
    label: { t: 'str40', coEdit: true },
    categoryId: { t: 'id', coEdit: false },
    visibility: { t: 'enum', values: V, gov: true },
    coEdit: { t: 'bool', gov: true },
    _alive: { t: 'bool', gov: true },
    _born: { t: 'stamp', writeOnce: true },
  },
  cat: {                                        // personal only — A3
    name: { t: 'str' },
    nameEn: { t: 'str' },
    paletteRef: { t: 'str' },
    visible: { t: 'bool' },
    defaultVisibility: { t: 'enum', values: V }, // 16.4; read ONCE at create, never a live rule
    _alive: { t: 'bool' },
    _born: { t: 'stamp', writeOnce: true },
  },
  pad: {
    text: { t: 'str' },
    _alive: { t: 'bool' },
    _born: { t: 'stamp', writeOnce: true },
  },
  // Free-form, local, never undoable, never synced. Nested v1 settings (`layers.*`) and the v2
  // additions (`lastSeenSeq.*`, `hiddenMembers.*`) are carried as DOTTED KEYS with scalar values,
  // because `f` is scalars-only by contract (ADR 001 §2) and `pref` may not be the one exception.
  //
  // `null` ON A PREF MEANS "THE VALUE IS GONE", AND THAT IS THE CONTRACT — not a defect.
  // ATT-32 read it as one: `materialize.js` resolves a null register rather than storing a third
  // state, so "explicitly cleared" and "never set" are not two different boards.
  //
  // ROUND 2 — WHAT "GONE" RESOLVES TO WAS WRONG AND IS NOW RIGHT (REG-8). This comment used to
  // say a cleared pref takes `defaultState().settings`'s value. It takes **v1's reading of
  // `null`**, which is the default for most prefs and `false` for every pref v1 consumes as a
  // plain boolean (`layout.js:243` is `s.layers.feiertage &&`). The two differ for exactly the
  // booleans whose default is `true`, and reading them as the default turned the Feiertage layer
  // ON for a board v1 draws with it OFF. See `materialize.js:applyClearedPrefs`, which owns the
  // rule and derives it from `typeof default === 'boolean'` so a pref added later is covered.
  //
  // And because "gone" and "the file says null" are then the same register, nothing else may use
  // `null` to mean "revert to the default": `replace.js:buildPrefOp` writes the DEFAULT VALUE for
  // a pref an imported board omits (from `ctx.defaultSettings`) rather than clearing it. For a CONTENT field that conflation would be a bug (ADR
  // 004 §5.1 needs `null` to mean redacted, distinct from absent, because a blank note text is a
  // legitimate value). For a pref it is the only coherent reading: every pref has a default and
  // the renderer needs a value, so there is no third state for the register to lose. The attack's
  // own words — "no v1 site does this today" — describe a shape that could not be observed.
  //
  // It is also LOAD-BEARING, so do not "tighten" it. The proposed repair was to make `prefSet`
  // reject `null`; that would break import and snapshot restore. `replace.js:buildPrefOp` writes
  // exactly this — `{bundesland: null, rowHeight: null}` for a pref this device holds that the
  // incoming file does not carry — because v1's `replaceAll()` installs the settings object
  // WHOLESALE, so a key the file omits must revert to its default rather than survive the import
  // (ADR 001 §8.5 step 5). Rejecting `null` here would leave `replace.js` no way to say that.
  pref: { '*': { t: 'any', local: true } },

  fnote: {                                      // family space — THE PUBLICATION
    'pub.level': { t: 'enum', values: V, gov: true },
    'pub.coEdit': { t: 'bool', gov: true },
    'pub.alive': { t: 'bool', gov: true },
    'pub.date': { t: 'date', coEdit: true },
    'pub.text': { t: 'str80', coEdit: true, geteiltOnly: true },
    'pub.repeatsYearly': { t: 'bool', coEdit: true },
    // NOT in ADR 001 §3.1's block, but required by ADR 001 §4.3 stage 3a ("governing fields
    // pub.level, pub.coEdit, pub.alive, _born") and by ADR 004 §5's transition table, which
    // writes `'_born': …` in the Privat→Belegt and Privat→Geteilt rows. Without it the first
    // publication of an entry could not carry its create stamp and `createdAt` (ADR 001 §1.4)
    // would be undefined for every foreign entry.
    _born: { t: 'stamp', writeOnce: true, gov: true },
  },
  fbar: {
    'pub.level': { t: 'enum', values: V, gov: true },
    'pub.coEdit': { t: 'bool', gov: true },
    'pub.alive': { t: 'bool', gov: true },
    'pub.startDate': { t: 'date', coEdit: true },
    'pub.endDate': { t: 'date', coEdit: true },
    'pub.label': { t: 'str40', coEdit: true, geteiltOnly: true },
    _born: { t: 'stamp', writeOnce: true, gov: true },   // see fnote._born
  },
  member: {
    displayName: { t: 'str' },
    colorRef: { t: 'str' },
    _alive: { t: 'bool' },
    _born: { t: 'stamp', writeOnce: true },
    // One register per device: key `dev.<deviceShort>`, value = b64url device attestation.
    // Write-once and admissible only from `op.act === memberId` — a member adds devices to their
    // own record and to nobody else's (ADR 001 §4.0).
    'dev.*': { t: 'str', writeOnce: true },
  },
  space: {
    name: { t: 'str' },
    admin: { t: 'id' },        // memberId — the admin chain, ADR 001 §4.1
    adminPrev: { t: 'opId' },  // the opId this transfer supersedes; null at genesis
    epoch: { t: 'int' },       // informational mirror of the key epoch (ADR 002 §4)
  },
});

/**
 * THERE IS NO `owner` FIELD, NO `seriesId` FIELD AND NO `board.reset` OP (ADR 001 §12.6).
 * `seriesId` is defined as an ALIAS OF THE ENTITY UUID: a repeating note IS its series (9.3), so
 * there is exactly one `visibility` register per series and A4 ("series-level visibility, no
 * per-year exceptions") is free. Downstream agents must not invent occurrence entities.
 * @param {string} entityKey @returns {string|null}
 */
export const seriesIdOf = (entityKey) => {
  const p = parseEntityKey(entityKey);
  return p && (p.kind === 'note' || p.kind === 'fnote') ? p.id : null;
};

/** `dev.<deviceShort16>` — the only wildcard register name on `member`. */
const DEV_REGISTER_RE = /^dev\.[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;

/**
 * The field spec for `(entityKind, fieldName)`, honouring the two wildcard rows (`pref['*']` and
 * `member['dev.*']`). Returns null when the field is UNKNOWN — which is a PARK, not a reject.
 * @param {string} entityKind @param {string} fieldName @returns {Object|null}
 */
export function fieldSpec(entityKind, fieldName) {
  const table = FIELDS[entityKind];
  if (!table || typeof fieldName !== 'string') return null;
  if (Object.prototype.hasOwnProperty.call(table, fieldName)) return table[fieldName];
  if (Object.prototype.hasOwnProperty.call(table, '*')) return table['*'];
  if (entityKind === 'member' && DEV_REGISTER_RE.test(fieldName)) return table['dev.*'];
  return null;
}

/** Field names declared for a kind, wildcards excluded. @param {string} kind @returns {string[]} */
export const fieldsOf = (kind) =>
  Object.keys(FIELDS[kind] || {}).filter((f) => f !== '*' && f !== 'dev.*');

/** Fields a co-editor may write (ADR 001 §4.3 stage 3b). @param {string} kind @returns {string[]} */
export const coEditableFields = (kind) => fieldsOf(kind).filter((f) => FIELDS[kind][f].coEdit === true);

/** Governing fields — owner or admin only (stage 3a). @param {string} kind @returns {string[]} */
export const governingFields = (kind) => fieldsOf(kind).filter((f) => FIELDS[kind][f].gov === true);

/**
 * Truth registers vs `pub.*` registers — the split ADR 004 is built on.
 * A truth field lives in the personal space and never leaves the device; a `pub.*` field lives in
 * the family space and is what the projection built. `categoryId` has NO `pub.` counterpart at
 * any level, and that absence — not a filter someone can forget to apply — is how A3 is enforced.
 * @param {string} field @returns {boolean}
 */
export const isPubField = (field) => typeof field === 'string' && field.startsWith('pub.');
/** @param {string} field @returns {boolean} */
export const isReservedField = (field) => typeof field === 'string' && field.startsWith('_');
/** A v1 product field, carried verbatim (ADR 001 §2.1). @param {string} field @returns {boolean} */
export const isTruthField = (field) => !isPubField(field) && !isReservedField(field);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Op kinds (ADR 001 §3) — eight, and that is the whole vocabulary
//
// ADR 004 §7: "There is no op kind for a read receipt, a presence signal, or a visibility-change
// notification. The eight kinds in ADR 001 §3 are the whole vocabulary" — Principle 9 is enforced
// by the ABSENCE of a mechanism, not by a policy. Adding a ninth kind needs a new ADR.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Object<string, {entities: string[], space: 'local'|'personal'|'family'}>} */
export const OP_KINDS = deepFreeze({
  'note.set': { entities: ['note'], space: 'personal' },
  'bar.set': { entities: ['bar'], space: 'personal' },
  'cat.set': { entities: ['cat'], space: 'personal' },
  'pad.set': { entities: ['pad'], space: 'personal' },
  'pref.set': { entities: ['pref'], space: 'local' },
  'pub.set': { entities: ['fnote', 'fbar'], space: 'family' },
  'member.set': { entities: ['member'], space: 'family' },
  'space.set': { entities: ['space'], space: 'family' },
});

/** @type {string[]} */
export const OP_KIND_NAMES = Object.freeze(Object.keys(OP_KINDS));

/** The op kind that writes a given entity kind. @param {string} entityKind @returns {string|null} */
export function opKindForEntity(entityKind) {
  for (const k of OP_KIND_NAMES) if (OP_KINDS[k].entities.includes(entityKind)) return k;
  return null;
}

/** The current op format version. Changes only when the op format changes, and it is SEPARATE
 *  from the HTTP protocol version (ADR 003 §4). An op with another `v` is PARKED. */
export const OP_VERSION = 1;

/** The solo-mode placeholder personal space (ADR 001 §8.2): in solo mode there is no personal
 *  space and no key, so migration ops are written with this and rewritten to the real `psp_…`
 *  the first time a personal space is created. */
export const PERSONAL_PLACEHOLDER = 'personal';
/** The device-local space. Never synced, never encrypted, never undoable. */
export const LOCAL_SPACE = 'local';

/**
 * 'local' | 'personal' | 'psp_…' | 'fsp_…', or null when the string is not a space reference we
 * recognise. An unrecognised space is PARKED (ADR 001 §10), never rejected.
 * @param {unknown} space @returns {'local'|'personal'|'family'|null}
 */
export function spaceClassOf(space) {
  if (space === LOCAL_SPACE) return 'local';
  if (space === PERSONAL_PLACEHOLDER) return 'personal';
  if (typeof space !== 'string') return null;
  if (isSpaceId(space)) return space.startsWith('fsp_') ? 'family' : 'personal';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Validation and the PARK / REJECT triage (ADR 001 §7.4, §10)
// ─────────────────────────────────────────────────────────────────────────────

/** Why an op was parked. Parked ops are RETAINED and re-evaluated; they are never dropped. */
export const PARK_REASONS = Object.freeze({
  /** `Op.v` is not a version this build understands. Re-evaluated after an app update. */
  VERSION: 'version',
  /** `op.k` is not one of the eight kinds. Re-evaluated after an app update. */
  UNKNOWN_KIND: 'unknownKind',
  /** A name in `f` is not in `FIELDS[kind]`. Parked WITH ITS OP — not dropped, not applied. */
  UNKNOWN_FIELD: 'unknownField',
  /** `op.space` is a form this build does not recognise. */
  UNKNOWN_SPACE: 'unknownSpace',
  /** Stamp more than MAX_FUTURE_DRIFT_MS ahead. Re-evaluated when local wall time passes it. */
  FUTURE: 'future',
  /** Sealed under an epoch key we do not hold yet. Re-evaluated on the next key fetch. */
  EPOCH: 'epoch',
  /**
   * An admin's §4.3 stage-3a patch sets the level to `privat` but carries something this build
   * cannot read as a withdrawal (a non-null value, or a name that is not `pub.*`). Re-evaluated
   * after an app update, exactly like the other version-skew reasons.
   *
   * It is deliberately NOT `VERSION`: that reason is defined as "`Op.v` is not a version this
   * build understands" and is set from `op.v`. Reusing it for a verdict derived from the PATCH
   * would make the diagnostic lie about where the park came from, and `oplog.js:park()` — which
   * validates against `isParkReason` — would happily accept the wrong story. The distinction
   * matters at the unpark seam: this is the one park reason whose op was already found to be a
   * governance write on somebody else's entity, so a future build that unparks it must re-run
   * stage 3a and must never treat "parked" as "previously approved".
   */
  UNSHARE_SHAPE: 'unshareShape',
  /**
   * **The op's device has no attestation yet — finding E3-3 / F-6, landed by E5.**
   *
   * ADR 002 §5.2.5 and ADR 001 §7.4: an op from a device whose `member.set{dev.*}` attestation
   * has not arrived is PARKED, not rejected. The two are not the same claim — a rejection is
   * permanent and a park is "ask again", and the difference is one Mac's whole first pull. A
   * newly paired device's attestation can arrive in a LATER page than the content op it
   * authorises, and `crypto/envelope.js` returns exactly this verdict (`ENVELOPE_PARK.ATTESTATION`,
   * P1) when `attestationOf(env.dv)` is null — absent, or contested under §2.3's "two shorts, no
   * winner".
   *
   * It could not be written into the op log before this constant existed: `oplog.park()`
   * validates against `isParkReason`, so the reason was refused and the line was dropped instead.
   * `envelope.js`'s `PARK_REASONS_NEEDED` recorded the obligation in code, and the value here is
   * the one it names — the two files must agree, and a test asserts they do.
   *
   * RE-EVALUATED when a device attestation lands: the next pull that carries one, or the pairing
   * flow handing one over directly, which at M1 is the only source there is (`member.set` is a
   * family-space op kind, so a person with two Macs and no Familienkreis has nowhere in the log
   * to record one).
   */
  ATTESTATION: 'attestation',
});

const PARKABLE = new Set(Object.values(PARK_REASONS));
/** @param {string} reason @returns {boolean} */
export const isParkReason = (reason) => PARKABLE.has(reason);

/**
 * A JSON scalar or null — the ONLY thing an `f` value may be (ADR 001 §2), and therefore the
 * only thing a register may hold. Exported so `registers.js` shares this definition rather
 * than carrying a copy: two answers to "is this storable?" is one answer too many.
 */
export function isScalar(v) {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  return t === 'number' && Number.isFinite(v);
}

/**
 * `YYYY-MM-DD`, checked for FORMAT and not for calendar validity — deliberately.
 * ADR 001 §12.8 says dates are `YYYY-MM-DD` everywhere and says nothing about a real day, and
 * `interact.js:330-334` (a repeat dragged onto 29 February from a non-leap anchor year) legally
 * produces `"2025-02-29"` in v1 today. See `entities.js:reanchorRepeat` for the full note. A
 * stricter check here would make an existing, working v1 gesture emit an invalid op.
 */
const checkDate = (v) => (isDateString(v) ? null : 'not a YYYY-MM-DD date');

/** @returns {string|null} an error message, or null when the value satisfies the spec */
function checkType(spec, value) {
  if (value === null) return null;             // `null` clears a register; always legal
  switch (spec.t) {
    case 'date': return checkDate(value);
    case 'str': return typeof value === 'string' ? null : 'not a string';
    case 'str40':
      if (typeof value !== 'string') return 'not a string';
      return value.length <= 40 ? null : `longer than 40 characters (${value.length})`;
    case 'str80':
      if (typeof value !== 'string') return 'not a string';
      return value.length <= 80 ? null : `longer than 80 characters (${value.length})`;
    case 'id': return typeof value === 'string' && value.length > 0 ? null : 'not an id';
    case 'bool': return typeof value === 'boolean' ? null : 'not a boolean';
    case 'int': return Number.isSafeInteger(value) ? null : 'not a safe integer';
    case 'enum':
      return spec.values.includes(value) ? null : `not one of ${spec.values.join('|')}`;
    case 'stamp': return isStamp(value) ? null : 'not a 37-char stamp';
    case 'opId': return isOpId(value) ? null : 'not a 22-char opId';
    case 'any': return isScalar(value) ? null : 'not a JSON scalar';
    default: return `unknown declared type ${spec.t}`;
  }
}

const reject = (reason) => ({ ok: false, reason, park: false });
const park = (reason, parkReason, extra = {}) => ({ ok: false, reason, park: true, parkReason, ...extra });

/**
 * Validate an op's shape: kind/entity agreement, scalar-only `f`, known field names, declared
 * types, reserved-name rules, `YYYY-MM-DD` on every date field.
 *
 * @param {Object} op
 * @returns {{ok:true}|{ok:false, reason:string, park:boolean, parkReason?:string, fields?:string[]}}
 *   `park: true` for an unknown version, kind, field name or space — forward compatibility, and
 *   the op MUST be retained (ADR 001 §7.4). `park: false` for a type violation or a structural
 *   defect, which is a protocol violation and not a version skew.
 */
export function validateOp(op) {
  if (op === null || typeof op !== 'object' || Array.isArray(op)) return reject('op is not an object');

  if (op.v !== OP_VERSION) {
    if (Number.isSafeInteger(op.v) && op.v > 0) return park(`op version ${op.v} is not ${OP_VERSION}`, PARK_REASONS.VERSION);
    return reject(`op.v must be ${OP_VERSION}, got ${JSON.stringify(op.v)}`);
  }
  if (!isOpId(op.id)) return reject('op.id must be 22 base64url characters');
  if (!isStamp(op.ts)) return reject('op.ts must be a 37-char stamp');
  if (!isMemberId(op.act)) return reject('op.act must be a MemberId');
  if (!isDeviceId(op.dev)) return reject('op.dev must be a DeviceId');

  const spaceClass = spaceClassOf(op.space);
  if (spaceClass === null) {
    if (typeof op.space === 'string' && op.space.length > 0) {
      return park(`unrecognised space ${JSON.stringify(op.space)}`, PARK_REASONS.UNKNOWN_SPACE);
    }
    return reject('op.space must be a string');
  }

  const kindSpec = OP_KINDS[op.k];
  if (!kindSpec) {
    if (typeof op.k === 'string' && op.k.length > 0) {
      return park(`unknown op kind ${JSON.stringify(op.k)}`, PARK_REASONS.UNKNOWN_KIND);
    }
    return reject('op.k must be a string');
  }

  // `gid` has NO effect on merge (ADR 001 §2); it is the unit of undo. `pref.set` carries none
  // and is never undone — v1 parity for `settings.lastCategoryId` (recon B5, rule U6).
  if (op.k === 'pref.set') {
    if (op.gid !== null && op.gid !== undefined && !isOpId(op.gid)) {
      return reject('pref.set carries no gid (rule U6); null, undefined or a GroupId only');
    }
  } else if (!isOpId(op.gid)) {
    return reject('op.gid must be a 22-char GroupId');
  }

  const entity = parseEntityKey(op.e);
  if (!entity) return reject(`op.e is not a well-formed entity key: ${JSON.stringify(op.e)}`);
  if (!kindSpec.entities.includes(entity.kind)) {
    return reject(`op kind ${op.k} may not address a ${entity.kind} entity`);
  }
  if (kindSpec.space !== spaceClass) {
    return reject(`op kind ${op.k} belongs in the ${kindSpec.space} space, not ${spaceClass}`);
  }

  if (op.f === null || typeof op.f !== 'object' || Array.isArray(op.f)) return reject('op.f must be an object');
  const names = Object.keys(op.f);
  if (names.length === 0) return reject('op.f is empty — an op that writes nothing is malformed');

  const unknown = [];
  for (const name of names) {
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
      return reject(`op.f carries the forbidden key ${JSON.stringify(name)}`);
    }
    // A malformed `dev.*` register name is a bad shape, not version skew: the device short is a
    // fixed 16-character Crockford string by construction (ADR 001 §1.2).
    if (entity.kind === 'member' && name.startsWith('dev.') && !DEV_REGISTER_RE.test(name)) {
      return reject(`${name} is not dev.<deviceShort16>`);
    }
    const spec = fieldSpec(entity.kind, name);
    if (!spec) { unknown.push(name); continue; }
    const value = op.f[name];
    if (!isScalar(value)) {
      return reject(`op.f["${name}"] must be a JSON scalar or null — no nested objects, no arrays`);
    }
    const bad = checkType(spec, value);
    if (bad) return reject(`op.f["${name}"] ${bad}`);
  }

  if (unknown.length) {
    // Parked WITH ITS OP. Not dropped and not partially applied: applying the known half of an
    // op we do not fully understand is how "does not show the new thing" becomes "loses the new
    // thing" (ADR 001 §7.4).
    return park(
      `unknown field${unknown.length > 1 ? 's' : ''} on ${entity.kind}: ${unknown.join(', ')}`,
      PARK_REASONS.UNKNOWN_FIELD,
      { fields: unknown },
    );
  }

  return { ok: true };
}

/**
 * The explicit triage. ONE place decides admit / park / reject, so nothing downstream has to
 * re-derive parking from a pair of booleans.
 *
 * The future-stamp park (ADR 001 §1.3, §7.4) is applied here rather than in `validateOp` because
 * it is the only check that depends on the local wall clock, which core/ may not read: pass
 * `nowMs` to arm it, omit it to run the pure shape checks alone.
 *
 * @param {Object} op
 * @param {{nowMs?:number, haveEpochKey?:boolean, haveAttestation?:boolean}} [ctx]
 * @returns {{status:'admit'}|{status:'park', reason:string, parkReason:string, fields?:string[]}
 *          |{status:'reject', reason:string}}
 */
export function classifyOp(op, ctx = {}) {
  const shape = validateOp(op);
  if (!shape.ok) {
    if (shape.park) {
      const out = { status: 'park', reason: shape.reason, parkReason: shape.parkReason };
      if (shape.fields) out.fields = shape.fields;
      return out;
    }
    return { status: 'reject', reason: shape.reason };
  }
  if (ctx.haveEpochKey === false) {
    return { status: 'park', reason: 'sealed under an epoch key we do not hold yet', parkReason: PARK_REASONS.EPOCH };
  }
  // The SECOND verdict core/ cannot reach on its own, and it is here for the same reason `epoch`
  // is: `load()` re-classifies every line on purpose, so a reason the classifier cannot re-derive
  // has to be fed back in or the op comes back LIVE. For `attestation` that is not merely a lost
  // diagnostic — it is an op from a device this build refused, applied without a gate, one
  // relaunch later. See `PARK_REASONS.ATTESTATION`.
  if (ctx.haveAttestation === false) {
    return {
      status: 'park',
      reason: 'the authoring device has no attestation yet',
      parkReason: PARK_REASONS.ATTESTATION,
    };
  }
  // The 24 h clamp (ADR 001 §1.3, §7.4). `stamp.js` owns the constant; a peer with a broken clock
  // must not be able to poison every register, and must not silently lose work either.
  if (typeof ctx.nowMs === 'number' && isTooFarFuture(op.ts, ctx.nowMs)) {
    return {
      status: 'park',
      reason: 'stamp is more than 24 h in the future',
      parkReason: PARK_REASONS.FUTURE,
    };
  }
  return { status: 'admit' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The op constructor
// ─────────────────────────────────────────────────────────────────────────────

/** Thrown when a constructor is handed something it cannot build a legal op from. */
export class OpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpError';
  }
}

/**
 * @typedef {Object} OpCtx
 * @property {string} act              the acting MemberId
 * @property {string} dev              the authoring DeviceId
 * @property {string} gid              the transaction group — one user action, one gid (rule U1)
 * @property {() => string} mint       `clock.tick()`; ONE STAMP PER OP (ADR 001 §2)
 * @property {() => string} newOpId    `ids.opId()`
 * @property {string} [space]          the personal space id; defaults to the 'personal'
 *                                     placeholder solo mode uses (ADR 001 §8.2)
 * @property {string|null} [familySpaceId]  null in solo mode; required for family kinds
 * @property {Map<string,Map<string,Object>>} [regs]  OPTIONAL read-only register view — the
 *                                     RegisterMap as it stands BEFORE this transaction. Supplied,
 *                                     the delete constructors use it to decline a delete of an
 *                                     entity that does not exist (ATT-88, see §6's `knows`).
 *                                     Omitted, they cannot judge and build as before.
 */

function requireCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') throw new OpError('an OpCtx is required');
  if (!isMemberId(ctx.act)) throw new OpError(`OpCtx.act must be a MemberId, got ${JSON.stringify(ctx.act)}`);
  if (!isDeviceId(ctx.dev)) throw new OpError(`OpCtx.dev must be a DeviceId, got ${JSON.stringify(ctx.dev)}`);
  if (typeof ctx.mint !== 'function') throw new OpError('OpCtx.mint is required — core/ may not read a clock (ADR 005 §2)');
  if (typeof ctx.newOpId !== 'function') throw new OpError('OpCtx.newOpId is required — core/ may not read a CSPRNG directly');
  return ctx;
}

function spaceFor(kind, ctx) {
  const cls = OP_KINDS[kind].space;
  if (cls === 'local') return LOCAL_SPACE;
  if (cls === 'family') {
    if (!isSpaceId(ctx.familySpaceId) || !String(ctx.familySpaceId).startsWith('fsp_')) {
      throw new OpError(`${kind} needs OpCtx.familySpaceId (an fsp_… id); solo mode emits no family ops`);
    }
    return ctx.familySpaceId;
  }
  const s = ctx.space ?? PERSONAL_PLACEHOLDER;
  if (spaceClassOf(s) !== 'personal') {
    throw new OpError(`OpCtx.space must be a psp_… id or the '${PERSONAL_PLACEHOLDER}' placeholder, got ${JSON.stringify(s)}`);
  }
  return s;
}

/**
 * Build ONE op. The op is validated and frozen before it is returned: ops are immutable and
 * append-only (ADR 001 §2), and an op that fails its own contract must not reach the log.
 *
 * @param {OpCtx} ctx
 * @param {string} k       op kind
 * @param {string} e       entity key
 * @param {Object} f       the field patch — JSON scalars or null only
 * @param {{born?:boolean}} [opts] `born: true` writes `_born` = this op's own stamp
 * @returns {Object} a frozen Op
 */
export function makeOp(ctx, k, e, f, opts = {}) {
  requireCtx(ctx);
  if (!OP_KINDS[k]) throw new OpError(`makeOp: unknown op kind ${JSON.stringify(k)}`);
  const ts = ctx.mint();
  const patch = opts.born ? { ...f, _born: ts } : { ...f };
  // ⚠ ADR 004 §2.2 BARRIER 3 — THE BRAND MUST SURVIVE THIS COPY.
  //
  // `core/project.js:projectForFamily` returns a FROZEN patch carrying a non-enumerable
  // `Symbol.for('lzp/v2/family-patch')`, and `crypto/envelope.js:sealOp` refuses any family-space
  // `pub.set` whose patch is unbranded. `{ ...f }` copies string keys only, so before this loop
  // existed EVERY op built through the shipped constructor arrived at `sealOp` unbranded and was
  // refused — the publish path could not have worked at all, and the failure would have read as a
  // bug in the projection. `PUBLISH_FAILURE_CONTRACT.byReference` states the obligation on the
  // caller; this is the one copy on the path that the caller cannot avoid, so it discharges it
  // here rather than asking every future call site to remember.
  //
  // ONLY WHEN THIS FUNCTION DID NOT WIDEN THE PATCH. A `born: true` op has a DIFFERENT field set
  // from the one the projection asserted and branded, and carrying the brand onto a widened copy
  // is exactly the "take the object the allowlist produced and add a key" attack the freeze in
  // `brandAndFreeze` exists to stop. A family projection carries its own `_born` (ADR 004 §5), so
  // no legitimate family patch reaches this function with `born: true`.
  if (!opts.born && f !== null && typeof f === 'object') {
    for (const s of Object.getOwnPropertySymbols(f)) {
      const d = Object.getOwnPropertyDescriptor(f, s);
      if (d) Object.defineProperty(patch, s, d);
    }
  }
  const op = {
    v: OP_VERSION,
    id: ctx.newOpId(),
    ts,
    space: spaceFor(k, ctx),
    act: ctx.act,
    dev: ctx.dev,
    // rule U6: `pref.set` carries no gid and is never undone.
    gid: k === 'pref.set' ? null : ctx.gid,
    k,
    e,
    f: patch,
  };
  const v = validateOp(op);
  if (!v.ok) throw new OpError(`makeOp built an invalid ${k}: ${v.reason}`);
  Object.freeze(op.f);
  return Object.freeze(op);
}

// ── the eight kind-level constructors ────────────────────────────────────────

/** @param {OpCtx} ctx @param {string} id @param {Object} f @param {{born?:boolean}} [o] */
export const noteSet = (ctx, id, f, o) => makeOp(ctx, 'note.set', noteKey(id), f, o);
/** @param {OpCtx} ctx @param {string} id @param {Object} f @param {{born?:boolean}} [o] */
export const barSet = (ctx, id, f, o) => makeOp(ctx, 'bar.set', barKey(id), f, o);
/** @param {OpCtx} ctx @param {string} id @param {Object} f @param {{born?:boolean}} [o] */
export const catSet = (ctx, id, f, o) => makeOp(ctx, 'cat.set', catKey(id), f, o);
/** @param {OpCtx} ctx @param {string} month `YYYY-MM` @param {Object} f @param {{born?:boolean}} [o] */
export const padSet = (ctx, month, f, o) => makeOp(ctx, 'pad.set', padKey(month), f, o);
/** LOCAL space, no gid, never undone, NEVER SYNCED (ADR 001 §3.3). @param {OpCtx} ctx @param {Object} f */
export const prefSet = (ctx, f) => makeOp(ctx, 'pref.set', PREF_KEY, f);
/** @param {OpCtx} ctx @param {'fnote'|'fbar'} kind @param {string} owner @param {string} uuid @param {Object} f */
export const pubSet = (ctx, kind, owner, uuid, f, o) =>
  makeOp(ctx, 'pub.set', familyKey(kind, owner, uuid), f, o);
/** @param {OpCtx} ctx @param {string} memberId @param {Object} f */
export const memberSet = (ctx, memberId, f, o) => makeOp(ctx, 'member.set', memberKey(memberId), f, o);
/** @param {OpCtx} ctx @param {string} spaceId @param {Object} f */
export const spaceSet = (ctx, spaceId, f) => makeOp(ctx, 'space.set', spaceKey(spaceId), f);

// ─────────────────────────────────────────────────────────────────────────────
// 5. Settings → `pref.set` (ADR 001 §3.3)
//
// "All 15 setSettings and 7 setLayer call sites keep v1 semantics exactly." (The real count in
// the v1 tree is 14 `setSettings` + 7 `setLayer` — see the report accompanying this work package;
// the mapping is the same either way.) Every settings field is device-local presentation state,
// 17.7 establishes per-device density as correct, and `settings.js:143,147` fire on every `input`
// event of a range slider — a synced settings op would be a per-pixel op storm.
//
// CONSEQUENCE FOR 19.4, stated here so nobody re-litigates it in a ticket: "my entire board syncs
// between my devices" means BOARD = CONTENT — notes, bars, categories, scratchpads. Settings are
// presentation and stay per device.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HOW DEEP A `settings` OBJECT MAY NEST BEFORE THE DOOR STOPS READING IT.
 *
 * The shipped tree nests exactly two levels (`layers.feiertage`, `lastSeenSeq.<spaceId>`,
 * `hiddenMembers.<memberId>`), so 32 is a cap nothing legitimate can reach. It is not
 * defensiveness, it is the door policy (`docs/v2/FINDINGS.md` A3-M1a) applied one layer earlier
 * than the `RangeError` catches in `migrate1to2.js` / `replace.js`:
 *
 *   · those catches handle the case where THIS RECURSION overflows the stack, and
 *   · this cap handles the case where it SURVIVES — a `settings` a couple of thousand deep
 *     flattens fine into ONE register name with two thousand dots, `prefsFromRegisters` rebuilds
 *     the nesting iteratively, and `store._project`'s `structuredClone(this.state.settings)`
 *     then overflows OUTSIDE any door, out of `init()`, with `ready === false`. A hand-edited
 *     `board.json` must not be able to make the app unbootable.
 *
 * A cap here also keeps the register name inside `parseEntityKey`'s 300-character world, and it
 * is one of the two locks: `materialize.js:prefsFromRegisters` refuses the same depth on the way
 * back OUT, so a name that arrived from a checkpoint or a peer rather than through this function
 * still cannot build a projection the clone cannot survive.
 */
export const PREF_MAX_DEPTH = 32;

/**
 * Flatten one level of nesting into dotted register names, because `f` is scalars-only.
 * `setLayer({feiertage:true})` → `{'layers.feiertage': true}`.
 *
 * Throws `OpError` on an array and on a patch nested past `PREF_MAX_DEPTH`. Both doors call this
 * ONE KEY AT A TIME inside a `try`, so on externally-sourced settings a refusal costs that key
 * and is reported to the warnings channel; from `settingsSet` / `layerSet` it is a throw, which
 * is what A3-M1a asks for — those two are internal call sites and a bad argument there is
 * programmer error.
 *
 * @param {Object} patch @param {string} [prefix] @param {number} [depth] @returns {Object}
 */
export function flattenPref(patch, prefix = '', depth = 0) {
  if (depth > PREF_MAX_DEPTH) {
    throw new OpError(`pref "${prefix}" nests deeper than ${PREF_MAX_DEPTH} levels; a settings register name is a field name, not a tree`);
  }
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const name = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flattenPref(v, name, depth + 1));
    else if (Array.isArray(v)) throw new OpError(`pref "${name}" is an array; carry set membership as ${name}.<id>: true`);
    else out[name] = v;
  }
  return out;
}

/** `store.setSettings(patch)` → one `pref.set`. @param {OpCtx} ctx @param {Object} patch */
export const settingsSet = (ctx, patch) => prefSet(ctx, flattenPref(patch));
/** `store.setLayer(patch)` → one `pref.set` under `layers.*`. @param {OpCtx} ctx @param {Object} patch */
export const layerSet = (ctx, patch) => prefSet(ctx, flattenPref(patch, 'layers'));

// ─────────────────────────────────────────────────────────────────────────────
// 6. MUTATIONS — every v1 `store.mutate()` site, mapped (ADR 001 §3.2)
//
// Rows 1-22 are the retrofit and are ALL 22 v1 sites; rows 23-27 are the family vocabulary and
// have no v1 site at all (see the block above row 23 — they carry `sites: []` and a `story`, and
// the test asserts the two forms never mix). `V1_MUTATE_SITES` is the flatMap of `sites`, so it
// stays exactly 22 entries however many v2 rows this table grows.
//
// All 22 sites. `[L]` in the ADR marks a site that ALSO writes `settings.lastCategoryId`, which
// becomes a `pref.set` in the `local` space, outside the transaction and therefore NOT undone —
// deliberately reproducing v1's behaviour that `lastCategoryId` survives ⌘Z (recon B5, rule U6).
//
// Each entry names its `sites` (file:line in the v1 tree) and its `label` (the string v1 passes
// to `store.mutate`, verbatim, so `undoStack` labels are unchanged). `tests/tier1/core-ops.test.js`
// enumerates all 22 sites independently and fails if one loses its constructor.
//
// Every constructor returns an Op[]. Building the ops does NOT decide whether to emit them: v1's
// `return false` decline protocol (`store.js:150`) survives verbatim in `store.txn()`, and it
// already prevents 16 no-op mutations from reaching the log. A constructor is called only after
// the caller has decided there is a change.
//
// WITH ONE EXCEPTION, ADDED FOR ATT-88 AND SCOPED TO IT: a DELETE constructor handed a register
// view (`ctx.regs`) declines — returns `[]` — when its target has no registers at all. That is
// not the constructor second-guessing the caller about a change; it is the constructor refusing
// to CREATE an entity in order to tombstone it. See the block above `lastCat` for why a log has
// no no-op deletes.
// ─────────────────────────────────────────────────────────────────────────────

// ── ATT-88: THE EXISTENCE GATE ON THE DELETE CONSTRUCTORS ───────────────────
//
// A tombstone is a WRITE. `note.set{_alive:false}` on an id that has no registers does not
// "delete nothing": it MINTS a register for an entity that never existed, permanently, and the
// family relay then synchronises that phantom to every sibling device. It converges (everybody
// agrees the ghost is dead) and it is invisible on the board (§5 step 3 filters `_alive:false`),
// so nothing ever cleans it up — a stale selection or a double-fire of ⌫ grows the log without
// bound. v1 could afford the same gesture because its delete is `notes.filter(…)`, which is a
// genuine no-op on a missing id; a log has no no-ops.
//
// So the delete constructors ask the register view first. `ctx.regs` is OPTIONAL because a call
// site that has no view (the op-vocabulary tests, a builder used outside a transaction) must
// still be able to build a legal op: with no view the constructor cannot judge and builds as
// before. WITH a view, an unknown target DECLINES.
//
// THE DECLINE IS AN EMPTY OP ARRAY, which is this module's existing "nothing to emit" idiom
// (`lastCat`, `unhide` below) and is exactly the same signal v1's `return false` produces one
// layer up: `store.txn()` returns early on `tx.ops.length === 0` and `undo.js`'s `push()` records
// no step for a group with no undoable register (see the ATT-5 note there). Zero ops IS the
// decline protocol in v2, so a delete constructor does not need a second one.
//
// It is NOT an authorisation check and NOT a liveness check: an already-tombstoned entity still
// HAS registers, so re-deleting it is admitted and stays idempotent under LWW.

/** The empty op list a declining constructor returns. Frozen: it is shared. */
const DECLINED = Object.freeze([]);

/**
 * Does the (optional) register view in `ctx` know this entity at all?
 * @param {OpCtx} ctx @param {string} entityKey @returns {boolean} true when it exists, and true
 *   when no view was supplied — "I cannot tell" must not be read as "it is missing".
 */
const knows = (ctx, entityKey) => {
  const regs = ctx && ctx.regs;
  if (!regs || typeof regs.has !== 'function') return true;
  return regs.has(entityKey);
};

/** Helper: the optional `[L]` pref op. Returns [] when the site did not touch lastCategoryId. */
const lastCat = (ctx, catId) => (catId == null ? [] : [prefSet(ctx, { lastCategoryId: catId })]);

/** Helper: the optional `cat.set{visible:true}` that `store.ensureVisible()` fired (story 4.6). */
const unhide = (ctx, catId) => (catId == null ? [] : [catSet(ctx, catId, { visible: true })]);

/** @type {Object<string, {sites:string[], label:string, kinds:string[], build:Function}>} */
export const MUTATIONS = deepFreeze({
  // 1 ────────────────────────────────────────────────────────────────────────
  /**
   * The v1 label says `delete`, and it lied: the same site deletes a note OR a bar depending on
   * `selection.type`. The op does not lie.
   *
   * ATT-88: `selection` is the one input here that routinely goes stale — the entry can have been
   * deleted on another device, or by a previous ⌫ the user did not see land — so this is the site
   * the existence gate was found on. With `ctx.regs` supplied it declines rather than tombstoning
   * a ghost.
   * @param {OpCtx} ctx @param {{type:'note'|'bar', id:string}} a
   */
  deleteSelected: {
    sites: ['interact.js:72'], label: 'delete', kinds: ['note.set', 'bar.set'],
    build: (ctx, { type, id }) => {
      if (type === 'note') return knows(ctx, noteKey(id)) ? [noteSet(ctx, id, { _alive: false })] : DECLINED;
      if (type === 'bar') return knows(ctx, barKey(id)) ? [barSet(ctx, id, { _alive: false })] : DECLINED;
      throw new OpError(`deleteSelected: type must be 'note' or 'bar', got ${JSON.stringify(type)}`);
    },
  },

  // 2 ────────────────────────────────────────────────────────────────────────
  /** Vertical press-and-drag from an empty day lays down a bar (3.1). `label:''` is v1's value,
   *  and `interact.js:317` goes straight into naming it — which is why `store.txn()` must stay
   *  synchronous through `emit()` (ADR 001 §0.9, §12.1). */
  createBar: {
    sites: ['interact.js:307'], label: 'create-bar', kinds: ['bar.set', 'cat.set'],
    build: (ctx, { id, startDate, endDate, categoryId, visibility = 'privat', unhideCategoryId = null }) => [
      barSet(ctx, id, {
        startDate, endDate, label: '', categoryId, visibility, coEdit: false, _alive: true,
      }, { born: true }),
      ...unhide(ctx, unhideCategoryId),
    ],
  },

  // 3 ────────────────────────────────────────────────────────────────────────
  /** `date` is ABSOLUTE. For a repeat the caller reanchors with `entities.reanchorRepeat()`,
   *  which is `interact.js:330-334` verbatim (9.3: keep the series' first year). */
  moveNote: {
    sites: ['interact.js:324'], label: 'move-note', kinds: ['note.set'],
    build: (ctx, { id, date }) => [noteSet(ctx, id, { date })],
  },

  // 4 ────────────────────────────────────────────────────────────────────────
  /** ABSOLUTE VALUES, NEVER A DELTA (ADR 001 §3.2, §6). The caller computes the new dates with
   *  `entities.addDays()`; a delta op applied twice would move the bar twice. */
  moveBar: {
    sites: ['interact.js:341'], label: 'move-bar', kinds: ['bar.set'],
    build: (ctx, { id, startDate, endDate }) => [barSet(ctx, id, { startDate, endDate })],
  },

  // 5 ────────────────────────────────────────────────────────────────────────
  resizeBar: {
    sites: ['interact.js:352'], label: 'resize-bar', kinds: ['bar.set'],
    build: (ctx, { id, startDate, endDate }) => {
      const f = {};
      if (startDate !== undefined) f.startDate = startDate;
      if (endDate !== undefined) f.endDate = endDate;
      if (!Object.keys(f).length) throw new OpError('resizeBar: give startDate, endDate or both');
      return [barSet(ctx, id, f)];
    },
  },

  // 6 ────────────────────────────────────────────────────────────────────────
  /** The inline editor on the board. `[L]` — `interact.js:546` writes `lastCategoryId`.
   *  `visibility` comes from the category's `defaultVisibility`, read ONCE at creation and never
   *  again (ADR 004 §3); the global default is `'privat'` (16.1). */
  createNoteInline: {
    sites: ['interact.js:543'], label: 'create-note', kinds: ['note.set', 'cat.set', 'pref.set'],
    build: (ctx, { id, date, text, categoryId, visibility = 'privat', unhideCategoryId = null, lastCategoryId = null }) => [
      noteSet(ctx, id, {
        date, text, categoryId, repeatsYearly: false, visibility, coEdit: false, _alive: true,
      }, { born: true }),
      ...unhide(ctx, unhideCategoryId),
      ...lastCat(ctx, lastCategoryId),
    ],
  },

  // 7 ────────────────────────────────────────────────────────────────────────
  /** 2.2 — clearing the text is how you delete without a dialog. `[L]` only when the category
   *  actually changed (`interact.js:573-575`). */
  editNoteInline: {
    sites: ['interact.js:565'], label: 'edit-note', kinds: ['note.set', 'pref.set'],
    build: (ctx, { id, text, categoryId = null, lastCategoryId = null }) => {
      // the empty-text branch IS a delete, so it takes the ATT-88 gate with it
      if (text === '') return knows(ctx, noteKey(id)) ? [noteSet(ctx, id, { _alive: false })] : DECLINED;
      const f = { text };
      if (categoryId != null) f.categoryId = categoryId;
      return [noteSet(ctx, id, f), ...lastCat(ctx, lastCategoryId)];
    },
  },

  // 8 ────────────────────────────────────────────────────────────────────────
  /** A bar label may legally be empty (`create-bar` writes `''`), so unlike a note there is no
   *  empty-means-delete branch here — v1 has none either. */
  editBarLabel: {
    sites: ['interact.js:592'], label: 'edit-bar', kinds: ['bar.set', 'pref.set'],
    build: (ctx, { id, label, categoryId = null, lastCategoryId = null }) => {
      const f = { label };
      if (categoryId != null) f.categoryId = categoryId;
      return [barSet(ctx, id, f), ...lastCat(ctx, lastCategoryId)];
    },
  },

  // 9 ────────────────────────────────────────────────────────────────────────
  /** THE 600 ms DEBOUNCE IS THE OP BOUNDARY (recon B9, rule U9) so ⌘Z is not per keystroke.
   *  v1 stores the UNTRIMMED value when `.trim()` is non-empty (`interact.js:621`). */
  padTyping: {
    sites: ['interact.js:618'], label: 'pad', kinds: ['pad.set'],
    build: (ctx, args) => padOps(ctx, args),
  },

  // 10 ───────────────────────────────────────────────────────────────────────
  /** The blur path bypasses the debounce and commits immediately (`interact.js:625-636`). Same
   *  op shape; a separate site because a missed one is a lost paragraph. */
  padBlur: {
    sites: ['interact.js:631'], label: 'pad', kinds: ['pad.set'],
    build: (ctx, args) => padOps(ctx, args),
  },

  // 11 ───────────────────────────────────────────────────────────────────────
  /** The popover's "+ Notiz". NOTE: unlike site #6 this does NOT write `lastCategoryId` — it
   *  only READS it (`popover.js:158`). ADR 001 §3.2 marks this row `[L]`; the v1 source does not
   *  support that and it is reported as an ADR error. `lastCategoryId` is still accepted here so
   *  a future story can turn it on deliberately rather than by drift. */
  createNotePopover: {
    sites: ['popover.js:159'], label: 'create-note', kinds: ['note.set', 'cat.set', 'pref.set'],
    build: (ctx, { id, date, text, categoryId, visibility = 'privat', unhideCategoryId = null, lastCategoryId = null }) => [
      noteSet(ctx, id, {
        date, text, categoryId, repeatsYearly: false, visibility, coEdit: false, _alive: true,
      }, { born: true }),
      ...unhide(ctx, unhideCategoryId),
      ...lastCat(ctx, lastCategoryId),
    ],
  },

  // 12 ───────────────────────────────────────────────────────────────────────
  recategoriseNote: {
    sites: ['popover.js:183'], label: 'recategorise', kinds: ['note.set', 'pref.set'],
    build: (ctx, { id, categoryId, lastCategoryId = categoryId }) => [
      noteSet(ctx, id, { categoryId }),
      ...lastCat(ctx, lastCategoryId),
    ],
  },

  // 13 ───────────────────────────────────────────────────────────────────────
  /** ONE OP, TWO FIELDS, ONE STAMP (ADR 001 §3.2 row 13).
   *  9.5 — the series starts in the year it was switched on, so turning the repeat ON reanchors
   *  the note to the occurrence the user was looking at (`popover.js:208`). Turning it OFF leaves
   *  the date alone in v1, so `date` is optional here: writing an unchanged value at a fresh
   *  stamp would let a toggle beat a concurrent remote move for no reason. */
  toggleRepeat: {
    sites: ['popover.js:202'], label: 'toggle-repeat', kinds: ['note.set'],
    build: (ctx, { id, repeatsYearly, date }) => {
      if (repeatsYearly === true && date === undefined) {
        throw new OpError('toggleRepeat: switching a repeat ON must carry the anchor date (story 9.5)');
      }
      const f = { repeatsYearly };
      if (date !== undefined) f.date = date;
      return [noteSet(ctx, id, f)];
    },
  },

  // 14 ───────────────────────────────────────────────────────────────────────
  deleteNotePopover: {
    sites: ['popover.js:217'], label: 'delete-note', kinds: ['note.set'],
    build: (ctx, { id }) => (knows(ctx, noteKey(id)) ? [noteSet(ctx, id, { _alive: false })] : DECLINED),
  },

  // 15 ───────────────────────────────────────────────────────────────────────
  recategoriseBar: {
    sites: ['popover.js:236'], label: 'recategorise-bar', kinds: ['bar.set', 'pref.set'],
    build: (ctx, { id, categoryId, lastCategoryId = categoryId }) => [
      barSet(ctx, id, { categoryId }),
      ...lastCat(ctx, lastCategoryId),
    ],
  },

  // 16 ───────────────────────────────────────────────────────────────────────
  /** The popover's inline text edit. Like #7 an empty text deletes, but unlike #7 there is no
   *  category picker in this row, so no `categoryId` and no `lastCategoryId` — ADR 001 §3.2's
   *  "as #7 `[L]`" over-reaches and it is reported as an ADR error. */
  editNotePopover: {
    sites: ['popover.js:266'], label: 'edit-note', kinds: ['note.set'],
    build: (ctx, { id, text }) => {
      if (text !== '') return [noteSet(ctx, id, { text })];
      return knows(ctx, noteKey(id)) ? [noteSet(ctx, id, { _alive: false })] : DECLINED;   // ATT-88
    },
  },

  // 17 ───────────────────────────────────────────────────────────────────────
  /** 4.3 — isolate a category by clicking it in the legend. ABSOLUTE, not a toggle: the caller
   *  reads the current value and emits the new one, so two devices toggling concurrently
   *  converge instead of cancelling. */
  toggleCategory: {
    sites: ['legend.js:35'], label: 'toggle-category', kinds: ['cat.set'],
    build: (ctx, { id, visible }) => {
      if (typeof visible !== 'boolean') throw new OpError('toggleCategory: `visible` must be the NEW absolute value');
      return [catSet(ctx, id, { visible })];
    },
  },

  // 18 ───────────────────────────────────────────────────────────────────────
  /** Both language slots explicitly (`legend.js:81-82`): creating a category while the UI is
   *  English must not store the English label as the German name. */
  addCategory: {
    sites: ['legend.js:76'], label: 'add-category', kinds: ['cat.set'],
    build: (ctx, { id, name, nameEn, paletteRef, defaultVisibility = 'privat' }) => [
      catSet(ctx, id, {
        name, nameEn, paletteRef, visible: true, defaultVisibility, _alive: true,
      }, { born: true }),
    ],
  },

  // 19 ───────────────────────────────────────────────────────────────────────
  /** `legend.js:116` — the DE-rename path does `delete x.nameEn`. In a register log there is no
   *  delete: it emits `{nameEn: null}` EXPLICITLY. `null` is a value; `undefined` is not
   *  representable (ADR 001 §2). Omitting it would leave the old English name in a register with
   *  its old stamp and every other device would keep rendering it — the same shape of defect as
   *  ADR 004 §5.1's, one level down. */
  renameCategory: {
    sites: ['legend.js:114'], label: 'rename-category', kinds: ['cat.set'],
    build: (ctx, { id, lang, name }) => {
      if (lang === 'en') return [catSet(ctx, id, { nameEn: name })];
      if (lang === 'de') return [catSet(ctx, id, { name, nameEn: null })];
      throw new OpError(`renameCategory: lang must be 'de' or 'en', got ${JSON.stringify(lang)}`);
    },
  },

  // 20 ───────────────────────────────────────────────────────────────────────
  recolorCategory: {
    sites: ['legend.js:129'], label: 'recolor-category', kinds: ['cat.set'],
    build: (ctx, { id, paletteRef }) => [catSet(ctx, id, { paletteRef })],
  },

  // 21 ───────────────────────────────────────────────────────────────────────
  /** The empty-category path (`legend.js:152`). `[L]` only when the deleted category WAS the
   *  last-used one (`legend.js:154`). */
  deleteCategory: {
    sites: ['legend.js:152'], label: 'delete-category', kinds: ['cat.set', 'pref.set'],
    build: (ctx, { id, lastCategoryId = null }) => {
      if (!knows(ctx, catKey(id))) return DECLINED;                       // ATT-88
      return [catSet(ctx, id, { _alive: false }), ...lastCat(ctx, lastCategoryId)];
    },
  },

  // 22 ───────────────────────────────────────────────────────────────────────
  /**
   * Delete-with-reassign (4.4 — deleting a category with entries never silently drops them).
   *
   * FAN-OUT, ONE `gid`, so ⌘Z stays one step (recon B1/B6). N + M + 1 INDEPENDENT register
   * writes, each naming its target by id and carrying an absolute value. A single
   * "reassign everything pointing at X" op would be non-commutative — its effect would depend on
   * which entities the folding device had already seen — and would break ADR 001 §6. Partial
   * delivery of the group leaves a consistent half-reassigned board that converges when the rest
   * arrives; the group has no cross-device atomicity requirement.
   */
  deleteCategoryReassign: {
    sites: ['legend.js:197'], label: 'delete-category', kinds: ['note.set', 'bar.set', 'cat.set', 'pref.set'],
    build: (ctx, { id, targetId, noteIds = [], barIds = [], lastCategoryId = null }) => {
      if (targetId === id) throw new OpError('deleteCategoryReassign: cannot reassign a category to itself');
      // ATT-88 — the WHOLE group declines. The reassignments are the delete's consequence
      // (4.4: deleting a category never silently drops entries), so with no category to delete
      // there is nothing to reassign either, and emitting the reassigns alone would rewrite live
      // entries to point at `targetId` on the strength of a selection that has already gone.
      if (!knows(ctx, catKey(id))) return DECLINED;
      return [
        ...noteIds.map((n) => noteSet(ctx, n, { categoryId: targetId })),
        ...barIds.map((b) => barSet(ctx, b, { categoryId: targetId })),
        catSet(ctx, id, { _alive: false }),
        ...lastCat(ctx, lastCategoryId),
      ];
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // 23-27 — THE FAMILY VOCABULARY. NO v1 SITE, AND THAT IS THE POINT (finding E6-1)
  //
  // Rows 1-22 above are a RETROFIT: each names the `store.mutate()` call site in the v1 tree it
  // replaces, and `V1_MUTATE_SITES` is asserted against a list read out of that tree by hand. The
  // five rows below have no v1 site, because the Familienkreis has no v1. They therefore carry
  // `sites: []` and a `story` instead, and `core-ops.test.js` asserts the two are mutually
  // exclusive — a v2 row that grew a `sites` entry would corrupt the 22-site proof, and a v1 row
  // that lost one would be invisible without it.
  //
  // WHY THEY ARE IN *THIS* TABLE AND NOT A SECOND ONE. `store.apply(name, args)` is the shortest
  // safe route from a gesture to the log: it builds through `makeOp` (validated and frozen before
  // it can reach the log), commits through `_commit` (one group, one gid, one broadcast) and
  // takes the decline protocol with it. A parallel table would be a second door with its own
  // answer to "is this op legal", and the point of `MUTATIONS` is that there is one.
  //
  // NONE OF THE FIVE IS UNDOABLE, and that is not this table's decision: `core/undo.js`'s
  // `UNDOABLE_KINDS` is note/bar/cat/pad, so `captureImages` filters `member.set` and `space.set`
  // out of both images and `_commit` records no step for them (rule U6). ⌘Z after a rename does
  // what it did before the rename — which is what 18.4 asks for, from the other side.
  //
  // ── WHAT EACH ROW REFUSES AT AUTHORING TIME, AND WHY IT REFUSES IT HERE ─────────────────────
  //
  // ADR 001 §4 is a fold every honest client applies to the SAME op set, so an inadmissible op is
  // rejected by every peer *including its author's other Mac*. That is exactly right for a
  // hostile client and exactly wrong as a user experience: the op lands in my log, my board
  // updates, my outbox pushes it, the relay stores it, and every peer drops it in silence. The
  // gesture worked everywhere except where it mattered.
  //
  // So each constructor mirrors the §4 predicate it can evaluate LOCALLY — never as a
  // substitute for the fold (which stays the authority), but so the one machine that can still
  // do something about it is told. Finding **E6-2** is precisely this failure with the seat of
  // the admin in it: "the outgoing admin demotes himself, the successor is never promoted, the
  // circle ends with no admin anywhere and no route back".
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  // 23 ───────────────────────────────────────────────────────────────────────
  /**
   * **Story 15.6 — "I can change my display name and colour anytime and it propagates to
   * everyone's boards, so identity stays current without admin involvement."**
   *
   * THE MEMBER ID IS `ctx.act` AND IS NOT AN ARGUMENT. ADR 001 §4.2: `member.set{displayName,
   * colorRef}` is admissible **only** if `op.act === memberId`. Taking a memberId here would make
   * "rename Mama from my Mac" a call somebody could write, an op every peer would reject, and a
   * rename that appears to work on the one board where it must not. Structural beats checked.
   *
   * `null` CLEARS (ADR 001 §5 step 1 · ADR 004 §5.1): `colorRef: null` means "no colour of my
   * own", which the legend renders from the palette, and is a different fact from never having
   * set one. Both fields are optional so that changing only the colour does not restate the name
   * at a fresh stamp and beat a concurrent rename from my other Mac for no reason (the same rule
   * `toggleRepeat` keeps for `date`).
   *
   * IT NEVER TOUCHES `dev.*`. §4.0: a patch mixing `dev.*` with ordinary member fields "has two
   * predicates and no single answer and is refused whole", so the two live in two constructors
   * that cannot be talked into being one — see `attestMyDevice`.
   * @param {OpCtx} ctx @param {{displayName?:string|null, colorRef?:string|null}} a
   */
  setMyProfile: {
    sites: [], story: '15.6', label: 'profile', kinds: ['member.set'],
    build: (ctx, { displayName, colorRef } = {}) => {
      const f = {};
      if (displayName !== undefined) f.displayName = displayName;
      if (colorRef !== undefined) f.colorRef = colorRef;
      if (!Object.keys(f).length) {
        throw new OpError('setMyProfile: give displayName, colorRef or both (story 15.6)');
      }
      return [memberSet(ctx, ctx.act, f)];
    },
  },

  // 24 ───────────────────────────────────────────────────────────────────────
  /**
   * **ADR 001 §4.0 — MY OWN DEVICE ATTESTATION, PUBLISHED INTO THE FAMILY LOG.**
   *
   * The self-authorizing bootstrap: "a `member.set` patch consisting **solely** of `dev.*`
   * registers is self-authorizing on `op.act === memberId`", because requiring an already-attested
   * device to author an attestation has no base case. This constructor is the only thing in the
   * product that can author one, and without it `core/authz.js` stage 0b answers
   * `unattestedDevice` for **every op every peer ever sends me** — correctly parked by the engine
   * and by `applyRemote`, and curable by nothing, for ever. That is finding E6-1 read from the
   * far side: not "my name is missing" but "the circle cannot admit a single op".
   *
   * THE IDEMPOTENCE GATE IS LOAD-BEARING AND IS NOT ATT-88's. §4.0's write-once is an
   * ADMISSIBILITY rule: "only the minimal claim under ≺ is admitted and every later claim is
   * rejected outright". So a second op for a short I have already published is not a harmless
   * duplicate — it is an op every peer REJECTS, and re-minting one on every launch (which is
   * exactly what an ungated call from an arming path does) grows the log by one permanently-dead
   * line per launch. With a register view it therefore DECLINES when the register already carries
   * this blob, and REFUSES LOUDLY when it carries a different one, because that second case is
   * either a re-minted attestation (which write-once will never accept) or somebody else's, and
   * silently emitting a doomed op is the thing this whole block exists to stop.
   * @param {OpCtx} ctx @param {{deviceShort:string, blob:string}} a
   */
  attestMyDevice: {
    sites: [], story: 'ADR 001 §4.0', label: 'attest-device', kinds: ['member.set'],
    build: (ctx, { deviceShort, blob } = {}) => {
      if (typeof blob !== 'string' || blob === '') {
        throw new OpError('attestMyDevice: `blob` is the b64url DeviceAttestation and must be a non-empty string');
      }
      const name = `dev.${deviceShort}`;
      if (!DEV_REGISTER_RE.test(name)) {
        throw new OpError(`attestMyDevice: ${JSON.stringify(deviceShort)} is not a 16-character Crockford deviceShort (ADR 001 §1.2)`);
      }
      const held = registerValueIn(ctx, memberKey(ctx.act), name);
      if (held !== undefined) {
        if (held === blob) return DECLINED;                       // already published; write-once
        throw new OpError(
          `attestMyDevice: ${name} is already attested with a different blob. ADR 001 §4.0 makes `
          + 'that register write-once, so a replacement is rejected by every peer rather than '
          + 'applied — this device would go on authoring ops nobody can admit.');
      }
      return [memberSet(ctx, ctx.act, { [name]: blob })];
    },
  },

  // 25 ───────────────────────────────────────────────────────────────────────
  /**
   * **Story 20.1 — the admin renames the space.** ADR 001 §4.1: `space.set{name}` is admissible
   * only from `op.act === admin@op.ts`. The space id comes from `ctx.familySpaceId` — `spaceFor`
   * has already refused a ctx without one — so a rename cannot be addressed at another circle.
   *
   * The ADMIN CHECK is `mustBeSittingAdmin`: without it, a member whose admin badge is one sync
   * stale renames the circle on their own board and on nobody else's, permanently, with no error
   * anywhere. See the block above row 23.
   * @param {OpCtx} ctx @param {{name:string}} a
   */
  renameSpace: {
    sites: [], story: '20.1', label: 'rename-space', kinds: ['space.set'],
    build: (ctx, { name } = {}) => {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new OpError('renameSpace: a Familienkreis name must be a non-empty string (story 20.1)');
      }
      mustBeSittingAdmin(ctx, 'renameSpace');
      return [spaceSet(ctx, ctx.familySpaceId, { name })];
    },
  },

  // 26 ───────────────────────────────────────────────────────────────────────
  /**
   * **ADR 001 §4.1 — THE GENESIS LINK.** "the space-create op has `adminPrev: null` and
   * `admin: <creator>`; it is admissible only if `op.act === op.f.admin`."
   *
   * Story 15.2 ("I create a Familienkreis and automatically become its admin") is the gesture;
   * this op is the *record*, and §4.1 is explicit that it is the only one: "the admin is resolved
   * entirely from the op set — never from a server column", so that a compromised relay cannot
   * rewrite a role table and thereby flip the validity of an admin unshare.
   *
   * Until this op exists, `adminAtIn` answers `null` for every stamp — so on a circle created by
   * this build **20.1's rename and 20.2's member removal are inadmissible from everybody,
   * including the creator**, and there is no link for a transfer to name. It is therefore the
   * root of every other row in this block, and it is emitted at creation, once.
   *
   * `admin` IS `ctx.act`, for the same structural reason as row 23. It DECLINES when the space
   * register already carries an admin: a second genesis link is not a correction, it is a rival
   * root that `resolveChain` decides by longest-chain-then-stamp — the one shape in this design
   * where two honest devices can disagree about who is in charge.
   * @param {OpCtx} ctx
   */
  claimAdmin: {
    sites: [], story: '15.2 · ADR 001 §4.1', label: 'claim-admin', kinds: ['space.set'],
    build: (ctx) => {
      const seated = registerValueIn(ctx, familySpaceKey(ctx, 'claimAdmin'), 'admin');
      if (seated !== undefined && seated !== null) return DECLINED;
      return [spaceSet(ctx, ctx.familySpaceId, { admin: ctx.act, adminPrev: null })];
    },
  },

  // 27 ───────────────────────────────────────────────────────────────────────
  /**
   * **Story 20.1's transfer — ADR 001 §4.1's TRANSFER LINK, and finding E6-2's cure.**
   *
   * "admissible only if `op.act === admin(link named by adminPrev)` and `adminPrev` names an
   * already-accepted link."
   *
   * THE MEASURED FAILURE THIS REFUSES. E6-2, on two Macs: `POST /members/transfer` answers
   * `{authoritative:false, stored:'nothing'}` by design, so with no op in the log "the outgoing
   * admin demotes himself, the successor is never promoted, the circle ends with no admin
   * anywhere and no route back". Every one of the three checks below is a way that outcome was
   * reachable:
   *
   *   · `adminPrev: null` would be a ROOTLESS ASSERTION. `resolveChain` roots only on
   *     `prev === null ∧ act === admin`, so a transfer TO SOMEBODY ELSE with a null prev is not a
   *     root and not a transfer — it is an orphan, dropped by every peer, seat lost.
   *   · a non-MemberId `admin` passes `FIELDS.space.admin`'s `{t:'id'}` (any non-empty string)
   *     and is then refused by `chainLink`'s `isMemberId`. The op is legal and the link is not:
   *     the register would read the typo on my board alone.
   *   · a transfer authored by anyone but the SITTING admin is refused at `op.act !== link.admin`.
   *     This is the stale-badge case and it is the likeliest of the three in a real family.
   *
   * `adminPrev` names the head of the accepted chain. `store.familyAdmin()` is where a caller
   * gets it; it is not derived here, because the chain is `core/authz.js`'s to resolve and a
   * second resolver would be a second answer to who is in charge.
   * @param {OpCtx} ctx @param {{admin:string, adminPrev:string}} a
   */
  transferAdmin: {
    sites: [], story: '20.1 · ADR 001 §4.1', label: 'transfer-admin', kinds: ['space.set'],
    build: (ctx, { admin, adminPrev } = {}) => {
      if (!isMemberId(admin)) {
        throw new OpError(`transferAdmin: \`admin\` must be a MemberId, got ${JSON.stringify(admin)} — a chain link naming anything else is dropped by every peer (ADR 001 §4.1)`);
      }
      if (!isOpId(adminPrev)) {
        throw new OpError(
          'transferAdmin: `adminPrev` must be the opId of the link this transfer supersedes '
          + '(store.familyAdmin().headOpId). A transfer with no predecessor is a rootless admin '
          + 'assertion, and ADR 001 §4.1 roots only on `adminPrev: null` AND `act === admin` — '
          + 'so it would hand the seat to nobody.');
      }
      mustBeSittingAdmin(ctx, 'transferAdmin');
      return [spaceSet(ctx, ctx.familySpaceId, { admin, adminPrev })];
    },
  },

  // 28 ───────────────────────────────────────────────────────────────────────
  /**
   * **Story 20.2 / LZP-608 — THE ADMIN REMOVES A MEMBER.** ADR 001 §4.2's removal branch: the one
   * op in this system by which one member touches another member's record.
   *
   * **THE PATCH IS EXACTLY `{_alive:false}` AND THAT IS A HARD SHAPE, NOT A CONVENTION.**
   * `core/authz.js` stage 2 reads
   *
   *     const onlyAlive = names.length === 1 && names[0] === '_alive';
   *
   * and admits an admin's write to somebody else's member record ONLY through that branch. A patch
   * carrying one extra field — a tidy `removedAt`, a helpful `reason` — falls through to
   * `reject(op, STAGES[2], NOT_SELF)`: built here, sealed, accepted by the relay, pulled by every
   * Mac in the family and dropped by all of them **in silence**. Nothing would report it except a
   * member list that never changed. So the patch is written once, here, and the constructor takes
   * no field arguments at all — there is no parameter through which a caller could add one.
   *
   * **REMOVING YOURSELF IS A DIFFERENT STORY AND A DIFFERENT ROUTE.** 20.3 is „Kreis verlassen":
   * `POST /members/leave`, which the relay accepts from the member themselves and which clears the
   * circle prefs on that Mac. Authoring `member.set{_alive:false}` against my own record would be
   * admitted by stage 2's `self` branch a line ABOVE the admin branch — so it would work, and it
   * would be the wrong thing: it marks the seat dead in the log while leaving the membership row,
   * the device row and the key wraps alive on the relay. Refused by name so the caller is sent to
   * the route that actually leaves.
   *
   * **THE ADMIN CHECK IS `mustBeSittingAdmin`**, the same one rows 25 and 27 use, and for the same
   * measured reason: without it a member whose admin badge is one sync stale removes somebody on
   * their own board and on nobody else's, permanently, with no error anywhere.
   *
   * `family/removal.js` is the caller. It owns the ORDER — rotate ▸ author ▸ publish ▸ syncNow —
   * and the epoch rotation ADR 002 §4.1 requires; this row owns the op.
   * @param {OpCtx} ctx @param {{memberId:string}} a
   */
  removeMember: {
    sites: [], story: '20.2 · ADR 001 §4.2', label: 'remove-member', kinds: ['member.set'],
    build: (ctx, { memberId } = {}) => {
      if (!isMemberId(memberId)) {
        throw new OpError(`removeMember: \`memberId\` must be a MemberId, got ${JSON.stringify(memberId)}`);
      }
      if (memberId === ctx.act) {
        throw new OpError(
          'removeMember: this is the admin\'s removal of ANOTHER member (20.2). Leaving a circle '
          + 'yourself is story 20.3 — `POST /members/leave` — which also releases the membership '
          + 'row, the device row and the key wraps on the relay; a `member.set{_alive:false}` '
          + 'against your own record would be admitted by authz stage 2\'s SELF branch and would '
          + 'leave every one of those behind.');
      }
      mustBeSittingAdmin(ctx, 'removeMember');
      return [memberSet(ctx, memberId, { _alive: false })];
    },
  },
});

/**
 * One register's value out of the OPTIONAL view in `ctx`, or `undefined` when there is no view
 * and when the register was never written. Deliberately the same "I cannot tell" shape `knows()`
 * has: a constructor called without a view (the op-vocabulary tests, a builder used outside a
 * transaction) must still be able to build a legal op.
 * @param {OpCtx} ctx @param {string} entityKey @param {string} field @returns {any}
 */
function registerValueIn(ctx, entityKey, field) {
  const regs = ctx && ctx.regs;
  if (!regs || typeof regs.get !== 'function') return undefined;
  const cells = regs.get(entityKey);
  if (!cells || typeof cells.get !== 'function') return undefined;
  const cell = cells.get(field);
  return cell === undefined ? undefined : cell.value;
}

/**
 * `space:<fsp_…>` for the ctx's family space, refusing with `spaceFor`'s own sentence rather than
 * with `spaceKey`'s `EntityKeyError`. The three `space.set` rows read the register BEFORE they
 * build an op, so without this the first thing a solo caller would see is a message about a bad
 * SpaceId rather than the one that says solo mode emits no family ops.
 * @param {OpCtx} ctx @param {string} who @returns {string}
 */
function familySpaceKey(ctx, who) {
  const sid = ctx && ctx.familySpaceId;
  if (!isSpaceId(sid) || !String(sid).startsWith('fsp_')) {
    throw new OpError(`${who} needs OpCtx.familySpaceId (an fsp_… id); solo mode emits no family ops`);
  }
  return spaceKey(sid);
}

/**
 * ADR 001 §4.1's admin predicate, evaluated against the folded `space:` register.
 *
 * WHY THE REGISTER IS THE RIGHT SOURCE HERE and the chain walk is not: `applyRemote` gates on
 * `foldAuthorized` BEFORE anything reaches the log, so a link that lost the longest-chain
 * resolution never became a register write. `space:<id>` → `admin` is therefore the accepted
 * chain's head value, read where a constructor can reach it, and `core/authz.js` stays the only
 * thing that RESOLVES a chain.
 *
 * With no view it does not refuse. See `knows()`: "I cannot tell" must not be read as "no".
 * @param {OpCtx} ctx @param {string} who the constructor name, for the message
 */
function mustBeSittingAdmin(ctx, who) {
  const seated = registerValueIn(ctx, familySpaceKey(ctx, who), 'admin');
  if (seated === undefined) return;                     // no view, or no chain yet — cannot judge
  if (seated === ctx.act) return;
  throw new OpError(
    `${who}: this Mac is not the Familienkreis admin — the seat is held by ${JSON.stringify(seated)}. `
    + 'ADR 001 §4.1 admits a `space.set` only from `op.act === admin@op.ts`, so this op would be '
    + 'applied here and rejected by every other member: the change would appear to work on the '
    + 'one board where it must not.');
}

/** Sites 9 and 10 share their op shape. @param {OpCtx} ctx @param {{month:string,text:string,born?:boolean}} a */
function padOps(ctx, { month, text, born = false }) {
  if (typeof text !== 'string') throw new OpError('pad: `text` must be a string');
  // v1: `if (val.trim()) s.scratchpads[key] = val; else delete s.scratchpads[key];`
  //
  // ATT-88 APPLIES HERE TOO, and this was the last path still open. Blanking a month that never
  // had a scratchpad is `delete` on a missing key in v1 — a genuine no-op — and a phantom
  // `pad:<month>` register here, which is exactly the defect ATT-88 names. It is also the MOST
  // REACHABLE phantom in the app: `interact.js:631` fires on blur, so clicking into an empty
  // scratchpad and clicking out again is enough to mint one, and the family relay then
  // synchronises it to every sibling device forever.
  //
  // It was left open by the ATT-88 pass because `tests/attack/v1-fidelity-core.test.js`'s ATT-61
  // asserted the ungated behaviour as v1 PARITY. That parity is real but it is the ATT-5 case:
  // v1's `mutate()` asks only `r === false` and never whether anything changed, so it records an
  // undo step whose pre-image equals its post-image — a ⌘Z that undoes nothing. v2 declines
  // instead, deliberately and in exactly one documented way (zero ops), and the seven other
  // delete constructors above already make that trade. Leaving this one site ungated would have
  // been the incoherent outcome: the same defect refused in seven places and minted in the
  // eighth, for a parity the suite has already decided not to keep.
  if (!text.trim()) {
    if (!knows(ctx, padKey(month))) return DECLINED;
    return [padSet(ctx, month, { _alive: false })];
  }
  return [padSet(ctx, month, { text, _alive: true }, { born })];
}

/** Every v1 mutate site this module covers, as `file:line`. The test enumerates them
 *  independently from the v1 source and fails if the two lists ever disagree. */
export const V1_MUTATE_SITES = Object.freeze(
  Object.values(MUTATIONS).flatMap((m) => m.sites).sort(),
);

/** @param {string} name @returns {{sites:string[], label:string, build:Function}} */
export function mutation(name) {
  const m = MUTATIONS[name];
  if (!m) throw new OpError(`unknown mutation ${JSON.stringify(name)}`);
  return m;
}

/**
 * Build the ops for one v1 mutation by name.
 * @param {string} name @param {OpCtx} ctx @param {Object} args @returns {Object[]} frozen Ops
 */
export function buildMutation(name, ctx, args) {
  return Object.freeze(mutation(name).build(ctx, args || {}));
}

// ─────────────────────────────────────────────────────────────────────────────

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}
