// tests/tier1/unshare.test.js — LZP-903 (story 18.3) and LZP-905 (story 18.6).
//
// SUBJECTS, all shipped and none stubbed:
//   `src/js/crypto/envelope.js`  barrier 4's RETRACTION CLAUSE and `RETRACTION_CLAUSE`
//   `src/js/core/project.js`     `adminUnshareOp`, `adminUnshareFollowUp`, `retractPatch`
//   `src/js/family/unshare.js`   `planUnshare`, `publishedState`, `UNSHARE_COPY`
//   `src/js/core/authz.js`       stage 3a, unmodified — the fold that actually decides authority
//   `src/js/store.js`            the real singleton, for 18.6 and for the follow-up measurement
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE TWO STORIES, AND WHAT EACH ONE IS ASSERTED ON
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// 18.3 — "As admin I can unshare any entry from the family space — it reverts to owner-private,
//         it is never deleted — so moderation is possible but non-destructive, and I still can't
//         read what was never shared."
//
//   IT REVERTS       §4, on a PEER's materialization and on a peer's REGISTERS — never on the
//                    admin's own board, which is right either way (ADR 004 §5.1's asymmetry).
//   IT NEVER DELETES §4, on the OWNER's board and on the owner's personal-space registers, and
//                    §2 on the emitted op: no `_alive`, no personal-space entity, `pub.alive`
//                    NULLED rather than set `false`.
//   IT NEVER READS   §2 on the ARITY of `adminUnshareOp` and on the bytes it produces from
//                    nothing but a kind; §6 on `planUnshare`, which cannot be asked about an
//                    entity the family does not hold.
//
// 18.6 — "Deletions propagate to all boards; my undo of my own deletion restores the entry as a
//         new shared operation, so even destructive acts stay reversible for their author."
//
//   §7, through the REAL store: the tombstone is a real `pub.set`, the restore is a NEW op at a
//   NEWER stamp (never a rewind), and 18.4's guard — another member's ops may not enter this
//   device's undo stack — is asserted where it lives, on `captureImages`.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE METHOD: THE ORACLE IS WRITTEN FROM THE PROSE, NEVER FROM THE BRANCH
//
// §1's `sealable()` was written from ADR 004 §2.2's amended barrier-4 text and from
// `RETRACTION_CLAUSE`'s six clauses, and it computes its answer from the ROW rather than by
// calling anything under test. A domain read off the implementation proves the implementation
// equals itself, which is the one thing this file must not do — barrier 4 already shipped a hole
// (finding S5) that every test of the day agreed with.
//
//   U1  levelOf answer × patch × adminOf answer                    5 × 4 × 5 + 5  =  105
//   U2  the three properties of 18.3, on the emitted op                          =    8
//   U3  the follow-up domain: what the two registers can disagree about          =   10
//                                                                        cells      123
//
// NO TEST HERE MINTS A STAMP FROM THE WALL CLOCK. The three rows that drive the REAL store
// inherit its clock — that is the subject, not the fixture — and they stamp RELATIVE to the log
// they are extending, never from a constant, because a constant would silently lose the LWW
// contest against ops the store minted a moment earlier and the row would go green for the wrong
// reason.

import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { resetStorage, seedBoard } from '../helpers/env.js';
import { short16, attestationBlob, attestVerify } from '../helpers/gen.js';

import {
  sealOp, RETRACTION_CLAUSE, PROJECT_CONTRACT, FAMILY_PATCH_BRAND,
} from '../../src/js/crypto/envelope.js';
import { generateDeviceKeys } from '../../src/js/crypto/identity.js';
import { createSpaceKey } from '../../src/js/crypto/spacekeys.js';

import {
  retractPatch, projectForFamily, adminUnshareOp, adminUnshareFollowUp,
  ADMIN_UNSHARE_CONTRACT, GETEILT_FIELDS, RedactionError,
} from '../../src/js/core/project.js';
import { makeOp, PERSONAL_PLACEHOLDER, FIELDS } from '../../src/js/core/ops.js';
import {
  foldAuthorized, classifyUnsharePatch, unsharePatch, REJECT_REASONS,
} from '../../src/js/core/authz.js';
import { captureImages, UndoError } from '../../src/js/core/undo.js';
import { materialize } from '../../src/js/core/materialize.js';
import { getRegister } from '../../src/js/core/registers.js';
import { familyKey, noteKey, memberKey, spaceKey, isMemberId } from '../../src/js/core/entities.js';
import { fmt, msOf } from '../../src/js/core/stamp.js';
import { store, defaultState } from '../../src/js/store.js';
import {
  planUnshare, publishedState, UNSHARE, UNSHARE_BLOCKERS, UNSHARE_COPY,
} from '../../src/js/family/unshare.js';
import { TXT as SHARING_TXT, FORBIDDEN_CLAIMS } from '../../src/js/family/sharing.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 0. THE CIRCLE — three members, PAPA the genesis admin, MAMA the owner, OMA a bystander
// ═════════════════════════════════════════════════════════════════════════════════════════════

const pad22 = (s) => (s + 'x'.repeat(22)).slice(0, 22);
const PAPA = `mem_${pad22('UPAPA')}`;          // the admin
const MAMA = `mem_${pad22('UMAMA')}`;          // the owner of the moderated entry
const OMA = `mem_${pad22('UOMA')}`;            // a member who is neither
const FSP = `fsp_${pad22('UFAMILIE')}`;
const UUID = 'cccccccc-3333-4333-8333-cccccccccccc';
const BAR_UUID = 'dddddddd-4444-4444-8444-dddddddddddd';
const BASE_MS = 1787836800000;
const SECRET = 'Scheidungsanwalt 14:30';

const DEVS = {
  [PAPA]: { id: `dev_${pad22('DUPAPA')}`, short: short16('DUPAPA') },
  [MAMA]: { id: `dev_${pad22('DUMAMA')}`, short: short16('DUMAMA') },
  [OMA]: { id: `dev_${pad22('DUOMA')}`, short: short16('DUOMA') },
};

let opN = 0;
function op(who, kind, e, f, ms, opts = {}) {
  return makeOp({
    act: who,
    dev: DEVS[who].id,
    gid: opts.gid ?? pad22(`gu${ms}`),
    space: opts.space ?? FSP,
    familySpaceId: FSP,
    mint: () => fmt(ms, opts.ctr ?? 0, DEVS[who].short),
    newOpId: () => pad22(`ou${++opN}`),
  }, kind, e, f, opts);
}

