// tests/attack/_e7-leak-kit.js — the adversary's rig for `e7-leak-*.test.js`.
//
// ADR 004 is the most security-critical document in the project and these files are its
// adversary. The rig therefore holds NOTHING that decides an outcome: every barrier, every
// projection, every fold and every seal is the shipped one. What lives here is the circle
// (three real members, real keys, real attestations), the wire tape, and the two helpers that
// drive Papa's store the way the product drives it.
//
// ⚠ ONE STORE PER PROCESS. `src/js/store.js` exports a SINGLETON, and `useFamilySpace` refuses a
// second circle (addendum 20.6). So each `e7-leak-*.test.js` file owns one circle for its whole
// run and the files are separate processes under `node --test`.
//
// ENGINE RULES (ADR 002 §1) observed: no signature bytes are compared (rule 1), no error NAME is
// branched on (rule 3) — an outcome is read as `err.barrier` / `err.check` / a park this codebase
// defines — and `memKeyStore()` is used throughout (rule 7).

import '../helpers/env.js';
import { resetStorage, seedBoard } from '../helpers/env.js';
import { store } from '../../src/js/store.js';
import { defaultState } from '../../src/js/store.js';

import { makeMember, attestOpenOver, ring, mkSpaceId, mkOpId, mkGroupId } from './_member-kit.js';
import { sealOp, openOp } from '../../src/js/crypto/envelope.js';
import { createSpaceKey } from '../../src/js/crypto/spacekeys.js';
import { fmt } from '../../src/js/core/stamp.js';
import { memberKey, spaceKey } from '../../src/js/core/entities.js';
import { foldAuthorized } from '../../src/js/core/authz.js';
import { assertFamilyPatch } from '../../src/js/core/project.js';
import { createWireRecorder } from '../helpers/never-transmitted.js';

export const BASE_MS = 1787836800000;
export const DATE = '2026-12-24';
export const BAR_FROM = '2027-07-01';
export const BAR_TO = '2027-07-14';

/**
 * THE PLANTED SECRETS. Each is a distinct string, because "the note text did not leak", "the bar
 * label did not leak" and "the category name did not leak" are three different claims and one
 * needle would let two of them ride on the third.
 */
export const SECRET = Object.freeze({
  noteText: 'Scheidungsanwalt 14:30',
  barLabel: 'Kur Bad Woerishofen',
  category: 'Zweitfamilie',
  privatOnly: 'Therapie Mittwoch',
  smuggled: 'Diagnose F32.1',
});

/** The legitimate carrier — the only content that may ever be on the tape. */
export const SHARED = Object.freeze({ text: 'Bescherung 18:00', label: 'Sommerurlaub' });

const BOARD = () => ({
  schemaVersion: 1,
  notes: [],
  bars: [],
  categories: [
    { id: 'cat-1', name: SECRET.category, colorRef: 'gruen', visible: true },
    { id: 'cat-2', name: 'Arbeit', colorRef: 'blau', visible: true },
  ],
  scratchpads: {},
  settings: null,
});

/**
 * Build the circle and adopt Papa's chair on the shipped singleton store.
 * @returns {Promise<Object>} the rig
 */
