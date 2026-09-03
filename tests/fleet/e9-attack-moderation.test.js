// FLEET · E9-C — ABUSING THE ADMIN UNSHARE (story 18.3 · LZP-903).
// ADR 001 §4.1 (the admin chain), §4.3 stage 3a · ADR 004 §5, §5.1, §7 · Principle 9 ·
// `core/authz.js:classifyUnsharePatch` · `core/project.js:adminUnshareOp` /
// `adminUnshareFollowUp` · `sync/family.js:sealLevelFor`.
//
// 18.3 grants the admin ONE verb over content that is not his: "it reverts to owner-private, it
// is never deleted — so moderation is possible but non-destructive, and I still can't read what
// was never shared." Four things are therefore promised at once, and each is a separate attack:
//
//     REVERT, NOT DELETE     §3b — can I make it a delete primitive?
//     NON-DESTRUCTIVE        §3b, §3i — does the owner still have their entry, and their undo?
//     I CANNOT READ          §3c, §3d — can the verb be used as an ORACLE over content I have
//                            never been shown?
//     AND IT STAYS DONE      §3e, §3f, §3h — replay, re-share, and a clock that is ahead.
//
// I am PAPA, the genuine genesis admin, with a patched client. Every op is authored by the real
// admin seat as the folded chain resolves it; nothing here forges the chain (that is
// `tests/attack/ownership-authz-admin.test.js`'s A2/A4, which are open and out of scope here).
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// DISPOSITION — READ BEFORE TRUSTING A GREEN RUN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// All four ATTACKS on the verb itself FAILED — the moderation is not a delete, not an oracle, not
// replayable and not available to a non-admin. §3b-b was a `SUCCEEDED` row and it was never about
// the verb at all: it was about the SEAM the verb's tri-state verdict crosses.
//
//     §3b-b IS CLOSED AND HAS BEEN INVERTED. It now asserts that the fold's PARK verdict is
//     honoured at that seam.
//
// WHAT CLOSED IT (`store.js:applyRemote`): the door read `verdict.rejected` and nothing else, so
// the tri-state's whole middle had no reader. Every OTHER park reason survived that gap because
// it comes from `classifyOp`, which `_log.append` runs one line later; `UNSHARE_SHAPE` is
// produced INSIDE `foldAuthorized` stage 3a and nowhere else. `FOLD_ONLY_PARKS` is the set of
// verdicts the classifier cannot reach, `applyRemote` parks them under the fold's own reason,
// and `authz.js`'s claim — "a parked op is never folded, so an admin who pads an unshare with a
// content write still gets no write primitive" — is true again because that map is consulted.
//
// The file's non-vacuity controls are §3a, which moderates successfully on the same rig, and
// §3f, which shows a SECOND unshare still works — without those, a build in which
// `adminUnshareOp` did nothing at all would look identical. Both are green under the fix, which
// is the measurement that says the fix costs the moderation verb nothing.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANT — one run, scratch copy
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   M-C1  `store.js` — `const FOLD_ONLY_PARKS = new Set();` (empty), i.e. restore the seam with
//         no reader while leaving every other line of the fix in place.
//         MEASURED, twice, in a scratch copy: **§3b-b dies and NOTHING ELSE DOES** — the other
//         rows in the four E9 attack files stay green, §3a and §3f included, and `npm test`,
//         `npm run test:attack` and `npm run test:server` are unmoved.
//
//         ⚠ A COARSER VERSION — parking EVERY op in `verdict.parked` — is why the set exists
//         rather than a branch: the fold parks more at that seam than the skew case alone, and
//         `_log.append` already parks the five `classifyOp` reasons one line later. Double-
//         parking them would move the `future` seam R6-4c pins. Recorded because it is a fact
//         about the seam a reader should have before widening the set.

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey } from '../../src/js/core/ops.js';
import { adminUnshareOp } from '../../src/js/core/project.js';
import { classifyUnsharePatch, foldAuthorized, registerValue } from '../../src/js/core/authz.js';
import { brandFamilyPatch } from '../../src/js/crypto/envelope.js';

import {
  circle, converge, on, mkPubSet, patchedOp, pushOp, regsOf, opsOn, parkedOn, boardOf,
} from './e9-attack-kit.js';

/** MAMA creates a real entry through the shipped mutations and shares it at `level`. */
async function mamaEntry(C, { text, level }) {
  const uuid = newUuid();
  await on(C.mama, async () => {
    assert.equal(C.mama.store.apply('createNoteInline', {
      id: uuid, date: '2026-12-24', text, categoryId: 'c1',
    }), true);
    if (level !== 'privat') {
      C.mama.store.txn('share', (tx) => { tx.note(uuid).set({ visibility: level }); });
    }
    await C.mama.engine.syncNow();
  });
  await converge(C, [C.papa, C.oma]);
  return { uuid, key: familyKey('fnote', C.mama.forStore.memberId, uuid) };
}

