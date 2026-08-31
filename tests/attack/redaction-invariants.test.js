// ATTACK · E7 — ADR 004 §10's ROW SET, DRIVEN END TO END.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE INVARIANT THE WHOLE EPIC EXISTS TO ENFORCE, quoted from ADR 004's own headline
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   > For every op that is sealed under a FAMILY key, for every entity whose level at seal time
//   > is not `geteilt`, the op's field patch contains no content field with a non-null value. It
//   > is asserted on the EMITTED OPS and on the SEALED BYTES — NEVER ON THE RENDERING. A
//   > rendering bug can therefore produce the wrong pixels; it cannot produce a leak.
//
// Every row below obeys that sentence literally. Nothing here reads a DOM node, a class name or a
// pixel. The subjects are ops, registers and ciphertext.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHAT IS REAL, BECAUSE A LEAK TEST OVER STAND-INS IS A FALSE GREEN
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   THE PUBLISHER   `src/js/store.js` — the shipped singleton, with a real personal space, a real
//                   family space, a real op log and the real `_publishAndEnqueue` seam. Papa's
//                   entries are created and re-levelled through `store.txn`, which is what the
//                   sharing cluster calls; the publication is DERIVED by the product, never built
//                   by this file. There is no line here that constructs a `pub.*` field.
//   THE PROJECTION  `src/js/core/project.js` — `projectForFamily` / `retractPatch`, reached only
//                   through the store.
//   THE SEAL        `src/js/crypto/envelope.js:sealOp`, unmodified, with the product's own
//                   barriers injected the way `sync/family.js` injects them: `assertFamilyPatch`
//                   as `ctx.assertFamilyPatch` (barrier 2) and `store.familyLevelOf` as
//                   `ctx.levelOf` (barrier 4). Real AES-GCM, real P-256 signatures, real padding.
//   THE WIRE        every pre-seal plaintext, every sealed byte and every stored envelope, on a
//                   tape — `tests/helpers/never-transmitted.js`, ADR 004 §10.1.
//   THE PEERS       Mama and Oma open with the real `openOp`, fold with the real `foldAuthorized`
//                   (staged authz, ADR 001 §4.3, stage 3c included) and draw with the real
//                   `materialize`. Their boards are the assertion subject for INV-R4, never
//                   Papa's — see §4.
//   THE KEYS        three real epochs. Half 3 of `assertNeverTransmitted` reads every envelope
//                   back under EVERY key the family has ever held, which is the only half that
//                   can see a field that is correctly encrypted and should never have existed.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE ROW SET (ADR 004 §10) — a ticket in E7 does not close without its row here green
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   INV-R1  no plaintext escape          §1   (P7a, P7b, P7g on the emitted ops AND the bytes)
//   INV-R2  two representations          §2
//   INV-R3  the owner always sees truth  §3   (P7c)
//   INV-R4  a downgrade removes          §4   (P7d, on the PEER's materialization)
//   A3      no `pub.categoryId`, ever    §5   (structural — the absence of a field)
//   16.1    private by default: 0 bytes  §6
//   16.7    Belegt ≡ Geteilt in length   §7   (P7i, at the bucket boundaries)
//   E2E     the family, driven           §8
//   P9      no snitch                    §9
//
// ENGINE RULES (ADR 002 §1) observed: no signature bytes are compared (rule 1), no error NAME is
// branched on (rule 3) — outcomes are read as `err.barrier` / a `park` this codebase defines —
// and `memKeyStore()` is used throughout, because Node has no `indexedDB` (rule 7).

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { resetStorage, seedBoard } from '../helpers/env.js';
import { store } from '../../src/js/store.js';

import {
  makeMember, attestOpenOver, ring, mkSpaceId, mkOpId, mkGroupId, fnoteKey, b64u,
} from './_member-kit.js';

import { sealOp, openOp, paddedLength } from '../../src/js/crypto/envelope.js';
import { PAD_BUCKET } from '../../src/js/crypto/suite.js';
import { createSpaceKey } from '../../src/js/crypto/spacekeys.js';
import { canonicalBytes } from '../../src/js/core/canon.js';
import { fmt } from '../../src/js/core/stamp.js';
import { foldAuthorized } from '../../src/js/core/authz.js';
import { materialize } from '../../src/js/core/materialize.js';
import { getRegister } from '../../src/js/core/registers.js';
import { memberKey, spaceKey, familyKey } from '../../src/js/core/entities.js';
import { defaultState } from '../../src/js/store.js';

import {
  GETEILT_FIELDS, BELEGT_FIELDS, STRUCTURAL_FIELDS, TRUTH_SOURCE, projectForFamily,
  assertFamilyPatch, RedactionError,
} from '../../src/js/core/project.js';

import {
  createWireRecorder, ADR_GETEILT_FIELDS, ADR_BELEGT_FIELDS, ADR_STRUCTURAL_FIELDS,
} from '../helpers/never-transmitted.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0 · THE CIRCLE — three real members, one real family space, three real epochs
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * THE PLANTED SECRETS. Every one of them is searched for on the whole tape, in every scenario.
 *
 * They are distinct strings rather than one, because "the text did not leak" and "the label did
 * not leak" and "the category did not leak" are three different claims and a single needle would
 * let two of them ride on the third.
 */
const SECRET = {
  /** Only ever on an entry that NEVER reaches `geteilt`. */
  noteText: 'Scheidungsanwalt 14:30',
  /** Likewise, for a bar. */
  barLabel: 'Kur Bad Woerishofen',
  /** A category NAME — never published at any level (A3), and the needle a key-name filter misses. */
  category: 'Zweitfamilie',
  /** Only ever on a Privat entry. */
  privatOnly: 'Therapie Mittwoch',
};

/**
 * THE LEGITIMATE CARRIER, and the reason it has to exist.
 *
 * `assertNeverTransmitted` is a claim about the WHOLE TAPE, so a needle asserted anywhere must be
 * one that never legitimately leaves this device — anywhere in this file. A suite in which nothing
 * is ever shared would pass with a build that publishes nothing at all, so every scenario that
 * needs a real Geteilt publication carries THESE strings instead, and the needles above stay
 * needles.
 */
const SHARED = { text: 'Bescherung 18:00', label: 'Sommerurlaub' };

const DATE = '2026-12-24';
const BAR_FROM = '2027-07-01';
const BAR_TO = '2027-07-14';
const BASE_MS = 1787836800000;
const FSP = mkSpaceId('family');
const PSP = mkSpaceId('personal');

/** @type {Object} */ let PAPA;
/** @type {Object} */ let MAMA;
/** @type {Object} */ let OMA;
/** @type {Object} */ let CIRCLE;
/** @type {ReturnType<typeof createWireRecorder>} */ let WIRE;

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
 * The Familienkreis's own prehistory, in the family space: one attestation and one profile per
 * member, and the admin chain. These are REAL blobs from `crypto/identity.js`, verified by
 * `attestOpenOver` with the real `verifyAttestation` — never a stub that says yes, because
 * `foldAuthorized` fails closed without a verifier and a stub would make stage 0b vacuous.
 */
async function circlePrehistory() {
  const ops = [];
  let ms = BASE_MS;
  const famOp = (m, dev, k, e, f) => ({
    v: 1,
    id: mkOpId(),
    ts: fmt((ms += 1000), 0, dev.deviceShort),
    space: FSP,
    act: m.memberId,
    dev: dev.deviceId,
    gid: mkGroupId(),
    k,
    e,
    f,
  });
  for (const m of [PAPA, MAMA, OMA]) {
    const dev = m.devices[0];
    ops.push(famOp(m, dev, 'member.set', memberKey(m.memberId),
      { [`dev.${dev.deviceShort}`]: m.attBlob }));
    ops.push(famOp(m, dev, 'member.set', memberKey(m.memberId),
      { displayName: m.name, colorRef: m.colorRef, _alive: true }));
  }
  ops.push(famOp(PAPA, PAPA.devices[0], 'space.set', spaceKey(FSP),
    { admin: PAPA.memberId, adminPrev: null, name: 'Familie Hein' }));
  return { ops, at: ms };
}

/** The `materialize` ctx for one member's board. */
const MCTX = (me) => ({
  me,
  familySpaceId: FSP,
  members: new Map([PAPA, MAMA, OMA].map((m) => [m.memberId, {
    displayName: m.name, colorRef: m.colorRef, initial: m.name[0],
  }])),
  currentMembers: new Set([PAPA.memberId, MAMA.memberId, OMA.memberId]),
  hiddenMembers: new Set(),
  prefs: {},
  lastSeenSeq: {},
  defaultSettings: defaultState().settings,
});