export async function buildCircle() {
  const FSP = mkSpaceId('family');
  const PSP = mkSpaceId('personal');

  const mk = async (name, colorRef) => {
    const m = await makeMember(1);
    const d = m.devices[0];
    m.attBlob = d.attestation;
    m.name = name;
    m.colorRef = colorRef;
    return m;
  };
  const PAPA = await mk('Papa', 'blau');
  const MAMA = await mk('Mama', 'magenta');
  const OMA = await mk('Oma', 'gruen');

  // Built BEFORE `useIdentity`, because the store takes its attestation verifier there and a
  // store without one fails closed: every family op from any device parks as `unattestedDevice`,
  // which looks exactly like "the secret never arrived".
  const attestOpen = await attestOpenOver([PAPA, MAMA, OMA].map(
    (m) => [m.memberId, m.attBlob, m.rec.recSig.publicKey]));

  resetStorage();
  seedBoard(BOARD());
  store.listeners.clear();
  store.warnings.length = 0;
  store.redactionHalt = null;
  store.useIdentity({
    memberId: PAPA.memberId,
    deviceId: PAPA.devices[0].deviceId,
    deviceShort: PAPA.devices[0].deviceShort,
    peerDeviceIds: [],
    attestOpen,
  });
  store.usePersonalSpace(PSP);
  await store.init();
  store.useFamilySpace(FSP);

  // Three epochs, because half 3 of `assertNeverTransmitted` is about the LOG and a log outlives
  // its keys (ADR 002 §4). One epoch makes that half a loop of length one.
  const keys = [await createSpaceKey(), await createSpaceKey(), await createSpaceKey()];
  const epochKeys = keys.map((k, i) => [FSP, i + 1, k]);
  const keyring = ring(epochKeys);

  // The circle's prehistory: one attestation and one profile per member, plus the admin chain.
  const prehistory = [];
  let ms = BASE_MS;
  const famOp = (m, dev, k, e, f) => ({
    v: 1, id: mkOpId(), ts: fmt((ms += 1000), 0, dev.deviceShort), space: FSP,
    act: m.memberId, dev: dev.deviceId, gid: mkGroupId(), k, e, f,
  });
  for (const m of [PAPA, MAMA, OMA]) {
    const dev = m.devices[0];
    prehistory.push(famOp(m, dev, 'member.set', memberKey(m.memberId),
      { [`dev.${dev.deviceShort}`]: m.attBlob }));
    prehistory.push(famOp(m, dev, 'member.set', memberKey(m.memberId),
      { displayName: m.name, colorRef: m.colorRef, _alive: true }));
  }
  prehistory.push(famOp(PAPA, PAPA.devices[0], 'space.set', spaceKey(FSP),
    { admin: PAPA.memberId, adminPrev: null, name: 'Familie Hein' }));

  const rig = {
    FSP, PSP, PAPA, MAMA, OMA, keys, epochKeys, keyring, prehistory,
    epoch: 1,
    ackSeq: 1000,
    wire: createWireRecorder(),
    // The recovery PUBLIC KEY, not the exported raw bytes: `verifyAttestation` verifies under a
    // `CryptoKey`. Handing it the raw export makes every blob fail, every device unattested and
    // every family op rejected at stage 0b — silently, with a green-looking "nothing arrived".
    attestOpen,
    attestationOf: (dv) => {
      for (const m of [PAPA, MAMA, OMA]) {
        for (const d of m.devices) if (d.deviceShort === dv) return d.att;
      }
      return null;
    },
  };
  return rig;
}

// ── driving Papa's store, through its own doors and nothing else ────────────────────────────

let seq = 0;
/** One note, at a level, created the way the product creates one. Returns its uuid. */
export function papaNote(o = {}) {
  const {
    level = 'privat', text = SECRET.noteText, categoryId = 'cat-1', repeats = false,
    date = DATE, coEdit = false,
  } = o;
  const id = `e7leak${String(++seq).padStart(2, '0')}-0000-4000-8000-000000000000`.slice(0, 36);
  store.txn('create-note', (tx) => {
    tx.note(id).create({ date, text, categoryId, repeatsYearly: repeats, visibility: level, coEdit });
  });
  return id;
}
/** One bar, likewise. */
export function papaBar(o = {}) {
  const { level = 'privat', label = SECRET.barLabel, categoryId = 'cat-1' } = o;
  const id = `e7leakb${String(++seq).padStart(2, '0')}-000-4000-8000-000000000000`.slice(0, 36);
  store.txn('create-bar', (tx) => {
    tx.bar(id).create({
      startDate: BAR_FROM, endDate: BAR_TO, label, categoryId, visibility: level, coEdit: false,
    });
  });
  return id;
}
export const setLevel = (kind, id, level) =>
  store.txn('set-visibility', (tx) => { tx[kind](id).set({ visibility: level }); });

/** Every family op Papa's log holds, in log order — the EMITTED OPS half of every claim. */
export const familyOps = (rig) =>
  store._log.lines().map((l) => l.op).filter((o) => o.space === rig.FSP);
/** Every personal-space op — the truth writes. */
export const personalOps = (rig) =>
  store._log.lines().map((l) => l.op).filter((o) => o.space === rig.PSP);

/**
 * Seal and record every family op currently in the outbox, exactly the way `sync/family.js` does.
 *
 * ⚠ THE TWO INJECTED PORTS ARE THE POINT. `sealOp` REFUSES a family `pub.set` without either of
 * them; this wires them to the same two shipped functions the engine wires them to, so a barrier
 * that stopped working in the product is measured here and vice versa.
 * @returns {Promise<Array<{op:Object, env:Object|null, refused:string|null}>>}
 */