/** The shipped moderation op, sealed the way `sync/family.js:sealLevelFor` seals a retraction. */
async function moderate(C, target, { pad = null, stamp = null, seal = {} } = {}) {
  let out = null;
  await on(C.papa, async () => {
    let op = adminUnshareOp(C.papa.store._ctx(), { kind: 'fnote', owner: target.owner, uuid: target.uuid });
    if (pad || stamp) {
      op = Object.freeze({
        ...op,
        ts: stamp ?? op.ts,
        f: brandFamilyPatch({ ...op.f, ...(pad || {}) }, { kind: 'fnote', level: 'privat' }),
      });
    }
    out = await pushOp(C, C.papa, op, {
      levelOf: () => null,                                  // barrier 4's retraction clause
      adminOf: () => C.papa.forStore.memberId,
      assertFamilyPatch: () => {},
      ...seal,
    });
  });
  return out;
}

describe('E9-C · the moderation verb, attacked four ways', () => {
  let C = null;
  before(async () => { C = await circle(['papa', 'mama', 'oma']); });

  test('§3a · NON-VACUITY · it reverts, on every board, and the owner reconciles', async () => {
    const e = await mamaEntry(C, { text: 'Bescherung 18:00', level: 'geteilt' });
    assert.equal((await regsOf(C.oma, e.key))['pub.text'], 'Bescherung 18:00');
    await moderate(C, { owner: C.mama.forStore.memberId, uuid: e.uuid });
    await converge(C, [C.mama, C.oma]);
    assert.equal((await regsOf(C.oma, e.key))['pub.level'], 'privat');
    assert.equal((await regsOf(C.oma, e.key))['pub.text'], null);
    await on(C.mama, () => {
      assert.equal(C.mama.store.registers().get(`note:${e.uuid}`).get('visibility').value, 'privat',
        'the owner-side follow-up ran');
      const [row] = C.mama.store.state.notes.filter((n) => n.id === e.uuid);
      assert.ok(row, 'IT IS NEVER DELETED: the note is still on her board');
      assert.equal(row.text, 'Bescherung 18:00', '…with its text, which is hers and always was');
    });
  });

  test('§3b · FAILED · it cannot be turned into a delete', async () => {
    // Two routes. (1) The shipped patch itself: `unsharePatch` writes `pub.alive: null`, and a
    // null is a WITHDRAWAL of a register, never `false`. (2) Padding: an admin who appends
    // `pub.alive: false` to make it a deletion changes the patch's CLASS — `classifyUnsharePatch`
    // reads "every other field is null" and answers `skew`, so every honest device PARKS the op
    // and folds nothing at all.
    const e = await mamaEntry(C, { text: 'Zahnarzt 9 Uhr', level: 'geteilt' });
    const shipped = adminUnshareOp((await ctxOf(C.papa)), {
      kind: 'fnote', owner: C.mama.forStore.memberId, uuid: e.uuid,
    });
    assert.equal(shipped.f['pub.alive'], null, 'a withdrawal, not a `false`');
    assert.equal(classifyUnsharePatch('fnote', shipped.f), 'unshare');
    assert.equal(classifyUnsharePatch('fnote', { ...shipped.f, 'pub.alive': false }), 'skew',
      'the padded version is not an unshare at all');

    // AUTHOR SIDE — and it is refused twice over, by two independent barriers, before any peer
    // is involved. Both are recorded because a reader who removes one should find the other.
    await assert.rejects(
      () => moderate(C, { owner: C.mama.forStore.memberId, uuid: e.uuid },
        { pad: { 'pub.alive': false } }),
      (err) => err.name === 'RedactionError' && /RETRACTION/.test(err.message),
      'barrier 4: the retraction clause only fires for a patch `classifyUnsharePatch` reads as an '
      + 'unshare, so a padded one has no level to be sealed at');
    await assert.rejects(
      () => moderate(C, { owner: C.mama.forStore.memberId, uuid: e.uuid },
        { pad: { 'pub.alive': false }, seal: { levelOf: () => 'privat' } }),
      (err) => err.name === 'RedactionError' && /privat payload carries a value/.test(err.message),
      'and `assertNoContentAboveLevel`: a privat payload is nulls and nothing else (INV-R4)');

    // AND THE FOLD AGREES: `foldAuthorized` PARKS it. `authz.js:1209` states what that buys —
    // "a parked op is never folded, so an admin who pads an unshare with a content write
    // (`{...unsharePatch(kind), 'pub.text': 'gekapert'}`) still gets no write primitive".
    let padded = null;
    await on(C.papa, () => {
      const base = adminUnshareOp(C.papa.store._ctx(), {
        kind: 'fnote', owner: C.mama.forStore.memberId, uuid: e.uuid,
      });
      padded = { ...base, f: { ...base.f, 'pub.alive': false } };
    });
    let verdict = null;
    await on(C.oma, () => {
      const all = [...C.oma.store._log.ops({ includeParked: true }), padded];
      verdict = foldAuthorized(all, C.oma.store._authzCtx());
    });
    assert.ok(verdict.parked.some((o) => (o && o.id ? o.id : o) === padded.id),
      `the fold parks it (got ${JSON.stringify(verdict.parked).slice(0, 120)})`);
    assert.equal(registerValue(verdict.regs, e.key, 'pub.level'), 'geteilt',
      'and in the FOLD\'s register map nothing moved — which is the sentence §3b-b falsifies');
  });

  test('§3b-b · CLOSED · `applyRemote` reads the fold\'s PARK verdict and holds the op', async () => {
    // `store.applyRemote` used to read `verdict.rejected` and nothing else. `verdict.parked` —
    // the tri-state's whole middle — had no reader at that seam, so a `pub.set` the fold decided
    // to HOLD was appended to the log as a live op and folded by the log's plain LWW.
    //
    // ⚠ EVERY OTHER PARK REASON ALREADY SURVIVED. `future`, `unknown epoch`, `attestation`: those
    // come from `classifyOp`, which `applyRemote` calls itself (§3h is a parked `future` and it
    // really is held). `PARK_REASONS.UNSHARE_SHAPE` is parked ONLY inside `foldAuthorized` — it
    // is the one verdict in the product produced in a place the store did not read.
    //
    // ⚠ AND ITS FIRST VICTIM WAS NOT AN ATTACKER, IT WAS AN APP UPDATE. The tri-state exists for
    // version skew: "a future version that withdraws a field with a sentinel rather than with
    // `null` is PARKED: retained, not applied, re-evaluated after an app update. Version skew
    // then degrades to 'not yet unshared, and the log still knows why', never to 'silently not
    // unshared, and the op is gone'." It used to degrade to a THIRD thing the ADR did not
    // consider: APPLIED WHOLESALE, sentinel and all, by the build that could not read it.
    // ONE ENTRY PER PAD. The two halves must not be able to lean on each other: a parked line
    // that a later `unpark()` promotes is withheld from the register map by `store.registers()`
    // (`FOLD_ONLY_PARKS` is read there too, which is defence in depth), and this row is about the
    // GATE, so it is given nothing else to be right for.
    for (const pad of [{ 'pub.alive': false }, { 'pub.text': 'gekapert' }]) {
      const e = await mamaEntry(C, { text: 'Elternsprechtag', level: 'geteilt' });
      const before = await regsOf(C.oma, e.key);
      let op = null;
      await on(C.papa, () => {
        const base = adminUnshareOp(C.papa.store._ctx(), {
          kind: 'fnote', owner: C.mama.forStore.memberId, uuid: e.uuid,
        });
        op = { ...base, f: { ...base.f, ...pad } };
      });
      assert.equal(classifyUnsharePatch('fnote', op.f), 'skew', 'the fold parks this');
      await on(C.oma, () => {
        const r = C.oma.store.applyRemote([op]);
        assert.deepEqual(r.applied, [], 'NOT applied');
        assert.deepEqual(r.refused, [{ id: op.id, reason: 'unshareShape', parked: true }],
          'HELD, under the fold\'s own reason, and reported as held rather than as lost');
      });
      assert.ok((await parkedOn(C.oma)).includes('unshareShape'),
        'and it is in the parked set, so an app update WILL re-judge it (ADR 001 §7.4)');
      const after = await regsOf(C.oma, e.key);
      assert.deepEqual(after, before,
        `nothing of the padded patch reached the register map — not the pad ${JSON.stringify(pad)}, `
        + 'and not the unshare it was hiding behind');
      assert.equal(after['pub.level'], 'geteilt',
        'NON-VACUITY: the entry is still Geteilt, so the op really did carry a withdrawal that '
        + 'would have moved something had it been folded');
    }
  });

  test('§3c · FAILED · on an entry the admin cannot read: it moderates, and reads nothing', async () => {
    // A BELEGT entry is the sharp case: the admin can SEE that the day is taken (that is what
    // Belegt is for) and has the entity key, so 18.3 must work on it — but he has never been
    // shown the text, and the verb must not become a way to be shown it.
    const e = await mamaEntry(C, { text: 'Vorstellungsgespraech', level: 'belegt' });
    const before = await regsOf(C.papa, e.key);
    assert.equal(before['pub.level'], 'belegt');
    assert.equal(before['pub.text'] ?? null, null, 'he has never held the text');

    const { op } = await moderate(C, { owner: C.mama.forStore.memberId, uuid: e.uuid });
    assert.deepEqual(
      Object.entries(op.f).filter(([, v]) => v !== null).map(([k]) => k), ['pub.level'],
      'the op carries `pub.level: privat` and NOTHING but explicit nulls — no content, either way');
    await converge(C, [C.mama, C.oma, C.papa]);
    assert.equal((await regsOf(C.papa, e.key))['pub.text'] ?? null, null,
      'and moderating it taught him nothing: no register on his Mac gained a value');
    const all = JSON.stringify(await regsOf(C.papa, e.key)) + JSON.stringify(C.papa.store.state ?? {});
    assert.ok(!all.includes('Vorstellungsgespraech'));
  });

  test('§3d · FAILED · it is not an oracle: the result does not depend on the content', async () => {
    // If moderation behaved differently for an entry with text, one without, and one that was
    // never published at all, the admin could learn the difference. He cannot: all three produce
    // the same op shape, the same verdict and the same registers.
    const withText = await mamaEntry(C, { text: 'Etwas Langes und Privates', level: 'geteilt' });
    const empty = await mamaEntry(C, { text: 'x', level: 'geteilt' });
    const ghost = { uuid: newUuid(), key: familyKey('fnote', C.mama.forStore.memberId, newUuid()) };

    const shapes = [];
    for (const t of [withText, empty, ghost]) {
      const { op, res } = await moderate(C, { owner: C.mama.forStore.memberId, uuid: t.uuid });
      shapes.push({ fields: Object.keys(op.f).sort().join(','), status: res.status });
    }
    assert.equal(new Set(shapes.map((s) => JSON.stringify(s))).size, 1,
      'three different secrets, one indistinguishable observation');
    await converge(C, [C.papa]);
    // …and moderating an entity that was never published creates a governing register and no
    // content, so it is not a probe either: nothing comes back.
    const g = await regsOf(C.papa, familyKey('fnote', C.mama.forStore.memberId, ghost.uuid));
    assert.equal(g['pub.level'], 'privat');
    assert.equal(Object.entries(g).filter(([, v]) => v !== null && v !== 'privat').length, 0,
      'an unshare of nothing is a row of nulls — no existence oracle');
  });

  test('§3e · FAILED · replaying the moderation after the owner re-shares changes nothing', async () => {
    const e = await mamaEntry(C, { text: 'Weihnachtsmarkt', level: 'geteilt' });
    const { env } = await moderate(C, { owner: C.mama.forStore.memberId, uuid: e.uuid });
    await converge(C, [C.mama, C.oma]);
    assert.equal((await regsOf(C.oma, e.key))['pub.level'], 'privat');

    // The owner re-shares, deliberately and knowingly (ADR 004 §5's "was schon sichtbar war…").
    await on(C.mama, async () => {
      C.mama.store.txn('reshare', (tx) => { tx.note(e.uuid).set({ visibility: 'geteilt' }); });
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.oma]);
    assert.equal((await regsOf(C.oma, e.key))['pub.level'], 'geteilt', 'her re-share stands');

    // I re-POST the identical envelope. Same opId → the relay dedupes it, and even if it did not,
    // the stamp is older than her re-share and per-field LWW would refuse it.
    const again = await C.papa.transport.request('POST', '/api/v1/ops', {}, {
      space: C.spaceId, ackSeq: '0', ops: [env], drained: true,
    }, {});
    assert.equal(again.status, 200);
    assert.equal((again.json.accepted || []).length, 0, 'the relay recognised the replay');
    await converge(C, [C.oma, C.mama]);
    assert.equal((await regsOf(C.oma, e.key))['pub.level'], 'geteilt',
      'a replayed retraction cannot re-hide an entry the owner has since re-shared');
    await on(C.mama, () => {
      assert.equal(C.mama.store.registers().get(`note:${e.uuid}`).get('visibility').value, 'geteilt',
        'and the owner-side follow-up did NOT fire again — it reads the folded level, which is geteilt');
    });
  });

  test('§3f · NON-VACUITY · a fresh moderation after a re-share does work', async () => {
    const e = await mamaEntry(C, { text: 'Silvester', level: 'geteilt' });
    await moderate(C, { owner: C.mama.forStore.memberId, uuid: e.uuid });
    await converge(C, [C.mama, C.oma]);
    await on(C.mama, async () => {
      C.mama.store.txn('reshare', (tx) => { tx.note(e.uuid).set({ visibility: 'geteilt' }); });
      await C.mama.engine.syncNow();
    });
    await converge(C, [C.papa, C.oma]);
    await moderate(C, { owner: C.mama.forStore.memberId, uuid: e.uuid });
    await converge(C, [C.oma]);
    assert.equal((await regsOf(C.oma, e.key))['pub.level'], 'privat',
      'moderation is repeatable — §3e is about the REPLAY, not about the verb wearing out');
  });

  test('§3g · FAILED · a non-admin\'s unshare-shaped patch reaches nothing', async () => {
    const e = await mamaEntry(C, { text: 'Elternabend', level: 'geteilt' });
    let op = null;
    await on(C.oma, () => {
      op = adminUnshareOp(C.oma.store._ctx(), {
        kind: 'fnote', owner: C.mama.forStore.memberId, uuid: e.uuid,
      });
    });
    await on(C.oma, () => pushOp(C, C.oma, op, {
      levelOf: () => null, adminOf: () => C.oma.forStore.memberId, assertFamilyPatch: () => {},
    }));
    await converge(C, [C.papa, C.mama, C.oma]);
    for (const m of [C.papa, C.mama, C.oma]) {
      assert.equal((await regsOf(m, e.key))['pub.level'], 'geteilt',
        `${m.tag} folded a moderation from a member who does not hold the seat`);
    }
    assert.equal(op.f['pub.level'], 'privat',
      'NON-VACUITY: the op really was a well-formed unshare — only the SEAT was missing');
  });

  test('§3h · FAILED (parked, with a note) · a moderation stamped a year ahead is held, not applied', async () => {
    // `store._authzCtx()` supplies no `ctx.nowMs`, so `authz.js`'s +24 h clamp is off (attack row
    // B4c). The op is nonetheless refused — by `oplog.js`, which PARKS a stamp too far in the
    // future. That is a defence, and it is worth naming what kind: the op is HELD, not dropped,
    // so it will be re-judged and can still fire when the clock reaches it. A moderation that
    // takes effect a year later is not this file's finding, but it is the shape a reader should
    // know about before "parked" is read as "neutralised".
    const e = await mamaEntry(C, { text: 'Sommerurlaub', level: 'geteilt' });
    let far = '';
    await on(C.papa, () => {
      const now = C.papa.store._ctx().mint();
      const [ms, ctr, dev] = now.split('.');
      far = `${String(Number(ms) + 365 * 24 * 3600 * 1000).padStart(13, '0')}.${ctr}.${dev}`;
    });
    await moderate(C, { owner: C.mama.forStore.memberId, uuid: e.uuid }, { stamp: far });
    await converge(C, [C.oma, C.mama]);
    assert.equal((await regsOf(C.oma, e.key))['pub.level'], 'geteilt', 'nothing was folded');
    assert.ok((await parkedOn(C.oma)).includes('future'), 'it is parked as `future`');
    await on(C.mama, () => {
      assert.equal(C.mama.store.registers().get(`note:${e.uuid}`).get('visibility').value, 'geteilt',
        'and the owner-side follow-up did not fire on a moderation that was never applied');
    });
  });

  test('§3i · FAILED · 18.4 · the owner\'s ⌘Z cannot undo the admin\'s moderation', async () => {
    // The follow-up is APPENDED, not committed. If it were committed, Mama's next ⌘Z would undo
    // Papa's moderation of her own entry — an undo of something she never did, and a silent
    // re-share of content the admin withdrew.
    const e = await mamaEntry(C, { text: 'Zeugnisse', level: 'geteilt' });
    await moderate(C, { owner: C.mama.forStore.memberId, uuid: e.uuid });
    await converge(C, [C.mama]);
    await on(C.mama, () => {
      assert.equal(C.mama.store.registers().get(`note:${e.uuid}`).get('visibility').value, 'privat');
      // Her most recent OWN action is the entry's creation, and that is what ⌘Z must reach.
      const undone = C.mama.store.undo();
      assert.notEqual(undone, false, 'NON-VACUITY: she does have an undo stack');
      assert.equal(C.mama.store.registers().get(`note:${e.uuid}`).get('visibility').value, 'privat',
        'and it did not put the moderation back');
    });
  });
});

/** `store._ctx()` needs the Mac's own disk mounted. */
async function ctxOf(mac) {
  let c = null;
  await on(mac, () => { c = mac.store._ctx(); });
  return c;
}
