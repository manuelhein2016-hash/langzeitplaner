// tests/helpers/project-domains.js — THE INPUT DOMAINS OF THE REDACTION BOUNDARY, AS DATA.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
//
// `tests/helpers/domains.js` says it one layer down and `crypto-domains.js` says it one layer up:
// an enumeration of BRANCHES is a description of the code that exists; an enumeration of INPUTS
// is a description of the world, and the world does not shrink when someone adds an `else if`.
//
// The subject here is `src/js/core/project.js` — the single choke point through which plaintext
// leaves a device (ADR 004 §2). It is the one module where a branch nobody enumerated is not a
// wrong pixel but a leak, and where the owner's own board is RIGHT in exactly the case that is
// wrong on everybody else's (§5.1: "no owner-side smoke test catches this, because the owner's
// board is right — that is exactly what makes it dangerous").
//
// FOUR DOMAINS, and they are four because there are four distinct places an input reaches the
// boundary:
//
//   R1  an ENTRY reaching `projectForFamily`     — what leaves the device
//   R2  a PATCH reaching `assertFamilyPatch`     — what barrier 2 refuses
//   R3  the RETURNED OBJECT itself               — the brand, and what a caller can still do to it
//   R4  a projected patch reaching `sealOp`      — barriers 1-4 wired together, on the real bytes
//
// R4 is the one that is not a unit test in disguise. ADR 004 asserts its invariant "on the
// EMITTED OPS and on the SEALED BYTES — never on the rendering", and R1's expectations are about
// emitted ops. R4 takes the same cells through the real `sealOp`, the real allowlist assertion,
// the real barrier 4 and the real AEAD, and reads the ciphertext.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTRACT OF AN ENTRY — identical to `domains.js` and `crypto-domains.js`, deliberately.
//
//   { id, value, label, expect, openFinding, note? }
//
//   id            stable, unique across the whole file. Quote it in a fix, in a commit, in a row.
//   value         THE INPUT. Data, never a closure.
//   label         one line a human can read in a failure report.
//   expect        THE REQUIRED BEHAVIOUR. Its shape is fixed per domain and documented at the
//                 head of that domain. NEVER the current behaviour.
//   openFinding   the finding id that predicts this entry FAILS today, or null when it must hold.
//                 A null that fails is NEWS. A non-null that HOLDS is STALE, and also a failure —
//                 a work order that lies is worse than none.
//
// ZERO DEPENDENCIES. Nothing here imports `src/`: an expectation derived from the implementation
// is a mirror, and a mirror cannot disagree. Every field list below is spelled out from ADR 004
// §2.1's TABLE — the human-readable one designers and reviewers read — and not from
// `GETEILT_FIELDS`. Where the two disagree, that disagreement is the finding.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Freeze a literal all the way down. Copied, not imported, so this file stays a leaf. */
const deep = (x) => {
  if (x === null || typeof x !== 'object') return x;
  for (const k of Object.keys(x)) deep(x[k]);
  return Object.freeze(x);
};

/** ADR 004's three levels, restated rather than imported so a change to the set shows up here. */
export const LEVELS = deep(['privat', 'belegt', 'geteilt']);

/** The two family entity kinds. */
export const KINDS = deep(['fnote', 'fbar']);

/**
 * THE SECRETS. Every one of these strings is planted in a truth object and then hunted for in the
 * emitted patch, in the canonical bytes and in the ciphertext. They are distinctive on purpose:
 * `assertNeverTransmitted` (ADR 004 §10.1) works by searching recorded bytes for a UTF-8 string,
 * and a secret that could occur by chance makes that search worthless.
 */
export const SECRETS = deep({
  text: 'Scheidungsanwalt 14:30',
  label: 'Kur Bad Reichenhall',
  categoryId: 'cat_GEHEIM_Gesundheit',
  future: 'ein Feld das jemand naechstes Jahr zu Note hinzufuegt',
});

/**
 * ADR 004 §2.1's PROJECTION TABLE, transcribed row by row from the ADR's prose table rather than
 * from `src/js/core/project.js`'s allowlists. Read it against §2.1 line by line:
 *
 *   truth field                      Privat  Belegt  Geteilt  published as
 *   date / startDate / endDate          —      ✓        ✓      pub.date / pub.startDate / pub.endDate
 *   text / label                        —      —        ✓      pub.text / pub.label
 *   repeatsYearly                       —      ✓        ✓      pub.repeatsYearly
 *   categoryId                          —      —        —      (never — A3)
 *   coEdit                              —      —        ✓      pub.coEdit
 *   _alive                              —      ✓        ✓      pub.alive
 *   visibility                          —      ✓        ✓      pub.level
 *   owner                               —   (the entity key)   —
 *   member colour, initial              —     (derived)        —
 */