export async function drainAndSeal(rig) {
  const lines = store.familyOutbox();
  const out = [];
  for (const line of lines) {
    const op = line.op;
    rig.wire.preSeal('papa-mac', op);
    let env = null;
    let refused = null;
    try {
      env = await sealOp(op, rig.keyring, rig.PAPA.devices[0].devSig.privateKey, {
        v: 1, sp: rig.FSP, ep: rig.epoch, dv: rig.PAPA.devices[0].deviceShort, oid: op.id, wit: '',
      }, {
        assertFamilyPatch,
        levelOf: (e) => store.familyLevelOf(e),
        attestation: rig.PAPA.devices[0].att,
      });
      rig.wire.sealedBytes('papa-mac', env);
      rig.wire.stored(env);
    } catch (err) {
      refused = err.barrier || err.check || err.code || 'UNEXPECTED';
    }
    out.push({ op, env, refused });
    store.ackPushed([{ oid: op.id, seq: ++rig.ackSeq }]);
  }
  return out;
}

/** Open every envelope this drain produced, the way a peer does. */
export async function openedFrom(rig, records) {
  const ops = [];
  for (const rec of records) {
    if (!rec.env) continue;
    const r = await openOp(rec.env, rig.keyring, rig.attestationOf, {});
    if (r && r.status === 'opened') ops.push(r.op);
  }
  return ops;
}

/** The full raw verdict of a peer's authorized fold. */
export function peerFoldFull(rig, me, openedOps) {
  return foldAuthorized([...rig.prehistory, ...openedOps], {
    me,
    // A wall clock generously ahead of every stamp on the tape. Papa's ops are stamped by the
    // REAL store clock, so a `nowMs` pinned to the fixture's epoch would park every one of them
    // as `future` — a drift clamp doing its job against a test that lied about the time.
    nowMs: Date.now() + 7200000,
    attestOpen: rig.attestOpen,
  });
}

/**
 * A peer's registers — and it ASSERTS that nothing was rejected or parked.
 *
 * That assertion is the difference between this rig and a false green: an attestation that does
 * not verify makes `foldAuthorized` reject every family op at stage 0b, and the symptom is an
 * empty board — which is exactly what "the secret never reached Mama" looks like.
 */
export function peerFold(rig, me, openedOps) {
  const r = peerFoldFull(rig, me, openedOps);
  if (r.rejected.length || r.parked.length) {
    throw new Error(
      'NON-VACUITY: the peer\'s fold did not admit the circle. '
      + `rejected ${JSON.stringify(r.rejected.map((o) => [o.k, r.rejectionOf(o.id)]))} `
      + `parked ${JSON.stringify(r.parked.map((o) => [o.k, r.parkReasonOf(o.id)]))}`);
  }
  return r.regs;
}

/** The `materialize` ctx for one member's board. */
export const MCTX = (rig, me) => ({
  me,
  familySpaceId: rig.FSP,
  members: new Map([rig.PAPA, rig.MAMA, rig.OMA].map((m) => [m.memberId, {
    displayName: m.name, colorRef: m.colorRef, initial: m.name[0],
  }])),
  currentMembers: new Set([rig.PAPA.memberId, rig.MAMA.memberId, rig.OMA.memberId]),
  hiddenMembers: new Set(),
  prefs: {},
  lastSeenSeq: {},
  defaultSettings: defaultState().settings,
});

/**
 * Put the circle's prehistory into PAPA's OWN store, so his device knows Mama's and Oma's devices
 * are attested and `applyRemote` can admit a peer's family op at all. Only the files that drive a
 * peer's write INTO Papa's board need it; the rest measure what leaves, not what arrives.
 * @returns {{applied:number, refused:Array}}
 */
export function seedCircleIntoStore(rig) {
  const r = store.applyRemote(rig.prehistory, {});
  return { applied: r.applied.length, refused: r.refused };
}

/** Mint one op in the family space, authored by whichever member/device is named. */
export function famOpFrom(rig, m, dev, k, e, f, atMs, counter = 0) {
  return {
    v: 1, id: mkOpId(), ts: fmt(atMs, counter, dev.deviceShort), space: rig.FSP,
    act: m.memberId, dev: dev.deviceId, gid: mkGroupId(), k, e, f,
  };
}

export { store, mkOpId, mkGroupId, fmt };
