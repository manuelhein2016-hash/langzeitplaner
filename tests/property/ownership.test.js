// tests/property/ownership.test.js — P9, structural ownership (LZP-406, risk R10).
//
// "**P9** — ownership: no op sequence, **including backdated stamps at `ms = 0`**, causes an
// entity's owner to change."
//
// ADR 001 §0.4 and §12.6: "Ownership is structural, not a register. A family entity's key
// literally contains its owner." **There is no `owner` field.** That is the entire defence, and
// it is a good one — but only for as long as nobody adds one, and only if nothing anywhere
// RESOLVES an owner by any route other than reading the key.
//
// So these tests attack from both directions:
//
//   1. Can an adversary make the system report a different owner? (Backdated writes at `ms = 0`,
//      forged genesis links, self-attestation, another member's key reusing my uuid, and the
//      whole attack assembled at once.)
//   2. Is the defence still structural at all? (`makeOp` must refuse an `owner` field; no
//      materialized entry may carry an owner that disagrees with its key; `ownerOfEntity` must
//      be a pure function of the string.)
//
// `ms = 0` is the specific stamp the property names, and for a reason worth stating: it is the
// smallest stamp expressible, so if ownership — or anything ownership depends on, like the admin
// chain — were ever decided by "the earliest write wins", this is the op that would take it.

import test from 'node:test';
import assert from 'node:assert/strict';

import '../helpers/env.js';
import {
  generate, ownershipAttacks, pcg32, shuffle, duplicateSome, EVE, ME, MAMA, PAPA, MEMBERS, FSP,
} from '../helpers/gen.js';
import { SEEDS, seeds, forEachSeed, sig } from './harness.js';

import { defaultState } from '../../src/js/store.js';
import { foldAuthorized } from '../../src/js/core/authz.js';
import { materialize } from '../../src/js/core/materialize.js';
import { serializeRegisters, entityKeys } from '../../src/js/core/registers.js';
import { ownerOfEntity, kindOfEntity, parseEntityKey, FIELDS } from '../../src/js/core/ops.js';

const mctx = (w) => ({ ...w.mctx, defaultSettings: defaultState().settings });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// P9 — the property
// ═════════════════════════════════════════════════════════════════════════════════════════════

test(`P9 — no op sequence changes any entity's owner, over ${SEEDS} seeds`, () => {
  forEachSeed(seeds(), 'P9 structural ownership', (seed) => {
    const w = generate(seed);
    const attack = ownershipAttacks(seed, w);
    const rnd = pcg32(seed ^ 0x99);
    const all = duplicateSome(rnd, shuffle(rnd, [...w.ops, ...attack.ops]), 0.2);

    const r = foldAuthorized(all, w.authzCtx);

    // 1. Every entity key in the register map still names its own owner, and the owner is
    //    whatever the KEY says — never anything the fold decided.
    for (const e of entityKeys(r.regs)) {
      const declared = ownerOfEntity(e);
      const parsed = parseEntityKey(e);
      assert.ok(parsed, `an unparseable entity key reached the register map: ${e}`);
      if (declared !== null) {
        assert.equal(declared, e.slice(e.indexOf(':') + 1, e.indexOf('/')),
          `ownerOfEntity disagrees with the key text for ${e}`);
        assert.ok(MEMBERS.includes(declared) || declared === EVE,
          `an entity key named an owner nobody ever heard of: ${e}`);
      }
    }

    // 2. No register on ANY of my entities is authored by somebody who is not entitled to it.
    //    On my truth entities the answer is absolute: only I ever write them.
    for (const [e, fields] of r.regs) {
      if (!/^(note|bar|cat|pad|pref):/.test(e)) continue;
      for (const [f, reg] of fields) {
        assert.equal(reg.author, ME,
          `${e}.${f} on MY OWN entity is authored by ${reg.author} — R10`);
      }
    }
  });
});

