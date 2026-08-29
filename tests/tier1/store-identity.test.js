// TIER 1 · LZP-501 — DURABLE DEVICE IDENTITY, AND THE CONVERGENCE IT UNBLOCKS.
// Finding **A3-H4** (HIGH, "two Macs over one board cannot converge at all") · ADR 002 §2.2,
// §2.3, §2.4, §5.2.0 · ADR 001 §4.0 · story 15.1 / Principle 7 · milestone M1 "Zwei Macs".
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ROW THIS FILE IS ABOUT, AND THE TRAP IT COMES WITH
// ─────────────────────────────────────────────────────────────────────────────
//
//   > A3-H4 — Two Macs over one board **cannot converge at all**: stamps and opIds agree exactly
//   > as ADR 001 §8.1 promises, but `_me` is ephemeral per process, so each refuses the other's
//   > ops with `notMyAct`. … **Any fleet test that mints its ops with the receiving store's own
//   > `_me` is a false green.**
//
// So this file is written against that last sentence. Everything below uses TWO REAL KEY STORES
// and TWO REAL P-256 DEVICE KEY PAIRS, minted independently; the ops one store applies are ops
// the OTHER store authored, through its own `apply()`, with its own clock and its own device
// short. Nothing is hand-built to be acceptable, and §2's mutants exist to prove the gate would
// notice if it were.
//
// WHAT "TWO IDENTITIES" MEANS AT M1, precisely: one **member** (one person) with two **devices**.
// `foldAuthorized`'s personal-space gate is `op.act === me` AND `op.dev ∈ ctx.myDevices`
// (ADR 001 §4.0), so the shared `memberId` is what pairing exists to deliver and the differing
// `deviceId`/`deviceShort` are what `myDevices` exists to admit. Both halves are asserted.
//
// AND THE OTHER HALF OF THE PROMISE (story 15.1, Principle 7, ADR 002 §2.4): §4 asserts that a
// solo store generates no key, runs no probe, touches no key store and cannot even REACH the
// generator. That is not a footnote to the convergence work — it is the constraint that shaped
// it, and it is why the identity is injected rather than fetched.