export const PUBLISHED_AT = deep({
  fnote: {
    privat: [],
    belegt: ['pub.level', 'pub.alive', 'pub.date', 'pub.repeatsYearly'],
    geteilt: ['pub.level', 'pub.alive', 'pub.date', 'pub.repeatsYearly', 'pub.coEdit', 'pub.text'],
  },
  fbar: {
    privat: [],
    belegt: ['pub.level', 'pub.alive', 'pub.startDate', 'pub.endDate'],
    geteilt: ['pub.level', 'pub.alive', 'pub.startDate', 'pub.endDate', 'pub.coEdit', 'pub.label'],
  },
});

/**
 * Every register a family entity has that a downgrade can WITHDRAW — i.e. the Geteilt row above,
 * which is the union of the three, because BELEGT ⊂ GETEILT and PRIVAT is empty.
 *
 * This list is what INV-R4 is a claim about: "a downgrade writes a `null` to EVERY content
 * register it withdraws". A field that is on this list and absent from a patch is the §5.1 defect.
 */
export const ALL_PUB_ROWS = deep({
  fnote: PUBLISHED_AT.fnote.geteilt,
  fbar: PUBLISHED_AT.fbar.geteilt,
});

/** The two rows that are not content: the level and the tombstone. Never withdrawn, restated. */
export const GOVERNING = deep(['pub.level', 'pub.alive']);

/** A syntactically valid stamp (`ms.ctr.deviceShort16`, 37 chars — `core/stamp.js`). */
export const A_STAMP = '1787836800123.000003.ABCDEFGH01234567';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// R1 — AN ENTRY REACHING `projectForFamily`: WHAT LEAVES THE DEVICE
//
// FIVE AXES, and the fifth (the transition) is not a separate argument: it IS the pair
// (`lastPublished` → `level`), so enumerating both axes enumerates every transition including the
// twelve of ADR 004 §5's table and the four no-ops nobody wrote a row for.
//
//   kind          fnote | fbar                                                        (2)
//   truth         the field set the caller hands us                                   (8)
//   level         the AUTHENTICATED level                                             (3)
//   lastPublished null | privat | belegt | geteilt                                    (4)
//
// 2 × 8 × 3 × 4 = 192 cells.
//
// WHY `truth` HAS EIGHT MEMBERS AND NOT TWO. A domain with only "a full entry" and "an empty
// entry" measures the happy path twice. Each of the six others is an input that a branch-first
// reading does not produce:
//
//   minimal        the fields a v1 board actually has — no `coEdit`, no `_born`, no
//                  `repeatsYearly`. The projection must emit an explicit null for each, not omit
//                  it, or the first share of an old entry is an INV-R4 violation on day one.
//   blank-text     `text: ''`. `ops.js` says in its own words that "a blank note text is a
//                  legitimate value", which is precisely why `null` had to be reserved for
//                  "redacted" — and precisely why ADR 004 §2.2's printed truthiness test
//                  (`patch['pub.text'] ||`) would let it past at Belegt.
//   dead           `_alive: false`. ADR 004 §5's "delete while published" row. Two cells of it
//                  are the ones nobody would have written: a dead entry that was NEVER published
//                  must produce no op at all, because publishing a tombstone for something no
//                  peer ever saw ANNOUNCES THAT IT EXISTED.
//   poisoned       a truth object carrying `categoryId`, an owner, a member colour, an initial,
//                  a decoy `pub.text` and a field somebody added to `Note` next year. This is the
//                  A3 cell and the "additive construction" cell at once: a projection built by
//                  spreading and deleting publishes every one of them.
//   stale-vis      `visibility: 'privat'` while the caller asks for Belegt or Geteilt. The entry
//                  and the level disagree, which means the caller read one entity and handed us
//                  another, and guessing which is right is how a Belegt entry gets its text
//                  published. Required: REFUSE. At `level: 'privat'` the same object agrees and
//                  must be projected normally — the cell that keeps the check from becoming
//                  "refuse whenever `visibility` is present".
//   alien-vis      `visibility: 'oeffentlich'` — a level register holding a value the enum
//                  cannot hold. It is the ONLY input that separates "an out-of-set level is
//                  silence" from "an out-of-set level is a refusal", and it exists because a
//                  mutant that brands the patch `truth.visibility ?? level` SURVIVED the domain
//                  without it: on every other input the two are the same value, so the brand
//                  restating a caller's field was invisible. Required: REFUSE, which is ADR 004
//                  §2.2 barrier 4's own rule ("an answer outside privat|belegt|geteilt is a
//                  refusal, never a fallback") applied one seam earlier.
//   wrong-typed    `text` is an object, `repeatsYearly` is the string `'yes'`, the date is a
//                  number, `coEdit` is `1`. A projection that coerces publishes `"[object
//                  Object]"`; one that passes non-scalars through emits something a register may
//                  not hold (ADR 001 §2). Required: an explicit null — a withdrawal, never a
//                  coercion and never an omission.
//
// expect = {
//   patch    the REQUIRED patch, exactly, or `null` for "nothing is published"
//   brand    the level the brand must restate, or `null` when there is no patch
//   throws   the `RedactionError.barrier` required, or `null`
// }
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** `lastPublished`. `null` is "never published", and it is a level's worth of difference. */
export const R1_LAST_PUBLISHED = deep([
  { id: 'never', value: null, published: false, label: 'never published — nothing has ever left this device' },
  { id: 'privat', value: 'privat', published: false, label: 'last published as PRIVAT — i.e. already retracted' },
  { id: 'belegt', value: 'belegt', published: true, label: 'last published as BELEGT — a date is on the wire' },
  { id: 'geteilt', value: 'geteilt', published: true, label: 'last published as GETEILT — the text is on the wire' },
]);

