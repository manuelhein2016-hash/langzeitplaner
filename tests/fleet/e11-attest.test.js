// FLEET · E11 / F-SHELL-1 — THE FAMILY LAYER STOPS LOCKING ITS OWN PEERS OUT.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FINDING THIS FILE EXISTS FOR
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// `docs/v2/SHELL-VERIFICATION.md` §9, measured in the shipped `.app`: a Mac in a Familienkreis
// accumulated `badAttestation` refusals — the founder's ledger read **0 → 6 → 13 → 25 over four
// launches** — and once a peer's `member.set{dev.<short>}` op had been refused, the cursor was
// released past it and that peer's device was permanently unattested there. Over five runs the
// Geteilt entry crossed in 4 of 5 and **the founder received a joiner's entry in 0 of 5**.
//
// Three things composed into it. This file holds the two that are ours, and says which is the
// defect:
//
//   1. **`selfAttest` re-signed on every launch.** THE DEFECT. An attestation is a statement
//      about a device that does not change between boots, and ECDSA is randomised by design, so
//      re-minting produced a different STRING for an unchanged fact — on a WRITE-ONCE register
//      whose value is that string, against a roster that carries the FIRST one. Fixed at the
//      root: `crypto/identity.js#ensureAttestedDevice` mints once and stores (§1).
//   2. **`buildAttestOpen` keys on the exact blob string.** NOT a defect and deliberately not
//      changed: the signature is verified over exactly those bytes, so keying on the payload
//      would mean admitting a signature nobody checked — the key-injection hole ADR 002 §2.3
//      exists to close. Once (1) is fixed there is one blob per device and nothing to
//      canonicalise. §1c is the row that would notice if that stopped being true.
//   3. **`BAD_ATTESTATION` was terminal.** A SEVERITY error, and the half that decides the
//      acceptance criterion. `ctx.attestOpen` is a LOOKUP over blobs this Mac has already
//      verified from the roster, so its `null` means "forged" OR "I have never been shown these
//      bytes", and `authz.js` answered both terminally. §2 splits them; §3 bounds the park.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RIG — reused, not rebuilt (`e6-attack-circle.js`)
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
//   THE RELAY      every handler, through `server/core/router.js`, over `adapters/memory.js`.
//   THE TRANSPORT  `platform/net.js#buildRequest` — the shipping client's canonical bytes.
//   THE ENGINE     `sync/family.js#createFamilySync`, one per simulated Mac.
//   THE CRYPTO     `crypto/identity.js`, `crypto/spacekeys.js`, `crypto/envelope.js`, unmodified.
//   THE DISKS      one `localStorage` image and one `store.js` MODULE EVALUATION per Mac.
//
// ⚠ WHAT THIS FILE ADDS TO THE RIG, AND WHY. `e9-attack-kit.js#bootMac` installs an `attestOpen`
// built over EVERY Mac's blob, at boot, for all time. That is an omniscient roster, and it is
// exactly the condition under which F-SHELL-1 is invisible: the defect is what happens when one
// Mac's roster is OLDER than a peer's claim. So §4 gives each Mac its own `seen` set, widened
// only by an explicit `readRoster(mac)` — the call `family/engine.js#refreshAttestations` makes
// on every key pass — and the founder's first launch reads the roster BEFORE the joiner exists,
// which is the real race and the one the shell pass measured.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE MUTANTS — one run each, on a scratch copy, naming the row that dies
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Five mutants, each run once on a scratch copy of the two files this ticket owns. The rows that
// died are MEASURED, not predicted:
//
//   M-E11-1  `crypto/identity.js#ensureAttestedDevice` — the cache read disabled, so every call
//            re-signs (the code exactly as it shipped)
//              → §1a · §1b · §1d · **§4a** RED  (4 of 20)
//            §4a is the one that matters: the acceptance criterion itself fails when the
//            attestation is re-minted, even with the severity fix in place.
//   M-E11-2  `core/authz.js` stage 0a — `held` is never set, so every condition-(4) failure is
//            `BAD_ATTESTATION` again (the code exactly as it shipped)
//              → §2a · §3a · §3d · §3e · **§4a** · **§4b** RED  (6 of 20)
//   M-E11-3  `core/authz.js` — the bound removed (`wins` forced true), so every unverifiable
//            self-filed claim parks
//              → §3a · §3d RED  (2 of 20) — the DoS bound, and nothing else moves
//   M-E11-4  `core/authz.js` — `haveVerifier` forced true, so a build that wired no opener at
//            all would PARK every family op instead of failing loudly
//              → §2d RED  (1 of 20)
//   M-E11-5  `core/authz.js` — the possession proof dropped from the held test (`devOf(op.ts)`
//            no longer compared to `att.deviceShort`)
//              → §2c · §3c RED  (2 of 20)
//
// THE HONEST-PATH CONTROLS, without which the rows above are satisfiable the wrong way:
//   §1c  two DIFFERENT Macs still mint two different blobs — §1a is otherwise satisfied by a
//        constant, which would be a far worse defect than the one being fixed.
//   §2b  the same op, once the roster HAS been read, is ADMITTED — §2 is otherwise satisfied by
//        refusing everything.
//   §3d/§3e  an honest device stays attested while a hostile claim is held beside it.
//   And this file green with no mutant applied.

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { memKeyStore } from '../../src/js/platform/keystore.js';
import {
  openDeviceIdentity, selfAttest, buildAttestOpen,
} from '../../src/js/platform/device-identity.js';
import {
  ensureAttestedDevice, exportRawPublic, verifyAttestation, KEYSTORE_IDS,
} from '../../src/js/crypto/identity.js';
import { canonicalBytes } from '../../src/js/core/canon.js';
import { b64u } from '../../src/js/core/b64.js';
import { foldAuthorized, REJECT_REASONS, parseAttestationBlob } from '../../src/js/core/authz.js';
import { entityUuid as newUuid } from '../../src/js/core/ids.js';
import { familyKey, validateOp, classifyOp } from '../../src/js/core/ops.js';

import { DAY } from './e6-attack-circle.js';
import {
  buildCircle, join, refreshRoster, bootMac, engineFor, on,
  publishAttestation, publishSharedEntry, boardOf,
} from './e9-attack-kit.js';

const MEM = { allowMemoryCustody: true };

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §1 · THE ATTESTATION IS MINTED ONCE — `crypto/identity.js`
//
// The defect, at its root. Nothing in this section needs a relay, a circle or a fold: it is a
// property of one function over one key store, which is what makes it cheap to keep.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One Mac's Keychain plus its member identity — `mintMember`'s first two lines, kept local. */
async function aMac() {
  const ks = memKeyStore();
  const opened = await openDeviceIdentity(ks, { today: DAY, ...MEM });
  return { ks, opened, recSigPriv: opened.recovery.recSig.privateKey };
}

/** `n` launches of the same Mac, each one calling `selfAttest` the way `engine.js` does. */
async function launchBlobs(mac, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    const att = await selfAttest(mac.ks, mac.opened.forStore, mac.recSigPriv, { createdAt: DAY });
    out.push(att.blob);
  }
  return out;
}