before(async () => {
  const mk = async (name, colorRef) => {
    const m = await makeMember(1);
    // ADR 002 §2.3's `dev.*` register value: `b64u(canonicalJSON(att)) + '.' + b64u(sig)`.
    // `crypto/identity.js:attestDevice` returns exactly that string, signed by this member's own
    // recovery key — `attestOpenOver` verifies it below with the REAL `verifyAttestation`, never a
    // stub that says yes, because `foldAuthorized` fails closed without a verifier and a stub
    // would make stage 0b vacuous.
    const d = m.devices[0];
    m.attBlob = d.attestation;
    m.name = name;
    m.colorRef = colorRef;
    return m;
  };
  PAPA = await mk('Papa', 'blau');
  MAMA = await mk('Mama', 'magenta');
  OMA = await mk('Oma', 'gruen');

  // ── PAPA'S MAC, through the store's own doors and nothing else ─────────────────────────────
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
    attestOpen: null,
  });
  store.usePersonalSpace(PSP);
  await store.init();
  store.useFamilySpace(FSP);

  // ── THE KEYS. Three epochs, because half 3 of `assertNeverTransmitted` is about the LOG and a
  //    log outlives its keys (ADR 002 §4). One epoch would make that half vacuous.
  const keys = [await createSpaceKey(), await createSpaceKey(), await createSpaceKey()];
  const epochKeys = keys.map((k, i) => [FSP, i + 1, k]);
  const keyring = ring(epochKeys);

  const pre = await circlePrehistory();
  CIRCLE = {
    keys,
    epochKeys,
    keyring,
    prehistory: pre.ops,
    // The recovery PUBLIC KEY, not the exported raw bytes: `verifyAttestation` verifies under a
    // `CryptoKey`. Handing it the raw export makes every blob fail, every device unattested and
    // every family op rejected at stage 0b — silently, and with a green-looking "nothing arrived".
    attestOpen: await attestOpenOver([PAPA, MAMA, OMA].map(
      (m) => [m.memberId, m.attBlob, m.rec.recSig.publicKey])),
    attestationOf: (dv) => {
      for (const m of [PAPA, MAMA, OMA]) {
        for (const d of m.devices) if (d.deviceShort === dv) return d.att;
      }
      return null;
    },
    /** Which epoch the next seal uses. Advanced by §1 so the tape spans more than one. */
    epoch: 1,
  };
  WIRE = createWireRecorder();
});

// ── the wire ────────────────────────────────────────────────────────────────────────────────

/**
 * Seal and record every family op currently in the outbox, exactly the way `sync/family.js` does.
 *
 * ⚠ THE TWO INJECTED PORTS ARE THE POINT. `sealOp` REFUSES a family `pub.set` without either of
 * them, which is the correct failure of an unwired boundary; this file wires them the way the
 * shipping engine wires them and to the same two functions, so a barrier that stopped working in
 * `sync/family.js` would still be measured here and vice versa.
 *
 * @returns {Promise<Array<{op:Object, env:Object|null, refused:string|null}>>}
 */
async function drainAndSeal() {
  const lines = store.familyOutbox();
  const out = [];
  for (const line of lines) {
    const op = line.op;
    WIRE.preSeal('papa-mac', op);
    let env = null;
    let refused = null;
    try {
      env = await sealOp(op, CIRCLE.keyring, PAPA.devices[0].devSig.privateKey, {
        v: 1,
        sp: FSP,
        ep: CIRCLE.epoch,
        dv: PAPA.devices[0].deviceShort,
        oid: op.id,
        wit: '',
      }, { assertFamilyPatch, levelOf: (e) => store.familyLevelOf(e), attestation: PAPA.devices[0].att });
      WIRE.sealedBytes('papa-mac', env);
      WIRE.stored(env);
    } catch (err) {
      // Read WHICH invariant refused, never the error name (ADR 002 §1 rule 3).
      refused = err.barrier || err.check || err.code || 'UNEXPECTED';
    }
    out.push({ op, env, refused });
    // ACK, so the same line is not offered twice. `ackPushed` is the product's own acknowledger.
    store.ackPushed([{ oid: op.id, seq: out.length + 1000 }]);
  }
  return out;
}

/** Every family op Papa's log holds, in log order. The EMITTED OPS half of every claim. */
const familyOps = () => store._log.lines().map((l) => l.op).filter((o) => o.space === FSP);
/** Every personal-space op — the truth writes. */
const personalOps = () => store._log.lines().map((l) => l.op).filter((o) => o.space !== FSP);

/** A peer's fold of the prehistory plus whatever really came off the wire. */
function peerFoldFull(me, openedOps) {
  return foldAuthorized([...CIRCLE.prehistory, ...openedOps], {
    me,
    // The peer's own wall clock, generously ahead of every stamp on the tape. Papa's ops are
    // stamped by the REAL store clock, so a `nowMs` pinned to the fixture's own epoch would park
    // every one of them as `future` — a drift clamp doing its job against a test that lied about
    // what time it was.
    nowMs: Date.now() + 3600000,
    attestOpen: CIRCLE.attestOpen,
  });
}

/**
 * A peer's fold of the prehistory plus whatever really came off the wire — and it ASSERTS that
 * nothing was rejected or parked.
 *
 * That assertion is the difference between this file and a false green: an attestation that does
 * not verify makes `foldAuthorized` reject every family op at stage 0b, and the symptom is an
 * empty board — which is exactly what "the secret never reached Mama" looks like. Every leak row
 * below would have passed against a peer who received nothing at all.
 */
function peerFold(me, openedOps) {
  const r = peerFoldFull(me, openedOps);
  if (r.rejected.length || r.parked.length) {
    throw new Error(
      'NON-VACUITY: the peer\'s fold did not admit the circle. '
      + `rejected ${JSON.stringify(r.rejected.map((o) => [o.k, r.rejectionOf(o.id)]))} `
      + `parked ${JSON.stringify(r.parked.map((o) => [o.k, r.parkReasonOf(o.id)]))}`);
  }
  return r.regs;
}

/** Open every sealed envelope on the tape the way a peer does, with the real `openOp`. */
async function openedByPeer() {
  const ops = [];
  for (const rec of WIRE.tape().sealed) {
    const r = await openOp(rec.env, CIRCLE.keyring, CIRCLE.attestationOf, {});
    if (r && r.status === 'opened') ops.push(r.op);
  }
  return ops;
}

