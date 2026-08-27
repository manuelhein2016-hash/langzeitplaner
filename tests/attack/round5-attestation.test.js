// ─────────────────────────────────────────────────────────────────────────────
// ROUND 5 — ADVERSARY, ATTACK 2: THE ATTESTATION BINDING, AFTER THE STRUCTURAL FIX
//
// Round 4 found that nothing bound `att.deviceId` to anybody: Eve minted a fully valid,
// fully signed attestation of her OWN and wrote Mama's `deviceId` into it. The fix was
// structural and it is the right shape — the label was DEMOTED rather than guarded, exactly as
// ADR 001 §4.4 refused to invent an `owner` register. §1 below confirms it holds and confirms
// the thing that makes it a fix rather than a refusal: a legitimate SECOND DEVICE for one member
// (story 19.4) still works, and Eve contesting a label does not un-attest the honest device.
//
// §2 is the next seam, and it is the mirror image of the fix.
//
// The `deviceId` reasoning ends with an explicit trade, written into `authz.js:882-887`:
//
//     "Nothing is rejected for it: refusing both claims would let anybody un-attest an honest
//      peer's device by naming its label, which is a worse trade than an unresolved query."
//
// That argument is correct. It is then NOT applied to `deviceShort`, where I-3 chose the other
// side: `attestationOf` REFUSES a contested short outright. So the very move the file rules out
// for the label is the shipped behaviour for the short — and the short is strictly easier to
// contest than the label, because `deviceShort` is the LAST 16 CHARACTERS OF EVERY STAMP the
// device has ever written (`stamp.js`: `pad13(ms).pad6(ctr).deviceShort16`).
//
// §2 then shows that the fix everyone is waiting for — ADR 002 §5.2.2's P2, the
// `SHA-256(sigPubRaw) === deviceShort` binding that WP-6 must ship inside `attestOpen` — DOES
// NOT CLOSE IT. `sigPubRaw` is a PUBLIC key that travels in Mama's own register value. Eve
// copies it verbatim into an attestation that names HERSELF, signs it with her own recovery key,
// and files it under `dev.<Mama's short>` in her own record. Every one of ADR 002 §2.3's four
// conditions passes, P2 passes, and the §1.2 `sigPubRaw → deviceShort` cross-check does not fire
// because Eve is telling the truth about the key. The short is contested; Mama's envelopes park;
// there is no revocation (R4-16a) and `dev.*` is write-once, so it is permanent.
//
// §3 checks the remaining spellings — the register-name seam, the payload types, and the
// `sigPubRaw` re-encoding — and they all hold.
//
// Rows tagged `SUCCEEDED (defect)` are green BECAUSE the defect is there.
// ─────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { foldAuthorized } from '../../src/js/core/authz.js';
import { validateOp } from '../../src/js/core/ops.js';
import { memberKey, familyKey } from '../../src/js/core/entities.js';
import { fmt } from '../../src/js/core/stamp.js';
import { b64u, ub64 } from '../../src/js/core/b64.js';
import { canonicalBytes, utf8, utf8Decode } from '../../src/js/core/canon.js';
import { pad22, short16, FSP } from './_kit.js';

const ME = `mem_${pad22('ME')}`;
const MAMA = `mem_${pad22('MAMA')}`;
const EVE = `mem_${pad22('EVE')}`;
const dev = (t) => ({ id: `dev_${pad22(t)}`, short: short16(t) });
const D_MAMA = dev('DMAMA');
const D_MAMA2 = dev('DMAMA2');          // 19.4 — Mama's iPad
const D_EVE = dev('DEVE');

const BASE = 1787836800000;
let seq = 0;
const rid = (t) => pad22(`${t}${++seq}`);

/** ADR 002 §2.3's register value. `keysOf` separates the LABEL from the real keypair. */
function attBlob({ memberId, deviceId, deviceShort, keysOf = deviceId, sigPubRaw }) {
  const att = {
    memberId,
    deviceId,
    deviceShort,
    sigPubRaw: sigPubRaw ?? b64u(utf8(`sigpub:${keysOf}`)),
    kexPubRaw: b64u(utf8(`kexpub:${keysOf}`)),
    createdAt: '2026-08-25',
  };
  return `${b64u(canonicalBytes(att))}.${b64u(utf8(`sig:${memberId}:${deviceId}`))}`;
}

