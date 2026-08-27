// ATTACK · T1 — the relay rewrites, re-attributes, replays, reorders, splices, truncates, and then
// feeds `openOp` every malformed shape it can build.
//
// ADR 002 §5.1's table names six attacks the AAD is supposed to block, one per field. This file
// runs all six and then the ones the table does not list. Where a defence holds, the test asserts
// WHICH barrier caught it — and, where two barriers stack, re-signs under the author's own key to
// force the attack past the first one and prove the second is independent rather than shadowed.
//
// The last section is the fuzz: ~40 shapes handed to `openOp`, hunting for the three failure modes
// that matter — an UNCAUGHT foreign throw, a WRONG KEY selected, and a PARK where a rejection
// belongs (or the reverse).

import test from 'node:test';
import assert from 'node:assert/strict';

import { b64u, ub64 } from '../../src/js/core/b64.js';
import { canonicalBytes, varint } from '../../src/js/core/canon.js';
import { fmt } from '../../src/js/core/stamp.js';
import { deviceId as mkDeviceId, memberId as mkMemberId, opId as mkOpId } from '../../src/js/core/ids.js';
import { isParkReason, PARK_REASONS } from '../../src/js/core/ops.js';
import { AEAD, PAD_BUCKET } from '../../src/js/crypto/suite.js';
import { sealOp, openOp, pad, ENVELOPE_PARK } from '../../src/js/crypto/envelope.js';
import {
  makeDevice, tableOf, spaceKey, ring, makeOp, hdrFor, forge, resign, outcome,
  personalSpace, familySpace, S,
} from './_crypto-relay-kit.js';