/**
 * The truth objects, per kind. `fields` is the literal object handed to `projectForFamily`;
 * `pub` is what each publishable row must carry IF the level permits it; `alive` and `born` are
 * the two normalized rows; `visibility` is what the object claims about itself.
 */
function truthShapes(kind) {
  const note = kind === 'fnote';
  const dateFields = note ? { date: '2026-12-24' } : { startDate: '2026-12-24', endDate: '2027-01-06' };
  const datePub = note
    ? { 'pub.date': '2026-12-24' }
    : { 'pub.startDate': '2026-12-24', 'pub.endDate': '2027-01-06' };
  const content = note ? { text: SECRETS.text } : { label: SECRETS.label };
  const contentPub = note ? { 'pub.text': SECRETS.text } : { 'pub.label': SECRETS.label };
  const repeats = note ? { repeatsYearly: true } : {};
  const repeatsPub = note ? { 'pub.repeatsYearly': true } : {};

  return [
    {
      id: 'full',
      label: 'a complete entry — dates, content, repeat, co-edit, alive, a create stamp',
      fields: { ...dateFields, ...content, ...repeats, coEdit: true, _alive: true, _born: A_STAMP },
      pub: { ...datePub, ...contentPub, ...repeatsPub, 'pub.coEdit': true },
      alive: true, born: A_STAMP, visibility: null,
    },
    {
      id: 'minimal',
      label: 'the fields a v1 board actually has — no coEdit, no _born, no repeat flag',
      fields: { ...dateFields },
      pub: { ...datePub },
      alive: true, born: null, visibility: null,
    },
    {
      id: 'blank-text',
      label: `${note ? 'text' : 'label'}: "" — a BLANK is a legitimate value, which is why null had to mean redacted`,
      fields: { ...dateFields, ...(note ? { text: '' } : { label: '' }), ...repeats, coEdit: false, _alive: true },
      pub: { ...datePub, ...(note ? { 'pub.text': '' } : { 'pub.label': '' }), ...repeatsPub, 'pub.coEdit': false },
      alive: true, born: null, visibility: null,
    },
    {
      id: 'dead',
      label: '_alive: false — the entry was deleted (ADR 004 §5, "delete while published")',
      fields: { ...dateFields, ...content, ...repeats, coEdit: true, _alive: false, _born: A_STAMP },
      pub: { ...datePub, ...contentPub, ...repeatsPub, 'pub.coEdit': true },
      alive: false, born: A_STAMP, visibility: null,
    },
    {
      id: 'poisoned',
      label: 'a truth object carrying categoryId, an owner, a colour, an initial, a decoy pub.text and a future field',
      fields: {
        ...dateFields, ...content, ...repeats, coEdit: true, _alive: true, _born: A_STAMP,
        categoryId: SECRETS.categoryId,
        ownerId: 'mem_someoneelse', memberColorRef: 'palette-7', initial: 'M',
        'pub.text': SECRETS.future, 'pub.label': SECRETS.future,
        mood: SECRETS.future, seriesId: 'srs_1', id: 'note_1', entityKey: 'note:xyz',
      },
      pub: { ...datePub, ...contentPub, ...repeatsPub, 'pub.coEdit': true },
      alive: true, born: A_STAMP, visibility: null,
    },
    {
      id: 'stale-vis',
      label: 'visibility: "privat" on the entry itself — the entry and the requested level disagree',
      fields: { ...dateFields, ...content, ...repeats, coEdit: true, _alive: true, _born: A_STAMP, visibility: 'privat' },
      pub: { ...datePub, ...contentPub, ...repeatsPub, 'pub.coEdit': true },
      alive: true, born: A_STAMP, visibility: 'privat',
    },
    {
      id: 'alien-vis',
      label: 'visibility: "oeffentlich" — a level register holding something the enum cannot hold',
      fields: { ...dateFields, ...content, ...repeats, coEdit: true, _alive: true, _born: A_STAMP, visibility: 'oeffentlich' },
      pub: { ...datePub, ...contentPub, ...repeatsPub, 'pub.coEdit': true },
      alive: true, born: A_STAMP, visibility: 'oeffentlich',
    },
    {
      id: 'wrong-typed',
      label: 'content is an object, the repeat flag is the string "yes", the date is a number, coEdit is 1',
      fields: {
        ...(note ? { date: 20261224 } : { startDate: 20261224, endDate: null }),
        ...(note ? { text: { toString: 'nope' } } : { label: { toString: 'nope' } }),
        ...(note ? { repeatsYearly: 'yes' } : {}),
        coEdit: 1, _alive: true,
      },
      // A non-scalar becomes an EXPLICIT NULL — a withdrawal, never a coercion. A scalar of the
      // wrong declared type travels VERBATIM so `validateOp` refuses it loudly inside `sealOp`
      // rather than the projection silently erasing a real value.
      pub: {
        ...(note ? { 'pub.date': 20261224 } : { 'pub.startDate': 20261224, 'pub.endDate': null }),
        ...(note ? { 'pub.text': null } : { 'pub.label': null }),
        ...(note ? { 'pub.repeatsYearly': 'yes' } : {}),
        'pub.coEdit': 1,
      },
      alive: true, born: null, visibility: null,
    },
  ];
}