/** What a signature CAN check: the blob was signed by the member the payload names. */
const verifier = (memberId, blob) => {
  try {
    const d = blob.indexOf('.');
    const att = JSON.parse(utf8Decode(ub64(blob.slice(0, d))));
    return att.memberId === memberId && utf8Decode(ub64(blob.slice(d + 1))) === `sig:${att.memberId}:${att.deviceId}`;
  } catch { return false; }
};

/**
 * WP-6's `attestOpen`, INCLUDING §5.2.2's P2 — the binding that is owed and that everybody is
 * waiting for. `sigPubRaw` here is `sigpub:<label of the real keypair>`, so "hashing" it is
 * reading that label back out; the property that matters is the one P2 asserts, namely that the
 * short is a function of the signing key and cannot be chosen independently of it.
 */
const openerWithP2 = (memberId, blob) => {
  try {
    const d = blob.indexOf('.');
    const att = JSON.parse(utf8Decode(ub64(blob.slice(0, d))));
    if (!verifier(memberId, blob)) return null;
    const owner = utf8Decode(ub64(att.sigPubRaw)).replace(/^sigpub:/, '');   // stands in for SHA-256
    if (short16(owner.replace(/^dev_/, '').replace(/A+$/, '')) !== att.deviceShort) return null;
    return att;
  } catch { return null; }
};

function mk(k, e, f, o) {
  const op = { v: 1, id: o.id ?? rid('op'), ts: o.ts, space: o.space, act: o.act, dev: o.dev, gid: o.gid ?? rid('g'), k, e, f };
  const v = validateOp(op);
  if (!v.ok) throw new Error(`test fixture built an invalid op: ${v.reason}`);
  return Object.freeze(op);
}
const attestOp = (housing, regShort, blob, ms, byDev) => mk(
  'member.set', memberKey(housing), { [`dev.${regShort}`]: blob },
  { act: housing, dev: byDev, ts: fmt(ms, 0, short16('T')), space: FSP },
);
const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** A FAMILY content op — the space stage 0b's device gate actually guards. */
const contentOp = (act, devId, ms, id, owner = act) => mk(
  'pub.set', familyKey('fnote', owner, U1), { 'pub.text': `von ${act}`, 'pub.level': 'geteilt' },
  { act, dev: devId, ts: fmt(ms, 0, short16('C')), space: FSP, id },
);

const fold = (ops, over = {}) => foldAuthorized(ops, { me: ME, attestVerify: verifier, ...over });

