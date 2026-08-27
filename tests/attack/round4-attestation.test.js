// ─────────────────────────────────────────────────────────────────────────────
// ROUND 4 — ADVERSARY, ATTACK 4: F-10's `attestationOf` LOOKUP
//
// F-10 gave `AuthzResult` the table `envelope.js` needs pre-decrypt: `deviceShort →
// DeviceAttestation`, keyed by the short ALONE because `op.act` is not knowable before the
// envelope opens. ADR 002 §2.3's four acceptance conditions are what make that keying a
// FUNCTION, and `authz.js` enforces all four. Two of the four hold under attack here (§1), and
// the register-name forgery is refused (§1).
//
// What did not hold was the claim the code made ABOUT the deviceId, at `authz.js:759-761`:
//
//     "A deviceId can only ever map to one member: the blob is signed over a payload naming
//      `memberId`, and the register it lives in must agree with it, so a second member cannot
//      adopt somebody else's attested device."
//
// The payload names `memberId` and `deviceId`. The four conditions bind `memberId` to the
// housing record and `deviceShort` to the register name. NOTHING binds `deviceId` to anybody.
// So Eve minted her OWN, fully valid, fully signed attestation whose `deviceId` was Mama's,
// housed it in her OWN record under her OWN short, and — because `memberOfDevice` was
// first-writer-wins over an order Eve could choose by backdating — `memberOfDevice(mamaDevice)`
// answered `EVE`, with `shortCollisions` empty so nothing reported it. §2.
//
// ─────────────────────────────────────────────────────────────────────────────
// DISPOSITION AFTER THE FIX PASS (2026-08-27)
//
// §2 (R4-13), §3 (R4-14 / I-3) and §4 (R4-15) are CLOSED and their rows are INVERTED in place —
// each now asserts the refusal rather than the defect. The fix is structural, in the shape ADR
// 001 §4.4 used for ownership: a `deviceId` is a self-asserted LABEL, so the fold stopped
// publishing a map from a label to an owner. `memberOfDevice` is the sole-claimant function,
// `deviceIdCollisions` reports every contested label, `attestationOf` REFUSES a contested short
// instead of resolving it, and the `attestOpen` agreement check compares all six fields.
// R4-13d is new and is the load-bearing row: it proves the stolen label confers nothing a
// freshly invented one would not, which is what "there is nothing to forge" has to mean.
// R4-14c is new: the half of ADR 001 §1.2 a pure fold CAN enforce without a hash.
//
// §5 (R4-16) is UNCHANGED and still a GAP row, green because the gap is real: there is no device
// revocation anywhere in the fold. That is deliberate and now written down — ADR 002 §2.3's
// "Revocation — the gap, and who owns it", owned by WP-9. Do not close it here.
//
// Rows tagged `SUCCEEDED (defect)` / `(gap)` are green BECAUSE the defect is there.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { foldAuthorized } from '../../src/js/core/authz.js';
import { validateOp } from '../../src/js/core/ops.js';
import { memberKey } from '../../src/js/core/entities.js';
import { fmt } from '../../src/js/core/stamp.js';
import { b64u, ub64 } from '../../src/js/core/b64.js';
import { canonicalBytes, utf8, utf8Decode } from '../../src/js/core/canon.js';
import { pad22, short16, FSP } from './_kit.js';

const ME = `mem_${pad22('ME')}`;
const MAMA = `mem_${pad22('MAMA')}`;
const EVE = `mem_${pad22('EVE')}`;
const dev = (t) => ({ id: `dev_${pad22(t)}`, short: short16(t) });
const D_ME = dev('DME');
const D_MAMA = dev('DMAMA');
const D_EVE = dev('DEVE');

const BASE = 1787836800000;
const DAY = 86400000;
let seq = 0;
const rid = (t) => pad22(`${t}${++seq}`);

/**
 * ADR 002 §2.3's register value: `b64u(canonicalJSON(att)) + '.' + b64u(sig)`.
 *
 * `keysOf` is the device whose REAL keypairs the payload carries, and it defaults to `deviceId`
 * only because for an honest attestation the two coincide. They must be separable: `deviceId` is
 * a random label its author asserts, `sigPubRaw` is the actual public point of the hardware
 * doing the signing, and the whole of R4-13 is the gap between them. A forgery that used the
 * victim's keys would not be a forgery — it would be the victim's device.
 */
