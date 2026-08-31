// src/js/core/entities.js — entity keys, the ONE shared day-selector, renderability, sorts.
// ADR 001 §1.1, §4.4, §5 · ADR 004 §9 · ADR 005 §1.1, §3 · ops.contract.js §2, §5.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2).
//
// THREE THINGS LIVE HERE, AND EACH IS HERE FOR A NAMED REASON.
//
// 1. ENTITY KEYS — STRUCTURAL OWNERSHIP (ADR 001 §4.4, §12.3).
//    A family entity's key literally contains its owner's member id:
//      fnote:mem_2bK7xQ9pLmR0aZ4tV9/5e1a-…-9c
//    There is NO `owner` register anywhere in this system, and there must never be one. Every
//    design the panel reviewed resolved ownership as "the author of the write with the smallest
//    stamp"; stamps have no lower bound, so a member running a modified client could emit an
//    owner write backdated to ms = 0 and take over any entity — defeating story 18.1 with one
//    line. Here `ownerOfEntity()` is a substring operation on a key the ciphertext is bound to,
//    and admissibility compares it to `op.act`, which is bound to a device attestation, which is
//    bound to the member's recovery key. There is nothing to backdate. That is property P9.
//
// 2. THE ONE SHARED DAY-SELECTOR (ADR 005 §3, ADR 004 §4.3).
//    `popover.js:47-61` re-implements the day query that `layout.js:61-79` + `:132-135` already
//    performs. Two implementations of the same question agree today by luck; in v2 the popover
//    copy would silently omit foreign entries unless someone updated it in lockstep, and 17.1
//    and A6 would then disagree about what is "on" a day. The fix is not "remember to update
//    both" — it is to delete one of them. Everything below reproduces v1's selection semantics
//    EXACTLY (repeat-occurrence expansion included, hidden-category tri-state included) so that
//    pointing both call sites here in WP-5 is a no-op on a solo board.
//
//    Single-day and whole-range selection go through the SAME code path — `notesOnDate` is
//    literally `noteOccurrencesInRange(state, date, date, ctx).get(date)`. Agreement between the
//    popover and the board is therefore true by construction, not by a test that has to be
//    remembered.
//
// 3. DATE PRIMITIVES, COPIED — NOT IMPORTED.
//    `src/js/dates.js` already has `parseISO`, `iso`, `p2`, `addDays`, `projectYearly`. ADR 005
//    §2's dependency rule allows `src/js/core/` to import from `src/js/core/` and NOWHERE else,
//    and `tests/tier1/core-purity.test.js` enforces that mechanically, so core cannot reach for
//    them. They are re-implemented below and pinned to the v1 originals by an equivalence test
//    (`core-ops.test.js`, "date primitives agree with v1 dates.js") over every month/day/year in
//    a wide range — including the Feb-29 rule (9.4) and the leap boundaries. If the two ever
//    diverge, that test goes red before anything renders.

import { cmp } from './stamp.js';
// THE VISIBILITY SEAM (ADR 004 §2.1, §4.2). `projectable` and `renderableNote` below used to
// spell `'privat'` and `'belegt'` as inline string comparisons — a viewer-side PRIVACY decision
// written as a literal inside a renderability predicate, in a file whose header is about entity
// keys and day selection. `core/visibility.js` owns the levels and what each one discloses;
// this file asks it. See the note on `projectedToPeers` at `projectable`.
import { projectedToPeers, isRedacted, VISIBILITY_LEVELS as LEVELS } from './visibility.js';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Entity kinds
// ─────────────────────────────────────────────────────────────────────────────

/** Every entity kind in the system. ops.contract.js §1's EntityKind. */
export const ENTITY_KINDS = Object.freeze([
  'note', 'bar', 'cat', 'pad', 'pref', 'fnote', 'fbar', 'member', 'space',
]);

/** Personal-space (and `local`, for `pref`) kinds — THE TRUTH (ADR 004 §1). */
export const TRUTH_KINDS = Object.freeze(['note', 'bar', 'cat', 'pad', 'pref']);

/** Family-space kinds — THE PUBLICATION plus governance. */
export const FAMILY_KINDS = Object.freeze(['fnote', 'fbar', 'member', 'space']);

/**
 * The two family kinds whose key carries an owner segment. `member:` and `space:` are family
 * entities too, but they are not owned BY a member in the `<memberId>/<uuid>` sense — a member
 * record IS the member, and a space belongs to its admin chain (ADR 001 §4.1).
 */
export const OWNED_FAMILY_KINDS = Object.freeze(['fnote', 'fbar']);

/** truth kind → its family publication kind. */
export const FAMILY_OF = Object.freeze({ note: 'fnote', bar: 'fbar' });
/** family publication kind → the truth kind it publishes. */
export const TRUTH_OF = Object.freeze({ fnote: 'note', fbar: 'bar' });

/**
 * The three visibility levels, in increasing order of disclosure (16.1–16.7).
 *
 * DEFINED IN `core/visibility.js` AND RE-EXPORTED HERE, unchanged in name and value, so that
 * `ops.js`, `crypto/envelope.js` and `core/project.js` keep importing it from where they always
 * did. The definition moved because the ORDER of this array is what every rank, comparison and
 * upgrade/downgrade classification in the product is computed from, and it belongs beside the
 * predicates that would have to answer for a fourth level rather than one line under the
 * entity-kind tables, where nothing reads it.
 */
