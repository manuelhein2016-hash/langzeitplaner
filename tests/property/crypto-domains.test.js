// tests/property/crypto-domains.test.js — ONE PROPERTY PER CRYPTO INPUT DOMAIN.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS SUITE IS EXPECTED TO BE RED, AND THE RED IS THE DELIVERABLE.
//
// `tests/helpers/crypto-domains.js` enumerates every input the crypto layer accepts across four
// seams and states, per input, the behaviour that is REQUIRED. This file drives every one of
// those inputs through the REAL `spacekeys`, the REAL `envelope`, the REAL `backup`, the REAL
// `identity` and the REAL authorization fold, and asserts the required behaviour. Nothing is
// stubbed that a fix could later have to make true: the only injected functions are the two ADR
// 004 §2.2 barrier-2 ports that WP-10 has not built yet, and they are injected as the WEAKEST
// possible stand-ins so that nothing below them is credited to them.
//
// The entries that fail are the fix phase's work order.
//
// The point is the SHAPE of the failure report, not the failure. Round 6's verdict on the history
// layer was that fixes get chosen a branch at a time and that a fix which handles four of five
// kinds passes; the E3 red team's verdict on this layer is the same sentence about a different
// question — four barriers, four correct answers, and nobody had enumerated the way a KEY
// arrives. So no property here stops at its first failing entry: each walks its WHOLE domain,
// collects every deviation, and fails once with all of them listed — split into
//
//   UNEXPECTED an entry carrying `openFinding: null` deviated anyway. A REGRESSION, or a domain
//              member nobody had looked at. Listed first and loudest.
//   STALE      an entry carrying an `openFinding` now HOLDS. The finding is closed and the domain
//              has not been told. Also a failure — a work order that lies is worse than none.
//   THE WORK   the known-open findings, by input id. This is what the fix phase is FOR, and a fix
//   ORDER      that closes four of five cells fails on the fifth, by name, with the id of the
//              input it missed.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import '../helpers/env.js';
import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  DOMAINS, C1, C1_SENDERS, C1_EPOCHS, C1_S1_CELLS, C2_FIELDS, C2_RINGS, C2_SPACE_IDS, C2_PASSPHRASES,
  C2_KEYSTORES, C3, C3_SHAPES, C3_ARRIVALS, C4, C4_DECLARED, C4_FOLDED, C4_BRANDS, C4_PAYLOADS,
  C4_NO_LEVELOF, C5, C5_WRITERS, C5_PAYLOADS,
} from '../helpers/crypto-domains.js';

import * as sk from '../../src/js/crypto/spacekeys.js';
import * as identity from '../../src/js/crypto/identity.js';
import * as backup from '../../src/js/crypto/backup.js';
import { sealOp, openOp, brandFamilyPatch } from '../../src/js/crypto/envelope.js';
import { foldAuthorized, registerValue } from '../../src/js/core/authz.js';
import { memKeyStore } from '../../src/js/platform/keystore.js';
import { canonicalBytes } from '../../src/js/core/canon.js';
import { b64u } from '../../src/js/core/b64.js';

import {
  makeMember, memberRecord, ring, makeOp, hdrFor, fnoteKey, attOp, attestOpenOver, outcomeOf,
  mkSpaceId, mkDeviceId, mkMemberId, DAY, FAST, S, fmt,
} from '../attack/_member-kit.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// The reporter. Every property below ends in `verdict(...)`.
//
// Deliberately the same function, the same three buckets and the same wording as
// `tests/property/domains.test.js`. Two report shapes for one method would be two methods.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * @param {string} domainId
 * @param {Array<{entry:Object, ok:boolean, got:*, partial?:boolean, carried?:boolean}>} results
 */