test(`P9 — the materialized board never reports an owner its key does not name`, () => {
  forEachSeed(seeds(), 'P9 through materialize', (seed) => {
    const w = generate(seed);
    const attack = ownershipAttacks(seed, w);
    const rnd = pcg32(seed ^ 0xAA);
    const all = shuffle(rnd, [...w.ops, ...attack.ops]);
    const st = materialize(foldAuthorized(all, w.authzCtx).regs, mctx(w));

    for (const entry of [...st.notes, ...st.bars]) {
      if (!entry.isForeign) {
        assert.equal(entry.ownerId, ME, `one of MY entries claims owner ${entry.ownerId}`);
        continue;
      }
      // A foreign entry's `ownerId` must equal the member segment of the key it came from, and
      // that member must actually be in the Kreis.
      assert.equal(entry.ownerId, ownerOfEntity(entry.entityKey),
        `a foreign entry's ownerId disagrees with its own entity key (${entry.entityKey})`);
      assert.ok(w.mctx.currentMembers.has(entry.ownerId),
        `an entry owned by a non-member (${entry.ownerId}) was projected — EVE is not in the Kreis`);
    }
  });
});

test('P9 — EVE, who is not in the Kreis, can never place an entry on my board', () => {
  // The whole assembled attack: self-attest, self-declare membership, forge a genesis at ms = 0
  // naming herself admin, then write to my entities and mint her own. `currentMembers` is derived
  // from the fold, and she is not in it, so nothing she owns is ever projected.
  forEachSeed(seeds(), 'P9 outsider', (seed) => {
    const w = generate(seed);
    const attack = ownershipAttacks(seed, w);
    const rnd = pcg32(seed ^ 0xBB);
    const all = shuffle(rnd, [...w.ops, ...attack.ops]);
    const st = materialize(foldAuthorized(all, w.authzCtx).regs, mctx(w));
    for (const entry of [...st.notes, ...st.bars]) {
      assert.notEqual(entry.ownerId, EVE, 'an outsider placed an entry on my board');
      assert.notEqual(entry.text, 'von Eve', 'an outsider wrote into one of my entries');
      assert.notEqual(entry.text, 'Evas Eintrag');
    }
  });
});

test('P9 — a backdated write at ms = 0 changes nothing at all', () => {
  // The stamp the property names by name. Folding WITHOUT the attack and WITH it must produce the
  // same board: every attacking op either loses on ownership or is an entity of the attacker's
  // own that is filtered by membership.
  forEachSeed(seeds(), 'P9 ms=0 backdating', (seed) => {
    const w = generate(seed);
    const attack = ownershipAttacks(seed, w);
    // EVE controls her own clock and backdates to the smallest stamp expressible. MAMA's probe
    // carries her real +10-minute device skew, because she is a genuine device and the point of
    // her op is that ATTESTED IS NOT AUTHORIZED — a different attack, asserted elsewhere.
    const eveOps = attack.ops.filter((o) => o.act === EVE);
    assert.ok(eveOps.length >= 5, 'the attack generator stopped emitting outsider ops');
    assert.ok(eveOps.every((o) => o.ts.startsWith('0000000000000')),
      'the outsider\'s ops are not actually backdated to ms = 0 — the test is not testing what it says');

    const clean = materialize(foldAuthorized(w.ops, w.authzCtx).regs, mctx(w));
    const rnd = pcg32(seed ^ 0xCC);
    const attacked = materialize(
      foldAuthorized(shuffle(rnd, [...w.ops, ...attack.ops]), w.authzCtx).regs, mctx(w));
    assert.equal(sig(attacked), sig(clean),
      'a backdated attack at ms = 0 changed the board');
  });
});

test('P9 — a foreign entity reusing one of MY uuids does not collide with mine', () => {
  // Ownership being structural means a peer CAN legitimately mint `fnote:<them>/<my uuid>` — the
  // uuid space is not owned by anyone. It must land as a separate entity. If the projection keyed
  // entries by bare uuid, the two would collapse into one and `layout.js:43`'s lane map (keyed by
  // `id`) would put them in the same lane.
  forEachSeed(seeds(200), 'P9 uuid collision', (seed) => {
    const w = generate(seed);
    const attack = ownershipAttacks(seed, w);
    const st = materialize(foldAuthorized([...w.ops, ...attack.ops], w.authzCtx).regs, mctx(w));
    const ids = [...st.notes, ...st.bars].map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length,
      'two entries share an `id` — a foreign entry collided with one of mine');
    for (const e of [...st.notes, ...st.bars]) {
      if (e.isForeign) {
        assert.equal(e.id, e.entityKey,
          'a foreign entry is keyed by bare uuid — that is forgeable and collides');
      }
    }
  });
});