export const R1_TRUTHS = deep({ fnote: truthShapes('fnote'), fbar: truthShapes('fbar') });

/**
 * THE REQUIRED RESULT, derived from ADR 004 §2.1's table, §5's transition table and §5.1's rule.
 * Not from the implementation: every list it consults is `PUBLISHED_AT` above.
 */
function r1Expect(kind, truth, level, last) {
  // The agreement check (ADR 004 §2.2 barrier 4's premise, applied one seam earlier). The entry's
  // own `visibility` TRUTH register — never a published level — must not contradict the level the
  // caller re-derived. Silence is not disagreement.
  // An answer outside the set is a REFUSAL at every level, never silence and never a fallback —
  // barrier 4's rule, applied one seam earlier. `null` here means the object is SILENT.
  if (truth.visibility !== null && !LEVELS.includes(truth.visibility)) {
    return { patch: null, brand: null, throws: 'barrier1' };
  }
  if (truth.visibility !== null && truth.visibility !== level) {
    return { patch: null, brand: null, throws: 'barrier1' };
  }

  const wasPublished = last === 'belegt' || last === 'geteilt';

  // 16.1 — a Privat entry produces no family op at all, and private by default costs zero bytes
  // on the wire. The one thing that legitimately travels at Privat is a WITHDRAWAL of what was
  // published before (§5.1, INV-R4).
  if (level === 'privat') {
    if (!wasPublished) return { patch: null, brand: null, throws: null };
    const patch = {};
    for (const f of ALL_PUB_ROWS[kind]) patch[f] = f === 'pub.level' ? 'privat' : null;
    return { patch, brand: 'privat', throws: null };
  }

  // Publishing a tombstone for an entry no peer ever saw ANNOUNCES THAT IT EXISTED — and the
  // entry it announces is one 16.1 kept off the wire entirely.
  if (!truth.alive && !wasPublished) return { patch: null, brand: null, throws: null };

  const permitted = new Set(PUBLISHED_AT[kind][level]);
  const patch = {};
  for (const f of ALL_PUB_ROWS[kind]) {
    if (f === 'pub.level') patch[f] = level;
    else if (f === 'pub.alive') patch[f] = truth.alive;
    // ADR 004 §5's "delete while published" row: `pub.alive: false` plus ALL CONTENT → null, so
    // §5.3's forget pass has something to act on and a later re-share cannot resurrect stale text
    // through a register nobody overwrote.
    else if (!truth.alive) patch[f] = null;
    // INV-R4 — a field outside this level's allowlist is withdrawn EXPLICITLY. Not omitted, on
    // any transition, in any order. Omission is not withdrawal.
    else if (!permitted.has(f)) patch[f] = null;
    else patch[f] = Object.hasOwn(truth.pub, f) ? truth.pub[f] : null;
  }
  // ADR 004 §5's Privat→Belegt and Privat→Geteilt rows carry `_born`. A re-share after a
  // retraction is a first publication too, and the register is write-once, so it is idempotent.
  if (!wasPublished && truth.born !== null) patch._born = truth.born;

  return { patch, brand: level, throws: null };
}

export const R1 = deep((() => {
  const out = [];
  for (const kind of KINDS) {
    for (const t of R1_TRUTHS[kind]) {
      for (const level of LEVELS) {
        for (const lp of R1_LAST_PUBLISHED) {
          out.push({
            id: `R1-${kind}/${t.id}/${lp.id}→${level}`,
            value: { kind, truth: t.id, level, lastPublished: lp.id },
            label: `${kind} · ${t.label} · ${lp.label} · now ${level.toUpperCase()}`,
            kind, truthId: t.id, level, lastPublishedId: lp.id,
            expect: r1Expect(kind, t, level, lp.value),
            openFinding: null,
          });
        }
      }
    }
  }
  return out;
})());