/** Mama's honest first device. Her `sigPubRaw` is PUBLIC: it is in this very register value. */
const MAMA_BLOB = attBlob({ memberId: MAMA, deviceId: D_MAMA.id, deviceShort: D_MAMA.short, keysOf: D_MAMA.short });
const MAMA_HONEST = () => attestOp(MAMA, D_MAMA.short, MAMA_BLOB, BASE, D_MAMA.id);
const MAMA_PUBKEY = b64u(utf8(`sigpub:${D_MAMA.short}`));

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE STRUCTURAL FIX HOLDS, AND IT DOES NOT BREAK 19.4
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-6 · the demoted label', () => {
  test('R5-6a FAILED (held) · Eve adopting Mama\'s deviceId still buys her nothing', async () => {
    const evesForgery = attestOp(
      EVE, D_EVE.short,
      attBlob({ memberId: EVE, deviceId: D_MAMA.id, deviceShort: D_EVE.short, keysOf: D_EVE.short }),
      BASE - 999_999, D_EVE.id,                          // backdated as hard as she likes
    );
    const r = fold([MAMA_HONEST(), evesForgery]);
    assert.equal(r.memberOfDevice(D_MAMA.id), null, 'no owner is picked from a contested label');
    assert.deepEqual(r.deviceIdCollisions, [D_MAMA.id], 'and the contest is reported');
    // The load-bearing half: the stolen label admits exactly what a fresh one would.
    const stolen = fold([MAMA_HONEST(), evesForgery, contentOp(EVE, D_MAMA.id, BASE + 1, rid('s'))]);
    assert.equal(stolen.admitted.some((o) => o.act === EVE), true, 'she can author as EVE with it …');
    assert.equal(stolen.regs.get(familyKey('fnote', EVE, U1)).get('pub.text').value, `von ${EVE}`);
    assert.equal(stolen.admitted.some((o) => o.act === MAMA && o.k === 'pub.set'), false,
      '… and never as MAMA, which is the only thing that would have been worth stealing');
  });

  test('R5-6b FAILED (held) · 19.4: a member\'s SECOND device still works, and Eve cannot break it', async () => {
    const mama2 = attestOp(
      MAMA, D_MAMA2.short,
      attBlob({ memberId: MAMA, deviceId: D_MAMA2.id, deviceShort: D_MAMA2.short, keysOf: D_MAMA2.short }),
      BASE + 10, D_MAMA.id,
    );
    const r = fold([MAMA_HONEST(), mama2]);
    assert.deepEqual([...r.attestedDevices.get(MAMA)].sort(), [D_MAMA.id, D_MAMA2.id].sort(),
      'two devices, one member — the pair reading is what makes this legal');
    assert.equal(r.memberOfDevice(D_MAMA2.id), MAMA);
    assert.ok(r.attestationOf(D_MAMA2.short), 'and the iPad resolves to its own attestation');
    // both devices may author
    for (const d of [D_MAMA.id, D_MAMA2.id]) {
      const f = fold([MAMA_HONEST(), mama2, contentOp(MAMA, d, BASE + 20, rid('c'))]);
      assert.equal(f.admitted.some((o) => o.dev === d && o.k === 'pub.set'), true, `${d} may author`);
    }
    // and Eve contesting the LABEL does not touch any of that
    const contest = attestOp(
      EVE, D_EVE.short,
      attBlob({ memberId: EVE, deviceId: D_MAMA2.id, deviceShort: D_EVE.short, keysOf: D_EVE.short }),
      BASE, D_EVE.id,
    );
    const g = fold([MAMA_HONEST(), mama2, contest, contentOp(MAMA, D_MAMA2.id, BASE + 30, rid('d'))]);
    assert.equal(g.admitted.some((o) => o.dev === D_MAMA2.id && o.k === 'pub.set'), true,
      "the honest device keeps folding — stage 0b reads the member's own record, not the global label");
    assert.ok(g.attestationOf(D_MAMA2.short), 'and its attestation still resolves');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE NEXT SEAM — THE REFUSAL IS THE WEAPON, AND P2 DOES NOT DISARM IT
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-7 · a contested deviceShort is a one-op, permanent, remote mute', () => {
  test('R5-7a SUCCEEDED (reachability) · the short a squatter needs is printed in every stamp the victim has ever written', async () => {
    // A REACHABILITY CHARACTERIZATION, not a defect row: it has no mutant, because what it
    // asserts is the stamp FORMAT (ADR 001 §1.3), which is correct and must not change. It is
    // here because it is the precondition that turns R5-7b from a risk into an attack.
    //
    // No guessing, no enumeration, no side channel: `deviceShort` is the last 16 characters of a
    // stamp, and every op carries `ts`. Anybody who has seen ONE op from Mama's Mac has it.
    const anyOpFromMama = contentOp(MAMA, D_MAMA.id, BASE + 5, rid('h'));
    const attestation = MAMA_BLOB;
    const payload = JSON.parse(utf8Decode(ub64(attestation.slice(0, attestation.indexOf('.')))));
    assert.equal(payload.deviceShort, D_MAMA.short, 'the short is in the register value in plaintext …');
    assert.equal(fmt(BASE, 0, D_MAMA.short).slice(21), D_MAMA.short, '… and in the tail of every stamp');
    assert.equal(anyOpFromMama.ts.length, 37, '(the format the whole product sorts on)');
    // `sigPubRaw` is public in the same place, which is what §2 needs.
    assert.equal(payload.sigPubRaw, MAMA_PUBKEY);
  });

  test('R5-7b SUCCEEDED (defect) · ONE well-formed op from anybody mutes Mama\'s device, permanently', async () => {
    const squat = attestOp(
      EVE, D_MAMA.short,
      attBlob({ memberId: EVE, deviceId: D_EVE.id, deviceShort: D_MAMA.short, keysOf: D_EVE.short }),
      BASE + 1, D_EVE.id,
    );
    const before = fold([MAMA_HONEST()]);
    assert.ok(before.attestationOf(D_MAMA.short), 'before: Mama\'s envelopes can be opened');

    const after = fold([MAMA_HONEST(), squat]);
    assert.equal(after.attestationOf(D_MAMA.short), null,
      'after: §5.2.2 P1 parks every sealed envelope from that device, for ever');
    assert.deepEqual(after.shortCollisions, [D_MAMA.short]);
    // Nothing is rejected — the squat is ADMITTED, which is what makes it permanent.
    assert.equal(after.admitted.some((o) => o.id === squat.id), true, 'the squat is admitted …');
    assert.equal(after.rejected.length, 0, '… nothing is refused …');
    // …and `dev.*` is write-once, so Mama cannot overwrite the collision, and there is no
    // revocation op anywhere in the fold (R4-16a).
    const retry = attestOp(MAMA, D_MAMA.short, MAMA_BLOB, BASE + 999, D_MAMA.id);
    const still = fold([MAMA_HONEST(), squat, retry]);
    assert.equal(still.attestationOf(D_MAMA.short), null, 'a re-attestation changes nothing');
    // Her own ops keep folding. The cost is confidentiality-preserving liveness, not integrity.
    const c = fold([MAMA_HONEST(), squat, contentOp(MAMA, D_MAMA.id, BASE + 40, rid('k'))]);
    assert.equal(c.admitted.some((o) => o.k === 'pub.set'), true, 'stage 0b is untouched, as designed');
  });

  test('R5-7c SUCCEEDED (defect) · P2 — WP-6\'s owed fix — DOES NOT CLOSE IT, because sigPubRaw is public', async () => {
    // First, the control: P2 is real here and it DOES refuse the naive squat of R5-7b, which is
    // exactly why the register records "until WP-6 ships P2, a squatted short costs liveness".
    const naive = attestOp(
      EVE, D_MAMA.short,
      attBlob({ memberId: EVE, deviceId: D_EVE.id, deviceShort: D_MAMA.short, keysOf: D_EVE.short }),
      BASE + 1, D_EVE.id,
    );
    const guarded = fold([MAMA_HONEST(), naive], { attestOpen: openerWithP2, attestVerify: undefined });
    assert.ok(guarded.attestationOf(D_MAMA.short), 'with P2 armed, the naive squat is refused …');
    assert.equal(guarded.rejected.some((o) => o.id === naive.id), true, '… and rejected outright');

    // NOW THE ATTACK. Eve does not lie about the key at all. She copies Mama's PUBLIC
    // `sigPubRaw` — which she reads out of Mama's own register value, or off any support bundle —
    // into an attestation that names HERSELF as the member, and files it under Mama's short in
    // HER OWN record. Everything is true except the implicit claim that she holds the private
    // half, and nothing in a pure fold can check that.
    const copied = attestOp(
      EVE, D_MAMA.short,
      attBlob({ memberId: EVE, deviceId: D_EVE.id, deviceShort: D_MAMA.short, sigPubRaw: MAMA_PUBKEY }),
      BASE + 1, D_EVE.id,
    );
    const r = fold([MAMA_HONEST(), copied], { attestOpen: openerWithP2, attestVerify: undefined });

    assert.equal(r.rejected.length, 0, 'ADR 002 §2.3 (1)(2)(3)(4) all pass …');
    assert.equal(r.admitted.some((o) => o.id === copied.id), true, '… P2 passes, because the key IS that short\'s key …');
    assert.deepEqual(r.shortCollisions, [D_MAMA.short], '… and the short is contested anyway');
    assert.equal(r.attestationOf(D_MAMA.short), null, 'so Mama is muted with P2 shipped and armed');

    // And the §1.2 cross-check cannot see it either: Eve told the truth about `sigPubRaw`, so
    // `sigPubRaw → deviceShort` is still a function.
    assert.equal(r.shortCollisions.length, 1, 'only the member-collision fired, not the key-collision');
  });

  test('R5-7d SUCCEEDED (defect) · the trade `authz.js:882` rules out for the LABEL is what ships for the SHORT', async () => {
    // Both contests are one op by anybody. One is admitted and reported; the other is refused.
    const labelContest = attestOp(EVE, D_EVE.short,
      attBlob({ memberId: EVE, deviceId: D_MAMA.id, deviceShort: D_EVE.short, keysOf: D_EVE.short }), BASE + 1, D_EVE.id);
    const shortContest = attestOp(EVE, D_MAMA.short,
      attBlob({ memberId: EVE, deviceId: D_EVE.id, deviceShort: D_MAMA.short, sigPubRaw: MAMA_PUBKEY }), BASE + 1, D_EVE.id);

    const byLabel = fold([MAMA_HONEST(), labelContest]);
    const byShort = fold([MAMA_HONEST(), shortContest]);

    // The label: the honest device keeps everything that enforces anything.
    assert.ok(byLabel.attestationOf(D_MAMA.short), 'label contested ⇒ the credential still resolves');
    // The short: the honest device loses the credential.
    assert.equal(byShort.attestationOf(D_MAMA.short), null, 'short contested ⇒ the credential is gone');
    // `memberOfDevice` is the one place the label DOES answer null — so the un-attest primitive
    // the comment says it avoided exists there too, for any consumer of that accessor.
    assert.equal(byLabel.memberOfDevice(D_MAMA.id), null,
      'and "anybody can un-attest a peer by naming its label" is true of `memberOfDevice` as shipped');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE REMAINING SPELLINGS — ALL REFUSED
// ─────────────────────────────────────────────────────────────────────────────

describe('R5-8 · other ways to claim a device you do not hold', () => {
  test('R5-8a FAILED (held) · the register NAME cannot be spelled two ways', async () => {
    const SPELLINGS = {
      lowercase: D_MAMA.short.toLowerCase(),
      'trailing dot': `${D_MAMA.short}.`,
      'a prefix of the short': D_MAMA.short.slice(0, 15),
      'padded': ` ${D_MAMA.short}`,
    };
    for (const [what, name] of Object.entries(SPELLINGS)) {
      let op;
      try {
        op = attestOp(EVE, name, attBlob({
          memberId: EVE, deviceId: D_EVE.id, deviceShort: D_MAMA.short, sigPubRaw: MAMA_PUBKEY,
        }), BASE + 2, D_EVE.id);
      } catch { continue; }                          // `validateOp` refused it before the fold
      const r = fold([MAMA_HONEST(), op]);
      assert.ok(r.attestationOf(D_MAMA.short), `${what}: the honest short is untouched`);
      assert.equal(r.admitted.some((o) => o.id === op.id), false, `${what}: and the op does not land`);
    }
  });

  test('R5-8b FAILED (held) · a re-encoded sigPubRaw does not fool the §1.2 cross-check into anything useful', async () => {
    // `shortOfSigPub` is keyed on the base64url STRING, so a different encoding of the same key
    // is a different key to it. The consequence is the harmless direction: the cross-check does
    // not fire, and nothing else changes, because the cross-check only ever ADDS collisions.
    const reencoded = `${MAMA_PUBKEY}`.replace(/A$/, 'A');   // same bytes, same string here
    const op = attestOp(EVE, D_EVE.short, attBlob({
      memberId: EVE, deviceId: D_EVE.id, deviceShort: D_EVE.short, sigPubRaw: reencoded,
    }), BASE + 3, D_EVE.id);
    const r = fold([MAMA_HONEST(), op]);
    assert.deepEqual(r.shortCollisions, [D_EVE.short, D_MAMA.short].sort(),
      'claiming a second short over one key contests BOTH — which is §1.2, and which is also '
      + 'a second route to the same mute (R5-7): Eve does not even have to name Mama\'s short');
  });

  test('R5-8c FAILED (held) · a malformed payload is not a credential in any shape', async () => {
    const BAD = {
      'deviceId is an object': { memberId: EVE, deviceId: {}, deviceShort: D_EVE.short },
      'deviceId is __proto__': { memberId: EVE, deviceId: '__proto__', deviceShort: D_EVE.short },
      'deviceId is empty': { memberId: EVE, deviceId: '', deviceShort: D_EVE.short },
      'memberId is Mama\'s (condition 3)': { memberId: MAMA, deviceId: D_EVE.id, deviceShort: D_EVE.short },
    };
    for (const [what, att] of Object.entries(BAD)) {
      const blob = `${b64u(canonicalBytes({
        sigPubRaw: MAMA_PUBKEY, kexPubRaw: MAMA_PUBKEY, createdAt: '2026-08-25', ...att,
      }))}.${b64u(utf8(`sig:${att.memberId}:${att.deviceId}`))}`;
      const op = attestOp(EVE, D_EVE.short, blob, BASE + 4, D_EVE.id);
      const r = fold([MAMA_HONEST(), op]);
      assert.equal(r.admitted.some((o) => o.id === op.id), false, `${what}: refused`);
      assert.equal(r.attestedDevices.get(EVE), undefined, `${what}: and Eve has no device at all`);
    }
  });
});
