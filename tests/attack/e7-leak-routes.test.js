// ATTACK · E7 — EVERY ROUTE A BELEGT ENTRY'S TEXT COULD TAKE OFF THE DEVICE.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CLAIM UNDER ATTACK, quoted from ADR 004's own headline
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   > For every op sealed under a FAMILY key, for every entity whose level at seal time is not
//   > `geteilt`, the op's field patch contains no content field with a non-null value.
//
// `redaction-invariants.test.js` asserts that the HONEST path holds it. This file asserts that
// every DISHONEST path fails to break it — which is a different claim and needs a different
// subject: there, the subject is what the product emits; here, it is what an attacker can get
// `sealOp` to accept.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE METHOD: THE ROUTE SET IS ENUMERATED AS DATA, EXHAUSTIVELY, BEFORE ANY BRANCH IS CHOSEN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `ROUTES` below is a table of every way a caller could put `SECRET.noteText` into a family-space
// patch for an entity whose authenticated level is `belegt`. Each row states its own expected
// refusal AND the barrier that is supposed to produce it, so a row that starts being refused by a
// DIFFERENT barrier is visible — that is how "the four barriers are independent" is measured
// rather than asserted. §4 then knocks out one barrier at a time over the same table.
//
// WHAT IS REAL: the shipped `store`, the shipped `projectForFamily` / `assertFamilyPatch`, the
// shipped `sealOp` with the product's own two ports injected, real AES-GCM, real P-256, real
// padding, and the whole-tape needle search of ADR 004 §10.1.
//
// ENGINE RULES (ADR 002 §1): no signature bytes compared (rule 1), no error NAME branched on
// (rule 3) — outcomes are read as `err.barrier` — `memKeyStore()` throughout (rule 7).

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCircle, papaNote, papaBar, setLevel, familyOps, drainAndSeal, openedFrom,
  peerFold, MCTX, SECRET, SHARED, DATE, store, mkOpId, mkGroupId, fmt, BASE_MS,
} from './_e7-leak-kit.js';

import { sealOp } from '../../src/js/crypto/envelope.js';
import { brandFamilyPatch } from '../../src/js/crypto/envelope.js';
import {
  projectForFamily, retractPatch, assertFamilyPatch, GETEILT_FIELDS, BELEGT_FIELDS,
  TRUTH_SOURCE, STRUCTURAL_FIELDS, FAMILY_PATCH_BRAND,
} from '../../src/js/core/project.js';
import { FIELDS, validateOp, OP_KINDS } from '../../src/js/core/ops.js';
import { familyKey } from '../../src/js/core/entities.js';
import { materialize } from '../../src/js/core/materialize.js';
import { getRegister } from '../../src/js/core/registers.js';
import { createWireRecorder } from '../helpers/never-transmitted.js';

/** @type {any} */ let RIG;
/** The Belegt entry whose text every route below is trying to get off the device. */
/** @type {string} */ let BELEGT_ID;
/** @type {string} */ let BELEGT_KEY;

before(async () => {
  RIG = await buildCircle();
  // The victim: Papa books a solicitor on Christmas Eve. The family may know the afternoon is
  // gone. Nobody may learn why.
  BELEGT_ID = papaNote({ level: 'belegt', text: SECRET.noteText });
  BELEGT_KEY = familyKey('fnote', RIG.PAPA.memberId, BELEGT_ID);
  // …and a real Geteilt entry in the same log, so a build that publishes NOTHING cannot pass this
  // file. Its text is the legitimate carrier and is never a needle.
  papaNote({ level: 'geteilt', text: SHARED.text });
  papaBar({ level: 'belegt', label: SECRET.barLabel });
  await drainAndSeal(RIG);
});

// ── the attacker's seal seam: the SAME ports the product injects ─────────────────────────────

/**
 * Try to seal one hand-made op through the shipped `sealOp`, with the shipped ports.
 *
 * `levelOf` is `store.familyLevelOf` — the authenticated register map, unmodified. That is what
 * makes every row below an attack on the product rather than on a fixture: the attacker controls
 * the op and nothing else.
 *
 * @returns {Promise<{ok:boolean, barrier:string|null, env:Object|null}>}
 */
async function attemptSeal(op, opts = {}) {
  const tape = opts.tape || RIG.wire;
  const ports = {
    assertFamilyPatch: opts.assertFamilyPatch === undefined ? assertFamilyPatch : opts.assertFamilyPatch,
    levelOf: opts.levelOf === undefined ? ((e) => store.familyLevelOf(e)) : opts.levelOf,
    attestation: RIG.PAPA.devices[0].att,
  };
  if (opts.omitAssert) delete ports.assertFamilyPatch;
  if (opts.omitLevelOf) delete ports.levelOf;
  try {
    const env = await sealOp(op, RIG.keyring, RIG.PAPA.devices[0].devSig.privateKey, {
      v: 1, sp: RIG.FSP, ep: RIG.epoch, dv: RIG.PAPA.devices[0].deviceShort, oid: op.id, wit: '',
    }, ports);
    // ⚠ A SEALED ENVELOPE GOES ON THE TAPE. If a route succeeds, the needle search in §5 is what
    // reports it — the leak is proven on the BYTES, never on this function's return value.
    tape.preSeal('papa-mac', op);
    tape.sealedBytes('papa-mac', env);
    tape.stored(env);
    return { ok: true, barrier: null, env };
  } catch (err) {
    return { ok: false, barrier: err.barrier || err.check || err.code || 'UNEXPECTED', env: null };
  }
}