/** The authz preamble: three attested members and the genesis admin link. */
function kreis() {
  const ops = [];
  let ms = BASE_MS;
  for (const m of [PAPA, MAMA, OMA]) {
    ops.push(op(m, 'member.set', memberKey(m),
      { [`dev.${DEVS[m].short}`]: attestationBlob(m, DEVS[m]) }, (ms += 1000)));
    ops.push(op(m, 'member.set', memberKey(m),
      { displayName: m.slice(4, 9), colorRef: 'p1', _alive: true }, (ms += 1000)));
  }
  ops.push(op(PAPA, 'space.set', spaceKey(FSP), { admin: PAPA, adminPrev: null, name: 'Familie' },
    (ms += 1000)));
  return { ops, at: ms };
}

const MCTX = (me) => ({
  me,
  familySpaceId: FSP,
  members: new Map([PAPA, MAMA, OMA].map((m) => [m, {
    displayName: m.slice(4, 9), colorRef: 'p1', initial: m[4],
  }])),
  currentMembers: new Set([PAPA, MAMA, OMA]),
  hiddenMembers: new Set(),
  prefs: {},
  lastSeenSeq: {},
  defaultSettings: defaultState().settings,
});

/** Mama's own truth for the entry, materialized-shaped, as `projectForFamily` wants it. */
const mamaTruth = (level) => ({
  visibility: level,
  date: '2026-12-24',
  text: SECRET,
  repeatsYearly: false,
  coEdit: false,
  categoryId: 'cat-privat',
  _alive: true,
  _born: fmt(BASE_MS, 0, DEVS[MAMA].short),
});

/**
 * Mama shares her note at `level`: the truth write in HER personal space plus the publication,
 * under one gid (ADR 004 §5). Only the family half ever crosses to another Mac.
 */
function mamaShares(level, at) {
  const gid = pad22(`gs${at}`);
  const truth = mamaTruth(level);
  const personal = op(MAMA, 'note.set', noteKey(UUID), {
    date: truth.date, text: truth.text, categoryId: truth.categoryId,
    repeatsYearly: false, visibility: level, coEdit: false, _alive: true,
  }, at, { space: PERSONAL_PLACEHOLDER, gid, born: true });
  const patch = projectForFamily('fnote', truth, level, null);
  const family = op(MAMA, 'pub.set', familyKey('fnote', MAMA, UUID), { ...patch }, at,
    { gid, ctr: 1, tag: 'p' });
  return { personal, family, gid };
}

/**
 * The REAL store, armed as Mama, in a Familienkreis.
 *
 * ⚠ ONE STORE PER PROCESS. `src/js/store.js` exports a SINGLETON and `useIdentity` /
 * `usePersonalSpace` may only be called before `init()`, so this arms it ONCE and every later
 * caller gets the same chair with a fresh board. Each row therefore uses its own entry uuid
 * rather than its own store.
 */
