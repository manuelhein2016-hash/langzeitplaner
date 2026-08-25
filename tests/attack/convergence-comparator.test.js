// tests/attack/convergence-comparator.test.js
//
// CONVERGENCE ATTACKS on the order itself — "is `≺` really a total order?" — and on the one
// admissibility predicate that is an EXACT match against a build-local field table.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fold, emptyRegisters, applyOp, cmpWrites, deserializeRegisters, serializeRegisters } from '../../src/js/core/registers.js';
import { foldAuthorized } from '../../src/js/core/authz.js';
import { isAdminUnsharePatch, unsharePatch } from '../../src/js/core/authz.js';
import { noteKey, familyKey, memberKey, spaceKey } from '../../src/js/core/entities.js';
import { attestationBlob, attestVerify, DEVICES, ME, MAMA, PSP, FSP } from '../helpers/gen.js';
import { BASE_MS, minter, shuffled, regsJSON, pad22 } from './_kit.js';

const M = (d) => minter(d, { fsp: FSP });
const DEV = {
  meDesk: DEVICES.find((d) => d.name === 'me-desktop'),
  mama: DEVICES.find((d) => d.name === 'mama-mac'),
};
const NOTE = '5e1a0000-0000-4000-8000-000000000001';
const KEY = noteKey(NOTE);

// ─────────────────────────────────────────────────────────────────────────────
// CONTROL — a modified client CAN mint two writes at one stamp; `≺` still resolves them.
// ─────────────────────────────────────────────────────────────────────────────

test('CONTROL — two ops at an identical stamp converge under every permutation', () => {
  const op = M(DEV.meDesk);
  const a = op('note.set', KEY, { text: 'A', date: '2026-09-10' }, { ms: BASE_MS, ctr: 7, space: PSP });
  const b = op('note.set', KEY, { text: 'B', date: '2026-09-10' }, { ms: BASE_MS, ctr: 7, space: PSP });
  assert.equal(a.ts, b.ts, 'precondition: the stamps are byte-identical');
  assert.notEqual(a.id, b.id);

  const reference = regsJSON(fold([a, b]));
  for (let s = 1; s <= 40; s++) {
    const regs = emptyRegisters();
    for (const o of shuffled([a, b, a, b], s)) applyOp(regs, o);
    assert.equal(regsJSON(regs), reference, `seed ${s}`);
  }
});