// ═════════════════════════════════════════════════════════════════════════════════════════════
// R2 — A PATCH REACHING `assertFamilyPatch`: WHAT BARRIER 2 REFUSES
//
// Barrier 2 is the barrier that does not depend on reaching the seal seam, and it is the one
// `sealOp` REQUIRES to be injected ("a security check that is skipped when absent is not a
// security check"). So its domain is not "the patches the projection produces" — those are R1's
// — but EVERY patch a caller could hand it, including the ones no projection would build.
//
// expect = { barrier: null (accept) | 'A3' | 'INV-R1' | 'INV-R4' | 'barrier2' | 'shape' }
//
// The `barrier` names are `RedactionError.barrier`, which exists so a test can report WHICH
// invariant refused without reading an error message (rule 3).
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Patch shapes. `build(kind)` is a function of the kind only — the LEVEL is the second axis, and
 * a shape whose expectation changed with the level would be two shapes.
 */
export const R2_SHAPES = deep([
  {
    id: 'full-geteilt',
    label: 'every Geteilt row with a value — the honest Geteilt publication',
    build: 'full-geteilt',
    accepts: ['geteilt'],
    at: { belegt: 'INV-R1', privat: 'INV-R1' },
  },
  {
    id: 'full-belegt',
    label: 'every Belegt row with a value, both withdrawals explicitly null — the honest Belegt publication',
    build: 'full-belegt',
    accepts: ['belegt', 'geteilt'],
    at: { privat: 'INV-R4' },
  },
  {
    id: 'withdrawal',
    label: 'pub.level:"privat" and every other row explicitly null — the retraction (§5.1)',
    build: 'withdrawal',
    accepts: ['privat', 'belegt', 'geteilt'],
    at: {},
    note: 'It must pass at EVERY level, not only at privat. A withdrawal is what a downgrade is '
      + 'made of, and a barrier that refused one below Geteilt would make Geteilt→Belegt '
      + 'impossible — which is the failure §5.1 is about, arrived at from the other side.',
  },
  {
    id: 'content-above-level',
    label: 'pub.text / pub.label carrying the real text — INV-R1 itself',
    build: 'content',
    accepts: ['geteilt'],
    at: { belegt: 'INV-R1', privat: 'INV-R1' },
  },
  {
    id: 'blank-content-above-level',
    label: 'pub.text / pub.label carrying "" — a BLANK is a value, and ADR 004 §2.2\'s printed truthiness test lets it past',
    build: 'blank-content',
    accepts: ['geteilt'],
    at: { belegt: 'INV-R1', privat: 'INV-R1' },
    note: '§2.2 spells this `if (level !== "geteilt" && (patch["pub.text"] || patch["pub.label"]))`. '
      + 'The empty string is falsy, so the printed barrier 2 admits it, while `envelope.js`\'s '
      + 'backstop (`patch[name] !== null`) refuses it — the advertised allowlist assertion was the '
      + 'WEAKER of the two. Reported as an ADR wording gap.',
  },
  {
    id: 'category',
    label: 'categoryId with a value — A3, the field that has no pub counterpart at any level',
    build: 'category',
    accepts: [],
    at: { privat: 'A3', belegt: 'A3', geteilt: 'A3' },
  },
  {
    id: 'category-null',
    label: 'categoryId: null — a category name travelling as a "withdrawal" of a register that does not exist',
    build: 'category-null',
    accepts: [],
    at: { privat: 'A3', belegt: 'A3', geteilt: 'A3' },
    note: 'The null escape must not reach it: `categoryId` is not a field of fnote/fbar, so '
      + '`hasOwn(FIELDS[kind], k)` is false and the escape never opens. This row is what says the '
      + 'escape is scoped to fields that EXIST, not to every name someone writes a null against.',
  },
  {
    id: 'pub-category',
    label: 'pub.categoryId — the same leak wearing the family-space prefix',
    build: 'pub-category',
    accepts: [],
    at: { privat: 'A3', belegt: 'A3', geteilt: 'A3' },
  },
  {
    id: 'prototype-key',
    label: '{toString: null} — a name nobody declared, riding the PROTOTYPE CHAIN through the null escape',
    build: 'prototype-key',
    accepts: [],
    at: { privat: 'barrier2', belegt: 'barrier2', geteilt: 'barrier2' },
    note: 'ADR 004 §2.2 spells the escape `patch[k] === null && (k in FIELDS[kind])`, and `in` '
      + 'walks the prototype chain: `"toString" in FIELDS.fnote` is TRUE. `envelope.js`\'s '
      + 'backstop reads `const f = spec[name]` and finds the inherited FUNCTION, so it agrees. '
      + 'Both barriers, one prototype. `Object.hasOwn` is the fix and this is the row that dies '
      + 'without it.',
  },
  {
    id: 'truth-field',
    label: 'the TRUTH field name (text / label) instead of the pub one — a personal-space register in a family patch',
    build: 'truth-field',
    accepts: [],
    at: { privat: 'barrier2', belegt: 'barrier2', geteilt: 'barrier2' },
  },
  {
    id: 'truth-field-null',
    label: 'the truth field name with a null — the escape must be scoped to the FAMILY kind\'s fields',
    build: 'truth-field-null',
    accepts: [],
    at: { privat: 'barrier2', belegt: 'barrier2', geteilt: 'barrier2' },
    note: '`text` IS a field — of `note`. `hasOwn(FIELDS.fnote, "text")` is false, and that is '
      + 'the whole reason the escape names the FAMILY kind rather than "any known field".',
  },
  {
    id: 'future-field',
    label: 'a field somebody adds to Note next year, hand-written into the patch',
    build: 'future-field',
    accepts: [],
    at: { privat: 'barrier2', belegt: 'barrier2', geteilt: 'barrier2' },
  },
  {
    id: 'coedit-below-geteilt',
    label: 'pub.coEdit: true at Belegt — co-editing dates you can see while the text stays hidden (§8)',
    build: 'coedit',
    accepts: ['geteilt'],
    at: {},
    note: 'Refused as an OFF-LIST field, not as content: `pub.coEdit` is on the Geteilt allowlist '
      + 'and on no other, so below Geteilt it is simply not a field this level publishes.',
  },
  {
    id: 'born-stamp',
    label: '_born carrying a valid stamp — structural, write-once, never content (§5\'s first-publication rows)',
    build: 'born',
    accepts: ['privat', 'belegt', 'geteilt'],
    at: {},
    note: '`_born` is on NEITHER allowlist and is still required by ADR 004 §5\'s transition table '
      + 'and by ops.js FIELDS. It is admitted by name and by shape (`isStamp`), which is why the '
      + 'next row exists.',
  },
  {
    id: 'born-not-a-stamp',
    label: '_born carrying a 60-character sentence — the structural escape used as a payload channel',
    build: 'born-bad',
    accepts: [],
    at: { privat: 'barrier2', belegt: 'barrier2', geteilt: 'barrier2' },
  },
  {
    id: 'privat-with-value',
    label: 'pub.level:"privat" and a real pub.date — a booking published for an entry 16.1 says produces no op at all',
    build: 'privat-value',
    accepts: [],
    at: { privat: 'INV-R4', belegt: null, geteilt: null },
    note: 'At Belegt and Geteilt this is an ordinary, admissible patch that merely RESTATES a '
      + 'level; barrier 4 at the seal seam is what checks the restatement against the map. The '
      + 'cell that matters is the privat one, and ADR 004 §2.2 indexes BELEGT_FIELDS for every '
      + 'non-Geteilt level, so as printed it ADMITS it.',
  },
  {
    id: 'accessor',
    label: 'pub.text is a GETTER that answers null once and the real text afterwards',
    build: 'accessor',
    accepts: [],
    at: { privat: 'shape', belegt: 'shape', geteilt: 'shape' },
    note: 'The one shape that can answer `null` to every barrier and the real text to '
      + '`canonicalJSON` a few frames later. Barrier 2, `envelope.js`\'s backstop and `validateOp` '
      + 'all read the patch BY PROPERTY ACCESS, so all three read the first answers and the AEAD '
      + 'seals the last — a time-of-check/time-of-use gap in the one function whose entire job is '
      + 'the check. Refused at EVERY level, GETEILT INCLUDED: at Geteilt the content is publishable, '
      + 'so what the row is about is not the text but the fact that nothing downstream can know '
      + 'what it validated.',
  },
  {
    id: 'empty',
    label: 'an empty patch — nothing to publish, and nothing to refuse either',
    build: 'empty',
    accepts: ['privat', 'belegt', 'geteilt'],
    at: {},
  },
  {
    id: 'not-an-object',
    label: 'an array where a patch should be — the shape check',
    build: 'array',
    accepts: [],
    at: { privat: 'shape', belegt: 'shape', geteilt: 'shape' },
  },
]);