/** One member, one device, one key, one valid envelope — the starting point of every attack here. */
async function scene({ ep = 3, wit = '' } = {}) {
  const dev = await makeDevice();
  const sp = personalSpace();
  const key = await spaceKey();
  const r = ring([[sp, ep, key]]);
  const op = makeOp(dev, sp, { f: { date: '2026-09-10', text: 'Zahnarzt' } });
  const env = await sealOp(op, r, dev.sigPriv, hdrFor(op, dev.dv, ep, wit));
  return { dev, sp, key, r, op, env, att: tableOf(dev) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Re-attribution — §5.1's `dv` row, and §5.2.2's checks 3, 4 and 5
// ─────────────────────────────────────────────────────────────────────────────

test('FAILED — T1 re-attributes an op to another device by rewriting `dv`', async () => {
  const a = await scene();
  const b = await makeDevice();
  const table = tableOf(a.dev, b);

  // Step 1: relabel. The AAD binds `dv`, so the SIGNATURE breaks before the AEAD is reached.
  assert.equal(await outcome(() => openOp({ ...a.env, dv: b.dv }, a.r, table)), 'P3');

  // Step 2: the relay cannot repair the signature — it has no device private key. To prove the
  // barriers are independent rather than one barrier counted twice, re-sign under the ORIGINAL
  // author's key (which a coerced client could do) and watch the SECOND barrier catch it:
  const resigned = await resign({ ...a.env, dv: b.dv }, a.dev.sigPriv);
  // P2 passes for `b` (b's attestation genuinely certifies b's short), P3 now fails because the
  // signature was made by `a`. Two different keys, one lookup — this is what re-attribution costs.
  assert.equal(await outcome(() => openOp(resigned, a.r, table)), 'P3');

  // Step 3: and if the attacker IS b — a real family member with a real device key — the AEAD
  // stops it, because `dv` is in the AAD and b re-encrypts nothing.
  const bSigned = await resign({ ...a.env, dv: b.dv }, b.sigPriv);
  assert.equal(await outcome(() => openOp(bSigned, a.r, table)), 'aead');
});

test('FAILED — a family member re-attributes the BODY: op.dev, op.act and the stamp tail', async () => {
  const a = await scene();
  const victim = await makeDevice();

  // The attacker here is a member with a real key: she forges a fresh, validly signed, correctly
  // tagged envelope over a plaintext naming someone else. Each of §5.2.2's checks 3, 4 and 5 is
  // the only thing between her and a false attribution rendered as „von Mama" (story 17.6).
  const hdr = hdrFor(a.op, a.dev.dv, 3, '');

  const wrongDev = { ...a.op, dev: victim.deviceId };
  assert.equal(await outcome(async () => openOp(
    await forge(wrongDev, hdr, a.key, a.dev.sigPriv), a.r, a.att)), 'C3');

  const wrongAct = { ...a.op, act: victim.memberId };
  assert.equal(await outcome(async () => openOp(
    await forge(wrongAct, hdr, a.key, a.dev.sigPriv), a.r, a.att)), 'C5');

  // Check 4 — the one a reader is tempted to drop. Stamping with a PEER's deviceShort would break
  // ADR 001 §6.2's premise that ≺ is a strict total order.
  const wrongStamp = { ...a.op, ts: fmt(1787836800123, 3, victim.dv) };
  assert.equal(await outcome(async () => openOp(
    await forge(wrongStamp, hdr, a.key, a.dev.sigPriv), a.r, a.att)), 'C4');

  // And the header-side mirror: relabel `dv` AND the stamp together, so checks 3/4/5 all agree
  // with each other — P2 then refuses, because the attestation filed under that short certifies a
  // different signing key than the one that signed.
  const both = { ...a.op, ts: fmt(1787836800123, 3, victim.dv), dev: victim.deviceId, act: victim.memberId };
  const bothHdr = { ...hdr, dv: victim.dv };
  assert.equal(await outcome(async () => openOp(
    await forge(both, bothHdr, a.key, a.dev.sigPriv), a.r, tableOf(a.dev, victim))), 'P3');
});

test('FAILED — T1 swaps in a DIFFERENT attestation for the same short (the squatted-short case)', async () => {
  const a = await scene();
  const squatter = await makeDevice();

  // A table that answers `a.dv` with the SQUATTER's attestation. This is what a fold that resolved
  // a contested short to a winner would hand `openOp` — and §2.3's "Two shorts, no winner" exists
  // precisely so it cannot. P2 catches it here as the backstop.
  const squatted = () => squatter.att;
  assert.equal(await outcome(() => openOp(a.env, a.r, squatted)), 'P2');

  // And the deliberate `null` a contested short produces: a PARK, sealed and unopened, re-evaluable.
  assert.equal(await outcome(() => openOp(a.env, a.r, () => null)), 'park:attestation');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. §5.1's other five AAD rows
// ─────────────────────────────────────────────────────────────────────────────

test('FAILED — `ep` relabelling, `sp` replay, `oid` splicing and `wit` rewriting: two barriers each', async () => {
  const a = await scene({ ep: 3, wit: 'kQ7bR0aZ4tV9wLpNcgXk92' });
  const other = await spaceKey();
  const fsp = familySpace();
  const fsk = await spaceKey();
  // The victim HOLDS a key for the family space too, so the cross-space replay below can actually
  // reach the AEAD rather than parking on a space it has never heard of.
  const two = ring([[a.sp, 3, a.key], [a.sp, 4, other], [fsp, 3, fsk]]);

  const cases = [
    ['ep', { ...a.env, ep: 4 }],
    ['sp', { ...a.env, sp: fsp }],
    ['oid', { ...a.env, oid: mkOpId() }],
    ['wit', { ...a.env, wit: 'AAAAAAAAAAAAAAAAAAAAAA' }],
    ['v', { ...a.env, v: 2 }],
  ];
  for (const [field, tampered] of cases) {
    const got = await outcome(() => openOp(tampered, two, a.att));
    // `v` is the exception: a version it does not know PARKS before anything else runs, by design
    // ("versioning, not negotiation", §1). Everything else dies on the signature.
    assert.equal(got, field === 'v' ? 'park:version' : 'P3', `${field} was not caught`);
  }

  // Force each past P3 by re-signing under the author's own key, and assert a SECOND, independent
  // barrier catches it. This is the difference between "the AAD blocks it" and "the signature
  // blocks it" — §5.1's table claims the former, and this proves the former is true too.
  assert.equal(await outcome(async () => openOp(await resign({ ...a.env, ep: 4 }, a.dev.sigPriv), two, a.att)), 'aead');
  const spResigned = await resign({ ...a.env, sp: fsp }, a.dev.sigPriv);
  assert.equal(await outcome(() => openOp(spResigned, two, a.att)), 'aead');

  // And a space the victim holds NO key for parks instead — P4 runs before the decrypt, so a relay
  // relabelling into an unknown space buys a park, not an oracle.
  const unknown = await resign({ ...a.env, sp: familySpace() }, a.dev.sigPriv);
  assert.equal(await outcome(() => openOp(unknown, two, a.att)), 'park:epoch');
  assert.equal(await outcome(async () => openOp(await resign({ ...a.env, oid: mkOpId() }, a.dev.sigPriv), two, a.att)), 'aead');
  assert.equal(await outcome(async () => openOp(await resign({ ...a.env, wit: 'AAAAAAAAAAAAAAAAAAAAAA' }, a.dev.sigPriv), two, a.att)), 'aead');

  // `oid` deserves its own note: even if the AEAD somehow passed, check 1 would catch it, because
  // `op.id` is INSIDE the ciphertext. Prove that by forging the pair consistently on the header
  // side only — a spliced envelope whose body still names the original id.
  const spliced = await forge(a.op, { ...hdrFor(a.op, a.dev.dv, 3, ''), oid: mkOpId() }, a.key, a.dev.sigPriv);
  assert.equal(await outcome(() => openOp(spliced, a.r, a.att)), 'C1');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Field-swapping between two VALID envelopes
// ─────────────────────────────────────────────────────────────────────────────

test('FAILED — swapping AAD fields, IVs, ciphertexts and signatures between two valid envelopes', async () => {
  const dev = await makeDevice();
  const sp = personalSpace();
  const key = await spaceKey();
  const r = ring([[sp, 3, key]]);
  const att = tableOf(dev);

  const opA = makeOp(dev, sp, { f: { date: '2026-09-10', text: 'Zahnarzt' } });
  const opB = makeOp(dev, sp, { f: { date: '2026-09-11', text: 'Elternabend' } });
  const A = await sealOp(opA, r, dev.sigPriv, hdrFor(opA, dev.dv, 3, 'AAAAAAAAAAAAAAAAAAAAAA'));
  const B = await sealOp(opB, r, dev.sigPriv, hdrFor(opB, dev.dv, 3, 'BBBBBBBBBBBBBBBBBBBBBB'));

  // Both open on their own — the baseline that makes every failure below meaningful.
  assert.equal(await outcome(() => openOp(A, r, att)), 'OPENED');
  assert.equal(await outcome(() => openOp(B, r, att)), 'OPENED');

  const swaps = {
    'A header + B body': { ...A, iv: B.iv, ct: B.ct, sig: B.sig },
    "A's sig onto B": { ...B, sig: A.sig },
    "B's ct into A": { ...A, ct: B.ct },
    "B's iv into A": { ...A, iv: B.iv },
    "B's oid into A": { ...A, oid: B.oid },
    "B's wit into A": { ...A, wit: B.wit },
  };
  for (const [name, env] of Object.entries(swaps)) {
    assert.equal(await outcome(() => openOp(env, r, att)), 'P3', `${name} was not caught`);
  }

  // Even a fully self-consistent recombination — B's whole body under A's header, re-signed —
  // dies at the AEAD, because the AAD carries A's `oid` and `wit` and B's tag was made over B's.
  const recombined = await resign({ ...A, iv: B.iv, ct: B.ct }, dev.sigPriv);
  assert.equal(await outcome(() => openOp(recombined, r, att)), 'aead');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The padding, attacked from both sides
// ─────────────────────────────────────────────────────────────────────────────

test('FAILED — stripping, shortening and stuffing the pad', async () => {
  const a = await scene();
  const hdr = hdrFor(a.op, a.dev.dv, 3, '');
  const body = canonicalBytes(a.op);

  // Strip the padding entirely: `varint ‖ payload` with nothing after it.
  const unpadded = new Uint8Array(varint(body.length).length + body.length);
  unpadded.set(varint(body.length), 0);
  unpadded.set(body, varint(body.length).length);
  assert.notEqual(unpadded.length % PAD_BUCKET, 0);
  assert.equal(await outcome(async () => openOp(
    await forge(null, hdr, a.key, a.dev.sigPriv, { plaintext: unpadded }), a.r, a.att)), 'padding');

  // Carry data in the pad — the T5 channel `unpad` exists to close.
  const stuffed = pad(body);
  stuffed[stuffed.length - 1] = 0x21;
  assert.equal(await outcome(async () => openOp(
    await forge(null, hdr, a.key, a.dev.sigPriv, { plaintext: stuffed }), a.r, a.att)), 'padding');

  // Lie about the declared length so the payload "ends" early and the rest reads as pad.
  const lying = pad(body);
  lying.set(varint(body.length - 40), 0);
  assert.equal(await outcome(async () => openOp(
    await forge(null, hdr, a.key, a.dev.sigPriv, { plaintext: lying }), a.r, a.att)), 'padding');

  // Declare a length that runs past the block.
  const overlong = pad(body);
  overlong.set(varint(100000), 0);
  assert.equal(await outcome(async () => openOp(
    await forge(null, hdr, a.key, a.dev.sigPriv, { plaintext: overlong }), a.r, a.att)), 'padding');

  // A zero-length payload — rule 2's guard, one layer down.
  const zero = new Uint8Array(PAD_BUCKET);
  assert.equal(await outcome(async () => openOp(
    await forge(null, hdr, a.key, a.dev.sigPriv, { plaintext: zero }), a.r, a.att)), 'padding');

  // And T1's version, which needs no key at all: truncate the ciphertext. The tag refuses.
  const short = ub64(a.env.ct).slice(0, ub64(a.env.ct).length - PAD_BUCKET);
  assert.equal(await outcome(async () => openOp(
    await resign({ ...a.env, ct: b64u(short) }, a.dev.sigPriv), a.r, a.att)), 'aead');
});

test('FAILED — non-canonical plaintext (the key-order channel) is refused', async () => {
  const a = await scene();
  const hdr = hdrFor(a.op, a.dev.dv, 3, '');
  const TE = new TextEncoder();

  // Same op, keys in a different order, plus a space. GCM cannot see this; `openOp` re-canonicalises.
  const reordered = JSON.stringify(a.op, ['f', 'k', 'e', 'v', 'id', 'ts', 'space', 'act', 'dev', 'gid']);
  const bytes = TE.encode(reordered);
  assert.equal(await outcome(async () => openOp(
    await forge(null, hdr, a.key, a.dev.sigPriv, { plaintext: pad(bytes) }), a.r, a.att)), 'canonical');

  // Not JSON at all, and not UTF-8 at all.
  assert.equal(await outcome(async () => openOp(
    await forge(null, hdr, a.key, a.dev.sigPriv, { plaintext: pad(TE.encode('{{{')) }), a.r, a.att)), 'canonical');
  assert.equal(await outcome(async () => openOp(
    await forge(null, hdr, a.key, a.dev.sigPriv, { plaintext: pad(new Uint8Array([0xff, 0xfe, 0xfd])) }), a.r, a.att)), 'canonical');

  // A canonical JSON value that is not an op object.
  assert.equal(await outcome(async () => openOp(
    await forge(null, hdr, a.key, a.dev.sigPriv, { plaintext: pad(TE.encode('[1,2,3]')) }), a.r, a.att)), 'shape');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Replay, reorder, truncate — the three the relay does NOT need a key for
// ─────────────────────────────────────────────────────────────────────────────

test('SUCCEEDED — replaying an unmodified envelope: openOp opens it again, every time, unchanged', async () => {
  const a = await scene();
  for (let i = 0; i < 3; i++) {
    const r = await openOp(a.env, a.r, a.att);
    assert.equal(r.status, 'opened');
    assert.equal(r.op.id, a.op.id);
  }
  // `openOp` is STATELESS by construction — it holds no seen-set, no seq, no receipt. Replay
  // suppression is `op.id` idempotency at the store, one seam over, and it is invisible from here.
  // Worth stating because §5.1's table lists `oid` as blocking "one op made to look like two" —
  // it blocks the RELABELLED copy, not the identical one.
  assert.equal(openOp.length, 3, 'env, keyring, attestationOf — no seen-set, no seq, no receipt');
});

test('SUCCEEDED — reordering and truncating the stream: nothing at this seam notices either', async () => {
  const dev = await makeDevice();
  const sp = personalSpace();
  const key = await spaceKey();
  const r = ring([[sp, 7, key]]);
  const att = tableOf(dev);

  const stream = [];
  for (let i = 0; i < 5; i++) {
    const op = makeOp(dev, sp, { ts: fmt(1787836800000 + i * 1000, i, dev.dv) });
    // `wit` is the ONLY order commitment in the design, and it is author-set, never compared.
    stream.push(await sealOp(op, r, dev.sigPriv, hdrFor(op, dev.dv, 7, b64u(new Uint8Array([i])))));
  }

  // The relay reverses the array and drops the last two. Every survivor still opens.
  const delivered = [...stream].reverse().slice(0, 3);
  for (const env of delivered) {
    assert.equal((await openOp(env, r, att)).status, 'opened');
  }
  // Ordering is recovered from the HLC stamp INSIDE the ciphertext, so reordering is harmless.
  // Withholding is not, and §8.6 concedes it: `wit` makes it "detectable in principle" by a
  // cross-check that lives nowhere in this seam. `openOp` never reads `wit` for any purpose.
  const witnesses = delivered.map((e) => e.wit);
  assert.equal(new Set(witnesses).size, 3, 'the witnesses differ and nothing compares them');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The unauthenticated PARK — storage amplification the relay pays nothing for
// ─────────────────────────────────────────────────────────────────────────────

test('SUCCEEDED — T1 makes every client retain an arbitrary blob for ever, at zero cryptographic cost', async () => {
  const a = await scene();

  // (i) The VERSION park runs before `assertHeader` and before P1/P2/P3. A single integer field is
  //     enough. The envelope is retained (ADR 001 §7.4) and re-evaluated after every app update.
  assert.equal(await outcome(() => openOp({ v: 2 }, a.r, a.att)), 'park:version');
  assert.equal(await outcome(() => openOp({ v: 9007199254740991, junk: 'x'.repeat(4096) }, a.r, a.att)),
    'park:version');

  // (ii) The ATTESTATION park runs before P3 — correctly, because `attestationOf` is the ONLY
  //      source of the verification key (§5.2.1 correction 1). The price is that a park is issued
  //      with NO signature checked: random `dv`, random `ct`, random `sig`.
  const junk = { ...a.env, dv: 'ZZZZZZZZZZZZZZZZ', ct: 'AAAA', sig: 'AAAA' };
  assert.equal(await outcome(() => openOp(junk, a.r, a.att)), 'park:attestation');

  // No attestation for a random short will ever arrive, so this park never resolves. It is not a
  // queue that drains; it is a write to every family member's disk that the relay performs by
  // returning bytes. The signature the relay cannot make is checked AFTER the retention decision.
  //
  // The mitigating fact, stated fairly: ADR 003's request auth means the relay must at least be
  // the relay (or hold a device key) to deliver these bytes — this is a T1 capability, not an
  // anybody capability. And ADR 001 §7.4 owns the park store's own bounds, not this seam.

  // (iii) A park reason this build cannot even record. `ENVELOPE_PARK.ATTESTATION` is F-6 / WP-8:
  //       `ops.js` does not know 'attestation', so the outcome of (ii) is currently UNDEFINED at
  //       the store — it is neither a rejection nor a recordable park.
  assert.equal(ENVELOPE_PARK.ATTESTATION, 'attestation');
  assert.equal(isParkReason(ENVELOPE_PARK.ATTESTATION), false,
    'if this flips, WP-8 landed and the amplification above finally has defined semantics');
  assert.equal(isParkReason(ENVELOPE_PARK.VERSION), true);
  assert.equal(isParkReason(ENVELOPE_PARK.EPOCH), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The fuzz — every malformed shape, hunting for an uncaught throw
// ─────────────────────────────────────────────────────────────────────────────

test('FAILED — 40 malformed inputs: every one lands on a named check or a park, none escapes', async () => {
  const a = await scene();
  const bad = (dv) => ({ ...a.env, dv });

  /** @type {Array<[string, any, any, any, string]>} name, env, ring, attestationOf, expected */
  const rows = [
    ['null', null, a.r, a.att, 'shape'],
    ['array', [], a.r, a.att, 'shape'],
    ['string', 'envelope', a.r, a.att, 'shape'],
    ['number', 7, a.r, a.att, 'shape'],
    ['empty object', {}, a.r, a.att, 'shape'],
    ['v missing', { ...a.env, v: undefined }, a.r, a.att, 'shape'],
    ['v = 0', { ...a.env, v: 0 }, a.r, a.att, 'shape'],
    ['v = -1', { ...a.env, v: -1 }, a.r, a.att, 'shape'],
    ['v = 1.5', { ...a.env, v: 1.5 }, a.r, a.att, 'shape'],
    ['v = "1"', { ...a.env, v: '1' }, a.r, a.att, 'shape'],
    ['v = 2 (park)', { ...a.env, v: 2 }, a.r, a.att, 'park:version'],
    ['sp missing', { ...a.env, sp: undefined }, a.r, a.att, 'shape'],
    ['sp = local', { ...a.env, sp: 'local' }, a.r, a.att, 'shape'],
    ['sp bad prefix', { ...a.env, sp: `xsp_${'A'.repeat(22)}` }, a.r, a.att, 'shape'],
    ['sp short', { ...a.env, sp: 'psp_AAAA' }, a.r, a.att, 'shape'],
    ['sp = object', { ...a.env, sp: {} }, a.r, a.att, 'shape'],
    ['ep = 0', { ...a.env, ep: 0 }, a.r, a.att, 'shape'],
    ['ep = -3', { ...a.env, ep: -3 }, a.r, a.att, 'shape'],
    ['ep = 2.5', { ...a.env, ep: 2.5 }, a.r, a.att, 'shape'],
    ['ep = "3"', { ...a.env, ep: '3' }, a.r, a.att, 'shape'],
    ['ep = Infinity', { ...a.env, ep: Infinity }, a.r, a.att, 'shape'],
    ['ep = 2^53', { ...a.env, ep: 2 ** 53 }, a.r, a.att, 'shape'],
    ['ep unheld (park)', { ...a.env, ep: 99 }, a.r, a.att, 'P3'],
    ['dv lowercase', bad('abcdefgh01234567'), a.r, a.att, 'shape'],
    ['dv 15 chars', bad('ABCDEFGH0123456'), a.r, a.att, 'shape'],
    ['dv with U', bad('UBCDEFGH01234567'), a.r, a.att, 'shape'],
    ['dv null', bad(null), a.r, a.att, 'shape'],
    ['oid 21 chars', { ...a.env, oid: 'A'.repeat(21) }, a.r, a.att, 'shape'],
    ['oid with +', { ...a.env, oid: `+${'A'.repeat(21)}` }, a.r, a.att, 'shape'],
    ['wit 87 chars', { ...a.env, wit: 'A'.repeat(87) }, a.r, a.att, 'shape'],
    ['wit with +', { ...a.env, wit: 'AA+A' }, a.r, a.att, 'shape'],
    ['wit = null', { ...a.env, wit: null }, a.r, a.att, 'shape'],
    ['iv 11 bytes', { ...a.env, iv: b64u(new Uint8Array(11)) }, a.r, a.att, 'shape'],
    ['iv 13 bytes', { ...a.env, iv: b64u(new Uint8Array(13)) }, a.r, a.att, 'shape'],
    ['iv not b64u', { ...a.env, iv: '****' }, a.r, a.att, 'shape'],
    ['iv = 0 bytes', { ...a.env, iv: '' }, a.r, a.att, 'shape'],
    ['ct empty', { ...a.env, ct: '' }, a.r, a.att, 'shape'],
    ['ct not b64u', { ...a.env, ct: '!!!!' }, a.r, a.att, 'shape'],
    ['ct impossible length', { ...a.env, ct: 'AAAAA' }, a.r, a.att, 'shape'],
    ['sig empty', { ...a.env, sig: '' }, a.r, a.att, 'shape'],
    ['sig 1 byte', { ...a.env, sig: b64u(new Uint8Array(1)) }, a.r, a.att, 'P3'],
    ['sig 4096 bytes', { ...a.env, sig: b64u(new Uint8Array(4096)) }, a.r, a.att, 'P3'],
    ['attestationOf missing', a.env, a.r, undefined, 'shape'],
    ['attestationOf = null', a.env, a.r, null, 'shape'],
    ['attestationOf -> null', a.env, a.r, () => null, 'park:attestation'],
    ['attestationOf -> undefined', a.env, a.r, () => undefined, 'park:attestation'],
    ['att.sigPubRaw missing', a.env, a.r, () => ({ deviceShort: a.dev.dv }), 'P2'],
    ['att.sigPubRaw = 7', a.env, a.r, () => ({ ...a.dev.att, sigPubRaw: 7 }), 'P2'],
    ['att.sigPubRaw not b64u', a.env, a.r, () => ({ ...a.dev.att, sigPubRaw: '***' }), 'P2'],
    ['att.sigPubRaw wrong length', a.env, a.r, () => ({ ...a.dev.att, sigPubRaw: b64u(new Uint8Array(64)) }), 'P2'],
    ['att.deviceShort disagrees', a.env, a.r, () => ({ ...a.dev.att, deviceShort: 'ZZZZZZZZZZZZZZZZ' }), 'P2'],
    ['keyring missing', a.env, undefined, a.att, 'shape'],
    ['keyring.get not a fn', a.env, { get: 1 }, a.att, 'shape'],
    ['keyring.get async', a.env, { get: async () => null }, a.att, 'shape'],
    ['keyring.get -> null (park)', a.env, { get: () => null }, a.att, 'park:epoch'],
    ['keyring.get -> junk', a.env, { get: () => ({}) }, a.att, 'aead'],
    ['prototype-polluted env', Object.assign(Object.create({ v: 1 }), { ...a.env }), a.r, a.att, 'OPENED'],
  ];

  const surprises = [];
  for (const [name, env, r, att, expected] of rows) {
    const got = await outcome(() => openOp(env, r, att));
    if (got !== expected) surprises.push(`${name}: expected ${expected}, got ${got}`);
    // The hard invariant, independent of the expectation: nothing foreign ever escapes.
    assert.equal(got.startsWith('UNEXPECTED'), false, `${name} threw a foreign error: ${got}`);
  }
  assert.deepEqual(surprises, []);

  // Two of those rows deserve a sentence.
  //
  // 'ep unheld (park)' is NOT a park: relabelling `ep` breaks the AAD, so P3 refuses before P4 can
  // park. The park at P4 is reachable only by an HONEST envelope whose epoch this device has not
  // yet received — which is exactly right, and means the relay cannot manufacture EPOCH parks the
  // way it manufactures ATTESTATION and VERSION ones.
  //
  // 'keyring.get -> junk' reaches the AEAD with a non-CryptoKey and comes back as a clean `aead`
  // refusal rather than a foreign TypeError, because `S.decrypt` is inside the try/catch boundary
  // (rule 3). That is the one place a wrong-shaped key could have escaped as an engine error.
});

test('FAILED — a personal envelope replayed into the family stream, and vice versa', async () => {
  const dev = await makeDevice();
  const psp = personalSpace();
  const fsp = familySpace();
  const psk = await spaceKey();
  const fsk = await spaceKey();
  const both = ring([[psp, 3, psk], [fsp, 3, fsk]]);
  const att = tableOf(dev);

  const personal = makeOp(dev, psp, { f: { date: '2026-09-10', text: 'Therapie' } });
  const env = await sealOp(personal, both, dev.sigPriv, hdrFor(personal, dev.dv, 3, ''));

  // Header relabelled: P3. Re-signed by the author: the AEAD, because `sp` is in the AAD.
  assert.equal(await outcome(() => openOp({ ...env, sp: fsp }, both, att)), 'P3');
  assert.equal(await outcome(async () => openOp(await resign({ ...env, sp: fsp }, dev.sigPriv), both, att)), 'aead');

  // And even with a consistently forged envelope under the FAMILY key, check 2 refuses, because
  // `op.space` is inside the ciphertext and still says `psp_…`.
  const forged = await forge(personal, { ...hdrFor(personal, dev.dv, 3, ''), sp: fsp }, fsk, dev.sigPriv);
  assert.equal(await outcome(() => openOp(forged, both, att)), 'C2');

  // Three independent refusals — signature, AEAD, and the plaintext's own `space` — which is
  // ADR 002 §3 barrier 3 plus §5.2.2 check 2, and is why 20.5 is "by construction".
});