test('CONTROL — a forged deviceShort collision still resolves: opId is the third key', () => {
  // Mama runs a modified client that stamps with MY device short, at my exact millisecond.
  const mine = M(DEV.meDesk)('note.set', KEY, { text: 'meins', date: '2026-09-10' },
    { ms: BASE_MS, ctr: 3, space: PSP });
  const forged = Object.freeze({ ...mine, id: pad22('FORGED'), f: Object.freeze({ text: 'gefaelscht' }) });
  assert.equal(mine.ts, forged.ts);

  assert.equal(regsJSON(fold([mine, forged])), regsJSON(fold([forged, mine])));
  assert.notEqual(cmpWrites({ stamp: mine.ts, op: mine.id, value: 'x' },
    { stamp: forged.ts, op: forged.id, value: 'x' }), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// C1 — CLOSED. A checkpoint register that lost its opId used to flip the forget-blank tiebreak.
//
// `deserializeRegisters` treated `op` as optional and stored `''` when it was absent. `cmpWrites`
// then compared `'' < <anyOpId>`, so ANY re-delivered op at the same stamp beat the stored
// register. For the ADR 004 §5.3 forget blank — value `null`, stamp and opId retained deliberately
// so the blank wins its own tie — losing the opId meant the retracted plaintext came BACK on the
// next re-pull. INV-R4 (a downgrade removes) silently not holding, one optional key away.
//
// Closed at BOTH ends, because a privacy retraction should not rest on one check:
//   1. `deserializeRegisters` now REFUSES a register with no OpId. `op` is SHAPE, not vocabulary,
//      and the module's stated doctrine is strict on shape; `serializeRegisters` has always
//      written it, and `oplog.js`'s forget pass already documents its dependence on it.
//   2. `cmpWrites` ranks a MISSING opId ABOVE every real one, so if an unattributed write is ever
//      constructed some other way it is ABSORBING rather than weakest. Only a genuinely greater
//      stamp — the owner publishing again — can displace it.
// ─────────────────────────────────────────────────────────────────────────────

test('C1 CLOSED: a checkpoint register with no `op` is refused, and cannot un-blank a retraction', () => {
  const op = M(DEV.meDesk);
  const published = op('note.set', KEY, { text: 'Krebsvorsorge', date: '2026-09-10' }, { ms: BASE_MS, space: PSP });

  // The ADR 004 §5.3 forget blank: value gone, stamp AND opId retained so the blank wins its tie.
  const blanked = serializeRegisters(fold([published]));
  blanked.regs[KEY].text = { value: null, stamp: published.ts, author: ME, op: published.id };

  const withOpId = deserializeRegisters(blanked);
  applyOp(withOpId, published);
  assert.equal(withOpId.get(KEY).get('text').value, null, 'the blank holds — this always worked');

  // (1) The same file with the `op` key dropped is now a CORRUPT file, not a weak register.
  const lossy = JSON.parse(JSON.stringify(blanked, (k, v) => (k === 'op' ? undefined : v)));
  assert.throws(() => deserializeRegisters(lossy),
    (e) => /op id/.test(e.message), 'the unattributed register never gets into the map at all');

  // (2) Defence in depth: hand-build the register the loader now refuses and re-deliver the very
  // op whose value was blanked. Under the old `a.op ?? ''` rank this put 'Krebsvorsorge' back.
  const handBuilt = new Map([[KEY, new Map([
    ['text', Object.freeze({ value: null, stamp: published.ts, author: ME })],
  ])]]);
  applyOp(handBuilt, published);
  assert.equal(handBuilt.get(KEY).get('text').value, null,
    'a missing opId is ABSORBING, not weakest — the retraction holds');

  // …and it is absorbing, not immovable: the owner sharing again at a GREATER stamp still wins.
  const republished = op('note.set', KEY, { text: 'Krebsvorsorge' }, { ms: BASE_MS + 5000, space: PSP });
  applyOp(handBuilt, republished);
  assert.equal(handBuilt.get(KEY).get('text').value, 'Krebsvorsorge', 'republication is not a leak');
});

// ─────────────────────────────────────────────────────────────────────────────
// C2 — CLOSED. The admin unshare was an EXACT match against THIS BUILD's field table.
//
// `unsharePatch(kind)` is derived from `FIELDS[kind]` at runtime, and `isAdminUnsharePatch` used
// to demand exactly those keys. Adding one `pub.*` field to `fnote` in a later version therefore
// changed what counted as an unshare. An unshare authored by an OLDER build carries one field
// fewer, and a NEWER build REJECTED it (`notAnUnshare`) — a rejection is final, not a park — so
// the entry the admin unshared stayed visible on the newer client while it was hidden on the
// older one. That is the "previously-hidden content reappears" failure ADR 001 §4.1 exists to
// prevent, arriving through a staggered app update instead of through a compromised relay.
//
// The predicate is now a property of the PATCH: level → privat, and every other field it carries
// is null. Version-independent in both directions, and a near-miss PARKS instead of dying.
// ─────────────────────────────────────────────────────────────────────────────

test('C2 CLOSED: an unshare from an older build — one pub field short — still unshares', () => {
  const w = family();
  const share = w.me('pub.set', w.fkey, {
    'pub.level': 'geteilt', 'pub.coEdit': false, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'Krebsvorsorge',
  }, { ms: BASE_MS + 20, space: FSP });

  const exact = { ...unsharePatch('fnote') };
  assert.deepEqual(Object.keys(exact).sort(),
    ['pub.alive', 'pub.coEdit', 'pub.date', 'pub.level', 'pub.repeatsYearly', 'pub.text']);

  // Exactly what an older build — one that did not yet know `pub.repeatsYearly` — would emit.
  const older = { ...exact };
  delete older['pub.repeatsYearly'];
  assert.equal(isAdminUnsharePatch('fnote', older), true, 'the predicate is not version-coupled');

  const unshare = w.mama('pub.set', w.fkey, older, { ms: BASE_MS + 40, space: FSP });
  const r = foldAuthorized([...w.setupMamaAdmin, share, unshare], w.ctx);

  assert.equal(r.rejectionOf(unshare.id), null, 'admitted, not dropped');
  assert.equal(r.regs.get(w.fkey).get('pub.level').value, 'privat', 'THE POINT: it really is unshared');
  assert.equal(r.regs.get(w.fkey).get('pub.text').value, null, 'and the text it carried is withdrawn');

  // The complete patch is of course still admitted.
  const good = w.mama('pub.set', w.fkey, exact, { ms: BASE_MS + 50, space: FSP });
  const ok = foldAuthorized([...w.setupMamaAdmin, share, good], w.ctx);
  assert.equal(ok.rejectionOf(good.id), null);
  assert.equal(ok.regs.get(w.fkey).get('pub.level').value, 'privat');
});

test('C2 CLOSED: a NEWER client\'s unshare, carrying a pub field this build has never heard of', () => {
  // The other skew direction. `pub.futureField` is not in THIS build's `FIELDS.fnote`, so the op
  // is parked by `classifyOp` before authorization ever sees it — `unknownField`, ADR 001 §7.4.
  // Parked is the correct degradation: the op is RETAINED and re-evaluated after the app update,
  // so the unshare lands as soon as this client knows what it is being asked to withdraw. What it
  // must never be is REJECTED, which would drop the op and leave the entry published forever.
  const w = family();
  const share = w.me('pub.set', w.fkey, {
    'pub.level': 'geteilt', 'pub.coEdit': false, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'Krebsvorsorge',
  }, { ms: BASE_MS + 20, space: FSP });

  // `makeOp` will not MINT a field it has no spec for, so the v2.1 op is hand-rolled — which is
  // exactly what it looks like coming off the wire from a client one release ahead.
  const template = w.mama('pub.set', w.fkey, unsharePatch('fnote'), { ms: BASE_MS + 40, space: FSP });
  const newer = { ...template, f: { ...template.f, 'pub.futureField': null } };
  const r = foldAuthorized([...w.setupMamaAdmin, share, newer], w.ctx);

  assert.equal(r.rejectionOf(newer.id), null, 'NOT rejected — a rejection would be final');
  assert.equal(r.parkReasonOf(newer.id), 'unknownField', 'parked, and re-evaluable after an update');
  assert.ok(r.parked.some((o) => o.id === newer.id), 'and the op itself is retained');

  // The patch is nevertheless recognisable as an unshare, so once the field table catches up the
  // parked op unparks straight into stage 3a rather than into a rejection.
  assert.equal(isAdminUnsharePatch('fnote', newer.f), true);
});

test('C2 CLOSED: an unshare carrying a NON-withdrawal is parked, never admitted, never dropped', () => {
  // A future build that withdraws a field with a sentinel instead of `null` is skew this build
  // cannot read. Parking it keeps both guarantees at once: the admin gets no general write
  // primitive (a parked op is never folded), and the op survives for a build that understands it.
  const w = family();
  const share = w.me('pub.set', w.fkey, {
    'pub.level': 'geteilt', 'pub.coEdit': false, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'Krebsvorsorge',
  }, { ms: BASE_MS + 20, space: FSP });

  const sentinel = w.mama('pub.set', w.fkey,
    { ...unsharePatch('fnote'), 'pub.text': '' }, { ms: BASE_MS + 40, space: FSP });
  const r = foldAuthorized([...w.setupMamaAdmin, share, sentinel], w.ctx);

  assert.equal(r.rejectionOf(sentinel.id), null, 'not rejected');
  assert.equal(r.parkReasonOf(sentinel.id), 'unshareShape',
    'parked for re-evaluation after an update — and under its OWN reason code, not `version`, '
    + 'which is defined as a verdict on `op.v` and did not produce this park');
  assert.equal(r.regs.get(w.fkey).get('pub.text').value, 'Krebsvorsorge', 'and NOT applied');

  // A patch that is not an unshare in ANY version is still a hard rejection — that is the line
  // between "we cannot read this yet" and "an admin is writing on somebody else's entity".
  const notAnUnshare = w.mama('pub.set', w.fkey,
    { ...unsharePatch('fnote'), 'pub.level': 'belegt' }, { ms: BASE_MS + 60, space: FSP });
  const r2 = foldAuthorized([...w.setupMamaAdmin, share, notAnUnshare], w.ctx);
  assert.equal(r2.rejectionOf(notAnUnshare.id).reason, 'notAnUnshare');
  assert.equal(r2.parkReasonOf(notAnUnshare.id), null);
});

// ─────────────────────────────────────────────────────────────────────────────

function family() {
  const me = M(DEV.meDesk);
  const mama = M(DEV.mama);
  const fkey = familyKey('fnote', ME, NOTE);
  const base = [
    me('member.set', memberKey(ME), { [`dev.${DEV.meDesk.short}`]: attestationBlob(ME, DEV.meDesk) },
      { ms: BASE_MS - 9000, space: FSP }),
    mama('member.set', memberKey(MAMA), { [`dev.${DEV.mama.short}`]: attestationBlob(MAMA, DEV.mama) },
      { ms: BASE_MS - 8000, space: FSP }),
    me('member.set', memberKey(ME), { displayName: 'Ich', _alive: true }, { ms: BASE_MS - 6000, space: FSP }),
    mama('member.set', memberKey(MAMA), { displayName: 'Mama', _alive: true }, { ms: BASE_MS - 5000, space: FSP }),
  ];
  return {
    me, mama, fkey,
    setupMamaAdmin: [...base, mama('space.set', spaceKey(FSP), { admin: MAMA, adminPrev: null },
      { ms: BASE_MS - 3000, space: FSP })],
    ctx: { me: ME, nowMs: BASE_MS + 10 * 3600000, attestVerify },
  };
}