export const VISIBILITY_LEVELS = LEVELS;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Entity keys
// ─────────────────────────────────────────────────────────────────────────────

/** 22 base64url characters = 128 bits (ADR 001 §1.2). */
const B22 = '[A-Za-z0-9_-]{22}';
const MEMBER_ID_RE = new RegExp(`^mem_${B22}$`);
const DEVICE_ID_RE = new RegExp(`^dev_${B22}$`);
const SPACE_ID_RE = new RegExp(`^(?:psp_|fsp_)${B22}$`);
const OP_ID_RE = new RegExp(`^${B22}$`);

/**
 * v1's entity ids: `crypto.randomUUID()` normally, and `id-<base36>-<base36>` from the fallback
 * at `store.js:14-16`. Migration keeps BOTH verbatim — entity uuids are never re-keyed
 * (ADR 001 §1.2) — so this must accept the fallback shape too. What it must NOT accept is a `/`
 * or a `:`, because those are the separators the family key is parsed on: an id containing one
 * would make `fnote:<mem>/<uuid>` ambiguous and therefore make ownership forgeable.
 */
const ENTITY_UUID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** `pad:<YYYY-MM>` — the scratchpad is addressed by month, not by uuid (F10). */
const MONTH_KEY_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/** The single settings entity. `pref:app`, and nothing else, ever (ADR 001 §1.1). */
export const PREF_KEY = 'pref:app';

/** @param {unknown} s @returns {boolean} */
export const isMemberId = (s) => typeof s === 'string' && MEMBER_ID_RE.test(s);
/** @param {unknown} s @returns {boolean} */
export const isDeviceId = (s) => typeof s === 'string' && DEVICE_ID_RE.test(s);
/** @param {unknown} s @returns {boolean} */
export const isSpaceId = (s) => typeof s === 'string' && SPACE_ID_RE.test(s);
/** @param {unknown} s @returns {boolean} */
export const isOpId = (s) => typeof s === 'string' && OP_ID_RE.test(s);
/** @param {unknown} s @returns {boolean} */
export const isEntityUuid = (s) => typeof s === 'string' && ENTITY_UUID_RE.test(s);
/** @param {unknown} s @returns {boolean} */
export const isMonthKey = (s) => typeof s === 'string' && MONTH_KEY_RE.test(s);

/** Thrown by the key CONSTRUCTORS. The parsers never throw; they return null. */
export class EntityKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EntityKeyError';
  }
}

/**
 * A local (personal-space) entity key: `note:<uuid>` · `bar:<uuid>` · `cat:<uuid>` ·
 * `pad:<YYYY-MM>` · `pref:app`.
 * @param {'note'|'bar'|'cat'|'pad'|'pref'} kind
 * @param {string} id  a uuid, a `YYYY-MM` month key, or `'app'` for pref
 * @returns {string}
 */
export function localKey(kind, id) {
  switch (kind) {
    case 'note':
    case 'bar':
    case 'cat':
      if (!isEntityUuid(id)) throw new EntityKeyError(`localKey: bad ${kind} id ${JSON.stringify(id)}`);
      return `${kind}:${id}`;
    case 'pad':
      if (!isMonthKey(id)) throw new EntityKeyError(`localKey: pad id must be YYYY-MM, got ${JSON.stringify(id)}`);
      return `pad:${id}`;
    case 'pref':
      if (id !== undefined && id !== 'app') throw new EntityKeyError(`localKey: the only pref entity is ${PREF_KEY}`);
      return PREF_KEY;
    default:
      throw new EntityKeyError(`localKey: ${JSON.stringify(kind)} is not a local entity kind`);
  }
}

export const noteKey = (uuid) => localKey('note', uuid);
export const barKey = (uuid) => localKey('bar', uuid);
export const catKey = (uuid) => localKey('cat', uuid);
export const padKey = (month) => localKey('pad', month);

/**
 * A family entity key. THIS is where ownership lives (ADR 001 §4.4, §12.3).
 * @param {'fnote'|'fbar'} kind
 * @param {string} owner  the owning MemberId — becomes an unforgeable part of the key
 * @param {string} uuid   the SAME uuid as the owner's truth entity (ADR 004 §9)
 * @returns {string} `fnote:<memberId>/<uuid>`
 */
export function familyKey(kind, owner, uuid) {
  if (kind !== 'fnote' && kind !== 'fbar') {
    throw new EntityKeyError(`familyKey: kind must be 'fnote' or 'fbar', got ${JSON.stringify(kind)}`);
  }
  if (!isMemberId(owner)) {
    throw new EntityKeyError(`familyKey: owner must be a MemberId, got ${JSON.stringify(owner)}`);
  }
  if (!isEntityUuid(uuid)) {
    throw new EntityKeyError(`familyKey: bad entity uuid ${JSON.stringify(uuid)}`);
  }
  return `${kind}:${owner}/${uuid}`;
}

/**
 * The family key that publishes a given truth key. The uuid is carried across unchanged, which
 * is why moving a repeat's anchor (`interact.js:330-334`) cannot change what the family record
 * points at (ADR 004 §9).
 * @param {string} truthKey `note:<uuid>` or `bar:<uuid>`
 * @param {string} owner
 * @returns {string}
 */