let storeArmed = false;
function mamaStore() {
  resetStorage();
  seedBoard({
    schemaVersion: 1, notes: [], bars: [],
    categories: [{ id: 'c1', name: 'Familie', colorRef: 'blau', visible: true }],
    scratchpads: {}, settings: null,
  });
  store.listeners.clear();
  store.warnings.length = 0;
  store.redactionHalt = null;
  if (!storeArmed) {
    store.useIdentity({
      memberId: MAMA, deviceId: DEVS[MAMA].id, deviceShort: DEVS[MAMA].short,
      peerDeviceIds: [], attestOpen: () => null,
    });
    store.usePersonalSpace(`psp_${pad22('UPERSONAL')}`);
    storeArmed = true;
  }
  store.init();
  if (store.familySpaceId() === null) store.useFamilySpace(FSP);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. U1 — BARRIER 4'S RETRACTION CLAUSE, over its whole input domain, through the REAL sealOp
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The adversary's one capability that an honest build does not have: writing the brand by hand.
 * Barrier 3 refuses an unbranded patch before barrier 4 is reached, so probing barrier 4 at all
 * requires forging one — which is exactly the capability a patched build has.
 */
function forgeBrand(patch, kind, level) {
  const out = { ...patch };
  Object.defineProperty(out, FAMILY_PATCH_BRAND, {
    value: Object.freeze({
      v: 1, source: 'projectForFamily', kind, level, fields: Object.keys(patch),
    }),
    enumerable: false, writable: false, configurable: false,
  });
  return Object.freeze(out);
}

const LEVELS_FROM_MAP = [
  { id: 'geteilt', value: 'geteilt' },
  { id: 'privat', value: 'privat' },
  { id: 'null', value: null },
  { id: 'undefined', value: undefined },
  { id: 'alien', value: 'oeffentlich' },
];

const ADMIN_ANSWERS = [
  { id: 'no-port', fn: undefined, seat: undefined },
  { id: 'null', fn: () => null, seat: null },
  { id: 'nonsense', fn: () => 'not-a-member-id', seat: 'not-a-member-id' },
  { id: 'somebody-else', fn: () => OMA, seat: OMA },
  { id: 'me', fn: () => PAPA, seat: PAPA },
];

function patchDomain() {
  const rp = retractPatch('fnote');
  return [
    // P1 — the real thing. `retractPatch('fnote')`, branded `privat` by the shipped projection.
    { id: 'retract', f: rp, brand: 'privat' },
    // P3 — the leak attempt: a retraction with a content field smuggled in beside it.
    { id: 'retract+text', f: forgeBrand({ ...rp, 'pub.text': SECRET }, 'fnote', 'privat'), brand: 'privat' },
    // P4 — ADR 004 §5.1's PRINTED code block: `pub.alive: false` instead of null (finding E7-6).
    { id: 'alive-false', f: forgeBrand({ ...rp, 'pub.alive': false }, 'fnote', 'privat'), brand: 'privat' },
    // P5 — a withdrawal that carries no `pub.level`, so no fold can read it as an unshare.
    { id: 'no-level', f: forgeBrand({ 'pub.date': null }, 'fnote', 'privat'), brand: 'privat' },
  ];
}

/**
 * THE ORACLE. Written from ADR 004 §2.2 (amended) and `RETRACTION_CLAUSE`'s clauses, in that
 * order, and computed from the row — it calls nothing under test.
 */
function sealable(row) {
  const known = ['privat', 'belegt', 'geteilt'].includes(row.folded);
  const applied = known ? row.folded : 'privat';
  const f = row.f;
  const keys = Object.keys(f);
  const pureRetraction = Object.prototype.hasOwnProperty.call(f, 'pub.level')
    && f['pub.level'] === 'privat'
    && keys.every((k) => k === 'pub.level' || f[k] === null);

  if (!known) {
    // The clause, and only the clause.
    if (!pureRetraction) return false;
    if (typeof row.adminFn !== 'function') return false;
    if (!isMemberId(row.seat)) return false;
    if (row.seat !== PAPA) return false;                 // op.act
  }
  // …then the main path's checks, at the applied level.
  if (row.brand !== applied) return false;
  const declared = Object.prototype.hasOwnProperty.call(f, 'pub.level') ? f['pub.level'] : undefined;
  if (declared !== undefined && declared !== null && declared !== applied) return false;
  if (applied === 'privat' && keys.some((k) => k !== 'pub.level' && f[k] !== null)) return false;
  return true;
}

const U1 = [];
for (const lvl of LEVELS_FROM_MAP) {
  for (const p of patchDomain()) {
    for (const a of ADMIN_ANSWERS) {
      U1.push({
        id: `U1-${lvl.id}/${p.id}/${a.id}`,
        folded: lvl.value, f: p.f, brand: p.brand, adminFn: a.fn, seat: a.seat,
      });
    }
  }
  // …plus the honest Geteilt publication, so the domain contains a cell that MUST seal on the
  // main path and a mutant that breaks it cannot hide behind an all-refusing domain.
  U1.push({
    id: `U1-${lvl.id}/publish-geteilt/me`,
    folded: lvl.value,
    f: projectForFamily('fnote', mamaTruth('geteilt'), 'geteilt', null),
    brand: 'geteilt', adminFn: () => PAPA, seat: PAPA,
  });
}

test('§0 · the domains are the size they claim', () => {
  assert.equal(U1.length, 105, '5 levelOf × 4 patches × 5 adminOf, + 5 honest publications');
  assert.equal(new Set(U1.map((r) => r.id)).size, U1.length, 'a duplicate id measures a cell twice');
  // NON-VACUITY: the domain must contain both outcomes, or it asserts nothing.
  const seals = U1.filter(sealable).length;
  assert.equal(seals, 14,
    'the oracle admits, and only: the retraction at each of the 3 unknown levels WITH the seat '
    + '(3); the retraction at folded=privat, where the MAIN path already allows it and the seat '
    + 'is irrelevant (5); the bare `pub.date: null` withdrawal at folded=privat, likewise (5); '
    + 'and the honest Geteilt publication at folded=geteilt (1)');
  assert.ok(seals > 0 && seals < U1.length, 'a domain with one outcome measures nothing');
});

test('U1 · the retraction clause: 105 cells through the REAL sealOp', async () => {
  const { devSig } = await generateDeviceKeys();
  const key = await createSpaceKey();
  const keyring = { get: (sp, ep) => (sp === FSP && ep === 1 ? key : null), currentEpoch: () => 1 };
  const fkey = familyKey('fnote', MAMA, UUID);

  let sealedCount = 0;
  for (const row of U1) {
    const o = op(PAPA, 'pub.set', fkey, row.f, BASE_MS + 90000);
    const ctx = {
      assertFamilyPatch: () => {},                       // barrier 2 stubbed OUT deliberately:
      // this file measures barrier 4 and the backstop. `tests/attack/e7-leak-routes.test.js`
      // measures what happens when barrier 2 is the last one standing.
      levelOf: () => row.folded,
      ...(row.adminFn ? { adminOf: row.adminFn } : {}),
    };
    const hdr = { v: 1, sp: FSP, ep: 1, dv: DEVS[PAPA].short, oid: o.id, wit: '' };
    let env = null;
    let err = null;
    try { env = await sealOp(o, keyring, devSig.privateKey, hdr, ctx); } catch (e) { err = e; }

    const want = sealable(row);
    if (want) {
      sealedCount++;
      assert.ok(env, `${row.id}: the clause refused an op it must seal — ${err && err.message}`);
    } else {
      assert.ok(err, `${row.id}: SEALED an op the rule refuses`);
      assert.equal(err.name, 'RedactionError', `${row.id}: ${err.message}`);
      assert.equal(err.barrier, 'barrier4', `${row.id}: refused by ${err.barrier}, expected barrier4`);
    }
    // AND THE LEAK CLAIM, on every cell: the secret never reaches a sealed envelope. Asserted on
    // the BYTES, not on the verdict — ADR 004's headline is about the sealed bytes.
    if (env) {
      assert.equal(JSON.stringify(env).includes(SECRET), false,
        `${row.id}: the secret is in the sealed envelope`);
    }
  }
  assert.equal(sealedCount, 14, 'exactly the cells the oracle admits actually sealed');
});

test('U1-a · the clause can never override a level the map HAS', () => {
  // RETRACTION_CLAUSE clause 1. An entity this device owns answers from its own `visibility`
  // truth register and takes the MAIN path — there is no adminOf answer that changes that.
  for (const row of U1) {
    if (!['privat', 'belegt', 'geteilt'].includes(row.folded)) continue;
    const withMe = { ...row, adminFn: () => PAPA, seat: PAPA };
    const withNothing = { ...row, adminFn: undefined, seat: undefined };
    assert.equal(sealable(withMe), sealable(withNothing),
      `${row.id}: the admin seat changed the outcome for an entity the map CAN answer for`);
  }
});

test('U1-b · barrier 4 with no `levelOf` at all is still a refusal, clause or no clause', async () => {
  const { devSig } = await generateDeviceKeys();
  const key = await createSpaceKey();
  const keyring = { get: () => key, currentEpoch: () => 1 };
  const o = op(PAPA, 'pub.set', familyKey('fnote', MAMA, UUID), retractPatch('fnote'), BASE_MS + 91000);
  let err = null;
  try {
    await sealOp(o, keyring, devSig.privateKey,
      { v: 1, sp: FSP, ep: 1, dv: DEVS[PAPA].short, oid: o.id, wit: '' },
      { assertFamilyPatch: () => {}, adminOf: () => PAPA });
  } catch (e) { err = e; }
  assert.ok(err, 'a seal path with no ctx.levelOf sealed a family pub.set');
  assert.equal(err.barrier, 'barrier4');
  assert.match(err.message, /no ctx\.levelOf/,
    'the missing-levelOf refusal must stay the ORIGINAL one — the retraction clause is reached '
    + 'only after the map has been consulted and has no answer');
});

test('U1-c · RETRACTION_CLAUSE says the rule, and says the two things it is not', () => {
  assert.equal(RETRACTION_CLAUSE.port, 'ctx.adminOf(spaceId) -> MemberId|null');
  assert.equal(RETRACTION_CLAUSE.clauses.length, 6);
  const all = RETRACTION_CLAUSE.clauses.join(' ');
  assert.match(all, /literal "privat"/, 'the level must be stated as a literal, not a derivation');
  assert.match(all, /not authorised here|not where admin authority is decided/i);
  assert.match(all, /convergence, not by gatekeeper/, 'D7 must be named where a reader will look');
  // The contract the outbox reads is unchanged — the clause ADDS a port, it does not soften
  // PROJECT_CONTRACT's statement that the level is never the caller's.
  assert.match(PROJECT_CONTRACT.clauses.join(' '), /`declared` never appears|RESTATEMENT, not an input/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. U2 — THE THREE PROPERTIES OF 18.3, ON THE EMITTED OP
// ═════════════════════════════════════════════════════════════════════════════════════════════

const adminCtx = (ms) => ({
  act: PAPA, dev: DEVS[PAPA].id, gid: pad22(`gx${ms}`), space: FSP, familySpaceId: FSP,
  mint: () => fmt(ms, 0, DEVS[PAPA].short),
  newOpId: () => pad22(`ox${++opN}`),
});

test('U2-a · IT REVERTS — the patch is a withdrawal of every field, explicitly (INV-R4)', () => {
  for (const kind of ['fnote', 'fbar']) {
    const uuid = kind === 'fnote' ? UUID : BAR_UUID;
    const o = adminUnshareOp(adminCtx(BASE_MS + 100000), { kind, owner: MAMA, uuid });
    assert.equal(o.k, 'pub.set');
    assert.equal(o.e, familyKey(kind, MAMA, uuid));
    assert.equal(o.f['pub.level'], 'privat');
    for (const field of GETEILT_FIELDS[kind]) {
      if (field === 'pub.level') continue;
      assert.ok(Object.prototype.hasOwnProperty.call(o.f, field),
        `${kind}: "${field}" is OMITTED. Omission is not withdrawal (ADR 004 §5.1) — the peer's `
        + 'LWW fold keeps the old value AND its stamp.');
      assert.equal(o.f[field], null, `${kind}: "${field}" is not an explicit null`);
    }
    // …and every honest peer can read it as an unshare, or the moderation lands nowhere.
    assert.equal(classifyUnsharePatch(kind, o.f), 'unshare',
      `${kind}: stage 3a would park or reject this, silently, on every peer`);
  }
});

test('U2-b · IT IS NEVER DELETED — no `_alive`, no personal space, `pub.alive` NULLED', () => {
  for (const kind of ['fnote', 'fbar']) {
    const uuid = kind === 'fnote' ? UUID : BAR_UUID;
    const o = adminUnshareOp(adminCtx(BASE_MS + 101000), { kind, owner: MAMA, uuid });
    assert.equal(o.space, FSP, 'the op is addressed to the FAMILY space and nowhere else');
    assert.equal('_alive' in o.f, false, '`_alive` is the owner\'s truth register and is untouchable');
    assert.equal('_born' in o.f, false, '`_born` is write-once and the entry is not deleted (18.3)');
    assert.equal(o.f['pub.alive'], null,
      'ADR 004 §5.1\'s printed `pub.alive: false` is UNSEALABLE (finding E7-6) and `null` is also '
      + 'the better answer: it makes the admin\'s unshare byte-identical to the owner\'s "→ Privat"');
    for (const name of Object.keys(o.f)) {
      assert.ok(name.startsWith('pub.'), `"${name}" is not a pub.* field — an unshare writes nothing else`);
      const spec = FIELDS[kind][name];
      assert.ok(spec, `"${name}" is not a ${kind} field at all`);
    }
  }
});

test('U2-c · IT NEVER READS — arity 2, and the bytes are a function of the KIND alone', () => {
  // There is no `truth` parameter and no patch parameter: content has no way in. Measured on the
  // FUNCTION, because "we simply never pass one" is a habit and this must be a property.
  assert.equal(adminUnshareOp.length, 2, 'adminUnshareOp(ctx, spec) — a third parameter would be '
    + 'the seam through which an admin could describe an entry they have never seen');
  // Two different owners, two different uuids, ONE patch. Nothing about the entry is in the bytes.
  const a = adminUnshareOp(adminCtx(BASE_MS + 102000), { kind: 'fnote', owner: MAMA, uuid: UUID });
  const b = adminUnshareOp(adminCtx(BASE_MS + 103000), {
    kind: 'fnote', owner: OMA, uuid: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
  });
  assert.deepEqual({ ...a.f }, { ...b.f },
    'the bytes differ between two entries, so they carry something about the entry');
  // A caller that tries to describe the entry is refused, not quietly obeyed.
  assert.throws(() => adminUnshareOp(adminCtx(BASE_MS + 104000), {
    kind: 'fnote', owner: MAMA, uuid: UUID, truth: { text: SECRET },
  }), () => true, 'an extra key must not be silently accepted');
});

test('U2-d · the refusals are refusals, not guesses', () => {
  const ctx = adminCtx(BASE_MS + 105000);
  const bad = [
    ['no family space', { ...ctx, familySpaceId: null }, { kind: 'fnote', owner: MAMA, uuid: UUID }],
    ['personal kind', ctx, { kind: 'note', owner: MAMA, uuid: UUID }],
    ['owner is not a MemberId', ctx, { kind: 'fnote', owner: 'mama', uuid: UUID }],
    ['owner absent', ctx, { kind: 'fnote', uuid: UUID }],
    ['uuid absent', ctx, { kind: 'fnote', owner: MAMA }],
    ['spec is a string', ctx, 'fnote:x/y'],
  ];
  for (const [id, c, spec] of bad) {
    assert.throws(() => adminUnshareOp(c, spec), (e) => e instanceof RedactionError, id);
  }
});

test('U2-e · ADMIN_UNSHARE_CONTRACT states 18.3 as claims, D7 included', () => {
  assert.equal(ADMIN_UNSHARE_CONTRACT.story, '18.3');
  assert.equal(ADMIN_UNSHARE_CONTRACT.clauses.length, 6);
  const all = ADMIN_UNSHARE_CONTRACT.clauses.join(' ');
  assert.match(all, /never deletes/);
  assert.match(all, /never reads/);
  assert.match(all, /convergence, not by gatekeeper/);
  assert.match(all, /adminUnshareFollowUp/, 'the owner\'s half must be named where the story is');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. PRINCIPLE 9 — the admin's unshare and the owner's own „→ Privat" are the same bytes
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§3 · byte-identical: a peer cannot tell an admin unshare from the owner going Privat', () => {
  for (const kind of ['fnote', 'fbar']) {
    const uuid = kind === 'fnote' ? UUID : BAR_UUID;
    // The admin's moderation…
    const adminOp = adminUnshareOp(adminCtx(BASE_MS + 110000), { kind, owner: MAMA, uuid });
    // …and the owner's own downgrade, through the ordinary projection.
    const truth = kind === 'fnote' ? mamaTruth('privat') : {
      visibility: 'privat', startDate: '2027-07-01', endDate: '2027-07-14',
      label: 'Kur', coEdit: false, _alive: true,
    };
    const ownerPatch = projectForFamily(kind, truth, 'privat', 'geteilt');
    assert.equal(JSON.stringify(adminOp.f), JSON.stringify({ ...ownerPatch }),
      `${kind}: the two retractions differ, so a peer can tell WHICH happened — Principle 9 is `
      + 'enforced by the absence of a distinguishing byte, not by a policy (ADR 004 §7)');
    // …and `core/authz.js`'s own idea of the patch agrees with both. Three shipped statements of
    // one shape; the day two of them drift, this row is what says so.
    assert.deepEqual({ ...adminOp.f }, { ...unsharePatch(kind) },
      `${kind}: core/authz.js:unsharePatch and core/project.js:retractPatch disagree`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. END TO END — the fold decides, the peer loses it, and the owner keeps it
// ═════════════════════════════════════════════════════════════════════════════════════════════

function scenario(actor) {
  const k = kreis();
  const share = mamaShares('geteilt', k.at + 1000);
  const un = op(actor, 'pub.set', familyKey('fnote', MAMA, UUID),
    { ...retractPatch('fnote') }, k.at + 5000);
  return { k, share, un };
}

const foldFor = (me, ops) => foldAuthorized(ops, { me, nowMs: BASE_MS + 7200000, attestVerify });

test('§4-a · the admin unshares: Oma\'s board loses the entry and her registers hold nulls', () => {
  const s = scenario(PAPA);
  const all = [...s.k.ops, s.share.family, s.un];

  // Before: Oma sees Mama's shared note, with its text.
  const before = foldFor(OMA, [...s.k.ops, s.share.family]);
  const shown = materialize(before.regs, MCTX(OMA)).notes.filter((n) => n.isForeign);
  assert.equal(shown.length, 1, 'NON-VACUITY: the entry must be visible before it is moderated');
  assert.equal(shown[0].text, SECRET);

  // After: it is gone, and stage 3a ADMITTED the admin's op — a rejection would look identical
  // on the board and mean nothing was moderated at all.
  const after = foldFor(OMA, all);
  assert.deepEqual(after.rejected.map((o) => o.id), [], 'stage 3a rejected the admin\'s unshare');
  assert.deepEqual(after.parked.map((o) => o.id), [], 'the unshare was PARKED as version skew');
  assert.deepEqual(materialize(after.regs, MCTX(OMA)).notes.filter((n) => n.isForeign), [],
    'the moderated entry is still on a peer\'s board');
  const fkey = familyKey('fnote', MAMA, UUID);
  for (const field of GETEILT_FIELDS.fnote) {
    const cell = getRegister(after.regs, fkey, field);
    if (field === 'pub.level') { assert.equal(cell && cell.value, 'privat'); continue; }
    assert.equal(cell ? cell.value : null, null,
      `"${field}" survived the moderation on a peer's disk — omission is not withdrawal`);
  }
});

test('§4-b · IT IS NEVER DELETED — Mama\'s own board still carries the entry, in full', () => {
  const s = scenario(PAPA);
  // Mama's Mac holds her personal truth ops as well as the family log.
  const mine = foldFor(MAMA, [...s.k.ops, s.share.personal, s.share.family, s.un]);
  const board = materialize(mine.regs, MCTX(MAMA));
  const note = board.notes.find((n) => n.id === UUID);
  assert.ok(note, 'the admin\'s unshare DELETED the owner\'s entry — 18.3 says it never does');
  assert.equal(note.text, SECRET, 'the owner\'s own text was blanked by a moderation (INV-R3)');
  assert.ok(!note.isForeign, 'the owner\'s own entry became foreign to her');
  // …and her truth registers are untouched: same value, same stamp, same op.
  const truthCell = getRegister(mine.regs, noteKey(UUID), 'text');
  assert.equal(truthCell.value, SECRET);
  assert.equal(truthCell.op, s.share.personal.id,
    'a moderation rewrote a register in the owner\'s PERSONAL space');
  assert.equal(getRegister(mine.regs, noteKey(UUID), '_alive').value, true,
    'the entry was tombstoned by a moderation');
});

test('§4-c · D7 — a non-admin\'s identical op is rejected by every honest device', () => {
  // The same bytes, the same entity, a different author. Ownership is structural and the fold is
  // deterministic, so Oma's forgery is rejected on Oma's own Mac too.
  const s = scenario(OMA);
  for (const me of [PAPA, MAMA, OMA]) {
    const r = foldFor(me, [...s.k.ops, s.share.family, s.un]);
    assert.equal(r.rejected.length, 1, `${me}: a non-admin's unshare was ADMITTED`);
    assert.equal(r.rejectionOf(s.un.id).reason, REJECT_REASONS.NOT_OWNER);
    assert.equal(getRegister(r.regs, familyKey('fnote', MAMA, UUID), 'pub.level').value, 'geteilt',
      `${me}: the forged moderation moved the level anyway`);
  }
});

test('§4-d · the moderation is order-independent — a peer that saw only the retraction agrees', () => {
  // ADR 004 §5.3 mechanism 1: the argmax fold ignores intermediates. A Mac that was offline for
  // the whole Geteilt period and pulls one batch lands in the same place.
  const s = scenario(PAPA);
  const onlyLast = foldFor(OMA, [...s.k.ops, s.un]);
  assert.deepEqual(materialize(onlyLast.regs, MCTX(OMA)).notes.filter((n) => n.isForeign), []);
  // …and so does one that receives the two family ops in the wrong order.
  const shuffled = foldFor(OMA, [...s.k.ops, s.un, s.share.family]);
  assert.deepEqual(materialize(shuffled.regs, MCTX(OMA)).notes.filter((n) => n.isForeign), []);
});

test('§4-e · an admin cannot smuggle a write into an unshare', () => {
  // `classifyUnsharePatch` admits a patch only if every field beside `pub.level` is null, so the
  // one thing an admin can append to an unshare is another WITHDRAWAL. A padded one is PARKED —
  // never applied, never dropped (a rejection is final, and a wrongly-final rejection of an
  // unshare leaves previously-hidden content visible).
  const s = scenario(PAPA);
  const padded = op(PAPA, 'pub.set', familyKey('fnote', MAMA, UUID),
    { ...retractPatch('fnote'), 'pub.text': 'gekapert' }, s.k.at + 6000);
  const r = foldFor(OMA, [...s.k.ops, s.share.family, padded]);
  assert.equal(r.parked.length, 1, 'a padded unshare must be parked, not applied');
  assert.equal(getRegister(r.regs, familyKey('fnote', MAMA, UUID), 'pub.text').value, SECRET,
    'the padded op wrote through — an unshare became a general write primitive');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. U3 — THE OWNER'S FOLLOW-UP, and the re-publish it exists to prevent
// ═════════════════════════════════════════════════════════════════════════════════════════════

const U3 = [
  ['moderated-geteilt', 'privat', 'geteilt', true],
  ['moderated-belegt', 'privat', 'belegt', true],
  ['own-downgrade', 'privat', 'privat', false],
  ['still-shared', 'geteilt', 'geteilt', false],
  ['still-belegt', 'belegt', 'belegt', false],
  ['level-mismatch-upward', 'belegt', 'geteilt', false],
  ['no-truth-register', 'privat', undefined, false],
  ['null-truth-register', 'privat', null, false],
  ['alien-truth-register', 'privat', 'oeffentlich', false],
  ['nothing-published', undefined, 'geteilt', false],
].map(([id, pub, vis, expect]) => ({ id: `U3-${id}`, pub, vis, expect }));

/** A hand-built register map of the shape `foldAuthorized` produces. */
function regsWith(rows) {
  const m = new Map();
  for (const [entity, name, value] of rows) {
    if (!m.has(entity)) m.set(entity, new Map());
    m.get(entity).set(name, { value, ts: fmt(BASE_MS, 0, DEVS[MAMA].short), op: pad22('oreg') });
  }
  return m;
}

test('U3 · the follow-up fires exactly where the two registers disagree', () => {
  assert.equal(U3.length, 10);
  const ctx = {
    act: MAMA, me: MAMA, dev: DEVS[MAMA].id, gid: pad22('gf1'), space: PERSONAL_PLACEHOLDER,
    familySpaceId: FSP, mint: () => fmt(BASE_MS + 200000, 0, DEVS[MAMA].short),
    newOpId: () => pad22(`of${++opN}`),
  };
  for (const row of U3) {
    const rows = [];
    if (row.pub !== undefined) rows.push([familyKey('fnote', MAMA, UUID), 'pub.level', row.pub]);
    if (row.vis !== undefined) rows.push([noteKey(UUID), 'visibility', row.vis]);
    rows.push([noteKey(UUID), 'text', SECRET]);
    const out = adminUnshareFollowUp(regsWith(rows), ctx);
    assert.equal(out.length, row.expect ? 1 : 0, `${row.id}: ${out.length} op(s)`);
    if (!row.expect) continue;
    assert.equal(out[0].k, 'note.set');
    assert.equal(out[0].e, noteKey(UUID));
    assert.deepEqual(Object.keys(out[0].f), ['visibility'],
      `${row.id}: the follow-up wrote something other than the level. It is a reconciliation, not `
      + 'an edit, and it may never touch the owner\'s content.');
    assert.equal(out[0].f.visibility, 'privat');
    assert.equal(out[0].space, PERSONAL_PLACEHOLDER);
  }
});

test('U3-a · the follow-up is idempotent, notifies nobody, and never touches a peer\'s entity', () => {
  const ctx = {
    act: MAMA, me: MAMA, dev: DEVS[MAMA].id, gid: pad22('gf2'), space: PERSONAL_PLACEHOLDER,
    familySpaceId: FSP, mint: () => fmt(BASE_MS + 201000, 0, DEVS[MAMA].short),
    newOpId: () => pad22(`og${++opN}`),
  };
  const regs = regsWith([
    [familyKey('fnote', MAMA, UUID), 'pub.level', 'privat'],
    [noteKey(UUID), 'visibility', 'geteilt'],
    // …and a PEER's moderated entity in the same map. Not mine to reconcile: ownership is read
    // off the key (ADR 001 §4.4) and there is no truth register here to write anyway.
    [familyKey('fnote', OMA, BAR_UUID), 'pub.level', 'privat'],
    [`note:${BAR_UUID}`, 'visibility', 'geteilt'],
  ]);
  const first = adminUnshareFollowUp(regs, ctx);
  assert.equal(first.length, 1, 'it reconciled somebody else\'s entity');
  assert.equal(first[0].e, noteKey(UUID));

  // Run it again over the state its own op produces: nothing.
  const settled = regsWith([
    [familyKey('fnote', MAMA, UUID), 'pub.level', 'privat'],
    [noteKey(UUID), 'visibility', 'privat'],
  ]);
  assert.deepEqual(adminUnshareFollowUp(settled, ctx), [], 'the follow-up is not idempotent');

  // Principle 9: there is no notification, no marker and no second op of any kind.
  for (const o of first) {
    assert.equal(o.k, 'note.set');
    assert.deepEqual(Object.keys(o.f), ['visibility']);
  }
  // Solo mode evaluates none of it.
  assert.deepEqual(adminUnshareFollowUp(regs, { ...ctx, familySpaceId: null }), []);
});

test('U3-b · WITHOUT the follow-up, the owner\'s next keystroke undoes the moderation', () => {
  // The measurement that makes `adminUnshareFollowUp` a defect fix rather than a nicety, taken on
  // the REAL store: `derivePublication` reads the level from `visibility` and `lastPublished` from
  // the folded `pub.level`. After a moderation those two disagree, so the next edit projects a
  // full Geteilt patch again — and the admin sees the text come back with no way to tell whether
  // the owner re-shared on purpose.
  mamaStore();

  const id = 'ffffffff-6666-4666-8666-ffffffffffff';
  store.txn('create-note', (tx) => tx.note(id).create({
    date: '2026-12-24', text: SECRET, categoryId: 'c1', repeatsYearly: false,
    visibility: 'geteilt', coEdit: false,
  }));
  const famOps = () => store._log.lines().map((l) => l.op).filter((o) => o.space === FSP);
  assert.equal(famOps().length, 1, 'NON-VACUITY: the share must have published');

  // The admin's moderation arrives and is folded (the fold itself is §4's claim; here it is a
  // premise, so it is written straight into the log the way `applyRemote` would leave it).
  //
  // ⚠ STAMPED RELATIVE TO THE LOG, not from `BASE_MS`. The store mints from the real clock, so a
  // constant fixture stamp LOSES the LWW contest against the share the line above just wrote —
  // and the row would then measure "an old op lost", which is true of any op and proves nothing.
  const afterShare = msOf(famOps().at(-1).ts) + 1000;
  store._log.append(op(PAPA, 'pub.set', familyKey('fnote', MAMA, id),
    { ...retractPatch('fnote') }, afterShare));
  assert.equal(
    getRegister(store._log.registers(), familyKey('fnote', MAMA, id), 'pub.level').value, 'privat',
    'NON-VACUITY: the moderation must be the winning write before the edit is made');

  // …and now Mama edits the text of a DIFFERENT thing about the same entry.
  store.txn('edit-note', (tx) => tx.note(id).set({ text: 'Bescherung' }));
  const before = famOps().length;
  const last = famOps().at(-1);
  assert.equal(last.f['pub.level'], 'geteilt',
    'THE MODERATION SURVIVED AN EDIT — if this ever passes, adminUnshareFollowUp has a caller and '
    + 'this row must be inverted rather than deleted');
  assert.equal(last.act, MAMA,
    'the last family op is not the owner\'s — nothing was re-published, so nothing is measured');
  assert.equal(before, 3, 'share, moderation, re-publication: the re-publication IS the defect');

  // And the follow-up is exactly what closes it: run it over the same registers and the
  // disagreement is gone.
  const ctx = { ...store._ctx(), me: MAMA };
  const fix = adminUnshareFollowUp(store._log.registers(), ctx);
  assert.equal(fix.length, 1, 'the follow-up did not see the disagreement it exists for');
  assert.equal(fix[0].e, noteKey(id));
  assert.equal(fix[0].f.visibility, 'privat');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6. THE DRIVER'S PURE HALF, AND THE COPY CONTRACT
// ═════════════════════════════════════════════════════════════════════════════════════════════

const fkeyOf = (owner = MAMA) => familyKey('fnote', owner, UUID);

test('§6-a · planUnshare answers every reachable verdict, and asks in the right ORDER', () => {
  const shared = regsWith([[fkeyOf(), 'pub.level', 'geteilt']]);
  const seat = (admin, isMe) => ({ spaceId: FSP, admin, headOpId: null, isMe });

  assert.equal(planUnshare({ regs: shared, entityKey: fkeyOf(), spaceId: null, seat: seat(PAPA, true) })
    .verdict, UNSHARE.NOT_MINE, 'solo mode');
  assert.equal(planUnshare({ regs: shared, entityKey: noteKey(UUID), spaceId: FSP, seat: seat(PAPA, true) })
    .blockers[0], UNSHARE_BLOCKERS.NOT_A_FAMILY_ENTITY, 'a personal key addresses nothing here');
  assert.equal(planUnshare({ regs: shared, entityKey: fkeyOf(), spaceId: FSP, seat: seat(null, false) })
    .blockers[0], UNSHARE_BLOCKERS.NO_ADMIN_CHAIN);
  assert.equal(planUnshare({ regs: shared, entityKey: fkeyOf(), spaceId: FSP, seat: seat(OMA, false) })
    .blockers[0], UNSHARE_BLOCKERS.NOT_THE_ADMIN);
  assert.deepEqual(
    planUnshare({ regs: shared, entityKey: fkeyOf(), spaceId: FSP, seat: seat(PAPA, true), hasKey: false })
      .blockers, [UNSHARE_BLOCKERS.NO_KEY]);
  const ok = planUnshare({ regs: shared, entityKey: fkeyOf(), spaceId: FSP, seat: seat(PAPA, true) });
  assert.equal(ok.verdict, UNSHARE.DONE);
  assert.deepEqual(ok.target, { shared: true, level: 'geteilt', kind: 'fnote', owner: MAMA, uuid: UUID });

  // ⚠ THE ORDER IS THE PRIVACY CLAIM. "Is anything published?" is asked BEFORE "am I the admin?",
  // so a NON-admin asking about an entity the family does not hold learns exactly what an admin
  // learns: nothing. Answering `notTheAdmin` first would make the refusal itself report that
  // something IS published there — a one-bit read of somebody's board, granted by an error.
  const empty = regsWith([[noteKey(UUID), 'text', SECRET]]);
  for (const s of [seat(PAPA, true), seat(OMA, false), seat(null, false)]) {
    assert.equal(planUnshare({ regs: empty, entityKey: fkeyOf(), spaceId: FSP, seat: s }).verdict,
      UNSHARE.NOTHING_SHARED,
      'the verdict for an unshared entity depends on WHO IS ASKING — that is a disclosure');
  }
});

test('§6-b · publishedState cannot report a level history (Principle 9)', () => {
  // `'privat'` (moderated, or downgraded) and absent (never shared) are the SAME answer. Telling
  // them apart would let a UI say „war geteilt", which ADR 004 §7.1 forbids by name.
  const wasShared = publishedState(regsWith([[fkeyOf(), 'pub.level', 'privat']]), fkeyOf());
  const neverShared = publishedState(regsWith([[noteKey(UUID), 'text', SECRET]]), fkeyOf());
  assert.deepEqual(wasShared, neverShared);
  assert.equal(wasShared.shared, false);
  assert.equal(wasShared.level, null);
  // …and it reads `pub.level`, which is the RIGHT register for "what do the others see" and the
  // wrong one for "what may be sealed" (finding S5). Belegt counts as shared.
  assert.equal(publishedState(regsWith([[fkeyOf(), 'pub.level', 'belegt']]), fkeyOf()).level, 'belegt');
  assert.equal(publishedState(null, fkeyOf()).shared, false);
  assert.equal(publishedState(regsWith([]), 'not a key').kind, null);
});

test('§6-c · the copy contract — both languages, ADR 002 §7.4', () => {
  // The required downgrade sentence is present BY IDENTITY, not by re-typing. A paste would make
  // this row red rather than pass review.
  assert.equal(UNSHARE_COPY.honesty, SHARING_TXT.downgradeNote,
    'the §7.4 downgrade string was copied instead of shared');
  assert.match(UNSHARE_COPY.honesty.de, /Was schon sichtbar war, wurde schon gesehen\./);

  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') { strings.push(v); return; }
    if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(UNSHARE_COPY);
  assert.ok(strings.length >= 14, `only ${strings.length} strings — the walker stopped working`);

  for (const s of strings) {
    for (const claim of FORBIDDEN_CLAIMS) {
      assert.equal(s.toLowerCase().includes(claim.toLowerCase()), false,
        `forbidden claim "${claim}" in: ${s}`);
    }
    // Principle 9 / addendum §6: the copy never reports on a person, and never says a name.
    assert.equal(/gelöscht|deleted|entfernt aus|removed the entry/i.test(s), false,
      `the copy implies a deletion: ${s}`);
  }
  // German first, English second (13.7) — every pair has both, and they are different strings.
  for (const [k, v] of Object.entries(UNSHARE_COPY)) {
    assert.ok(typeof v.de === 'string' && v.de.length > 0, `${k}: no German`);
    assert.ok(typeof v.en === 'string' && v.en.length > 0, `${k}: no English`);
    assert.notEqual(v.de, v.en, `${k}: the two languages are the same string`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7. STORY 18.6 — deletions propagate, and the AUTHOR's undo restores as a NEW op
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('18.6-a · a delete of a published entry publishes a TOMBSTONE, and undo restores it', () => {
  mamaStore();
  const id = '11111111-7777-4777-8777-111111111111';
  store.txn('create-note', (tx) => tx.note(id).create({
    date: '2026-12-24', text: 'Bescherung', categoryId: 'c1', repeatsYearly: false,
    visibility: 'geteilt', coEdit: false,
  }));
  const fam = () => store._log.lines().map((l) => l.op).filter((o) => o.space === FSP);
  assert.equal(fam().length, 1, 'NON-VACUITY: the entry must be published before it is deleted');

  store.txn('delete-note', (tx) => tx.note(id).del());
  const tomb = fam().at(-1);
  assert.equal(fam().length, 2, 'the delete published nothing — it would live on every peer\'s board');
  assert.equal(tomb.k, 'pub.set');
  assert.equal(tomb.f['pub.alive'], false, 'the tombstone is `pub.alive: false` (ADR 004 §5)');
  assert.equal(tomb.f['pub.text'], null,
    'a dead entry publishes its tombstone and NOTHING ELSE — a delete that kept the text would '
    + 'leave it readable in every peer\'s register map');
  for (const f of GETEILT_FIELDS.fnote) {
    if (f === 'pub.level' || f === 'pub.alive') continue;
    assert.equal(tomb.f[f], null, `"${f}" survived the delete`);
  }
  assert.equal(store.state.notes.length, 0, 'the entry is still on the board after a delete');

  // …and the AUTHOR's undo restores it AS A NEW OP. Not a rewind, not a retraction of the
  // tombstone: a new `pub.set` at a NEWER stamp, so a peer that already tombstoned sees a
  // resurrect rather than a duplicate entry.
  store.undo();
  const back = fam().at(-1);
  assert.equal(fam().length, 3, 'the restore emitted no family op — it would live only on my Mac');
  assert.ok(back.ts > tomb.ts, 'the restore is not at a NEWER stamp, so the LWW fold ignores it');
  assert.notEqual(back.id, tomb.id, 'the restore reused the tombstone\'s op id');
  assert.equal(back.e, tomb.e, 'the restore addresses a different entity — 18.6 says the SAME one');
  assert.equal(back.f['pub.alive'], true);
  assert.equal(back.f['pub.text'], 'Bescherung', 'the restore did not bring the content back');
  assert.equal(store.state.notes.length, 1);
  assert.equal(store.state.notes[0].text, 'Bescherung');
});

test('18.6-b · a peer folding only the last op agrees, in either arrival order', () => {
  // The restore has to WIN on a Mac that never saw the delete, and lose to nothing. Both are
  // properties of the argmax fold, and both are what "restores it as a new shared operation"
  // means once there is more than one Mac.
  const k = kreis();
  const fk = familyKey('fnote', MAMA, UUID);
  const share = mamaShares('geteilt', k.at + 1000);
  const dead = { ...mamaTruth('geteilt'), _alive: false };
  const tomb = op(MAMA, 'pub.set', fk,
    { ...projectForFamily('fnote', dead, 'geteilt', 'geteilt') }, k.at + 2000);
  const back = op(MAMA, 'pub.set', fk,
    { ...projectForFamily('fnote', mamaTruth('geteilt'), 'geteilt', 'geteilt') }, k.at + 3000);

  const seen = (ops) => materialize(foldFor(OMA, ops).regs, MCTX(OMA)).notes.filter((n) => n.isForeign);
  assert.equal(seen([...k.ops, share.family]).length, 1, 'NON-VACUITY');
  assert.equal(seen([...k.ops, share.family, tomb]).length, 0, 'the deletion did not propagate');
  assert.equal(seen([...k.ops, share.family, tomb, back]).length, 1, 'the restore did not land');
  assert.equal(seen([...k.ops, back, tomb, share.family]).length, 1,
    'the outcome depends on arrival order — the fold is not order-independent');
  assert.equal(seen([...k.ops, back]).length, 1,
    'a Mac that never saw the delete cannot see the restored entry');
  assert.equal(seen([...k.ops, share.family, tomb, back])[0].text, 'Scheidungsanwalt 14:30');
});

test('18.6-c · 18.4 — another member\'s delete can never enter my undo stack', () => {
  // The interaction the ticket names. `captureImages` is armed with `me` on every commit
  // (`store._commit`), so a foreign op is refused at the door rather than inverted by mistake —
  // and ⌘Z therefore cannot resurrect somebody else's deletion or undo their moderation.
  const foreign = op(MAMA, 'note.set', noteKey(UUID), { _alive: false }, BASE_MS + 400000,
    { space: PERSONAL_PLACEHOLDER });
  assert.throws(
    () => captureImages(new Map(), [foreign], { me: PAPA }),
    (e) => e instanceof UndoError && /story 18\.4/.test(e.message));
  // …and a `pub.set` is not undoable AT ALL — not even my own. ADR 004 §5 and `core/undo.js`:
  // the publication is DERIVED, so ⌘Z undoes the truth and lets the publisher re-derive.
  const mineFamily = op(PAPA, 'pub.set', familyKey('fnote', MAMA, UUID),
    { ...retractPatch('fnote') }, BASE_MS + 401000);
  const images = captureImages(new Map(), [mineFamily], { me: PAPA });
  assert.deepEqual(images.pre, [], 'a family op entered the undo stack');
  assert.deepEqual(images.post, []);
});

test('18.6-d · a moderated entry that the owner deletes and restores stays moderated', () => {
  // The 18.3 × 18.6 interaction, on the fold. Once the family holds `privat`, the owner's delete
  // publishes NOTHING (there is no tombstone for something no peer can see, 16.1) and the restore
  // republishes nothing either — until the owner deliberately shares again.
  const truthPrivat = { ...mamaTruth('privat') };
  assert.equal(projectForFamily('fnote', truthPrivat, 'privat', 'privat'), null,
    'a moderated entry re-published on a delete');
  assert.equal(projectForFamily('fnote', { ...truthPrivat, _alive: false }, 'privat', 'privat'), null,
    'the delete of a moderated entry announced that it existed');
  // …and the retraction the moderation wrote is still the whole of what a peer holds.
  const s = scenario(PAPA);
  const r = foldFor(OMA, [...s.k.ops, s.share.family, s.un]);
  assert.equal(getRegister(r.regs, familyKey('fnote', MAMA, UUID), 'pub.alive').value, null);
  assert.equal(getRegister(r.regs, familyKey('fnote', MAMA, UUID), 'pub.level').value, 'privat');
});