describe('§1 · one device, one attestation, for ever', () => {
  test('§1a · two launches of the same Mac mint ONE blob — the string, not just the payload', async () => {
    // ── THE DEFECT, IN ONE ASSERTION. ────────────────────────────────────────────────────────
    // `signBytes`'s own header: "WebCrypto ECDSA is non-deterministic in BOTH engines … never
    // use a signature as an idempotency key". `member:<M> → dev.<short>` IS a signature used as
    // an idempotency key — it is a write-once register whose VALUE is the blob string, and
    // `buildAttestOpen` keys its verified table on that string. So a second signature over the
    // same six fields is a second, unverifiable claim on a register that is already taken.
    const mac = await aMac();
    const [first, second] = await launchBlobs(mac, 2);
    assert.equal(second, first,
      'THE FIX: `ensureAttestedDevice` mints once and stores. Without it these two strings '
      + 'differ, because ECDSA is randomised, and the second is a claim no peer can verify.');

    // The payloads always agreed; it was never the payload that moved.
    assert.deepEqual(parseAttestationBlob(second), parseAttestationBlob(first));

    // And the reuse is REPORTED, so a caller that must know can ask rather than compare strings.
    const again = await ensureAttestedDevice(mac.ks, mac.opened.forStore.memberId, mac.recSigPriv,
      { deviceId: mac.opened.forStore.deviceId, createdAt: DAY });
    assert.equal(again.minted, false, 'the second call did not sign anything');
    assert.equal(again.blob, first);
  });

  test('§1b · FIVE consecutive launches produce exactly ONE distinct blob', async () => {
    // The shell pass's dial, at the layer where the dial is. "Every extra launch makes the
    // circle worse" was a count of DISTINCT blob strings; this is that count.
    const mac = await aMac();
    const blobs = await launchBlobs(mac, 5);
    assert.equal(new Set(blobs).size, 1, `five launches minted ${new Set(blobs).size} blobs`);

    // …and the one blob still verifies under the member's own recovery key, which is the only
    // thing a peer will ever ask about it.
    const pub = mac.opened.recovery.recSig.publicKey;
    assert.notEqual(await verifyAttestation(blobs[0], pub), null);
  });

  test('§1c · CONTROL — two different Macs still mint two different blobs', async () => {
    // Without this row §1a is satisfiable by a function that returns a constant, and a constant
    // attestation would be a far worse defect than the one being fixed.
    const a = await aMac();
    const b = await aMac();
    const [ba] = await launchBlobs(a, 1);
    const [bb] = await launchBlobs(b, 1);
    assert.notEqual(bb, ba);
    assert.notEqual(parseAttestationBlob(bb).deviceShort, parseAttestationBlob(ba).deviceShort);
  });

  test('§1d · the stored blob is CHECKED, not trusted — a foreign cache is re-minted over', async () => {
    // A cache is a new place for a wrong answer to live. `ensureAttestedDevice` uses a stored
    // blob only when it parses, when all six fields equal the payload built from the LIVE key
    // store, and when it still verifies under the recovery key. Here the record is poisoned with
    // another Mac's blob — every field of it names a different device.
    const mine = await aMac();
    const theirs = await aMac();
    const [ok] = await launchBlobs(mine, 1);
    const [foreign] = await launchBlobs(theirs, 1);

    await mine.ks.put(KEYSTORE_IDS.devMeta, canonicalBytes({
      memberId: mine.opened.forStore.memberId,
      deviceId: mine.opened.forStore.deviceId,
      deviceShort: mine.opened.forStore.deviceShort,
      createdAt: DAY,
      attest: foreign,
    }));

    const back = await ensureAttestedDevice(mine.ks, mine.opened.forStore.memberId, mine.recSigPriv,
      { deviceId: mine.opened.forStore.deviceId, createdAt: DAY });
    assert.notEqual(back.blob, foreign, 'the poisoned cache was used');
    assert.equal(back.minted, true, 'a rejected cache costs one re-mint, and says so');
    assert.deepEqual(parseAttestationBlob(back.blob), parseAttestationBlob(ok));
    assert.notEqual(
      await verifyAttestation(back.blob, mine.opened.recovery.recSig.publicKey), null);

    // …and the re-mint is itself stored, so the damage is one launch and not every launch.
    const settled = await launchBlobs(mine, 2);
    assert.equal(new Set(settled).size, 1);
    assert.equal(settled[0], back.blob);
  });

  test('§1e · a truncated cache is survivable — the record is data, not a promise', async () => {
    const mac = await aMac();
    const [ok] = await launchBlobs(mac, 1);
    for (const junk of ['', 'not-a-blob', 'AAAA.BBBB', '.', 'x.']) {
      // eslint-disable-next-line no-await-in-loop
      await mac.ks.put(KEYSTORE_IDS.devMeta, canonicalBytes({
        memberId: mac.opened.forStore.memberId,
        deviceId: mac.opened.forStore.deviceId,
        deviceShort: mac.opened.forStore.deviceShort,
        createdAt: DAY,
        attest: junk,
      }));
      // eslint-disable-next-line no-await-in-loop
      const back = await ensureAttestedDevice(mac.ks, mac.opened.forStore.memberId, mac.recSigPriv,
        { deviceId: mac.opened.forStore.deviceId, createdAt: DAY });
      assert.deepEqual(parseAttestationBlob(back.blob), parseAttestationBlob(ok), junk);
    }
  });

  test('§1f · a store that refuses the write still hands back a usable blob', async () => {
    // "A failed write is not fatal": bricking `importBackup` step 6 on a flaky disk to protect an
    // optimisation would be the wrong trade. The cost of a refused write is one re-mint per
    // launch, i.e. exactly the behaviour that shipped — and stage 0a no longer treats that
    // terminally either, which is why the two halves of this fix belong together.
    const ks = memKeyStore();
    const opened = await openDeviceIdentity(ks, { today: DAY, ...MEM });
    const readOnly = {
      get: (id) => ks.get(id), del: (id) => ks.del(id), list: () => ks.list(),
      put: async (id, v) => {
        if (id === KEYSTORE_IDS.devMeta && (await ks.get(KEYSTORE_IDS.devMeta)) !== null) {
          throw new Error('disk full');
        }
        return ks.put(id, v);
      },
    };
    const out = await ensureAttestedDevice(readOnly, opened.forStore.memberId,
      opened.recovery.recSig.privateKey,
      { deviceId: opened.forStore.deviceId, createdAt: DAY });
    assert.equal(out.minted, true);
    assert.notEqual(
      await verifyAttestation(out.blob, opened.recovery.recSig.publicKey), null,
      'the blob is valid even though it could not be remembered');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §2 · THE SEVERITY SPLIT — `core/authz.js` stage 0a
//
// Every row here folds REAL ops, minted by real `selfAttest` calls and verified through the real
// `buildAttestOpen`. Nothing is stubbed except which blobs a given Mac has been shown, which is
// the variable the finding is about.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const BASE = Date.UTC(2026, 8, 3, 9, 0, 0);
const pad13 = (n) => String(n).padStart(13, '0');
const pad6 = (n) => String(n).padStart(6, '0');
/** A real 37-character stamp: `pad13(ms).pad6(ctr).deviceShort16` (core/stamp.js). */
const stampOf = (ms, ctr, short) => `${pad13(ms)}.${pad6(ctr)}.${short}`;

let A;                 // one Mac
let B;                 // a second Mac, same shape, different keys
let SPACE;

async function member(tag) {
  const ks = memKeyStore();
  const opened = await openDeviceIdentity(ks, { today: DAY, ...MEM });
  const att = await selfAttest(ks, opened.forStore, opened.recovery.recSig.privateKey,
    { createdAt: DAY });
  return {
    tag, ks,
    memberId: opened.forStore.memberId,
    deviceId: opened.forStore.deviceId,
    short: opened.forStore.deviceShort,
    recSig: opened.recovery.recSig,
    blob: att.blob,
  };
}

/** The opener `family/engine.js#refreshAttestations` builds, over exactly the blobs given. */
async function openerOver(rows) {
  return buildAttestOpen(await Promise.all(rows.map(async (r) => ({
    memberId: r.who.memberId,
    recoveryPubSigRaw: await exportRawPublic(r.who.recSig.publicKey),
    blobs: r.blobs,
  }))));
}

/** `member.set{dev.<name>}` authored by `stampShort`, in the family space. */
let opSeq = 0;
/** 22 base64url characters; `-` is in the alphabet, so it is a legal filler. */
const pad22 = (t) => `${t}----------------------`.slice(0, 22);
function attestOpFor(who, fields, { stampShort = who.short, act = who.memberId, ms = BASE } = {}) {
  opSeq += 1;
  const op = {
    v: 1,
    id: pad22(`op${opSeq}`),
    ts: stampOf(ms, opSeq, stampShort),
    space: SPACE,
    act,
    dev: who.deviceId,
    gid: pad22(`g${opSeq}`),
    k: 'member.set',
    e: `member:${who.memberId}`,
    f: Object.freeze({ ...fields }),
  };
  const v = validateOp(op);
  if (!v.ok) throw new Error(`e11 fixture built an invalid op: ${v.reason}`);
  return Object.freeze(op);
}

const reasonOf = (r, op) => (r.rejectionOf(op.id) || {}).reason ?? null;

/**
 * A blob that passes ADR 002 §2.3's conditions (2) and (3) — it names `housing` as its member and
 * `short` as its device, and `short` is what the register will be called — but whose signature is
 * junk. It is therefore unverifiable by ANY opener, which is exactly what a re-minted blob looks
 * like to a Mac with a stale roster, and it is the only way to reach the held/terminal decision
 * without being refused structurally first.
 */
function unverifiableBlob(housing, deviceId, short, seedFrom) {
  const donor = parseAttestationBlob(seedFrom);
  const payload = canonicalBytes({
    memberId: housing,
    deviceId,
    deviceShort: short,
    sigPubRaw: donor.sigPubRaw,
    kexPubRaw: donor.kexPubRaw,
    createdAt: donor.createdAt,
  });
  return `${b64u(payload)}.${b64u(new Uint8Array(64).fill(7))}`;
}

describe('§2 · a blob this Mac cannot verify YET is not the same verdict as a bad blob', () => {
  before(async () => {
    A = await member('a');
    B = await member('b');
    SPACE = `fsp_${pad22('E11FLEET')}`;
  });

  test('§2a · a self-filed attestation an EMPTY roster cannot verify is CURABLE, not terminal', async () => {
    // The exact shape the shell pass measured: the founder's opener was built before the joiner
    // existed, so the joiner's own attestation op — the ONE op that could ever attest that
    // device — arrived unverifiable.
    const op = attestOpFor(B, { [`dev.${B.short}`]: B.blob });
    const stale = await openerOver([{ who: A, blobs: [A.blob] }]);   // A has never seen B
    const r = foldAuthorized([op], { me: A.memberId, attestOpen: stale });

    assert.equal(reasonOf(r, op), REJECT_REASONS.UNATTESTED_DEVICE,
      'THE FIX. `badAttestation` here released the cursor past the op and made B permanently '
      + 'unattested on A; `unattestedDevice` is in `CURABLE_REFUSALS`, so the store parks the '
      + 'line under `PARK_REASONS.ATTESTATION` and `unparkAttested()` re-judges it.');

    // NOTHING WAS ADMITTED. The severity changed; the authority did not.
    assert.equal(r.admitted.length, 0);
    assert.equal(r.attestationOf(B.short), null);
    assert.equal(r.regs.has(`member:${B.memberId}`), false);
    assert.equal(r.attestedDevices.has(B.memberId), false);
  });

  test('§2b · the SAME bytes, once the roster has been read, are admitted', async () => {
    // The cure, and the honest-path control for §2a: the only thing that changed is what this
    // Mac has been shown.
    const op = attestOpFor(B, { [`dev.${B.short}`]: B.blob });
    const fresh = await openerOver([{ who: A, blobs: [A.blob] }, { who: B, blobs: [B.blob] }]);
    const r = foldAuthorized([op], { me: A.memberId, attestOpen: fresh });
    assert.equal(reasonOf(r, op), null);
    assert.equal(r.admitted.length, 1);
    assert.notEqual(r.attestationOf(B.short), null);
    assert.deepEqual([...r.attestedDevices.get(B.memberId)], [B.deviceId]);
  });

  test('§2c · every STRUCTURAL failure is still terminal — four of them, by name', async () => {
    const fresh = await openerOver([{ who: A, blobs: [A.blob] }, { who: B, blobs: [B.blob] }]);
    const ctx = { me: A.memberId, attestOpen: fresh };

    // i · the blob does not parse. No arrival changes that.
    const i = attestOpFor(B, { [`dev.${B.short}`]: 'not-a-blob' });
    assert.equal(reasonOf(foldAuthorized([i], ctx), i), REJECT_REASONS.BAD_ATTESTATION);

    // ii · the payload's deviceShort is not the register name.
    const ii = attestOpFor(B, { [`dev.${A.short}`]: B.blob });
    assert.equal(reasonOf(foldAuthorized([ii], ctx), ii), REJECT_REASONS.BAD_ATTESTATION);

    // iii · a peer's blob copied verbatim into my own record (§2.3 condition (3)).
    const iii = attestOpFor(B, { [`dev.${A.short}`]: A.blob });
    assert.equal(reasonOf(foldAuthorized([iii], ctx), iii), REJECT_REASONS.BAD_ATTESTATION);

    // iv · THE POSSESSION PROOF. The blob is B's own and perfectly good, but the op that files it
    // was stamped by A — a shape no honest flow in this product produces, because the register is
    // written by an op and an op is stamped by whoever authored it. The stale opener cannot
    // verify it either, so this is the row that separates "held" from "held for anyone who asks".
    const stale = await openerOver([{ who: A, blobs: [A.blob] }]);
    const iv = attestOpFor(B, { [`dev.${B.short}`]: B.blob }, { stampShort: A.short });
    assert.equal(reasonOf(foldAuthorized([iv], { me: A.memberId, attestOpen: stale }), iv),
      REJECT_REASONS.BAD_ATTESTATION);
  });

  test('§2d · with NO verifier wired at all the refusal stays terminal and loud', async () => {
    // E6-1 read from its far side, and the reason the park is conditioned on `haveVerifier`.
    // "Nothing in `src/js/` ever passed one" is a WIRING bug: no op that could ever arrive cures
    // it, and parking every family op on a build that forgot to call `setAttestOpen` would
    // convert a loud, total failure into a quiet, total one.
    const op = attestOpFor(B, { [`dev.${B.short}`]: B.blob });
    const blind = foldAuthorized([op], { me: A.memberId });
    assert.equal(reasonOf(blind, op), REJECT_REASONS.BAD_ATTESTATION);
    assert.equal(blind.rejected.length, 1);
  });

  test('§2e · an opener that DISAGREES with the register bytes is terminal (R4-15 preserved)', async () => {
    // Three answers, not two. `null` is "I have not seen this"; an ANSWER that contradicts the
    // bytes is a hostile or broken opener trying to smuggle in an attestation the log does not
    // carry, which is decidable here and can never become true.
    const op = attestOpFor(B, { [`dev.${B.short}`]: B.blob });
    const parsed = parseAttestationBlob(B.blob);
    const liar = () => ({ ...parsed, kexPubRaw: parseAttestationBlob(A.blob).kexPubRaw });
    assert.equal(reasonOf(foldAuthorized([op], { me: A.memberId, attestOpen: liar }), op),
      REJECT_REASONS.BAD_ATTESTATION);
  });

  test('§2f · a multi-register patch is never held — one register per op, or nothing', async () => {
    // The honest producer is `selfAttest`, which returns exactly one field. A patch carrying two
    // `dev.*` registers cannot be a self-attestation for both (one stamp, one short), so holding
    // it would be holding a shape no honest Mac emits — and would break the bound in §3.
    const stale = await openerOver([{ who: A, blobs: [A.blob] }]);
    const both = attestOpFor(B, { [`dev.${B.short}`]: B.blob, [`dev.${A.short}`]: A.blob });
    assert.equal(reasonOf(foldAuthorized([both], { me: A.memberId, attestOpen: stale }), both),
      REJECT_REASONS.BAD_ATTESTATION);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §3 · CAN AN ATTACKER FILL THE PARK?
//
// The question a reviewer asks of any parkable refusal, and this project has been bitten by the
// answer twice this month (the epoch ladder, the parking slot). A park is a durable line on every
// peer's disk; a park an unauthenticated party can mint at will is a denial-of-service primitive.
//
// THE BOUND, STATED: **at most one held attestation claim per `(member record, dev.<short>)`
// register, and a register may be held only by an op the holder of that short's PRIVATE KEY
// authored.** So the parks a hostile member can create equal the number of devices they hold —
// the same number that bounds their legitimate registers, and a number the relay already caps by
// refusing envelopes from devices it has no row for. It does not grow with ops sent, blobs
// minted, or time.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('§3 · the park is bounded, and the bound is not a constant somebody picked', () => {
  test('§3a · 50 unverifiable claims on ONE register produce exactly ONE park', async () => {
    // The flood. Eve holds one device, so she can author ops stamped with exactly one short, so
    // she can name exactly one register. She varies the BLOB instead — 50 payload-identical
    // claims that differ only in the bytes after the dot, which is what a re-signing loop
    // produces and what an attacker would reach for.
    const eve = await member('eve');
    const stale = await openerOver([{ who: A, blobs: [A.blob] }]);
    const ops = [];
    for (let i = 0; i < 50; i++) {
      // A blob whose signature half is junk — unverifiable, exactly like a re-minted one is to a
      // Mac with a stale roster. The FOLD cannot tell the two apart, which is the whole point.
      const [head] = eve.blob.split('.');
      ops.push(attestOpFor(eve, { [`dev.${eve.short}`]: `${head}.${'A'.repeat(80 + i)}` },
        { ms: BASE + i }));
    }
    const r = foldAuthorized(ops, { me: A.memberId, attestOpen: stale });

    const parked = r.rejected.filter((o) => reasonOf(r, o) === REJECT_REASONS.UNATTESTED_DEVICE);
    const terminal = r.rejected.filter((o) => reasonOf(r, o) === REJECT_REASONS.WRITE_ONCE);
    assert.equal(parked.length, 1, `the flood produced ${parked.length} parks, not 1`);
    assert.equal(terminal.length, 49);
    assert.equal(r.admitted.length, 0);

    // AND IT IS THE SAME ONE ON EVERY MAC. The held claim is the minimal one under the join's own
    // order, which is a function of the SET — so two devices that received the 50 ops in
    // different orders hold the same line and neither drifts.
    const shuffled = [...ops].reverse();
    const r2 = foldAuthorized(shuffled, { me: A.memberId, attestOpen: stale });
    const held2 = r2.rejected.filter((o) => reasonOf(r2, o) === REJECT_REASONS.UNATTESTED_DEVICE);
    assert.equal(held2.length, 1);
    assert.equal(held2[0].id, parked[0].id, 'two arrival orders held two different lines');
  });

  test('§3b · a member cannot park anything in a PEER\'s record', async () => {
    // The first of the three facts the bound rests on: `op.act === subject`. Without it a member
    // could fill every other member's record and the bound would be the circle's size squared.
    const eve = await member('eve');
    const stale = await openerOver([{ who: A, blobs: [A.blob] }]);
    const intruder = attestOpFor(A, { [`dev.${eve.short}`]: eve.blob },
      { act: eve.memberId, stampShort: eve.short });
    const r = foldAuthorized([intruder], { me: A.memberId, attestOpen: stale });
    assert.equal(reasonOf(r, intruder), REJECT_REASONS.NOT_SELF);
  });

  test('§3c · a member cannot park under a short they cannot PROVE', async () => {
    // The second fact: `devOf(op.ts) === att.deviceShort`. `openOp`'s P2, P3 and check 4 bind the
    // stamp to the signing key the envelope verified under, so varying the register name costs a
    // second device private key — and that device has to be one the relay admitted into the
    // space. Twenty invented shorts, twenty terminal refusals, zero parks.
    const eve = await member('eve');
    const stale = await openerOver([{ who: A, blobs: [A.blob] }]);
    const ops = [];
    for (let i = 0; i < 20; i++) {
      const other = await member(`x${i}`);                                  // eslint-disable-line no-await-in-loop
      // The blob is honest in every checkable respect EXCEPT the signature: it names EVE as its
      // housing member (condition (3)) and its own `deviceShort` matches the register name
      // (condition (2)), so nothing structural refuses it before the held decision is reached.
      // What Eve cannot do is author the op that files it — her stamp ends in HER short.
      const blob = unverifiableBlob(eve.memberId, other.deviceId, other.short, other.blob);
      ops.push(attestOpFor(eve, { [`dev.${other.short}`]: blob },
        { stampShort: eve.short, ms: BASE + 1000 + i }));
    }
    const r = foldAuthorized(ops, { me: A.memberId, attestOpen: stale });
    assert.equal(r.rejected.filter((o) => reasonOf(r, o) === REJECT_REASONS.UNATTESTED_DEVICE).length, 0);
    assert.equal(r.rejected.filter((o) => reasonOf(r, o) === REJECT_REASONS.BAD_ATTESTATION).length, 20);
  });

  test('§3d · a register already claimed by an ADMITTED op is never held', async () => {
    // The third fact, and the one that keeps verified ops judged exactly as they were: a later
    // unverifiable claim on a taken register is `writeOnce` — terminal — and not "ask me again".
    const fresh = await openerOver([{ who: A, blobs: [A.blob] }, { who: B, blobs: [B.blob] }]);
    const good = attestOpFor(B, { [`dev.${B.short}`]: B.blob }, { ms: BASE });
    const [head] = B.blob.split('.');
    const later = attestOpFor(B, { [`dev.${B.short}`]: `${head}.${'B'.repeat(80)}` },
      { ms: BASE + 5000 });
    const r = foldAuthorized([good, later], { me: A.memberId, attestOpen: fresh });
    assert.equal(reasonOf(r, good), null);
    assert.equal(reasonOf(r, later), REJECT_REASONS.WRITE_ONCE);
    assert.notEqual(r.attestationOf(B.short), null, 'the honest device is still attested');
  });

  test('§3e · a hostile park cannot un-attest an honest peer', async () => {
    // The mirror of §3d and the trade this file refuses to make in the other direction. Eve
    // squats a claim on her own record; B's own register, filed by B, is unaffected.
    const eve = await member('eve');
    const fresh = await openerOver([
      { who: A, blobs: [A.blob] }, { who: B, blobs: [B.blob] }, { who: eve, blobs: [eve.blob] }]);
    const [head] = eve.blob.split('.');
    const squat = attestOpFor(eve, { [`dev.${eve.short}`]: `${head}.${'C'.repeat(80)}` });
    const honest = attestOpFor(B, { [`dev.${B.short}`]: B.blob });
    const r = foldAuthorized([squat, honest], { me: A.memberId, attestOpen: fresh });
    assert.equal(reasonOf(r, honest), null);
    assert.notEqual(r.attestationOf(B.short), null);
    assert.equal(reasonOf(r, squat), REJECT_REASONS.UNATTESTED_DEVICE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §4 · THE ACCEPTANCE CRITERION — five consecutive launches, on the real relay
//
// "A founder must receive a joiner's entry on FIVE CONSECUTIVE LAUNCHES, with the refusal ledger
// flat at zero." That is a behavioural criterion, not a unit test, so this section drives the
// real engine over the real relay and counts what the shell driver counts.
//
// THE STALENESS IS THE FIXTURE. Each Mac carries its own `seen` set of blobs, widened only by
// `readRoster(mac)` — which is what `family/engine.js` does on start and on every key pass. The
// founder's read on launch 1 happens BEFORE the joiner exists, which is the race the shell pass
// reproduced on a dial by running the settle loop twice.
// ─────────────────────────────────────────────────────────────────────────────────────────────

let GEN = 0;

/** Widen one Mac's opener from the relay's own roster, and install it on that Mac's store. */
async function readRoster(C, mac) {
  const list = await mac.transport.request(
    'GET', `/api/v1/spaces/${C.spaceId}/members`, undefined, undefined);
  assert.equal(list.status, 200);
  const rows = list.json.members.map((m) => ({
    memberId: m.memberId,
    recoveryPubSigRaw: m.recoveryPubSig,
    blobs: (m.devices || []).map((d) => d.attestation).filter((b) => typeof b === 'string' && b),
  }));
  mac.opener = await buildAttestOpen(rows);
  if (mac.store) await on(mac, () => { mac.store.setAttestOpen(mac.opener); });
  return rows;
}

/**
 * Re-open one Mac over its EXISTING disk — a relaunch, not a fresh install. `bootMac` clears the
 * disk, which would delete the very state the finding is about (the log, the cursor, the parked
 * lines and the register that stops a republish).
 */
async function relaunch(C, mac) {
  GEN += 1;
  mac.store = (await import(`../../src/js/store.js?e11-${mac.tag}-${GEN}`)).store;
  await on(mac, async () => {
    const s = mac.store;
    s.listeners.clear();
    s.ready = false;
    s.warnings.length = 0;
    s.useIdentity({ ...mac.forStore, peerDeviceIds: [] });
    s.setAttestOpen(mac.opener ?? (() => null));
    await s.init();
    s.useFamilySpace(C.spaceId);
  });
  mac.engine = engineFor(C, mac);
}

/** What the shell driver calls the refusal ledger: `badAttestation` on this Mac, this launch. */
const badAttestations = (mac) =>
  mac.store.warnings.filter((w) => /refused: badAttestation/.test(String(w.message ?? w))).length;

describe('§4 · five consecutive launches, real relay, real engine', () => {
  test('§4a · the founder receives a joiner\'s entry on all five, ledger flat at zero', async () => {
    const C = await buildCircle(['papa', 'mama']);
    const papa = C.papa;
    const mama = C.mama;

    // ── LAUNCH 0 · the founder founds the circle and reads the roster it can see, which is
    //    itself. This is the exact state the shell pass's founder was in.
    await refreshRoster(C);
    await bootMac(C, papa);
    await readRoster(C, papa);
    await on(papa, async () => {
      assert.equal(papa.store.apply('attestMyDevice', {
        deviceShort: papa.forStore.deviceShort, blob: papa.myBlob,
      }), true);
      assert.equal(papa.store.apply('claimAdmin', {}), true);
      papa.engine = engineFor(C, papa);
      assert.equal((await papa.engine.pushNow()).pushed, 2);
    });
    const papaOpenerBefore = papa.opener;

    // ── the joiner arrives AFTER that read ────────────────────────────────────────────────────
    assert.equal((await join(C, mama)).status, 200);
    await refreshRoster(C);                       // the ENVELOPE table (P1); not the opener
    // The admin's key pass — `sync/keys.js#deliver` wraps the current epoch to the joiner's
    // device. It does NOT widen `papa.opener`: that is `readRoster` here, and it is the variable
    // the finding is about.
    await on(papa, () => papa.engine.syncNow());
    await bootMac(C, mama);
    await readRoster(C, mama);
    await on(mama, async () => {
      mama.engine = engineFor(C, mama);
      await mama.engine.syncNow();
      await publishAttestation(C, mama);
    });
    assert.equal(papa.opener, papaOpenerBefore, 'the founder has not re-read the roster yet');

    // ── FIVE LAUNCHES ─────────────────────────────────────────────────────────────────────────
    const crossed = [];
    const ledger = [];
    const mamaBlobs = new Set([mama.myBlob]);

    for (let launch = 1; launch <= 5; launch++) {
      // The joiner authors one Geteilt entry per launch and pushes it.
      const uuid = newUuid();
      /* eslint-disable no-await-in-loop */
      await relaunch(C, mama);
      await on(mama, async () => {
        await mama.engine.syncNow();
        await publishSharedEntry(C, mama, uuid, { 'pub.text': `Eintrag ${launch}` });
      });
      // Whatever `selfAttest` would mint on THIS launch — the register the engine would publish.
      const again = await selfAttest(mama.ks, mama.forStore, mama.recovery.recSig.privateKey,
        { createdAt: DAY });
      mamaBlobs.add(again.blob);

      // The founder launches. Its opener is whatever its LAST roster read left behind — on
      // launch 1 that is a roster without the joiner in it.
      await relaunch(C, papa);
      await on(papa, () => papa.engine.syncNow());
      // …and then the key pass reads the roster, exactly as `refreshAttestations` does.
      await readRoster(C, papa);
      await on(papa, () => papa.engine.syncNow());

      const board = await on(papa, () => boardOf(C, papa));
      const key = familyKey('fnote', mama.forStore.memberId, uuid);
      crossed.push(board.some((n) => n.id === key || n.text === `Eintrag ${launch}`));
      ledger.push(await on(papa, () => badAttestations(papa)));
      /* eslint-enable no-await-in-loop */
    }

    // ── THE MEASUREMENT ───────────────────────────────────────────────────────────────────────
    assert.deepEqual(crossed, [true, true, true, true, true],
      `the founder received the joiner's entry in ${crossed.filter(Boolean).length} of 5 launches`);
    assert.deepEqual(ledger, [0, 0, 0, 0, 0],
      `the refusal ledger read ${ledger.join(' → ')} — it must be flat at zero`);
    assert.equal(mamaBlobs.size, 1,
      `the joiner minted ${mamaBlobs.size} distinct attestation blobs over five launches`);

    // The joiner's device really is attested on the founder — the property every entry depends on.
    const attested = await on(papa, () => {
      const r = foldAuthorized([...papa.store._log.ops({ includeParked: true })],
        papa.store._authzCtx());
      return r.attestedDevices.get(mama.forStore.memberId);
    });
    assert.deepEqual([...(attested || [])], [mama.forStore.deviceId]);
  });

  test('§4b · the first launch really was the race — the op is PARKED, then cured', async () => {
    // §4a would pass for the wrong reason if the founder's first pull never met an unverifiable
    // attestation at all. This row proves it did: with the stale opener the joiner's own
    // attestation op is refused CURABLY and the LINE is kept, and the same store cures it once
    // the roster is read — no second fetch, because the relay would never serve it again.
    const C = await buildCircle(['papa', 'mama']);
    const { papa, mama } = C;

    await refreshRoster(C);
    await bootMac(C, papa);
    await readRoster(C, papa);
    await on(papa, async () => {
      papa.store.apply('attestMyDevice', {
        deviceShort: papa.forStore.deviceShort, blob: papa.myBlob,
      });
      papa.store.apply('claimAdmin', {});
      papa.engine = engineFor(C, papa);
      await papa.engine.pushNow();
    });
    const staleOpener = papa.opener;

    assert.equal((await join(C, mama)).status, 200);
    await refreshRoster(C);
    await on(papa, () => papa.engine.syncNow());          // the admin's key pass
    await bootMac(C, mama);
    await readRoster(C, mama);
    const uuid = newUuid();
    await on(mama, async () => {
      mama.engine = engineFor(C, mama);
      await mama.engine.syncNow();
      await publishAttestation(C, mama);
      await publishSharedEntry(C, mama, uuid, { 'pub.text': 'Omas Geburtstag' });
    });

    // The founder pulls with the roster it read before the joiner existed.
    papa.opener = staleOpener;
    await on(papa, () => papa.store.setAttestOpen(staleOpener));
    const held = await on(papa, async () => {
      await papa.engine.syncNow();
      return {
        parked: papa.store._log.parkedOps().map((e) => e.reason),
        bad: badAttestations(papa),
        board: boardOf(C, papa).length,
      };
    });
    assert.ok(held.parked.length >= 1,
      'the attestation op was dropped rather than held — the cursor is now past it for ever');
    assert.ok(held.parked.every((r) => r === 'attestation'));
    assert.equal(held.bad, 0, 'and nothing was refused terminally');

    // THE CURE, on the same store, from the parked line alone.
    await readRoster(C, papa);
    const cured = await on(papa, async () => {
      await papa.engine.syncNow();
      const board = boardOf(C, papa);
      return {
        parked: papa.store._log.parkedOps().length,
        text: board.map((n) => n.text),
      };
    });
    assert.equal(cured.parked, 0, 'the held lines were never re-judged');
    assert.ok(cured.text.includes('Omas Geburtstag'),
      'the joiner\'s entry did not cross after the roster arrived');
  });

  test('§4c · the joiner republishes NOTHING on relaunch — one register, five launches', async () => {
    // The other half of the finding, measured where it bites: `publishMyAttestation`'s guard is
    // the folded register, and a re-signed blob would be a SECOND write to it. With the
    // attestation minted once, five launches leave exactly one `dev.*` cell and one writer.
    const C = await buildCircle(['papa', 'mama']);
    const { papa, mama } = C;
    await refreshRoster(C);
    await bootMac(C, papa);
    await readRoster(C, papa);
    await on(papa, async () => {
      papa.store.apply('attestMyDevice', {
        deviceShort: papa.forStore.deviceShort, blob: papa.myBlob,
      });
      papa.store.apply('claimAdmin', {});
      papa.engine = engineFor(C, papa);
      await papa.engine.pushNow();
    });
    assert.equal((await join(C, mama)).status, 200);
    await refreshRoster(C);
    await on(papa, () => papa.engine.syncNow());          // the admin's key pass
    await bootMac(C, mama);
    await readRoster(C, mama);
    await on(mama, async () => {
      mama.engine = engineFor(C, mama);
      await mama.engine.syncNow();
      await publishAttestation(C, mama);
    });

    for (let i = 0; i < 5; i++) {
      /* eslint-disable no-await-in-loop */
      await relaunch(C, mama);
      await on(mama, async () => {
        await mama.engine.syncNow();
        const short = mama.forStore.deviceShort;
        const held = mama.store.registers().get(`member:${mama.forStore.memberId}`)?.get(`dev.${short}`);
        // `family/engine.js#publishMyAttestation`'s guard, verbatim.
        if (held === undefined || typeof held.value !== 'string' || held.value === '') {
          const att = await selfAttest(mama.ks, mama.forStore, mama.recovery.recSig.privateKey,
            { createdAt: DAY });
          mama.store.apply('attestMyDevice', { deviceShort: short, blob: att.blob });
        }
      });
      /* eslint-enable no-await-in-loop */
    }

    // HER OWN register, not the circle's: papa's attestation is in this log too and counting it
    // would make the row pass at 2 for the wrong reason.
    const mine = await on(mama, () => {
      const ops = [...mama.store._log.ops({ includeParked: true })];
      return ops.filter((o) => o.k === 'member.set'
        && o.act === mama.forStore.memberId
        && Object.keys(o.f).some((n) => n.startsWith('dev.')));
    });
    assert.equal(mine.length, 1, `five launches wrote ${mine.length} attestation ops, not 1`);
    assert.deepEqual(Object.keys(mine[0].f), [`dev.${mama.forStore.deviceShort}`]);
    assert.equal(mine[0].f[`dev.${mama.forStore.deviceShort}`], mama.myBlob,
      'the register holds the blob the RELAY\'s roster carries — the one every peer can verify');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// §5 · F-SHELL-1(b) — THE ATTESTATION THE CHECKPOINT ATE
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS SECTION EXISTS, AND WHAT IT COST TO NOT HAVE IT
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// §1–§4 close F-SHELL-1(a): the blob is minted once, and an unverifiable claim is HELD rather
// than refused. `store.js#_absorbedAttestOps` was landed alongside them to close (b) — a peer's
// `member.set{dev.*}` op that the local checkpoint absorbed is no longer a LINE, so
// `foldAuthorized` never sees it, and every op that peer authors parks `unattestedDevice` for
// ever. It shipped with **no test of any kind**, and it did not work:
//
//     `foldAuthorized` Pass A runs `classifyOp` before any attestation condition. `ops.js:418`
//     requires `op.id` to be a 22-char opId and `ops.js:445` requires the SAME of `op.gid`. The
//     reconstruction passed `gid: null` and, for a cell with no opId, minted the id
//     `cp_<member>_<name>`. Both are rejected `{stage:'attestation', reason:'shape'}`. Every
//     reconstructed op was discarded before it could attest anything, and the method was inert.
//
// It was invisible to 5,448 green rows because nothing exercised it, and invisible in the shell
// run because it only bites the Mac whose checkpoint happened to absorb the founder's op — in
// `scripts/shell-family-e2e.mjs` that was Mama and not Oma, on the same relay, in the same run,
// which read as flakiness rather than as a defect. Measured from the kept scratch dir of a real
// run: Mama had a `checkpoint.json` whose horizon was 5 µs after her own first op, held Papa's
// `dev.AB9…` cell in it, and rebuilt Papa's op on every fold — and threw it away at Pass A, 
// while Oma had no checkpoint at all and read the same entry without trouble.
//
// So: the shape rule is the row. §5a is the property, §5b is the reconstruction's own shape, and
// §5c is the honest-path control that stops §5a passing because nothing was absorbed.
//
//   M-E11-6  `gid: cell.op` → `gid: null`  (the code exactly as it shipped)  → §5a · §5b RED
//   M-E11-7  the `isOpId(cell.op)` guard removed, id/gid minted `cp_<name>`   → §5b RED
//   M-E11-8  `_absorbedAttestOps` returns `[]`                                → §5a · §5b RED
//   M-E11-9  the still-a-line skip removed (every cell reconstructed always)  → §5c RED
//   M-E11-10 the `arriving` batch ignored (the manufactured splice returns)  → §5d RED
//   M-E11-11 `attestMyDevice`'s idempotence gate removed (`held === blob` no
//            longer DECLINES), so a second identical claim is authored          → §5e RED
//
// Six mutants, one run each on a scratch copy, rows MEASURED not predicted; control 25/25.
// §5e is a CHARACTERIZATION, not a fix: F-SHELL-4 is measured and open, and its docblock says
// which hypothesis was built, tested and DISPROVEN rather than shipped.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Absorb every line at or below the current max into the checkpoint — what `_persistOps` ②
 *  does under `TAIL_COMPACT_AT`, and what a joiner's first launch does to the founder's ops. */
const absorbEverything = (mac) => mac.store._log.compact();

describe('§5 · the attestation the checkpoint absorbed', () => {
  test('§5a · a peer whose attestation is only in the checkpoint is still attested', async () => {
    const C = await buildCircle(['papa', 'mama']);
    const { papa, mama } = C;
    await refreshRoster(C);
    await bootMac(C, papa);
    await readRoster(C, papa);
    await on(papa, async () => {
      papa.store.apply('attestMyDevice', {
        deviceShort: papa.forStore.deviceShort, blob: papa.myBlob,
      });
      papa.store.apply('claimAdmin', {});
      papa.engine = engineFor(C, papa);
      await papa.engine.pushNow();
    });
    assert.equal((await join(C, mama)).status, 200);
    await refreshRoster(C);
    await on(papa, () => papa.engine.syncNow());
    await bootMac(C, mama);
    await readRoster(C, mama);
    await on(mama, async () => {
      mama.engine = engineFor(C, mama);
      await mama.engine.syncNow();
      await publishAttestation(C, mama);
    });

    // The founder pulls the joiner's attestation and admits it: a LINE, and the device attested.
    await on(papa, () => papa.engine.syncNow());
    await readRoster(C, papa);
    await on(papa, () => papa.engine.syncNow());
    const lineBefore = await on(papa, () => [...papa.store._log.ops({ includeParked: true })]
      .some((o) => o.act === mama.forStore.memberId
        && Object.keys(o.f || {}).some((n) => n.startsWith('dev.'))));
    assert.equal(lineBefore, true, 'precondition: the joiner\'s attestation is a line here');

    // ── THE FIXTURE, AND IT IS THE PRODUCT'S OWN CODE ────────────────────────────────────────
    // `_persistOps` step ② calls exactly this once the tail passes `TAIL_COMPACT_AT`, and a
    // joiner's first launch fixes a horizon above every op the founder authored before it
    // existed. Either way the line is gone and only the register cell is left.
    await on(papa, () => absorbEverything(papa));
    const lineAfter = await on(papa, () => [...papa.store._log.ops({ includeParked: true })]
      .some((o) => o.act === mama.forStore.memberId
        && Object.keys(o.f || {}).some((n) => n.startsWith('dev.'))));
    assert.equal(lineAfter, false, 'the fixture did nothing — the attestation op is still a line');
    const cell = await on(papa, () => papa.store.registers()
      .get(`member:${mama.forStore.memberId}`)?.get(`dev.${mama.forStore.deviceShort}`));
    assert.equal(typeof cell?.value, 'string', 'the checkpoint kept the register cell');

    // ── THE PROPERTY ─────────────────────────────────────────────────────────────────────────
    // The joiner authors an entry AFTER the absorption, so nothing about it predates the
    // horizon: if the device is unattested here, this op parks and the board stays empty.
    const uuid = newUuid();
    await on(mama, () => publishSharedEntry(C, mama, uuid, { 'pub.text': 'Nach dem Checkpoint' }));
    await on(papa, () => papa.engine.syncNow());

    const board = await on(papa, () => boardOf(C, papa));
    const key = familyKey('fnote', mama.forStore.memberId, uuid);
    assert.ok(board.some((n) => n.id === key || n.text === 'Nach dem Checkpoint'),
      'the founder did not receive the entry — the absorbed attestation was not reconstructed');
    assert.equal(await on(papa, () => badAttestations(papa)), 0,
      'the refusal ledger must stay flat at zero across the absorption');

    const attested = await on(papa, () => {
      const r = foldAuthorized(
        [...papa.store._absorbedAttestOps(), ...papa.store._log.ops({ includeParked: true })],
        papa.store._authzCtx());
      return r.attestedDevices.get(mama.forStore.memberId);
    });
    assert.deepEqual([...(attested || [])], [mama.forStore.deviceId],
      'the joiner\'s device is not attested from the checkpoint alone');
  });

  test('§5b · every reconstruction is a WELL-FORMED op — the shape rule that killed it', async () => {
    // §5a is a behaviour and could in principle be satisfied by some other path. This is the
    // defect itself, stated as a property of the reconstruction: `foldAuthorized` runs
    // `classifyOp` on it FIRST, so anything it emits must classify as `admit`. A reconstruction
    // that fails here is discarded before a single attestation condition runs, silently.
    const C = await buildCircle(['papa', 'mama']);
    const { papa, mama } = C;
    await refreshRoster(C);
    await bootMac(C, papa);
    await readRoster(C, papa);
    await on(papa, async () => {
      papa.store.apply('attestMyDevice', {
        deviceShort: papa.forStore.deviceShort, blob: papa.myBlob,
      });
      papa.store.apply('claimAdmin', {});
      papa.engine = engineFor(C, papa);
      await papa.engine.pushNow();
    });
    assert.equal((await join(C, mama)).status, 200);
    await refreshRoster(C);
    await on(papa, () => papa.engine.syncNow());
    await bootMac(C, mama);
    await readRoster(C, mama);
    await on(mama, async () => {
      mama.engine = engineFor(C, mama);
      await mama.engine.syncNow();
      await publishAttestation(C, mama);
    });
    await on(papa, () => papa.engine.syncNow());
    await readRoster(C, papa);
    await on(papa, () => papa.engine.syncNow());
    await on(papa, () => absorbEverything(papa));

    const rebuilt = await on(papa, () => papa.store._absorbedAttestOps());
    assert.ok(rebuilt.length >= 2,
      `nothing was reconstructed (${rebuilt.length}) — the fixture absorbed nothing`);
    for (const op of rebuilt) {
      // `classifyOp` is the gate, and it is the one that has to answer `admit` — `foldAuthorized`
      // Pass A rejects anything else as `{stage:'attestation', reason:'shape'}` before a single
      // attestation condition runs. NOTE that `validateOp` RETURNS its verdict rather than
      // throwing, so `assert.doesNotThrow(() => validateOp(op))` is vacuous and passes over a
      // malformed op — the first cut of this row made exactly that mistake and survived M-E11-6.
      const verdict = classifyOp(op, { nowMs: Date.now() });
      assert.equal(verdict.status, 'admit',
        `a reconstructed attestation op is malformed (${verdict.reason}): `
        + JSON.stringify({ ...op, f: '…' }));
      assert.deepEqual(validateOp(op), { ok: true }, 'core/ops.js#validateOp — the same op, the same answer');
      assert.equal(op.k, 'member.set');
      assert.equal(op.act, op.e.slice('member:'.length),
        'a reconstruction may only ever land in its own author\'s record');
      assert.equal(Object.keys(op.f).length, 1, 'exactly one dev.* register per reconstruction');
    }

    // DETERMINISTIC: two folds of the same checkpoint build byte-identical ops, or two Macs
    // holding the same cell would disagree about what the log says.
    const again = await on(papa, () => papa.store._absorbedAttestOps());
    assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(rebuilt)));

    // ── THE GUARD ON A CELL WITH NO OPID ─────────────────────────────────────────────────────
    // A cell is `{value, stamp, author, op}`, but a checkpoint written by an older build (or a
    // hand-edited `checkpoint.json`) can be missing `op`. There is then no deterministic identity
    // to give the reconstruction: a minted one — `cp_<member>_<name>` was the first cut — is
    // neither a 22-char opId nor stable across launches, so it is rejected at Pass A anyway AND
    // it would be a different op every time. The cell must contribute nothing at all.
    const victim = await on(papa, () => {
      const cells = papa.store._log.registers().get(`member:${mama.forStore.memberId}`);
      const name = `dev.${mama.forStore.deviceShort}`;
      const cell = cells.get(name);
      cells.set(name, { value: cell.value, stamp: cell.stamp, author: cell.author });
      return name;
    });
    const afterStrip = await on(papa, () => papa.store._absorbedAttestOps());
    assert.equal(afterStrip.some((o) => Object.keys(o.f)[0] === victim), false,
      'a register cell carrying no opId was reconstructed anyway — with an invented id');
    assert.equal(afterStrip.length, rebuilt.length - 1,
      'exactly the opId-less cell dropped out, and nothing else moved');
  });

  test('§5d · a re-served op is not spliced against its own reconstruction', async () => {
    // A register cell does not retain the writing op's `gid`, so the reconstruction has to
    // synthesize one — which means the reconstruction and the REAL op are two different bodies
    // under one opId. `foldAuthorized` Pass A calls that envelope splicing (ADR 002 §5.1),
    // resolves it by canonical max and reports the opId in `splicedIds`. A relay re-serves an op
    // on every cursor reset, so without the `arriving` argument this store reports tampering
    // that never happened, on ops nobody touched. Measured before the argument: 2 reconstructions
    // → 2 spliced ids.
    const C = await buildCircle(['papa', 'mama']);
    const { papa, mama } = C;
    await refreshRoster(C);
    await bootMac(C, papa);
    await readRoster(C, papa);
    await on(papa, async () => {
      papa.store.apply('attestMyDevice', {
        deviceShort: papa.forStore.deviceShort, blob: papa.myBlob,
      });
      papa.store.apply('claimAdmin', {});
      papa.engine = engineFor(C, papa);
      await papa.engine.pushNow();
    });
    assert.equal((await join(C, mama)).status, 200);
    await refreshRoster(C);
    await on(papa, () => papa.engine.syncNow());
    await bootMac(C, mama);
    await readRoster(C, mama);
    await on(mama, async () => {
      mama.engine = engineFor(C, mama);
      await mama.engine.syncNow();
      await publishAttestation(C, mama);
    });
    await on(papa, () => papa.engine.syncNow());
    await readRoster(C, papa);
    await on(papa, () => papa.engine.syncNow());
    await on(papa, () => absorbEverything(papa));

    const rebuilt = await on(papa, () => papa.store._absorbedAttestOps());
    assert.ok(rebuilt.length >= 2, 'the fixture absorbed nothing');
    // THE RE-SERVE. The same ops, carrying their true `gid` — which is exactly what the relay
    // hands back after a cursor reset, and is not equal to the synthesized one.
    const reserved = rebuilt.map((o) => ({ ...o, gid: 'ZZZZZZZZZZZZZZZZZZZZZZ' }));
    assert.deepEqual(await on(papa, () => papa.store._absorbedAttestOps(reserved)), [],
      'an op present in the arriving batch was rebuilt beside itself — that is a manufactured splice');
    const v = await on(papa, () => foldAuthorized(
      [...papa.store._absorbedAttestOps(reserved),
        ...papa.store._log.ops({ includeParked: true }), ...reserved],
      papa.store._authzCtx()));
    assert.deepEqual([...(v.splicedIds || [])], [],
      `${[...(v.splicedIds || [])].length} opId(s) were reported as spliced envelopes, on ops nobody tampered with`);
  });

  test('§5e · CHARACTERIZATION — the write-once guard, and the launch on which it failed', async () => {
    // ═══ F-SHELL-4, MEASURED IN THE SHIPPED APP AND STILL OPEN ═══════════════════════════════
    //
    // Mama published her OWN device attestation TWICE, in two consecutive launches, for a
    // register ADR 001 §4.0 makes write-once. Same device, same 545-byte blob, 3.8 s apart:
    // `KHtu…` during her join (phase 02) and `luxB…` on her next launch (phase 06). Both are
    // admissible on their face, so §4.0 does exactly what it must — every Mac keeps the minimal
    // claim under `≺` and refuses the other `writeOnce`, TERMINALLY — and the circle then splits
    // on the record: Mama's log names `KHtu…` as the writer of her register, Papa's, Oma's and
    // Opa's name `luxB…`. Nothing breaks, because the two blobs are byte-identical and the
    // device stays attested either way. What remains is a permanent refusal on every peer, on
    // every launch, for ever. Over five acceptance runs of `scripts/shell-family-e2e.mjs` the
    // refusal ledger read **2 · 34 · 48 · 2 · 34** — the 2s being one unrelated `notOwner`
    // (F-SHELL-3), the rest being this.
    //
    // ⚠ THE CAUSE IS NOT YET NAMED, AND THIS ROW DOES NOT CLAIM IT IS. The obvious hypothesis —
    // that `publishMyAttestation` reads `store.registers()`, which is the AUTHORIZED fold, and
    // so sees no cell before `engine.js:733` installs `attestOpen` — was built, tested here, and
    // DISPROVEN: `_noteAuthzVerdict` returns the raw base map unless there are withdrawals, and
    // `store.js#_withdrawalsOf` names `badAttestation` and `writeOnce` as explicitly NOT
    // withdrawals, so the cell is visible with or without a verifier. The fix built on that
    // hypothesis was reverted rather than shipped. In the failing run Mama's `KHtu…` also
    // carried `seq: null` and never reached the relay at all, which is the thread to pull next.
    //
    // WHAT THIS ROW IS FOR. The guard had NO test of any kind — which is how a defect this loud
    // survived six rounds. It pins the two cases the guard must answer, so that whoever fixes
    // F-SHELL-4 starts from a characterized guard rather than from nothing.
    const C = await buildCircle(['papa', 'mama']);
    const { papa } = C;
    await refreshRoster(C);
    await bootMac(C, papa);
    await readRoster(C, papa);
    await on(papa, async () => {
      papa.store.apply('attestMyDevice', {
        deviceShort: papa.forStore.deviceShort, blob: papa.myBlob,
      });
      papa.store.apply('claimAdmin', {});
      papa.engine = engineFor(C, papa);
      await papa.engine.pushNow();
    });
    const short = papa.forStore.deviceShort;
    const me = `member:${papa.forStore.memberId}`;

    // ── (1) THE LIVE LINE, with no verifier installed and the withdrawal fold ARMED — the first
    //    `registers()` call of a relaunch, which is the state the shipped app is in at
    //    `engine.js:629`. `_authzArmed` starts `true` in the constructor and is re-derived on
    //    every fold, so this is the launch state and not a stub.
    await on(papa, () => {
      papa.store.setAttestOpen(() => null);
      papa.store._authz = null;
      papa.store._authzArmed = true;
    });
    const seenLive = await on(papa, () => papa.store.registers().get(me)?.get(`dev.${short}`));
    assert.equal(typeof seenLive?.value, 'string',
      'the guard sees no claim on a verifier-less launch — it would publish a second one');

    // ── (2) THE ABSORBED CELL. Once the checkpoint has eaten the line there is no line left, and
    //    the register cell is the only record that this Mac ever made the claim.
    await on(papa, () => absorbEverything(papa));
    assert.equal(await on(papa, () => [...papa.store._log.ops({ includeParked: true })]
      .some((o) => o.k === 'member.set' && Object.keys(o.f || {}).includes(`dev.${short}`))), false,
      'the fixture did nothing — the claim is still a line');
    const seenAbsorbed = await on(papa, () => papa.store.registers().get(me)?.get(`dev.${short}`));
    assert.equal(seenAbsorbed?.value, papa.myBlob,
      'an absorbed claim is invisible to the guard — re-publishing it is exactly F-SHELL-4');

    // ── (3) THE CONSTRUCTOR'S OWN GATE. `core/ops.js#attestMyDevice` declines the same blob and
    //    THROWS on a different one; neither may mint a second op for one write-once register.
    await on(papa, () => {
      assert.equal(papa.store.apply('attestMyDevice', { deviceShort: short, blob: papa.myBlob }),
        false, 'the same blob a second time must be DECLINED, not authored');
    });
    const claims = await on(papa, () => [...papa.store._log.ops({ includeParked: true })]
      .filter((o) => o.k === 'member.set' && Object.keys(o.f || {}).includes(`dev.${short}`)));
    assert.deepEqual(claims.map((o) => o.id), [],
      `a second claim was authored for one write-once register: ${claims.map((o) => o.id).join(', ')}`);

    // ── THE HONEST-PATH CONTROL. Without it every assertion above is satisfied by a guard that
    //    never publishes anything, which is E6-1 from the far side: the circle cannot admit a
    //    single op. A short with no claim must still be publishable.
    await bootMac(C, C.mama);
    assert.equal(await on(C.mama, () => C.mama.store.registers()
      .get(`member:${C.mama.forStore.memberId}`)?.get(`dev.${C.mama.forStore.deviceShort}`)), undefined,
      'a Mac that has not attested yet must look unattested, or nothing is ever published');
    assert.equal(await on(C.mama, () => C.mama.store.apply('attestMyDevice', {
      deviceShort: C.mama.forStore.deviceShort, blob: C.mama.myBlob,
    })), true, 'a first claim is authored normally');
  });

  test('§5c · CONTROL — nothing is reconstructed while the op is still a line', async () => {
    // Without this row §5a is satisfied by a method that reconstructs unconditionally, and §5b by
    // one that reconstructs nothing at all in the ordinary case. A second copy of an op the fold
    // already holds is not free: it is a body under a live opId, i.e. a splice candidate.
    const C = await buildCircle(['papa', 'mama']);
    const { papa, mama } = C;
    await refreshRoster(C);
    await bootMac(C, papa);
    await readRoster(C, papa);
    await on(papa, async () => {
      papa.store.apply('attestMyDevice', {
        deviceShort: papa.forStore.deviceShort, blob: papa.myBlob,
      });
      papa.store.apply('claimAdmin', {});
      papa.engine = engineFor(C, papa);
      await papa.engine.pushNow();
    });
    assert.equal((await join(C, mama)).status, 200);
    await refreshRoster(C);
    await on(papa, () => papa.engine.syncNow());
    await bootMac(C, mama);
    await readRoster(C, mama);
    await on(mama, async () => {
      mama.engine = engineFor(C, mama);
      await mama.engine.syncNow();
      await publishAttestation(C, mama);
    });
    await on(papa, () => papa.engine.syncNow());
    await readRoster(C, papa);
    await on(papa, () => papa.engine.syncNow());

    assert.deepEqual(await on(papa, () => papa.store._absorbedAttestOps()), [],
      'a live line was reconstructed a second time — that is a splice candidate, not a repair');
    // …and it is inert outside a family circle, which is what keeps the v1 oracle where it is.
    assert.deepEqual(await on(mama, () => {
      mama.store._familySpaceId = null;
      const r = mama.store._absorbedAttestOps();
      mama.store._familySpaceId = C.spaceId;
      return r;
    }), [], 'a solo board must reconstruct nothing at all');
  });
});
