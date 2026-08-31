// tests/property/project-domains.test.js — ONE PROPERTY PER INPUT DOMAIN OF THE REDACTION BOUNDARY.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `tests/helpers/project-domains.js` enumerates every input that reaches `src/js/core/project.js`
// across four seams and states, per input, the behaviour that is REQUIRED. This file drives every
// one of those inputs through the REAL projection, the REAL allowlist assertion, the REAL
// `sealOp` and the REAL AES-GCM, and asserts the required behaviour.
//
// NOTHING IS STUBBED THAT A FIX COULD LATER HAVE TO MAKE TRUE. In particular R4 injects the REAL
// `assertFamilyPatch` into `sealOp` — the first time in this repository that ADR 004 §2.2's
// barrier 2 has been anything but a stand-in. `tests/helpers/crypto-domains.js` says so in its
// own words at C4: "Barrier 2 is INJECTED and REQUIRED (`core/project.js` is WP-10 and until it
// lands no family `pub.set` can be sealed at all), so it has to be stubbed … as the weakest thing
// that can exist." It has landed; this is the file that stops stubbing it.
//
// NO PROPERTY STOPS AT ITS FIRST FAILING ENTRY. Each walks its WHOLE domain, collects every
// deviation and fails once with all of them listed, in the same three buckets and the same
// wording as `domains.test.js` and `crypto-domains.test.js` — two report shapes for one method
// would be two methods.
//
//   UNEXPECTED an entry carrying `openFinding: null` deviated anyway. A REGRESSION, or a domain
//              member nobody had looked at. Listed first and loudest.
//   STALE      an entry carrying an `openFinding` now HOLDS. A work order that lies is worse
//              than none.
//   THE WORK   the known-open findings, by input id.
//   ORDER
// ─────────────────────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOMAINS, R1, R1_TRUTHS, R1_LAST_PUBLISHED, R2, R2_SHAPES, R3, R4, R4_MISWIRED,
  PUBLISHED_AT, ALL_PUB_ROWS, SECRETS, LEVELS, KINDS, A_STAMP,
} from '../helpers/project-domains.js';

import {
  GETEILT_FIELDS, BELEGT_FIELDS, STRUCTURAL_FIELDS, FAMILY_PATCH_BRAND,
  RedactionError, projectForFamily, retractPatch, assertFamilyPatch, projectCoEditPatch,
  familyPatchBrand, PUBLISH_FAILURE_CONTRACT,
} from '../../src/js/core/project.js';

import { unsharePatch } from '../../src/js/core/authz.js';
import { canonicalBytes } from '../../src/js/core/canon.js';
import { ub64 } from '../../src/js/core/b64.js';
import { sealOp } from '../../src/js/crypto/envelope.js';
import * as sk from '../../src/js/crypto/spacekeys.js';

import { makeMember, ring, makeOp, hdrFor, mkSpaceId, entityUuid } from '../attack/_member-kit.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The reporter. Every property below ends in `verdict(...)`.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** @param {string} domainId @param {Array<{entry:Object, ok:boolean, got:*}>} results */
function verdict(domainId, results) {
  const d = DOMAINS[domainId];
  assert.equal(results.length, d.entries.length,
    `${domainId}: ${results.length} entries probed but the domain has ${d.entries.length} — `
    + 'a property that skips a domain member is exactly the failure this file exists to prevent');

  const unexpected = [];
  const expected = [];
  const stale = [];
  for (const r of results) {
    const known = r.entry.openFinding !== null && r.entry.openFinding !== undefined;
    if (!r.ok && !known) unexpected.push(r);
    else if (!r.ok && known) expected.push(r);
    else if (r.ok && known) stale.push(r);
  }
  console.log(`CENSUS ${domainId}: ${results.length} inputs · `
    + `${results.filter((r) => r.ok).length} hold · `
    + `${expected.length} known-open · ${unexpected.length} UNEXPECTED · ${stale.length} stale`);

  if (!unexpected.length && !expected.length && !stale.length) return;

  const show = (r) => `    ${r.entry.id}  [${r.entry.openFinding ?? 'no finding'}]  ${r.entry.label}\n`
    + `        required: ${JSON.stringify(r.entry.expect)}\n`
    + `        measured: ${JSON.stringify(r.got)}`;

  const byFinding = new Map();
  for (const r of expected) {
    if (!byFinding.has(r.entry.openFinding)) byFinding.set(r.entry.openFinding, []);
    byFinding.get(r.entry.openFinding).push(r);
  }

  const parts = [`${domainId} — ${d.title}`, `  (${d.subject})`,
    `  ${results.length} inputs enumerated · ${results.filter((r) => r.ok).length} hold · `
    + `${expected.length} known-open · ${unexpected.length} UNEXPECTED · ${stale.length} stale`];
  if (unexpected.length) {
    parts.push('', '  UNEXPECTED — an input nobody had a finding for is behaving wrongly:',
      unexpected.map(show).join('\n'));
  }
  if (stale.length) {
    parts.push('', '  STALE — these now hold; close the finding and clear `openFinding`:',
      stale.map((r) => `    ${r.entry.id}  [${r.entry.openFinding}]  ${r.entry.label}`).join('\n'));
  }
  if (expected.length) {
    parts.push('', '  THE WORK ORDER — known-open findings, by input:');
    for (const [finding, rows] of [...byFinding].sort()) {
      parts.push(`    ── ${finding} — ${rows.length} input${rows.length === 1 ? '' : 's'} ──`,
        rows.map(show).join('\n'));
    }
  }
  assert.fail(parts.join('\n'));
}

