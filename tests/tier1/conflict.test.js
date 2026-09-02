// tests/tier1/conflict.test.js — 18.5, THE LOST-EDIT NOTICE, above the DOM.
// LZP-904 · deliverable 23 · ADR 004 §8, §7, §4.1 · ADR 001 §5 step 2, §6 · ADR 002 §7.4.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE IS GUARDING, AND THE ORDER IT MATTERS IN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//  1. **THAT THERE IS ONLY ONE RESOLUTION RULE.** §B drives `registers.js:displacedBy` — the seam
//     — against the register map the board is drawn from, on BOTH shapes of the same human race:
//     the owner (whose loss is a PROMOTION, ADR 004 §4.1) and the co-editor (whose loss is an
//     ordinary in-cell join). If the notice ever disagreed with the fold, the user would be told
//     they lost an edit that is on their screen, or kept one that is not. Both directions are
//     asserted, so the file cannot pass by never reporting anything.
//
//  2. **THAT ONLY THE LOSER CAN BE TOLD, STRUCTURALLY.** §F is the adversarial section and it is
//     the reason this file exists at all. Principle 9 forbids surveillance mechanics IN EITHER
//     DIRECTION, and ADR 004 §7 forbids an "X made an entry private" notification by name. Four
//     rows: the admin unshare (18.3), the remote deletion (18.6), my own second Mac (19.4), and a
//     peer op stamped at `ms = 0` (D7's P9 shape). Every one of them is a state change the fold
//     accepts and the notice must be silent about.
//
//  3. **THAT "IN FLIGHT" MEANS WHAT ADR 004 §8 SAYS.** §C pins the 30-second window and the two
//     things the ledger refuses to inherit — an op it did not watch being authored, and an op it
//     has already reported.
//
//  4. **THE COPY IS A CONTRACT.** §E sweeps every string the module can render, in BOTH
//     languages, against ADR 002 §7.4's `FORBIDDEN_CLAIMS` and against the module's own
//     `FORBIDDEN_DRAMA` — because 18.5's acceptance criterion is not "it works", it is
//     *"conflicts at family scale are rare and must be treated as boring"*, and a correct
//     implementation with the wrong sentence fails it.
//
// NO TEST READS THE WALL CLOCK (ADR 005 §5). Every stamp comes from a fake HLC on an injected
// clock; every op id comes from a counter; the ledger's `now` is a variable this file moves.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TXT, FORBIDDEN_DRAMA, FORBIDDEN_CLAIMS, IN_FLIGHT_MS, NOTICE_MS,
  admits, createLedger, readLosses, lostLine, nameOf,
} from '../../src/js/family/conflict.js';

import { standingWrite, displacedBy, fold, RegisterError } from '../../src/js/core/registers.js';
import { createClock, fmt } from '../../src/js/core/stamp.js';
import { makeOp, FIELDS, fieldsOf, coEditableFields, governingFields } from '../../src/js/core/ops.js';
import { familyKey, FAMILY_OF } from '../../src/js/core/entities.js';

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic scaffolding
// ─────────────────────────────────────────────────────────────────────────────

const ME = `mem_${'A'.repeat(22)}`;
const MAMA = `mem_${'M'.repeat(22)}`;
const ADMIN = `mem_${'D'.repeat(22)}`;
const PSP = `psp_${'E'.repeat(22)}`;
const FSP = `fsp_${'F'.repeat(22)}`;
const GID = 'C'.repeat(22);

const SHORT = {
  desktop: 'ZZZZZZZZZZZZZZZZ',
  laptop: '7QAR2MZ9XKPNC0GV',
  mama: 'HHHHHHHHHHHHHHHH',
  admin: '1111111111111111',
};

const U = '5e1a-4b2c-9c';          // the entry both people are editing
const U2 = 'aaaa-bbbb-cc';
const NOTE = `note:${U}`;
const BAR = `bar:${U2}`;
/** MY entry's publication — the owner side of the race. */
const FNOTE_MINE = familyKey('fnote', ME, U);
const FBAR_MINE = familyKey('fbar', ME, U2);
/** MAMA's entry, which I co-edit — the co-editor side of the race. */
const FNOTE_HERS = familyKey('fnote', MAMA, U);

const BASE = 1787836800000;