export const R2 = deep((() => {
  const out = [];
  for (const kind of KINDS) {
    for (const s of R2_SHAPES) {
      for (const level of LEVELS) {
        const barrier = s.accepts.includes(level)
          ? null
          : (Object.hasOwn(s.at, level) ? s.at[level] : 'barrier2');
        out.push({
          id: `R2-${kind}/${s.id}@${level}`,
          value: { kind, shape: s.id, level },
          label: `${kind} @ ${level.toUpperCase()} · ${s.label}`,
          kind, shapeId: s.id, build: s.build, level,
          expect: { barrier },
          openFinding: null,
          note: s.note,
        });
      }
    }
  }
  return out;
})());

// ═════════════════════════════════════════════════════════════════════════════════════════════
// R3 — THE RETURNED OBJECT ITSELF: THE BRAND, AND WHAT A CALLER CAN STILL DO TO IT
//
// Barrier 3's whole claim is that "no future caller can bypass the allowlist, including one
// written by a downstream agent who never read this document". That claim is about the OBJECT the
// projection hands back, not about the function that built it, and every row below is a way the
// object could betray it.
//
// expect = { holds: true }  — every row is a required property, and a row that fails is a leak
//                             path, not a style complaint.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const R3 = deep([
  { id: 'R3-brand-present', value: 'brand', openFinding: null, expect: { holds: true },
    label: 'the returned patch carries Symbol.for("lzp/v2/family-patch")' },
  { id: 'R3-brand-non-enumerable', value: 'non-enumerable', openFinding: null, expect: { holds: true },
    label: 'the brand is NON-ENUMERABLE — `canonicalJSON` walks Object.keys, so an enumerable brand would become WIRE FORMAT' },
  { id: 'R3-brand-non-writable', value: 'non-writable', openFinding: null, expect: { holds: true },
    label: 'the brand is non-writable — a patch cannot be re-branded at a different level after the projection decided' },
  { id: 'R3-brand-non-configurable', value: 'non-configurable', openFinding: null, expect: { holds: true },
    label: 'the brand is non-configurable — `defineProperty` cannot replace it either' },
  { id: 'R3-brand-frozen', value: 'brand-frozen', openFinding: null, expect: { holds: true },
    label: 'the brand VALUE is frozen — `brand.level = "geteilt"` is barrier 4\'s attack one step earlier' },
  { id: 'R3-brand-level', value: 'brand-level', openFinding: null, expect: { holds: true },
    label: 'brand.level is the level the projection ACTUALLY APPLIED, never a caller\'s argument this module did not use' },
  { id: 'R3-brand-fields', value: 'brand-fields', openFinding: null, expect: { holds: true },
    label: 'brand.fields lists exactly the rows emitted, and is itself frozen' },
  { id: 'R3-patch-frozen', value: 'patch-frozen', openFinding: null, expect: { holds: true },
    label: 'the PATCH is frozen — the cheapest way past an allowlist is to take its output and add a key' },
  { id: 'R3-no-add', value: 'no-add', openFinding: null, expect: { holds: true },
    label: 'a caller cannot add `categoryId` to a returned patch' },
  { id: 'R3-no-overwrite', value: 'no-overwrite', openFinding: null, expect: { holds: true },
    label: 'a caller cannot overwrite `pub.text: null` with the real text after the projection redacted it' },
  { id: 'R3-canonical-blind', value: 'canonical-blind', openFinding: null, expect: { holds: true },
    label: 'the canonical bytes of the patch carry no trace of the brand — it is a local marker, never wire format' },
  { id: 'R3-clone-strips', value: 'clone-strips', openFinding: null, expect: { holds: true },
    label: 'a structuredClone of the patch LOSES the brand — the obligation on every caller, asserted rather than assumed' },
  { id: 'R3-truth-untouched', value: 'truth-untouched', openFinding: null, expect: { holds: true },
    label: 'the truth object is not mutated — the projection is OF the truth, never an edit TO it (INV-R3)' },
  { id: 'R3-fresh-object', value: 'fresh-object', openFinding: null, expect: { holds: true },
    label: 'two projections of the same entry are distinct objects — no shared identity across ops in a log' },
  { id: 'R3-allowlists-deep-frozen', value: 'allowlists-frozen', openFinding: null, expect: { holds: true },
    label: 'GETEILT_FIELDS.fnote.push("categoryId") throws — ADR 004 §2\'s `Object.freeze` leaves the ARRAYS writable' },
  { id: 'R3-retract-equals-unshare', value: 'retract-equals-unshare', openFinding: null, expect: { holds: true },
    label: 'retractPatch(kind) equals authz.unsharePatch(kind) byte for byte — one retraction shape, so a peer cannot tell an owner\'s "→ Privat" from an admin unshare (Principle 9)' },
  { id: 'R3-belegt-subset', value: 'belegt-subset', openFinding: null, expect: { holds: true },
    label: 'BELEGT_FIELDS ⊂ GETEILT_FIELDS, and the difference is exactly {text|label, coEdit}' },
  { id: 'R3-no-category-anywhere', value: 'no-category-anywhere', openFinding: null, expect: { holds: true },
    label: 'no allowlist, at any level, for any kind, names a category — A3 by the absence of a field (P7g)' },
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// R4 — A PROJECTED PATCH REACHING `sealOp`: THE FOUR BARRIERS, WIRED, ON THE REAL BYTES
//
// R1 asserts on the EMITTED OPS. ADR 004's invariant is asserted on the emitted ops AND ON THE
// SEALED BYTES, and until this domain existed nothing had ever run the real projection through
// the real seal path: `crypto-domains.js` C4 stubs barrier 2 as "a function that asserts nothing"
// because `core/project.js` did not exist, and every attack-suite row does the same.
//
// So R4 is the first place where `projectForFamily` → `assertFamilyPatch` → barrier 3 → barrier 4
// → the backstop → AES-GCM all run against one another. It is also the P7g / P7i row: the
// ciphertext is searched for the secrets, and a Belegt and a Geteilt op of the same entity are
// compared for length.
//
// expect = {
//   outcome  'sealed' | 'nothing-published' | a `RedactionError.barrier` | an `EnvelopeError.check`
//   leaks    ALWAYS the empty array. Which secrets were found in the canonical plaintext or in
//            the ciphertext. There is no cell of any domain in this file where a non-empty value
//            is correct, and stating it as a measured value rather than as an assertion is what
//            makes the failure report name WHICH secret and WHICH cell.
// }
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const R4 = deep((() => {
  const out = [];
  for (const kind of KINDS) {
    for (const level of LEVELS) {
      for (const lp of R1_LAST_PUBLISHED) {
        const wasPublished = lp.value === 'belegt' || lp.value === 'geteilt';
        const nothing = level === 'privat' && !wasPublished;
        out.push({
          id: `R4-${kind}/${lp.id}→${level}`,
          value: { kind, level, lastPublished: lp.id },
          label: `${kind} · a POISONED entry (category + a future field + a decoy pub.text) · ${lp.label} · now ${level.toUpperCase()} · sealed for real`,
          kind, level, lastPublishedId: lp.id,
          expect: { outcome: nothing ? 'nothing-published' : 'sealed', leaks: [] },
          openFinding: null,
        });
      }
    }
  }
  return out;
})());