test('P9 — an op with a stamp of ms = 0 cannot take the admin chain', () => {
  // Ownership of an ENTITY is structural; the admin's power to unshare is not, so the chain is
  // the other place an ms = 0 op could do damage. EVE forges a genesis at ms = 0 in every seed.
  forEachSeed(seeds(), 'P9 admin chain under ms=0', (seed) => {
    const w = generate(seed);
    const attack = ownershipAttacks(seed, w);
    const rnd = pcg32(seed ^ 0xDD);
    const r = foldAuthorized(shuffle(rnd, [...w.ops, ...attack.ops]), w.authzCtx);
    assert.notEqual(r.admin, EVE, 'a forged genesis at ms = 0 took the admin role');
    assert.ok(r.admin === null || MEMBERS.includes(r.admin), `admin resolved to ${r.admin}`);
  });
});

test('P9 — GAP, CHARACTERIZED: `currentMembers` admits anyone who writes their own member record', () => {
  // ═══ THIS TEST DOCUMENTS A HOLE. It asserts the CURRENT behaviour, not the desired one. ═══
  //
  // EVE self-attests and writes `member:<EVE>{_alive: true}` into the family space. ADR 001 §4.2
  // legislates `_alive: false` (who may REMOVE a member) and is SILENT on `_alive: true`, so
  // `authz.js` implements the symmetric rule — self or admin@ts — because admin-only would stop a
  // legitimate joiner from ever creating their own record. The consequence is that
  // `foldAuthorized().currentMembers` is "everyone who claims to be alive", not "everyone the
  // admin let in": there is no binding in the LOG between a member record and the space it
  // belongs to.
  //
  // Why the product is not currently broken by this: `ctx.currentMembers` handed to
  // `materialize()` comes from the invite/pairing flow, not from the fold, and EVE cannot obtain
  // the space's epoch key, so her ops never decrypt on a real peer in the first place. The
  // containment is CRYPTOGRAPHIC and it is upstream of this layer.
  //
  // Why it still matters: `AuthzResult.currentMembers` is documented as the member set, it is the
  // obvious thing for WP-3/WP-9 to feed straight into `MaterializeCtx`, and doing so would put an
  // uninvited party's entries on the board. The two tests above pass ONLY because the fixture
  // passes a curated `currentMembers`.
  //
  // ACTION: ADR 001 §4.2 needs a rule for `_alive: true` — most likely "admissible from self ONLY
  // if an admin-authored `member.set` for that member already exists in this space", which closes
  // it without blocking a joiner. Until then WP-3 must NOT wire `r.currentMembers` into
  // `MaterializeCtx` unfiltered. Flip these assertions when the rule lands.
  const w = generate(0);
  const attack = ownershipAttacks(0, w);
  const r = foldAuthorized([...w.ops, ...attack.ops], w.authzCtx);
  assert.equal(r.currentMembers.has(EVE), true,
    'CURRENT behaviour, pinned: an outsider self-declares into currentMembers');
  assert.notEqual(r.admin, EVE, 'but she still cannot become admin — the chain is bound to a genesis');

  // And the containment that DOES hold: with a curated member set she is invisible.
  const st = materialize(r.regs, mctx(w));
  assert.equal(st.notes.some((n) => n.ownerId === EVE), false,
    'the curated currentMembers is what keeps her off the board — do not remove it');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Is the defence still STRUCTURAL? — the half that rots silently
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('P9 — there is no owner field, on any kind, and there never may be (ADR 001 §12.6)', () => {
  // "No op sequence can change the owner" is trivially true while no op can NAME an owner. This
  // is the assertion that notices the day someone adds one, at which point every other test in
  // this file becomes a statement about a defence that no longer exists.
  const banned = ['owner', 'ownerId', 'member', 'memberId', 'seriesId', 'act', 'author'];
  for (const [kind, table] of Object.entries(FIELDS)) {
    for (const bad of banned) {
      assert.equal(Object.prototype.hasOwnProperty.call(table, bad), false,
        `FIELDS.${kind} declares "${bad}" — ownership/authorship is no longer structural`);
      assert.equal(Object.prototype.hasOwnProperty.call(table, `pub.${bad}`), false,
        `FIELDS.${kind} declares "pub.${bad}"`);
    }
  }
});

test('P9 — makeOp REFUSES to build an op naming an owner', () => {
  // The table check above is compile-time reasoning; this is the runtime half. `ownershipAttacks`
  // tries to build three such ops on every seed and collects the refusals.
  forEachSeed(seeds(100), 'P9 validator refusal', (seed) => {
    const w = generate(seed);
    const { refused } = ownershipAttacks(seed, w);
    assert.equal(refused.length, 3, 'the attack generator stopped trying to forge an owner field');
    for (const r of refused) {
      assert.ok(r.error, `makeOp BUILT an op carrying ${sig(r.patch)} — R10 is open`);
      assert.match(r.error, /unknown field/, `unexpected refusal reason: ${r.error}`);
    }
  });
});

test('P9 — ownerOfEntity is a pure function of the key string and consults nothing else', () => {
  // If ownership were ever resolved by a lookup — a map, a register, a ctx — it could be poisoned.
  // This pins that it is string parsing: the same key always yields the same owner, no arguments
  // beyond the key, and a key shaped like a family key but with an extra segment is refused
  // rather than silently truncated to something plausible.
  assert.equal(ownerOfEntity(`fnote:${MAMA}/abc`), MAMA);
  assert.equal(ownerOfEntity(`fbar:${PAPA}/abc`), PAPA);
  assert.equal(ownerOfEntity('note:abc'), null, 'a personal entity has no owner segment');
  assert.equal(ownerOfEntity('cat:abc'), null);

  // A three-segment family key must not parse — that is how an attacker would try to smuggle a
  // second owner past a naive `split('/')[0]`.
  assert.equal(parseEntityKey(`fnote:${MAMA}/${PAPA}/abc`), null,
    'a family key with an extra segment parsed — the owner segment is ambiguous');
  assert.equal(kindOfEntity(`fnote:${MAMA}/abc`), 'fnote');

  // Determinism and purity: 100 calls, no arguments beyond the key, identical every time.
  for (let i = 0; i < 100; i++) assert.equal(ownerOfEntity(`fnote:${MAMA}/abc`), MAMA);
});

test('P9 — the register map is unchanged by an outsider, byte for byte', () => {
  // The strongest statement of the property: not "the board looks the same" but "the state is
  // the same". EVE's own entities DO land in the register map — she is entitled to her own keys,
  // and refusing them at the fold would be censorship rather than authorization — so the
  // comparison is scoped to the entities that are not hers, which is what R10 is actually about.
  forEachSeed(seeds(250), 'P9 register-level', (seed) => {
    const w = generate(seed);
    const attack = ownershipAttacks(seed, w);
    const rnd = pcg32(seed ^ 0xEE);

    // `serializeRegisters` returns `{v, regs}` — the format version wraps the map, so the strip
    // has to reach one level in. Comparing the wrapper's keys (as the first draft did) compares
    // the string "regs" with itself and passes vacuously.
    const strip = (regs) => {
      const out = serializeRegisters(regs).regs;
      for (const k of Object.keys(out)) if (ownerOfEntity(k) === EVE || k.includes(EVE)) delete out[k];
      return sig(out);
    };
    const clean = strip(foldAuthorized(w.ops, w.authzCtx).regs);
    const attacked = strip(foldAuthorized(shuffle(rnd, [...w.ops, ...attack.ops]), w.authzCtx).regs);
    assert.equal(attacked, clean, 'an outsider changed a register on an entity that is not hers');
  });
});