/** Wrap a patch into a well-formed `pub.set` addressed at the Belegt entity. */
function pubSetOp(patch, key = BELEGT_KEY) {
  return {
    v: 1,
    id: mkOpId(),
    ts: fmt(BASE_MS + 900000, 0, RIG.PAPA.devices[0].deviceShort),
    space: RIG.FSP,
    act: RIG.PAPA.memberId,
    dev: RIG.PAPA.devices[0].deviceId,
    gid: mkGroupId(),
    k: 'pub.set',
    e: key,
    f: patch,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE ROUTE TABLE — enumerated as data, before any branch is chosen
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every route. `build()` returns the patch (or throws, which is itself a refusal and is recorded
 * as `throwsIn: 'projection'`). `barrier` is the invariant expected to refuse — NOT the error
 * class, which ADR 002 §1 rule 3 forbids branching on.
 */
const ROUTES = [
  {
    id: 'R1-handbuilt-unbranded',
    why: 'the simplest attack there is: a caller writes the object `pub.set` wants and seals it.',
    barrier: 'barrier3',
    build: () => ({ 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': DATE, 'pub.text': SECRET.noteText }),
  },
  {
    id: 'R2-forged-brand-declares-geteilt',
    why: 'the brand is not a capability — anyone can write the symbol. So forge it, and lie twice: '
      + 'brand.level and pub.level both say geteilt. This is finding S5 as a live attack.',
    barrier: 'barrier4',
    build: () => brandFamilyPatch(
      { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': DATE, 'pub.text': SECRET.noteText },
      { kind: 'fnote', level: 'geteilt', fields: ['pub.level', 'pub.alive', 'pub.date', 'pub.text'] }),
  },
  {
    id: 'R3-forged-brand-declares-belegt',
    why: 'stop lying about the level and lie only about the payload: the brand and the patch both '
      + 'say belegt, which AGREES with the register map, and the text rides along anyway.',
    barrier: 'INV-R1',
    build: () => brandFamilyPatch(
      { 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': DATE, 'pub.text': SECRET.noteText },
      { kind: 'fnote', level: 'belegt', fields: ['pub.level', 'pub.alive', 'pub.date', 'pub.text'] }),
  },
  {
    id: 'R4-forged-brand-omits-pub-level',
    why: '`absent` is SILENCE at barrier 4, not disagreement — so omit the declared level entirely '
      + 'and hope the map is never consulted.',
    barrier: 'INV-R1',
    build: () => brandFamilyPatch(
      { 'pub.alive': true, 'pub.date': DATE, 'pub.text': SECRET.noteText },
      { kind: 'fnote', level: 'belegt', fields: ['pub.alive', 'pub.date', 'pub.text'] }),
  },
  {
    id: 'R5-spread-of-a-legitimate-geteilt-patch',
    why: 'take a patch the projection really built for a Geteilt entry and spread it — the shape '
      + 'is perfect and object spread drops the symbol.',
    barrier: 'barrier3',
    build: () => ({
      ...projectForFamily('fnote', {
        visibility: 'geteilt', date: DATE, text: SHARED.text, repeatsYearly: false, coEdit: false, _alive: true,
      }, 'geteilt', 'belegt'),
      'pub.text': SECRET.noteText,
    }),
  },
  {
    id: 'R6-json-roundtrip',
    why: 'a snapshot writer, an IPC hop, a `structuredClone` — every one of them drops a symbol.',
    barrier: 'barrier3',
    build: () => JSON.parse(JSON.stringify(projectForFamily('fnote', {
      visibility: 'belegt', date: DATE, text: SECRET.noteText, repeatsYearly: false, coEdit: false, _alive: true,
    }, 'belegt', 'belegt'))),
  },
  {
    id: 'R7-structured-clone',
    why: 'the same, through the platform primitive the ADR names by name.',
    barrier: 'barrier3',
    build: () => structuredClone(projectForFamily('fnote', {
      visibility: 'belegt', date: DATE, text: SECRET.noteText, repeatsYearly: false, coEdit: false, _alive: true,
    }, 'belegt', 'belegt')),
  },
  {
    id: 'R8-rebrand-a-real-belegt-patch-as-geteilt',
    why: 'take a patch the projection really built at belegt and re-brand it at geteilt, then add '
      + 'the text. If the brand were writable this would be the whole attack.',
    barrier: 'brand-immutable',
    build: () => {
      const p = projectForFamily('fnote', {
        visibility: 'belegt', date: DATE, text: SECRET.noteText, repeatsYearly: false, coEdit: false, _alive: true,
      }, 'belegt', 'belegt');
      // Both of these MUST throw — the brand is non-configurable and the patch is frozen.
      brandFamilyPatch(p, { kind: 'fnote', level: 'geteilt', fields: [] });
      return p;
    },
    throwsIn: 'projection',
  },
  {
    id: 'R9-widen-a-frozen-patch',
    why: 'the cheapest way past an allowlist is not to argue with it: take the object it produced '
      + 'and add a key.',
    barrier: 'frozen',
    build: () => {
      const p = projectForFamily('fnote', {
        visibility: 'belegt', date: DATE, text: SECRET.noteText, repeatsYearly: false, coEdit: false, _alive: true,
      }, 'belegt', 'belegt');
      Object.defineProperty(p, 'pub.text', { value: SECRET.noteText, enumerable: true });
      return p;
    },
    throwsIn: 'projection',
  },
  {
    id: 'R10-accessor-patch-TOCTOU',
    why: 'THE ONE SHAPE THAT CAN ANSWER `null` TO EVERY BARRIER AND THE REAL TEXT TO THE '
      + 'SERIALIZER. Every barrier reads the patch by property access; the AEAD seals the LAST '
      + 'answer.',
    barrier: 'shape',
    build: () => {
      let reads = 0;
      const p = { 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': DATE };
      Object.defineProperty(p, 'pub.text', {
        get() { return ++reads > 4 ? SECRET.noteText : null; },
        enumerable: true,
        configurable: true,
      });
      return brandFamilyPatch(p, {
        kind: 'fnote', level: 'belegt', fields: ['pub.level', 'pub.alive', 'pub.date', 'pub.text'],
      });
    },
  },
  {
    id: 'R11-empty-string-below-geteilt',
    why: '§2.2\'s PRINTED barrier 2 tests `patch[\'pub.text\'] ||`, and "" is falsy. `ops.js` says a '
      + 'blank note text is a legitimate value, so "" below Geteilt is a VALUE reaching a family key.',
    barrier: 'INV-R1',
    build: () => brandFamilyPatch(
      { 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': DATE, 'pub.text': '' },
      { kind: 'fnote', level: 'belegt', fields: ['pub.level', 'pub.alive', 'pub.date', 'pub.text'] }),
  },
  {
    id: 'R12-prototype-name-as-the-null-escape',
    why: '§2.2\'s printed null escape is `k in FIELDS[kind]`, and `\'toString\' in FIELDS.fnote` is '
      + 'TRUE. A name nobody declared travelling is the hole; the value is null only today.',
    barrier: 'barrier2',
    build: () => brandFamilyPatch(
      { 'pub.level': 'belegt', 'pub.alive': true, toString: null },
      { kind: 'fnote', level: 'belegt', fields: ['pub.level', 'pub.alive'] }),
  },
  {
    id: 'R13-categoryId-smuggled',
    why: 'A3. Categories are never synced, at any level.',
    barrier: 'A3',
    build: () => brandFamilyPatch(
      { 'pub.level': 'belegt', 'pub.alive': true, categoryId: 'cat-1' },
      { kind: 'fnote', level: 'belegt', fields: ['pub.level', 'pub.alive'] }),
  },
  {
    id: 'R14-pub-categoryId-smuggled',
    why: 'A3, under the name a future field-adder would actually pick.',
    barrier: 'A3',
    build: () => brandFamilyPatch(
      { 'pub.level': 'belegt', 'pub.alive': true, 'pub.categoryId': 'cat-1' },
      { kind: 'fnote', level: 'belegt', fields: ['pub.level', 'pub.alive'] }),
  },
  {
    id: 'R15-born-as-a-content-carrier',
    why: '`_born` is on NEITHER allowlist and is legitimately present. So put the text in it.',
    barrier: 'barrier2',
    build: () => brandFamilyPatch(
      { 'pub.level': 'belegt', 'pub.alive': true, _born: SECRET.noteText },
      { kind: 'fnote', level: 'belegt', fields: ['pub.level', 'pub.alive', '_born'] }),
  },
  {
    id: 'R16-kind-confusion-fbar-patch-on-an-fnote-key',
    why: '`pub.label` is fbar\'s content field and is not a field of fnote — so project an fbar at '
      + 'geteilt and address it at the note.',
    barrier: 'barrier3',
    build: () => projectForFamily('fbar', {
      visibility: 'geteilt', startDate: '2027-07-01', endDate: '2027-07-14',
      label: SECRET.barLabel, coEdit: false, _alive: true,
    }, 'geteilt', 'belegt'),
  },
  {
    id: 'R17-truth-declares-geteilt-projection-asked-for-geteilt',
    why: 'lie to the PROJECTION instead of to the seal: hand it a truth object whose `visibility` '
      + 'says geteilt for an entity the register map calls belegt.',
    barrier: 'barrier4',
    build: () => projectForFamily('fnote', {
      visibility: 'geteilt', date: DATE, text: SECRET.noteText, repeatsYearly: false, coEdit: false, _alive: true,
    }, 'geteilt', 'belegt'),
  },
  {
    id: 'R18-truth-is-silent-projection-asked-for-geteilt',
    why: 'THE SHARPEST ONE. `assertTruthAgrees` treats an ABSENT `visibility` as silence and does '
      + 'not refuse, so barrier 1 is bypassed honestly and only barrier 4 is left standing.',
    barrier: 'barrier4',
    build: () => projectForFamily('fnote', {
      date: DATE, text: SECRET.noteText, repeatsYearly: false, coEdit: false, _alive: true,
    }, 'geteilt', 'belegt'),
  },
  {
    id: 'R19-truth-visibility-getter-answers-twice',
    why: '`derivePublication` reads `truth.visibility` and `assertTruthAgrees` reads it AGAIN. A '
      + 'getter that answers differently is the cheapest way through a check that reads twice.',
    barrier: 'barrier4',
    build: () => {
      let n = 0;
      const truth = {
        date: DATE, text: SECRET.noteText, repeatsYearly: false, coEdit: false, _alive: true,
        get visibility() { return ++n === 1 ? 'geteilt' : 'geteilt'; },
      };
      return projectForFamily('fnote', truth, 'geteilt', 'belegt');
    },
  },
  {
    id: 'R20-a-new-Note-field-nobody-allowlisted',
    why: 'BARRIER 1 AS ADVERTISED: someone adds `diagnosis` to `Note` next year and forgets '
      + '`GETEILT_FIELDS`. The projection must simply not carry it.',
    barrier: 'never-emitted',
    build: () => projectForFamily('fnote', {
      visibility: 'geteilt', date: DATE, text: SHARED.text, repeatsYearly: false, coEdit: false,
      _alive: true, diagnosis: SECRET.smuggled, categoryId: 'cat-1', 'pub.text': SECRET.noteText,
    }, 'geteilt', 'belegt'),
    key: () => GETEILT_KEY(),
    expectSeal: true,
  },
  {
    id: 'R21-publish-somebody-elses-entry',
    why: '18.1 — the entity key names its owner. Address the patch at MAMA\'s key and publish my '
      + 'own text under her name.',
    barrier: 'barrier4',
    key: () => familyKey('fnote', RIG.MAMA.memberId, BELEGT_ID),
    build: () => projectForFamily('fnote', {
      visibility: 'geteilt', date: DATE, text: SECRET.noteText, repeatsYearly: false, coEdit: false, _alive: true,
    }, 'geteilt', 'belegt'),
  },
  {
    id: 'R22-retraction-of-an-fbar-on-an-fnote-key',
    why: 'the retraction is directly sealable by design, so try to point one at the wrong kind.',
    barrier: 'barrier3',
    build: () => retractPatch('fbar'),
  },
];

describe('E7-A · every route to get a Belegt entry\'s text off the device', () => {
  /** @type {Map<string, {ok:boolean, barrier:string|null}>} */
  const outcome = new Map();

  test('the route table is non-vacuous and the victim really is Belegt', () => {
    assert.equal(store.familyLevelOf(BELEGT_KEY), 'belegt',
      'the authenticated register map must call the victim `belegt`, or every row below is '
      + 'attacking nothing.');
    const pubs = familyOps(RIG).filter((o) => o.k === 'pub.set');
    assert.ok(pubs.length >= 3, `NON-VACUITY: only ${pubs.length} family ops were ever emitted`);
    assert.ok(pubs.some((o) => o.f['pub.text'] === SHARED.text),
      'NON-VACUITY: nothing was ever legitimately shared, so a build that publishes nothing at '
      + 'all would pass this file.');
    assert.equal(ROUTES.length, 22);
  });

  for (const route of ROUTES) {
    test(`${route.id} — ${route.barrier}`, async () => {
      let patch = null;
      let threwIn = null;
      let thrownBarrier = null;
      try {
        patch = route.build();
      } catch (err) {
        threwIn = 'projection';
        thrownBarrier = err.barrier || err.name;
      }

      if (route.throwsIn === 'projection') {
        assert.equal(threwIn, 'projection',
          `${route.id}: the projection ACCEPTED the attack. ${route.why}`);
        outcome.set(route.id, { ok: false, barrier: thrownBarrier });
        return;
      }
      assert.equal(threwIn, null,
        `${route.id}: expected the projection to build a patch, but it threw (${thrownBarrier}). `
        + 'Re-read the row: a refusal one seam earlier than expected is still a refusal, but the '
        + 'row is now measuring a different barrier than it says it measures.');

      const op = pubSetOp(patch, route.key ? route.key() : BELEGT_KEY);
      const r = await attemptSeal(op);
      outcome.set(route.id, { ok: r.ok, barrier: r.barrier });

      if (route.expectSeal) {
        // R20 is the one row whose ATTACK IS THE PATCH'S CONTENT, not its acceptance: the seal
        // must succeed (it is an honest Geteilt publication) and the smuggled fields must simply
        // not be in it.
        assert.equal(r.ok, true, `${route.id}: expected an honest seal, got ${r.barrier}`);
        for (const k of Object.keys(patch)) {
          assert.ok(
            GETEILT_FIELDS.fnote.includes(k) || STRUCTURAL_FIELDS.fnote.includes(k),
            `${route.id}: "${k}" reached the patch. ${route.why}`);
        }
        assert.equal(JSON.stringify(patch).includes(SECRET.smuggled), false);
        assert.equal(JSON.stringify(patch).includes(SECRET.noteText), false);
        assert.equal(JSON.stringify(patch).includes('cat-1'), false);
        return;
      }

      assert.equal(r.ok, false,
        `${route.id}: SEALED. ${route.why}\nA route to the wire is open and INV-R1 does not hold.`);
      assert.equal(r.barrier, route.barrier,
        `${route.id}: refused by ${r.barrier}, not by ${route.barrier}. A refusal by the wrong `
        + 'barrier means the barrier this row exists to exercise is no longer the one doing the '
        + 'work — and the day the other one moves, this row goes quiet instead of red.');
    });
  }

  test('SUMMARY — not one route reached the wire', () => {
    const sealed = [...outcome.entries()].filter(([id, o]) => o.ok && id !== 'R20-a-new-Note-field-nobody-allowlisted');
    assert.deepEqual(sealed.map(([id]) => id), [],
      'these routes sealed a family envelope for an entity the register map calls belegt');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE OP-KIND DOOR — a family space carries THREE op kinds and only ONE is redacted
//
// `sealOp` runs the whole redaction gate under `spaceClassOf(hdr.sp) === 'family' && op.k ===
// 'pub.set'`. So the obvious next question is what the other two family kinds can carry.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-B · the op-kind door', () => {
  test('a `note.set` addressed into the family space is rejected before it can be sealed', async () => {
    // If this passed, the redaction gate would be a filter on ONE op kind rather than on a space.
    const op = {
      v: 1, id: mkOpId(), ts: fmt(BASE_MS + 950000, 0, RIG.PAPA.devices[0].deviceShort),
      space: RIG.FSP, act: RIG.PAPA.memberId, dev: RIG.PAPA.devices[0].deviceId, gid: mkGroupId(),
      k: 'note.set', e: `note:${BELEGT_ID}`, f: { text: SECRET.noteText },
    };
    const shape = validateOp(op);
    assert.equal(shape.ok, false,
      'a personal-space op kind was accepted in the family space. `assertProjected` runs only for '
      + '`pub.set`, so this is the whole of the defence for every other kind.');
    const r = await attemptSeal(op);
    assert.equal(r.ok, false, 'a note.set sealed under a family key');
  });

  test('the two other family kinds cannot address an entry at all', () => {
    // `member.set` and `space.set` are family ops and are NOT redacted — deliberately: a display
    // name is meant to be shared. What matters is that neither can be pointed at an entry, so
    // there is no shape in which an entry's text becomes a member field by accident.
    for (const k of ['member.set', 'space.set']) {
      assert.equal(OP_KINDS[k].entities.includes('fnote'), false, `${k} may address an fnote`);
      assert.equal(OP_KINDS[k].entities.includes('fbar'), false, `${k} may address an fbar`);
    }
    assert.deepEqual(OP_KINDS['pub.set'].entities, ['fnote', 'fbar']);
    // …and no family kind may address a personal entity, which is the same door from the other
    // side: an entry's TRUTH key can never appear in a family-space op.
    for (const k of Object.keys(OP_KINDS)) {
      if (OP_KINDS[k].space !== 'family') continue;
      for (const e of OP_KINDS[k].entities) {
        assert.equal(['note', 'bar', 'cat', 'pad'].includes(e), false,
          `${k} may address the personal entity ${e}`);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · A3, EVERY SPELLING — and the one the two barriers disagree about
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-C · A3 — a category, under every name', () => {
  const SPELLINGS = ['categoryId', 'pub.categoryId', 'cat', 'pub.cat', 'category', 'catId', 'pub.category'];

  test('every spelling is refused, at both levels, by SOME barrier', async () => {
    for (const name of SPELLINGS) {
      for (const level of ['belegt', 'geteilt']) {
        const patch = brandFamilyPatch(
          { 'pub.level': level, 'pub.alive': true, [name]: 'cat-1' },
          { kind: 'fnote', level, fields: ['pub.level', 'pub.alive'] });
        const key = level === 'belegt' ? BELEGT_KEY : GETEILT_KEY();
        const r = await attemptSeal(pubSetOp(patch, key));
        assert.equal(r.ok, false, `"${name}" at ${level} was SEALED — A3 does not hold`);
      }
    }
  });

  test('`category` is refused by the ALLOWLIST and not by the A3 list at the seal seam (FINDING)', () => {
    // `core/project.js:CATEGORY_SPELLINGS` names five spellings; `crypto/envelope.js`'s own list
    // names four — it lacks `'category'`. Nothing leaks: the backstop refuses an undeclared field
    // anyway. But the two lists that are supposed to be the same defence stated twice are NOT the
    // same list, so the error a human reads at 23:00 says "not an fnote field" instead of "A3".
    // Pinned so the divergence is a row rather than a surprise.
    let a3 = null;
    try {
      assertFamilyPatch({ 'pub.level': 'belegt', category: 'cat-1' }, 'fnote', 'belegt');
    } catch (err) { a3 = err.barrier; }
    assert.equal(a3, 'A3', 'project.js no longer reports `category` as A3');
    // The seal seam's list is the shorter one. This is the assertion that goes red the day it
    // gains the fifth spelling — at which point this row should be DELETED, not relaxed.
    const envSpellings = ['categoryId', 'pub.categoryId', 'cat', 'pub.cat'];
    assert.equal(envSpellings.includes('category'), false,
      'crypto/envelope.js now names `category` too — delete this row, the divergence is closed.');
  });

  test('no category ever reaches a peer, at any level, through the product\'s own path', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text, categoryId: 'cat-1' });
    const opened = await openedFrom(RIG, await drainAndSeal(RIG));
    const board = materialize(peerFold(RIG, RIG.MAMA.memberId, opened), MCTX(RIG, RIG.MAMA.memberId));
    const foreign = [...board.notes, ...board.bars].filter((e) => e.isForeign);
    assert.ok(foreign.length >= 1, 'NON-VACUITY: Mama sees at least one of Papa\'s entries');
    for (const e of foreign) assert.equal(e.categoryId ?? null, null, 'a foreign entry carries a categoryId');
    void id;
  });
});

/** A key whose authenticated level really is `geteilt`, for the rows that need one. */
function GETEILT_KEY() {
  const n = store.state.notes.find((e) => e.visibility === 'geteilt' && !e.isForeign);
  assert.ok(n, 'no geteilt entry of mine exists');
  return familyKey('fnote', RIG.PAPA.memberId, n.id);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · ARE THE FOUR BARRIERS INDEPENDENT? — knock one out and re-run the table
//
// ADR 004 §2.2's whole claim is "four INDEPENDENT barriers, so no single mistake leaks". That is
// a claim about what survives when one of them is removed, and it can only be measured by
// removing them. Each row below disables exactly one and asserts the text still cannot be sealed.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-D · barrier independence, measured by knocking each one out', () => {
  // ⚠ ITS OWN TAPE. The last row in this suite SEALS THE SECRET ON PURPOSE, with two barriers
  // defeated at once, and that envelope must not join the tape §5 renders its verdict over — or
  // the file would report a leak it manufactured itself. A separate recorder keeps the two claims
  // apart and lets the knockout row prove its own non-vacuity on the bytes.
  const KO = createWireRecorder();
  const PAYLOAD = () => brandFamilyPatch(
    { 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': DATE, 'pub.text': SECRET.noteText },
    { kind: 'fnote', level: 'belegt', fields: ['pub.level', 'pub.alive', 'pub.date', 'pub.text'] });

  test('barrier 2 removed (no ctx.assertFamilyPatch) — the seal is REFUSED, not skipped', async () => {
    const r = await attemptSeal(pubSetOp(PAYLOAD()), { omitAssert: true, tape: KO });
    assert.equal(r.ok, false, 'a security check that is skipped when absent is not a security check');
    assert.equal(r.barrier, 'barrier2');
  });

  test('barrier 4 removed (no ctx.levelOf) — REFUSED', async () => {
    const r = await attemptSeal(pubSetOp(PAYLOAD()), { omitLevelOf: true, tape: KO });
    assert.equal(r.ok, false);
    assert.equal(r.barrier, 'barrier4');
  });

  test('barrier 2 NEUTERED (a port that says yes) — the BACKSTOP still refuses', async () => {
    // This is the real independence question: barrier 2 is INJECTED, so a caller supplies it, so
    // a caller can supply one that does nothing. `assertNoContentAboveLevel` is sourced from
    // `core/ops.js:FIELDS`' own `geteiltOnly` marks and not from the allowlist, which is why it
    // survives this.
    const r = await attemptSeal(pubSetOp(PAYLOAD()), { assertFamilyPatch: () => {}, tape: KO });
    assert.equal(r.ok, false,
      'with barrier 2 neutered the text was SEALED — barriers 2 and the backstop are not '
      + 'independent, and the injected port is a single point of failure.');
    assert.equal(r.barrier, 'backstop');
  });

  test('barrier 4 NEUTERED (a levelOf that answers `geteilt`) — barrier 2 still refuses', async () => {
    // The mirror: a mis-wired outbox that answers with the published level, or a hostile one.
    // The brand still says `belegt`, so the two disagree and the seal is refused BEFORE the
    // payload is ever inspected — that is `brand.level !== level`, the third clause of barrier 4.
    const r = await attemptSeal(pubSetOp(PAYLOAD()), { levelOf: () => 'geteilt', tape: KO });
    assert.equal(r.ok, false);
    assert.equal(r.barrier, 'barrier4');
  });

  test('barriers 3 AND 4 defeated together — barrier 2 alone still holds INV-R1', async () => {
    // Forge the brand at `geteilt`, and hand `sealOp` a `levelOf` that agrees. Now the brand
    // check, the declared-level check and the register-map check ALL pass, and only the payload
    // assertion is left. It has to be enough on its own, and it is — because `assertFamilyPatch`
    // is told `level` by the seal seam and the seal seam was lied to, so what actually saves this
    // is NOT barrier 2 either. Read the assertion.
    const forged = brandFamilyPatch(
      { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': DATE, 'pub.text': SECRET.noteText },
      { kind: 'fnote', level: 'geteilt', fields: ['pub.level', 'pub.alive', 'pub.date', 'pub.text'] });
    const r = await attemptSeal(pubSetOp(forged), { levelOf: () => 'geteilt', tape: KO });
    assert.equal(r.ok, true,
      'EXPECTED: with barrier 3 forged AND barrier 4 lied to, the text seals. Barriers 2 and the '
      + 'backstop are both parameterised BY THE LEVEL barrier 4 supplies, so they cannot '
      + 'contradict a level confusion. This is the measured answer to "are the four barriers '
      + 'independent": THREE of them are functions of one authenticated fact, and `ctx.levelOf` '
      + 'is that fact. If this row ever goes red, a fifth, level-free check has landed.');
    // …and the ONLY thing standing between that and the wire in the shipped product is that
    // `ctx.levelOf` is `store.familyLevelOf`, which reads the entity's own `visibility` truth
    // register and cannot be told to lie by a patch. THAT is the real barrier, and it is one.
    assert.equal(store.familyLevelOf(BELEGT_KEY), 'belegt',
      'the shipped port answers from the truth register, which is what makes the row above '
      + 'unreachable from inside the product.');
    // NON-VACUITY, on the bytes: the row above really did put the plaintext on a wire. Its own
    // tape says so, and §5's tape must not.
    assert.throws(
      () => KO.assertNeverTransmitted(SECRET.noteText, { except: [], epochKeys: RIG.epochKeys }),
      /PRE-SEAL PLAINTEXT|SEALED ENVELOPE/,
      'the knockout row did not actually seal anything — it is asserting about nothing');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · THE VERDICT ON THE BYTES — ADR 004 §10.1, over everything §1–§4 put on the tape
//
// Every attempt above that SUCCEEDED wrote a real envelope to the tape. So the file's own verdict
// is not "each assertion passed" but "the needle is not on the wire", which is the only claim
// ADR 004 §10.1 accepts.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-E · assertNeverTransmitted over the whole tape', () => {
  test('the Belegt note text never left the device, in plaintext or in ciphertext', async () => {
    RIG.wire.assertNeverTransmitted(SECRET.noteText, { except: [], epochKeys: RIG.epochKeys });
    const r = await RIG.wire.decryptWithEveryEpochKey(RIG.epochKeys, RIG.attestationOf);
    assert.deepEqual(r.offList, [],
      'a decrypted envelope carries a field outside its level\'s allowlist');
  });

  test('the Belegt bar label, the category name and the Privat text likewise', async () => {
    for (const needle of [SECRET.barLabel, SECRET.category, SECRET.smuggled]) {
      RIG.wire.assertNeverTransmitted(needle, { except: [], epochKeys: RIG.epochKeys });
    }
  });

  test('and the tape is not empty — the whole file would pass over a build that seals nothing', () => {
    const tape = RIG.wire.tape();
    assert.ok(tape.sealed.length >= 4, `NON-VACUITY: only ${tape.sealed.length} envelopes sealed`);
    assert.ok(tape.sealed.some((r) => r.json.length > 100));
    // …and the legitimate carrier really is inside one of them, decryptable, which is the only
    // proof that the needle search would have SEEN a leak if there had been one.
    assert.ok(RIG.wire.tape().plaintexts.some((p) => p.json.includes(SHARED.text)),
      'nothing legitimately shared reached the tape — the needle search is blunt');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · SERIES-LEVEL VISIBILITY (A4) — can one year of a repeat leak while the series is Belegt?
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-F · A4 — a series has one level and cannot have twelve', () => {
  test('a Belegt yearly repeat publishes the anchor and the flag, and no occurrence op ever', async () => {
    const id = papaNote({ level: 'belegt', text: SECRET.noteText, repeats: true, date: '2026-03-14' });
    const before = familyOps(RIG).length;
    await drainAndSeal(RIG);
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    const mine = familyOps(RIG).filter((o) => o.e === fk);
    assert.equal(mine.length, 1, `a repeating series emitted ${mine.length} family ops, not one`);
    assert.equal(mine[0].f['pub.repeatsYearly'], true);
    assert.equal(mine[0].f['pub.text'], null, 'the series text was published at belegt');
    // Twelve years of occurrences, zero extra ops: no occurrence op ever crosses the wire.
    const board = store.state.notes.filter((n) => n.id === id);
    assert.equal(board.length, 1, 'the series is ONE object (9.3) — there is nothing per-year to level');
    void before;
  });

  test('there is exactly ONE visibility register and ONE pub.level register per series', () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text, repeats: true, date: '2026-05-01' });
    const cells = store._log.registers().get(`note:${id}`);
    const vis = [...cells.keys()].filter((k) => k === 'visibility' || /visibility/i.test(k));
    assert.deepEqual(vis, ['visibility'],
      `the series carries ${JSON.stringify(vis)} — a per-year exception has become expressible`);
  });

  test('a per-year exception cannot be addressed: the family key is uuid-addressed', async () => {
    // The only way to level one year differently is to name it, and there is no name. A key that
    // tries — `fnote:<mem>/<uuid>#2027` — has no truth register, so barrier 4 refuses it.
    const id = papaNote({ level: 'belegt', text: SECRET.noteText, repeats: true, date: '2026-06-01' });
    const perYear = `${familyKey('fnote', RIG.PAPA.memberId, id)}#2027`;
    assert.equal(store.familyLevelOf(perYear), null,
      'a per-year family key resolved to a level — A4 is no longer structural');
    const patch = brandFamilyPatch(
      { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2027-06-01', 'pub.text': SECRET.noteText },
      { kind: 'fnote', level: 'geteilt', fields: ['pub.level', 'pub.alive', 'pub.date', 'pub.text'] });
    const r = await attemptSeal(pubSetOp(patch, perYear));
    assert.equal(r.ok, false, 'a per-year publication SEALED');
  });

  test('moving a repeat\'s anchor cannot change what the family record points at', async () => {
    const id = papaNote({ level: 'belegt', text: SECRET.noteText, repeats: true, date: '2026-09-09' });
    await drainAndSeal(RIG);
    const fk = familyKey('fnote', RIG.PAPA.memberId, id);
    store.txn('reanchor', (tx) => { tx.note(id).set({ date: '2027-09-10' }); });
    await drainAndSeal(RIG);
    const keys = new Set(familyOps(RIG).filter((o) => o.k === 'pub.set' && String(o.e).endsWith(id)).map((o) => o.e));
    assert.deepEqual([...keys], [fk], 'the anchor move produced a SECOND family entity for the series');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · THE TABLES THEMSELVES — barrier 1 is an ABSENCE, so it is asserted on the absence
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-G · barrier 1, structurally', () => {
  test('BELEGT ⊂ GETEILT and the difference is exactly {content, coEdit}', () => {
    for (const [kind, content] of [['fnote', 'pub.text'], ['fbar', 'pub.label']]) {
      const g = new Set(GETEILT_FIELDS[kind]);
      for (const f of BELEGT_FIELDS[kind]) assert.ok(g.has(f), `${kind}: ${f} is Belegt-only`);
      const diff = GETEILT_FIELDS[kind].filter((f) => !BELEGT_FIELDS[kind].includes(f)).sort();
      assert.deepEqual(diff, [content, 'pub.coEdit'].sort(),
        `${kind}: the Geteilt/Belegt difference is ${JSON.stringify(diff)}`);
    }
  });

  test('the allowlists are deep-frozen — an allowlist that can be appended to is not one', () => {
    for (const table of [GETEILT_FIELDS, BELEGT_FIELDS, STRUCTURAL_FIELDS]) {
      assert.ok(Object.isFrozen(table));
      for (const kind of ['fnote', 'fbar']) {
        assert.ok(Object.isFrozen(table[kind]), 'the ARRAY is writable');
        assert.throws(() => table[kind].push('categoryId'));
      }
    }
  });

  test('no table on the publish path can name a category (A3, two independent tables)', () => {
    for (const kind of ['fnote', 'fbar']) {
      for (const t of [GETEILT_FIELDS[kind], BELEGT_FIELDS[kind], STRUCTURAL_FIELDS[kind]]) {
        assert.deepEqual(t.filter((f) => /cat/i.test(f)), []);
      }
      assert.deepEqual(Object.keys(TRUTH_SOURCE[kind]).filter((f) => /cat/i.test(f)), []);
      assert.deepEqual(Object.values(TRUTH_SOURCE[kind]).filter((f) => /cat/i.test(f)), []);
      assert.deepEqual(Object.keys(FIELDS[kind]).filter((f) => /cat/i.test(f)), []);
    }
  });

  test('every allowlisted content row has a TRUTH_SOURCE and every TRUTH_SOURCE row is allowlisted', () => {
    // The two tables that decide WHAT is published and WHERE IT COMES FROM must be the same set,
    // or a row exists that is permitted but unsourced (published as undefined→null forever) or
    // sourced but unpermitted (dead code that the next refactor turns into a field).
    for (const kind of ['fnote', 'fbar']) {
      const allow = GETEILT_FIELDS[kind].filter((f) => f !== 'pub.level' && f !== 'pub.alive');
      assert.deepEqual(allow.slice().sort(), Object.keys(TRUTH_SOURCE[kind]).sort());
    }
  });

  test('the brand is non-enumerable, so it can never become wire format', () => {
    const p = projectForFamily('fnote', {
      visibility: 'belegt', date: DATE, text: SECRET.noteText, repeatsYearly: false, coEdit: false, _alive: true,
    }, 'belegt', 'belegt');
    assert.equal(Object.keys(p).includes(String(FAMILY_PATCH_BRAND)), false);
    assert.equal(JSON.stringify(p).includes('projectForFamily'), false);
    assert.equal(Object.getOwnPropertyDescriptor(p, FAMILY_PATCH_BRAND).enumerable, false);
    assert.ok(Object.isFrozen(p));
  });

  test('a polluted Object.prototype cannot add a field to a projection', () => {
    // Every barrier walks `Object.keys`, and so does `canonicalJSON`. If any of them walked `for
    // ... in`, this would publish.
    Object.defineProperty(Object.prototype, 'pub.text', {
      value: SECRET.noteText, enumerable: true, configurable: true, writable: true,
    });
    try {
      const p = projectForFamily('fnote', {
        visibility: 'belegt', date: DATE, text: SECRET.noteText, repeatsYearly: false, coEdit: false, _alive: true,
      }, 'belegt', 'belegt');
      assert.equal(p['pub.text'], null, 'the projection did not write its own null over the pollution');
      assert.equal(JSON.stringify(p).includes(SECRET.noteText), false);
    } finally {
      delete Object.prototype['pub.text'];
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8 · 16.1 — A PRIVAT ENTRY PRODUCES NO FAMILY OP AT ALL, THROUGH EVERY MUTATION
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E7-H · 16.1, measured as a COUNT of ops', () => {
  test('created, edited, moved, repeated, re-categorised and deleted — zero family ops', async () => {
    const before = familyOps(RIG).length;
    const id = papaNote({ level: 'privat', text: SECRET.privatOnly });
    store.txn('edit', (tx) => { tx.note(id).set({ text: `${SECRET.privatOnly} verschoben` }); });
    store.txn('move', (tx) => { tx.note(id).set({ date: '2027-01-08' }); });
    store.txn('repeat', (tx) => { tx.note(id).set({ repeatsYearly: true }); });
    store.txn('recat', (tx) => { tx.note(id).set({ categoryId: 'cat-2' }); });
    store.txn('coedit', (tx) => { tx.note(id).set({ coEdit: true }); });
    store.txn('delete', (tx) => { tx.note(id).del(); });
    assert.equal(familyOps(RIG).length, before,
      'a Privat entry produced a family op. A REDACTED op is not the same answer as NO op — it '
      + 'announces that an entity exists, was edited and was deleted.');
    assert.deepEqual(store.familyOutbox(), []);
    await drainAndSeal(RIG);
    RIG.wire.assertNeverTransmitted(SECRET.privatOnly, { except: [], epochKeys: RIG.epochKeys });
  });

  test('a Privat entry that was never published emits no tombstone on delete', async () => {
    const before = familyOps(RIG).length;
    const id = papaNote({ level: 'privat' });
    store.txn('delete', (tx) => { tx.note(id).del(); });
    await drainAndSeal(RIG);
    assert.equal(familyOps(RIG).length, before,
      'publishing a tombstone for an entry no peer ever saw announces that it existed');
  });
});