function attBlob({ memberId, deviceId, deviceShort, keysOf = deviceId }) {
  const att = {
    memberId,
    deviceId,
    deviceShort,
    sigPubRaw: b64u(utf8(`sigpub:${keysOf}`)),
    kexPubRaw: b64u(utf8(`kexpub:${keysOf}`)),
    createdAt: '2026-08-25',
  };
  return `${b64u(canonicalBytes(att))}.${b64u(utf8(`sig:${memberId}:${deviceId}`))}`;
}

/**
 * Stands in for the real `verifyAttestation`. It checks what a signature can check: that the blob
 * was signed by the member the payload names. It CANNOT check `deviceShort ↔ sigPubRaw` — that is
 * §5.2.2's P2 and needs SHA-256 — and it has nothing at all to say about `deviceId`.
 */
const verifier = (memberId, blob) => {
  try {
    const d = blob.indexOf('.');
    const att = JSON.parse(utf8Decode(ub64(blob.slice(0, d))));
    return att.memberId === memberId && utf8Decode(ub64(blob.slice(d + 1))) === `sig:${att.memberId}:${att.deviceId}`;
  } catch { return false; }
};

function mk(k, e, f, o) {
  const op = { v: 1, id: o.id ?? rid('op'), ts: o.ts, space: o.space, act: o.act, dev: o.dev, gid: o.gid ?? rid('g'), k, e, f };
  const v = validateOp(op);
  if (!v.ok) throw new Error(`test fixture built an invalid op: ${v.reason}`);
  return Object.freeze(op);
}
const attestOp = (housing, regShort, blob, ms, byDev) =>
  mk('member.set', memberKey(housing), { [`dev.${regShort}`]: blob }, { act: housing, dev: byDev, ts: fmt(ms, 0, short16('T')), space: FSP });

const fold = (ops, over = {}) => foldAuthorized(ops, { me: ME, attestVerify: verifier, ...over });
const reasons = (r) => r.rejected.map((o) => r.rejectionOf(o.id).reason).sort();

/** Mama's honest record, always present. */
const MAMA_HONEST = () => attestOp(
  MAMA, D_MAMA.short, attBlob({ memberId: MAMA, deviceId: D_MAMA.id, deviceShort: D_MAMA.short }), BASE, D_MAMA.id,
);