/** Key-order-insensitive signature. The wire form is `canonicalJSON`, which sorts. */
const norm = (o) => (o === null || o === undefined ? o
  : JSON.stringify(Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]))));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const barrierOf = (fn) => {
  try { fn(); return null; } catch (err) {
    return err instanceof RedactionError ? err.barrier : `UNEXPECTED ${err && err.name}: ${err && err.message}`;
  }
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// R1 — AN ENTRY REACHING `projectForFamily`
//
// Every cell is checked TWICE, and the second check is the one that is not a mirror:
//
//   (a) the patch equals the one the domain derived from ADR 004 §2.1's table; and
//   (b) SIX INVARIANTS that are independent of that table and would still have to hold if the
//       table itself were wrong — P7a, P7b, P7g, INV-R4, "no truth field name ever appears as a
//       key", and "every value is a JSON scalar or null". A projection could satisfy (a) with a
//       transcription error in the domain; it cannot satisfy (b) with a leak.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Every truth-field name that must never appear as a KEY of a family patch. */
const TRUTH_NAMES = ['date', 'startDate', 'endDate', 'text', 'label', 'repeatsYearly',
  'categoryId', 'visibility', 'coEdit', '_alive', 'alive', 'owner', 'ownerId',
  'memberColorRef', 'initial', 'mood', 'seriesId', 'entityKey'];

const isScalarOrNull = (v) => v === null || typeof v === 'string' || typeof v === 'boolean'
  || (typeof v === 'number' && Number.isFinite(v));

/**
 * The invariants that do not consult the projection table. Returns a list of violations; the
 * empty list is the required value for every cell of every domain in this file.
 */
function invariantsOf(patch, kind, level) {
  const bad = [];
  if (patch === null) return bad;
  const keys = Object.keys(patch);
  const union = new Set([...GETEILT_FIELDS[kind], ...STRUCTURAL_FIELDS[kind]]);

  // P7a — every key is on the allowlist union, plus the structural row.
  for (const k of keys) if (!union.has(k)) bad.push(`P7a: off-list key "${k}"`);

  // P7b — INV-R1 on the emitted op: below Geteilt, no non-null content.
  if (level !== 'geteilt') {
    for (const k of ['pub.text', 'pub.label']) {
      if (Object.hasOwn(patch, k) && patch[k] !== null) bad.push(`P7b: "${k}" carries a value at ${level}`);
    }
  }

  // P7g — no category, as a key OR as a value, at any level, ever.
  for (const k of keys) {
    if (/cat/i.test(k)) bad.push(`P7g: key "${k}" names a category`);
    if (patch[k] === SECRETS.categoryId) bad.push(`P7g: "${k}" carries the category id`);
  }

  // INV-R4 — every row this level does not publish is PRESENT and null. Omission is not
  // withdrawal, and this is the assertion that says so on the emitted op rather than in prose.
  const permitted = new Set(PUBLISHED_AT[kind][level]);
  if (patch['pub.level'] !== level) bad.push(`pub.level restates ${JSON.stringify(patch['pub.level'])}, not ${level}`);
  for (const f of ALL_PUB_ROWS[kind]) {
    // `pub.level` is GOVERNING: it is restated at every level and withdrawn at none — it is what
    // carries the new level to the receiver (ADR 004 §4.2 renders from it). The withdrawal rule
    // is about CONTENT registers.
    if (f === 'pub.level') continue;
    if (permitted.has(f)) continue;
    if (!Object.hasOwn(patch, f)) bad.push(`INV-R4: "${f}" is OMITTED rather than withdrawn`);
    else if (patch[f] !== null) bad.push(`INV-R4: "${f}" is withdrawn to ${JSON.stringify(patch[f])}, not null`);
  }

  // No truth-space name ever appears as a key of a family patch.
  for (const k of keys) if (TRUTH_NAMES.includes(k)) bad.push(`truth field name "${k}" in a family patch`);

  // ADR 001 §2 — `f` is scalars-only. `undefined` is not a scalar and would vanish in JSON,
  // turning an intended WITHDRAWAL into an OMISSION at the last possible moment.
  for (const k of keys) if (!isScalarOrNull(patch[k])) bad.push(`"${k}" is not a JSON scalar: ${typeof patch[k]}`);

  // The decoy: a truth object carrying its own `pub.text` must not have it copied through.
  for (const k of keys) if (patch[k] === SECRETS.future) bad.push(`"${k}" carries the future field's value`);

  return bad;
}

describe('R1 · an entry reaching projectForFamily', () => {
  test('R1 — kind × truth × level × lastPublished, and the transition is the pair', () => {
    const results = [];
    for (const e of R1) {
      const shape = R1_TRUTHS[e.kind].find((t) => t.id === e.truthId);
      const lp = R1_LAST_PUBLISHED.find((l) => l.id === e.lastPublishedId);
      const before = JSON.stringify(shape.fields);

      let got;
      try {
        // A FRESH COPY every cell: the domain's `fields` are deep-frozen, and a projection that
        // mutated its input would throw here rather than be measured — which would hide it.
        const patch = projectForFamily(e.kind, { ...shape.fields }, e.level, lp.value);
        const brand = familyPatchBrand(patch);
        got = {
          patch: patch === null ? null : { ...patch },
          brand: brand === null ? null : brand.level,
          throws: null,
          bad: invariantsOf(patch, e.kind, e.level),
        };
      } catch (err) {
        got = {
          patch: null,
          brand: null,
          throws: err instanceof RedactionError ? err.barrier : `UNEXPECTED ${err && err.name}`,
          bad: [],
        };
      }

      const ok = norm(got.patch) === norm(e.expect.patch)
        && got.brand === e.expect.brand
        && got.throws === e.expect.throws
        && got.bad.length === 0
        && JSON.stringify(shape.fields) === before;
      results.push({ entry: e, ok, got });
    }
    verdict('R1', results);
  });

  test('R1 · the twelve transitions of ADR 004 §5, named, are all cells of the cross', () => {
    // §5's table is prose; this is the same table as ids, so a reviewer can check the enumeration
    // covers it without reading the cross. Every one of these must exist in R1.
    const named = [
      'R1-fnote/full/never→belegt', 'R1-fnote/full/never→geteilt',
      'R1-fnote/full/belegt→geteilt', 'R1-fnote/full/geteilt→belegt',
      'R1-fnote/full/belegt→privat', 'R1-fnote/full/geteilt→privat',
      'R1-fnote/dead/geteilt→geteilt', 'R1-fnote/dead/never→geteilt',
      'R1-fbar/full/never→belegt', 'R1-fbar/full/geteilt→belegt',
      'R1-fbar/full/geteilt→privat', 'R1-fbar/dead/belegt→belegt',
    ];
    const ids = new Set(R1.map((e) => e.id));
    for (const id of named) assert.ok(ids.has(id), `ADR 004 §5's transition ${id} is not a cell of R1`);
    assert.equal(R1.length, 192, 'the R1 cross changed size — 2 kinds × 8 truths × 3 levels × 4 lastPublished');
  });

  test('R1 · INV-R4 · Geteilt→Belegt withdraws the text EXPLICITLY, and that is the §5.1 defect', () => {
    // The single highest-value defect in the whole v2 surface, as one assertion. A projection
    // that OMITS `pub.text` here leaves every peer's LWW register untouched: the entry looks
    // downgraded on my board and stays fully readable on Mama's, and no owner-side smoke test
    // catches it, because the owner's board is right.
    const t = R1_TRUTHS.fnote.find((s) => s.id === 'full').fields;
    const p = projectForFamily('fnote', { ...t }, 'belegt', 'geteilt');
    assert.ok(Object.hasOwn(p, 'pub.text'), 'pub.text was OMITTED — omission is not withdrawal (ADR 004 §5.1)');
    assert.equal(p['pub.text'], null);
    assert.ok(Object.hasOwn(p, 'pub.coEdit'), 'pub.coEdit was OMITTED on a downgrade');
    assert.equal(p['pub.coEdit'], null);
    assert.equal(p['pub.date'], '2026-12-24', 'the BOOKING must survive a downgrade — that is what Belegt is');
    assert.equal(JSON.stringify(p).includes(SECRETS.text), false);
  });

  test('R1 · P7d · any sequence of transitions ending in privat leaves a peer nothing but the retraction', () => {
    // ADR 004 §5.1's mandatory property, stated on the EMITTED OPS: whatever route the entry
    // took, the final patch withdraws every register it ever wrote.
    const seqs = [
      ['belegt', 'geteilt', 'belegt', 'privat'],
      ['geteilt', 'privat', 'geteilt', 'privat'],
      ['belegt', 'privat'],
      ['geteilt', 'belegt', 'geteilt', 'belegt', 'privat'],
    ];
    for (const kind of KINDS) {
      const t = R1_TRUTHS[kind].find((s) => s.id === 'full').fields;
      for (const seq of seqs) {
        let last = null;
        const written = new Set();
        for (const level of seq) {
          const p = projectForFamily(kind, { ...t }, level, last);
          if (p !== null) for (const k of Object.keys(p)) if (p[k] !== null) written.add(k);
          last = level;
        }
        const final = projectForFamily(kind, { ...t }, 'privat', seq[seq.length - 2] ?? null);
        for (const k of written) {
          if (k === 'pub.level' || k === '_born') continue;
          assert.equal(final !== null && Object.hasOwn(final, k) && final[k] === null, true,
            `${kind} [${seq.join('→')}]: "${k}" was written and is not withdrawn by the retraction`);
        }
        assert.equal(final['pub.level'], 'privat');
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// R2 — A PATCH REACHING `assertFamilyPatch`
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The patch shapes, built for one kind. Data in the domain; construction here. */
function buildPatch(build, kind, level) {
  const note = kind === 'fnote';
  const contentField = note ? 'pub.text' : 'pub.label';
  const truthField = note ? 'text' : 'label';
  const secret = note ? SECRETS.text : SECRETS.label;
  const dates = note
    ? { 'pub.date': '2026-12-24', 'pub.repeatsYearly': true }
    : { 'pub.startDate': '2026-12-24', 'pub.endDate': '2027-01-06' };

  switch (build) {
    case 'full-geteilt':
      return { 'pub.level': 'geteilt', 'pub.alive': true, ...dates, 'pub.coEdit': true, [contentField]: secret };
    case 'full-belegt':
      return { 'pub.level': 'belegt', 'pub.alive': true, ...dates, 'pub.coEdit': null, [contentField]: null };
    case 'withdrawal': {
      const out = {};
      for (const f of ALL_PUB_ROWS[kind]) out[f] = f === 'pub.level' ? 'privat' : null;
      return out;
    }
    case 'content': return { [contentField]: secret };
    case 'blank-content': return { [contentField]: '' };
    case 'category': return { 'pub.level': level, categoryId: SECRETS.categoryId };
    case 'category-null': return { categoryId: null };
    case 'pub-category': return { 'pub.categoryId': SECRETS.categoryId };
    case 'prototype-key': return { toString: null };
    case 'truth-field': return { [truthField]: secret };
    case 'truth-field-null': return { [truthField]: null };
    case 'future-field': return { mood: SECRETS.future };
    case 'coedit': return { 'pub.coEdit': true };
    case 'born': return { _born: A_STAMP };
    case 'born-bad': return { _born: 'nicht wirklich ein Stempel sondern ein Satz von 60 Zeichen' };
    case 'privat-value':
      return { 'pub.level': 'privat', ...(note ? { 'pub.date': '2026-12-24' } : { 'pub.startDate': '2026-12-24' }) };
    case 'accessor': {
      const p = {};
      let n = 0;
      Object.defineProperty(p, contentField, { get() { return n++ === 0 ? null : secret; }, enumerable: true });
      return p;
    }
    case 'empty': return {};
    case 'array': return [];
    default: throw new Error(`unknown build ${build}`);
  }
}

describe('R2 · a patch reaching assertFamilyPatch', () => {
  test('R2 — every patch shape × every kind × every level', () => {
    const results = [];
    for (const e of R2) {
      const patch = buildPatch(e.build, e.kind, e.level);
      const got = { barrier: barrierOf(() => assertFamilyPatch(patch, e.kind, e.level)) };
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }
    verdict('R2', results);
  });

  test('R2 · P7e · assertFamilyPatch throws for every off-list field of every kind, at every level', () => {
    // The domain enumerates the interesting shapes; this walks the ACTUAL union of every field
    // name the two family kinds know, so a field added to `FIELDS` later is covered without
    // anyone remembering to add a row.
    const all = new Set([...GETEILT_FIELDS.fnote, ...GETEILT_FIELDS.fbar,
      ...STRUCTURAL_FIELDS.fnote, ...STRUCTURAL_FIELDS.fbar]);
    for (const kind of KINDS) {
      const mine = new Set([...GETEILT_FIELDS[kind], ...STRUCTURAL_FIELDS[kind]]);
      for (const level of LEVELS) {
        for (const f of all) {
          if (mine.has(f)) continue;                 // the other kind's field
          const b = barrierOf(() => assertFamilyPatch({ [f]: 'ein Wert' }, kind, level));
          assert.ok(b !== null, `${kind}@${level}: "${f}" belongs to the OTHER kind and was admitted`);
        }
      }
    }
  });

  test('R2 · the arguments themselves are validated before any table is indexed', () => {
    // `GETEILT_FIELDS['toString']` is a FUNCTION, not undefined. A prototype-chain name reaching a
    // table lookup turns a refusal into a TypeError — and §2.3's loud failure path catches
    // `RedactionError`, so the one class of bug that must never be quiet would arrive wearing the
    // wrong name.
    for (const bad of ['toString', 'constructor', '__proto__', 'note', 'fnote ', '', null, undefined, 0]) {
      assert.equal(barrierOf(() => assertFamilyPatch({}, bad, 'geteilt')), 'shape',
        `kind ${JSON.stringify(bad)} did not produce a RedactionError`);
      assert.equal(barrierOf(() => projectForFamily(bad, { date: '2026-01-01' }, 'geteilt', null)), 'shape');
      assert.equal(barrierOf(() => retractPatch(bad)), 'shape');
    }
    for (const bad of ['Geteilt', 'oeffentlich', '', null, undefined, 0, 'toString']) {
      assert.equal(barrierOf(() => assertFamilyPatch({}, 'fnote', bad)), 'barrier1',
        `level ${JSON.stringify(bad)} did not produce a RedactionError`);
    }
    for (const bad of [undefined, 'oeffentlich', 0, {}, []]) {
      assert.equal(barrierOf(() => projectForFamily('fnote', { date: '2026-01-01' }, 'geteilt', bad)), 'shape',
        `lastPublished ${JSON.stringify(bad)} was accepted — \`undefined\` is not "never published"`);
    }
    for (const bad of [null, undefined, 'ein String', 42, []]) {
      assert.equal(barrierOf(() => projectForFamily('fnote', bad, 'geteilt', null)), 'shape');
    }
  });

  test('R2 · projectCoEditPatch is the co-editor\'s door and it is narrower than the projection', () => {
    // ADR 004 §8: `pub.coEdit` exists only at Geteilt, and every governing field is folded in
    // stage 3a from the owner alone — which is why "a co-editor can never grant themselves
    // co-edit" is a consequence of the staged fold and not a rule anyone enforces.
    const p = projectCoEditPatch('fnote', 'geteilt', { 'pub.text': 'Bescherung 18:00' });
    assert.deepEqual({ ...p }, { 'pub.text': 'Bescherung 18:00' });
    assert.equal(familyPatchBrand(p).level, 'geteilt');
    assert.equal(Object.isFrozen(p), true);
    for (const gov of ['pub.level', 'pub.coEdit', 'pub.alive', '_born']) {
      assert.equal(barrierOf(() => projectCoEditPatch('fnote', 'geteilt', { [gov]: true })), 'barrier1',
        `a co-editor was allowed to write the governing field "${gov}"`);
    }
    assert.equal(barrierOf(() => projectCoEditPatch('fnote', 'belegt', { 'pub.date': '2026-01-01' })), 'barrier1');
    assert.equal(barrierOf(() => projectCoEditPatch('fnote', 'privat', { 'pub.date': '2026-01-01' })), 'barrier1');
    assert.equal(barrierOf(() => projectCoEditPatch('fnote', 'geteilt', { categoryId: 'cat_1' })), 'barrier1');
    assert.equal(barrierOf(() => projectCoEditPatch('fnote', 'geteilt', { 'pub.text': undefined })), 'shape');
    assert.equal(projectCoEditPatch('fnote', 'geteilt', {}), null);
    // A co-editor's `null` is an EDIT (it clears the owner's text), not a withdrawal — and it is
    // admitted, because clearing a shared note is a thing a co-editor may do.
    assert.equal(projectCoEditPatch('fbar', 'geteilt', { 'pub.label': null })['pub.label'], null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// R3 — THE RETURNED OBJECT ITSELF
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('R3 · the returned object itself', () => {
  test('R3 — the brand, the freeze, and what a caller can still do to the patch', () => {
    const truth = R1_TRUTHS.fnote.find((t) => t.id === 'poisoned').fields;
    const make = () => projectForFamily('fnote', { ...truth }, 'geteilt', null);
    const p = make();
    const desc = Object.getOwnPropertyDescriptor(p, FAMILY_PATCH_BRAND);
    const brand = familyPatchBrand(p);

    const probes = {
      'brand': () => brand !== null && brand.source === 'projectForFamily' && brand.v === 1,
      'non-enumerable': () => desc.enumerable === false
        && Object.keys(p).every((k) => typeof k === 'string')
        && Object.getOwnPropertySymbols(p).length === 1,
      'non-writable': () => desc.writable === false,
      'non-configurable': () => desc.configurable === false,
      'brand-frozen': () => Object.isFrozen(desc.value),
      'brand-level': () => brand.level === 'geteilt'
        && familyPatchBrand(projectForFamily('fnote', { ...truth, visibility: undefined }, 'belegt', 'geteilt')).level === 'belegt'
        && familyPatchBrand(retractPatch('fnote')).level === 'privat',
      'brand-fields': () => Object.isFrozen(brand.fields)
        && eq([...brand.fields].sort(), Object.keys(p).sort()),
      'patch-frozen': () => Object.isFrozen(p),
      'no-add': () => {
        try { p.categoryId = SECRETS.categoryId; } catch { /* strict mode throws; both are a refusal */ }
        return !Object.hasOwn(p, 'categoryId');
      },
      'no-overwrite': () => {
        const b = projectForFamily('fnote', { ...truth }, 'belegt', 'geteilt');
        try { b['pub.text'] = SECRETS.text; } catch { /* as above */ }
        return b['pub.text'] === null;
      },
      'canonical-blind': () => {
        const bytes = new TextDecoder().decode(canonicalBytes(p));
        return !bytes.includes('family-patch') && !bytes.includes('projectForFamily');
      },
      'clone-strips': () => familyPatchBrand(structuredClone({ ...p })) === null
        && familyPatchBrand(JSON.parse(JSON.stringify(p))) === null
        && familyPatchBrand({ ...p }) === null,
      'truth-untouched': () => {
        const t = { ...truth };
        const snapshot = JSON.stringify(t);
        projectForFamily('fnote', t, 'belegt', 'geteilt');
        return JSON.stringify(t) === snapshot;
      },
      'fresh-object': () => make() !== make() && retractPatch('fnote') !== retractPatch('fnote'),
      'allowlists-frozen': () => {
        for (const table of [GETEILT_FIELDS, BELEGT_FIELDS, STRUCTURAL_FIELDS]) {
          for (const kind of KINDS) {
            try { table[kind].push('categoryId'); } catch { /* the required outcome */ }
            if (table[kind].includes('categoryId')) return false;
            if (!Object.isFrozen(table[kind])) return false;
          }
          if (!Object.isFrozen(table)) return false;
        }
        return true;
      },
      'retract-equals-unshare': () => KINDS.every((k) => eq(
        Object.fromEntries(Object.keys(retractPatch(k)).sort().map((f) => [f, retractPatch(k)[f]])),
        Object.fromEntries(Object.keys(unsharePatch(k)).sort().map((f) => [f, unsharePatch(k)[f]])))),
      'belegt-subset': () => KINDS.every((k) => {
        const g = new Set(GETEILT_FIELDS[k]);
        const diff = GETEILT_FIELDS[k].filter((f) => !BELEGT_FIELDS[k].includes(f));
        return BELEGT_FIELDS[k].every((f) => g.has(f))
          && eq(diff.sort(), [k === 'fnote' ? 'pub.text' : 'pub.label', 'pub.coEdit'].sort());
      }),
      'no-category-anywhere': () => [GETEILT_FIELDS, BELEGT_FIELDS, STRUCTURAL_FIELDS]
        .every((t) => KINDS.every((k) => t[k].every((f) => !/cat/i.test(f)))),
    };

    const results = R3.map((e) => {
      let holds = false;
      try { holds = probes[e.value]() === true; } catch (err) { holds = `threw ${err && err.message}`; }
      return { entry: e, ok: holds === true, got: { holds } };
    });
    verdict('R3', results);
  });

  test('R3 · PUBLISH_FAILURE_CONTRACT states ADR 004 §2.3\'s obligation on the store, executably', () => {
    // The obligation is on `src/js/store.js`, which this work package does not own. The contract
    // is kept beside the thing that throws so the two cannot drift, in the same shape as
    // `envelope.js:PROJECT_CONTRACT` — two contracts, one direction each, no third opinion.
    assert.equal(PUBLISH_FAILURE_CONTRACT.module, 'src/js/store.js');
    assert.equal(PUBLISH_FAILURE_CONTRACT.catchBy, 'name');
    assert.equal(PUBLISH_FAILURE_CONTRACT.byReference, true);
    assert.ok(PUBLISH_FAILURE_CONTRACT.clauses.length >= 6);
    assert.ok(PUBLISH_FAILURE_CONTRACT.clauses.some((c) => /STOPS THE SYNC LOOP/.test(c)));
    assert.ok(PUBLISH_FAILURE_CONTRACT.clauses.some((c) => /NEVER logged-and-skipped/.test(c)));
    // Catching by NAME really does catch both classes: `core/project.js` and `crypto/envelope.js`
    // each export a `RedactionError` and neither may import the other (ADR 005 §2).
    const mine = new RedactionError('x', 'barrier2');
    assert.equal(mine.name, 'RedactionError');
    assert.equal(mine.barrier, 'barrier2');
    assert.ok(mine instanceof Error);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// R4 — A PROJECTED PATCH REACHING `sealOp`: THE REAL BYTES
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Every secret that must not appear in the recorded bytes at a given level. */
function forbiddenAt(kind, level) {
  const out = [SECRETS.categoryId, SECRETS.future];
  if (level !== 'geteilt') out.push(kind === 'fnote' ? SECRETS.text : SECRETS.label);
  return out;
}

describe('R4 · a projected patch reaching sealOp', () => {
  let F = null;
  before(async () => {
    const me = await makeMember(1);
    const FSP = mkSpaceId('family');
    F = { me, dev: me.devices[0], FSP, kr: ring([[FSP, 1, await sk.createSpaceKey()]]) };
  });

  test('R4 — the projection, the assertion, barriers 3 and 4, the backstop and the AEAD, wired', async () => {
    const results = [];
    const sealedLengths = new Map();

    for (const e of R4) {
      const truth = R1_TRUTHS[e.kind].find((t) => t.id === 'poisoned').fields;
      const lp = R1_LAST_PUBLISHED.find((l) => l.id === e.lastPublishedId).value;
      const key = `${e.kind}:${F.me.memberId}/${entityUuid()}`;
      const forbidden = forbiddenAt(e.kind, e.level);
      let got;
      try {
        const patch = projectForFamily(e.kind, { ...truth }, e.level, lp);
        if (patch === null) {
          got = { outcome: 'nothing-published', leaks: [] };
        } else {
          const op = makeOp(F.dev, F.FSP, { k: 'pub.set', e: key, f: patch });
          // THE REAL barrier 2, and the levelOf a correctly wired outbox provides: the entity's
          // own `visibility` TRUTH register, which at publish time already carries the NEW level
          // (ADR 001 §0.9). Never the last-published `pub.level` — that was finding S5.
          const ctx = { assertFamilyPatch, levelOf: () => e.level };
          const env = await sealOp(op, F.kr, F.dev.devSig.privateKey, hdrFor(op, F.dev, 1), ctx);
          const plain = new TextDecoder().decode(canonicalBytes(op));
          const cipher = new TextDecoder('latin1').decode(ub64(env.ct));
          const leaks = forbidden.filter((s) => plain.includes(s) || cipher.includes(s));
          got = { outcome: 'sealed', leaks };
          sealedLengths.set(e.id, ub64(env.ct).length);
        }
      } catch (err) {
        got = { outcome: err.barrier || err.check || `UNEXPECTED ${err && err.name}: ${err && err.message}`, leaks: [] };
      }
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }

    // The mis-wiring rows: about `ctx`, not about the entry.
    for (const e of R4_MISWIRED) {
      const kind = 'fnote';
      const truth = R1_TRUTHS[kind].find((t) => t.id === 'poisoned').fields;
      const key = `${kind}:${F.me.memberId}/${entityUuid()}`;
      let got;
      try {
        let patch = projectForFamily(kind, { ...truth }, 'geteilt', 'privat');
        if (e.value.patch === 'structuredClone') patch = structuredClone({ ...patch });
        const op = makeOp(F.dev, F.FSP, { k: 'pub.set', e: key, f: patch });
        const ctx = {};
        if (e.value.assertFamilyPatch !== 'absent') ctx.assertFamilyPatch = assertFamilyPatch;
        // `levelOf` wired to the LAST-PUBLISHED level — the exact mis-wiring ADR 004 §2.2's
        // amendment says must fail loudly on the first share rather than quietly ever after.
        ctx.levelOf = () => (e.value.levelOf === 'last-published' ? 'privat' : 'geteilt');
        await sealOp(op, F.kr, F.dev.devSig.privateKey, hdrFor(op, F.dev, 1), ctx);
        got = { outcome: 'sealed', leaks: [] };
      } catch (err) {
        got = { outcome: err.barrier || err.check || `UNEXPECTED ${err && err.name}: ${err && err.message}`, leaks: [] };
      }
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }

    verdict('R4', results);

    // P7i — a Belegt op and a Geteilt op of the same entity are THE SAME CIPHERTEXT LENGTH
    // (padding, ADR 002 §5.3). Without it the wire tells a relay which entries carry text.
    for (const kind of KINDS) {
      const b = sealedLengths.get(`R4-${kind}/geteilt→belegt`);
      const g = sealedLengths.get(`R4-${kind}/belegt→geteilt`);
      assert.ok(b && g, `${kind}: the two comparison cells did not seal`);
      assert.equal(b, g, `P7i: a ${kind} Belegt op and a Geteilt op differ in ciphertext length (${b} vs ${g}) — `
        + 'the padding no longer hides which entries carry content (ADR 002 §5.3)');
    }
  });

  test('R4 · P7g · the category never reaches a sealed byte, at any level, for any kind', async () => {
    // The end-to-end half of `assertNeverTransmitted` (ADR 004 §10.1) for one string: the whole
    // pipeline — projection, assertion, sealing, AEAD — rather than one stage of it.
    for (const kind of KINDS) {
      for (const level of ['belegt', 'geteilt']) {
        const truth = R1_TRUTHS[kind].find((t) => t.id === 'poisoned').fields;
        const patch = projectForFamily(kind, { ...truth }, level, 'privat');
        const op = makeOp(F.dev, F.FSP, {
          k: 'pub.set', e: `${kind}:${F.me.memberId}/${entityUuid()}`, f: patch,
        });
        const env = await sealOp(op, F.kr, F.dev.devSig.privateKey, hdrFor(op, F.dev, 1),
          { assertFamilyPatch, levelOf: () => level });
        const plain = new TextDecoder().decode(canonicalBytes(op));
        const cipher = new TextDecoder('latin1').decode(ub64(env.ct));
        for (const s of [SECRETS.categoryId, 'categoryId', 'cat_']) {
          assert.equal(plain.includes(s), false, `${kind}@${level}: "${s}" is in the pre-seal plaintext (A3, P7g)`);
          assert.equal(cipher.includes(s), false, `${kind}@${level}: "${s}" is in the SEALED BYTES (A3, P7g)`);
        }
      }
    }
  });

  test('R4 · P7f · a caller passing "geteilt" for a Belegt entity does not get its text sealed', async () => {
    // Barrier 4, end to end, with the real projection on the other side of it. The caller lies in
    // BOTH places a caller can lie — the projection argument and `op.f["pub.level"]` — and the
    // register map is asked anyway.
    const truth = R1_TRUTHS.fnote.find((t) => t.id === 'poisoned').fields;
    const patch = projectForFamily('fnote', { ...truth }, 'geteilt', 'privat');
    assert.equal(patch['pub.text'], SECRETS.text, 'the setup must really carry the text');
    const op = makeOp(F.dev, F.FSP, { k: 'pub.set', e: `fnote:${F.me.memberId}/${entityUuid()}`, f: patch });
    let barrier = null;
    try {
      await sealOp(op, F.kr, F.dev.devSig.privateKey, hdrFor(op, F.dev, 1),
        { assertFamilyPatch, levelOf: () => 'belegt' });     // the AUTHENTICATED answer
    } catch (err) { barrier = err.barrier; }
    assert.equal(barrier, 'barrier4',
      'a patch projected at geteilt was sealed for an entity the register map calls belegt');
  });
});