/** A device with its own HLC on its own fake wall clock. Nothing here reads a real clock. */
function device(name, { member = ME, short = SHORT.desktop, startMs = BASE } = {}) {
  let nowMs = startMs;
  let n = 0;
  const clock = createClock(short, () => nowMs);
  const ctx = {
    act: member,
    dev: `dev_${name[0].toUpperCase().repeat(22)}`,
    gid: GID,
    space: PSP,
    familySpaceId: FSP,
    mint: () => clock.tick(),
    newOpId: () => `${name.slice(0, 2)}${String(++n).padStart(20, '0')}`,
  };
  return {
    name,
    advance(ms) { nowMs += ms; return this; },
    at(ms) { nowMs = ms; return this; },
    emit(kind, entity, f) { return makeOp(ctx, kind, entity, f, {}); },
    note(f) { return this.emit('note.set', NOTE, f); },
    bar(f) { return this.emit('bar.set', BAR, f); },
    pub(entity, f) { return this.emit('pub.set', entity, f); },
  };
}

/** A raw op with an arbitrary stamp — for the backdating row, which `makeOp` would never mint. */
let rawN = 0;
const rawPub = (over) => ({
  v: 1,
  id: `zz${String(++rawN).padStart(20, '0')}`,
  ts: fmt(BASE, 0, SHORT.mama),
  space: FSP,
  act: MAMA,
  dev: `dev_${'M'.repeat(22)}`,
  gid: GID,
  k: 'pub.set',
  e: FNOTE_MINE,
  f: { 'pub.text': 'Mama' },
  ...over,
});

