// TIER 1 · LZP-502 — THE PERSONAL SPACE: MY TWO MACS, MY WHOLE PRIVATE BOARD.
// Milestone M1 "Zwei Macs" · stories 19.4, 21.2, 19.1, 16.5, 17.7 · ADR 003 §3/§8 · ADR 006 §9 ·
// ADR 002 §5/§6 · ADR 001 §3.3/§4/§7 · findings F-6, F-7, and the WP-3 obligation.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT THIS SUITE REFUSES TO DO, AND WHY THAT IS THE WHOLE POINT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Finding A3-H4 ends with a sentence that is a specification for this file:
//
//   > **Any fleet test that mints its ops with the receiving store's own `_me` is a false green.**
//
// So nothing here is hand-built to be acceptable. There are TWO key stores, TWO independently
// generated P-256 device key pairs and ONE member (M1 is one person with two Macs). The ops one
// Mac applies are ops the OTHER Mac's own `apply()` minted, sealed with the OTHER Mac's own
// signing key, pushed through the REAL `server/core/router.js` with a REAL `Authorization`
// signature built by `src/js/platform/net.js`, verified by the REAL `server/core/auth.js`, stored
// as opaque bytes by the REAL memory adapter, and pulled back and opened with the REAL `openOp`.
// Nothing is stubbed between `store.txn()` on one Mac and `store.state` on the other except the
// socket.
//
// The three false greens this file was written to avoid, each with the assertion that prevents it:
//
//   1. **the receiver authors the ops** → §1 asserts `op.dev` is the SENDER's deviceId and that
//      the two devices differ, before anything is applied;
//   2. **the relay is not really in the path** → §1 asserts the relay holds ciphertext it cannot
//      read (the plaintext of a note never appears in the adapter's bytes), and every request in
//      the file goes through `matchRoute` + `authenticate`;
//   3. **the crypto is not really in the path** → §6 replays a FAMILY envelope at the personal
//      door and asserts it never opens, and §1 asserts the seal fails when the key ring is empty
//      rather than falling back to anything.

import '../helpers/env.js';
import test, { describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { localStorage as LS, resetStorage, seedBoard } from '../helpers/env.js';

import { memKeyStore } from '../../src/js/platform/keystore.js';
import { openDeviceIdentity, selfAttest } from '../../src/js/platform/device-identity.js';
import { exportRawPublic } from '../../src/js/crypto/identity.js';
import { createKeyRing, createSpaceKey } from '../../src/js/crypto/spacekeys.js';
import { sealOp } from '../../src/js/crypto/envelope.js';
import { buildRequest } from '../../src/js/platform/net.js';
import { spaceId as mkSpaceId, opId as newOpId, groupId as newGid } from '../../src/js/core/ids.js';
import { prefSet, noteSet } from '../../src/js/core/ops.js';

// THE RELAY COMES THROUGH THE HELPER, NOT THROUGH `server/` DIRECTLY.
// `tests/tier1/suite-integrity.test.js` allows a tier-1 test file to import only `node:`,
// `../../src/js/…` or a helper. `server/` is real code — nothing here is a stand-in — but it is
// not `src/js/`, and `tests/helpers/loopback.js` is the door `server.contract.js §3` names for
// exactly this: the real handlers, the real router, the real ADR 003 §2 ladder, no sockets.
import { createRelay, simClock, SERVER_LIMITS } from '../helpers/loopback.js';

import {
  createPersonalSync, createPersonalPublisher, LIMITS, CADENCE,
  CURABLE_PARKS, CURABLE_REFUSALS, isCurable, PersonalSyncError,
  PARK_HANDLING, parkHandlingOf,
} from '../../src/js/sync/personal.js';
import { ENVELOPE_PARK } from '../../src/js/crypto/envelope.js';

const DAY = '2026-08-29';
const MEM = { allowMemoryCustody: true };
const ORIGIN = 'https://relay.invalid';
const S = globalThis.crypto.subtle;

/** The board both Macs open. One note, so one field can be contested and watched. */
const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n0', date: '2026-03-04', text: 'Termin 0', categoryId: 'c1', repeatsYearly: false }],
  bars: [],
  categories: [{ id: 'c1', name: 'Familie', colorRef: 'gruen', visible: true }],
  scratchpads: {},
  settings: null,
});

const quiet = (s) => clearTimeout(s._saveTimer);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §0.1  TWO MACS' DISKS IN ONE PROCESS
//
// `storage.js` reads a module-level `localStorage`, so two evaluations of `store.js` share one
// disk. A fleet test that ignored that would have Mac B's `init()` reading Mac A's `board.json`
// — which is not two Macs, it is one Mac with two names, and it would make every relaunch
// assertion in §2/§3/§8 meaningless. So each Mac carries its own disk image and it is swapped in
// around every call that touches storage.
// ─────────────────────────────────────────────────────────────────────────────────────────────

