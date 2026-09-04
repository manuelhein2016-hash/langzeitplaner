// ATTACK · E13 — THE REDACTION BOUNDARY, ACROSS A QUIT-AND-OPEN.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS, AND WHY IT IS IN tests/attack/ AND NOT tests/fleet/
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// The standing bar this project re-runs every round is one sentence: **zero bytes of a Privat
// entry**. It has held through eight adversary rounds and 970 attack rows, and it holds
// STRUCTURALLY — a Privat entry produces no family op at all, so there is nothing to filter and
// nothing to bypass (`e7-leak-*`, `privacy-e5-*`, `crypto-*-read`).
//
// F2/F3/F4's repair (2026-09-04) puts a NEW PRODUCER OF OPS into that boundary. `store.js`
// reconstructs governing ops out of register cells a checkpoint absorbed, and hands them to
// `foldAuthorized` at all three fold sites. Those ops decide **who is admitted** (F3's `_alive`,
// F9's admin chain) and **what is shown** (F2's `pub.coEdit`, F4's acked level) — which is the
// boundary's own territory, in its own words. A reconstruction that rebuilt one field too many
// would be a leak with a brand-new shape: bytes that were never on the wire, minted on the
// reader's own Mac, out of a checkpoint she wrote herself.
//
// So the boundary is asked a ninth time, of the new producer specifically. It lives here because
// this is where the bar lives; it borrows `tests/fleet/`'s circle because that is the only rig in
// the tree that can build a converged circle and quit-and-open one Mac on its own disk.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE TWO HALVES, AND WHY NEITHER IS SUFFICIENT ALONE
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §1 is STATIC and it is the honest form of the claim. `ABSORBED_ROWS`'s field patterns are the
//    whole vocabulary the reconstruction can emit, so "no content field can be rebuilt" is a
//    property of a two-row table, not of a run. A dynamic row alone would only ever say "no
//    content came back on THIS board".
//
// §2 is DYNAMIC, over a real converged circle with real German entry text, because a static row
//    alone cannot see a field that arrives by a route the table does not name — an accumulator
//    that copies the whole cell, say, rather than the one value.
//
// §3 is the one that matters most and is the cheapest to get wrong: a PRIVAT entry. It has no
//    register in the family space at all, so the correct answer is that there is nothing to
//    reconstruct — and the row asserts the ABSENCE at the source, not merely that no text came
//    out the other end.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// MUTANTS — one run each, restored between, naming the row that dies
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Measured 2026-09-04, each applied alone to `src/js/store.js`, baseline 7/7 restored between.
//
//   M-B1  `ABSORBED_ROWS`' second row's field pattern widened to /^pub\./
//         dies  §1a §2b §2c        (4 pass / 3 fail) — the table admits it, the op carries it,
//                                  and `pub.text` comes back on a reader's own Mac
//   M-B2  the accumulator writes `acc.f[name] = cell` (the whole cell) instead of `cell.value`
//         dies  §2b ALONE          (6 pass / 1 fail)
//   M-B3  `ABSORBED_ROWS` extended with `{entity:/^note:/, field:/^text$/}` (the PERSONAL space)
//         dies  §1a §1b §2d        (4 pass / 3 fail) — a personal note's text reaching a
//                                  family-space op is the leak this file is a tripwire for
//
// ⚠ M-B2 SURVIVED THE FIRST DRAFT OF THIS FILE — 7/7, with the mutant in. Recorded because the
//   reason is the interesting part. Copying the cell leaks no ENTRY TEXT (the four admissible
//   cells hold booleans and one short enum), so §2c had nothing to find and passed honestly. What
//   it does leak is `cell.stamp`, whose last sixteen characters ARE the authoring device
//   (`core/stamp.js#devOf`) — a device identifier inside an op body that should carry a
//   permission and nothing else. §2b now asserts the VALUE'S TYPE as well as its NAME, and that
//   is what kills it. A mutant that survives is a missing row, not a note.
//
// HONEST-PATH CONTROL: this file green with no mutant applied, and §2a is a non-vacuity row —
// the reconstruction must actually PRODUCE something, or §2b/§2c/§2d pass by emptiness.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { familyKey } from '../../src/js/core/ops.js';
import { entityUuid as newUuid } from '../../src/js/core/ids.js';