import '../helpers/env.js';
import test, { describe, before, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { resetStorage, seedBoard } from '../helpers/env.js';
import { pathToPrefix, staticPathToPrefix } from '../helpers/importgraph.js';

import { memKeyStore } from '../../src/js/platform/keystore.js';
import {
  openDeviceIdentity, selfAttest, buildAttestOpen, deviceSetFor, readMemberId,
  IdentityUnavailableError,
} from '../../src/js/platform/device-identity.js';
import { exportRawPublic, deviceShortOf } from '../../src/js/crypto/identity.js';
import { memberSet, noteSet } from '../../src/js/core/ops.js';
import { opId as newOpId, groupId as newGid, spaceId as mkSpaceId } from '../../src/js/core/ids.js';
import { parse as parseStamp } from '../../src/js/core/stamp.js';

const DAY = '2026-08-29';
const MEM = { allowMemoryCustody: true };   // tier 1 has no IndexedDB (keystore.js rule 7)

/** A board both Macs open. One note, so one field can be contested and watched. */
const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n0', date: '2026-03-04', text: 'Termin 0', categoryId: 'c1', repeatsYearly: false }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', colorRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const quiet = (s) => clearTimeout(s._saveTimer);

/**
 * ONE PERSON, TWO MACS — built the way ADR 002 §6.3 builds it, not the way a test would.
 *
 *   · Mac A mints the member: a recovery pair (`RK_sig`, the thing that says "I am this member")
 *     plus its own non-extractable device pair.
 *   · Mac B is PAIRED IN: it is handed the memberId and `RK_sig`, and mints its OWN device pair.
 *     `withRecoveryKey: false` is what makes that literal — B's key store never generates a
 *     second recovery identity, because a second one would be a second person.
 *   · Each Mac SELF-ATTESTS. Not a convenience: FINDINGS §4.5 option (a) only enters a `dev.*`
 *     register into `attestationOf` when the op that wrote it was stamped by the device it
 *     attests, so an attestation written for B by A is a claim B cannot back.
 */
async function twoMacs() {
  const ksA = memKeyStore();
  const ksB = memKeyStore();
  const A = await openDeviceIdentity(ksA, { today: DAY, ...MEM });
  const memberId = A.forStore.memberId;
  const B = await openDeviceIdentity(ksB, { today: DAY, memberId, withRecoveryKey: false, ...MEM });

  const recSigPriv = A.recovery.recSig.privateKey;
  const attA = await selfAttest(ksA, A.forStore, recSigPriv, { createdAt: DAY });
  const attB = await selfAttest(ksB, B.forStore, recSigPriv, { createdAt: DAY });

  const recoveryPubSigRaw = await exportRawPublic(A.recovery.recSig.publicKey);
  const attestOpen = await buildAttestOpen([
    { memberId, recoveryPubSigRaw, blobs: [attA.blob, attB.blob] },
  ]);

  return { ksA, ksB, A, B, memberId, attA, attB, attestOpen, recoveryPubSigRaw, recSigPriv };
}

/**
 * A second and third evaluation of `store.js` — the closest thing tier 1 has to a second Mac —
 * and ONE pair of identities for the whole file.
 *
 * The identities are minted once, deliberately: `useIdentity` refuses to re-point a store at a
 * second member (§5), which is the correct rule and is also exactly what a fleet is. Re-minting
 * per test would be modelling two Macs that forget who they are between edits.
 */
let storeA = null;
let storeB = null;
let MACS = null;
before(async () => {
  storeA = (await import('../../src/js/store.js?identity-mac-a')).store;
  storeB = (await import('../../src/js/store.js?identity-mac-b')).store;
  MACS = await twoMacs();
});
afterEach(() => { if (storeA) quiet(storeA); if (storeB) quiet(storeB); });
after(() => { if (storeA) quiet(storeA); if (storeB) quiet(storeB); });

/** A store nobody else in this file holds — for the cases that need an identity-free launch. */
async function freshStore(tag) {
  const s = (await import(`../../src/js/store.js?identity-${tag}`)).store;
  quiet(s);
  s.listeners.clear();
  s.undoStack.length = 0;
  s.redoStack.length = 0;
  s.snapshots.length = 0;
  s._lastSnapshotDay = null;
  s.ready = false;
  s.warnings.length = 0;
  return s;
}

/** Boot both stores over the same seeded board, each already carrying its durable identity. */
async function fleet(opts = {}) {
  const macs = MACS;
  resetStorage();
  seedBoard(BOARD());
  for (const [store, id, peer] of [[storeA, macs.A, macs.B], [storeB, macs.B, macs.A]]) {
    quiet(store);
    store.listeners.clear();
    store.undoStack.length = 0;
    store.redoStack.length = 0;
    store.snapshots.length = 0;
    store._lastSnapshotDay = null;
    store.ready = false;
    store.useIdentity({
      ...id.forStore,
      peerDeviceIds: opts.noPeers ? [] : [peer.forStore.deviceId],
      attestOpen: macs.attestOpen,
    });
    await store.init();
    quiet(store);
    store.warnings.length = 0;
  }
  return macs;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. THE INVERSION OF A3-H4 — two Macs converge
// ═════════════════════════════════════════════════════════════════════════════

describe('A3-H4 INVERTED — two durable identities over one board converge', () => {
  test('Mac B accepts Mac A\'s op, and Mac A accepts Mac B\'s', async () => {
    // R3-41 measures the defect: with ephemeral identity, B refuses A's op `notMyAct` and the
    // board never moves. Same shape, durable identity, opposite outcome — and the ops are the
    // real ones A's own `apply()` minted, never re-authored for the receiver.
    const macs = await fleet();
    assert.notEqual(storeA._device, storeB._device, 'two DEVICES, or the test proves nothing');
    assert.equal(storeA._me, storeB._me, 'one MEMBER — this is one person with two Macs');

    storeA.apply('editNotePopover', { id: 'n0', text: 'von Mac A' });
    quiet(storeA);
    const fromA = storeA._log.ops().filter((o) => o.k === 'note.set' && o.f.text === 'von Mac A');
    assert.equal(fromA.length, 1, 'Mac A authored exactly one op');
    assert.equal(fromA[0].dev, macs.A.forStore.deviceId, 'and it is stamped by MAC A, not by the receiver');

    storeB.applyRemote(fromA);
    quiet(storeB);
    assert.equal(storeB.state.notes.find((n) => n.id === 'n0').text, 'von Mac A',
      'CONVERGED: the op A wrote is the text B draws');
    assert.deepEqual(storeB.warnings, [], 'and nothing was refused on the way in');

    // …and back the other way, so this is not an accident of who booted first.
    storeB.apply('editNotePopover', { id: 'n0', text: 'von Mac B' });
    quiet(storeB);
    const fromB = storeB._log.ops().filter((o) => o.k === 'note.set' && o.f.text === 'von Mac B');
    storeA.applyRemote(fromB);
    quiet(storeA);
    assert.equal(storeA.state.notes.find((n) => n.id === 'n0').text, 'von Mac B');
    assert.deepEqual(storeA.warnings, []);
  });

  test('after the exchange both Macs project the same board', async () => {
    // Convergence is not "the op was accepted", it is "the two boards agree". A three-op exchange
    // in both directions, then equality of the whole v1 projection.
    await fleet();
    storeA.apply('editNotePopover', { id: 'n0', text: 'A schreibt' });
    storeA.apply('createNotePopover', { id: 'nA', date: '2026-04-01', text: 'nur bei A', categoryId: 'c1' });
    quiet(storeA);
    storeB.apply('createNotePopover', { id: 'nB', date: '2026-05-01', text: 'nur bei B', categoryId: 'c1' });
    quiet(storeB);

    // `.space !== 'local'` added by LZP-502 when F-7 was closed: a `pref.set` is a LOCAL-space op
    // and settings are never synced (ADR 001 §3.3, story 17.7), so `applyRemote` now refuses one
    // by name instead of silently admitting it. The migration emits one, so the unfiltered set
    // below was handing this door an op no sync engine could ever transmit — `store.outbox()`
    // filters the same three classes on the way OUT. The convergence claim is unchanged.
    const mine = (s) => s._log.ops().filter((o) => o.dev === s._device && o.space !== 'local');
    const opsA = mine(storeA);
    const opsB = mine(storeB);
    storeB.applyRemote(opsA);
    storeA.applyRemote(opsB);
    quiet(storeA); quiet(storeB);

    const ids = (s) => s.state.notes.map((n) => n.id).sort();
    assert.deepEqual(ids(storeA), ['n0', 'nA', 'nB'], 'A has both Macs\' notes');
    assert.deepEqual(ids(storeB), ['n0', 'nA', 'nB'], 'and so does B');
    assert.equal(storeA.state.notes.find((n) => n.id === 'n0').text, 'A schreibt');
    assert.equal(storeB.state.notes.find((n) => n.id === 'n0').text, 'A schreibt');
    assert.deepEqual(storeA.state.notes, storeB.state.notes, 'the two boards are the same board');
    assert.deepEqual(storeA.warnings, []);
    assert.deepEqual(storeB.warnings, []);
  });

  test('a last-writer-wins contest is decided by the stamp, and both Macs decide it the same way', async () => {
    // The point of a durable device short: it is the HLC tiebreak (ADR 001 §1.2), so two Macs
    // that write the same field in the same millisecond still agree on who won — on both Macs.
    await fleet();
    storeA.apply('editNotePopover', { id: 'n0', text: 'A zuerst' });
    quiet(storeA);
    storeB.apply('editNotePopover', { id: 'n0', text: 'B danach' });
    quiet(storeB);
    const opA = storeA._log.ops().find((o) => o.f.text === 'A zuerst');
    const opB = storeB._log.ops().find((o) => o.f.text === 'B danach');

    storeA.applyRemote([opB]);
    storeB.applyRemote([opA]);
    quiet(storeA); quiet(storeB);
    const winner = opA.ts > opB.ts ? 'A zuerst' : 'B danach';
    assert.equal(storeA.state.notes[0].text, winner);
    assert.equal(storeB.state.notes[0].text, winner, 'both Macs picked the SAME winner');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. `ctx.myDevices` IS SUPPLIED — and the mutants that prove it is load-bearing
// ═════════════════════════════════════════════════════════════════════════════

describe('ADR 001 §4.0 — the local device set is supplied, not defaulted', () => {
  test('an op from a device NOT in my set is refused `notMyDevice`, even under my own memberId', async () => {
    // THE MUTANT FOR §1. If `myDevices` were still absent, this op — right `act`, unknown `dev`
    // — would be admitted, and §1's green would be proving only that `act === me` works. It is
    // also the check itself: a device nobody paired, claiming to be one of mine, is exactly what
    // §4.0's device set exists to refuse.
    await fleet({ noPeers: true });
    assert.equal(storeA._identity !== null, true);

    storeB.apply('editNotePopover', { id: 'n0', text: 'von einem fremden Gerät' });
    quiet(storeB);
    const fromB = storeB._log.ops().filter((o) => o.f.text === 'von einem fremden Gerät');
    assert.equal(fromB[0].act, storeA._me, 'the op claims MY member …');
    assert.notEqual(fromB[0].dev, storeA._device, '… from a device that is not mine');

    storeA.applyRemote(fromB);
    quiet(storeA);
    assert.equal(storeA.state.notes[0].text, 'Termin 0', 'the board did not move');
    assert.ok(storeA.warnings.some((w) => /notMyDevice/.test(w)),
      `refused by name; warnings were: ${storeA.warnings.join(' | ')}`);
  });

  test('the same op IS admitted once pairing has put that device in the set', async () => {
    // The non-vacuity control for the mutant above: one input, two device sets, two outcomes.
    await fleet();
    storeB.apply('editNotePopover', { id: 'n0', text: 'vom gekoppelten Mac' });
    quiet(storeB);
    const fromB = storeB._log.ops().filter((o) => o.f.text === 'vom gekoppelten Mac');
    storeA.applyRemote(fromB);
    quiet(storeA);
    assert.equal(storeA.state.notes[0].text, 'vom gekoppelten Mac');
    assert.deepEqual(storeA.warnings, []);
  });

  test('the set is ALSO derived from the log: a self-attestation in the batch admits its own author', async () => {
    // A3-H4 item (3): "once identity is durable, (3) is *derived* (`attestationOf` filtered by
    // `memberId`), needs no new plumbing". This is that half, and it is why `applyRemote` folds
    // twice: the `dev.*` register that makes B's device known arrives IN THE SAME BATCH as the
    // content op it authorises, which is exactly what a newly paired Mac's first pull looks like
    // (ADR 002 §6.3). Note `noPeers: true` — pairing told this store NOTHING.
    const macs = await fleet({ noPeers: true });
    const FSP = mkSpaceId('family');
    const attOp = memberSet(
      {
        act: storeB._me, dev: storeB._device, gid: newGid(), mint: () => storeB._clock.tick(),
        newOpId, newGid, familySpaceId: FSP,
      },
      storeB._me,
      macs.attB.field
    );
    assert.equal(parseStamp(attOp.ts).dev, macs.B.forStore.deviceShort,
      'the attestation must be stamped by the device it attests — FINDINGS §4.5 option (a)');

    storeB.apply('editNotePopover', { id: 'n0', text: 'erste Berührung' });
    quiet(storeB);
    const content = storeB._log.ops().filter((o) => o.f.text === 'erste Berührung');

    storeA.applyRemote([...content, attOp]);
    quiet(storeA);
    assert.equal(storeA.state.notes[0].text, 'erste Berührung',
      'the attestation in the batch is what admitted the content op beside it');
    assert.equal(storeA.warnings.some((w) => /notMyDevice/.test(w)), false,
      `nothing was refused: ${storeA.warnings.join(' | ')}`);
  });

  test('an attestation that does not verify under the member\'s recovery key admits nothing', async () => {
    // Fail closed. The blob is B's real, RK-signed attestation; the store is simply given no way
    // to verify it (`attestOpen: null` — solo mode's state, and the state of any store whose
    // verifier has not been built). `authz.js` then treats every `dev.*` register as
    // BAD_ATTESTATION, so the derived half of the set contributes nothing and the content op
    // falls back to the pairing-derived half, which is empty here.
    const macs = MACS;
    const blind = await freshStore('no-verifier');
    resetStorage();
    seedBoard(BOARD());
    blind.useIdentity({ ...macs.A.forStore, peerDeviceIds: [], attestOpen: null });
    await blind.init();
    quiet(blind);
    blind.warnings.length = 0;

    const FSP = mkSpaceId('family');
    const ctx = {
      act: blind._me, dev: macs.B.forStore.deviceId, gid: newGid(),
      mint: () => blind._clock.tick(), newOpId, newGid, familySpaceId: FSP,
      space: 'personal',
    };
    const attOp = memberSet(ctx, blind._me, macs.attB.field);
    const noteOp = noteSet(ctx, 'n0', { text: 'geschmuggelt' });

    blind.applyRemote([attOp, noteOp]);
    quiet(blind);
    assert.equal(blind.state.notes[0].text, 'Termin 0', 'nothing was smuggled in');
    assert.ok(blind.warnings.some((w) => /notMyDevice|badAttestation/.test(w)),
      `refused, by name: ${blind.warnings.join(' | ')}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. DURABILITY — the property the word "durable" is doing all the work for
// ═════════════════════════════════════════════════════════════════════════════

describe('the identity survives a relaunch, and the deviceShort is the signing key', () => {
  test('re-opening the same key store returns the same three values', async () => {
    // A relaunch, at the only fidelity tier 1 can offer: the KEY STORE is the thing that persists
    // (keystore.js rule 7 — Node has no IndexedDB, so tier 2 owns the on-disk claim), and this
    // asserts the identity is a function of it and not of the process.
    const ks = memKeyStore();
    const first = await openDeviceIdentity(ks, { today: DAY, ...MEM });
    const second = await openDeviceIdentity(ks, { today: DAY, ...MEM });
    assert.deepEqual(second.forStore, first.forStore, 'a second launch found the identity it minted');
    assert.equal(first.minted, true);
    assert.equal(second.minted, false, 'and knew it had not minted it');
    assert.equal(await readMemberId(ks), first.forStore.memberId);

    const other = await openDeviceIdentity(memKeyStore(), { today: DAY, ...MEM });
    assert.notEqual(other.forStore.memberId, first.forStore.memberId, 'a DIFFERENT Mac is a different identity');
    assert.notEqual(other.forStore.deviceShort, first.forStore.deviceShort);
  });

  test('deviceShort is crock32(SHA-256(rawSigPub)[0..10]) and nothing else (ADR 002 §5.2.0)', async () => {
    const ks = memKeyStore();
    const id = await openDeviceIdentity(ks, { today: DAY, ...MEM });
    const raw = await exportRawPublic(id.identity.devSig.publicKey);
    assert.equal(id.forStore.deviceShort, deviceShortOf(raw),
      'the short must be a function of the SIGNING KEY, or it cannot survive anything');
    assert.match(id.forStore.deviceShort, /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/);
  });

  test('every stamp the store mints afterwards carries that short — ADR 002 §5.2.2 check 4', async () => {
    // `devOf(op.ts) === env.dv` is what makes "an op stamped with S was signed by S's key" true,
    // and FINDINGS §4.5 records that check 4 "may not be weakened, made optional, or moved". It
    // is only true if the store's CLOCK is built on the durable short, which is what this asserts.
    const macs = await fleet();
    storeA.apply('editNotePopover', { id: 'n0', text: 'gestempelt' });
    quiet(storeA);
    const op = storeA._log.ops().find((o) => o.f.text === 'gestempelt');
    assert.equal(parseStamp(op.ts).dev, macs.A.forStore.deviceShort);
    assert.equal(op.dev, macs.A.forStore.deviceId, 'and op.dev is the durable deviceId');
    assert.equal(op.act, macs.A.forStore.memberId);
  });

  test('the clock does not walk backwards when the identity is adopted', async () => {
    // `useIdentity` rebuilds the clock on the new short. Restarting it at zero would mint stamps
    // below ops the same session already appended — a merge that loses to its own past.
    const late = await freshStore('late-adopt');
    resetStorage();
    seedBoard(BOARD());
    await late.init();
    quiet(late);
    late.apply('editNotePopover', { id: 'n0', text: 'vorher' });
    quiet(late);
    const before = late._clock.peek();

    late.useIdentity({ ...MACS.A.forStore });
    const after = late._clock.peek();
    assert.ok(after.slice(0, 20) >= before.slice(0, 20), `the clock went backwards: ${before} -> ${after}`);
    assert.equal(after.slice(-16), MACS.A.forStore.deviceShort, 'and it is now the durable short');
    assert.ok(late.warnings.some((w) => /adopted after the board had already loaded/.test(w)),
      'and a post-init adoption says so rather than pretending the spine was re-derived');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. SOLO MODE GENERATES NOTHING (story 15.1 · Principle 7 · ADR 002 §2.4)
// ═════════════════════════════════════════════════════════════════════════════

describe('solo mode mints no key, runs no probe, and cannot reach the generator', () => {
  test('a store that was never given an identity has none, and says so', async () => {
    const solo = await freshStore('solo');
    resetStorage();
    seedBoard(BOARD());
    await solo.init();
    quiet(solo);
    assert.equal(solo.hasDurableIdentity(), false);
    const d = solo.diagnostics();
    assert.equal(d.identity.durable, false, 'the honest answer, and the one that explains a silent sync');
    assert.equal(d.identity.canVerifyAttestations, false);
    assert.deepEqual(d.identity.peerDevices, []);
    assert.match(d.identity.deviceShort, /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/,
      'it still HAS a short — a random one, per launch, exactly as ADR 002 §2.4 describes');
    solo.apply('editNotePopover', { id: 'n0', text: 'allein' });
    quiet(solo);
    assert.equal(solo.state.notes[0].text, 'allein', 'and the app works, which is the whole point');
  });

  test('store.js cannot reach src/js/crypto/ — not statically, not dynamically', () => {
    // The guarantee `tests/tier1/crypto-identity.test.js` states for the boot graph, restated for
    // the file this work package changed. It is the reason `useIdentity()` takes three strings
    // and two closures instead of a `KeyStore`: crypto is INJECTED at the family opt-in moment,
    // by `src/js/platform/device-identity.js`, which nothing in the boot graph imports.
    // `store.js` is held to the STRONGER form — neither statically nor dynamically — because it
    // is not a boot entry point but a leaf: nothing about it needs a door. The three boot
    // entries are held to the static form, for the reason E5 recorded in
    // `tests/tier1/network-scope.test.js` §2: ADR 002 §2.4's own "key generation happens at the
    // family opt-in moment" requires ONE dynamic door, and hiding it from the walker would be
    // worse than counting it.
    for (const chain of [pathToPrefix('src/js/store.js', 'src/js/crypto/'),
                         pathToPrefix('src/js/store.js', 'src/js/platform/device-identity.js')]) {
      assert.equal(chain, null, chain ? `store.js reaches crypto: ${chain.join(' -> ')}` : '');
    }
    for (const entry of ['src/js/boot.js', 'src/js/firstrun.js', 'src/js/main.js']) {
      const chain = staticPathToPrefix(entry, 'src/js/crypto/');
      assert.equal(chain, null, chain ? `${entry} statically reaches crypto: ${chain.join(' -> ')}` : '');
      const dev = staticPathToPrefix(entry, 'src/js/platform/device-identity.js');
      assert.equal(dev, null, dev ? `${entry} statically reaches device-identity: ${dev.join(' -> ')}` : '');
    }
    // and the walker really can find one, so the greens above mean something
    assert.ok(pathToPrefix('src/js/platform/device-identity.js', 'src/js/crypto/'),
      'device-identity.js is supposed to be the module that DOES reach crypto');
  });

  test('memory custody is refused for a real pairing — an identity that will not survive a quit', async () => {
    // `chooseKeyStore` reports `kind` precisely so this refusal can exist. A device attested
    // against a memory store leaves the member a write-once `dev.*` register for a ghost.
    await assert.rejects(
      () => openDeviceIdentity(memKeyStore(), { today: DAY, custody: 'memory' }),
      (e) => e instanceof IdentityUnavailableError
    );
    assert.ok(await openDeviceIdentity(memKeyStore(), { today: DAY, custody: 'memory', ...MEM }),
      'and the test-only escape hatch is explicit, never the default');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. `useIdentity` refuses what it cannot mean
// ═════════════════════════════════════════════════════════════════════════════

describe('the seam is loud about a half-formed identity', () => {
  let s;
  beforeEach(async () => {
    s = (await import(`../../src/js/store.js?identity-guard-${Math.random().toString(36).slice(2)}`)).store;
  });

  test('a bad memberId, deviceId or deviceShort is a throw, never a silent ephemeral store', () => {
    const good = { memberId: 'mem_' + 'A'.repeat(22), deviceId: 'dev_' + 'B'.repeat(22), deviceShort: 'A'.repeat(16) };
    assert.throws(() => s.useIdentity(null), TypeError);
    assert.throws(() => s.useIdentity({ ...good, memberId: 'nope' }), /memberId must be a MemberId/);
    assert.throws(() => s.useIdentity({ ...good, deviceId: 'mem_x' }), /deviceId must be a DeviceId/);
    assert.throws(() => s.useIdentity({ ...good, deviceShort: 'lowercase16chrs!' }), /deviceShort must be/);
    assert.throws(() => s.useIdentity({ ...good, peerDeviceIds: ['not-a-device'] }), /peerDeviceIds/);
    assert.throws(() => s.useIdentity({ ...good, attestOpen: 'nope' }), /attestOpen/);
    assert.equal(s.hasDurableIdentity(), false, 'and none of that half-adopted an identity');
  });

  test('an identity is never re-pointed at a second member', () => {
    const a = { memberId: 'mem_' + 'A'.repeat(22), deviceId: 'dev_' + 'B'.repeat(22), deviceShort: 'A'.repeat(16) };
    assert.deepEqual(s.useIdentity(a), a);
    assert.deepEqual(s.useIdentity(a), a, 'idempotent for the SAME identity');
    assert.throws(() => s.useIdentity({ ...a, memberId: 'mem_' + 'C'.repeat(22) }),
      /already runs as/, 'the same discipline ensureDeviceIdentity applies to a half-written key store');
    assert.equal(s._me, a.memberId, 'and the refusal changed nothing');
  });

  test('deviceSetFor reads only MY member\'s row and drops revoked devices', () => {
    const rows = [
      { memberId: 'mem_me', devices: [{ deviceId: 'dev_mine' }, { deviceId: 'dev_two' }, { deviceId: 'dev_old', revokedAt: '2026-01-01' }] },
      { memberId: 'mem_mama', devices: [{ deviceId: 'dev_hers' }] },
    ];
    assert.deepEqual(deviceSetFor('mem_me', 'dev_mine', rows), ['dev_two'],
      'not mine-and-hers, not the revoked one, and not myself');
    assert.deepEqual(deviceSetFor('mem_me', 'dev_mine', []), []);
  });
});