function verdict(domainId, results) {
  const d = DOMAINS[domainId];
  assert.equal(results.length, d.entries.length,
    `${domainId}: ${results.length} entries probed but the domain has ${d.entries.length} — `
    + 'a property that skips a domain member is exactly the failure this file exists to prevent');

  const unexpected = [];
  const expected = [];
  const stale = [];
  for (const r of results) {
    if (r.carried) continue;
    const known = r.entry.openFinding !== null && r.entry.openFinding !== undefined;
    if (!r.ok && !known) unexpected.push(r);
    else if (!r.ok && known) expected.push(r);
    else if (r.ok && known && !r.partial) stale.push(r);
  }
  if (!unexpected.length && !expected.length && !stale.length) return;

  const show = (r) => `    ${r.entry.id}  [${r.entry.openFinding ?? 'no finding'}]  ${r.entry.label}\n`
    + `        required: ${JSON.stringify(r.entry.expect)}\n`
    + `        measured: ${JSON.stringify(r.got)}`;

  const byFinding = new Map();
  for (const r of expected) {
    if (!byFinding.has(r.entry.openFinding)) byFinding.set(r.entry.openFinding, []);
    byFinding.get(r.entry.openFinding).push(r);
  }

  const parts = [`${domainId} — ${d.title}`, `  (${d.subject})`,
    `  ${results.length} inputs enumerated · ${results.filter((r) => r.carried).length} owned elsewhere · `
    + `${results.filter((r) => r.ok && !r.carried).length} hold · `
    + `${expected.length} known-open · ${unexpected.length} UNEXPECTED · ${stale.length} stale`];
  if (unexpected.length) {
    parts.push('', '  UNEXPECTED — an input nobody had a finding for is behaving wrongly:',
      unexpected.map(show).join('\n'));
  }
  if (stale.length) {
    parts.push('', '  STALE — these now hold; close the finding and clear `openFinding`:',
      stale.map((r) => `    ${r.entry.id}  [${r.entry.openFinding}]  ${r.entry.label}`).join('\n'));
  }
  if (expected.length) {
    parts.push('', '  THE WORK ORDER — known-open findings, by input:');
    for (const [finding, rows] of [...byFinding].sort()) {
      parts.push(`    ── ${finding} — ${rows.length} input${rows.length === 1 ? '' : 's'} ──`,
        rows.map(show).join('\n'));
    }
  }
  assert.fail(parts.join('\n'));
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const KEX = { name: 'ECDH', namedCurve: 'P-256' };
const APP = '2.0.0';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C1 — A WRAP ROW ARRIVING AT `admitWraps`
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Fixtures shared by all 128 cells. Built once: a cell differs by its ROW, not by its people. */
let F = null;

const rawPub = async (pub) => new Uint8Array(await S.exportKey('raw', pub));
const rawAes = async (k) => (k ? b64u(new Uint8Array(await S.exportKey('raw', k))) : null);

describe('C1 · a wrap row arriving at admitWraps', () => {
  before(async () => {
    const victim = await makeMember(2);         // devices[0] = this Mac, devices[1] = my second
    const peer = await makeMember(1);           // a fellow member of the Familienkreis
    const outsider = await makeMember(1);       // attested, and not a member of the space in hand
    const removed = await makeMember(1);        // was a member; her attestation still verifies
    const throwaway = await S.generateKey(KEX, true, ['deriveKey', 'deriveBits']);
    const nobody = await S.generateKey(KEX, true, ['deriveKey', 'deriveBits']);
    F = {
      victim, peer, outsider, removed, throwaway, nobody,
      victimKexPub: await S.importKey('raw', victim.devices[0].kexPubRaw, KEX, true, []),
      myKexPriv: victim.devices[0].devKex.privateKey,
      psp: mkSpaceId('personal'),
      fsp: mkSpaceId('family'),
      honestKey: await sk.createSpaceKey(),
      futureKey: await sk.createSpaceKey(),
      pastKey: await sk.createSpaceKey(),
      fifthKey: await sk.createSpaceKey(),
      attackerKey: await sk.createSpaceKey(),
      throwawayRaw: await rawPub(throwaway.publicKey),
      nobodyRaw: await rawPub(nobody.publicKey),
    };
    F.raw = {
      honest: await rawAes(F.honestKey),
      future: await rawAes(F.futureKey),
      past: await rawAes(F.pastKey),
      fifth: await rawAes(F.fifthKey),
      attacker: await rawAes(F.attackerKey),
    };

    // THE ADMISSIBLE SENDER SETS — `admitWraps(…, ctx)`'s required `ctx.senders` (finding S1).
    //
    // These are not a stub and are not a per-cell fixture: they are the SAME two branded lists
    // the wrapping side builds, from the same two constructors, for the two spaces in hand. That
    // is what makes the 30 S1 cells a property of the design rather than of this file —
    // `personalRecipients` REFUSES a device belonging to any member but me, so `other-member`
    // could not be put into the personal set even by a test that wanted to.
    //
    // Verified ONCE, here, and reused: `admissibleSenders` returns a set bound to one space, and
    // `admitWraps` accepts it without re-verifying 256 attestations.
    F.personalSenders = await sk.admissibleSenders(sk.personalRecipients({
      memberId: victim.memberId,
      recoverySigPubRaw: victim.recoveryPubSig,
      devices: victim.devices.map((d) => ({
        deviceId: d.deviceId, memberId: victim.memberId, kexPubRaw: d.kexPubRaw, attestation: d.attestation,
      })),
    }), F.psp);
    F.familySenders = await sk.admissibleSenders(
      sk.familyRecipients([memberRecord(victim), memberRecord(peer)]), F.fsp
    );
  });

  /** The (private key, declared public key) pair a sender kind puts on the wire. */
  function senderOf(senderId, scopeId) {
    switch (senderId) {
      case 'member':
        return scopeId === 'family'
          ? { priv: F.peer.devices[0].devKex.privateKey, declared: F.peer.devices[0].kexPubRaw }
          : { priv: F.victim.devices[1].devKex.privateKey, declared: F.victim.devices[1].kexPubRaw };
      case 'other-member':
        return { priv: F.outsider.devices[0].devKex.privateKey, declared: F.outsider.devices[0].kexPubRaw };
      case 'removed':
        return { priv: F.removed.devices[0].devKex.privateKey, declared: F.removed.devices[0].kexPubRaw };
      case 'myself':
        return { priv: F.victim.devices[0].devKex.privateKey, declared: F.victim.devices[0].kexPubRaw };
      case 'unattested':
        return { priv: F.throwaway.privateKey, declared: F.throwawayRaw };
      case 'absent':
        return { priv: F.throwaway.privateKey, declared: undefined, omit: true };
      case 'malformed':
        return { priv: F.throwaway.privateKey, declared: 'nicht-ein-punkt!!' };
      case 'nobody':
        // Wrapped with the throwaway key and DECLARING a different, perfectly valid point. The
        // KEK therefore derives to the wrong bytes and the AEAD refuses — which is the refusal
        // that already exists, and the one `unattested` proves is not an authentication.
        return { priv: F.throwaway.privateKey, declared: F.nobodyRaw };
      default:
        throw new Error(`C1: unknown sender ${senderId}`);
    }
  }

  const legitKeyFor = (epochId) => (epochId === 'nonexistent' ? F.futureKey
    : epochId === 'below-floor' ? F.pastKey : F.honestKey);

  /** `wrapSpaceKey` is the expensive call in this domain and the cells share wraps. */
  const wraps = new Map();
  async function wrapOnce(tag, key, priv, space, epoch) {
    const k = `${tag}|${space}|${epoch}`;
    if (!wraps.has(k)) {
      wraps.set(k, await sk.wrapSpaceKey(key, priv, F.victimKexPub, { spaceId: space, epoch }));
    }
    return wraps.get(k);
  }

  test('C1a — every wrap row, from every sender, into both rings, at every epoch, in both orders', async () => {
    const results = [];
    for (const e of C1) {
      const space = e.scopeId === 'personal' ? F.psp : F.fsp;
      const epoch = C1_EPOCHS.find((x) => x.id === e.epochId);
      const senderSpec = C1_SENDERS.find((x) => x.id === e.senderId);
      const entitled = senderSpec.entitled[e.scopeId];
      const sender = senderOf(e.senderId, e.scopeId);
      const honest = senderOf('member', e.scopeId);

      const rowKey = entitled ? legitKeyFor(e.epochId) : F.attackerKey;
      const row = {
        epoch: epoch.rowEpoch,
        wrapped: await wrapOnce(`${e.senderId}/${e.scopeId}/${entitled ? e.epochId : 'attacker'}`,
          rowKey, sender.priv, space, epoch.rowEpoch),
      };
      if (!sender.omit) row.senderKexPubRaw = sender.declared;

      const honestRow = {
        epoch: epoch.honestEpoch,
        wrapped: await wrapOnce(`honest/${e.scopeId}`, F.honestKey, honest.priv, space, epoch.honestEpoch),
        senderKexPubRaw: honest.declared,
      };

      const r = sk.createKeyRing();
      for (const pre of epoch.prefill) r.put(space, pre, pre === 5 ? F.fifthKey : F.honestKey);

      // TWO CALLS, NOT ONE ARRAY, and it measures the same thing: `admitWraps` walks its rows
      // sequentially and `ring.has` short-circuits per row, so splitting the batch is exactly
      // the relay's ordering choice — and it makes the SUBJECT ROW's own outcome unambiguous,
      // which one aggregate report over two rows would not.
      const ctx = {
        spaceId: space,
        myKexPriv: F.myKexPriv,
        senders: e.scopeId === 'personal' ? F.personalSenders : F.familySenders,
      };
      let report;
      if (e.orderId === 'before') {
        report = await sk.admitWraps(r, [row], ctx);
        await sk.admitWraps(r, [honestRow], ctx);
      } else {
        await sk.admitWraps(r, [honestRow], ctx);
        report = await sk.admitWraps(r, [row], ctx);
      }

      const held = await rawAes(r.get(space, epoch.rowEpoch));
      const slot = held === null ? 'nothing'
        : held === F.raw.honest ? 'the-honest-key'
          : held === F.raw.attacker ? 'the-attacker-key'
            : held === await rawAes(legitKeyFor(e.epochId)) ? 'this-row'
              : 'unknown';

      const got = {
        row: report.admitted.length ? 'admitted' : report.refused ? 'refused' : 'duplicate',
        slot,
        trusted: slot !== 'the-attacker-key' && slot !== 'unknown',
      };
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }
    verdict('C1', results);
  });

  test('C1b — the 30 cells finding S1 owned are named, and every one of them is a refusal', async () => {
    // The count is not the assertion. A regression that re-opened S1 for the family space only,
    // or for the `before` order only, would still be "30 cells minus some" — so the ids are the
    // assertion, and `C1_S1_CELLS` is derived from the same rule that produced them.
    assert.equal(C1_S1_CELLS.length, 30);
    const cells = new Set(C1_S1_CELLS);
    for (const e of C1.filter((x) => cells.has(x.id))) {
      assert.deepEqual(e.expect, { row: 'refused', slot: e.epochId === 'lacking' ? 'the-honest-key' : 'nothing', trusted: true },
        `${e.id} is in S1's set but does not require a refusal`);
      assert.equal(e.openFinding, null, `${e.id} still carries an open finding`);
    }
    // Every sender in those cells is one that OPENS and is WELL-FORMED — i.e. the AEAD would have
    // admitted it. If this ever narrows, the domain has stopped measuring the finding.
    assert.deepEqual(
      [...new Set(C1_S1_CELLS.map((id) => id.split('/')[0].slice('C1-'.length)))].sort(),
      ['other-member', 'removed', 'unattested']
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C2 — A BACKUP FILE'S BYTES
// ═════════════════════════════════════════════════════════════════════════════════════════════

const PASS = 'Schlüsselbund-2026';
const impOpts = () => ({ deviceId: mkDeviceId(), createdAt: DAY, iterations: FAST });
const clone = (f) => JSON.parse(JSON.stringify(f));

const c2Board = (owner) => ({
  schemaVersion: 2,
  notes: [{ id: 'n1', owner, date: '2026-09-10', text: 'Zahnarzt' }],
  bars: [],
  categories: [{ id: 'cat-arbeit', name: 'Arbeit', color: '#c00' }],
  scratchpads: {},
  settings: { startMonth: '2026-01' },
  _v2: { lineageId: 'lin_ZZZZZZZZZZZZZZZZZZZZZZZZZZ', gen: 7 },
});

async function aBackup(pass = PASS, spaces = undefined) {
  const me = await makeMember(1);
  const psk = await sk.createSpaceKey();
  const file = await backup.exportBackup(
    c2Board(me.memberId),
    { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
    spaces ?? { personal: { id: mkSpaceId('personal'), epochs: new Map([[1, psk]]) } },
    pass,
    { exportedAt: DAY, app: APP, iterations: FAST }
  );
  return { me, file, pass };
}

/**
 * THE REPORT CHANNEL. `reported` in C2b and C2c asks whether the import result TELLS ITS CALLER
 * that something about the restore is unverified or incomplete. `importBackup` is I/O-free by
 * design and therefore cannot CHECK the Kreis binding or the epoch coverage; that is not the
 * requirement. The requirement is that it SAYS SO, and this is the set of names a fix could use
 * to say it. Adding any one of them turns the matching rows STALE, which is the prompt to record
 * the answer in `crypto-domains.js`.
 */
const REPORT_FIELDS = ['warnings', 'unverified', 'missingEpochs', 'pending', 'spacesReport', 'gaps'];
function reportsSomething(out) {
  if (!out) return true;                            // a loud refusal IS a report
  for (const f of REPORT_FIELDS) if (out[f] !== undefined) return true;
  for (const which of ['personal', 'family']) {
    const b = out.spaces && out.spaces[which];
    if (b) for (const f of REPORT_FIELDS) if (b[f] !== undefined) return true;
  }
  return false;
}

function mutate(file, path, how, extra) {
  const parts = path.split('.');
  let cur = file;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
  const last = parts[parts.length - 1];
  const v = cur[last];
  switch (how) {
    // C2a-20 — NOT a mutation of the content, a mutation of the WRITER. Every key of the board
    // re-emitted in reverse order, which is what a different JSON serializer (or a hand edit in
    // an editor that sorts) produces. The import must still succeed.
    case 'reorder-keys': {
      const out = {};
      for (const k of Object.keys(v).reverse()) out[k] = v[k];
      cur[last] = out;
      return;
    }
    case 'append-entry': v.push(extra); return;
    case 'empty-array': cur[last] = []; return;
    case 'flip-first-char': cur[last] = v.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')); return;
    // NOT THE LAST CHARACTER, AND THE REASON IS A REAL TRAP. A base64url string whose byte length
    // is not a multiple of 3 ends in a character carrying SLACK BITS, so `A`→`B` there can decode
    // to identical bytes — a mutation test that flips the last character passes or fails by the
    // length of the payload it happened to be handed. A middle character is fully significant,
    // and `A`↔`z` (0 ↔ 51) moves the high bits rather than only the low one.
    case 'flip-mid-char': {
      const i = Math.floor(v.length / 2);
      cur[last] = v.slice(0, i) + (v[i] === 'A' ? 'z' : 'A') + v.slice(i + 1);
      return;
    }
    case 'replace-member-id': cur[last] = extra; return;
    default:
      if (typeof v === 'number') cur[last] = v + 1;
      else if (typeof v === 'string') cur[last] = 'geaendert';
      else if (Array.isArray(v)) cur[last] = [];
      else cur[last] = { geaendert: true };
  }
}

describe('C2 · a backup file\'s bytes', () => {
  test('C2 — the field map, the epoch ring, the space ids, the passphrase and the key store', async () => {
    const results = [];

    // ── C2a — WHICH FIELDS ARE AUTHENTICATED ────────────────────────────────────────────────
    const base = await aBackup();
    for (const e of C2_FIELDS) {
      const t = clone(base.file);
      const extra = e.value.how === 'replace-member-id' ? mkMemberId()
        : e.value.path === 'board.categories' ? { id: 'cat-x', name: 'X', color: '#000' }
          : { id: 'n9', owner: base.me.memberId, date: '2026-12-24', text: 'eingeschmuggelt' };
      mutate(t, e.value.path, e.value.how, extra);

      let code = null;
      let restored = false;
      try {
        const out = await backup.importBackup(t, PASS, memKeyStore(), impOpts());
        restored = out.identityRestored === true;
      } catch (err) {
        code = err.code || `UNEXPECTED ${err.name}: ${err.message}`;
      }
      const got = { tagRefuses: code === 'cannot-open', rewritable: restored };
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }

    // ── C2b — THE EPOCH RING INSIDE THE SEALED PAYLOAD ──────────────────────────────────────
    for (const e of C2_RINGS) {
      const me = await makeMember(1);
      const epochs = new Map();
      for (const k of e.value.epochs) {
        epochs.set(k, e.value.keyBytes ? new Uint8Array(e.value.keyBytes) : await sk.createSpaceKey());
      }
      const fam = { id: mkSpaceId('family'), epoch: e.value.epoch, epochs };
      let file = null;
      try {
        file = await backup.exportBackup(
          c2Board(me.memberId),
          { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
          { personal: { id: mkSpaceId('personal'), epochs: new Map([[1, await sk.createSpaceKey()]]) }, family: fam },
          PASS, { exportedAt: DAY, app: APP, iterations: FAST }
        );
      } catch { file = null; }

      let got;
      if (file === null) {
        got = { imported: false, reported: true };
      } else {
        let out = null;
        try { out = await backup.importBackup(file, PASS, memKeyStore(), impOpts()); } catch { out = null; }
        got = {
          imported: out !== null && out.identityRestored === true && out.spaces.family !== null,
          reported: reportsSomething(out),
        };
      }
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }

    // ── C2c — THE SPACE IDS ─────────────────────────────────────────────────────────────────
    //
    // ⚠ C2c-2 IS CARRIED, AND THE ROW THAT PROVES IT HAS TO BE IS C2c-1. Measuring the two
    // side by side is what showed it: `idFor('own','family')` and `idFor('another-kreis','family')`
    // are the SAME EXPRESSION — two fresh, well-formed `fsp_` ids — because the difference
    // between „mein Kreis" and „ein anderer Kreis" is not in the file. It is in the member list,
    // which is the fold's and arrives later. So no implementation can make C2c-2 report while
    // C2c-1 stays silent; a `reported` channel that fired on both would say nothing, and one that
    // fired on neither is where the code already was.
    //
    // `backup.js` therefore answers the half it can — `result.familyBinding` carries the id and
    // the sentence „dieser Mac kann es nicht nachprüfen", UNCONDITIONALLY, on every family
    // restore — and the half that needs an authority is carried to §7.3 step 5's
    // `POST /api/v1/devices/adopt`, the only thing that can contradict a file. `familyBinding` is
    // deliberately NOT one of `REPORT_FIELDS`: if it were, it would flip C2b-1 and C2c-1 too and
    // C2b's epoch-gap requirement (S8) would stop being measurable at all.
    const C2C_CARRIED = new Map([
      ['C2c-2', 'indistinguishable from C2c-1 inside the file; owned by §7.3 step 5 (POST /devices/adopt)'],
    ]);
    for (const e of C2_SPACE_IDS) {
      if (C2C_CARRIED.has(e.id)) {
        results.push({ entry: e, ok: true, carried: true, got: C2C_CARRIED.get(e.id) });
        continue;
      }
      const me = await makeMember(1);
      const idFor = (kind, which) => (kind === null ? null
        : kind === 'own' ? mkSpaceId(which)
          : kind === 'another-kreis' ? mkSpaceId('family')
            : kind === 'personal-shaped' ? mkSpaceId('personal')
              : kind === 'family-shaped' ? mkSpaceId('family')
                : 'nicht-eine-space-id');
      const famId = idFor(e.value.family, 'family');
      const perId = idFor(e.value.personal, 'personal');
      const spaces = {
        personal: { id: perId, epochs: new Map([[1, await sk.createSpaceKey()]]) },
        family: famId === null ? null : { id: famId, epoch: 1, epochs: new Map([[1, await sk.createSpaceKey()]]) },
      };
      let file = null;
      try {
        file = await backup.exportBackup(
          c2Board(me.memberId),
          { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
          spaces, PASS, { exportedAt: DAY, app: APP, iterations: FAST }
        );
      } catch { file = null; }

      let got;
      if (file === null) {
        got = { imported: false, reported: true };
      } else {
        let out = null;
        try { out = await backup.importBackup(file, PASS, memKeyStore(), impOpts()); } catch { out = null; }
        got = { imported: out !== null && out.identityRestored === true, reported: reportsSomething(out) };
      }
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }

    // ── C2d — THE PASSPHRASE ────────────────────────────────────────────────────────────────
    //
    // `weaknessSurfaced` is measured against a NAMED set of channels a fix could use, exactly as
    // `reportsSomething` is: a refusal counts, and so would an exported classifier or a strength
    // field on the file. Nothing else does, because nothing else reaches the sheet that renders
    // `EXPORT_SHEET_COPY`.
    //
    // ⚠ CORRECTED 2026-08-28, BY MEASUREMENT (S7's fix phase). This block used to ask
    // `typeof backup.passphraseStrength === 'function'` ONCE, outside the loop, and credit every
    // row with the answer. That made `weaknessSurfaced` a property of the MODULE rather than of
    // the passphrase: the moment a classifier existed, C2d-8 and C2d-9 — the two controls, which
    // REQUIRE `weaknessSurfaced: false` — measured `true` and went UNEXPECTED. A channel that
    // cannot say "this one is fine" is not a measurement of a domain, it is a feature detector.
    // It now asks the classifier ABOUT THE INPUT, which is what the domain always required and
    // is what makes the controls load-bearing.
    //
    // A strength field ON THE FILE is deliberately NOT one of the channels any more either: a
    // file that carries „this one was weak" hands the thief a sorting key for the drawer.
    const weaknessOf = (pass) => {
      if (typeof backup.passphraseStrength !== 'function') return false;
      const s = backup.passphraseStrength(pass);
      return s !== null && typeof s === 'object' && s.weak === true;
    };
    for (const e of C2_PASSPHRASES) {
      const me = await makeMember(1);
      let file = null;
      let code = null;
      try {
        file = await backup.exportBackup(
          c2Board(me.memberId),
          { memberId: me.memberId, recSig: me.rec.recSig, recKex: me.rec.recKex },
          { personal: { id: mkSpaceId('personal'), epochs: new Map([[1, await sk.createSpaceKey()]]) } },
          e.value, { exportedAt: DAY, app: APP, iterations: FAST }
        );
      } catch (err) {
        code = err.code || `UNEXPECTED ${err.name}: ${err.message}`;
      }
      const got = {
        exported: file !== null,
        weaknessSurfaced: code === 'passphrase-empty' || code === 'passphrase-too-weak'
          || weaknessOf(e.value),
      };
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }

    // ── C2e — THE KEY STORE THE IMPORT LANDS IN ─────────────────────────────────────────────
    const mine = await aBackup();
    const theirs = await aBackup();
    for (const e of C2_KEYSTORES) {
      const spec = e.value;
      const ks = memKeyStore();
      const src = spec.who === 'another-member' ? theirs : mine;
      const nPuts = spec.rec + (spec.dev || 0);
      if (nPuts >= 6) {
        await backup.importBackup(src.file, src.pass, ks, impOpts());
      } else if (nPuts > 0) {
        // A store stopped part way through, which is the only way to reach these states: the
        // module writes one record at a time and offers no way to write half of one on purpose.
        let n = 0;
        const flaky = {
          get: ks.get, del: ks.del, list: ks.list,
          put: async (id, v) => { n += 1; if (n > nPuts) throw new Error('disk full'); return ks.put(id, v); },
        };
        await assert.rejects(() => backup.importBackup(src.file, src.pass, flaky, impOpts()));
      }

      // C2e-9 — the one residue shape the flaky-put construction cannot reach. `put` fails from
      // the END, so a partial triple built that way never keeps the METADATA; deleting a named
      // record after a complete import is the only way to get "2 of 3, and the meta still names
      // somebody else", which is exactly the input the ownership check exists for.
      for (const id of spec.del || []) await ks.del(identity.KEYSTORE_IDS[id]);

      let code = null;
      try { await backup.importBackup(mine.file, PASS, ks, impOpts()); } catch (err) {
        code = err.code || `UNEXPECTED ${err.name}: ${err.message}`;
      }
      let repairable = true;
      if (code !== null) {
        try { await backup.importBackup(mine.file, PASS, ks, impOpts()); } catch { repairable = false; }
      }
      const got = { code, repairable };
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }

    verdict('C2', results);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C3 — AN ATTESTATION REACHING THE FOLD
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Hand-sign an attestation payload `attestDevice` would refuse to mint. A modified client can do
 *  exactly this, and the threat model has one: T5 is a family member with a build of her own. */
async function forgeBlob(att, recSigPriv) {
  const payload = canonicalBytes({
    memberId: att.memberId,
    deviceId: att.deviceId,
    deviceShort: att.deviceShort,
    sigPubRaw: att.sigPubRaw,
    kexPubRaw: att.kexPubRaw,
    createdAt: att.createdAt,
  });
  const sig = await identity.signBytes(recSigPriv, payload);
  return `${b64u(payload)}.${b64u(sig)}`;
}

describe('C3 · an attestation reaching the fold', () => {
  test('C3 — §2.3\'s four conditions × the shapes that satisfy them × when the blob arrives', async () => {
    const FSP = mkSpaceId('family');
    const victim = await makeMember(1);
    const squatter = await makeMember(2);
    const V = victim.devices[0];
    const Q = squatter.devices[0];
    const victimShort = V.deviceShort;

    // The victim's own envelope, sealed once and opened against every fold below. The ring and
    // the signature are honest throughout: the only thing that varies is which attestation the
    // table hands `openOp`.
    const PSP = mkSpaceId('personal');
    const spaceKey = await sk.createSpaceKey();
    const vop = makeOp(V, PSP, { f: { date: '2026-09-10', text: 'Zahnarzt' } });
    const venv = await sealOp(vop, ring([[PSP, 1, spaceKey]]), V.devSig.privateKey, hdrFor(vop, V, 1));

    /** Build the second attestation for a shape: `{blob, mints, name, record, act, dev}`. */
    async function shapeBlobOf(shapeId) {
      switch (shapeId) {
        case 'honest':
          return { blob: Q.attestation, mints: 'yes', name: Q.deviceShort, record: squatter.memberId, act: squatter.memberId, dev: Q };
        case 'squat-short': {
          // Her record, HIS short, HIS public signing key — read out of his own `dev.*` register
          // inside the E2EE stream — and her own recovery signature.
          const att = await identity.buildDeviceAttestation(
            { memberId: squatter.memberId, deviceId: V.deviceId, createdAt: DAY },
            V.devSig.publicKey, Q.devKex.publicKey
          );
          return { blob: await identity.attestDevice(att, squatter.rec.recSig.privateKey), mints: 'yes',
            name: att.deviceShort, record: squatter.memberId, act: squatter.memberId, dev: Q };
        }
        case 'squat-short-copied-key-own-short': {
          const D = squatter.devices[1];
          const att = {
            memberId: squatter.memberId, deviceId: D.deviceId, deviceShort: D.deviceShort,
            sigPubRaw: V.sigPubRaw,                       // HIS key, under HER short
            kexPubRaw: b64u(D.kexPubRaw), createdAt: DAY,
          };
          let mints = 'yes';
          try { await identity.attestDevice(att, squatter.rec.recSig.privateKey); } catch { mints = 'forged'; }
          return { blob: await forgeBlob(att, squatter.rec.recSig.privateKey), mints,
            name: D.deviceShort, record: squatter.memberId, act: squatter.memberId, dev: Q };
        }
        case 'name-mismatch':
          return { blob: Q.attestation, mints: 'yes', name: victimShort, record: squatter.memberId, act: squatter.memberId, dev: Q };
        case 'peer-device-id': {
          const { devSig, devKex } = await identity.generateDeviceKeys();
          const att = await identity.buildDeviceAttestation(
            { memberId: squatter.memberId, deviceId: V.deviceId, createdAt: DAY },
            devSig.publicKey, devKex.publicKey
          );
          return { blob: await identity.attestDevice(att, squatter.rec.recSig.privateKey), mints: 'yes',
            name: att.deviceShort, record: squatter.memberId, act: squatter.memberId, dev: Q };
        }
        case 'into-victims-record':
          return { blob: Q.attestation, mints: 'yes', name: Q.deviceShort, record: victim.memberId, act: squatter.memberId, dev: Q };
        case 'victims-blob-into-hers':
          return { blob: V.attestation, mints: 'yes', name: victimShort, record: squatter.memberId, act: squatter.memberId, dev: Q };
        default:
          throw new Error(`C3: unknown shape ${shapeId}`);
      }
    }

    const results = [];
    for (const e of C3) {
      const shape = C3_SHAPES.find((s) => s.id === e.shapeId);
      const arrival = C3_ARRIVALS.find((a) => a.id === e.arrivalId);
      const built = await shapeBlobOf(shape.id);

      const victimOwn = attOp(victim.memberId, V, V.attestation, victimShort, FSP, 1787836850000);
      const shapeOp = attOp(built.record, built.dev, built.blob, built.name, FSP,
        arrival.squatFirst === false ? 1787836900000 : 1787836800000);
      shapeOp.act = built.act;

      const ops = arrival.victimPresent ? [victimOwn, shapeOp] : [shapeOp];

      // The pre-resolved `attestOpen` table, built with the REAL `verifyAttestation` over every
      // (housing member, blob) pair in play — never a stub that says yes.
      const pairs = [];
      for (const [mid, rec] of [[victim.memberId, victim.rec.recSig.publicKey],
        [squatter.memberId, squatter.rec.recSig.publicKey]]) {
        for (const blob of [V.attestation, built.blob]) pairs.push([mid, blob, rec]);
      }
      const attestOpen = await attestOpenOver(pairs);

      const r = foldAuthorized(ops, { me: victim.memberId, attestOpen });
      const rej = r.rejectionOf(shapeOp.id);
      const resolved = r.attestationOf(victimShort);

      // RECOVERABILITY. Fold the victim's own attestation (if it was not there) plus a
      // replacement claim on the same register — the two moves the victim actually has — and ask
      // whether the short answers with the victim afterwards.
      const replacement = attOp(victim.memberId, V, V.attestation, victimShort, FSP, 1787837000000);
      const r2 = foldAuthorized(
        [...(arrival.victimPresent ? ops : [...ops, victimOwn]), replacement],
        { me: victim.memberId, attestOpen }
      );
      const recovered = r2.attestationOf(victimShort);

      const outcome = await outcomeOf(
        () => openOp(venv, ring([[PSP, 1, spaceKey]]), (dv) => r.attestationOf(dv))
      );

      const got = {
        mints: built.mints,
        foldsAs: rej === null || rej === undefined ? 'admitted' : `rejected:${rej.reason}`,
        resolves: resolved === null || resolved === undefined ? 'nobody'
          : resolved.memberId === victim.memberId ? 'the-victim' : 'the-squatter',
        victimEnvelope: outcome,
        retained: outcome === 'opened' || outcome.startsWith('park:'),
        recoverable: (recovered && recovered.memberId) === victim.memberId,
      };
      const want = { ...e.expect };
      delete want.wellFormed;                 // documentation, not a measurement
      results.push({ entry: { ...e, expect: want }, ok: eq(got, want), got });
    }
    verdict('C3', results);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C4 — A PATCH REACHING `sealOp`
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('C4 · a patch reaching sealOp', () => {
  test('C4 — the declared level × the folded level × the brand × the payload', async () => {
    const me = await makeMember(1);
    const dev = me.devices[0];
    const FSP = mkSpaceId('family');
    const kr = ring([[FSP, 1, await sk.createSpaceKey()]]);
    const results = [];

    /**
     * Barrier 2 is INJECTED and REQUIRED (`core/project.js` is WP-10 and until it lands no family
     * `pub.set` can be sealed at all), so it has to be stubbed for this domain to be reachable at
     * all. It is stubbed as the weakest thing that can exist — a function that asserts nothing —
     * so that every refusal measured below is barrier 3's, barrier 4's or the backstop's, and
     * none of them is credited to a stand-in. It doubles as the probe for the level that was
     * APPLIED: `sealOp` hands it to `ctx.assertFamilyPatch(patch, kind, level)`.
     */
    async function probe(declared, folded, brand, payload, withLevelOf) {
      const patch = { ...payload.fields };
      if (declared.present) patch['pub.level'] = declared.value;
      if (brand.from !== null) {
        brandFamilyPatch(patch, {
          kind: 'fnote',
          level: brand.from === 'folded' ? folded.value : declared.value,
        });
      }
      const op = makeOp(dev, FSP, { k: 'pub.set', e: fnoteKey(me.memberId), f: patch });
      let seen = null;
      const ctx = { assertFamilyPatch: (_p, _k, lvl) => { seen = lvl; } };
      if (withLevelOf) ctx.levelOf = () => folded.value;
      const outcome = await outcomeOf(
        () => sealOp(op, kr, dev.devSig.privateKey, hdrFor(op, dev, 1), ctx)
      );
      const name = outcome === 'OK' ? 'sealed' : outcome;
      return { outcome: name, level: name === 'sealed' || name === 'backstop' ? seen : null };
    }

    for (const e of C4) {
      const got = await probe(
        C4_DECLARED.find((d) => d.id === e.declaredId),
        C4_FOLDED.find((f) => f.id === e.foldedId),
        C4_BRANDS.find((b) => b.id === e.brandId),
        C4_PAYLOADS.find((p) => p.id === e.payloadId),
        true
      );
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }

    for (const e of C4_NO_LEVELOF) {
      const got = await probe(
        C4_DECLARED.find((d) => d.id === 'geteilt'),
        C4_FOLDED.find((f) => f.id === 'geteilt'),
        C4_BRANDS.find((b) => b.id === 'matching'),
        C4_PAYLOADS.find((p) => p.id === 'date-only'),
        false
      );
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }

    verdict('C4', results);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE NON-VACUITY GUARD
//
// Every property above walks its whole domain and reports what deviated. None of them would
// notice a domain that had quietly emptied itself, an `expect` that had been relaxed to match the
// build, or a finding that had been deleted rather than closed. This test is the one that would.
// ═════════════════════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════════════════════
// C5 — A `pub.set` REACHING THE FOLD
//
// The mirror of C4, on the machine the attacker does not own. Nothing here is stubbed: the ops
// are real, the attestations are verified with the real `verifyAttestation`, and the answer is
// read off the real register map that `foldAuthorized` returns.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('C5 · a pub.set reaching the fold', () => {
  test('C5 — the writer × the payload × the entity\'s folded level and where it came from', async () => {
    const FSP = mkSpaceId('family');
    const owner = await makeMember(1);
    const coed = await makeMember(2);
    const OD = owner.devices[0];
    const CD = coed.devices[0];
    const E = fnoteKey(owner.memberId);

    // The family: both members attested into the stream, both alive, the owner is the genesis
    // admin. Built once — a cell differs by its OPS, not by its people.
    const base = [];
    let seq = 0;
    const at = (n) => 1787836800000 + n * 1000;
    for (const [m, d] of [[owner, OD], [coed, CD]]) {
      base.push(attOp(m.memberId, d, d.attestation, d.deviceShort, FSP, at(seq++)));
      base.push({
        ...makeOp(d, FSP, { k: 'member.set', e: `member:${m.memberId}`,
          f: { displayName: m.memberId.slice(4, 8), _alive: true } }),
        ts: fmt(at(seq++), 0, d.deviceShort),
      });
    }
    base.push({
      ...makeOp(OD, FSP, { k: 'space.set', e: `space:${FSP}`,
        f: { admin: owner.memberId, adminPrev: null, name: 'Familie' } }),
      ts: fmt(at(seq++), 0, OD.deviceShort),
    });

    const attestOpen = await attestOpenOver([
      [owner.memberId, OD.attestation, owner.rec.recSig.publicKey],
      [coed.memberId, CD.attestation, coed.rec.recSig.publicKey],
    ]);

    /** An owner `pub.set` carrying only governing fields, at wall-clock `ms`. */
    const govOp = (f, ms) => ({
      ...makeOp(OD, FSP, { k: 'pub.set', e: E, f }),
      ts: fmt(ms, 0, OD.deviceShort),
    });

    const cellOf = (v) => (v === undefined ? 'none' : v === null ? 'null' : 'value');

    const results = [];
    for (const e of C5) {
      const w = C5_WRITERS.find((x) => x.id === e.writerId);
      const p = C5_PAYLOADS.find((x) => x.id === e.payloadId);
      const dev = w.id === 'owner' ? OD : CD;

      // T10 — co-edit is granted unconditionally, so that a co-editor refusal below is never
      // ABOUT co-edit. The one gate C5 is not measuring is the one gate it must not trip.
      const ops = [...base, govOp({ 'pub.coEdit': true, 'pub.alive': true }, at(10))];

      // The level, and where it comes from.
      if (e.source === 'earlier-op') ops.push(govOp({ 'pub.level': e.level }, at(20)));
      if (e.source === 'later-op') ops.push(govOp({ 'pub.level': 'geteilt' }, at(20)));

      const patch = { ...p.fields };
      if (e.source === 'same-op') patch['pub.level'] = e.level;
      const content = { ...makeOp(dev, FSP, { k: 'pub.set', e: E, f: patch }),
        ts: fmt(at(30), 0, dev.deviceShort) };
      ops.push(content);

      // …and the RETROACTIVE cell: the content op above was sealed while the entry really was
      // Geteilt, and the owner moves the level afterwards.
      if (e.source === 'later-op') ops.push(govOp({ 'pub.level': e.level }, at(40)));

      const r = foldAuthorized(ops, { me: owner.memberId, attestOpen });
      const rej = r.rejectionOf(content.id);
      const got = {
        admitted: (rej === null || rej === undefined) && r.parkReasonOf(content.id) === null,
        text: cellOf(registerValue(r.regs, E, 'pub.text')),
        date: cellOf(registerValue(r.regs, E, 'pub.date')),
        reported: (r.contentAboveLevel || []).some((x) => x.opId === content.id),
      };
      results.push({ entry: e, ok: eq(got, e.expect), got });
    }
    verdict('C5', results);
  });

  // The domain's own law, asserted over the ENUMERATION rather than per cell. INV-R1 is not "the
  // 24 cells we fixed behave"; it is "no input in the domain produces a readable geteiltOnly
  // value below Geteilt", and that sentence has to be checkable without naming a cell.
  test('C5 — INV-R1 as a law over the whole domain: a text value implies the level is geteilt', () => {
    const offenders = C5.filter((e) => e.expect.text === 'value' && e.level !== 'geteilt');
    assert.deepEqual(offenders.map((e) => e.id), [],
      'a cell requires a readable `pub.text` at a level below Geteilt — INV-R1 is stated wrong');
    // …and the law is not vacuous: some cell had better require the value to survive at Geteilt.
    assert.ok(C5.some((e) => e.expect.text === 'value' && e.level === 'geteilt'),
      'no cell keeps the text at Geteilt — the rule would be satisfied by dropping everything');
  });
});

describe('the domain file itself', () => {
  test('every entry is well-formed, every id is unique, and the crossings are complete', () => {
    const ids = new Set();
    let withFinding = 0;
    for (const dId of ['C1', 'C2', 'C3', 'C4']) {
      const d = DOMAINS[dId];
      assert.ok(d.entries.length > 0, `${dId} has no entries`);
      for (const e of d.entries) {
        assert.equal(ids.has(e.id), false, `duplicate entry id ${e.id}`);
        ids.add(e.id);
        assert.equal(typeof e.label, 'string');
        assert.ok(e.label.length > 0, `${e.id} has no label`);
        assert.ok(e.expect !== null && typeof e.expect === 'object', `${e.id} has no expect`);
        assert.ok(Object.prototype.hasOwnProperty.call(e, 'openFinding'),
          `${e.id} does not say whether it is expected to fail`);
        if (e.openFinding !== null) withFinding += 1;
      }
    }
    // The four crossings, by arithmetic rather than by count-what-is-there: a cross that lost an
    // axis value would still be "consistent" with itself.
    assert.equal(C1.length, 8 * 2 * 4 * 2, 'C1 is not the full sender × scope × epoch × order cross');
    assert.equal(C3.length, C3_SHAPES.length * C3_ARRIVALS.length);
    assert.equal(C4.length, C4_DECLARED.length * C4_FOLDED.length * C4_BRANDS.length * C4_PAYLOADS.length);
    assert.ok(withFinding > 0,
      'no entry in the whole file predicts a failure. Either every finding is closed — in which '
      + 'case say so per entry, with a note — or the domain has been relaxed to match the build.');
  });
});