// ─────────────────────────────────────────────────────────────────────────────
// 1. WHAT THE FOUR CONDITIONS DO HOLD
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-12 · the §2.3 conditions that survive attack', () => {
  test('R4-12a HELD · copying a peer\'s blob verbatim into my own record is refused (condition 3)', () => {
    const mamaBlob = attBlob({ memberId: MAMA, deviceId: D_MAMA.id, deviceShort: D_MAMA.short });
    const r = fold([MAMA_HONEST(), attestOp(EVE, D_MAMA.short, mamaBlob, BASE + 1, D_EVE.id)]);
    assert.deepEqual(reasons(r), ['badAttestation']);
    assert.equal(r.attestationOf(D_MAMA.short).memberId, MAMA, 'the lookup still answers Mama');
  });

  test('R4-12b HELD · forging the register name (dev.<X> holding a blob for short Y) is refused (condition 2)', () => {
    const eveBlob = attBlob({ memberId: EVE, deviceId: D_EVE.id, deviceShort: D_EVE.short });
    const r = fold([attestOp(EVE, D_MAMA.short, eveBlob, BASE, D_EVE.id)]);
    assert.deepEqual(reasons(r), ['badAttestation']);
    assert.equal(r.attestationOf(D_MAMA.short), null);
  });

  test('R4-12c HELD · writing into somebody else\'s member record is refused (condition 1)', () => {
    const blob = attBlob({ memberId: MAMA, deviceId: D_MAMA.id, deviceShort: D_MAMA.short });
    const bad = mk('member.set', memberKey(MAMA), { [`dev.${D_MAMA.short}`]: blob },
      { act: EVE, dev: D_EVE.id, ts: fmt(BASE, 0, short16('T')), space: FSP });
    const r = fold([bad]);
    assert.deepEqual(reasons(r), ['notSelf']);
  });

  test('R4-12d HELD · `attestationOf` never throws on peer-sourced junk', () => {
    const r = fold([MAMA_HONEST()]);
    for (const junk of [null, undefined, 42, {}, [], '', 'OUOUOUOUOUOUOUOU', short16('nobody')]) {
      assert.equal(r.attestationOf(junk), null, `attestationOf(${JSON.stringify(junk)})`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE DEVICE ID IS NOT BOUND TO ANYBODY — and this one leaves no trace
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-13 · adopting a peer\'s deviceId', () => {
  // INVERTED 2026-08-27. The defect is closed, structurally: a `deviceId` is a self-asserted
  // LABEL, and the fold no longer publishes a map from a label to an owner. `memberOfDevice` is
  // the sole-claimant function — one claimant answers, two or more answer `null` — and the
  // contest is published on `deviceIdCollisions`. See `authz.js` §2, "a deviceId is a label, not
  // an identity". The attestation itself is still ADMITTED, deliberately: refusing both claims
  // would let anybody un-attest an honest peer's device by naming its label, which is the DoS
  // the sole-claimant rule exists to avoid.
  //
  // The forged blob carries EVE's OWN keys (`keysOf`) — the realistic attack. Only the label
  // is Mama's; if the keys were Mama's too there would be nothing forged.
  const eveClaimsMama = () => attBlob({
    memberId: EVE, deviceId: D_MAMA.id, deviceShort: D_EVE.short, keysOf: D_EVE.id,
  });

  test('R4-13a REFUSED · Eve may still write the label, but it no longer resolves to anybody', () => {
    const r = fold([MAMA_HONEST(), attestOp(EVE, D_EVE.short, eveClaimsMama(), BASE - DAY, D_EVE.id)]);

    assert.deepEqual(reasons(r), [],
      'still admitted — a rejection here would be a DoS handle on an honest peer\'s device');
    assert.equal(r.memberOfDevice(D_MAMA.id), null,
      'FIXED: two claimants, so the label has no owner — not Eve, and not "whoever backdated"');
    assert.deepEqual(r.deviceIdCollisions, [D_MAMA.id],
      'FIXED: and the contest is REPORTED, which is the signal that did not exist before');
    // Both member records still hold their own attestation. The pair is what stage 0b reads and
    // the pair is untouched — Mama keeps her device, and Eve has a device wearing a stolen label.
    assert.ok([...(r.attestedDevices.get(MAMA) ?? [])].includes(D_MAMA.id), 'Mama is not un-attested');
    assert.equal(r.attestedDevices.get(EVE).size, 1, 'and Eve gained no extra device, only a name');
  });

  test('R4-13b REFUSED · no stamp decides it any more, because nothing is decided', () => {
    const early = fold([MAMA_HONEST(), attestOp(EVE, D_EVE.short, eveClaimsMama(), BASE - DAY, D_EVE.id)]);
    const late = fold([MAMA_HONEST(), attestOp(EVE, D_EVE.short, eveClaimsMama(), BASE + DAY, D_EVE.id)]);
    assert.equal(early.memberOfDevice(D_MAMA.id), null, 'backdated: nobody');
    assert.equal(late.memberOfDevice(D_MAMA.id), null, 'post-dated: nobody');
    assert.deepEqual(early.deviceIdCollisions, late.deviceIdCollisions,
      'FIXED: the answer no longer moves with a number the attacker picks');
  });

  test('R4-13c · it is a function of the SET, not of arrival order', () => {
    const a = MAMA_HONEST();
    const b = attestOp(EVE, D_EVE.short, eveClaimsMama(), BASE - DAY, D_EVE.id);
    assert.equal(fold([a, b]).memberOfDevice(D_MAMA.id), fold([b, a]).memberOfDevice(D_MAMA.id));
    assert.deepEqual(fold([a, b]).deviceIdCollisions, fold([b, a]).deviceIdCollisions,
      'the report must not depend on arrival, or two Macs would disagree about a contest');
  });

  test('R4-13d · the label buys nothing: a FRESH label admits exactly the same ops', () => {
    // The proof that there is nothing left to forge. Whatever Eve can do holding Mama's label,
    // she can do holding a label she invented — so adopting Mama's is not a capability, it is a
    // name collision. She still cannot author as Mama: stage 0b gates `op.dev` against
    // `op.act`'s OWN record, and the envelope gates the signature under `att.sigPubRaw`.
    const fresh = dev('DFRESH');
    const withStolen = attestOp(EVE, D_EVE.short, eveClaimsMama(), BASE - DAY, D_EVE.id);
    const withFresh = attestOp(EVE, D_EVE.short, attBlob({
      memberId: EVE, deviceId: fresh.id, deviceShort: D_EVE.short, keysOf: D_EVE.id,
    }), BASE - DAY, D_EVE.id);

    const opFrom = (devId) => mk('member.set', memberKey(EVE), { displayName: 'Eve' },
      { act: EVE, dev: devId, ts: fmt(BASE + 10, 0, short16('T')), space: FSP });

    const stolen = fold([MAMA_HONEST(), withStolen, opFrom(D_MAMA.id)]);
    const invented = fold([MAMA_HONEST(), withFresh, opFrom(fresh.id)]);
    assert.deepEqual(reasons(stolen), reasons(invented),
      'identical outcomes ⇒ the stolen label conferred nothing');

    // And the one thing she wanted — authoring AS Mama from that device — is still refused.
    const asMama = mk('member.set', memberKey(MAMA), { displayName: 'gekapert' },
      { act: MAMA, dev: D_MAMA.id, ts: fmt(BASE + 11, 0, short16('T')), space: FSP });
    const r = fold([withStolen, asMama]);   // no honest Mama attestation in this set
    assert.deepEqual(reasons(r), ['unattestedDevice'],
      'stage 0b reads `op.act`\'s OWN record, so Eve\'s claim does not attest Mama');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. I-3, CONFIRMED — the deviceShort collision, resolved in the attacker's favour
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-14 · I-3: a contested short is not a credential', () => {
  // INVERTED 2026-08-27. The contest used to be resolved minimal-under-`≺`, which handed the
  // lookup to whoever backdated. It is no longer resolved at all: `attestationOf` refuses a
  // contested short. `null` is a DEFINED outcome there — ADR 002 §5.2.2 P1 parks the sealed
  // envelope, unopened, and a park is re-evaluable (§5.2.5) — so a squatter costs liveness and
  // never gains a key. `shortCollisions` finally has a reader: `attestationOf` itself.
  test('R4-14a REFUSED · attestationOf(mamaShort) hands `openOp` nothing at all', () => {
    const eveBlob = attBlob({ memberId: EVE, deviceId: D_EVE.id, deviceShort: D_MAMA.short });
    const r = fold([MAMA_HONEST(), attestOp(EVE, D_MAMA.short, eveBlob, BASE - DAY, D_EVE.id)]);

    assert.deepEqual(reasons(r), [], 'all four acceptance conditions still pass — nothing pure refuses it');
    assert.equal(r.attestationOf(D_MAMA.short), null,
      'FIXED: the backdated squatter takes nothing; P1 parks the envelope instead');
    assert.deepEqual(r.shortCollisions, [D_MAMA.short], 'and the contest is reported, as before');

    // The bound: it is a stall, not a loss. Mama's own attestation is still in her record and
    // still attests her device, so stage 0b keeps admitting her plaintext ops.
    assert.ok([...(r.attestedDevices.get(MAMA) ?? [])].includes(D_MAMA.id));
  });

  test('R4-14b · backdating no longer changes the answer, in either direction', () => {
    const eveBlob = attBlob({ memberId: EVE, deviceId: D_EVE.id, deviceShort: D_MAMA.short });
    for (const ms of [BASE - DAY, BASE + DAY]) {
      const r = fold([MAMA_HONEST(), attestOp(EVE, D_MAMA.short, eveBlob, ms, D_EVE.id)]);
      assert.equal(r.attestationOf(D_MAMA.short), null, `stamp ${ms}`);
    }
  });

  test('R4-14c · one signing key under two shorts is contested WITHOUT hashing anything', () => {
    // The half of ADR 001 §1.2 a pure synchronous fold can actually enforce. P2
    // (`crock32(SHA-256(sigPubRaw)[0..10]) === deviceShort`) needs a hash and lives in `openOp`
    // — but "one key, one short" is an equality, and it catches the squat that lands BEFORE its
    // victim's own attestation, when there is not yet a second member record to collide with.
    const twin = attBlob({ memberId: EVE, deviceId: D_EVE.id, deviceShort: short16('TWIN'), keysOf: D_EVE.id });
    const own = attBlob({ memberId: EVE, deviceId: D_EVE.id, deviceShort: D_EVE.short, keysOf: D_EVE.id });
    const r = fold([
      attestOp(EVE, D_EVE.short, own, BASE, D_EVE.id),
      attestOp(EVE, short16('TWIN'), twin, BASE + 1, D_EVE.id),
    ]);
    assert.deepEqual(r.shortCollisions, [D_EVE.short, short16('TWIN')].sort(),
      'both shorts are contested — one of the two must be a lie about §1.2');
    assert.equal(r.attestationOf(D_EVE.short), null);
    assert.equal(r.attestationOf(short16('TWIN')), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE `attestOpen` AGREEMENT CHECK MISSES THE KEY-AGREEMENT POINT
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-15 · "an attestOpen whose answer disagrees counts as a failed verification"', () => {
  // INVERTED 2026-08-27. All SIX fields are compared. `kexPubRaw` is the key-agreement point
  // ADR 002 §4.2 wraps the family space key to, so an opener allowed to disagree about it was a
  // key-injection channel through the one door §2.3 exists to shut.
  test('R4-15a REFUSED · an opener that disagrees about the key-agreement point verifies nothing', () => {
    const lying = (m, b) => {
      const d = b.indexOf('.');
      const att = JSON.parse(utf8Decode(ub64(b.slice(0, d))));
      if (att.memberId !== m) return null;
      return { ...att, kexPubRaw: b64u(utf8('ATTACKER-KEX')), createdAt: '1970-01-01' };
    };
    const r = fold([MAMA_HONEST()], { attestVerify: undefined, attestOpen: lying });
    assert.deepEqual(reasons(r), ['badAttestation'], 'FIXED: the disagreement is a failed verification');
    assert.equal(r.attestationOf(D_MAMA.short), null, 'FIXED: the op is not admitted');
  });

  test('R4-15b HELD · each of the six refuses on its own', () => {
    const base = (over) => (m, b) => {
      const d = b.indexOf('.');
      const att = JSON.parse(utf8Decode(ub64(b.slice(0, d))));
      if (att.memberId !== m) return null;
      return { ...att, ...over };
    };
    const overrides = [
      { memberId: EVE }, { deviceId: D_EVE.id }, { deviceShort: D_EVE.short },
      { sigPubRaw: 'ZZZZ' }, { kexPubRaw: b64u(utf8('ATTACKER-KEX')) }, { createdAt: '1970-01-01' },
    ];
    for (const over of overrides) {
      const r = fold([MAMA_HONEST()], { attestVerify: undefined, attestOpen: base(over) });
      assert.deepEqual(reasons(r), ['badAttestation'], `disagreeing on ${Object.keys(over)[0]}`);
    }
    // The control: an opener that agrees on all six admits. Without this the loop above would
    // pass with the whole agreement check replaced by `return false`.
    const honest = base({});
    assert.deepEqual(reasons(fold([MAMA_HONEST()], { attestVerify: undefined, attestOpen: honest })), []);
  });

  test('R4-15c HELD · the table always comes from the register bytes, never from the opener', () => {
    // Containment, independent of detection. The opener agrees on all six — so verification
    // succeeds — but returns a SEVENTH field and a different object identity. What the table
    // publishes must still be exactly what `parseAttestationBlob` read out of the log, or the
    // injection would be a second, unlogged source of device identity.
    const embellishing = (m, b) => {
      const d = b.indexOf('.');
      const att = JSON.parse(utf8Decode(ub64(b.slice(0, d))));
      if (att.memberId !== m) return null;
      return { ...att, quantumPubRaw: b64u(utf8('ATTACKER-PQ')) };
    };
    const r = fold([MAMA_HONEST()], { attestVerify: undefined, attestOpen: embellishing });
    const a = r.attestationOf(D_MAMA.short);
    assert.deepEqual(reasons(r), [], 'agreeing on all six verifies — an extra field is not a disagreement');
    assert.equal(a.kexPubRaw, b64u(utf8(`kexpub:${D_MAMA.id}`)));
    assert.deepEqual(Object.keys(a).sort(),
      ['createdAt', 'deviceId', 'deviceShort', 'kexPubRaw', 'memberId', 'sigPubRaw'],
      'the opener\'s extra field never reaches the table');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. REPLAY A REVOKED DEVICE — there is nothing to replay past
// ─────────────────────────────────────────────────────────────────────────────

describe('R4-16 · revocation', () => {
  test('R4-16a SUCCEEDED (gap) · the fold has no revocation, and write-once means the register can never be amended', () => {
    const honest = MAMA_HONEST();
    // Mama's laptop is stolen (ADR 002 T3). Try to withdraw the attestation the way ADR 004 §5.1
    // withdraws a field, and the way a later correction would be written.
    const withdraw = mk('member.set', memberKey(MAMA), { [`dev.${D_MAMA.short}`]: null },
      { act: MAMA, dev: D_MAMA.id, ts: fmt(BASE + DAY, 0, short16('T')), space: FSP });
    const replace = attestOp(MAMA, D_MAMA.short,
      attBlob({ memberId: MAMA, deviceId: dev('DNEW').id, deviceShort: D_MAMA.short }), BASE + 2 * DAY, D_MAMA.id);

    const r = fold([honest, withdraw, replace]);
    assert.ok(r.attestationOf(D_MAMA.short), 'GAP: the stolen device is still attested');
    assert.ok([...(r.attestedDevices.get(MAMA) ?? [])].includes(D_MAMA.id),
      'GAP: stage 0b still admits its ops — revocation lives in ADR 003 / the epoch bump, nowhere in the fold');
    assert.ok(reasons(r).includes('writeOnce') || reasons(r).includes('badAttestation'),
      'and the correction is refused, so the register cannot even be amended');
  });
});