import {
  circle, converge, on, mkPubSet, patchedOp,
} from '../fleet/e9-attack-kit.js';
import { engineFor } from '../fleet/e6-attack-circle.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE RIG — the same two calls `tests/fleet/e13-compaction.test.js` makes, and nothing more
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Quit and open again on the same disk. Nothing here shapes what the checkpoint writes. */
async function quitAndOpen(C, mac) {
  await on(mac, async () => {
    clearTimeout(mac.store._saveTimer);
    await mac.store.persistNow();
    mac.store.ready = false;
    mac.store.listeners.clear();
    await mac.store.init();
    mac.engine = engineFor(C, mac);
  });
}

/** One owner-published `pub.set`, sealed the way `publishSharedEntry` seals. */
async function share(C, mac, fields, level = 'geteilt') {
  const key = familyKey('fnote', mac.forStore.memberId, newUuid());
  await on(mac, async () => {
    await patchedOp(C, mac, mkPubSet(C, mac, key, {
      'pub.level': level, 'pub.alive': true, 'pub.date': '2026-10-14', ...fields,
    }, level), { levelOf: () => level });
    await mac.engine.syncNow();
  });
  await converge(C, C.macs.filter((m) => m !== mac));
  return key;
}

/** Every string anywhere inside a value, however nested — the leak does not have to be top level. */
function stringsIn(v, out = []) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsIn(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsIn(x, out);
  return out;
}