/** One note, at a level, through the store. Returns its uuid. */
let seq = 0;
function papaNote({ level = 'privat', text = SECRET.noteText, categoryId = 'cat-1', repeats = false } = {}) {
  const id = `redaction-${++seq}-0000-0000-000000000000`.slice(0, 36);
  store.txn('create-note', (tx) => {
    tx.note(id).create({
      date: DATE, text, categoryId, repeatsYearly: repeats, visibility: level, coEdit: false,
    });
  });
  return id;
}
function papaBar({ level = 'privat', label = SECRET.barLabel } = {}) {
  const id = `redaction-b${++seq}-0000-0000-00000000000`.slice(0, 36);
  store.txn('create-bar', (tx) => {
    tx.bar(id).create({
      startDate: BAR_FROM, endDate: BAR_TO, label, categoryId: 'cat-1', visibility: level, coEdit: false,
    });
  });
  return id;
}
const setLevel = (kind, id, level) => store.txn('set-visibility', (tx) => { tx[kind](id).set({ visibility: level }); });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · INV-R1 — NO PLAINTEXT ESCAPE
//
// "The `text`/`label` of a Belegt entry, and every field of a Privat entry, are never encoded
//  into an op sealed under a family key." (ADR 004 §1)
//
// THE STORY. Papa books a solicitor's appointment on Christmas Eve. He wants the family to know
// the afternoon is gone; he does not want them to know why. He marks it Belegt. Mama's board must
// show a block. Nothing on Mama's disk, and nothing the relay ever held, may contain the word.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('INV-R1 · no plaintext escape', () => {
  let noteId; let barId; let sealedRecords;

  before(async () => {
    noteId = papaNote({ level: 'belegt' });                  // carries SECRET.noteText — NEVER shared
    barId = papaBar({ level: 'belegt' });                    // carries SECRET.barLabel — NEVER shared
    // A Geteilt entry in the SAME log, on purpose: a test in which nothing is ever shared proves
    // that a build which publishes nothing at all passes. Its text is the legitimate carrier.
    const shared = papaNote({ level: 'geteilt', text: SHARED.text });
    sealedRecords = await drainAndSeal();
    // The tape must span more than one epoch, or half 3 below is a loop of length one. The entry
    // that moves is the SHARED one — moving the Belegt one through Geteilt would put its secret on
    // the wire legitimately and turn every needle in this file blunt.
    CIRCLE.epoch = 2;
    setLevel('note', shared, 'belegt');
    setLevel('note', shared, 'geteilt');
    sealedRecords = [...sealedRecords, ...(await drainAndSeal())];
  });

  test('P7a · every emitted family patch is a subset of ADR 004 §2\'s allowlist ∪ explicit nulls', () => {
    const pubs = familyOps().filter((o) => o.k === 'pub.set');
    assert.ok(pubs.length >= 4, `NON-VACUITY: only ${pubs.length} family ops were emitted`);
    for (const op of pubs) {
      const kind = String(op.e).split(':')[0];
      const permitted = new Set([...ADR_GETEILT_FIELDS[kind], ...ADR_STRUCTURAL_FIELDS]);
      for (const k of Object.keys(op.f)) {
        assert.ok(permitted.has(k),
          `${op.e}: "${k}" is outside ADR 004 §2's allowlist for ${kind}. The allowlist is the `
          + 'mechanism; a field that is not on it may not be on the wire under any circumstances.');
      }
    }
  });

  test('P7b · no op below `geteilt` carries a non-null content field — on the EMITTED OPS', () => {
    const pubs = familyOps().filter((o) => o.k === 'pub.set');
    let below = 0;
    for (const op of pubs) {
      const kind = String(op.e).split(':')[0];
      const content = kind === 'fnote' ? 'pub.text' : 'pub.label';
      if (op.f['pub.level'] === 'geteilt') continue;
      below++;
      assert.equal(op.f[content], null,
        `${op.e} at ${op.f['pub.level']} carries ${JSON.stringify(op.f[content])} in "${content}". `
        + 'INV-R1: only an EXPLICIT NULL — a withdrawal — is permitted below geteilt.');
      // …and the absence is not what makes it safe. `undefined` would satisfy `!== value` and
      // would be ADR 004 §5.1's bug: a register that is never written keeps the value it had.
      assert.ok(Object.hasOwn(op.f, content),
        `${op.e} at ${op.f['pub.level']} OMITS "${content}" rather than nulling it. Omission is `
        + 'not withdrawal (ADR 004 §5.1) — the peer\'s register keeps its old value and its stamp.');
    }
    assert.ok(below >= 3, `NON-VACUITY: only ${below} ops below geteilt`);
  });

  test('P7b · …and on the SEALED BYTES: the ciphertext of a Belegt op contains no secret', () => {
    // Half 1 and half 2 of ADR 004 §10.1, over the whole tape. `except: []` is the strictest
    // form: not even Papa's own Mac may have handed the string to `sealOp`, because `sealOp` is
    // the family seam and this device's family ops are the only thing on this tape.
    const counts = WIRE.assertNeverTransmitted(SECRET.noteText, {
      except: [], epochKeys: CIRCLE.epochKeys,
    });
    WIRE.assertNeverTransmitted(SECRET.barLabel, { except: [], epochKeys: CIRCLE.epochKeys });
    WIRE.assertNeverTransmitted(SECRET.category, { except: [], epochKeys: CIRCLE.epochKeys });
    assert.ok(counts.plaintexts >= 4 && counts.sealed >= 4,
      `NON-VACUITY: the tape holds ${counts.plaintexts} plaintexts and ${counts.sealed} envelopes`);
    assert.equal(counts.sealed, counts.stored, 'the relay stored exactly what was handed to it');
  });

  test('P7b · …and by DECRYPTING THE WHOLE FAMILY LOG WITH EVERY EPOCH KEY', async () => {
    // The only half that can see a leak the other two structurally cannot: a field that IS
    // encrypted, correctly, and should never have been in the object at all.
    const r = await WIRE.decryptWithEveryEpochKey(CIRCLE.epochKeys, CIRCLE.attestationOf);
    assert.deepEqual(r.offList, [],
      'a decrypted family op carries a field outside its level\'s allowlist:\n  '
      + r.offList.join('\n  '));
    assert.ok(r.opened >= 4, `NON-VACUITY: only ${r.opened} envelopes opened`);
    assert.equal(r.attempts, WIRE.tape().sealed.length * CIRCLE.epochKeys.length,
      'every envelope was tried under EVERY epoch key, not just its own');
    assert.ok(CIRCLE.epochKeys.length >= 2,
      'a single-epoch tape makes this row a loop of length one');
    // And the tape really does span two epochs, or "every key" is a claim about one key.
    assert.ok(new Set(WIRE.tape().sealed.map((s) => s.env.ep)).size >= 2,
      'every envelope on the tape was sealed under the same epoch');
  });

  test('P7e · `assertFamilyPatch` throws for every off-list field, and `sealOp` refuses an unbranded patch', async () => {
    for (const kind of ['fnote', 'fbar']) {
      for (const bad of ['categoryId', 'pub.categoryId', 'text', 'owner', 'pub.owner', 'toString']) {
        assert.throws(() => assertFamilyPatch({ [bad]: 'x' }, kind, 'geteilt'), RedactionError,
          `${kind}: "${bad}" was admitted by barrier 2`);
      }
      // The explicit-null escape, and its exact width: a null passes for a DECLARED field of this
      // kind and for nothing else. `Object.hasOwn`, never `in` — `'toString' in FIELDS.fnote` is
      // `true` and ADR 004 §2.2's printed barrier used `in`.
      assert.doesNotThrow(() => assertFamilyPatch({ 'pub.level': 'geteilt', 'pub.text': null }, 'fnote', 'geteilt'));
      assert.throws(() => assertFamilyPatch({ toString: null }, kind, 'geteilt'), RedactionError,
        `${kind}: a prototype-chain name rode the null escape`);
    }
    // Barrier 3, through the REAL seal seam: a hand-built patch, correct in every other way.
    const hand = {
      v: 1, id: mkOpId(), ts: fmt(BASE_MS, 0, PAPA.devices[0].deviceShort), space: FSP,
      act: PAPA.memberId, dev: PAPA.devices[0].deviceId, gid: mkGroupId(), k: 'pub.set',
      e: fnoteKey(PAPA.memberId),
      f: { 'pub.level': 'belegt', 'pub.alive': true, 'pub.date': DATE },
    };
    let barrier = null;
    try {
      await sealOp(hand, CIRCLE.keyring, PAPA.devices[0].devSig.privateKey, {
        v: 1, sp: FSP, ep: 1, dv: PAPA.devices[0].deviceShort, oid: hand.id, wit: '',
      }, { assertFamilyPatch, levelOf: () => 'belegt', attestation: PAPA.devices[0].att });
    } catch (e) { barrier = e.barrier; }
    assert.equal(barrier, 'barrier3',
      'a hand-built family patch was SEALED. Plaintext leaves a device through exactly one '
      + 'function and that function is projectForFamily() — ADR 004 §2.2 barrier 3.');
  });

  test('a BLANK text is a value, not an absence — barrier 2 is `!== null`, never truthiness', () => {
    // ⚠ ADR 004 §2.2's PRINTED barrier is `patch['pub.text'] || patch['pub.label']`, and
    // `core/ops.js` says in its own words that "a blank note text is a legitimate value" — which
    // is exactly why `null` had to be reserved for "redacted". An empty string below Geteilt is a
    // VALUE reaching a family key, and a truthiness test waves it through.
    //
    // It is not only a shape argument. `''` and `null` are two different facts on a peer's board:
    // `null` withdraws the register and the viewer renders the neutral word; `''` OVERWRITES it
    // with a blank, which is what a Geteilt entry whose owner cleared the text looks like. A
    // Belegt entry that publishes `''` therefore tells the family "this entry has no text",
    // which is a claim about content and one the level does not license.
    for (const [kind, field] of [['fnote', 'pub.text'], ['fbar', 'pub.label']]) {
      for (const level of ['belegt', 'privat']) {
        assert.throws(() => assertFamilyPatch({ 'pub.level': level, [field]: '' }, kind, level),
          (e) => e.name === 'RedactionError' && e.barrier === 'INV-R1',
          `${kind} at ${level}: a blank ${field} was admitted by barrier 2`);
      }
      assert.doesNotThrow(() => assertFamilyPatch({ 'pub.level': 'geteilt', [field]: '' }, kind, 'geteilt'),
        'a blank string at geteilt is a legitimate value and must pass');
    }
    // …and end to end: a Belegt entry whose text really is blank publishes `null`, not `''`.
    const id = papaNote({ level: 'belegt', text: '' });
    const fk = familyKey('fnote', PAPA.memberId, id);
    const op = familyOps().filter((o) => o.e === fk).pop();
    assert.ok(op, 'the blank Belegt entry published nothing at all');
    assert.equal(op.f['pub.text'], null, 'a blank text was published as a VALUE');
  });

  test('A3 refuses BY NAME, one barrier before the allowlist would refuse it anyway', () => {
    // The allowlist loop would refuse `pub.categoryId` as "a field outside the allowlist", which
    // is true and useless. ADR 004 is the most security-critical document in this project and
    // §2.3 requires its failure path to be LOUD; a generic complaint shadowing the one rule
    // everybody quotes is a quieter failure for the one class of bug that must never be quiet.
    for (const kind of ['fnote', 'fbar']) {
      for (const name of ['categoryId', 'pub.categoryId', 'cat', 'pub.cat', 'category']) {
        for (const level of ['privat', 'belegt', 'geteilt']) {
          assert.throws(() => assertFamilyPatch({ [name]: 'cat-1' }, kind, level),
            (e) => e.name === 'RedactionError' && e.barrier === 'A3'
              && /A3/.test(e.message) && /never synced/i.test(e.message),
            `${kind}/${level}: "${name}" was not refused AS A CATEGORY`);
          // …including as an explicit null, which is the shape the withdrawal escape admits for
          // every DECLARED field. A category is not a declared field, and saying so by name is
          // the difference between a rule and a coincidence.
          assert.throws(() => assertFamilyPatch({ [name]: null }, kind, level),
            (e) => e.name === 'RedactionError' && e.barrier === 'A3');
        }
      }
    }
  });

  test('P7f · `sealOp` re-derives the level from the register map, not from the caller', async () => {
    // Finding S5, as a live attack: the caller declares `geteilt` for an entity the authenticated
    // `visibility` register calls `belegt`, and brands the patch at the level it declared. Under
    // the OLD formula (`patch['pub.level'] ?? currentPubLevel(e)`) the caller's value won and the
    // brand backed the lie. Both halves are the same caller lying twice, which is the shape.
    const id = papaNote({ level: 'belegt', text: SECRET.privatOnly });
    await drainAndSeal();
    const uuid = id;
    const truth = {
      visibility: 'geteilt', date: DATE, text: SECRET.privatOnly, repeatsYearly: false,
      coEdit: false, _alive: true,
    };
    const lying = projectForFamily('fnote', truth, 'geteilt', 'belegt');
    assert.equal(lying['pub.text'], SECRET.privatOnly, 'the projection did what it was told');
    const op = {
      v: 1, id: mkOpId(), ts: fmt(BASE_MS + 9999, 0, PAPA.devices[0].deviceShort), space: FSP,
      act: PAPA.memberId, dev: PAPA.devices[0].deviceId, gid: mkGroupId(), k: 'pub.set',
      e: familyKey('fnote', PAPA.memberId, uuid), f: lying,
    };
    let barrier = null;
    try {
      await sealOp(op, CIRCLE.keyring, PAPA.devices[0].devSig.privateKey, {
        v: 1, sp: FSP, ep: 1, dv: PAPA.devices[0].deviceShort, oid: op.id, wit: '',
      }, { assertFamilyPatch, levelOf: (e) => store.familyLevelOf(e), attestation: PAPA.devices[0].att });
    } catch (e) { barrier = e.barrier; }
    assert.equal(barrier, 'barrier4',
      'a `pub.text` was sealed for an entity the authenticated register map calls BELEGT. '
      + 'A declared level is a claim to be CHECKED against the map, never a substitute for it.');
    // And the store's own answer is the truth register, which is what makes that refusal correct.
    assert.equal(store.familyLevelOf(familyKey('fnote', PAPA.memberId, uuid)), 'belegt');
    // The secret never reached the tape, because the refusal happened before the AEAD.
    WIRE.assertNeverTransmitted(SECRET.privatOnly, { except: [], epochKeys: CIRCLE.epochKeys });
  });

  test('P7f · a family entity belonging to somebody else has no level here, so it cannot be published', () => {
    // Ownership is read off the KEY (ADR 001 §4.4), not off a flag. `null` is a refusal at
    // barrier 4 and never a fallback to the peer's last-published `pub.level` — answering with
    // that would let a co-edit re-publish a text its owner had since withdrawn.
    assert.equal(store.familyLevelOf(familyKey('fnote', MAMA.memberId, 'aaaa1111-2222-3333-4444-555566667777')), null);
    assert.equal(store.familyLevelOf('fnote:not-a-key'), null);
    assert.equal(store.familyLevelOf(null), null);
  });

  test('the two transcriptions of ADR 004 §2 agree — the module\'s and this suite\'s', () => {
    // `never-transmitted.js` transcribes the allowlists from the ADR's printed code block rather
    // than importing them, so a mutant that widened `core/project.js`'s table would not widen the
    // check. That independence is only worth something if a DIVERGENCE is loud, which is this row.
    for (const kind of ['fnote', 'fbar']) {
      assert.deepEqual([...GETEILT_FIELDS[kind]], [...ADR_GETEILT_FIELDS[kind]],
        `${kind}: core/project.js's GETEILT_FIELDS no longer matches ADR 004 §2's printed block`);
      assert.deepEqual([...BELEGT_FIELDS[kind]], [...ADR_BELEGT_FIELDS[kind]],
        `${kind}: core/project.js's BELEGT_FIELDS no longer matches ADR 004 §2's printed block`);
      assert.deepEqual([...STRUCTURAL_FIELDS[kind]], [...ADR_STRUCTURAL_FIELDS]);
      // BELEGT ⊂ GETEILT, and the difference is exactly {content, coEdit} — INV-R1 and §8 as a
      // set difference, so neither can drift without this row noticing.
      const diff = GETEILT_FIELDS[kind].filter((f) => !BELEGT_FIELDS[kind].includes(f)).sort();
      assert.deepEqual(diff, [kind === 'fnote' ? 'pub.text' : 'pub.label', 'pub.coEdit'].sort());
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · INV-R2 — TWO REPRESENTATIONS, ONE ENTITY
//
// "At most one truth record and at most one publication record, with independent registers and
//  independent stamps." (ADR 004 §1)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('INV-R2 · two representations, one entity', () => {
  test('one uuid, two entity keys, two register sets, two spaces', async () => {
    const id = papaNote({ level: 'geteilt', text: 'Bescherung 18:00' });
    await drainAndSeal();
    const truthKey = `note:${id}`;
    const pubKey = familyKey('fnote', PAPA.memberId, id);
    const regs = store.registers();

    assert.ok(regs.get(truthKey), 'the truth record exists');
    assert.ok(regs.get(pubKey), 'the publication record exists');
    assert.notEqual(truthKey, pubKey, 'and they are two keys');
    // The uuid is carried across UNCHANGED (ADR 004 §9) — which is why moving a repeat's anchor
    // cannot change what the family record points at.
    assert.equal(pubKey.split('/')[1], id);
    // The owner is IN THE KEY. There is no owner register to backdate (18.1).
    assert.equal(pubKey.split(':')[1].split('/')[0], PAPA.memberId);
    assert.equal([...regs.get(pubKey).keys()].filter((k) => /owner/i.test(k)).length, 0);

    // Independent registers: the truth's names and the publication's names do not overlap at all.
    const truthNames = new Set(regs.get(truthKey).keys());
    const pubNames = new Set(regs.get(pubKey).keys());
    const overlap = [...pubNames].filter((n) => truthNames.has(n) && n !== '_born');
    assert.deepEqual(overlap, [], `the two records share register names: ${overlap.join(', ')}`);

    // Independent stamps: the truth write and the publication carry DIFFERENT stamps, because
    // they are different ops. (They share a gid — see §8 — which is a different claim.)
    const tv = getRegister(regs, truthKey, 'date');
    const pv = getRegister(regs, pubKey, 'pub.date');
    assert.ok(tv && pv, 'both registers are written');
    assert.notEqual(tv.stamp, pv.stamp, 'two ops, two stamps');
    assert.equal(tv.value, pv.value, 'and the publication is a PROJECTION of the truth');

    // Two spaces, and the truth was never sealed under a family key.
    const truthOps = personalOps().filter((o) => o.e === truthKey);
    const pubOps = familyOps().filter((o) => o.e === pubKey);
    assert.ok(truthOps.length >= 1 && pubOps.length >= 1);
    assert.equal(truthOps.filter((o) => o.space === FSP).length, 0,
      'a TRUTH op was authored into the family space — 20.5, there is no admin x-ray because '
      + 'truth registers were never sealed under the family key');
  });

  test('TRUTH_SOURCE is a rename table, and `categoryId` has no row in it (A3)', () => {
    for (const kind of ['fnote', 'fbar']) {
      const sources = Object.values(TRUTH_SOURCE[kind]);
      assert.equal(sources.includes('categoryId'), false,
        `${kind}: a published field is a projection OF categoryId`);
      assert.equal(Object.keys(TRUTH_SOURCE[kind]).some((k) => /cat/i.test(k)), false);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · INV-R3 — THE OWNER ALWAYS SEES THE TRUTH
//
// "A redaction can never make my own board lie to me." (ADR 004 §1) — and P7c is the only thing
// standing between the promotion rule and a bug that blanks the owner's own note (§11.4).
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('INV-R3 · the owner always sees the truth', () => {
  test('P7c · Geteilt → Belegt publishes `pub.text: null` and does NOT blank my own note', async () => {
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    await drainAndSeal();
    const before = store.state.notes.find((n) => n.id === id);
    assert.equal(before.text, SHARED.text, 'the owner sees the real text at geteilt');

    setLevel('note', id, 'belegt');
    const sealedNow = await drainAndSeal();
    const withdrawal = sealedNow.map((r) => r.op).find((o) => o.k === 'pub.set');
    assert.ok(withdrawal, 'the downgrade published something');
    assert.equal(withdrawal.f['pub.text'], null, 'and what it published is an explicit null');

    const after = store.state.notes.find((n) => n.id === id);
    assert.equal(after.text, SHARED.text,
      'THE DOWNGRADE BLANKED MY OWN NOTE. `materialize.js:promote` must never promote my own '
      + '`pub.*` writes — they are projections OF the truth, not edits TO it (ADR 004 §4.1).');
    assert.equal(after.visibility, 'belegt');
    // …and the same claim read off the REGISTERS, which is sharper: materialization could be
    // hiding a truth register the publication had overwritten.
    assert.equal(getRegister(store.registers(), `note:${id}`, 'text').value, SHARED.text);
  });

  test('P7c · a visibility change republishes the CO-EDITOR\'s newer value, not my stale one', async () => {
    // ⚠ ADR 004 §11.4: "the promotion rule is the hardest thing here to hold in your head, and
    // P7c is the only thing standing between it and a bug that blanks the owner's own note." This
    // is the other half of that sentence, and the half nothing else in the suite covers.
    //
    // §4.1's promotion says the OWNER's board reads `maxByStamp(truth[f], pub[f] where author !==
    // me)`. So after Mama moves a co-editable Geteilt entry, Papa's board shows HER date. If the
    // publish path then read RAW REGISTERS instead of the MATERIALIZED entry, Papa's next
    // visibility change would republish HIS OLD DATE at a fresh stamp and win — silently undoing
    // a co-editor's work with a control that says nothing about dates.
    //
    // Papa's own log has to hold the circle for Mama's op to be admissible at all, so the
    // prehistory goes in through `applyRemote` — the product's own inbox, past the real
    // `foldAuthorized`, never a direct register write.
    store.setAttestOpen(CIRCLE.attestOpen);
    const pre = store.applyRemote(CIRCLE.prehistory, {});
    assert.deepEqual(pre.refused, [], 'Papa\'s own fold refused the circle');

    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    store.txn('grant-coedit', (tx) => { tx.note(id).set({ coEdit: true }); });
    await drainAndSeal();
    const fk = familyKey('fnote', PAPA.memberId, id);

    // MAMA MOVES IT. A real op, authored by her device, admitted by stage 3b because `pub.coEdit`
    // is true — not a register poke.
    const hers = {
      v: 1,
      id: mkOpId(),
      ts: fmt(Date.now() + 1000, 0, MAMA.devices[0].deviceShort),
      space: FSP,
      act: MAMA.memberId,
      dev: MAMA.devices[0].deviceId,
      gid: mkGroupId(),
      k: 'pub.set',
      e: fk,
      f: { 'pub.date': '2027-03-04' },
    };
    const r = store.applyRemote([hers], { seqs: { [hers.id]: 9001 } });
    assert.deepEqual(r.refused, [], 'stage 3b refused a co-editor\'s write on a coEdit entry');
    assert.equal(store.state.notes.find((n) => n.id === id).date, '2027-03-04',
      'PROMOTION did not reach Papa\'s board — §4.1');
    assert.equal(getRegister(store.registers(), `note:${id}`, 'date').value, DATE,
      'CONTROL: the raw truth register still holds Papa\'s older date, so the two really disagree '
      + 'and this row is not measuring one value twice');

    // …and now the visibility change. What it republishes must be HERS.
    const mark = store._log.lines().length;
    setLevel('note', id, 'belegt');
    const pub = store._log.lines().slice(mark).map((l) => l.op).find((o) => o.k === 'pub.set');
    assert.ok(pub, 'the downgrade published nothing');
    assert.equal(pub['f']['pub.date'], '2027-03-04',
      'the visibility change republished PAPA\'S STALE DATE over the co-editor\'s newer one, at a '
      + 'fresh stamp, so it wins. `_publishAndEnqueue` must pass the MATERIALIZED entry as '
      + '`truth` — promotion applied (ADR 004 §4.1, PUBLISH_FAILURE_CONTRACT clause 6).');
  });

  test('P7c · a Privat entry is fully mine — every field, on my board, with nothing published', async () => {
    const id = papaNote({ level: 'privat', text: SECRET.privatOnly, categoryId: 'cat-2' });
    const before = familyOps().length;
    await drainAndSeal();
    assert.equal(familyOps().length, before, 'a privat entry emitted nothing');
    const mine = store.state.notes.find((n) => n.id === id);
    assert.equal(mine.text, SECRET.privatOnly);
    assert.equal(mine.date, DATE);
    assert.equal(mine.categoryId, 'cat-2');
    assert.equal(mine.visibility, 'privat');
  });

  test('a `RedactionError` on the publish path STOPS the sync loop — it is never log-and-skip', () => {
    // ADR 004 §2.3, normatively: "It is NEVER logged-and-skipped, and it never silently omits a
    // family op — because a silently omitted downgrade op is exactly the failure in §5."
    //
    // The input that produces one, and it is not contrived: a `visibility` truth register holding
    // a level this build has never heard of. `ops.js` types the field as an enum, so no op this
    // build would accept could write it — a future protocol version, or a corrupted import, can.
    const id = papaNote({ level: 'belegt' });
    assert.equal(store.redactionHalt, null, 'the store is healthy before the injection');
    // The seam `PUBLISH_FAILURE_CONTRACT` itself names: `_truthOf` is what hands the projection
    // the materialized entry, and a materialized entry carrying a level this build has never
    // heard of is what a future protocol version or a corrupted import produces. `registers()`
    // is rebuilt per call, so poking a cell there would be poking a copy.
    const realTruthOf = store._truthOf;
    store._truthOf = function (kind, uuid) {
      const t = realTruthOf.call(this, kind, uuid);
      return t && uuid === id ? { ...t, visibility: 'oeffentlich' } : t;
    };
    try {
      store.txn('poke', (tx) => { tx.note(id).set({ date: '2026-12-25' }); });
      assert.ok(store.redactionHalt, 'a RedactionError on the publish path was SWALLOWED');
      assert.equal(store.redactionHalt.barrier, 'barrier1');
      assert.deepEqual(store.familyOutbox(), [],
        'the family sync loop kept running after a redaction failure. §5.1: a silently omitted '
        + 'downgrade leaves the entry readable on every peer while the owner\'s board looks right.');
      assert.ok(store.warnings.some((w) => /PUBLICATION HALTED/.test(w)),
        'the halt wrote no local diagnostic — §2.3 requires one, and the settings strip');
      // MY OWN BOARD IS UNTOUCHED. The halt stops publication and only publication: the truth
      // write landed, the log is still writable, and nothing was lost.
      assert.equal(store.state.notes.find((n) => n.id === id).date, '2026-12-25');
      assert.equal(store._logMayBeWritten(), true, 'the halt disarmed the LOG, which loses ops');
    } finally {
      store._truthOf = realTruthOf;
      store.redactionHalt = null;
      store.warnings.length = 0;
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · INV-R4 — A DOWNGRADE REMOVES
//
// "Any transition to a lower level writes explicit `null`s to every content register it
//  withdraws, at a newer stamp. OMISSION IS NOT WITHDRAWAL." (ADR 004 §1, §5.1)
//
// ⚠ ASSERTED ON MAMA'S BOARD AND MAMA'S REGISTERS, NEVER ON PAPA'S. That is the whole reason
// §5.1 calls this "the single highest-value defect in the whole v2 surface": in the failing case
// the owner's board is right, so no owner-side smoke test catches it.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('INV-R4 · a downgrade removes — on the PEER\'s materialization', () => {
  /** Every ordered sequence of levels of length ≤ 4 that ends in `privat`, both kinds. */
  const SEQUENCES = [
    ['geteilt', 'privat'],
    ['belegt', 'privat'],
    ['geteilt', 'belegt', 'privat'],
    ['belegt', 'geteilt', 'privat'],
    ['geteilt', 'belegt', 'geteilt', 'privat'],
    ['privat', 'geteilt', 'privat'],
  ];

  for (const kind of ['note', 'bar']) {
    for (const levels of SEQUENCES) {
      test(`P7d · ${kind} [${levels.join(' → ')}] leaves the peer NO field of the entity`, async () => {
        // A sequence that passes through `geteilt` PUBLISHES its content legitimately, so it may
        // not carry a needle: it would blunt every `assertNeverTransmitted` in the file. The
        // sequences that never reach Geteilt carry the real needles, and those are the ones whose
        // bytes are checked below.
        const shares = levels.includes('geteilt');
        const secret = shares
          ? (kind === 'note' ? SHARED.text : SHARED.label)
          : (kind === 'note' ? SECRET.noteText : SECRET.barLabel);
        const id = kind === 'note'
          ? papaNote({ level: levels[0], text: secret })
          : papaBar({ level: levels[0], label: secret });
        const opened = [];
        // Skip the setter for INDEX 0 only. Comparing the level instead (`to !== levels[0]`) also
        // skips the FINAL `privat` of a `privat → geteilt → privat` sequence, which is the one
        // transition the row exists to measure — a test that silently stops short of its own
        // subject, and the reason this is an index and not a value.
        for (const [i, to] of levels.entries()) {
          if (i > 0) setLevel(kind, id, to);
          for (const rec of await drainAndSeal()) {
            if (!rec.env) continue;
            const r = await openOp(rec.env, CIRCLE.keyring, CIRCLE.attestationOf, {});
            if (r.status === 'opened') opened.push(r.op);
          }
        }
        assert.ok(opened.length >= 1, 'NON-VACUITY: nothing reached the wire at all');

        const fkind = kind === 'note' ? 'fnote' : 'fbar';
        const fk = familyKey(fkind, PAPA.memberId, id);
        const regs = peerFold(MAMA.memberId, opened);
        const board = materialize(regs, MCTX(MAMA.memberId));

        // 1. THE BOARD — the entity is gone from Mama's arrays entirely.
        const seen = [...board.notes, ...board.bars].filter((e) => e.id === id || e.entityKey === fk);
        assert.deepEqual(seen, [],
          `${kind} [${levels.join('→')}]: the peer still DRAWS the entity after a retraction`);

        // 2. THE REGISTERS — the sharper claim: materialization could be hiding a value that is
        //    still on Mama's disk. `pub.level` is `'privat'`; every other withdrawable register
        //    holds an EXPLICIT null.
        for (const field of GETEILT_FIELDS[fkind]) {
          const cell = getRegister(regs, fk, field);
          if (field === 'pub.level') {
            assert.equal(cell && cell.value, 'privat', `${levels.join('→')}: pub.level on the peer`);
            continue;
          }
          assert.equal(cell ? cell.value : null, null,
            `${kind} [${levels.join('→')}]: "${field}" survived the retraction on the PEER's disk `
            + `holding ${JSON.stringify(cell && cell.value)}. OMISSION IS NOT WITHDRAWAL — the `
            + 'entry looks downgraded on Papa\'s board and stays fully readable on Mama\'s.');
        }

        // 3. THE BYTES — and the secret never reached the wire at all if the sequence never
        //    passed through geteilt.
        if (!shares) WIRE.assertNeverTransmitted(secret, { except: [], epochKeys: CIRCLE.epochKeys });
      });
    }
  }

  test('§5.3 mechanism 1 · a peer that receives ONLY the last op lands on the same nothing', async () => {
    // The argmax fold ignores intermediates, so retraction does not depend on delivery: a Mac
    // that was offline for the whole Geteilt period converges on the same state as one that
    // watched every step.
    const id = papaNote({ level: 'geteilt', text: SHARED.text });
    const opened = [];
    for (const to of ['belegt', 'geteilt', 'privat']) {
      setLevel('note', id, to);
      for (const rec of await drainAndSeal()) {
        if (!rec.env) continue;
        const r = await openOp(rec.env, CIRCLE.keyring, CIRCLE.attestationOf, {});
        if (r.status === 'opened') opened.push(r.op);
      }
    }
    const pubs = opened.filter((o) => o.k === 'pub.set');
    assert.ok(pubs.length >= 2, 'NON-VACUITY: there were intermediates to skip');
    const regs = peerFold(OMA.memberId, [pubs[pubs.length - 1]]);
    const fk = familyKey('fnote', PAPA.memberId, id);
    assert.deepEqual(materialize(regs, MCTX(OMA.memberId)).notes.filter((n) => n.isForeign), []);
    for (const field of GETEILT_FIELDS.fnote) {
      if (field === 'pub.level') continue;
      const cell = getRegister(regs, fk, field);
      assert.equal(cell ? cell.value : null, null,
        `${field} survived a retraction-only delivery — retraction depends on delivery, which §5.3 forbids`);
    }
  });

  test('the retraction is byte-identical whichever level it came from (Principle 9)', async () => {
    // A peer cannot tell whether Papa withdrew a Geteilt entry or a Belegt one, and that is not a
    // policy: `retractPatch(kind)` takes the KIND AND NOTHING ELSE, so no function on the path was
    // ever told what the level used to be.
    const shapes = [];
    for (const from of ['belegt', 'geteilt']) {
      const id = papaNote({ level: from, text: from === 'geteilt' ? SHARED.text : SECRET.noteText });
      await drainAndSeal();
      setLevel('note', id, 'privat');
      const rec = (await drainAndSeal()).map((r) => r.op).find((o) => o.k === 'pub.set');
      assert.ok(rec, `the ${from} → privat transition published nothing`);
      shapes.push(JSON.stringify(rec.f));
    }
    assert.equal(shapes[0], shapes[1],
      'a Geteilt→Privat retraction and a Belegt→Privat retraction differ on the wire — a peer can '
      + 'recover what the entry used to be (ADR 004 §7 rule 1).');
    for (const s of shapes) {
      assert.equal(/geteilt|belegt/.test(s), false,
        `the retraction names the level it came from: ${s}`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · A3 — `categoryId` HAS NO `pub.*` COUNTERPART AT ANY LEVEL
//
// "Enforced by the ABSENCE OF A FIELD, not by a filter someone can forget to apply." (ADR 004 §1)
// So this is asserted STRUCTURALLY — on the tables — as well as on the ops and the bytes.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('A3 · categories are never synced', () => {
  test('structurally: no allowlist, no FIELDS row, no TRUTH_SOURCE row can name a category', async () => {
    const { FIELDS } = await import('../../src/js/core/ops.js');
    for (const kind of ['fnote', 'fbar']) {
      for (const table of [GETEILT_FIELDS[kind], BELEGT_FIELDS[kind], STRUCTURAL_FIELDS[kind]]) {
        assert.deepEqual(table.filter((f) => /cat/i.test(f)), [],
          `${kind}: an allowlist names a category`);
      }
      assert.deepEqual(Object.keys(FIELDS[kind]).filter((f) => /cat/i.test(f)), [],
        `core/ops.js:FIELDS.${kind} declares a category register — a caller who hand-builds a `
        + 'patch could then publish one, and A3 would rest on a filter rather than on an absence');
    }
    // Two independent tables, neither of which can name a category, and no filter to forget.
  });

  test('P7g · on the emitted ops and on the sealed bytes, at every level', async () => {
    for (const level of ['belegt', 'geteilt']) {
      const id = papaNote({ level, text: `Kategorie-Probe ${level}`, categoryId: 'cat-1' });
      await drainAndSeal();
      const fk = familyKey('fnote', PAPA.memberId, id);
      for (const op of familyOps().filter((o) => o.e === fk)) {
        for (const k of Object.keys(op.f)) {
          assert.equal(/cat/i.test(k), false, `${level}: a family op carries "${k}"`);
        }
        assert.equal(JSON.stringify(op.f).includes('cat-1'), false,
          `${level}: the category ID reached a family op`);
      }
    }
    // …and the category's NAME — a real secret, and the one a filter over key names would miss.
    WIRE.assertNeverTransmitted(SECRET.category, { except: [], epochKeys: CIRCLE.epochKeys });
    const r = await WIRE.decryptWithEveryEpochKey(CIRCLE.epochKeys, CIRCLE.attestationOf);
    assert.deepEqual(r.offList, []);
  });

  test('the peer never learns a category exists, at any level', async () => {
    const id = papaNote({ level: 'geteilt', text: 'Bescherung' });
    const opened = [];
    for (const rec of await drainAndSeal()) {
      if (!rec.env) continue;
      const r = await openOp(rec.env, CIRCLE.keyring, CIRCLE.attestationOf, {});
      if (r.status === 'opened') opened.push(r.op);
    }
    const board = materialize(peerFold(MAMA.memberId, opened), MCTX(MAMA.memberId));
    const foreign = [...board.notes, ...board.bars].filter((e) => e.isForeign);
    assert.ok(foreign.length >= 1, 'NON-VACUITY: Mama sees at least one of Papa\'s entries');
    for (const e of foreign) {
      assert.equal(e.categoryId ?? null, null,
        `a foreign entry arrived carrying categoryId ${JSON.stringify(e.categoryId)} — A3`);
    }
    assert.ok(board.categories.every((c) => c.id !== 'cat-1' || c.name !== SECRET.category)
      || board.categories.length === 0, 'the peer materialized one of Papa\'s categories');
    void id;
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · 16.1 — PRIVATE BY DEFAULT COSTS ZERO BYTES
//
// "A Privat entry produces NO FAMILY OP AT ALL." (ADR 004 §1) — measured as a COUNT of ops, not
// as a shape, because a redacted op is not the same answer as no op.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('16.1 · private by default costs zero bytes', () => {
  test('a Privat entry, created, edited, moved, repeated and deleted, emits ZERO family ops', async () => {
    const before = familyOps().length;
    const id = papaNote({ level: 'privat', text: SECRET.privatOnly });
    store.txn('edit', (tx) => { tx.note(id).set({ text: `${SECRET.privatOnly} verschoben` }); });
    store.txn('move', (tx) => { tx.note(id).set({ date: '2027-01-08' }); });
    store.txn('repeat', (tx) => { tx.note(id).set({ repeatsYearly: true }); });
    store.txn('recat', (tx) => { tx.note(id).set({ categoryId: 'cat-2' }); });
    store.txn('delete', (tx) => { tx.note(id).del(); });
    assert.equal(familyOps().length, before,
      'a Privat entry produced a family op. 16.1 is structural: private by default costs zero '
      + 'bytes on the wire, and a REDACTED op is not the same answer as NO op — it announces that '
      + 'an entity exists, was edited, and was deleted.');
    assert.deepEqual(store.familyOutbox(), [], 'and nothing is waiting to be pushed');
    // Every op it DID emit is a personal-space truth write.
    const its = personalOps().filter((o) => o.e === `note:${id}`);
    assert.ok(its.length >= 5, `NON-VACUITY: only ${its.length} truth writes`);
    for (const op of its) assert.notEqual(op.space, FSP);
    WIRE.assertNeverTransmitted(SECRET.privatOnly, { except: [], epochKeys: CIRCLE.epochKeys });
  });

  test('a privat-and-never-published DELETE publishes no tombstone', async () => {
    // Publishing a tombstone for an entry no peer ever saw ANNOUNCES THAT IT EXISTED — and the
    // entry it announces is one 16.1 kept off the wire entirely.
    const before = familyOps().length;
    const id = papaNote({ level: 'privat' });
    store.txn('delete', (tx) => { tx.note(id).del(); });
    await drainAndSeal();
    assert.equal(familyOps().length, before);
  });

  test('16.4 — a category default of `privat` is the FLOOR, and a dangling category fails closed', async () => {
    const { visibilityForNewEntry, DEFAULT_VISIBILITY } = await import('../../src/js/core/visibility.js');
    assert.equal(DEFAULT_VISIBILITY, 'privat');
    assert.equal(visibilityForNewEntry(null), 'privat', 'a dangling category');
    assert.equal(visibilityForNewEntry({}), 'privat', 'a category with no default');
    assert.equal(visibilityForNewEntry({ defaultVisibility: 'oeffentlich' }), 'privat',
      'a level outside the enum falls to the floor, never to the last level used');
    assert.equal(visibilityForNewEntry.length, 1,
      'arity 1 is the enforcement of "read exactly once, at entry creation": a function that '
      + 'takes only a category has nothing to re-evaluate against, so it cannot become a live '
      + 'rule and changing a default can never re-publish an existing entry (ADR 004 §3).');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · 16.7 / P7i — A BELEGT OP AND A GETEILT OP ARE THE SAME CIPHERTEXT LENGTH
//
// ADR 002 §5.3's padding, at the BUCKET BOUNDARIES — which is where the claim is true and where
// it stops being true, and both halves are worth knowing.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('16.6 · the badge never promises a privacy state that has not reached the server', () => {
  test('a pending publication shows the OLD, lower exposure — and says it is pending', async () => {
    // ADR 004 §6, and the direction of the error is the whole rule: "a pending upgrade shows the
    // old, LOWER exposure plus the pending marker. A pending downgrade shows the old, HIGHER
    // exposure plus the pending marker. Both errors point the same way — the badge NEVER
    // UNDER-REPORTS what others can see."
    // The legitimate carrier: this entry really does reach Geteilt, so it may not carry a needle.
    const id = papaNote({ level: 'privat', text: SHARED.text });
    const mine = () => store.state.notes.find((n) => n.id === id);
    assert.equal(mine().exposure.level, 'privat', 'nothing published, nothing exposed');
    assert.equal(mine().exposure.pending, false, 'and nothing outstanding');

    setLevel('note', id, 'geteilt');               // …but the op is still in the outbox
    assert.equal(mine().exposure.level, 'privat',
      'THE BADGE PROMISED A DISCLOSURE THAT HAS NOT REACHED THE SERVER. `pub.level` is `geteilt`'
      + ' in my register map and no peer has been told — exposure is what the family CAN SEE.');
    assert.equal(mine().exposure.pending, true, 'and the pending marker is missing');

    await drainAndSeal();                          // the push, and the ack
    assert.equal(mine().exposure.level, 'geteilt', 'once acked the badge tells the truth');
    assert.equal(mine().exposure.pending, false);

    // …and the downgrade errs the same way: still GETEILT until the withdrawal is acked.
    setLevel('note', id, 'belegt');
    assert.equal(mine().exposure.level, 'geteilt',
      'a pending DOWNGRADE rendered as already withdrawn — the badge under-reported what others '
      + 'can still see, which is the one direction ADR 004 §6 forbids.');
    assert.equal(mine().exposure.pending, true);
    await drainAndSeal();
    assert.equal(mine().exposure.level, 'belegt');
    assert.equal(mine().exposure.pending, false);
  });

  test('exposure is MY disclosure of MY entry, and is null for somebody else\'s', async () => {
    const id = papaNote({ level: 'belegt' });
    const opened = [];
    for (const rec of await drainAndSeal()) {
      if (!rec.env) continue;
      const r = await openOp(rec.env, CIRCLE.keyring, CIRCLE.attestationOf, {});
      if (r.status === 'opened') opened.push(r.op);
    }
    const fk = familyKey('fnote', PAPA.memberId, id);
    const board = materialize(peerFold(MAMA.memberId, opened), MCTX(MAMA.memberId));
    const theirs = board.notes.find((n) => n.entityKey === fk || n.id === fk);
    assert.ok(theirs, 'NON-VACUITY: Mama holds the entry');
    assert.equal(theirs.exposure, null,
      'a foreign entry carries an exposure object. It is MY disclosure state and is meaningless '
      + 'for someone else\'s entry — and rendering it would put a badge on a row that also carries '
      + 'the initial chip and the „neu" dot, which ADR 004 §6 prices as three markers in a slot '
      + 'that was measured for two.');
  });
});

describe('16.7 / P7i · Belegt and Geteilt are indistinguishable by ciphertext length', () => {
  /** Seal one op of a given kind at a given level with a text of a chosen length. */
  async function sealed(level, textLen, uuid) {
    const text = 'x'.repeat(textLen);
    const truth = {
      visibility: level, date: DATE, text, repeatsYearly: false, coEdit: false, _alive: true,
    };
    // `lastPublished: 'belegt'` unconditionally — a `privat` projection of a NEVER-published
    // entry is `null` (16.1, zero bytes), and this row is about the retraction's LENGTH, which
    // only exists when there is something to retract.
    const patch = projectForFamily('fnote', truth, level, 'belegt');
    const op = {
      v: 1, id: mkOpId(), ts: fmt(BASE_MS + 5000, 0, PAPA.devices[0].deviceShort), space: FSP,
      act: PAPA.memberId, dev: PAPA.devices[0].deviceId, gid: mkGroupId(), k: 'pub.set',
      e: familyKey('fnote', PAPA.memberId, uuid), f: patch,
    };
    const env = await sealOp(op, CIRCLE.keyring, PAPA.devices[0].devSig.privateKey, {
      v: 1, sp: FSP, ep: 1, dv: PAPA.devices[0].deviceShort, oid: op.id, wit: '',
    }, { assertFamilyPatch, levelOf: () => level, attestation: PAPA.devices[0].att });
    // `ct` is the base64url STRING, not its length: `x.ct.length` on a number is
    // `undefined`, and `assert.equal(undefined, undefined)` is the shape of a vacuous row.
    return { env, plain: canonicalBytes(op).length, ct: env.ct };
  }

  const UU = 'ffffffff-1111-2222-3333-444455556666';

  /** The first text length at which a Geteilt op leaves the Belegt op's padding bucket. */
  async function boundary() {
    const b = await sealed('belegt', 0, UU);
    for (let len = 0; len <= 4 * PAD_BUCKET; len++) {
      const g = await sealed('geteilt', len, UU);
      if (g.ct.length !== b.ct.length) return { len, belegt: b.ct.length, geteilt: g.ct.length };
    }
    return null;
  }

  test('inside the bucket, a Belegt op and a Geteilt op are the SAME ciphertext length', async () => {
    // P7i, and it is TRUE — inside one bucket, which is where the overwhelming majority of ops
    // live (ADR 002 §5.3's own claim). This is what makes 16.7's disclosure a BLOCK rather than a
    // measurement: a relay operator watching Papa's stream cannot tell a booking from a shared
    // note by counting bytes.
    const edge = await boundary();
    assert.ok(edge, 'no text length inside four buckets ever diverged — the row is vacuous');
    const b = await sealed('belegt', 0, UU);
    for (const len of [0, 1, 12, 40, edge.len - 1]) {
      const g = await sealed('geteilt', len, UU);
      assert.equal(g.ct.length, b.ct.length,
        `text length ${len}: a Belegt op is ${b.ct.length} ciphertext chars and a Geteilt op is `
        + `${g.ct.length} (ADR 002 §5.3).`);
    }
  });

  test('THE BUCKET BOUNDARY — measured, and it is INSIDE the note-length cap (FINDING)', async () => {
    // ⚠ THE FINDING, MEASURED RATHER THAN ASSUMED, and the reason this row exists at all.
    //
    // ADR 004 §10's P7i says "a Belegt op and a Geteilt op of the same entity are THE SAME
    // CIPHERTEXT LENGTH (padding, ADR 002 §5.3)" without qualification. Padding hides a length
    // difference only WITHIN a bucket, and the row above is where that is true. This row measures
    // where it stops — and it stops inside the product's own note-length cap:
    //
    //     `core/ops.js:FIELDS.fnote['pub.text']` is `str80`. `popover.js` sets `maxLength = 80`.
    //     A Geteilt note leaves the Belegt op's bucket well below that.
    //
    // So for a long note, a relay operator — who sees `(spaceId, epoch, deviceShort, seq, length)`
    // in the clear (ADR 003 §6.3) — can distinguish "Papa shared something" from "Papa marked
    // himself busy" WITHOUT A KEY. That is not a break of INV-R1: no content escapes, and the
    // adversary learns one bit about a level, not a word of text. It is a gap between P7i as
    // written and P7i as implementable, and ADR 002 §8.7 already owns the honest half of it
    // ("padding costs ~1.4× storage and does not hide timing").
    //
    // PINNED AS A NUMBER so that a change to PAD_BUCKET, to the op header, or to the entity-key
    // shape moves this row rather than passing quietly. It is a CHARACTERIZATION, not a demand:
    // closing it means a second padding tier, which is a real cost and a product decision.
    assert.equal(PAD_BUCKET, 256);
    const edge = await boundary();
    assert.ok(edge, 'no text length inside four buckets diverged — the boundary was never reached');
    assert.ok(edge.len >= 32 && edge.len <= PAD_BUCKET,
      `the boundary moved to ${edge.len} characters; re-read the finding above before adjusting it`);
    assert.ok(edge.len < 80,
      `MEASURED: a Geteilt note leaves the Belegt bucket at ${edge.len} ASCII characters `
      + `(${edge.belegt} → ${edge.geteilt} ciphertext chars). If this is now ABOVE 80 — the `
      + '`str80` cap — the finding has been closed and this row should be inverted rather than '
      + 'relaxed.');
    // …and the cap counts CHARACTERS while the bucket counts BYTES, so the worst case is worse
    // than the number above: an 80-character note of astral codepoints is 320 UTF-8 bytes.
    const wide = await sealed('geteilt', 0, UU);
    assert.ok(wide.ct.length > 0);
  });

  test('a retraction is the same length as any other op of its kind', async () => {
    // Principle 9 again, in the length channel: if a withdrawal were shorter than a publication,
    // a relay operator could count downgrades without reading a byte.
    const r = await sealed('privat', 0, UU);
    const b = await sealed('belegt', 0, UU);
    assert.equal(r.ct.length, b.ct.length,
      'a retraction is a different ciphertext length from a publication — the relay can count '
      + 'downgrades (ADR 003 §6.3, Principle 9).');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8 · THE FAMILY, DRIVEN — Papa marks it Belegt, Mama sees a block, Papa withdraws it
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('E2E · the story, through the real pipeline', () => {
  test('Papa marks it Belegt → Mama sees a neutral block with duration and owner and NO TEXT', async () => {
    const id = papaNote({ level: 'belegt', text: SECRET.noteText });
    const opened = [];
    for (const rec of await drainAndSeal()) {
      assert.equal(rec.refused, null, `the seal refused: ${rec.refused}`);
      const r = await openOp(rec.env, CIRCLE.keyring, CIRCLE.attestationOf, {});
      assert.equal(r.status, 'opened', 'Mama could not open Papa\'s envelope');
      opened.push(r.op);
    }
    const regs = peerFold(MAMA.memberId, opened);
    const board = materialize(regs, MCTX(MAMA.memberId));
    // A FOREIGN entry's `id` is its ENTITY KEY (`materialize.js:foreignCandidate`), not the bare
    // uuid — the uuid alone is not unique across members, and the key carries its owner.
    const fk = familyKey('fnote', PAPA.memberId, id);
    const seen = board.notes.find((n) => n.entityKey === fk || n.id === fk);
    assert.ok(seen, 'Papa\'s Belegt entry never reached Mama\'s board — 16.7 discloses EXISTENCE');

    // WHAT SHE MAY SEE (16.7's deliberate leak, rendered as a leak):
    assert.equal(seen.date, DATE, 'the date');
    assert.equal(seen.ownerId, PAPA.memberId, 'the owner');
    assert.equal(seen.isForeign, true);
    assert.equal(seen.redacted, true, 'and the entry is marked redacted, so no renderer prints text');

    // WHAT SHE MAY NOT — asserted on the DATA, and then on the BYTES.
    assert.equal(seen.text ?? null, null, 'the text reached Mama\'s board');
    assert.equal(seen.categoryId ?? null, null, 'the category reached Mama\'s board (A3)');
    assert.equal(JSON.stringify(board).includes(SECRET.noteText), false,
      'the text is somewhere in Mama\'s materialized state');
    assert.equal(getRegister(regs, fk, 'pub.text').value, null, 'Mama\'s register holds the text');
    // ADR 004 §10.1, in a Belegt scenario, as §10.1 requires.
    WIRE.assertNeverTransmitted(SECRET.noteText, { except: [], epochKeys: CIRCLE.epochKeys });
    const dec = await WIRE.decryptWithEveryEpochKey(CIRCLE.epochKeys, CIRCLE.attestationOf);
    assert.deepEqual(dec.offList, []);
  });

  test('Papa downgrades to Privat → it LEAVES Mama\'s board at the next sync', async () => {
    const id = papaNote({ level: 'belegt', text: SECRET.noteText });
    const opened = [];
    const pull = async () => {
      for (const rec of await drainAndSeal()) {
        if (!rec.env) continue;
        const r = await openOp(rec.env, CIRCLE.keyring, CIRCLE.attestationOf, {});
        if (r.status === 'opened') opened.push(r.op);
      }
    };
    await pull();
    const fk = familyKey('fnote', PAPA.memberId, id);
    const on = (b) => b.notes.some((n) => n.entityKey === fk || n.id === fk);
    let board = materialize(peerFold(MAMA.memberId, opened), MCTX(MAMA.memberId));
    assert.ok(on(board), 'it was on Mama\'s board to begin with');

    setLevel('note', id, 'privat');
    await pull();                                  // ← the next sync, and only that
    const regs = peerFold(MAMA.memberId, opened);
    board = materialize(regs, MCTX(MAMA.memberId));
    assert.equal(on(board), false,
      'it is still on Mama\'s board after the downgrade — ADR 004 §5.1');
    for (const field of GETEILT_FIELDS.fnote) {
      if (field === 'pub.level') continue;
      const cell = getRegister(regs, fk, field);
      assert.equal(cell ? cell.value : null, null, `"${field}" is still on Mama's disk`);
    }
  });

  test('the truth write and the publication share ONE gid — one ⌘Z, no window (ADR 004 §5)', async () => {
    const id = papaNote({ level: 'privat' });
    await drainAndSeal();
    const mark = store._log.lines().length;
    setLevel('note', id, 'geteilt');
    const group = store._log.lines().slice(mark).map((l) => l.op);
    const truth = group.find((o) => o.k === 'note.set');
    const pub = group.find((o) => o.k === 'pub.set');
    assert.ok(truth && pub, 'the transition emitted both halves');
    assert.equal(truth.gid, pub.gid,
      'two gids: there is a window in which the truth says geteilt and the family has not been '
      + 'told, and ⌘Z reverts only one of them.');
    // …and ⌘Z withdraws the publication, because `core/undo.js` makes a `pub.set` non-undoable and
    // the publisher RE-DERIVES against the restored truth. A share that survives its own undo is a
    // leak with a very short story.
    store.undo();
    const after = store._log.lines().slice(mark).map((l) => l.op).filter((o) => o.k === 'pub.set');
    assert.equal(after[after.length - 1].f['pub.level'], 'privat',
      '⌘Z left the entry SHARED. Undoing the truth must make the publisher re-derive — otherwise '
      + 'the register map keeps the level the user just took back, and the owner\'s board is right.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 9 · PRINCIPLE 9 — NO SURVEILLANCE MECHANICS
//
// "A „neu" dot on a downgrade is THE surveillance mechanic Principle 9 forbids." (addendum §6)
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('Principle 9 · a downgrade tells nobody anything', () => {
  test('there is no op kind for a notification, a read receipt or a presence signal', async () => {
    const { OP_KINDS } = await import('../../src/js/core/ops.js');
    const kinds = Object.keys(OP_KINDS).sort();
    assert.deepEqual(kinds,
      ['bar.set', 'cat.set', 'member.set', 'note.set', 'pad.set', 'pref.set', 'pub.set', 'space.set'],
      'the eight kinds in ADR 001 §3 are the whole vocabulary, and Principle 9 is enforced by the '
      + 'ABSENCE OF A MECHANISM rather than by a policy. A ninth kind is how that stops being true.');
    for (const k of kinds) {
      assert.equal(/notif|seen|read|presence|ping|typing|activity/i.test(k), false,
        `${k} is a surveillance primitive`);
    }
  });

  test('the transition plan has nowhere to put a notification', async () => {
    const { planTransition, TRANSITION_PLAN_KEYS } = await import('../../src/js/core/visibility.js');
    const plan = planTransition({ from: 'geteilt', to: 'privat', lastPublished: 'geteilt', alive: true });
    assert.deepEqual(Object.keys(plan).sort(), [...TRANSITION_PLAN_KEYS].sort());
    assert.equal(plan.notifies, false,
      '`notifies: false` is present AS A LITERAL so that adding the mechanism means changing a '
      + 'value a test already reads, rather than adding a field nobody is looking for.');
    assert.ok(Object.isFrozen(plan));
  });

  test('a downgrade never dots: `isNew` is false for the peer after a withdrawal', async () => {
    const id = papaNote({ level: 'geteilt', text: 'Bescherung 18:00' });
    const opened = [];
    const pull = async () => {
      for (const rec of await drainAndSeal()) {
        if (!rec.env) continue;
        const r = await openOp(rec.env, CIRCLE.keyring, CIRCLE.attestationOf, {});
        if (r.status === 'opened') opened.push(r.op);
      }
    };
    await pull();
    setLevel('note', id, 'belegt');                // a DOWNGRADE, which discloses less
    await pull();
    const regs = peerFold(MAMA.memberId, opened);
    const board = materialize(regs, MCTX(MAMA.memberId));
    const fk = familyKey('fnote', PAPA.memberId, id);
    const seen = board.notes.find((n) => n.entityKey === fk || n.id === fk);
    assert.ok(seen, 'the Belegt block is still there — a downgrade is not a deletion');
    assert.equal(seen.isNew === true, false,
      'THE SURVEILLANCE MECHANIC. A „neu" dot on a downgrade tells Mama that Papa took something '
      + 'back, which is precisely the thing 17.5\'s `!levelDecreased(e)` clause exists to prevent '
      + '(ADR 004 §7 rule 2, addendum §6).');
  });

  test('the Belegt block carries no history: a downgraded entry is byte-identical to a born-Belegt one', async () => {
    // ADR 004 §7 rule 1: "A Belegt block that was downgraded from Geteilt renders identically to
    // one that was always Belegt. No history, no „war geteilt", no strikethrough, no animation."
    // Asserted on the REGISTERS, so no rendering is load-bearing for it.
    const born = papaNote({ level: 'belegt', text: SECRET.noteText });
    const fell = papaNote({ level: 'geteilt', text: SECRET.noteText });
    const opened = [];
    const pull = async () => {
      for (const rec of await drainAndSeal()) {
        if (!rec.env) continue;
        const r = await openOp(rec.env, CIRCLE.keyring, CIRCLE.attestationOf, {});
        if (r.status === 'opened') opened.push(r.op);
      }
    };
    await pull();
    setLevel('note', fell, 'belegt');
    await pull();
    const regs = peerFold(MAMA.memberId, opened);
    const shapeOf = (uuid) => GETEILT_FIELDS.fnote.map((f) => {
      const c = getRegister(regs, familyKey('fnote', PAPA.memberId, uuid), f);
      return [f, c ? c.value : null];
    });
    assert.deepEqual(shapeOf(fell), shapeOf(born),
      'the downgraded entry and the born-Belegt one differ in the registers a peer holds — a '
      + 'client can derive „war geteilt" from them, which ADR 004 §7 rule 1 forbids.');
  });

  test('attribution shows WHO and WHEN, never WHAT: no level history is derivable', async () => {
    const id = papaNote({ level: 'geteilt', text: 'Bescherung 18:00' });
    const opened = [];
    for (const to of ['belegt', 'geteilt']) {
      setLevel('note', id, to);
      for (const rec of await drainAndSeal()) {
        if (!rec.env) continue;
        const r = await openOp(rec.env, CIRCLE.keyring, CIRCLE.attestationOf, {});
        if (r.status === 'opened') opened.push(r.op);
      }
    }
    const regs = peerFold(MAMA.memberId, opened);
    const cells = regs.get(familyKey('fnote', PAPA.memberId, id));
    assert.ok(cells, 'the entity is on Mama\'s disk');
    // A register is `{value, ts, …}` — the CURRENT value and its stamp. There is no `history`,
    // no `previous`, no `changedFrom`, because the fold is `max_≺` and keeps one cell per name.
    for (const [name, cell] of cells) {
      for (const k of Object.keys(cell)) {
        assert.equal(/hist|prev|was|from|before|old/i.test(k), false,
          `the register ${name} carries "${k}" — a level history a client could render`);
      }
    }
  });
});