function snapDisk() {
  const o = {};
  for (const k of LS._keys()) o[k] = LS.getItem(k);
  return o;
}
function restoreDisk(image) {
  LS.clear();
  for (const k of Object.keys(image || {})) LS.setItem(k, image[k]);
}
/** Run `fn` with `mac`'s disk mounted, and capture whatever it wrote back onto that disk. */
async function on(mac, fn) {
  restoreDisk(mac.disk);
  try {
    return await fn();
  } finally {
    quiet(mac.store);
    mac.disk = snapDisk();
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §0.2  THE RELAY — the real handlers, the real router, the real auth ladder
// ─────────────────────────────────────────────────────────────────────────────────────────────

function makeRelay() {
  const r = createRelay({ clock: simClock(Date.UTC(2026, 7, 29, 9, 0, 0)) });
  return {
    store: r.store,
    ctx: r.ctx,
    route: r.route,
    tick(ms) { r.clock.advance(ms); },
    async handle(sreq) {
      // `dispatch` already turns a throw into the shaped body `errors.js` builds; this only
      // normalises the header bag, because a handler may legitimately answer without one.
      const res = await r.dispatch(sreq);
      return { status: res.status, headers: res.headers || {}, body: res.body };
    },
  };
}

/**
 * The client's Transport port bound straight to the relay's own router — no sockets, and every
 * byte the shipping client would have put on the wire.
 *
 * It is built on `src/js/platform/net.js`'s own `buildRequest`, which is the shared half of both
 * shipping transports: the `Authorization` header, the canonical query, the exact body bytes and
 * the SHA-256 the signature covers are therefore all produced by the shipping client, and
 * `server/core/auth.js` verifies them with the shipping verifier. A mistake in either is a red
 * test here rather than a 401 in Frankfurt.
 */
function loopbackTransport(relay, cfg) {
  return {
    origin: ORIGIN,
    async request(method, path, query, body, headers) {
      const req = await buildRequest(cfg, method, path, query, body, headers);
      const url = new URL(req.url);
      const q = {};
      for (const [k, v] of url.searchParams) q[k] = v;
      const h = {};
      for (const k of Object.keys(req.headers)) h[k.toLowerCase()] = String(req.headers[k]);
      h['x-real-ip'] = '127.0.0.1';
      const res = await relay.handle({
        method: req.method,
        path: url.pathname,
        query: q,
        headers: h,
        body: body ?? null,
        rawBody: req.rawBody,
        clientIp: '127.0.0.1',
      });
      return { status: res.status, headers: res.headers, json: res.body };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §0.3  ONE PERSON, TWO MACS, ONE PERSONAL SPACE
// ─────────────────────────────────────────────────────────────────────────────────────────────

let FLEET = null;

/**
 * Built the way ADR 002 §6.3 builds it: Mac A mints the member (recovery pair + its own
 * non-extractable device pair); Mac B is PAIRED IN — handed the memberId and `RK_sig`, minting
 * its OWN device pair with `withRecoveryKey: false`, because a second recovery identity would be
 * a second person. Each Mac SELF-ATTESTS (FINDINGS §4.5 option (a)).
 *
 * The PSK is drawn once and handed to both rings, which is exactly what pairing step 7 delivers.
 */
async function buildFleet() {
  const ksA = memKeyStore();
  const ksB = memKeyStore();
  const A = await openDeviceIdentity(ksA, { today: DAY, ...MEM });
  const memberId = A.forStore.memberId;
  const B = await openDeviceIdentity(ksB, { today: DAY, memberId, withRecoveryKey: false, ...MEM });

  const recSigPriv = A.recovery.recSig.privateKey;
  const attA = await selfAttest(ksA, A.forStore, recSigPriv, { createdAt: DAY });
  const attB = await selfAttest(ksB, B.forStore, recSigPriv, { createdAt: DAY });

  const spaceId = mkSpaceId('personal');
  const psk = await createSpaceKey();
  const ringA = createKeyRing();
  const ringB = createKeyRing();
  ringA.put(spaceId, 1, psk);
  ringB.put(spaceId, 1, psk);

  // `openOp`'s P1, keyed by deviceShort ALONE. At M1 both attestations come from PAIRING —
  // see §5 of this file for why they cannot come from the log or from the relay.
  const byShort = new Map([
    [attA.attestation.deviceShort, attA.attestation],
    [attB.attestation.deviceShort, attB.attestation],
  ]);
  const attestationOf = (dv) => byShort.get(dv) ?? null;

  const storeA = (await import('../../src/js/store.js?sync-mac-a')).store;
  const storeB = (await import('../../src/js/store.js?sync-mac-b')).store;

  return {
    memberId, spaceId, psk, attestationOf, byShort, recSigPriv,
    A: { id: A, ks: ksA, att: attA, ring: ringA, store: storeA, disk: {} },
    B: { id: B, ks: ksB, att: attB, ring: ringB, store: storeB, disk: {} },
  };
}

/** Register the space and both devices on the relay, exactly as `POST /spaces` + `POST /devices`
 *  would leave it. Space creation is LZP-501/E3's ticket; what this file drives is `/ops`. */
async function seedRelay(relay, F) {
  const raw = async (kp) => exportRawPublic(kp.publicKey);
  const recPubSig = await raw(F.A.id.recovery.recSig.publicKey ? { publicKey: F.A.id.recovery.recSig.publicKey } : F.A.id.recovery.recSig);
  const recPubKex = await raw(F.A.id.recovery.recKex);
  await relay.store.tx(async (tx) => {
    await tx.createSpace({
      id: F.spaceId, kind: 'PERSONAL', currentEpoch: 1, nextSeq: 0n, headChain: null,
      createdAt: new Date(relay.ctx.now()),
    });
    await tx.claimEpoch(F.spaceId, 1);
    await tx.addMember({
      id: F.memberId, spaceId: F.spaceId, colorRef: 'gruen',
      recoveryPubSig: recPubSig, recoveryPubKex: recPubKex,
      joinedAt: new Date(relay.ctx.now()), removedAt: null,
    });
    for (const m of [F.A, F.B]) {
      await tx.addDevice({
        id: m.id.forStore.deviceId,
        spaceId: F.spaceId,
        memberId: F.memberId,
        deviceShort: m.id.forStore.deviceShort,
        sigPubRaw: await raw(m.id.identity.devSig),
        kexPubRaw: await raw(m.id.identity.devKex),
        attestation: new TextEncoder().encode(m.att.blob),
        lastSeenSeq: 0n, lastPushedSeq: 0n,
        addedAt: new Date(relay.ctx.now()), revokedAt: null,
      });
    }
  });
}

/** Boot one Mac over a freshly seeded board, with identity and space adopted BEFORE `init()`. */
async function bootMac(mac, F, { board = BOARD(), peers = true } = {}) {
  mac.disk = {};
  await on(mac, async () => {
    resetStorage();
    if (board) seedBoard(board);
    const s = mac.store;
    s.listeners.clear();
    s.undoStack.length = 0;
    s.redoStack.length = 0;
    s.snapshots.length = 0;
    s._lastSnapshotDay = null;
    s.ready = false;
    s.warnings.length = 0;
    const peer = mac === F.A ? F.B : F.A;
    if (!s.hasDurableIdentity()) {
      s.useIdentity({ ...mac.id.forStore, peerDeviceIds: [] });
    }
    // `useIdentity` refuses to re-point a store at a second member, so a store reused across
    // describe blocks keeps its identity — and would keep the PAIRING it was given, which would
    // make §4's first-contact state unreachable. The device set is therefore set explicitly on
    // every boot, which is also the honest model: pairing is a fact about this Mac's disk.
    s._peerDevices = new Set(peers ? [peer.id.forStore.deviceId] : []);
    if (s.personalSpaceId() === null) s.usePersonalSpace(F.spaceId);
    await s.init();
    s.warnings.length = 0;
  });
}

/** Re-`init()` the same store over the disk it left behind — a relaunch. */
async function relaunch(mac) {
  await on(mac, async () => {
    mac.store.ready = false;
    await mac.store.init();
  });
}

/** The engine for one Mac, over the shared relay. */
function engineFor(mac, F, relay, extra = {}) {
  const cfg = {
    origin: ORIGIN,
    deviceShort: mac.id.forStore.deviceShort,
    sign: mac.id.sign,
    clientVersion: '2.0.0',
    now: () => relay.ctx.now(),
    random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
    subtle: S,
  };
  return createPersonalSync({
    store: mac.store,
    transport: loopbackTransport(relay, cfg),
    keyring: mac.ring,
    sigPriv: mac.id.identity.devSig.privateKey,
    spaceId: F.spaceId,
    deviceShort: mac.id.forStore.deviceShort,
    attestationOf: F.attestationOf,
    attestation: mac.att.attestation,
    now: () => relay.ctx.now(),
    ...extra,
  });
}

before(async () => { FLEET = await buildFleet(); });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1  M1 — TWO MACS, ONE PRIVATE BOARD, THROUGH A RELAY THAT CAN READ NOTHING
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 M1 "Zwei Macs" — the whole private board syncs end to end', () => {
  let relay;
  let F;
  let eA;
  let eB;

  beforeEach(async () => {
    F = FLEET;
    relay = makeRelay();
    await seedRelay(relay, F);
    await bootMac(F.A, F);
    await bootMac(F.B, F);
    eA = engineFor(F.A, F, relay);
    eB = engineFor(F.B, F, relay);
  });

  test('an edit on Mac A appears on Mac B — and Mac B never authored it', async () => {
    await on(F.A, () => { F.A.store.apply('editNotePopover', { id: 'n0', text: 'von Mac A' }); });

    // The op is MAC A's. Asserted before it moves, because this is the assertion A3-H4's closing
    // sentence demands and everything after it is worthless without it.
    const authored = F.A.store._log.ops().find((o) => o.k === 'note.set' && o.f.text === 'von Mac A');
    assert.equal(authored.dev, F.A.id.forStore.deviceId, 'authored by Mac A');
    assert.notEqual(F.A.id.forStore.deviceId, F.B.id.forStore.deviceId, 'two DEVICES, or this proves nothing');
    assert.equal(F.A.store._me, F.B.store._me, 'one MEMBER — one person, two Macs');

    await on(F.A, () => eA.pushNow());
    await on(F.B, () => eB.pullNow());

    assert.equal(F.B.store.state.notes.find((n) => n.id === 'n0').text, 'von Mac A',
      'CONVERGED through the relay');
    assert.deepEqual(F.B.store.warnings, [], 'and nothing was refused on the way in');
  });

  test('…and back the other way, so it is not an accident of who pushed first', async () => {
    await on(F.A, () => { F.A.store.apply('editNotePopover', { id: 'n0', text: 'A' }); });
    await on(F.A, () => eA.pushNow());
    await on(F.B, () => eB.pullNow());
    await on(F.B, () => { F.B.store.apply('createNotePopover', { id: 'nB', date: '2026-05-01', text: 'nur bei B', categoryId: 'c1' }); });
    await on(F.B, () => eB.pushNow());
    await on(F.A, () => eA.pullNow());

    const ids = (s) => s.state.notes.map((n) => n.id).sort();
    assert.deepEqual(ids(F.A.store), ['n0', 'nB']);
    assert.deepEqual(ids(F.B.store), ['n0', 'nB']);
    assert.deepEqual(F.A.store.state.notes, F.B.store.state.notes, 'the two boards are the same board');
  });

  test('a PRIVATE entry syncs too — 19.4 is "my whole board", not "the shareable part of it"', async () => {
    await on(F.A, () => {
      F.A.store.apply('createNotePopover', { id: 'geheim', date: '2026-06-06', text: 'Arzttermin', categoryId: 'c1' });
    });
    await on(F.A, () => eA.pushNow());
    await on(F.B, () => eB.pullNow());
    assert.equal(F.B.store.state.notes.find((n) => n.id === 'geheim').text, 'Arzttermin');
  });

  test('THE RELAY IS BLIND — the note text is nowhere in the bytes it stored (21.1)', async () => {
    await on(F.A, () => { F.A.store.apply('editNotePopover', { id: 'n0', text: 'Zahnarzt Mittwoch' }); });
    await on(F.A, () => eA.pushNow());
    const page = await relay.store.listOps(F.spaceId, 0n, 500);
    assert.ok(page.ops.length > 0, 'the relay stored something');
    const all = page.ops.map((o) => Buffer.from(o.envelope).toString('latin1')).join('');
    assert.equal(all.includes('Zahnarzt'), false, 'the plaintext is not in the stored envelope');
    assert.equal(all.includes('n0'), false, 'nor is the entity id');
    // …and there is no authoring time column at all (ADR 003 §5.1's deliberate omission).
    assert.equal('ts' in page.ops[0], false);
  });

  test('an empty key ring is a REFUSAL, never a plaintext push', async () => {
    const naked = engineFor(F.A, F, relay, { keyring: createKeyRing() });
    await on(F.A, () => { F.A.store.apply('editNotePopover', { id: 'n0', text: 'nie' }); });
    await on(F.A, () => naked.pushNow());
    const page = await relay.store.listOps(F.spaceId, 0n, 500);
    assert.equal(page.ops.length, 0, 'nothing reached the relay');
    assert.equal(naked.quarantined().length > 0, true, 'and the refusal is visible, not silent');
    assert.match(naked.quarantined()[0].reason, /key ring holds no key/);
  });

  test('the signature the client builds is the one the relay verifies — a bad key is a 401', async () => {
    // Mac A signing with Mac B's key. `authenticate` looks the device up by the SHORT in the
    // header and verifies against the stored public key, so this is the whole §2 ladder.
    const wrong = engineFor(F.A, F, relay);
    const bad = createPersonalSync({
      store: F.A.store,
      transport: loopbackTransport(relay, {
        origin: ORIGIN,
        deviceShort: F.A.id.forStore.deviceShort,
        sign: F.B.id.sign,                                  // ← the wrong half
        clientVersion: '2.0.0',
        now: () => relay.ctx.now(),
        random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
        subtle: S,
      }),
      keyring: F.A.ring,
      sigPriv: F.A.id.identity.devSig.privateKey,
      spaceId: F.spaceId,
      deviceShort: F.A.id.forStore.deviceShort,
      attestationOf: F.attestationOf,
      now: () => relay.ctx.now(),
    });
    await on(F.A, () => { F.A.store.apply('editNotePopover', { id: 'n0', text: 'gefälscht' }); });
    await on(F.A, () => bad.pushNow());
    assert.equal((await relay.store.listOps(F.spaceId, 0n, 500)).ops.length, 0);
    assert.equal(bad.diagnostics().lastError.status, 401);
    assert.equal(wrong.status().state, 'pending', 'the outbox still holds it — nothing was lost');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2  THE OUTBOX (ADR 003 §8.1) — DERIVED FROM THE LOG, NOT A SECOND QUEUE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the outbox is a projection of the log', () => {
  let relay;
  let F;
  let eA;

  beforeEach(async () => {
    F = FLEET;
    relay = makeRelay();
    await seedRelay(relay, F);
    await bootMac(F.A, F);
    eA = engineFor(F.A, F, relay);
  });

  test('EVERY local door fills it — txn, apply, mutate, undo, redo and replaceAll alike', async () => {
    // The reason the outbox is derived and not a publish hook: there is no call site to forget.
    // Six doors, six op sources, one filter. A hook added at `_commit` alone would miss four.
    const seen = new Set();
    await on(F.A, async () => {
      const s = F.A.store;
      await eA.pushNow();                                     // drain the spine first
      const before = s.outboxSize();
      assert.equal(before, 0, 'the migrated board has been pushed');

      s.apply('editNotePopover', { id: 'n0', text: 'apply' });
      seen.add(s.outboxSize() > 0 && 'apply');
      await eA.pushNow();

      s.mutate('mutate', (st) => { st.notes[0].text = 'mutate'; });
      seen.add(s.outboxSize() > 0 && 'mutate');
      await eA.pushNow();

      s.txn('txn', (tx) => tx.note('n0').set({ text: 'txn' }));
      seen.add(s.outboxSize() > 0 && 'txn');
      await eA.pushNow();

      s.undo();
      seen.add(s.outboxSize() > 0 && 'undo');
      await eA.pushNow();

      s.redo();
      seen.add(s.outboxSize() > 0 && 'redo');
      await eA.pushNow();

      s.replaceAll({ ...BOARD(), notes: [{ id: 'nR', date: '2026-07-07', text: 'import', categoryId: 'c1', repeatsYearly: false }] });
      seen.add(s.outboxSize() > 0 && 'replaceAll');
    });
    assert.deepEqual([...seen].sort(), ['apply', 'mutate', 'redo', 'replaceAll', 'txn', 'undo']);
  });

  test('attach() — a committed transaction arms a DEBOUNCED push, and never seals inside emit()', async () => {
    // ADR 001 §0.9 and `store.js` header note 2: `txn → apply → project → emit` is strictly
    // synchronous, because `interact.js:317` asks the DOM for the freshly created bar's label
    // element the instant the call returns. An `await` above `emit()` silently breaks bar-label
    // editing — so the subscriber may do NOTHING but arm a timer.
    const timers = [];
    const eDeb = engineFor(F.A, F, relay, {
      schedule: (ms, fn) => { timers.push({ ms, fn }); return timers.length - 1; },
      unschedule: (h) => { if (timers[h]) timers[h] = { ms: 0, fn: () => {} }; },
    });
    eDeb.attach();
    await on(F.A, () => eDeb.pushNow());                     // drain
    let sealedDuringEmit = false;
    await on(F.A, () => {
      const before = eDeb.diagnostics().sealedCached;
      F.A.store.apply('editNotePopover', { id: 'n0', text: 'getippt' });
      sealedDuringEmit = eDeb.diagnostics().sealedCached !== before;
    });
    assert.equal(sealedDuringEmit, false, 'nothing was sealed synchronously inside the transaction');
    assert.equal(timers.length, 1, 'one timer was armed …');
    assert.equal(timers[0].ms, CADENCE.pushDebounceMs, '… at ADR 003 §8.2\'s 2 s debounce');

    // Three edits in a row arm ONE push, not three (that is what "debounce" has to mean).
    await on(F.A, () => {
      F.A.store.apply('editNotePopover', { id: 'n0', text: 'a' });
      F.A.store.apply('editNotePopover', { id: 'n0', text: 'b' });
    });
    // `unschedule` cancels the previous one, so however many edits land there is exactly ONE
    // live timer. Three edits, one push — that is what "debounce" has to mean, and the failure it
    // prevents is three signed requests for one keystroke run.
    const live = timers.filter((t) => t.ms === CADENCE.pushDebounceMs).length;
    assert.equal(live, 1, 'each edit RE-arms the same slot rather than adding one …');
    await on(F.A, async () => { timers[timers.length - 1].fn(); await eDeb.pushNow(); });
    assert.equal(F.A.store.outboxSize(), 0, '… and the one that fires drains everything');

    // A REMOTE fold is not a trigger: it is this engine's own pull coming back round, and a push
    // armed by it would make two Macs ping-pong a timer at each other for ever.
    const armed = timers.length;
    await on(F.A, () => { F.A.store.emit('remote'); });
    assert.equal(timers.length, armed, "'remote' arms nothing");
    eDeb.detach();
    await on(F.A, () => { F.A.store.apply('editNotePopover', { id: 'n0', text: 'nach detach' }); });
    assert.equal(timers.length, armed, 'and detach() really unsubscribes');
  });

  test('a PEER\'s op is never in my outbox — it could not be sealed and the relay would 403 it', async () => {
    // `POST /ops` refuses `e.dv !== auth.deviceShort` with `device_mismatch`, and `sealOp` cannot
    // even build the envelope (§5.2.2 check 4 compares `devOf(op.ts)` to my own short). Without
    // this filter one peer op that arrived without a seq wedges the outbox permanently.
    const eB = engineFor(F.B, F, relay);
    await bootMac(F.B, F);
    await on(F.B, () => { F.B.store.apply('editNotePopover', { id: 'n0', text: 'von B' }); });
    await on(F.B, () => eB.pushNow());
    await on(F.A, () => eA.pushNow());
    await on(F.A, () => eA.pullNow());
    await on(F.A, () => {
      for (const line of F.A.store.outbox()) {
        assert.equal(line.op.dev, F.A.id.forStore.deviceId, 'only my own ops are offered');
      }
    });
  });

  test('a pulled op carries its SEQ into the log, so it is never pushed back (the ping-pong)', async () => {
    const eB = engineFor(F.B, F, relay);
    await bootMac(F.B, F);
    await on(F.A, () => eA.pushNow());                       // A's spine is already up
    await on(F.B, () => { F.B.store.apply('editNotePopover', { id: 'n0', text: 'B schreibt' }); });
    await on(F.B, () => eB.pushNow());
    await on(F.A, () => eA.pullNow());

    const pulled = F.A.store._log.lines().find((l) => l.op.f && l.op.f.text === 'B schreibt');
    assert.notEqual(pulled.seq, null, 'the pulled op carries the server seq …');
    await on(F.A, () => {
      assert.equal(F.A.store.outbox().some((l) => l.op.id === pulled.op.id), false,
        '… so it is not in my outbox, and the ping-pong cannot start');
    });
    const before = (await relay.store.listOps(F.spaceId, 0n, 500)).ops.length;
    await on(F.A, () => eA.pushNow());
    assert.equal((await relay.store.listOps(F.spaceId, 0n, 500)).ops.length, before,
      'and a push right after a pull uploads nothing at all');
  });

  test('an ack SURVIVES A RELAUNCH — otherwise every launch republishes the world', async () => {
    await on(F.A, async () => {
      await eA.pushNow();
      await F.A.store.persistNow();
      assert.equal(F.A.store.outboxSize(), 0, 'drained');
    });
    await relaunch(F.A);
    await on(F.A, () => {
      assert.equal(F.A.store.outboxSize(), 0,
        'REGRESSION GUARD (R5-4 shape): a relaunch that re-offered the whole board would push it '
        + 'again on every launch for ever');
    });
  });

  test('a crash between push and ack costs ONE duplicate push and never a lost op', async () => {
    // The ack is dropped on the floor; the SAME engine offers the op again; the server reports it
    // in `duplicate` with its EXISTING seq and returns 200 (§3.1). At-least-once is sufficient
    // and exactly-once is never needed.
    await on(F.A, () => { F.A.store.apply('editNotePopover', { id: 'n0', text: 'einmal' }); });
    const realAck = F.A.store.ackPushed.bind(F.A.store);
    F.A.store.ackPushed = () => 0;
    await on(F.A, () => eA.pushNow());
    F.A.store.ackPushed = realAck;
    const rows = await relay.store.listOps(F.spaceId, 0n, 500);
    await on(F.A, () => eA.pushNow());
    const rows2 = await relay.store.listOps(F.spaceId, 0n, 500);
    assert.equal(rows2.ops.length, rows.ops.length, 'the second push stored NOTHING new');
    await on(F.A, () => assert.equal(F.A.store.outboxSize(), 0, 'and the outbox drained on the retry'));
  });

  test('the SEALED envelope is cached — a re-push must not re-seal (409 forked_op_id)', async () => {
    // ADR 003 §3.1: the relay compares stored BYTES, and a re-seal has a fresh iv and a fresh
    // non-deterministic signature. A client that re-seals sees 409 on every retry and the defect
    // is its own.
    await on(F.A, () => { F.A.store.apply('editNotePopover', { id: 'n0', text: 'einmal versiegelt' }); });
    const realAck = F.A.store.ackPushed.bind(F.A.store);
    F.A.store.ackPushed = () => 0;
    await on(F.A, () => eA.pushNow());
    assert.ok(eA.diagnostics().sealedCached > 0, 'the seal is held');
    await on(F.A, () => eA.pushNow());
    F.A.store.ackPushed = realAck;
    assert.equal(eA.diagnostics().lastError, null, 'the second push was a 200, not a 409');
    await on(F.A, () => eA.pushNow());
    await on(F.A, () => assert.equal(F.A.store.outboxSize(), 0));
    assert.equal(eA.diagnostics().sealedCached, 0, 'and the cache empties with the outbox');
  });

  test('WITHOUT a durable envelopeStore a RELAUNCH re-seals and the relay answers 409 — the ADR gap', async () => {
    // ⚠ THIS IS A FINDING, ASSERTED SO IT CANNOT BE FORGOTTEN. ADR 003 §8.1 says the outbox holds
    // SEALED envelopes; ADR 006 §9.2 and `store.js` say `ops.jsonl` holds PLAINTEXT op lines.
    // Both are right for their own purpose and nothing reconciles them, so a laptop closed with a
    // queued edit re-seals it on the next launch and the relay refuses the new bytes.
    await on(F.A, () => { F.A.store.apply('editNotePopover', { id: 'n0', text: 'im Zug getippt' }); });
    const before = engineFor(F.A, F, relay);
    F.A.store.ackPushed = () => 0;                            // the push happened; the ack did not
    await on(F.A, () => before.pushNow());
    delete F.A.store.ackPushed;

    const afterQuit = engineFor(F.A, F, relay);               // a new process: no in-memory cache
    await on(F.A, () => afterQuit.pushNow());
    assert.equal(afterQuit.diagnostics().lastError?.status, 409,
      'REPORTED, not silent — and bounded to the named oid, so the rest of the batch survives');

    // …and the fix, through the injected port. The same relaunch, with somewhere to keep the
    // bytes, is a clean duplicate and a drained outbox.
    const disk = new Map();
    const withStore = {
      load: async (sp) => disk.get(sp) || [],
      save: async (sp, envs) => { disk.set(sp, envs); },
    };
    await bootMac(F.A, F);
    const relay2 = makeRelay();
    await seedRelay(relay2, F);
    const e1 = engineFor(F.A, F, relay2, { envelopeStore: withStore });
    await on(F.A, () => { F.A.store.apply('editNotePopover', { id: 'n0', text: 'wieder im Zug' }); });
    F.A.store.ackPushed = () => 0;
    await on(F.A, () => e1.pushNow());
    delete F.A.store.ackPushed;
    const e2 = engineFor(F.A, F, relay2, { envelopeStore: withStore });
    await on(F.A, () => e2.pushNow());
    assert.equal(e2.diagnostics().lastError, null, 'no 409 — the same bytes were offered again');
    await on(F.A, () => assert.equal(F.A.store.outboxSize(), 0, 'and the outbox drained'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3  ADR 006 §9.1 — W1: THE CURSOR RIDES BELOW THE COMMIT POINT
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 W1 — the persisted cursor is never ahead of board.json', () => {
  let relay;
  let F;

  beforeEach(async () => {
    F = FLEET;
    relay = makeRelay();
    await seedRelay(relay, F);
    await bootMac(F.A, F);
    await bootMac(F.B, F);
  });

  test('a peer op is folded, PERSISTED, and only then does the cursor move', async () => {
    const eA = engineFor(F.A, F, relay);
    const eB = engineFor(F.B, F, relay);
    await on(F.B, () => { F.B.store.apply('editNotePopover', { id: 'n0', text: 'B1' }); });
    await on(F.B, () => eB.pushNow());

    const order = [];
    const realPersist = F.A.store.persistNow.bind(F.A.store);
    const realCursor = F.A.store.noteCursor.bind(F.A.store);
    F.A.store.persistNow = async (...a) => { order.push('persist'); return realPersist(...a); };
    F.A.store.noteCursor = (...a) => { order.push('cursor'); return realCursor(...a); };
    await on(F.A, () => eA.pullNow());
    F.A.store.persistNow = realPersist;
    F.A.store.noteCursor = realCursor;

    assert.equal(order.indexOf('persist') > -1, true, 'the fold was committed');
    assert.ok(order.indexOf('persist') < order.lastIndexOf('cursor'),
      'and the cursor moved AFTER the commit point, never before');
  });

  test('a crash before the persist re-fetches rather than skips — and the re-fetch is idempotent', async () => {
    const eA = engineFor(F.A, F, relay);
    const eB = engineFor(F.B, F, relay);
    // A launch that has persisted at least once — i.e. one with a LINEAGE. That matters and it is
    // not test scaffolding: without one, the next `init()` has no history to adopt and re-derives
    // the board at `now` (ADR 006 §9.4), which would stamp the local value ABOVE the peer op it
    // is about to re-pull. `_opsPersisted` is on here (§9.5), so this is the ordinary state of a
    // Mac that has been syncing for more than one save.
    await on(F.A, () => F.A.store.persistNow());
    await on(F.B, () => {
      F.B.store.apply('createNotePopover', { id: 'nUeb', date: '2026-11-11', text: 'überlebt', categoryId: 'c1' });
    });
    await on(F.B, () => eB.pushNow());

    // The crash: fold, then lose everything below the commit point. The cursor is in the LOG, so
    // "the checkpoint was never written" and "the cursor was never persisted" are one event —
    // which is the structural half of W1.
    await on(F.A, async () => {
      F.A.store.persistNow = async () => {};              // the disk is gone
      await eA.pullNow();
      delete F.A.store.persistNow;
    });
    const cursorOnDisk = JSON.parse(F.A.disk['langzeitplaner.checkpoint'] || 'null');
    assert.equal(cursorOnDisk === null || !cursorOnDisk.cursors || !cursorOnDisk.cursors[F.spaceId], true,
      'nothing on disk claims to have consumed the op');

    await relaunch(F.A);
    const eA2 = engineFor(F.A, F, relay);
    await on(F.A, () => eA2.pullNow());
    assert.equal(F.A.store.state.notes.find((n) => n.id === 'nUeb')?.text, 'überlebt',
      'the op was re-delivered and applied');
    assert.equal(F.A.store.state.notes.filter((n) => n.id === 'nUeb').length, 1, 'exactly once');
  });

  test('the cursor NEVER moves backwards, even when a stale page is replayed', async () => {
    const eA = engineFor(F.A, F, relay);
    const eB = engineFor(F.B, F, relay);
    await on(F.B, () => { F.B.store.apply('editNotePopover', { id: 'n0', text: 'x' }); });
    await on(F.B, () => eB.pushNow());
    await on(F.A, () => eA.pullNow());
    const high = F.A.store.cursor(F.spaceId);
    await on(F.A, () => F.A.store.noteCursor(F.spaceId, '1'));
    assert.equal(F.A.store.cursor(F.spaceId), high, 'a lower seq is refused');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4  F-6 — AN OP WHOSE ATTESTATION HAS NOT ARRIVED IS NOT DROPPED
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 F-6 — first contact does not lose data', () => {
  let relay;
  let F;

  beforeEach(async () => {
    F = FLEET;
    relay = makeRelay();
    await seedRelay(relay, F);
    await bootMac(F.B, F);
    // Mac A boots WITHOUT knowing B is one of its devices — the first-contact state exactly.
    await bootMac(F.A, F, { peers: false });
  });

  test('the op is HELD, the cursor is held with it, and it lands the moment pairing completes', async () => {
    const eA = engineFor(F.A, F, relay);
    const eB = engineFor(F.B, F, relay);
    // A NEW note, not an edit of `n0`: the two Macs' clocks are the same wall clock in this
    // process, so an edit contest between them would be decided by the HLC counter and then by
    // the random device short — a coin flip, and a flaky test. F-6 is about DELIVERY, not about
    // who wins a contest (§1 measures that), so the delivery is measured on an uncontested key.
    await on(F.B, () => {
      F.B.store.apply('createNotePopover', { id: 'nNeu', date: '2026-09-09', text: 'vom neuen Mac', categoryId: 'c1' });
    });
    await on(F.B, () => eB.pushNow());

    const r1 = await on(F.A, () => eA.pullNow());
    assert.equal(r1.applied, 0, 'nothing was applied …');
    assert.equal(eA.deferredOps().length > 0, true, '… and nothing was DROPPED either');
    for (const held of eA.deferredOps()) assert.equal(held.why, 'notMyDevice');
    assert.equal(F.A.store.cursor(F.spaceId), '0',
      'THE CURSOR IS HELD — this is what makes the server the durable record (ADR 006 §9.1)');

    // Pairing completes: this Mac learns that the other device is its own.
    await on(F.A, async () => {
      F.A.store._peerDevices.add(F.B.id.forStore.deviceId);
      const r2 = await eA.pullNow();
      assert.ok(r2.applied > 0, 'the SAME ops, re-delivered from the hold, now apply');
    });
    assert.equal(F.A.store.state.notes.find((n) => n.id === 'nNeu').text, 'vom neuen Mac');
    assert.equal(eA.deferredOps().length, 0);
    assert.notEqual(F.A.store.cursor(F.spaceId), '0', 'and only now does the cursor move past it');
  });

  test('a held op does not block the CONTENT it precedes for ever — it quarantines and releases', async () => {
    // ADR 003 §8.2: "a permanently rejected op must never silently spin forever". A cursor pinned
    // behind one op would block every LATER op on the space, which is worse than the loss it was
    // avoiding. So the hold is bounded and the release is visible.
    const eA = engineFor(F.A, F, relay, { maxDeferrals: 2 });
    const eB = engineFor(F.B, F, relay);
    await on(F.B, () => {
      F.B.store.apply('createNotePopover', { id: 'nNie', date: '2026-10-10', text: 'nie zustellbar', categoryId: 'c1' });
    });
    await on(F.B, () => eB.pushNow());
    for (let i = 0; i < 4; i += 1) await on(F.A, () => eA.pullNow());
    assert.equal(eA.deferredOps().length, 0, 'the hold was released');
    assert.ok(eA.quarantined().length > 0, 'to a VISIBLE quarantine, not to silence');
    for (const q of eA.quarantined()) assert.match(q.reason, /after 2 attempts/);
    assert.equal(eA.status().state, 'error', 'and the engine says so (ADR 003 §8.3)');
    assert.notEqual(F.A.store.cursor(F.spaceId), '0', 'the cursor is released past it');
  });

  test('the taxonomy is closed: a curable refusal is held, an incurable one is not', () => {
    assert.deepEqual([...CURABLE_REFUSALS], ['notMyDevice', 'unattestedDevice']);
    assert.equal(isCurable('notMyDevice'), true);
    assert.equal(isCurable('attestation'), true, 'openOp P1 — the attestation has not arrived');
    assert.equal(isCurable('epoch'), true, 'ADR 002 §4.4 — a key fetch cures it');
    for (const final of ['shape', 'notMyAct', 'writeOnce', 'notOwner', 'localSpace', 'foreignSpace']) {
      assert.equal(isCurable(final), false, `${final} is final — re-pulling gives the same answer`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4b  P-8 — EVERY PARK REASON HAS A DECIDED FATE, AND A PARK IS NEVER A DROP
//
// F-6's prose above was right for a year and the code under it never ran: `pullNow` tested
// `out.parked` on an object whose discriminator is `out.status`, so the whole branch was dead and
// EVERY park fell through into `terminal()` — quarantined as "openOp returned no op", cursor
// released, op destroyed. `tests/attack/privacy-e5-scope.test.js` §6 is the inverted adversary
// row; this block is the domain, so that the next reason `crypto/envelope.js` learns to emit
// cannot be the one nobody added a branch for.
//
// The method is `tests/helpers/sync-domains.js`'s: enumerate the INPUT DOMAIN — here the six
// values of `ENVELOPE_PARK` — and decide every one of them, rather than naming two branches.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4b P-8 — the park domain, decided rather than branched', () => {
  test('the table covers exactly the reasons the envelope layer can emit', () => {
    // THE TOTALITY CHECK, and the one assertion that would have prevented P-8's second half.
    // `CURABLE_PARKS` used to BE the engine's whole knowledge of parks, so a reason that was not
    // one of its two members had no handling at all. Now the table is the knowledge and
    // `CURABLE_PARKS` is a projection of it, so a new `ENVELOPE_PARK` member is a RED TEST here
    // rather than a silently destroyed op in the field.
    assert.deepEqual(Object.keys(PARK_HANDLING).sort(), Object.values(ENVELOPE_PARK).sort());
    for (const [reason, h] of Object.entries(PARK_HANDLING)) {
      assert.ok(['session', 'update'].includes(h.curedBy), `${reason}: curedBy ${h.curedBy}`);
      assert.equal(typeof h.note, 'string');
      assert.ok(h.note.length > 40, `${reason}: the note has to say what the entry is FOR`);
      assert.equal(Object.isFrozen(h), true);
    }
    // The two classes are both non-empty. Without this, a table that said `'session'` everywhere
    // would satisfy every row below while meaning nothing.
    const bySession = Object.values(PARK_HANDLING).filter((h) => h.curedBy === 'session');
    const byUpdate = Object.values(PARK_HANDLING).filter((h) => h.curedBy === 'update');
    assert.ok(bySession.length > 0 && byUpdate.length > 0, 'the classification is vacuous');
  });

  test('`CURABLE_PARKS` is DERIVED from the table, not restated beside it', () => {
    assert.deepEqual([...CURABLE_PARKS],
      Object.keys(PARK_HANDLING).filter((r) => PARK_HANDLING[r].curedBy === 'session'));
    assert.deepEqual([...CURABLE_PARKS], ['attestation', 'epoch']);
    assert.equal(isCurable('attestation'), true);
    assert.equal(isCurable('epoch'), true);
    // …and the update-curable reasons are NOT `isCurable`, because that word means "a re-pull in
    // this session can change the answer". They are still HELD; see the rows below.
    assert.equal(isCurable('version'), false);
    assert.equal(isCurable('unknownKind'), false);
  });

  test('`parkHandlingOf` is TOTAL — a reason from a newer build is still a park', () => {
    // The one input class this file cannot enumerate, because it is by definition the one this
    // build has never heard of. A park reason a NEWER `crypto/envelope.js` emits must not fall
    // off the table into `terminal()` — that is P-8's exact failure mode, one version later.
    for (const unknown of ['somethingNew', '', 'PARKED', 'attestation ', null, undefined, 7, {}]) {
      const h = parkHandlingOf(unknown);
      assert.equal(h.known, false, `${JSON.stringify(unknown)} should not be a known reason`);
      assert.equal(h.curedBy, 'update', 'an unknown reason must be HELD, never dropped');
    }
    for (const known of Object.values(ENVELOPE_PARK)) {
      assert.equal(parkHandlingOf(known).known, true, `${known} is not in the table`);
    }
    // `hasOwnProperty`, not `in`: `parkHandlingOf('toString')` must not resolve to Object.prototype.
    assert.equal(parkHandlingOf('toString').known, false, 'the table is reachable through the prototype');
    assert.equal(parkHandlingOf('constructor').known, false);
  });

  // ── the behavioural half: each park driven through the REAL engine ─────────────────────────

  let relay;
  let F;

  beforeEach(async () => {
    F = FLEET;
    relay = makeRelay();
    await seedRelay(relay, F);
    await bootMac(F.B, F);
    await bootMac(F.A, F);          // A KNOWS B here — the only thing withheld is per-row
  });

  /**
   * B authors one note and pushes it; A pulls under `arrange`. Returns what A did with it.
   *
   * Nothing is hand-built: the op is minted by B's own `apply()`, sealed with B's own signing key
   * and pulled back through the real relay and the real `openOp` (A3-H4).
   */
  async function fateOf(arrange = {}) {
    const eB = engineFor(F.B, F, relay);
    await on(F.B, () => {
      F.B.store.apply('createNotePopover', {
        id: `p8-${Math.random().toString(36).slice(2, 8)}`, date: '2026-11-11',
        text: 'geparkt', categoryId: 'c1',
      });
    });
    await on(F.B, () => eB.pushNow());
    const eA = engineFor(F.A, F, relay, arrange);
    const r = await on(F.A, () => eA.pullNow());
    return {
      pull: r,
      held: eA.deferredOps(),
      quarantined: eA.quarantined(),
      cursor: F.A.store.cursor(F.spaceId),
      status: eA.status(),
      applied: F.A.store.state.notes.some((n) => n.text === 'geparkt'),
    };
  }

  /** A transport that serves A's pulls with one field of every envelope edited. */
  function editingTransport(edit) {
    const inner = loopbackTransport(relay, {
      origin: ORIGIN,
      deviceShort: F.A.id.forStore.deviceShort,
      sign: F.A.id.sign,
      clientVersion: '2.0.0',
      now: () => relay.ctx.now(),
      random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      subtle: S,
    });
    return {
      origin: ORIGIN,
      async request(method, path, query, body, headers) {
        const res = await inner.request(method, path, query, body, headers);
        if (method === 'GET' && path === '/api/v1/ops' && res.json && Array.isArray(res.json.ops)) {
          for (const e of res.json.ops) edit(e);
        }
        return res;
      },
    };
  }

  test('P1 ATTESTATION — held, cursor held, nothing quarantined', async () => {
    const got = await fateOf({ attestationOf: () => null });
    assert.equal(got.pull.deferred, 1, 'the park branch did not run — P-8 is back');
    assert.deepEqual(got.held.map((h) => h.why), [ENVELOPE_PARK.ATTESTATION],
      'held under the ENUM `openOp` emitted, never under its human sentence');
    assert.deepEqual(got.quarantined, [], 'a park is a deferral, never a quarantine');
    assert.equal(got.cursor, '0', 'THE CURSOR MOVED PAST AN OP THIS MAC COULD NOT READ');
    assert.equal(got.applied, false);
  });

  test('P4 EPOCH — held, cursor held (ADR 002 §4.4, offline across a rotation)', async () => {
    const ring = { get: () => null, currentEpoch: () => 1 };
    const got = await fateOf({ keyring: ring });
    assert.equal(got.pull.deferred, 1);
    assert.deepEqual(got.held.map((h) => h.why), [ENVELOPE_PARK.EPOCH]);
    assert.deepEqual(got.quarantined, []);
    assert.equal(got.cursor, '0');
  });

  test('VERSION — an envelope from a newer build is held, not destroyed', async () => {
    // ADR 003 §4: "a client keeps the ability to OPEN every Envelope.v it has ever seen", and ADR
    // 002 §1 is "versioning, not negotiation". Both are promises about the op still being there
    // after the update, and before this fix `v: 99` was the reason an op was silently deleted.
    //
    // NO `parkStore` IS INJECTED HERE, and that is the configuration this row measures: the
    // retention is per-session, so the cursor is HELD. That is the documented fail-safe — between
    // two silent losses this engine takes the recoverable one — and the next row measures the
    // other half, where the port exists and the cursor is released as ADR 003 §8.2 requires.
    const got = await fateOf({ transport: editingTransport((e) => { e.v = 99; }) });
    assert.equal(got.pull.deferred, 1);
    assert.deepEqual(got.held.map((h) => h.why), [ENVELOPE_PARK.VERSION]);
    assert.deepEqual(got.quarantined, []);
    assert.equal(got.cursor, '0');
  });

  test('VERSION with a DURABLE park — the cursor is RELEASED, and the envelope is on disk', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    // P-8's third axis, and the reason ADR 003 §8.2 demands it. A cursor pinned behind an envelope
    // only a NEW BINARY can read blocks every later op on the space until the user updates — and
    // a hostile relay would wedge this device with a single `v: 99` row. So the cursor must be
    // released. Releasing it is only safe once the envelope is retained DURABLY, because after the
    // release the retained copy is the only one this Mac can reach.
    //
    // `sync/outbox.js`'s `createParkingLot` is that retention, behind the `parkStore` port. The
    // condition is the LOT'S OWN ANSWER about itself (`durable`), never an assumption: the row
    // above is the same input with no port, and it still holds the cursor.
    // ═══════════════════════════════════════════════════════════════════════════════════════════
    let rows = [];
    const parkStore = {
      durable: true,
      async loadRecords() { return rows; },
      async saveRecords(next) { rows = next; },
    };
    const got = await fateOf({ transport: editingTransport((e) => { e.v = 99; }), parkStore });

    assert.deepEqual(got.held.map((h) => h.why), [ENVELOPE_PARK.VERSION], 'still HELD, not refused');
    assert.deepEqual(got.quarantined, [], 'and not quarantined');
    assert.notEqual(got.cursor, '0',
      'THE CURSOR IS RELEASED. Reverting the `dormant` arm in `defer()` pins it at 0 again and a '
      + 'single unreadable envelope blocks the space for ever (ADR 003 §8.2).');

    // …and the bytes are on disk, with the reason, which is what makes the release safe.
    assert.equal(rows.length, 1, 'the sealed envelope was retained');
    assert.equal(rows[0].reason, ENVELOPE_PARK.VERSION, 'with its park reason');
    assert.deepEqual(Object.keys(rows[0].env).sort(),
      ['ct', 'dv', 'ep', 'iv', 'oid', 'sig', 'sp', 'v', 'wit'],
      'and as an ENVELOPE — the relay\'s `seq`/`chain` framing is not part of the sealed thing, '
      + 'and a tenth field would be a channel into a file this device replays for weeks');
  });

  test('a held op reports WHAT WOULD CURE IT, so a UI can write the right sentence', async () => {
    // "Held until your other Mac finishes pairing" and "held until you update the app" are the
    // same STATE and two different things to tell a person. `curedBy` is recorded at the moment
    // of the hold, off `PARK_HANDLING`, so the classification has exactly one home — the failure
    // mode this whole pass is about is two places disagreeing about one taxonomy.
    const session = await fateOf({ attestationOf: () => null });
    assert.deepEqual([...new Set(session.held.map((h) => h.curedBy))], ['session']);
    // The SAME store, one pull later: the cursor is still held at 0, so this pull re-delivers the
    // op above as well — which is the retry path working, and why the assertion is over the set.
    const update = await fateOf({ transport: editingTransport((e) => { e.v = 99; }) });
    assert.deepEqual([...new Set(update.held.map((h) => h.curedBy))], ['update']);
    assert.ok(update.held.length >= 1);
    // A curable REFUSAL is `'session'` by definition — `CURABLE_REFUSALS` means "a later op".
    assert.equal(PARK_HANDLING[ENVELOPE_PARK.VERSION].curedBy, 'update');
    assert.equal(PARK_HANDLING[ENVELOPE_PARK.ATTESTATION].curedBy, 'session');
  });

  test('a held op is `pending`, never `healthy` — story 19.3 means what it says', async () => {
    // "Stille bedeutet Gesundheit" is a PROMISE, and the promise is not "the indicator is quiet",
    // it is "quiet means there is nothing to tell you". An op this Mac is holding is work
    // outstanding, exactly as an unacknowledged outbox line is — so `pending`, and NOT `error`,
    // because nothing has failed.
    const got = await fateOf({ attestationOf: () => null });
    assert.equal(got.status.state, 'pending');
    assert.equal(got.status.deferredOps, 1);
    assert.equal(got.status.errorKind, null, 'a held op is not a fault');
  });

  test('the hold is BOUNDED, and its end is a named quarantine (ADR 003 §8.2)', async () => {
    // The control that stops "hold the cursor" being read as "hold it for ever". A cursor pinned
    // behind one unreadable envelope blocks every later op on the space, which is both worse for
    // the user than the loss it was avoiding and how a hostile relay would wedge this device.
    const eB = engineFor(F.B, F, relay);
    await on(F.B, () => {
      F.B.store.apply('createNotePopover', { id: 'p8-nie', date: '2026-11-12', text: 'nie', categoryId: 'c1' });
    });
    await on(F.B, () => eB.pushNow());
    const eA = engineFor(F.A, F, relay, { attestationOf: () => null, maxDeferrals: 2 });
    for (let i = 0; i < 4; i += 1) await on(F.A, () => eA.pullNow());

    assert.deepEqual(eA.deferredOps(), [], 'the ladder never ended');
    assert.deepEqual(eA.quarantined().map((q) => q.reason),
      [`still ${ENVELOPE_PARK.ATTESTATION} after 2 attempts`],
      'and its end must NAME the reason it gave up on');
    assert.equal(eA.status().state, 'error');
    assert.notEqual(F.A.store.cursor(F.spaceId), '0', 'only now is the cursor released');
  });

  test('an envelope with NO `oid` still leaves a record — the one cell nothing could report', async () => {
    // `sync-domains.js` S1-terminal-malformed's own note: `terminal()` was guarded on
    // `typeof oid === 'string'`, so a header-less envelope was refused (correctly) and then
    // dropped with the cursor released AND with no record in the session either. A refusal that
    // leaves no trace is the whole shape of this pass's findings, so it is filed under its seq.
    const got = await fateOf({ transport: editingTransport((e) => { delete e.oid; }) });
    assert.equal(got.applied, false, 'a header-less envelope was applied');
    assert.equal(got.quarantined.length, 1, 'the refusal left no record at all');
    assert.match(got.quarantined[0].oid, /^seq:\d+$/, 'and the record is filed under its seq');
    assert.match(got.quarantined[0].reason, /envelope:/);
  });

  test('`applyRemote` answers for EVERY op it is handed — the claim the cursor rests on', async () => {
    // ── THE REACHABILITY CLAIM BEHIND `pullNow`'s `notReported` GUARD ─────────────────────────
    //
    // The commit point is computed from the ops the engine knows the fold DECIDED. An op that
    // came back in neither `applied` nor `refused` would slip past that computation and the
    // cursor would be released over it, silently — which is P-8's shape one seam further down.
    // The guard that holds such an op is deliberately unreachable today, and this row is why:
    // `store.applyRemote` partitions its input. `store.js` has one arm that warns and reports
    // neither ("not a well-formed op"), and nothing `openOp` returns can take it, because
    // `isOpId(op.id)` has already run inside `openOp`.
    //
    // THE ROW IS THE PIN. If `applyRemote` ever stops answering for an input, this goes red here
    // rather than as a lost note on somebody's second Mac — and the guard stops being dead code.
    await on(F.A, () => {
      const s = F.A.store;
      const mk = (uuid, over) => noteSet({
        act: s._me, dev: s._device, gid: newGid(), mint: () => s._clock.tick(),
        newOpId, newGid, space: F.spaceId, familySpaceId: null, regs: s.registers(),
        ...over,
      }, uuid, { text: 'Partition' }, { born: true });
      const batch = [
        mk('p8-part-a', {}),                                       // ordinary, admissible
        mk('p8-part-b', { space: mkSpaceId('personal') }),         // a foreign personal space
        prefSet({                                                  // the `local` space (F-7)
          act: s._me, dev: s._device, gid: newGid(), mint: () => s._clock.tick(),
          newOpId, newGid, space: F.spaceId, familySpaceId: null, regs: s.registers(),
        }, { rowHeight: 41 }),
      ];
      const r = s.applyRemote(batch);
      const answered = new Set([...r.applied, ...r.refused.map((x) => x.id)]);
      for (const op of batch) {
        assert.equal(answered.has(op.id), true,
          `applyRemote answered for neither list on ${op.k} in ${op.space} — the cursor rule `
          + 'in `pullNow` rests on this partition being total');
      }
      assert.ok(r.applied.length > 0 && r.refused.length > 0,
        'the batch exercised only one side of the partition, so the check is vacuous');
    });
  });

  test('CONTROL — an honest pull still applies, holds nothing and moves the cursor', async () => {
    // Without this every row above is equally satisfied by an engine that defers everything for
    // ever, which would be a green suite and a product that never syncs.
    const got = await fateOf();
    assert.equal(got.applied, true, 'the ordinary case stopped working');
    assert.deepEqual(got.held, []);
    assert.deepEqual(got.quarantined, []);
    assert.notEqual(got.cursor, '0');
    assert.equal(got.status.state, 'healthy', 'and silence is still FREE (19.3)');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4c  R8-1 / R8-2 — THE CHAIN WITNESS IS THE WRAPPER, AND WHAT IT IS ALLOWED TO DO
//
// Round 8 put ADR 002 §5.4's detector on the product path by importing `verifyChain`, the LEAF of
// `sync/chain.js` — a pure function over one contiguous run, with no memory of what this device
// has already folded — and then compensated for the missing memory by giving it a power the ADR
// forbids in one sentence: "it NEVER BLOCKS SYNC in v2 (a false positive that broke a family's
// board would be far worse than the attack)".
//
// Two failures fell out of that, both on an HONEST relay:
//
//   R8-1  the second pull of a HELD page — F-6's ordinary first contact — was verified against an
//         anchor inside itself and reported as `seq jumped from 1 to 1`, and the record persisted
//         beside the cursor paired the commit seq with the LAST ROW OF THE PAGE's chain, so the
//         next launch accused the relay of forging a value this device had written itself;
//   R8-2  a member removal (ADR 003 §6.3) leaves a hole nothing can fill, and a permanent cursor
//         hold on an unfillable hole is a wedge: every op above it was unreachable for ever.
//
// `pullNow` now folds each page through `createChainWitness()`, which is the wrapper the same file
// always shipped: `fresh` (rows at or below the head are already folded), the per-break dedupe,
// the re-anchor, `broken`, and `fromGenesis`. The three rows below pin the three consequences at
// the unit level; `tests/fleet/round8-chain.test.js` is the same three through two whole Macs.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4c R8-1/R8-2 — a chain finding is a diagnostic, and the anchor is one row', () => {
  let relay;
  let F;

  beforeEach(async () => {
    F = FLEET;
    relay = makeRelay();
    await seedRelay(relay, F);
    await bootMac(F.B, F);
    await bootMac(F.A, F, { peers: false });     // A does not know B yet — F-6's first contact
  });

  /** An in-memory `chainStore`, so the record `cursor.js` persists can be read back here. */
  const heads = () => {
    let held = {};
    return {
      durable: true,
      async loadCursors() { return JSON.parse(JSON.stringify(held)); },
      async saveCursors(all) { held = JSON.parse(JSON.stringify(all)); },
      get value() { return held; },
    };
  };

  /** The engine, with one hostile hand on the wire: `mutate(ops) => ops`. */
  function engineWithWire(mac, mutate, extra = {}) {
    const cfg = {
      origin: ORIGIN,
      deviceShort: mac.id.forStore.deviceShort,
      sign: mac.id.sign,
      clientVersion: '2.0.0',
      now: () => relay.ctx.now(),
      random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      subtle: S,
    };
    const base = loopbackTransport(relay, cfg);
    const transport = {
      origin: ORIGIN,
      async request(method, path, query, body, headers) {
        const res = await base.request(method, path, query, body, headers);
        if (method !== 'GET' || path !== '/api/v1/ops' || res.status !== 200) return res;
        return { ...res, json: { ...res.json, ops: mutate(res.json.ops || []) } };
      },
    };
    return engineFor(mac, F, relay, { transport, ...extra });
  }

  test('a HELD page re-served is silent — the witness knows what it has already folded', async () => {
    // The exact input R8-1 named: A cannot apply B's op yet (`notMyDevice`), so the cursor is held
    // and the honest relay re-serves the same row on the next pull. With `verifyChain` that second
    // page was checked against an anchor INSIDE it and reported as a hole between a seq and
    // itself; with the witness the row is at or below the head and is dropped before any check.
    const eA = engineFor(F.A, F, relay);
    const eB = engineFor(F.B, F, relay);
    await on(F.B, () => {
      F.B.store.apply('createNotePopover', { id: 'nHalt', date: '2026-09-09', text: 'gehalten', categoryId: 'c1' });
    });
    await on(F.B, () => eB.pushNow());

    for (let i = 0; i < 4; i += 1) {
      await on(F.A, () => eA.pullNow());
      assert.equal(F.A.store.syncChain, null,
        `pull ${i + 1}: an honest re-serve of a held page is not evidence about the relay`);
      assert.equal(eA.status().state, 'pending', `pull ${i + 1}: a hold is work outstanding, not a fault`);
      assert.equal(F.A.store.cursor(F.spaceId), '0', `pull ${i + 1}: and the cursor is still held`);
    }
    assert.equal(F.A.store.warnings.some((w) => /does not add up/.test(w)), false,
      'and the user is told nothing at all, because nothing happened');
  });

  test('the record persisted beside the cursor is the chain OF THE COMMITTED ROW', async () => {
    // R8-1b. `cursor.js advance(space, seq, head, …)` writes `{seq, chain: head.chain}` and cannot
    // check that the two are one row — so the caller must hand it one. B authors two ops; A can
    // apply neither, so nothing commits; then A learns about B and applies both.
    const store = heads();
    const eB = engineFor(F.B, F, relay);
    await on(F.B, () => {
      F.B.store.apply('createNotePopover', { id: 'nEins', date: '2026-09-09', text: 'eins', categoryId: 'c1' });
      F.B.store.apply('createNotePopover', { id: 'nZwei', date: '2026-09-10', text: 'zwei', categoryId: 'c1' });
    });
    await on(F.B, () => eB.pushNow());
    // THE PAGE MUST END ABOVE THE COMMIT, or the two values coincide and the row proves nothing.
    // The LAST row is served under an envelope version this build cannot read — `ENVELOPE_PARK`'s
    // `VERSION`, held rather than dropped (§4b) — so the page verifies to its end while the cursor
    // stops at the row before it. That is F-6's shape and it is where round 8's record went wrong.
    const eA = engineWithWire(
      F.A,
      (ops) => ops.map((o, i) => (i === ops.length - 1 && ops.length > 1 ? { ...o, v: 2 } : o)),
      { chainStore: store },
    );
    await on(F.A, async () => {
      F.A.store._peerDevices.add(F.B.id.forStore.deviceId);
      await eA.pullNow();
    });
    assert.equal(eA.deferredOps().length, 1, 'the last row of the page is HELD, so the commit is below it');

    const rec = store.value[F.spaceId];
    assert.ok(rec, 'the anchor is persisted at all (P-4)');
    assert.equal(rec.seq, F.A.store.cursor(F.spaceId), 'beside the cursor it belongs to');
    const page = await loopbackTransport(relay, {
      origin: ORIGIN,
      deviceShort: F.A.id.forStore.deviceShort,
      sign: F.A.id.sign,
      clientVersion: '2.0.0',
      now: () => relay.ctx.now(),
      random: (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      subtle: S,
    }).request('GET', '/api/v1/ops', { space: F.spaceId, since: '0', limit: '500' }, null, {});
    const row = page.json.ops.find((o) => String(o.seq) === rec.seq);
    assert.equal(rec.chain, row.chain,
      'ONE ROW, ONE RECORD: the chain stored is the chain the relay served for THAT seq. Round 8 '
      + 'stored `w.head.chain` — the last row of the page — beside a commit that could be lower, '
      + 'and the next launch could not verify anything against it, ever again.');
  });

  test('a hole holds the cursor for the pull that finds it, and then the witness re-anchors', async () => {
    // BOTH HALVES OF THE TRADE IN ONE ROW. Half one: a withheld row is not stepped over on the
    // pull that discovers it — deleting the hold outright would redden this. Half two: the hold is
    // not re-armed once the witness has folded past the break — keeping it, as round 8 did, is
    // what wedged a device for ever after a member purge, whose hole is this shape exactly and
    // cannot be filled by anybody (R8-2).
    await on(F.A, () => { F.A.store._peerDevices.add(F.B.id.forStore.deviceId); });
    const eB = engineFor(F.B, F, relay);
    await on(F.B, () => {
      for (const [id, day] of [['nA', '2026-09-09'], ['nB', '2026-09-10'], ['nC', '2026-09-11']]) {
        F.B.store.apply('createNotePopover', { id, date: day, text: id, categoryId: 'c1' });
      }
    });
    await on(F.B, () => eB.pushNow());

    // Whatever the relay serves, the SECOND row of the log is never in it. That is a censored op
    // and a purged one at once: nothing on this device can tell them apart, which is the point.
    let hidden = null;
    const eA = engineWithWire(F.A, (ops) => {
      if (hidden === null && ops.length > 1) hidden = ops[1].oid;
      return ops.filter((o) => o.oid !== hidden);
    });

    await on(F.A, () => eA.pullNow());
    const held = F.A.store.cursor(F.spaceId);
    assert.equal(F.A.store.syncChain?.findings?.[0]?.kind, 'gap', 'the hole is named …');
    assert.equal(F.A.store.syncChain.findings[0].benignCause, 'member-purge',
      '… with the benign cause the client may not ignore (ADR 003 §6.3)');
    assert.equal(eA.status().state, 'error', 'and it is reported');
    assert.equal(BigInt(held) < 2n, true,
      'THE CURSOR STOPPED BELOW THE MISSING ROW — one honest round trip for a relay that '
      + 'truncated a page. Round 8 was right about this half.');
    assert.equal(F.A.store.state.notes.some((n) => n.id === 'nC'), true,
      'and the rows that DID arrive were applied: nothing is refused on the witness\'s word '
      + '(ADR 002 §8.6, ADR 003 §10.6)');

    await on(F.A, () => eA.pullNow());
    assert.equal(BigInt(F.A.store.cursor(F.spaceId)) > 2n, true,
      'AND ON THE NEXT PULL IT MOVES. The witness re-anchored on the row it was served, so the '
      + 'same break is not re-reported and is not re-armed as a hold. This is the line between a '
      + 'diagnostic and a wedge, and R8-2 is the wedge.');
    assert.equal(F.A.store.syncChain?.findings?.[0]?.kind, 'gap',
      'THE FINDING OUTLIVES THE HOLD: sync continues and the verdict stands, because only positive '
      + 'evidence clears it and the row this relay was accused of holding never arrived.');
    assert.equal(eA.status().state, 'error', 'so the loss is loud rather than silent (E5-2)');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §5  F-7 — THE `local` SPACE NEVER LEAVES AND NEVER LANDS  (ADR 001 §3.3, story 17.7)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§5 F-7 — settings are never synced, at both ends of the wire', () => {
  let relay;
  let F;

  beforeEach(async () => {
    F = FLEET;
    relay = makeRelay();
    await seedRelay(relay, F);
    await bootMac(F.A, F);
  });

  test('OUTBOUND: a pref.set is in the log and is NOT in the outbox', async () => {
    await on(F.A, () => {
      F.A.store.setSettings({ rowHeight: 33 });
      const prefs = F.A.store._log.ops().filter((o) => o.k === 'pref.set');
      assert.ok(prefs.length > 0, 'the log records it — it IS persisted, just never synced');
      assert.equal(F.A.store.outbox().some((l) => l.op.k === 'pref.set'), false,
        'and the outbox does not offer one');
    });
  });

  test('INBOUND: a remote pref.set is refused BY NAME and never reaches the registers', async () => {
    await on(F.A, () => {
      const before = F.A.store.state.settings.rowHeight;
      const op = prefSet({
        act: F.A.store._me, dev: F.A.store._device, gid: newGid(), mint: () => F.A.store._clock.tick(),
        newOpId, newGid, space: F.spaceId, familySpaceId: null, regs: F.A.store.registers(),
      }, { rowHeight: 99 });
      const r = F.A.store.applyRemote([op]);
      assert.deepEqual(r.refused, [{ id: op.id, reason: 'localSpace' }]);
      assert.equal(F.A.store.state.settings.rowHeight, before);
      assert.match(F.A.store.warnings.at(-1), /never synced/);
    });
  });

  test('a personal op addressed to ANOTHER psp_ space is refused — the cross-space replay', async () => {
    await on(F.A, () => {
      const other = mkSpaceId('personal');
      const op = noteSet({
        act: F.A.store._me, dev: F.A.store._device, gid: newGid(), mint: () => F.A.store._clock.tick(),
        newOpId, newGid, space: other, familySpaceId: null, regs: F.A.store.registers(),
      }, 'fremd', { text: 'nicht meins' }, { born: true });
      const r = F.A.store.applyRemote([op]);
      assert.deepEqual(r.refused, [{ id: op.id, reason: 'foreignSpace' }]);
      assert.equal(F.A.store.state.notes.some((n) => n.id === 'fremd'), false);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §6  21.2 — NO FAMILY KEY CAN EVER APPLY
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§6 21.2 — the two scopes are disjoint and this engine cannot bridge them', () => {
  test('a family space id is REFUSED at construction, not tolerated', async () => {
    const F = FLEET;
    assert.throws(() => createPersonalSync({
      store: F.A.store, transport: { request: async () => ({}) }, keyring: F.A.ring,
      spaceId: mkSpaceId('family'), deviceShort: F.A.id.forStore.deviceShort,
      attestationOf: () => null, now: () => 0,
    }), (e) => e instanceof PersonalSyncError && /psp_/.test(e.message));
  });

  test('a FAMILY envelope replayed at the personal door never opens — the key is not reachable', async () => {
    const F = FLEET;
    const relay = makeRelay();
    await seedRelay(relay, F);
    await bootMac(F.A, F);

    // A real family space, a real family key, a real op sealed under it — by the same device.
    const fsp = mkSpaceId('family');
    const fsk = await createSpaceKey();
    const familyRing = createKeyRing();
    familyRing.put(fsp, 1, fsk);
    const op = noteSet({
      act: F.A.store._me, dev: F.A.store._device, gid: newGid(), mint: () => F.A.store._clock.tick(),
      newOpId, newGid, space: F.spaceId, familySpaceId: fsp, regs: F.A.store.registers(),
    }, 'x1', { text: 'privat' }, { born: true });

    // Sealing it for the FAMILY space is refused outright: §5.2.2 check 2 is mirrored in sealOp.
    await assert.rejects(
      () => sealOp(op, familyRing, F.A.id.identity.devSig.privateKey,
        { v: 1, sp: fsp, ep: 1, dv: F.A.id.forStore.deviceShort, oid: op.id, wit: '' }),
      /sp/);

    // And the personal ring simply does not hold a key for an `fsp_` id — it is not a wrong key,
    // it is an unreachable one (ADR 002 §3 barrier 1).
    assert.equal(F.A.ring.get(fsp, 1), null);
    assert.equal(F.A.ring.get(F.spaceId, 1) === null, false);
  });

  test('the engine refuses a deviceShort that is not the one the store stamps with (§5.2.2 check 4)', async () => {
    const F = FLEET;
    assert.throws(() => createPersonalSync({
      store: F.A.store, transport: { request: async () => ({}) }, keyring: F.A.ring,
      spaceId: F.spaceId, deviceShort: F.B.id.forStore.deviceShort,
      attestationOf: () => null, now: () => 0,
    }), /check 4/);
  });

  test('a missing attestationOf is a construction failure, not a silent permanent park', () => {
    const F = FLEET;
    assert.throws(() => createPersonalSync({
      store: F.A.store, transport: { request: async () => ({}) }, keyring: F.A.ring,
      spaceId: F.spaceId, deviceShort: F.A.id.forStore.deviceShort, now: () => 0,
    }), /attestationOf/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §7  THE WP-3 OBLIGATION — `planReplaceAll`'s retractions reach the publisher
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§7 WP-3 — an import never leaves entries live on the other device (story 16.5)', () => {
  let F;
  beforeEach(async () => { F = FLEET; await bootMac(F.A, F); });

  test('replaceAll hands the plan\'s retractions to the publisher, and a restore does too', async () => {
    const pub = createPersonalPublisher();
    await on(F.A, async () => {
      F.A.store.setPublisher(pub);
      const calls = [];
      const wrapped = { ...pub, retract: (k) => { calls.push(k); pub.retract(k); } };
      F.A.store.setPublisher(wrapped);
      F.A.store.replaceAll({ ...BOARD(), notes: [] });
      assert.equal(calls.length, 1, 'the import handed its list over — even when it is empty');
      await F.A.store.rollSnapshot();
      F.A.store.snapshots.unshift({ day: '2026-08-28', at: '2026-08-28T09:00:00Z', state: BOARD() });
      const ok = F.A.store.restoreSnapshot('2026-08-28');
      assert.equal(ok, true);
      assert.equal(calls.length, 2, 'and so did the snapshot restore (11.5)');
    });
  });

  test('a retraction recorded in SOLO mode is carried across when the publisher arrives', async () => {
    // The bug this closes: `replaceAll` runs at import time, which is usually BEFORE any sync
    // engine exists, and `nullPublisher()` is what receives the list. Anything that did not carry
    // it forward would lose the one list `planReplaceAll` is the only thing able to compute.
    await on(F.A, () => {
      F.A.store.publisher.retract(['fnote:m1/aaa', 'fbar:m1/bbb']);
      const pub = createPersonalPublisher();
      const carried = F.A.store.setPublisher(pub);
      assert.equal(carried.retractions, 2);
      assert.deepEqual(pub.pendingRetractions, ['fnote:m1/aaa', 'fbar:m1/bbb']);
      assert.deepEqual(F.A.store.diagnostics().sync.pendingRetractions, 2);
    });
  });

  test('nothing is ever re-shared without being asked — askToReshare records a QUESTION', async () => {
    await on(F.A, () => {
      const pub = createPersonalPublisher();
      F.A.store.setPublisher(pub);
      pub.askToReshare([{ key: 'fnote:m1/ccc', level: 'geteilt' }]);
      assert.equal(pub.pendingReshares.length, 1);
      assert.deepEqual(pub.derivePublication(), [], 'and nothing is published from it');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §8  ADR 006 §9 — THE AUTHORITY RULE ONCE A PEER EXISTS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§8 board.json is the truth, the log is history — with a peer in the picture', () => {
  let F;
  beforeEach(async () => { F = FLEET; });

  test('§9.5 — a quarantined log is NOT overwritten: `_opsPersisted` consults it first', async () => {
    await bootMac(F.A, F);
    await on(F.A, async () => {
      F.A.store.apply('editNotePopover', { id: 'n0', text: 'history' });
      await F.A.store.persistNow();
    });
    // A foreign lineage beside the board: the checkpoint claims a lineage the board does not.
    F.A.disk['langzeitplaner.checkpoint'] = JSON.stringify({
      ...JSON.parse(F.A.disk['langzeitplaner.checkpoint']),
      lzp: { v: 2, lineageId: 'lin_deadbeefdeadbeefdead', gen: 9, boardHash: null, horizon: null, at: 0 },
    });
    await relaunch(F.A);
    assert.equal(F.A.store.quarantine !== null, true, 'the log was refused');
    // `_sequesterQuarantine` renames those bytes aside; once it has, writing is safe again. If it
    // could not, the session must stay read-only for the log — that is the whole of §9.5.
    assert.equal(F.A.store._opsPersisted, !!F.A.store.quarantine.movedAside,
      '`_opsPersisted` is exactly "the quarantined bytes are out of the way"');
  });

  test('§9.3 / W2 — a quarantine is a RE-JOIN: the whole board is republished, at `now` stamps', async () => {
    await bootMac(F.A, F);
    await on(F.A, async () => {
      F.A.store.apply('editNotePopover', { id: 'n0', text: 'vor dem Bruch' });
      await F.A.store.persistNow();
    });
    F.A.disk['langzeitplaner.checkpoint'] = JSON.stringify({
      ...JSON.parse(F.A.disk['langzeitplaner.checkpoint']),
      lzp: { v: 2, lineageId: 'lin_deadbeefdeadbeefdead', gen: 9, boardHash: null, horizon: null, at: 0 },
    });
    await relaunch(F.A);

    const diag = F.A.store.diagnostics();
    assert.equal(diag.sync.rejoin, true, 'the re-join is REPORTED — never a quiet convergence reset');
    assert.match(F.A.store.warnings.join('\n'), /RE-JOIN/i, 'and it is visible to the user');
    // The content survived — `board.json` is the truth — and every line of the re-derived log is
    // unacknowledged, which IS the republication W2 asks for.
    assert.equal(F.A.store.state.notes.find((n) => n.id === 'n0').text, 'vor dem Bruch');
    assert.ok(F.A.store.outboxSize() > 0, 'the whole personal projection is in the outbox');
    for (const line of F.A.store.outbox()) {
      assert.notEqual(line.op.ts.slice(0, 13), '0000000000000',
        'ADR 006 §9.4 — GENESIS stamps are for upgrade day only; a re-join at the bottom of the '
        + 'order would lose every field contest it should win');
    }
  });

  test('ADR 001 §8.1 vs ADR 002 §5.2.2 check 4 — a migrated op CANNOT be sealed at GENESIS', async () => {
    // ⚠ THE SECOND FINDING IN THIS FILE, and the sharper one. §8.1 stamps every migration op with
    // the ALL-ZEROS device short on purpose; check 4 demands `devOf(op.ts) === env.dv` and may
    // not be weakened (it is what makes `dev.*` a possession proof — FINDINGS §4.5 / I-3). So the
    // migrated board — the very first thing M1 uploads — is unsealable as §8.1 leaves it. The
    // measurement, so the resolution below is not mistaken for a preference:
    await bootMac(F.A, F);
    const genesis = { ...BOARD(), schemaVersion: 1 };
    const raw = (await import('../../src/js/core/migrate1to2.js')).migrateV1(genesis, {
      memberId: F.A.store._me, deviceId: F.A.store._device, acceptLossy: true, personalSpaceId: F.spaceId,
    });
    const note = raw.ops.find((o) => o.k === 'note.set');
    assert.equal(note.ts.slice(-16), '0'.repeat(16), 'GENESIS carries the zero short …');
    await assert.rejects(
      () => sealOp(note, F.A.ring, F.A.id.identity.devSig.privateKey,
        { v: 1, sp: F.spaceId, ep: 1, dv: F.A.id.forStore.deviceShort, oid: note.id, wit: '' }),
      /check 4/, '… and sealOp refuses it, exactly as every peer would');
  });

  test('…so the spine NEVER TRAVELS: it is shared prehistory, reproduced identically on both Macs', async () => {
    // The obvious fix — re-stamp the spine once a space exists — was built, measured and
    // WITHDRAWN. Two costs, both real:
    //   · `migrateV1` derives a migration op's id from `board.json` (ADR 001 §8.1), so a re-stamp
    //     produces the SAME opId with DIFFERENT bytes, which is `409 forked_op_id` on the second
    //     Mac's very first push — for ever, on a perfectly healthy pair of Macs;
    //   · and the two Macs' migrated register stamps would then differ for every cell of the
    //     shared prehistory, which ADR 004 §4.3 makes load-bearing the day a family space exists.
    // §8.1's determinism is the answer, not the obstacle: the spine is a pure function of the
    // file, so every Mac holding that file already has it, byte for byte, and it never has to go
    // on the wire at all.
    await bootMac(F.A, F);
    await bootMac(F.B, F);
    const notes = (m) => m.store._log.ops().filter((o) => o.k === 'note.set');
    assert.deepEqual(notes(F.A).map((o) => [o.id, o.ts, o.e]), notes(F.B).map((o) => [o.id, o.ts, o.e]),
      'identical ids AND identical stamps on both Macs — this is what §8.1 is for');
    for (const op of notes(F.A)) assert.equal(op.ts.slice(-16), '0'.repeat(16), 'GENESIS');

    // …and the outbox refuses to offer them, so the engine never quarantines the migrated board.
    await on(F.A, () => {
      assert.equal(F.A.store.outbox().length, 0, 'nothing of the spine is offered');
      assert.ok(F.A.store._log.ops().length > 0, 'though the log is full of it');
      F.A.store.apply('editNotePopover', { id: 'n0', text: 'echte Änderung' });
      const box = F.A.store.outbox();
      assert.equal(box.length, 1, 'only a REAL edit is');
      assert.equal(box[0].op.ts.slice(-16), F.A.id.forStore.deviceShort);
    });
  });

  test('OWED, and asserted so it cannot be forgotten: a Mac WITHOUT that board.json gets none of it', async () => {
    // The corollary of the rule above, stated as a measurement rather than as a hope. ADR 002
    // §6.3 step 8 says a newly paired Mac "pulls from seq 0" — and what it pulls is every op
    // authored since the space existed, which does NOT include the pre-space board. Pairing (or
    // the backup file, §7.2) has to hand `board.json` over. Owner: WP-9 / the pairing flow.
    await bootMac(F.A, F);
    const relay = makeRelay();
    await seedRelay(relay, F);
    const eA = engineFor(F.A, F, relay);
    await on(F.A, () => eA.pushNow());

    await bootMac(F.B, F, { board: null });                  // a genuinely new Mac: no board file
    const eB = engineFor(F.B, F, relay);
    await on(F.B, () => eB.pullNow());
    assert.equal(F.B.store.state.notes.length, 0,
      'the pre-space board did NOT arrive over the wire — pairing owes the hand-over');
    assert.deepEqual(F.B.store.warnings.filter((w) => /refused/.test(w)), [],
      'and nothing was refused: there was simply nothing to send');
  });

  test('usePersonalSpace AFTER init() is refused — every envelope would fail §5.2.2 check 2', async () => {
    await bootMac(F.A, F);
    await on(F.A, () => {
      assert.throws(() => F.A.store.usePersonalSpace(mkSpaceId('personal')), /already writes into/);
      F.A.store._personalSpaceId = null;
      assert.throws(() => F.A.store.usePersonalSpace(mkSpaceId('personal')), /BEFORE init\(\)/);
      F.A.store._personalSpaceId = F.spaceId;
    });
  });

  test('every op the spine mints carries the psp_ id, so every one of them CAN be sealed', async () => {
    await bootMac(F.A, F);
    await on(F.A, () => {
      const personal = F.A.store._log.ops().filter((o) => o.k !== 'pref.set');
      assert.ok(personal.length > 0);
      for (const op of personal) {
        assert.equal(op.space, F.spaceId,
          "an op stamped `space: 'personal'` can never be sealed for a psp_ space");
      }
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §9  THE CONTRACT — the restated constants may not drift from `docs/v2/contracts/`
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§9 the protocol numbers are the contract\'s', () => {
  test('LIMITS and CADENCE match sync.contract.js §0 exactly', async () => {
    const contract = await import('../../docs/v2/contracts/sync.contract.js');
    for (const k of Object.keys(LIMITS)) {
      assert.equal(LIMITS[k], contract.LIMITS[k], `LIMITS.${k} drifted from the contract`);
    }
    for (const k of Object.keys(CADENCE)) {
      assert.equal(CADENCE[k], contract.CADENCE[k], `CADENCE.${k} drifted from the contract`);
    }
    // …and against the SERVER's own numbers, which is the pair that actually has to agree.
    assert.equal(LIMITS.opsPerPush, SERVER_LIMITS.opsPerPush);
    assert.equal(LIMITS.opsPerPull, SERVER_LIMITS.opsPerPull);
    assert.equal(LIMITS.bytesPerEnvelope, SERVER_LIMITS.bytesPerEnvelope);
    assert.equal(LIMITS.bytesPerRequest, SERVER_LIMITS.bytesPerRequest);
  });

  test('the park reasons this engine holds for are the ones the envelope layer emits', async () => {
    const { ENVELOPE_PARK } = await import('../../src/js/crypto/envelope.js');
    assert.deepEqual([...CURABLE_PARKS].sort(), [ENVELOPE_PARK.ATTESTATION, ENVELOPE_PARK.EPOCH].sort());
  });
});