/** An in-flight ledger row, as `createLedger` would have built it. */
const inflight = (op, field, at = 1000) => ({
  entity: op.e,
  uuid: op.e.includes('/') ? op.e.split('/')[1] : op.e.split(':')[1],
  field,
  stamp: op.ts,
  op: op.id,
  value: op.f[field],
  at,
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §A — `admits`: the field domain, enumerated as data rather than sampled
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('A1 · the ledger admits exactly the co-editable fields, in BOTH namespaces', () => {
  // ONE TABLE. The expected answer is derived from `ops.js`'s own `coEdit` marks — the same marks
  // `authz.js` stage 3b and `registers.js:promoteEntity` read — so a field added to FIELDS next
  // year is covered here the day it is added, and a hand-written list cannot drift from it.
  const rows = [];
  for (const kind of ['note', 'bar']) {
    const coEdit = new Set(coEditableFields(kind));
    for (const f of fieldsOf(kind)) {
      rows.push([`${kind}:${U}`, f, coEdit.has(f)]);
      // MAMA's entity — the co-editor row, the only family shape the ledger holds.
      rows.push([familyKey(FAMILY_OF[kind], MAMA, U), `pub.${f}`, coEdit.has(f)]);
      // MY OWN publication — never, at any field. See A4.
      rows.push([familyKey(FAMILY_OF[kind], ME, U), `pub.${f}`, false]);
    }
  }
  assert.ok(rows.length >= 36, `the domain collapsed to ${rows.length} rows`);
  for (const [key, field, want] of rows) {
    assert.equal(admits(key, field, ME), want, `admits(${key}, ${field})`);
  }
});

test('A4 · MY OWN publication is never in flight — the refusal row F1 forced', () => {
  // `pub.set` on `fnote:<me>/…` is a projection of my truth, not an edit to it (ADR 004 §4.1).
  // Admitting one made an ADMIN UNSHARE (18.3) render as „Papa hat das gerade auch geändert" —
  // the "X made an entry private" notification ADR 004 §7 forbids by name. See F1.
  for (const f of ['pub.text', 'pub.date', 'pub.repeatsYearly']) {
    assert.equal(admits(FNOTE_MINE, f, ME), false, `my own publication: ${f}`);
    assert.equal(admits(FNOTE_HERS, f, ME), true, `a co-editor write on hers: ${f}`);
  }
  // With no member id the question "is this mine?" is unanswerable, and silence is the answer.
  assert.equal(admits(FNOTE_HERS, 'pub.text', null), false);
  assert.equal(admits(FNOTE_HERS, 'pub.text', 'not-a-member'), false);
  // A truth key needs no member id: it is mine by construction (nobody else's truth is here).
  assert.equal(admits(NOTE, 'text'), true);
});

test('A2 · every GOVERNING field is refused — 18.3 and 18.6 can never produce a notice', () => {
  // ADR 004 §7: "there is no op kind for a read receipt, a presence signal, or a visibility-change
  // notification". `pub.level`, `pub.coEdit` and `pub.alive` are stage-3a governing fields, so a
  // ledger that held them would turn an admin unshare into "Papa hat das geändert" — the exact
  // notification the ADR forbids — and a remote delete into a lost-edit line.
  const gov = [];
  for (const kind of ['note', 'bar']) {
    for (const f of governingFields(kind)) {
      gov.push([`${kind}:${U}`, f]);
      gov.push([familyKey(FAMILY_OF[kind], MAMA, U), `pub.${f}`]);
    }
  }
  assert.ok(gov.length >= 6, `only ${gov.length} governing fields found`);
  for (const [key, field] of gov) assert.equal(admits(key, field, ME), false, `${key} ${field}`);
  // `_alive` and `_born` are reserved rather than declared, and both must be refused too.
  assert.equal(admits(NOTE, '_alive', ME), false);
  assert.equal(admits(NOTE, '_born', ME), false);
  assert.equal(admits(FNOTE_HERS, 'pub.alive', ME), false);
});

test('A3 · kinds that are never shared are refused whole — categories, pads, prefs (A3)', () => {
  // `categoryId` has no `pub.` counterpart AT ANY LEVEL (ADR 004 §1, amendment A3). A category
  // therefore cannot be co-edited, cannot race, and must not be able to enter the ledger even if
  // some future caller offers one.
  for (const f of fieldsOf('cat')) assert.equal(admits(`cat:${U}`, f, ME), false, `cat ${f}`);
  assert.equal(admits('pad:2026-09', 'text', ME), false);
  assert.equal(admits('pref:app', 'lang', ME), false);
  assert.equal(admits(NOTE, 'categoryId', ME), false, 'A3 — a category never travels, so it never races');
  assert.equal(admits(FNOTE_HERS, 'pub.categoryId', ME), false);
  // Junk in, `false` out. No throw: this predicate is a gate, not a validator.
  assert.equal(admits('not-an-entity-key', 'text', ME), false);
  assert.equal(admits(NOTE, null, ME), false);
  assert.equal(admits(undefined, 'text', ME), false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §B — the seam. ONE resolution rule, on both shapes of the same race.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('B1 · CO-EDITOR side: my pub.text is displaced by Mama\'s newer pub.text', () => {
  // I am not the owner. Both writes land in the same cell of `fnote:<mama>/<uuid>`, and the join
  // is the ordinary one.
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const mine = me.pub(FNOTE_HERS, { 'pub.text': 'Zahnarzt 9 Uhr' });
  const hers = mama.advance(400).pub(FNOTE_HERS, { 'pub.text': 'Zahnarzt 10 Uhr' });

  const regs = fold([mine, hers]);
  const d = displacedBy(regs, FNOTE_HERS, 'pub.text', inflight(mine, 'pub.text'), ME);
  assert.ok(d, 'my in-flight write lost and the seam must say so');
  assert.equal(d.by, MAMA);
  assert.equal(d.stamp, hers.ts);
  assert.equal(d.entity, FNOTE_HERS);
  assert.equal(d.field, 'pub.text');
  // …and the board agrees, which is the whole point of asking the seam rather than a clock.
  assert.equal(standingWrite(regs, FNOTE_HERS, 'pub.text', ME).value, 'Zahnarzt 10 Uhr');
});

test('B2 · CO-EDITOR side, the mirror: I win, and nothing is reported', () => {
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const hers = mama.pub(FNOTE_HERS, { 'pub.text': 'Zahnarzt 10 Uhr' });
  const mine = me.advance(400).pub(FNOTE_HERS, { 'pub.text': 'Zahnarzt 9 Uhr' });

  const regs = fold([hers, mine]);
  assert.equal(displacedBy(regs, FNOTE_HERS, 'pub.text', inflight(mine, 'pub.text'), ME), null);
  assert.equal(standingWrite(regs, FNOTE_HERS, 'pub.text', ME).value, 'Zahnarzt 9 Uhr');
});

test('B3 · OWNER side: the loss is a PROMOTION, and the seam reads it the way the board does', () => {
  // The hard half of 18.5. My edit goes into my TRUTH register (`note:<uuid>` / `text`); Mama's
  // co-edit goes into MY PUBLICATION (`fnote:<me>/<uuid>` / `pub.text`). They are different cells
  // in different namespaces with independent stamps, and the value the board draws is decided by
  // ADR 004 §4.1's promotion. A notice that compared the truth cell alone would say I won.
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const mine = me.note({ text: 'Zahnarzt 9 Uhr' });
  const hers = mama.advance(400).pub(FNOTE_MINE, { 'pub.text': 'Zahnarzt 10 Uhr' });

  const regs = fold([mine, hers]);
  // The truth cell still holds my write — untouched, exactly as INV-R3 requires.
  assert.equal(regs.get(NOTE).get('text').value, 'Zahnarzt 9 Uhr');
  // …and what the human sees is hers.
  assert.equal(standingWrite(regs, NOTE, 'text', ME).value, 'Zahnarzt 10 Uhr');
  const d = displacedBy(regs, NOTE, 'text', inflight(mine, 'text'), ME);
  assert.ok(d, 'the owner lost the field on the board and must be told');
  assert.equal(d.by, MAMA);
});

test('B4 · OWNER side, the mirror: my newer truth write beats her publication, silently', () => {
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const hers = mama.pub(FNOTE_MINE, { 'pub.text': 'Zahnarzt 10 Uhr' });
  const mine = me.advance(400).note({ text: 'Zahnarzt 9 Uhr' });

  const regs = fold([hers, mine]);
  assert.equal(standingWrite(regs, NOTE, 'text', ME).value, 'Zahnarzt 9 Uhr');
  assert.equal(displacedBy(regs, NOTE, 'text', inflight(mine, 'text'), ME), null);
});

test('B5 · the three refusals, each on its own', () => {
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const mine = me.pub(FNOTE_HERS, { 'pub.text': 'meins' });

  // 1 — an unwritten cell is not a conflict.
  assert.equal(displacedBy(fold([]), FNOTE_HERS, 'pub.text', inflight(mine, 'pub.text'), ME), null);

  // 2 — a write of MY OWN, from a second Mac, is 19.4 working and is never a conflict.
  const laptop = device('lt', { member: ME, short: SHORT.laptop });
  const alsoMine = laptop.advance(900).pub(FNOTE_HERS, { 'pub.text': 'auch meins' });
  const regs2 = fold([mine, alsoMine]);
  assert.equal(standingWrite(regs2, FNOTE_HERS, 'pub.text', ME).value, 'auch meins');
  assert.equal(displacedBy(regs2, FNOTE_HERS, 'pub.text', inflight(mine, 'pub.text'), ME), null,
    'author is the MEMBER, so my own two Macs never fight each other');

  // 3 — an OLDER foreign write standing in the cell cannot displace mine.
  const older = mama.at(BASE - 5000).pub(FNOTE_HERS, { 'pub.text': 'alt' });
  assert.equal(displacedBy(fold([older]), FNOTE_HERS, 'pub.text', inflight(mine, 'pub.text'), ME), null);
});

test('B6 · the seam refuses to answer without a MemberId — a solo board can never reach it', () => {
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mine = me.note({ text: 'x' });
  const regs = fold([mine]);
  for (const bad of [undefined, null, '', 'me', 'mem_short']) {
    assert.throws(() => standingWrite(regs, NOTE, 'text', bad), RegisterError, `me=${bad}`);
    assert.throws(() => displacedBy(regs, NOTE, 'text', inflight(mine, 'text'), bad), RegisterError);
  }
  assert.throws(() => displacedBy(regs, NOTE, 'text', { stamp: 'not-a-stamp' }, ME), RegisterError);
  assert.throws(() => standingWrite(regs, 'nonsense', 'text', ME), RegisterError);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §C — the ledger: what "in flight" means (ADR 004 §8)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('C1 · recording is idempotent — harvest runs on every emit and must not re-arm a row', () => {
  let t = 1000;
  const led = createLedger({ now: () => t });
  const me = device('me');
  const op = me.note({ text: 'Zahnarzt', categoryId: null });
  assert.equal(led.record(op), 1, 'one admissible field of two');
  t = 20000;
  assert.equal(led.record(op), 0, 'the same op again adds nothing');
  assert.equal(led.size(), 1);
  assert.equal(led.entries()[0].at, 1000, 'and its `at` did NOT move — otherwise it never expires');
});

test('C2 · a second write to the same cell replaces the row — one edit, not two', () => {
  let t = 1000;
  const led = createLedger({ now: () => t });
  const me = device('me');
  led.record(me.note({ text: 'Zahn' }));
  t = 3000;
  led.record(me.advance(500).note({ text: 'Zahnarzt' }));
  assert.equal(led.size(), 1);
  assert.equal(led.entries()[0].value, 'Zahnarzt');
  assert.equal(led.entries()[0].at, 3000);
});

test('C3 · the 30-second window is ADR 004 §8\'s, and it is enforced by prune()', () => {
  assert.equal(IN_FLIGHT_MS, 30_000, 'ADR 004 §8 fixes the window at 30 s');
  let t = 1000;
  const led = createLedger({ now: () => t });
  const me = device('me');
  led.record(me.note({ text: 'Zahnarzt' }));
  t = 1000 + IN_FLIGHT_MS - 1;
  assert.equal(led.prune(), 0, 'still in flight one millisecond before the window closes');
  assert.equal(led.size(), 1);
  t = 1000 + IN_FLIGHT_MS;
  assert.equal(led.prune(), 1, 'and out of it exactly at the window');
  assert.equal(led.size(), 0);
});

test('C4 · an inherited op is marked seen and recorded NOWHERE — a relaunch says nothing', () => {
  // Refusal 2 in the module header. A Mac that quit with unpushed edits and relaunches into a
  // changed world must be silent: nothing was in flight, because nobody was watching.
  let t = 1000;
  const led = createLedger({ now: () => t });
  const me = device('me');
  const old = me.note({ text: 'von gestern' });
  led.ignore(old.id);
  assert.equal(led.record(old), 0);
  assert.equal(led.size(), 0);
});

test('C5 · a reported row is retired, so one race can never produce two notices', () => {
  let t = 1000;
  const led = createLedger({ now: () => t });
  const me = device('me');
  const op = me.note({ text: 'Zahnarzt' });
  led.record(op);
  const row = led.entries()[0];
  led.retire([row]);
  assert.equal(led.size(), 0);
  led.retire([row]);            // idempotent
  assert.equal(led.size(), 0);
});

test('C6 · the ledger holds only what `admits` allows — a governing write never enters', () => {
  let t = 1000;
  const led = createLedger({ now: () => t, me: () => ME });
  const me = device('me');
  assert.equal(led.record(me.note({ visibility: 'geteilt', coEdit: true })), 0,
    'the sharing cluster writes governing fields; none of them is an edit that can race');
  // On MAMA's entity — the co-editor shape. The level half is governing and never enters; the
  // content half is my edit and does.
  assert.equal(led.record(me.pub(FNOTE_HERS, { 'pub.level': 'geteilt', 'pub.text': 'meins' })), 1);
  assert.equal(led.entries()[0].field, 'pub.text');
  // And my OWN publication contributes nothing at all, at any field. See A4 and F1.
  assert.equal(led.record(me.pub(FNOTE_MINE, { 'pub.text': 'projiziert' })), 0);
  assert.equal(led.size(), 1);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §D — `readLosses`: one entry, one line
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('D1 · several lost fields of ONE bar are ONE report — a drag is one thing that happened', () => {
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const mine = me.bar({ startDate: '2026-09-01', endDate: '2026-09-07' });
  const hers = mama.advance(500).pub(FBAR_MINE, {
    'pub.startDate': '2026-09-03', 'pub.endDate': '2026-09-10',
  });
  const regs = fold([mine, hers]);
  const rows = [inflight(mine, 'startDate', 1000), inflight(mine, 'endDate', 1000)];
  const { report, retire } = readLosses(regs, rows, ME);
  assert.ok(report);
  assert.equal(report.uuid, U2);
  assert.equal(report.by, MAMA);
  assert.equal(report.rows.length, 2, 'both fields are accounted for…');
  assert.equal(retire.length, 2, '…and both are retired, so the line fires once');
});

test('D2 · a shared entry of mine reports ONCE — through the truth row, never the publication', () => {
  // Sharing an entry of mine emits a truth op AND a derived `pub.set`. Only the truth op is an
  // edit; the publication is its projection (ADR 004 §4.1) and the ledger refuses it (A4). So the
  // owner's loss arrives through promotion, once, and there is no second row to double it.
  let t = 1000;
  const led = createLedger({ now: () => t, me: () => ME });
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const truth = me.note({ text: 'Zahnarzt 9 Uhr' });
  const pub = me.pub(FNOTE_MINE, { 'pub.text': 'Zahnarzt 9 Uhr' });
  led.record(truth);
  led.record(pub);
  assert.equal(led.size(), 1, 'one edit, one row');
  const hers = mama.advance(900).pub(FNOTE_MINE, { 'pub.text': 'Zahnarzt 10 Uhr' });
  const { report } = readLosses(fold([truth, pub, hers]), led.entries(), ME);
  assert.ok(report);
  assert.equal(report.uuid, U);
  assert.equal(report.rows.length, 1);
  assert.equal(report.by, MAMA);
});

test('D3 · two entries losing at once produce ONE line — the one I touched most recently', () => {
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const noteMine = me.note({ text: 'A' });
  const barMine = me.bar({ label: 'B' });
  const hers1 = mama.advance(600).pub(FNOTE_MINE, { 'pub.text': 'A2' });
  const hers2 = mama.advance(10).pub(FBAR_MINE, { 'pub.label': 'B2' });
  const regs = fold([noteMine, barMine, hers1, hers2]);
  const rows = [inflight(noteMine, 'text', 1000), inflight(barMine, 'label', 5000)];
  const { report, retire } = readLosses(regs, rows, ME);
  assert.ok(report);
  assert.equal(report.uuid, U2, 'the bar, because it is the one I touched last');
  assert.equal(retire.length, 2, 'the other entry is silent, not pending');
});

test('D4 · when several people win several fields, the line names the NEWEST winner', () => {
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const admin = device('ad', { member: ADMIN, short: SHORT.admin });
  const mine = me.bar({ startDate: '2026-09-01', endDate: '2026-09-07' });
  const hers = mama.advance(400).pub(FBAR_MINE, { 'pub.startDate': '2026-09-02' });
  const his = admin.advance(900).pub(FBAR_MINE, { 'pub.endDate': '2026-09-12' });
  const regs = fold([mine, hers, his]);
  const rows = [inflight(mine, 'startDate', 1000), inflight(mine, 'endDate', 1000)];
  const { report } = readLosses(regs, rows, ME);
  assert.ok(report);
  assert.equal(report.by, ADMIN, 'later wins, and the sentence says so');
});

test('D5 · nothing displaced ⇒ no report and nothing retired', () => {
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mine = me.note({ text: 'Zahnarzt' });
  const regs = fold([mine]);
  const { report, retire } = readLosses(regs, [inflight(mine, 'text')], ME);
  assert.equal(report, null);
  assert.deepEqual(retire, []);
  // …and with no MemberId at all it is silent rather than throwing: solo mode reaches it as a
  // no-op, which is Principle 7.
  assert.deepEqual(readLosses(regs, [inflight(mine, 'text')], null), { report: null, retire: [] });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §E — the copy is a contract (ADR 002 §7.4 · 18.5's "boring" criterion)
// ═════════════════════════════════════════════════════════════════════════════════════════════

const everyString = () => {
  const out = [];
  for (const lang of ['de', 'en']) {
    for (const pair of Object.values(TXT)) out.push(pair[lang]);
    out.push(lostLine('Mama', lang));
    out.push(lostLine(nameOf(MAMA, () => null, lang), lang));
  }
  return out;
};

test('E1 · no string this module can render makes a claim the crypto cannot keep', () => {
  const strings = everyString();
  assert.ok(strings.length >= 8, `only ${strings.length} strings — the sweep stopped working`);
  for (const s of strings) {
    for (const claim of FORBIDDEN_CLAIMS) {
      assert.ok(!s.toLowerCase().includes(claim.toLowerCase()),
        `ADR 002 §7.4 forbids "${claim}", found in: ${s}`);
    }
  }
});

test('E2 · and none of them makes a rare event feel like an event', () => {
  // The acceptance criterion IS the sentence, not just its truth: "conflicts at family scale are
  // rare and must be treated as BORING".
  for (const s of everyString()) {
    for (const word of FORBIDDEN_DRAMA) {
      assert.ok(!s.toLowerCase().includes(word.toLowerCase()),
        `"${word}" turns 18.5 into an event — found in: ${s}`);
    }
    assert.ok(!/[!?]/.test(s), `no exclamation, no question — the board does not ask: ${s}`);
  }
});

test('E3 · German-first, both languages, one line each', () => {
  for (const lang of ['de', 'en']) {
    const line = lostLine('Mama', lang);
    assert.ok(!line.includes('\n'), 'one line');
    assert.ok(line.includes('Mama'), '17.6 names the person');
    assert.ok(line.length <= 70, `${line.length} chars is no longer one glance: ${line}`);
  }
  assert.equal(lostLine('Mama', 'de'), 'Mama hat das gerade auch geändert — die neuere Änderung gilt.');
  assert.equal(lostLine('Mama', 'en'), 'Mama changed this too just now — the newer change stands.');
  // The nameless fallback is `sharing.js`'s own, so 17.6 and 18.5 call the same person the same
  // thing on the same screen.
  assert.equal(nameOf(MAMA, () => null, 'de'), 'Ein Mitglied');
  assert.equal(nameOf(MAMA, () => '  Mama  ', 'de'), 'Mama');
  assert.equal(nameOf(MAMA, () => 'A member', 'en'), 'A member');
});

test('E4 · the notice says WHO and never WHAT — no field name reaches the copy', () => {
  // ADR 004 §7.3's rule for attribution, applied here: a lost-edit line that named the field, or
  // showed the old value, would be a diff view in one sentence.
  const names = new Set([...fieldsOf('note'), ...fieldsOf('bar')].map((f) => f.toLowerCase()));
  for (const s of everyString()) {
    for (const f of names) {
      if (f.length < 4) continue;
      assert.ok(!s.toLowerCase().includes(f), `the copy names the field "${f}": ${s}`);
    }
  }
  assert.equal(NOTICE_MS, 6000, 'it dismisses itself; it does not persist');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §F — ADVERSARIAL. Four state changes the fold accepts and the notice must be silent about.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('F1 · 18.3 — an ADMIN UNSHARE produces no notice. ADR 004 §7 forbids that message by name', () => {
  // The unshare is one op: `pub.level: 'privat'` plus every content field nulled, authored by the
  // admin at a stamp newer than mine. `registers.js:withdrawnByOther` keeps my truth whole, so
  // the promotion does not fire — and even if it had, `admits` never let `pub.level` into the
  // ledger, so there is no row to report. TWO independent reasons; this asserts both.
  const me = device('me', { member: ME, short: SHORT.desktop });
  const admin = device('ad', { member: ADMIN, short: SHORT.admin });
  const mine = me.note({ text: 'Zahnarzt' });
  const publish = me.pub(FNOTE_MINE, { 'pub.level': 'geteilt', 'pub.text': 'Zahnarzt' });
  const unshare = admin.advance(2000).pub(FNOTE_MINE, { 'pub.level': 'privat', 'pub.text': null });

  const regs = fold([mine, publish, unshare]);
  // 18.3: "it reverts to owner-private, it is NEVER deleted" — my own board still reads right.
  assert.equal(standingWrite(regs, NOTE, 'text', ME).value, 'Zahnarzt');
  const led = createLedger({ now: () => 1000, me: () => ME });
  led.record(mine);
  led.record(publish);
  assert.equal(led.size(), 1, 'only the truth edit is in flight; my publication is not an edit');
  const { report } = readLosses(regs, led.entries(), ME);
  assert.equal(report, null, 'moderation is not a lost edit, and the board never says who moderated');

  // ⚠ THE MUTANT THIS ROW EXISTS FOR. Put the publication row back in the ledger — the state this
  // file was written against — and the admin's `pub.text: null` displaces it in-cell, because
  // `withdrawnByOther` guards the TRUTH and a raw family cell has no such qualifier. The user is
  // then told „Ein Mitglied hat das gerade auch geändert" about a moderation action.
  const mutant = readLosses(regs, [inflight(publish, 'pub.text', 1000)], ME);
  assert.equal(mutant.report && mutant.report.by, ADMIN,
    'if this stops reporting, the refusal in `admits` has become untestable and may be deleted by accident');
});

test('F2 · 18.6 — a remote DELETION produces no notice; 18.6\'s answer is ⌘Z, not a line', () => {
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const mine = me.pub(FNOTE_HERS, { 'pub.text': 'Zahnarzt' });
  const killed = mama.advance(700).pub(FNOTE_HERS, { 'pub.alive': false });
  const regs = fold([mine, killed]);
  const led = createLedger({ now: () => 1000, me: () => ME });
  led.record(mine);
  led.record(killed);
  assert.equal(led.size(), 1, 'only my content write is in flight; `pub.alive` never enters');
  const { report } = readLosses(regs, led.entries(), ME);
  assert.equal(report, null);
});

test('F3 · 19.4 — my own second Mac never produces a notice, on either side of the namespace', () => {
  const desktop = device('me', { member: ME, short: SHORT.desktop });
  const laptop = device('lt', { member: ME, short: SHORT.laptop });
  const a = desktop.note({ text: 'Zahnarzt 9 Uhr' });
  const b = laptop.advance(1500).pub(FNOTE_MINE, { 'pub.text': 'Zahnarzt 10 Uhr' });
  const regs = fold([a, b]);
  const led = createLedger({ now: () => 1000, me: () => ME });
  led.record(a);
  const { report } = readLosses(regs, led.entries(), ME);
  assert.equal(report, null, 'the author is the MEMBER — one human does not race themselves');
  // The promotion asymmetry is why: my own publication is never promoted onto my own truth.
  assert.equal(standingWrite(regs, NOTE, 'text', ME).value, 'Zahnarzt 9 Uhr');
});

test('F4 · D7/P9 — a peer op backdated to ms = 0 cannot displace anything', () => {
  // D7: "ownership is structural … no op sequence, INCLUDING STAMPS AT ms = 0, can move an entity
  // to another owner". The notice inherits that for free, because it asks the same total order the
  // fold uses: a stamp at zero LOSES, so there is nothing to report. The mirror also matters — a
  // backdated op must not silently steal the line from a genuine winner.
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mine = me.pub(FNOTE_HERS, { 'pub.text': 'meins' });
  const backdated = rawPub({ e: FNOTE_HERS, ts: fmt(0, 0, SHORT.mama), f: { 'pub.text': 'geklaut' } });
  const regs = fold([mine, backdated]);
  assert.equal(standingWrite(regs, FNOTE_HERS, 'pub.text', ME).value, 'meins');
  assert.equal(displacedBy(regs, FNOTE_HERS, 'pub.text', inflight(mine, 'pub.text'), ME), null);
});

test('F5 · the notice is order-independent, because the fold it reads is', () => {
  // 18.5's "near-simultaneously" means the two ops arrive in an arbitrary order at each machine.
  // Every permutation of the same op set must give the same answer, or two people would see
  // different accounts of one race. This is ADR 001 §6 reaching the UI unchanged.
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const mine = me.pub(FNOTE_HERS, { 'pub.text': 'meins' });
  const hers = mama.advance(300).pub(FNOTE_HERS, { 'pub.text': 'ihres' });
  const perms = [[mine, hers], [hers, mine], [mine, hers, mine], [hers, mine, hers, mine]];
  for (const p of perms) {
    const d = displacedBy(fold(p), FNOTE_HERS, 'pub.text', inflight(mine, 'pub.text'), ME);
    assert.equal(d && d.by, MAMA, `permutation ${p.map((o) => o.id).join(',')}`);
  }
});

test('F6 · a co-editor CLEARING my text is a real loss — `null` is a value (R9)', () => {
  // The mirror of F1: an explicit `pub.text: null` from a co-editor at Geteilt DOES reach my
  // truth (ADR 004 §4.1, risk R9), so it is a genuine lost edit and must be reported. If this
  // ever goes quiet, the "never promote a null" shortcut has been reintroduced somewhere.
  const me = device('me', { member: ME, short: SHORT.desktop });
  const mama = device('ma', { member: MAMA, short: SHORT.mama });
  const mine = me.note({ text: 'Zahnarzt' });
  const cleared = mama.advance(800).pub(FNOTE_MINE, { 'pub.text': null });
  const regs = fold([mine, cleared]);
  const d = displacedBy(regs, NOTE, 'text', inflight(mine, 'text'), ME);
  assert.ok(d, 'an explicit null from a co-editor is an edit, and it won');
  assert.equal(d.by, MAMA);
});