// The three strings that must never appear in a reconstructed op. German, because the product is
// German-first and a leak that only shows up in ASCII is a leak that was tested in English.
const GETEILT_TEXT = 'Herbstferien an der Nordsee';
const PRIVAT_TEXT = 'Befund Dr. Weber besprechen';
const PERSONAL_TEXT = 'Mamas Geburtstag — Kuchen bestellen';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 · THE TABLE — a static bound on what the reconstruction can ever emit
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E13-B §1 · the reconstruction\'s vocabulary is bounded by a table, not by a filter', () => {
  // `ABSORBED_ROWS` is module-private, so it is read the way the boundary is always read here:
  // out of the shipped source. A regex over source is a weak instrument in general — the audit's
  // own §5b records two false reds from exactly that — so this row does not scan for a phrase.
  // It extracts the table's literal field PATTERNS and reasons about them.
  const SRC = new URL('../../src/js/store.js', import.meta.url);

  test('§1a · the only fields it can rebuild are `_alive` and pub.{level,coEdit,alive}', async () => {
    const src = await (await import('node:fs/promises')).readFile(SRC, 'utf8');
    const table = src.slice(src.indexOf('const ABSORBED_ROWS'), src.indexOf('const ABSORBED_ROWS') + 700);
    assert.ok(/ABSORBED_ROWS/.test(table), 'ABSORBED_ROWS is gone — the bound is no longer a table');

    const fields = [...table.matchAll(/field:\s*(\/[^/]+\/)/g)].map((m) => m[1]);
    assert.deepEqual(fields, ['/^_alive$/', '/^pub\\.(level|coEdit|alive)$/'],
      'the reconstruction\'s field vocabulary moved. Every name it admits is an ADMISSIBILITY '
      + 'input and none may be CONTENT — `pub.text`, `pub.label`, `pub.date`, `pub.repeatsYearly` '
      + 'and every personal-space field are content or metadata about content. Widen this and a '
      + 'reader\'s own checkpoint starts minting bytes that were never on her wire.');

    // And the patterns are ANCHORED at both ends. `/^pub\./` unanchored would admit `pub.text`
    // while still reading as "the pub row", which is mutant M-B1 and the likeliest wrong edit.
    for (const f of fields) {
      assert.ok(f.startsWith('/^') && (f.endsWith('$/') || f.includes(')$/')),
        `${f} is not anchored at both ends — it admits fields whose names merely start this way`);
    }
  });

  test('§1b · no row of the table reaches a PERSONAL-space entity at all', async () => {
    const src = await (await import('node:fs/promises')).readFile(SRC, 'utf8');
    const table = src.slice(src.indexOf('const ABSORBED_ROWS'), src.indexOf('const ABSORBED_ROWS') + 700);
    const entities = [...table.matchAll(/entity:\s*(\/[^/]+\/)/g)].map((m) => m[1]);
    assert.deepEqual(entities, ['/^member:/', '/^(fnote|fbar):/'],
      'the reconstruction reaches a new entity class. `note:` and `bar:` are the PERSONAL space — '
      + 'ADR 001 §3.3 — and their `text`/`label` cells are the user\'s own writing. A family-space '
      + 'op rebuilt out of one of those cells is the leak this file exists to catch.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 · THE BOARD — a real converged circle, a real quit-and-open, real German text
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E13-B §2 · after a quit-and-open the reconstruction carries no byte of any entry', () => {
  test('§2a · NON-VACUITY — the reconstruction actually produces governing ops', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.papa, { 'pub.text': GETEILT_TEXT, 'pub.coEdit': true });
    await quitAndOpen(C, C.oma);

    let rebuilt = [];
    await on(C.oma, () => { rebuilt = C.oma.store._absorbedGovernanceOps(); });
    assert.ok(rebuilt.length >= 1,
      'nothing was reconstructed, so every assertion below would pass by emptiness. Either the '
      + 'absorption did not happen or the repair is gone — both are findings, and neither is this '
      + 'row\'s subject.');
    // And it did rebuild the governing field the co-editor's admission turns on, or §2b–§2d are
    // measuring a reconstruction that is not the one F2 is about.
    const fields = new Set(rebuilt.flatMap((o) => Object.keys(o.f || {})));
    assert.ok(fields.has('pub.coEdit'),
      `the co-edit grant was not among the rebuilt fields (${[...fields].join(', ')})`);
  });

  test('§2b · not one rebuilt op carries a field outside the admissibility vocabulary', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.papa, { 'pub.text': GETEILT_TEXT, 'pub.coEdit': true });
    // A second entry, with the other two CONTENT fields an `fnote` may carry. (`pub.label` is an
    // `fbar` field and `sealOp` refuses it under an `fnote` key — measured while writing this row,
    // and a small independent confirmation that the seal is a whitelist and not a coat of paint.)
    await share(C, C.mama, { 'pub.text': 'Zahnarzt 9 Uhr', 'pub.repeatsYearly': true });
    await quitAndOpen(C, C.oma);

    let rebuilt = [];
    await on(C.oma, () => { rebuilt = C.oma.store._absorbedGovernanceOps(); });
    const ALLOWED = new Set(['_alive', 'pub.level', 'pub.coEdit', 'pub.alive']);
    for (const op of rebuilt) {
      for (const [name, value] of Object.entries(op.f || {})) {
        assert.ok(ALLOWED.has(name),
          `a rebuilt op carries "${name}", which is not an admissibility input: ${JSON.stringify(op.f)}`);
        // AND THE VALUE IS THE CELL'S VALUE, NOT THE CELL. Every one of the four names above is a
        // boolean or a short enum string, so a value that is an OBJECT can only be the register
        // cell copied whole — `{value, stamp, author, op}`. That is mutant M-B2, it survived the
        // first draft of this file, and it is not merely untidy: `stamp`'s last sixteen characters
        // ARE the authoring device (`core/stamp.js#devOf`), so a cell copy puts a device
        // identifier inside an op body that is supposed to carry a permission and nothing else.
        // Principle 9 is enforced by the absence of a distinguishing byte; this would add one.
        assert.ok(value === null || typeof value !== 'object',
          `"${name}" was rebuilt as an object, so the register CELL was copied rather than its `
          + `value — that puts the authoring device's stamp into the op body: ${JSON.stringify(value)}`);
      }
    }
  });

  test('§2c · ██ NOT ONE BYTE OF A GETEILT ENTRY\'S TEXT SURVIVES THE REBUILD ██', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    const key = await share(C, C.papa, { 'pub.text': GETEILT_TEXT, 'pub.coEdit': true });
    await quitAndOpen(C, C.oma);

    // NON-VACUITY: the text really is in this Mac's REGISTERS — it is a Geteilt entry and Oma is
    // entitled to read it on her board. The claim is about the reconstruction, not about secrecy.
    let onBoard = null;
    let rebuilt = [];
    await on(C.oma, () => {
      onBoard = C.oma.store._log.registers().get(key)?.get('pub.text')?.value ?? null;
      rebuilt = C.oma.store._absorbedGovernanceOps();
    });
    assert.equal(onBoard, GETEILT_TEXT,
      'the shared text is not in Oma\'s registers at all — then this row proves nothing, because '
      + 'the reconstruction had no text available to leak in the first place');

    const strings = rebuilt.flatMap((o) => stringsIn(o.f));
    assert.equal(strings.filter((s) => s.includes(GETEILT_TEXT)).length, 0,
      `a rebuilt op carried the entry's text: ${JSON.stringify(strings)}`);
    // And not a fragment of it either — a truncated or hashed copy is still a byte of it.
    for (const word of GETEILT_TEXT.split(' ')) {
      assert.equal(strings.some((s) => s.includes(word)), false,
        `a rebuilt op carried "${word}" out of the entry's text: ${JSON.stringify(strings)}`);
    }
  });

  test('§2d · ██ A PRIVAT ENTRY HAS NOTHING TO REBUILD, AND THAT IS ASSERTED AT THE SOURCE ██', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    // Papa's own board: one personal note and one entry he keeps Privat. Neither publishes.
    await on(C.papa, async () => {
      assert.equal(C.papa.store.apply('createNoteInline', {
        id: newUuid(), date: '2026-11-03', text: PERSONAL_TEXT, categoryId: 'c1',
      }), true);
      assert.equal(C.papa.store.apply('createNoteInline', {
        id: newUuid(), date: '2026-11-04', text: PRIVAT_TEXT, categoryId: 'c1', visibility: 'privat',
      }), true);
      await C.papa.engine.syncNow();
      clearTimeout(C.papa.store._saveTimer);
      await C.papa.store.persistNow();
    });
    await converge(C, [C.mama, C.oma]);
    await quitAndOpen(C, C.papa);

    // THE ABSENCE, AT THE SOURCE. 16.1 is structural: a Privat entry produces ZERO family ops, so
    // there is no family register holding it and therefore nothing a reconstruction could reach.
    // Asserting "no text came out" alone would also pass if the register existed and the filter
    // merely worked — a weaker guarantee and a different one.
    let famKeys = [];
    let rebuilt = [];
    await on(C.papa, () => {
      famKeys = [...C.papa.store._log.registers().keys()].filter((k) => /^(fnote|fbar):/.test(k));
      rebuilt = C.papa.store._absorbedGovernanceOps();
    });
    const allStrings = famKeys.flatMap((k) => {
      let out = [];
      const cells = C.papa.store._log.registers().get(k);
      if (cells) for (const [, cell] of cells) out = out.concat(stringsIn(cell?.value));
      return out;
    }).concat(rebuilt.flatMap((o) => stringsIn(o.f)));

    for (const secret of [PRIVAT_TEXT, PERSONAL_TEXT]) {
      assert.equal(allStrings.some((s) => s.includes(secret)), false,
        `"${secret}" reached the family space after a quit-and-open: ${JSON.stringify(allStrings)}`);
      for (const word of secret.split(' ')) {
        if (word.length < 4) continue;   // „Dr." and „—" are not evidence of anything
        assert.equal(allStrings.some((s) => s.includes(word)), false,
          `"${word}" reached the family space after a quit-and-open: ${JSON.stringify(allStrings)}`);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 · THE CHAIN REPAIR — the same question of the other producer
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E13-B §3 · the admin-chain reconstruction carries two member ids and nothing else', () => {
  test('§3a · a rebuilt `space.set` link has exactly {admin, adminPrev} and no content', async () => {
    const C = await circle(['papa', 'mama', 'oma']);
    await share(C, C.papa, { 'pub.text': GETEILT_TEXT });
    await quitAndOpen(C, C.oma);

    // The absorption is imposed for the length of the call — R-1b's retention deliberately keeps
    // the chain line, and a link that is still a line is correctly not rebuilt beside itself.
    // (`tests/fleet/e12-unshare.test.js#withSpaceSetAbsorbed` is the same idiom and says why.)
    let links = [];
    await on(C.oma, () => {
      const log = C.oma.store._log;
      const real = log.ops.bind(log);
      log.ops = (opts) => real(opts).filter((o) => o.k !== 'space.set');
      try { links = C.oma.store._absorbedChainOps(); } finally { log.ops = real; }
    });
    assert.equal(links.length, 1, `the chain reconstruction rebuilt ${links.length} links, not one`);
    assert.deepEqual(Object.keys(links[0].f).sort(), ['admin', 'adminPrev'],
      `a rebuilt chain link carries fields beyond the seat: ${JSON.stringify(links[0].f)}`);
    const strings = stringsIn(links[0].f);
    assert.equal(strings.some((s) => s.includes(GETEILT_TEXT)), false,
      'the chain link carried entry text');
    // The one string it does carry is a member id, and it is one this circle actually holds.
    assert.equal(links[0].f.admin, C.papa.forStore.memberId,
      'the rebuilt link names somebody who is not the admin');
    assert.equal(links[0].f.adminPrev, null, 'a rebuilt link must be genesis-shaped or absent');
  });
});