export function familyKeyFor(truthKey, owner) {
  const parsed = parseEntityKey(truthKey);
  if (!parsed || !FAMILY_OF[parsed.kind]) {
    throw new EntityKeyError(`familyKeyFor: ${JSON.stringify(truthKey)} has no family counterpart`);
  }
  return familyKey(FAMILY_OF[parsed.kind], owner, parsed.id);
}

/** @param {string} memberId @returns {string} */
export function memberKey(memberId) {
  if (!isMemberId(memberId)) throw new EntityKeyError(`memberKey: bad MemberId ${JSON.stringify(memberId)}`);
  return `member:${memberId}`;
}

/** @param {string} spaceId @returns {string} */
export function spaceKey(spaceId) {
  if (!isSpaceId(spaceId)) throw new EntityKeyError(`spaceKey: bad SpaceId ${JSON.stringify(spaceId)}`);
  return `space:${spaceId}`;
}

/**
 * The one parser. NEVER throws — a malformed key arriving from a peer is data, not a bug in this
 * process, and the caller (validateOp) needs to classify it rather than crash.
 * @param {unknown} e
 * @returns {{kind:string, owner:string|null, id:string, key:string}|null}
 */
export function parseEntityKey(e) {
  if (typeof e !== 'string' || e.length === 0 || e.length > 300) return null;
  const colon = e.indexOf(':');
  if (colon <= 0) return null;
  const kind = e.slice(0, colon);
  const rest = e.slice(colon + 1);

  switch (kind) {
    case 'note':
    case 'bar':
    case 'cat':
      return isEntityUuid(rest) ? { kind, owner: null, id: rest, key: e } : null;
    case 'pad':
      return isMonthKey(rest) ? { kind, owner: null, id: rest, key: e } : null;
    case 'pref':
      return rest === 'app' ? { kind, owner: null, id: rest, key: e } : null;
    case 'fnote':
    case 'fbar': {
      const slash = rest.indexOf('/');
      if (slash <= 0) return null;
      const owner = rest.slice(0, slash);
      const id = rest.slice(slash + 1);
      if (!isMemberId(owner) || !isEntityUuid(id)) return null;
      return { kind, owner, id, key: e };
    }
    case 'member':
      return isMemberId(rest) ? { kind, owner: rest, id: rest, key: e } : null;
    case 'space':
      return isSpaceId(rest) ? { kind, owner: null, id: rest, key: e } : null;
    default:
      return null;
  }
}

/** @param {unknown} e @returns {boolean} */
export const isEntityKey = (e) => parseEntityKey(e) !== null;

/**
 * @param {string} e
 * @returns {string|null} the EntityKind, or null when `e` is not a well-formed entity key.
 *          Non-throwing on purpose: `validateOp` must be able to classify a malformed key.
 */
export function kindOfEntity(e) {
  const p = parseEntityKey(e);
  return p ? p.kind : null;
}

/**
 * The owner segment of a family entity key — the whole of ownership in this system
 * (ADR 001 §4.4). Returns null for a personal-space key, whose owner is trivially me
 * (single-writer space), and null for a malformed key.
 * @param {string} e @returns {string|null}
 */
export function ownerOfEntity(e) {
  const p = parseEntityKey(e);
  if (!p) return null;
  return OWNED_FAMILY_KINDS.includes(p.kind) ? p.owner : null;
}

/** @param {string} e @returns {string|null} the uuid / month key / 'app' segment */
export function idOfEntity(e) {
  const p = parseEntityKey(e);
  return p ? p.id : null;
}

/** @param {unknown} kind @returns {boolean} */
export const isFamilyKind = (kind) => FAMILY_KINDS.includes(kind);
/** @param {unknown} kind @returns {boolean} */
export const isTruthKind = (kind) => TRUTH_KINDS.includes(kind);

// ─────────────────────────────────────────────────────────────────────────────
// 2. Date primitives — copies of src/js/dates.js, pinned by an equivalence test
//
// See the header. `core/` may not import a v1 module (ADR 005 §2), so these are copies of the
// v1 implementations, deliberately line-for-line rather than "improved", so the equivalence test
// compares two things that are meant to be the same rather than two things that happen to agree.
// The Date object is used only as a UTC calculator, exactly as `dates.js` uses it; nothing here
// reads a wall clock (`Date.now` is banned in core/ and does not appear).
// ─────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD`, structurally. Calendar validity is deliberately NOT checked — see ops.js. */
export const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** @param {unknown} s @returns {boolean} */
export const isDateString = (s) => typeof s === 'string' && DATE_RE.test(s);

/**
 * The two ends of `DATE_RE`'s alphabet — R5-11.
 *
 * Every accepted date is exactly ten characters of the fixed shape `dddd-dd-dd`, so the STRING
 * order of two accepted dates is their calendar order, and the extremes of that order are the
 * smallest and largest strings the regex can produce: month and day are both floored at `01` and
 * the year is four unconstrained digits.
 *
 *     '0000-01-01' ≤ every accepted date ≤ '9999-12-31'
 *
 * That is not a nicety. `layout.js:133` decides whether a bar is painted at all by COMPARING its
 * edge against `iso(y, m, 1)` and `iso(y, m, len)` — never by parsing it — so a bar edge the file
 * holds as `''` or `'zzz'` has a well-defined rendering in v1 even though it is not a date, and
 * the only way v2 can reproduce that rendering with a `date` register is to write the end of the
 * alphabet that sorts on the same side. `migrate1to2.js:coerceToV1BarEdge` is the one caller and
 * carries the argument in full; these two constants are here, next to `DATE_RE`, because the
 * claim they make is a claim about `DATE_RE` and about nothing else.
 *
 * Pinned by `core-ops.test.js` §F — a widened `DATE_RE` (a five-digit year, a `+` sign) has to
 * move these with it or the pin goes red.
 */
