// ATTACK · THE PRIVACY ADVERSARY, 3 of 5 — "MY OWN DEVICES AND NOTHING ELSE".
//
// Stories 21.2 and 19.4: "my entire board, including private entries, syncs between MY devices
// only. No family key can ever apply." At M1 there is no family, which is exactly the moment the
// locks are least likely to be exercised and most likely to be written wrongly — so this file
// tries to get something out of the personal stream that does not belong there, and to get
// something into it that was never mine.
//
//   §1  OUTBOUND — can a settings value, a spine op, a peer's op or a family op be pushed?
//   §2  INBOUND — can a hostile relay land a foreign op on my board?
//   §3  THE CURSOR — can a cursor cross spaces?
//   §4  IMPORT AND RE-JOIN — does `replaceAll` publish the right thing to the right stream?
//   §5  THE POSITIVE CONTROL — a private entry really does reach my other Mac.
//   §6  THE SEAM THAT EATS AN OP — finding P-8. This is the important part of this file.
//
// SUCCEEDED / FAILED are from the adversary's point of view.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet, boardsAgree } from '../helpers/fleet.js';
import { recordWire, repoFile } from '../helpers/privacy-audit.js';
import { createPersonalSync, createPersonalPublisher, CURABLE_PARKS } from '../../src/js/sync/personal.js';
import { ENVELOPE_PARK } from '../../src/js/crypto/envelope.js';

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n0', date: '2027-03-04', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }],
  bars: [{ id: 'b0', startDate: '2027-07-01', endDate: '2027-07-14', label: 'Urlaub', categoryId: 'c1' }],
  categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: { '2027-03': 'Notizen' },
  settings: { locale: 'de' },
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 — OUTBOUND
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · trying to get something out of the personal stream that does not belong there', () => {
  test('FAILED — a personal engine cannot even be built against a family space', () => {
    // The refusal 21.2 turns on, at construction rather than at the first push: a personal engine
    // pointed at an `fsp_…` would push the whole private board into the family stream, and there
    // is no recovery from having done it once.
    for (const bad of ['fsp_AAAAAAAAAAAAAAAAAAAAAA', 'local', 'personal', '', null, undefined, 42]) {
      assert.throws(() => createPersonalSync({ spaceId: bad }), /psp_/, `spaceId ${JSON.stringify(bad)}`);
    }
  });

  test('FAILED — a settings value NEVER reaches the wire and NEVER reaches the other Mac', async () => {
    // Rule U6 / story 17.7: `pref.set` is a `local`-space op and settings are not synced. This is
    // the privacy reading of that rule rather than the merge reading: the settings map is where
    // `syncOrigin` lives, where the last-used category lives, and where any future preference
    // will live. It is the most likely place for something personal to leak by accident, because
    // nothing about a preference LOOKS like board content.
    const fleet = await createFleet({ board: BOARD() });
    const rec = recordWire(fleet.wire);
    try {
      await fleet.A.run(async () => {
        fleet.A.store.setSettings({ geheimePraeferenz: 'BLUTDRUCK-MEDIKAMENT-RAMIPRIL' });
      });
      await fleet.A.persist();
      await fleet.settle(2);
    } finally {
      rec.restore();
    }
    assert.equal(rec.bytes().includes('BLUTDRUCK'), false, 'a setting reached the wire');
    assert.equal(rec.bytes().includes('geheimePraeferenz'), false, 'a setting KEY reached the wire');
    assert.equal(fleet.B.store.state.settings.geheimePraeferenz, undefined,
      'a setting crossed to the other Mac');
    // And on the Mac that wrote it, it is still there — the filter is a transport rule, not a
    // reason to lose a preference.
    assert.equal(fleet.A.store.state.settings.geheimePraeferenz, 'BLUTDRUCK-MEDIKAMENT-RAMIPRIL');
  });

  test('FAILED — the outbox offers only MY ops, in MY space, unparked and unacknowledged', async () => {
    // The four filters, exercised together on a live store rather than read out of a comment.
    // The one that matters for 21.2 is `op.space === personalSpaceId`; the one that matters for
    // 21.1 is `op.dev === this._device`, because a peer's op in my outbox would be me re-uploading
    // somebody else's plaintext under my own signature.
    const fleet = await createFleet({ board: BOARD() });
    await fleet.A.apply('createNotePopover', { id: 'p1', date: '2027-05-06', text: 'meins', categoryId: 'c1' });
    await fleet.settle(2);
    await fleet.B.apply('createNotePopover', { id: 'p2', date: '2027-05-07', text: 'seins', categoryId: 'c1' });
    await fleet.settle(2);

    for (const dev of fleet.all) {
      const lines = dev.store.outbox({ limit: Infinity });
      assert.deepEqual(lines, [], `${dev.name} still owes ops after settling`);
      // Every line the LOG holds that is not mine must be invisible to the outbox even before it
      // is acknowledged, so force the question: unack everything and look again.
      const foreign = dev.store._log.lines().filter((l) => l.op && l.op.dev !== dev.deviceId);
      assert.ok(foreign.length > 0, `${dev.name} holds no peer ops at all — the check is vacuous`);
      for (const l of foreign) {
        assert.equal(dev.store.outbox().some((o) => o.op.id === l.op.id), false,
          `${dev.name} would re-upload a peer op`);
      }
    }
  });

  test('FAILED — nothing in the personal path can publish to a family stream, because there is no publisher for one', () => {
    // ADR 004 §3's publisher, at M1. `derivePublication()` returning `[]` is not a stub that
    // might one day forget a filter: there is no family space id, and `familySpaceId` is null.
    // The list that IS kept — retractions — is a list of things to UNSHARE, which is the safe
    // direction, and §4 below checks it survives an import.
    const pub = createPersonalPublisher();
    assert.equal(pub.familySpaceId, null);
    assert.deepEqual(pub.derivePublication(), []);
    assert.deepEqual(pub.drain(), []);
    // `askToReshare` records a QUESTION and never an action — story 16.5.
    pub.askToReshare([{ key: 'fnote:x' }]);
    assert.deepEqual(pub.drain(), [], 'a reshare question became a publication');
    assert.equal(pub.pendingReshares.length, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 — INBOUND
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · a hostile relay tries to land a foreign op on my board', () => {
  test('FAILED — all four foreign space classes are refused by applyRemote, each by name', async () => {
    // The store's own gate, ahead of the fold. The interesting one is `local`: a relay that could
    // land a `pref.set` would be writing the victim's SETTINGS — including `syncOrigin`, which is
    // where every future request goes. That is not a merge bug, it is a redirection primitive,
    // and it is refused by name.
    const fleet = await createFleet({ board: BOARD() });
    await fleet.settle(1);
    const B = fleet.B.store;
    const mine = fleet.A.store._log.lines().find((l) => l.op && l.op.k === 'note.set');
    assert.ok(mine, 'no note op in the log to re-address');

    const outcomes = [];
    await fleet.B.run(async () => {
      for (const [label, space] of [
        ['family', 'fsp_AAAAAAAAAAAAAAAAAAAAAA'],
        ['local', 'local'],
        ['another personal space', 'psp_ZZZZZZZZZZZZZZZZZZZZZZ'],
        ['the placeholder', 'personal'],
      ]) {
        const forged = { ...mine.op, space, id: `${'A'.repeat(21)}${outcomes.length}` };
        const r = B.applyRemote([forged], { seqs: { [forged.id]: '1' } });
        outcomes.push(`${label}: ${JSON.stringify(r.refused.map((x) => x.reason))}`);
      }
    });
    assert.deepEqual(outcomes, [
      'family: ["shape"]',
      'local: ["localSpace"]',
      'another personal space: ["foreignSpace"]',
      'the placeholder: ["foreignSpace"]',
    ]);
    // `shape` for the family case is `validateOp`: `core/ops.js` will not let a `note.set` EXIST
    // in a family space, so the direction "my private note appears in the family stream" is
    // refused by the op type system before any transport rule is consulted. That is the strongest
    // of the four locks and it is the one nobody has to remember.
  });

  test('FAILED — a foreign envelope never opens: the AAD binds `sp`, so it dies at the signature', async () => {
    // The crypto lock, driven through the shipped engine rather than through `openOp` directly.
    // A relay that re-labels an envelope from one space to another — the single move that would
    // turn a family op into a personal one — changes the AAD and so breaks the signature before
    // one plaintext byte exists.
    const fleet = await createFleet({ board: BOARD() });
    await fleet.A.apply('createNotePopover', { id: 'p1', date: '2027-05-06', text: 'privat', categoryId: 'c1' });
    await fleet.settle(1);

    const rnd = (n) => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(n))).toString('base64url');
    const foreign = {
      v: 1, sp: `fsp_${rnd(16)}`, ep: 1, dv: fleet.A.short, oid: rnd(16), wit: '',
      iv: rnd(12), ct: rnd(528), sig: rnd(64), seq: '99', chain: rnd(32),
    };
    fleet.wire.hostile.onResponse = (res, req, who) => {
      if (req.method !== 'GET' || req.path !== '/api/v1/ops' || who !== fleet.B.short) return res;
      if (res.status !== 200 || !Array.isArray(res.body.ops)) return res;
      return { ...res, body: { ...res.body, ops: [...res.body.ops, foreign], nextCursor: '99' } };
    };
    await fleet.B.pull();
    fleet.wire.honest();

    const q = fleet.B.quarantined();
    assert.equal(q.length, 1);
    assert.match(q[0].reason, /P3 failed/, 'the foreign envelope was not caught at the signature');
    assert.deepEqual(fleet.B.store.state.notes.map((n) => n.text).sort(), ['Zahnarzt', 'privat']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE CURSOR
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · can a cursor cross spaces?', () => {
  test('SUCCEEDED — `store.noteCursor` accepts ANY space id, `local` and a family space included', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-9 · LOW today, MEDIUM the day a family space exists · ADR 003 §3.3 · ADR 006 §9.1.
    //
    // `noteCursor(space, seq)`'s docblock says "there is exactly one way to move a cursor", and
    // that is true — but the one way accepts any space id at all. Its only guard is that A
    // personal space exists; the argument itself is passed straight to `oplog.setCursor`, which
    // stores it, and it rides into `checkpoint().cursors` and onto disk.
    //
    // At M1 nothing exploits it: `sync/personal.js` is the only caller and it always passes its
    // own `spaceId`. It matters later for two reasons. First, the day WP-6's family engine
    // exists, two engines share one store and one `cursors` map, and a mixed-up argument is a
    // family cursor advanced by a personal pull — which silently SKIPS family ops, the failure
    // ADR 006 §9.1's W1 is written to prevent. Second, `'local'` is accepted, and the local
    // space is by definition never pulled, so a cursor for it is meaningless state persisted for
    // ever.
    //
    // The fix is one line — refuse a space that is neither this store's personal space nor a
    // registered family space — and it belongs to `store.js`.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const fleet = await createFleet({ board: BOARD() });
    await fleet.settle(1);
    await fleet.A.run(async () => {
      const s = fleet.A.store;
      assert.equal(s.noteCursor('fsp_BBBBBBBBBBBBBBBBBBBBBB', '9'), true, 'close finding P-9');
      assert.equal(s.noteCursor('local', '9'), true);
      assert.equal(s.noteCursor('psp_ZZZZZZZZZZZZZZZZZZZZZZ', '9'), true);
      assert.equal(s.cursor('fsp_BBBBBBBBBBBBBBBBBBBBBB'), '9');
      assert.deepEqual(s.warnings.slice(-3), [], 'not even a warning was raised');
      // …and it is persisted, which is what makes it state rather than a transient mistake.
      const cursors = s._log.checkpoint().cursors;
      assert.deepEqual(
        Object.keys(cursors).filter((k) => k !== fleet.spaceId).sort(),
        ['fsp_BBBBBBBBBBBBBBBBBBBBBB', 'local', 'psp_ZZZZZZZZZZZZZZZZZZZZZZ'],
        'three cursors for three spaces this store does not and cannot sync',
      );
    });

    // The engine itself is disciplined — the reason this is LOW and not HIGH.
    const src = repoFile('src/js/sync/personal.js')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const calls = src.match(/noteCursor\([^)]*\)/g) || [];
    assert.deepEqual(calls, ['noteCursor(spaceId, String(commit)'],
      'the engine now moves a cursor for something other than its own space');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 — IMPORT AND RE-JOIN
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · an import replaces the board — what does it publish?', () => {
  test('FAILED — `replaceAll` goes through the plan, hands the retractions on, and pushes nothing foreign', async () => {
    // The WP-3 obligation, read as a privacy question rather than as a correctness one: an import
    // tombstones entries the family could see, and the retraction list is the ONLY record that
    // they must be withdrawn. Dropping it leaves an entry live on the other device (story 16.5) —
    // i.e. content the user believes they deleted, still visible. At M1 the list is empty and
    // that is precisely when it is most likely to be thrown away.
    const fleet = await createFleet({ board: BOARD() });
    await fleet.settle(1);
    const rec = recordWire(fleet.wire);
    try {
      await fleet.A.replaceAll({
        schemaVersion: 1,
        notes: [{ id: 'i1', date: '2027-08-08', text: 'importiert', categoryId: 'c1', repeatsYearly: false }],
        bars: [], categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
        scratchpads: {}, settings: { locale: 'de' },
      });
      await fleet.settle(3);
    } finally {
      rec.restore();
    }

    // The publisher exists and was consulted — `pendingRetractions` is a real array, reachable
    // from diagnostics, and not a value that vanished at the seam.
    const diag = fleet.A.storeDiagnostics();
    assert.ok(diag.sync, 'the store reports no sync diagnostics');
    assert.ok(Array.isArray(fleet.A.publisher.pendingRetractions));

    // Nothing addressed to anything but the one personal space left this Mac.
    const pushes = rec.calls.filter((c) => c.method === 'POST' && c.body && Array.isArray(c.body.ops));
    assert.ok(pushes.length > 0, 'the import pushed nothing at all');
    for (const p of pushes) {
      assert.equal(p.body.space, fleet.spaceId);
      for (const env of p.body.ops) assert.equal(env.sp, fleet.spaceId, 'an envelope named another space');
    }
    // And the import really did travel, so the row is not green because nothing happened.
    assert.deepEqual(fleet.B.store.state.notes.map((n) => n.text), ['importiert']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE POSITIVE CONTROL
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 · the promise has a positive half, and it must be true too', () => {
  test('FAILED — the whole private board, including a `privat` entry, converges on both Macs', async () => {
    // 21.2 is not only "and nothing else"; it is "my ENTIRE board, including private entries".
    // Without this row every other row in this file could be satisfied by a client that syncs
    // nothing at all.
    const fleet = await createFleet({ board: BOARD() });
    await fleet.A.apply('createNotePobover', {}).catch(() => {});   // a typo'd mutation is a no-op
    await fleet.A.apply('createNotePopover', {
      id: 'privat1', date: '2027-05-06', text: 'Blutdruck-Check Praxis Sonnenberg', categoryId: 'c1',
    });
    await fleet.B.apply('padBlur', { month: '2027-05', text: 'Rezept abholen' });
    await fleet.settle(3);
    const agree = boardsAgree(fleet.all);
    assert.equal(agree.equal, true, `the two Macs disagree on: ${agree.detail}`);
    assert.ok(fleet.B.store.state.notes.some((n) => n.text === 'Blutdruck-Check Praxis Sonnenberg'));
    assert.equal(fleet.A.state.scratchpads['2027-05'], 'Rezept abholen');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6 — THE SEAM THAT EATS AN OP. THIS IS THE FINDING.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§6 · what happens to an op that arrives before the thing that would let it be read', () => {
  test('SUCCEEDED — an op parked by openOp is DESTROYED, not deferred: F-6 is open at this seam', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-8 · CRITICAL · story 19.6 / 21.2 / finding F-6 · `src/js/sync/personal.js`.
    //
    // THE BUG, in two lines. `openOp` reports a park as
    //
    //     { status: 'park', parkReason: 'attestation'|'epoch'|'version'|…, reason: '<a sentence>' }
    //
    // and `pullNow` reads it as
    //
    //     if (out && out.parked) {
    //       if (CURABLE_PARKS.includes(out.reason)) defer(item, out.reason);
    //
    // `out.parked` is never set — the field is `out.status` — so the whole branch is DEAD CODE.
    // Every parked envelope falls through to the next guard, which finds no `op.id`, and is sent
    // to `terminal()`: quarantined, reported as "openOp returned no op", and the cursor is
    // released past it. The second mistake is inside the dead branch and would defeat it even if
    // it ran: `CURABLE_PARKS` holds the enum values, and `out.reason` is the human sentence, so
    // `includes()` could never match. `out.parkReason` is the field it meant.
    //
    // WHAT IT COSTS. This is not a corner: it is the first contact between two Macs, which is
    // the whole of M1.
    //
    //   · P1 ATTESTATION — an op from my other Mac arriving before that Mac's attestation has
    //     been learned. `family/mount.js` even warns "its ops will park" when the roster has no
    //     `kexPubRaw` yet. They do not park. They are destroyed.
    //   · P4 EPOCH — an op sealed under a key epoch this device has not fetched. ADR 002 §4.4's
    //     whole design for a device offline across a rotation is "hold the cursor, fetch the
    //     key, re-read". Instead every op of the new epoch is lost on the first pull.
    //   · VERSION — an op from a newer build, which should be re-read after an update.
    //
    // AND IT IS SILENT. Measured below: after the attestation arrives, the note is still absent;
    // after a relaunch the quarantine — which lives only in the engine's memory — is EMPTY, the
    // indicator says `healthy`, the cursor is past the op so it is never re-pulled, and the two
    // Macs are permanently, invisibly different. A user sees a note on the desktop that does not
    // exist on the laptop, with no error anywhere and nothing to click.
    //
    // The fix is two words (`out.status === 'park'`, `out.parkReason`) and it is `personal.js`'s.
    // The reason it is CRITICAL rather than HIGH is the silence: `store._warn` fires once, into a
    // warnings array, with a sentence that says "nothing here was changed" — which is true, and
    // is the opposite of what the user needs to be told.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const fleet = await createFleet({ board: BOARD() });
    await fleet.settle(1);

    // F-6's exact scenario: A writes; B has not yet learned A's attestation.
    const attestation = fleet.attestations.get(fleet.A.short);
    assert.ok(attestation, 'the fleet holds no attestation to withhold');
    fleet.attestations.delete(fleet.A.short);

    await fleet.A.apply('createNotePopover', {
      id: 'erstkontakt', date: '2027-05-06', text: 'vom anderen Mac', categoryId: 'c1',
    });
    await fleet.A.push();
    const pulled = await fleet.B.pull();

    // (1) It was NOT deferred, which is what F-6 says must happen.
    assert.equal(pulled.deferred, 0, 'if this is 1, P-8 is fixed — the park branch runs');
    assert.deepEqual(fleet.B.deferredOps(), []);

    // (2) It was quarantined, with a reason that names no park at all.
    const q = fleet.B.quarantined();
    assert.equal(q.length, 1);
    assert.equal(q[0].reason, 'openOp returned no op',
      'the reason changed — re-read P-8 before adjusting this string');

    // (3) The cursor was RELEASED past it, so the op will never be offered again.
    assert.equal(fleet.B.cursor(), q[0].seq, 'the cursor is past the op it could not read');

    // (4) The cure arrives — and cures nothing.
    fleet.attestations.set(fleet.A.short, attestation);
    await fleet.B.catchUp(6);
    assert.deepEqual(fleet.B.store.state.notes.map((n) => n.text).sort(), ['Zahnarzt'],
      'if "vom anderen Mac" appears here, P-8 is fixed');

    // (5) A relaunch clears the only trace, and the app then calls itself healthy.
    await fleet.B.relaunch();
    await fleet.B.catchUp(6);
    assert.deepEqual(fleet.B.quarantined(), [], 'the quarantine survived a relaunch');
    assert.equal(fleet.B.status().state, 'healthy', 'the indicator is not silent — good news');
    assert.deepEqual(fleet.B.store.state.notes.map((n) => n.text).sort(), ['Zahnarzt']);

    // (6) …while Mac A still has it. Two Macs, permanently different, both reporting healthy.
    assert.deepEqual(fleet.A.store.state.notes.map((n) => n.text).sort(),
      ['Zahnarzt', 'vom anderen Mac']);
    const agree = boardsAgree(fleet.all);
    assert.equal(agree.equal, false, 'the boards agree — P-8 is fixed, invert this row');
  });

  test('SUCCEEDED — the two lines, read out of the source, so the finding cannot be argued about', () => {
    // The behavioural row above is the proof; this is the diagnosis, pinned so that a fix is
    // visible as a change here and not only as a change in a fleet outcome.
    const src = repoFile('src/js/sync/personal.js');
    assert.match(src, /if \(out && out\.parked\) \{/,
      'the park branch changed — re-verify P-8');
    assert.match(src, /if \(CURABLE_PARKS\.includes\(out\.reason\)\) defer\(item, out\.reason\);/);

    // What `openOp` actually returns, from its own module, so the mismatch is stated in both
    // directions rather than inferred.
    const env = repoFile('src/js/crypto/envelope.js');
    assert.match(env, /const out = \{ status: 'park', parkReason, reason \};/);
    assert.equal(/\bparked:\s*true/.test(env), false, 'openOp now sets `parked` — close P-8');

    // And the two constants the dead branch compares against are enum values, never sentences.
    assert.deepEqual([...CURABLE_PARKS], [ENVELOPE_PARK.ATTESTATION, ENVELOPE_PARK.EPOCH]);
    assert.deepEqual([...CURABLE_PARKS], ['attestation', 'epoch']);
  });
});