/**
 * The one R4 input that is about the WIRING rather than about the entry: `ctx.levelOf` answering
 * with the LAST-PUBLISHED level instead of the truth register.
 *
 * It is enumerated because ADR 004 §2.2's amendment states the symptom as a hard rule — "a
 * levelOf wired to the published pub.level makes every legitimate transition a barrier-4 refusal,
 * loudly and on the first share, which is the correct symptom of a mis-wired seam and the reason
 * this is safe to state as a hard rule". A rule stated as a symptom needs a row that observes the
 * symptom, or the next integrator wires it to `pub.level`, sees a refusal, and concludes the
 * projection is broken.
 */
export const R4_MISWIRED = deep([
  { id: 'R4-miswired-levelOf', value: { levelOf: 'last-published' },
    label: 'ctx.levelOf wired to the LAST-PUBLISHED pub.level (privat) while the entry is now Geteilt',
    expect: { outcome: 'barrier4', leaks: [] }, openFinding: null },
  { id: 'R4-no-assertFamilyPatch', value: { assertFamilyPatch: 'absent' },
    label: 'the seal path injects NO ctx.assertFamilyPatch — barrier 2 is required, never optional',
    expect: { outcome: 'barrier2', leaks: [] }, openFinding: null },
  { id: 'R4-cloned-patch', value: { patch: 'structuredClone' },
    label: 'the patch is structuredClone\'d between the projection and the seal — the brand is gone',
    expect: { outcome: 'barrier3', leaks: [] }, openFinding: null,
    note: 'The refusal is correct and it is the one that will look like a projection bug. '
      + '`PUBLISH_FAILURE_CONTRACT.byReference` is the clause; this is the row.' },
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════

export const DOMAINS = deep({
  R1: {
    id: 'R1',
    title: 'an entry reaching `projectForFamily` — WHAT LEAVES THE DEVICE',
    entries: R1,
    subject: 'core/project.js:projectForFamily — ADR 004 §2, §2.1, §5, §5.1 (INV-R4)',
  },
  R2: {
    id: 'R2',
    title: 'a patch reaching `assertFamilyPatch` — WHAT BARRIER 2 REFUSES',
    entries: R2,
    subject: 'core/project.js:assertFamilyPatch — ADR 004 §2.2 barrier 2, A3, INV-R1',
  },
  R3: {
    id: 'R3',
    title: 'the returned object itself — the brand, and what a caller can still do to it',
    entries: R3,
    subject: 'core/project.js — ADR 004 §2.2 barrier 3, §2.4, crypto/envelope.js:PROJECT_CONTRACT',
  },
  R4: {
    id: 'R4',
    title: 'a projected patch reaching `sealOp` — the four barriers wired, on the real bytes',
    entries: [...R4, ...R4_MISWIRED],
    subject: 'core/project.js → crypto/envelope.js:sealOp — ADR 004 §2.2 barriers 1-4 + the backstop, §10.1',
  },
});

export const DOMAIN_IDS = deep(['R1', 'R2', 'R3', 'R4']);

/** Every entry across every domain, tagged with the domain it came from. */
export const ALL = deep(DOMAIN_IDS.flatMap((d) => DOMAINS[d].entries.map((e) => ({ domain: d, ...e }))));

/** The entries a finding id predicts will fail — the work order, per row. */
export function byFinding(finding) {
  return ALL.filter((e) => e.openFinding !== null && String(e.openFinding).startsWith(finding));
}

/** The census, so "how many inputs does this boundary have" is a number and not an impression. */
export const CENSUS = deep(Object.fromEntries(DOMAIN_IDS.map((d) => [d, DOMAINS[d].entries.length])));