export const EARLIEST_DATE = '0000-01-01';
export const LATEST_DATE = '9999-12-31';

/** @param {number} n @returns {string} */
export const p2 = (n) => String(n).padStart(2, '0');

/** @param {number} y @param {number} m @param {number} d @returns {string} */
export const iso = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;

/** @param {string} s @returns {{y:number, m:number, d:number}} */
export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

/** @param {string} s @returns {string} `YYYY-MM` */
export const monthKeyOf = (s) => s.slice(0, 7);

/** @param {number} y @param {number} m @returns {number} */
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** `dates.js:dow` — 0 = Sonntag … 6 = Samstag. @param {number} y @param {number} m @param {number} d */
export const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

/** `dates.js:monthOrdinal` — a month on an absolute scale. @param {number} y @param {number} m */
export const monthOrdinal = (y, m) => y * 12 + (m - 1);

/** `dates.js:addMonths`, verbatim. @param {number} y @param {number} m @param {number} n */
export function addMonths(y, m, n) {
  const o = monthOrdinal(y, m) + n;
  return { y: Math.floor(o / 12), m: (o % 12) + 1 };
}

/** @param {number} y @returns {boolean} */
export const isLeap = (y) => daysInMonth(y, 2) === 29;

/** @param {string} s @param {number} n @returns {string} */
export function addDays(s, n) {
  const { y, m, d } = parseISO(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole days from a to b (b - a). @param {string} a @param {string} b @returns {number} */
export function diffDays(a, b) {
  const A = parseISO(a);
  const B = parseISO(b);
  return Math.round((Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / 86400000);
}

/**
 * Yearly-repeat projection (story 9.4): a Feb-29 series shows on Feb 28 in non-leap years;
 * everything else keeps its month and day. `dates.js:projectYearly`, verbatim.
 *
 * ADR 004 §9: no occurrence op ever crosses the wire. A Geteilt yearly repeat publishes
 * `pub.date` (the anchor) and `pub.repeatsYearly: true`, and each peer expands locally with THIS
 * function — which is why a three-weeks-offline device converges with no special handling.
 * @param {string} anchorISO @param {number} year @returns {string}
 */
export function projectYearly(anchorISO, year) {
  const { m, d } = parseISO(anchorISO);
  if (m === 2 && d === 29 && !isLeap(year)) return iso(year, 2, 28);
  return iso(year, m, d);
}

/**
 * Moving a repeating note keeps the series' FIRST year and moves the month/day the whole series
 * lands on — `interact.js:330-334`, verbatim, story 9.3 ("one object per series").
 *
 * ⚠ v1 QUIRK, PRESERVED ON PURPOSE. Dragging a repeat onto 29 February from a note anchored in a
 * non-leap year produces the string `"<nonLeapYear>-02-29"`, a date that does not exist. v1 does
 * exactly this, and it renders correctly anyway because `projectYearly` maps a Feb-29 anchor back
 * to Feb 28 in non-leap years. `ops.js` therefore validates dates for FORMAT, not for calendar
 * validity (ADR 001 §12.8 says `YYYY-MM-DD` everywhere; it does not say "a real day"). Do not
 * "fix" this in the retrofit without a story: it would change which day an existing user's
 * repeating note lands on.
 *
 * @param {string} currentDate the note's current anchor date
 * @param {string} targetDate  the date the user dropped it on
 * @returns {string}
 */
export function reanchorRepeat(currentDate, targetDate) {
  const anchorY = currentDate.slice(0, 4);
  const tgt = parseISO(targetDate);
  return iso(Number(anchorY), tgt.m, tgt.d);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b. THE ONE DATE SHAPE THAT HANGS THE RENDERER (ATT-97 / REG-9)
//
// `holidays.js:51` is `let d = 22; while (dow(year, 11, d) !== 3) d -= 1;`. It answers in at most
// seven steps for every year `dow` can answer for, and for a NaN year — or a year below the
// window `Date.UTC` can represent — it never answers at all: `dow` is NaN, `NaN !== 3` forever,
// `d` runs to −∞ and the app freezes with no error and no frame.
//
// THAT — and nothing narrower — is the condition. The first fix pass guarded `startMonth` with
// `/^\d{4}-(0[1-9]|1[0-2])$/`, which is far stricter than "layout.js can render it": v1 opens
// `'2026-1'` (→ 2026-01), `'2026-13'` (→ 2027-01), `'2026-00'` (→ 2025-12) and `'26-01'`
// (→ 26-01) with twelve columns and no hang, because `parseISO` is `split('-').map(Number)` and
// `addMonths` normalises any month ordinal. Refusing those turned openable boards into an
// unopenable app — a worse bug than the one being fixed. So the guard below reproduces v1's own
// arithmetic and asks the only question that matters: is every year this board puts on screen a
// year `holidays.js` can finish a Buß- und Bettag walk in?
// ─────────────────────────────────────────────────────────────────────────────

/** `layout.js:14` — a board is always exactly twelve columns wide (story 1.1). */
export const MONTHS_VISIBLE = 12;

/**
 * Does `holidays.js:51` — `let d = 22; while (dow(year, 11, d) !== 3) d -= 1;` — terminate for
 * this year, with a real date to show for it?
 *
 * `d` walks DOWN from 22. When `year-11-22` is a date `Date` can represent, a Wednesday is at
 * most seven steps away and the answer is a real Buß- und Bettag. When it is not:
 *   · NaN year, or a year below the representable window (< −271821): `dow` is NaN forever, `d`
 *     runs to −∞ and the app freezes with no error and no frame. THAT is ATT-97.
 *   · a year above the window (> 275759): the walk does come back down into range, but it costs
 *     (year − 275760) × 365 iterations — 3.6e11 of them for `year` 1e9 — and what it finally
 *     returns is a fabricated string like `"275800-11--14012"`, not a holiday. v1 "opens" such a
 *     board only in the sense that it eventually paints corrupted holiday data.
 * So the line is exactly this: every visible year must be one the date arithmetic can express.
 * It is a property of the YEAR, with no threshold to tune, and it holds for every year a board a
 * person could plausibly hand-edit will ever name.
 *
 * @param {number} year @returns {boolean}
 */
export const yearIsRenderable = (year) => Number.isFinite(dow(year, 11, 22));

/**
 * `layout.js:23-27` (`visibleStart`) and `layout.js:98-103` (the twelve `addMonths` and the year
 * set they feed to `holidayIndex`), reproduced for a PINNED board — the only mode that reads
 * `startMonth` — and answered with `yearIsRenderable`.
 *
 * Returns true for every value v1 can actually draw, `'2026-1'` and `'26-01'` included, and
 * false only where rendering would hang. `pageYears` is part of the question because
 * `visibleStart` multiplies it by twelve and adds it: a `pageYears` of 1e9 hangs the same loop
 * from a perfectly well-formed `startMonth`.
 *
 * Never throws: it is a predicate over caller data (a register value, a `ctx.defaultSettings`
 * key), and a hostile shape must be REFUSED, not propagated as an exception of another type.
 *
 * @param {unknown} startMonth @param {unknown} pageYears @returns {boolean}
 */
export function pinnedMonthsRenderable(startMonth, pageYears) {
  try {
    const { y, m } = parseISO(`${startMonth}-01`);        // layout.js:25, verbatim
    const start = addMonths(y, m, (pageYears || 0) * 12); // layout.js:26, verbatim
    const months = [];
    for (let i = 0; i < MONTHS_VISIBLE; i++) months.push(addMonths(start.y, start.m, i)); // :99
    const years = [...new Set(months.map((mo) => mo.y))]; // layout.js:103, verbatim
    return years.every(yearIsRenderable);
  } catch {
    return false;                                         // a Symbol, a BigInt, a throwing toString
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE SHARED DAY-SELECTOR (ADR 005 §3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SelectorCtx
 * @property {(catId:string) => boolean} [categoryVisible]
 *           Defaults to v1's tri-state rule over `state.categories`: a category is visible unless
 *           it says `visible === false`, and an UNKNOWN category id is visible. Both `store.js:264
 *           -267` and `layout.js:111` behave this way and the popover and the board must not
 *           disagree about a dangling reference.
 * @property {(memberId:string) => boolean} [memberVisible]
 *           17.3's per-member toggle. Defaults to "everyone visible", so on a solo board this
 *           whole branch is inert — that is WP-5's exit criterion.
 * @property {Set<string>} [hiddenMembers]  convenience: builds `memberVisible` when it is absent
 */

/** v1's tri-state category rule, in one place. `store.js:264-267` === `layout.js:111`. */
export function categoryVisibilityOf(state) {
  const map = new Map((state.categories || []).map((c) => [c.id, c.visible !== false]));
  return (catId) => map.get(catId) !== false;
}

function selectorCtx(state, ctx = {}) {
  const categoryVisible = ctx.categoryVisible || categoryVisibilityOf(state);
  let memberVisible = ctx.memberVisible;
  if (!memberVisible) {
    const hidden = ctx.hiddenMembers;
    memberVisible = hidden ? (m) => !hidden.has(m) : () => true;
  }
  return { categoryVisible, memberVisible };
}

/**
 * The single per-entry visibility gate the selector applies.
 *
 * An OWN entry is gated by its category (4.3). A FOREIGN entry has no category at all — A3 means
 * `categoryId` has no `pub.` counterpart at any level, so there is nothing to gate on — and is
 * gated by the member toggle instead (17.3). Routing a foreign entry through the category check
 * would ask `categoryVisible(undefined)`, which answers "visible" by v1's dangling-reference
 * rule; correct by accident is not good enough for a privacy control.
 */
function entryPasses(entry, gates) {
  if (entry.isForeign) return gates.memberVisible(entry.ownerId);
  return gates.categoryVisible(entry.categoryId);
}

/**
 * Notes that survive the visibility gates, in `state.notes` order.
 * `layout.js:114-117`'s filter and `popover.js:49`'s filter, unified.
 * @param {Object} state @param {SelectorCtx} [ctx] @returns {Object[]}
 */
export function visibleNotes(state, ctx = {}) {
  const gates = selectorCtx(state, ctx);
  return (state.notes || []).filter((n) => entryPasses(n, gates));
}

/**
 * Bars that survive the visibility gates, in `state.bars` order.
 * `layout.js:119`'s filter and `popover.js:58-60`'s filter, unified.
 * @param {Object} state @param {SelectorCtx} [ctx] @returns {Object[]}
 */
export function visibleBars(state, ctx = {}) {
  const gates = selectorCtx(state, ctx);
  return (state.bars || []).filter((b) => entryPasses(b, gates));
}

/**
 * Expand yearly repeats into concrete dates inside a window. `layout.js:61-79`, verbatim,
 * including the two rules that are easy to lose:
 *
 *   * story 9.5 — a series exists from its FIRST year onward, never before, which is the
 *     `Math.max(y0, anchorYear)` lower bound.
 *   * a NON-repeating note is pushed at its own date and clipped to the window, so a note outside
 *     the visible range contributes nothing.
 *
 * Occurrence order within a day is `state.notes` order, which is what makes the capacity slice at
 * `layout.js:209` and therefore the "+n" chip deterministic (ADR 001 §5 step 5).
 *
 * @param {Object[]} notes ALREADY filtered (see `visibleNotes`)
 * @param {string} firstISO @param {string} lastISO
 * @returns {Map<string, Array<{note:Object, date:string}>>} date → occurrences
 */
export function noteOccurrences(notes, firstISO, lastISO) {
  const map = new Map();
  const push = (date, note) => {
    if (date < firstISO || date > lastISO) return;
    if (!map.has(date)) map.set(date, []);
    map.get(date).push({ note, date });
  };
  const y0 = Number(firstISO.slice(0, 4));
  const y1 = Number(lastISO.slice(0, 4));
  for (const n of notes) {
    if (!n.repeatsYearly) { push(n.date, n); continue; }
    const anchorYear = Number(n.date.slice(0, 4));
    for (let y = Math.max(y0, anchorYear); y <= y1; y++) {
      push(projectYearly(n.date, y), n);
    }
  }
  return map;
}

/**
 * Filter + expand in one call — what `layout.js` will use for a whole board.
 * @param {Object} state @param {string} firstISO @param {string} lastISO @param {SelectorCtx} [ctx]
 * @returns {Map<string, Array<{note:Object, date:string}>>}
 */
export function noteOccurrencesInRange(state, firstISO, lastISO, ctx = {}) {
  return noteOccurrences(visibleNotes(state, ctx), firstISO, lastISO);
}

/**
 * Note occurrences on ONE day — what `popover.js` will use.
 *
 * Deliberately implemented as the degenerate case of the range query rather than as a second
 * predicate. That is the entire point of ADR 005 §3: two implementations of "is this note on this
 * day" cannot drift apart if there is only one.
 *
 * @param {Object} state @param {string} date @param {SelectorCtx} [ctx]
 * @returns {Array<{note:Object, date:string}>}
 */
export function notesOnDate(state, date, ctx = {}) {
  return noteOccurrencesInRange(state, date, date, ctx).get(date) || [];
}

/**
 * Bars covering `date`. `popover.js:57-61`, and the same overlap test `layout.js:133` applies per
 * column. Order is `state.bars` order.
 * @param {Object} state @param {string} date @param {SelectorCtx} [ctx] @returns {Object[]}
 */
export function barsOnDate(state, date, ctx = {}) {
  return visibleBars(state, ctx).filter((b) => b.startDate <= date && b.endDate >= date);
}

/**
 * Bars overlapping `[firstISO, lastISO]`. `layout.js:133`'s test, hoisted.
 * @param {Object} state @param {string} firstISO @param {string} lastISO @param {SelectorCtx} [ctx]
 * @returns {Object[]}
 */
export function barsInRange(state, firstISO, lastISO, ctx = {}) {
  return visibleBars(state, ctx).filter((b) => !(b.endDate < firstISO || b.startDate > lastISO));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Renderability (ADR 001 §5 step 3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Presence, not truthiness.
 *
 * ADR 001 §5 step 3: "Renderability is checked against explicit fields and never inferred from
 * absence." A Geteilt note whose `pub.text` op has not arrived yet is INVISIBLE, not "Belegt" —
 * meaning is never inferred from a missing field, because that is the bug class ADR 004 exists to
 * prevent. `null` counts as absent because materialization skips null registers (step 1): null is
 * how a downgrade WITHDRAWS a field (ADR 004 §5.1), so a null `pub.text` must not keep an entry
 * renderable. An empty string, by contrast, is a value — v1 renders an empty note as `…`
 * (`popover.js:193`) and creates bars with `label: ''` — so `''` is present.
 */
const has = (v) => v !== undefined && v !== null;

/**
 * A NOTE'S DATE IS A GRID QUESTION, NOT AN ARRAY QUESTION — A3-H2.
 *
 * `state.notes` is v1's ARRAY. `layout.js` decides which day row a note lands in, and a note it
 * cannot place is simply never placed: `layout.js:63` is `if (date < firstISO || date > lastISO)
 * return;`, and for a note with no date at all the comparison is `undefined < '2026-01-01'`,
 * which is false both ways, so the occurrence lands under the key `undefined` and no day row ever
 * asks for it. The note stays in `state.notes`, stays in `board.json`, and is simply not drawn.
 *
 * v2 read `has(date)` as a condition for being on the board AT ALL, which is a different claim,
 * and at the retrofit seam it was a destructive one: in solo mode `board.json` IS the checkpoint,
 * so a note the projection refused was rewritten out of the user's file on the first autosave and
 * gone at the next launch. That is A3-H2, and principle 6 („nichts geht verloren") forbids it.
 *
 * So an OWN note is on the board when it has a TEXT — which is the field v1 paints, and which
 * both doors supply (`''`, ATT-53) when the file omits it. Nothing else about this predicate
 * moves:
 *
 *   · A CLEARED text still takes an own note off the board. `null` is how ADR 004 §5.1 withdraws
 *     a field, a co-editor clearing my text is exactly that, and the entry has nothing left to
 *     paint. (`tests/attack/ownership-authz-undo.test.js`, `core-integration.test.js`.)
 *   · A FOREIGN entry is untouched — `has(date) && (belegt || has(text))`, in that order. Every
 *     word of the paragraph above about not inferring meaning from absence is about the foreign
 *     path, and it stays true of it.
 *   · The ONE own-note exception is a repeat with no anchor. `layout.js:72` expands a repeating
 *     note with `Number(n.date.slice(0, 4))`, which THROWS on a note with no date and takes the
 *     whole board down with it — v1 does not draw that note either, it fails to draw anything.
 *     There is no v1 rendering to preserve, so the entry is kept out of the array rather than
 *     handed to a renderer that cannot survive it. Both doors additionally refuse to MINT that
 *     shape (`migrate1to2.js`: a truthy `repeatsYearly` on a note with no usable date is coerced
 *     to `false` and reported), so this guard is the belt and that is the braces.
 *
 * @param {Object} note a materialized note entry, already decorated with `isForeign`/`level`
 * @returns {boolean}
 */
export function renderableNote(note) {
  if (!note) return false;
  // `isRedacted(level)` is `showsExistence && !showsContent` — exactly `'belegt'` today, and the
  // predicate rather than the literal so that "a Belegt entry needs no text to be drawn" is a
  // consequence of what Belegt DISCLOSES (ADR 004 §2.1) rather than of what it is spelled.
  if (note.isForeign) return has(note.date) && (isRedacted(note.level) || has(note.text));
  if (note.repeatsYearly && typeof note.date !== 'string') return false;
  return has(note.text);
}

/**
 * A FOREIGN bar needs both ends, for `renderableNote`'s reason: absence on the redaction path is
 * absence, never a value inferred from it.
 *
 * An OWN bar is v1's array again (A3-H2), and — since R4-10 — an own bar with a missing edge is
 * v1's array too, WITH THE EDGE STILL MISSING. v1 draws a bar with no `endDate` from its start to
 * the END OF THE VISIBLE WINDOW: `layout.js:133-135`, where `undefined < mFirst` is false so the
 * bar is not skipped, and `segEnd = b.endDate < mLast ? b.endDate : mLast` resolves to `mLast` in
 * every column from its start onwards. Nine column-segments for an April start, four for an April
 * end, twelve for a bar with neither — the last of which additionally clashes with every other
 * bar in `assignLanes` (`layout.js:50`) and takes a lane off it.
 *
 * THE HORIZON IS NOT DATA, SO IT IS NOT MIGRATED. Both doors used to fill the missing edge from
 * the edge the file did carry, reasoning that "to the horizon" is a function of TODAY and a
 * migration that read the clock would produce a different file on each of my two Macs (R12). The
 * premise was right and the conclusion did not follow: the third option is to write NOTHING and
 * let the renderer do what it has always done. Anchoring turned nine painted segments into one
 * painted day and wrote an `endDate` into the user's `board.json` that the file never held —
 * which in solo mode, where `board.json` IS the checkpoint, is permanent at the first autosave.
 *
 * So every own bar reaches here, with whatever edges the file had, and `layout.js` — the same
 * file in both builds — draws it the way it always did. Ugly and all: reproducing v1's rendering
 * is the point, and it is what makes `board.json` a fixed point for these shapes.
 *
 * @param {Object} bar @returns {boolean}
 */
export function renderableBar(bar) {
  if (!bar) return false;
  if (bar.isForeign) return has(bar.startDate) && has(bar.endDate);
  return true;
}

/**
 * @param {'note'|'bar'} kind @param {Object} entry @returns {boolean}
 */
export function renderable(kind, entry) {
  if (kind === 'note') return renderableNote(entry);
  if (kind === 'bar') return renderableBar(entry);
  throw new EntityKeyError(`renderable: no predicate for kind ${JSON.stringify(kind)}`);
}

/**
 * @typedef {Object} ProjectionCtx
 * @property {Set<string>} [currentMembers] members whose entries may appear at all (20.2)
 * @property {Set<string>} [hiddenMembers]  device-local per-member toggle (17.3)
 */

/**
 * ADR 001 §5 step 3, in full and in its stated order. `regs → entity` projection has already
 * dropped null registers; this decides whether the entity reaches an array at all.
 *
 * A removed member's entries vanish from every board the instant the membership register says so
 * — that is what makes 20.2 instantaneous and why it needs no crypto and no purge op.
 *
 * @param {'note'|'bar'} kind @param {Object} entry @param {ProjectionCtx} [ctx]
 * @returns {boolean}
 */
export function projectable(kind, entry, ctx = {}) {
  if (!entry) return false;
  if (entry.alive === false) return false;
  if (entry.isForeign) {
    // ADR 004 §4.2: `pub.level` `'privat'` or absent ⇒ NOT PROJECTED AT ALL.
    //
    // `projectedToPeers` is `!level || level === 'privat'`, BYTE FOR BYTE — the same predicate
    // this line always applied, now named once instead of spelled here. It is deliberately NOT
    // `showsExistence`, which additionally refuses a level outside the enum: that would drop a
    // foreign entry at an unknown future level rather than render it un-redacted, which is the
    // forward-compatibility trade `core-materialize.test.js:757` characterizes on purpose. The
    // two predicates, the one input they disagree on and the reason the choice is somebody
    // else's are all documented at `visibility.js:projectedToPeers`.
    if (!projectedToPeers(entry.level)) return false;
    if (ctx.currentMembers && !ctx.currentMembers.has(entry.ownerId)) return false;
    if (ctx.hiddenMembers && ctx.hiddenMembers.has(entry.ownerId)) return false;
  }
  return renderable(kind, entry);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Sort comparators (ADR 001 §5 step 5)
//
// MANDATORY, NOT COSMETIC. v1's capacity slice (`layout.js:209`) and its per-column lane rescue
// (`layout.js:162-177`) are order-sensitive, so array order is user-visible — stories 2.4, 2.5,
// 3.8. Two devices that folded the same ops into different array orders would render different
// "+n" chips and different lane assignments from identical data.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A missing `_born` sorts LAST. A register set without its `_born` is a fragment of an entity
 * whose create op has not arrived (no causal delivery, ADR 001 §2), and a fragment must never
 * displace a complete entity from the capacity slice. `id` is the final tiebreak and it is total,
 * so the comparator is a strict weak ordering with no ties between distinct entities.
 */
const BORN_LAST = '￿';
const bornOf = (e) => (typeof e._born === 'string' ? e._born : BORN_LAST);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** `(_born asc, id asc)` @param {Object} a @param {Object} b @returns {number} */
export const cmpNotes = (a, b) => cmp(bornOf(a), bornOf(b)) || byId(a, b);

/** `(_born asc, id asc)` — so `categories[0]`, the dangling-reference fallback
 *  (`store.js:84`, ADR 001 §5 step 7), is deterministic. */
export const cmpCategories = (a, b) => cmp(bornOf(a), bornOf(b)) || byId(a, b);

/**
 * `(_born asc, id asc)` — the SAME comparator as notes and categories, and for the same reason.
 *
 * THIS USED TO BE `(startDate asc, endDate desc, id asc)`, the comparator `assignLanes` already
 * applies at `layout.js:43`, and that was wrong (ATT-50 / ATT-52). ADR 001 §8.3's acceptance
 * criterion is `materialize(fold(migrateV1(b).ops))` deep-equals the v1 board "for every field
 * INCLUDING array order". Notes and categories satisfied it because `_born` carries the v1 array
 * index (§8.1); bars did not, because a date sort throws that index away. The failure was
 * invisible in the WP-1 gate only because that fixture's bars happened to already be in date
 * order — a test that could not fail.
 *
 * Sorting by `_born` costs NOTHING at render time: `assignLanes` sorts its input by
 * `(startDate, endDate desc, id)` internally (`layout.js:38-44`), so lane assignment is
 * order-independent either way. What array order still decides downstream is `seg.labelRow` —
 * which row inside a multi-row bar the label is drawn on — and on upgrade day the user's own
 * file order is the answer that does not move anything.
 *
 * ADR CORRECTION, noted for the pass that amends the text: ADR 001 §5 step 5 still says
 * `bars — (startDate asc, endDate desc, id asc)`. The code is now the §8.3 reading; §5 step 5
 * must be amended to `(_born asc, id asc)`.
 *
 * @param {Object} a @param {Object} b @returns {number}
 */
export const cmpBars = (a, b) => cmp(bornOf(a), bornOf(b)) || byId(a, b);

/** @param {Object[]} notes @returns {Object[]} a new array */
export const sortNotes = (notes) => [...notes].sort(cmpNotes);
/** @param {Object[]} bars @returns {Object[]} a new array */
export const sortBars = (bars) => [...bars].sort(cmpBars);
/** @param {Object[]} cats @returns {Object[]} a new array */
export const sortCategories = (cats) => [...cats].sort(cmpCategories);

/**
 * Scratchpads are an object; its key order is user-visible only through `JSON.stringify`, and
 * `board.json` is human-readable (11.4) and compared byte-wise in tests. Sorted keys make both
 * stable. Insertion order into a fresh object IS the enumeration order for string keys that are
 * not array indices, and `YYYY-MM` never is one.
 * @param {Object<string,string>} pads @returns {Object<string,string>}
 */
export function sortScratchpads(pads) {
  const out = {};
  for (const k of Object.keys(pads || {}).sort()) out[k] = pads[k];
  return out;
}
