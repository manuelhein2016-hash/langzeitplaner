// tests/attack/_harness.js — a hostile family, built by hand.
//
// This is NOT tests/helpers/gen.js. gen.js builds the world the implementers had in mind; this
// one builds the world an attacker would build, with every id chosen so the attack is legible in
// the assertion rather than hidden in a seed.
//
// Zero dependencies, DOM-free. Nothing here is imported by src/.

import { makeOp } from '../../src/js/core/ops.js';
import { memberKey, spaceKey, familyKey, noteKey } from '../../src/js/core/entities.js';
import { fmt } from '../../src/js/core/stamp.js';
import { canonicalJSON } from '../../src/js/core/canon.js';
import { b64u, ub64 } from '../../src/js/core/b64.js';

const TE = new TextEncoder();
const TD = new TextDecoder();

/** 22 base64url characters, deterministic and readable in a failure message. */
const id22 = (s) => (s + 'x'.repeat(22)).slice(0, 22);
const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 16 Crockford characters. */
export const short16 = (s) => {
  let out = '';
  for (const ch of s.toUpperCase()) out += CROCK.includes(ch) ? ch : CROCK[ch.charCodeAt(0) % 32];
  return (out + '0'.repeat(16)).slice(0, 16);
};

// ── the cast ────────────────────────────────────────────────────────────────────────────────
// MEMBER IDS ARE CHOSEN FOR THEIR SORT ORDER. `ZORRO` sorts after `MAMA`/`ME`/`PAPA`, which is
// what the envelope-splicing attack (A3) needs; `AXEL` sorts before all of them, which is what
// the same attack needs in the other direction. Real member ids are random, so an attacker
// simply keeps generating one until it sorts where they want it.
export const ME = `mem_${id22('ME')}`;          // the victim / the local device's owner
export const MAMA = `mem_${id22('MAMA')}`;      // an honest co-editor
export const PAPA = `mem_${id22('PAPA')}`;      // the honest genesis admin
export const ZORRO = `mem_${id22('ZORRO')}`;    // the malicious family member; sorts LAST
export const AXEL = `mem_${id22('AXEL')}`;      // a second attacker whose id sorts FIRST
export const EVE = `mem_${id22('EVE')}`;        // an outsider, never invited

export const MEMBERS = Object.freeze([ME, MAMA, PAPA, ZORRO]);

export const PSP = `psp_${id22('PERSONAL')}`;
export const FSP = `fsp_${id22('FAMILIE')}`;
export const FSP_EVIL = `fsp_${id22('EVIL')}`;    // a SECOND family circle the attacker creates

export const BASE_MS = 1787836800000;             // 2026-08-25T00:00:00Z-ish. Never Date.now().
export const HOUR = 3600000;
export const DAY = 24 * HOUR;

export const dev = (name, member) => Object.freeze({
  name, member, id: `dev_${id22(name.replace(/[^A-Za-z0-9]/g, ''))}`, short: short16(name),
});

export const D = Object.freeze({
  me: dev('MEMAC', ME),
  meLaptop: dev('MELAP', ME),
  mama: dev('MAMAMAC', MAMA),
  papa: dev('PAPAMAC', PAPA),
  zorro: dev('ZORROMAC', ZORRO),
  axel: dev('AXELMAC', AXEL),
  eve: dev('EVEMAC', EVE),
});

// ── attestation (ADR 002 §2.3) ──────────────────────────────────────────────────────────────
//
// `sig` is `sig:<memberId>:<deviceId>` — i.e. a signature made with THAT MEMBER'S OWN recovery
// key, which is exactly what §2.3 specifies and exactly what any member can produce for their own
// member id. Modelling it as anything stronger would be modelling a defence the design does not
// have. This is byte-compatible with tests/helpers/gen.js so a finding here is not an artefact of
// a different stub.

export function attestationBlob(member, device, overrides = {}) {
  const att = {
    memberId: member,
    deviceId: device.id,
    deviceShort: device.short,
    sigPubRaw: b64u(TE.encode(`sigpub:${device.id}`)),
    kexPubRaw: b64u(TE.encode(`kexpub:${device.id}`)),
    createdAt: '2026-08-25',
    ...overrides,
  };
  const signer = att.memberId;             // you sign with YOUR key, over YOUR payload
  return `${b64u(TE.encode(canonicalJSON(att)))}.${b64u(TE.encode(`sig:${signer}:${att.deviceId}`))}`;
}

export function attestVerify(memberId, blob) {
  if (typeof blob !== 'string') return false;
  const dot = blob.indexOf('.');
  if (dot < 0) return false;
  try {
    const att = JSON.parse(TD.decode(ub64(blob.slice(0, dot))));
    const sig = TD.decode(ub64(blob.slice(dot + 1)));
    return att.memberId === memberId && sig === `sig:${att.memberId}:${att.deviceId}`;
  } catch {
    return false;
  }
}

// ── op minting ──────────────────────────────────────────────────────────────────────────────

/**
 * An op author. Every stamp is `fmt(msYouAskedFor, counter, device.short)` — no clock, no
 * randomness, so every op sequence in a finding is reproducible verbatim.
 */
export function actor(device, counter) {
  let n = 0;
  return {
    device,
    /**
     * @param {string} k op kind
     * @param {string} e entity key
     * @param {Object} f field patch
     * @param {{ms?:number, ctr?:number, act?:string, dev?:string, space?:string,
     *          familySpaceId?:string, gid?:string, id?:string, born?:boolean}} o
     */
    op(k, e, f, o = {}) {
      const ms = o.ms ?? BASE_MS;
      const ctr = o.ctr ?? 0;
      const ctx = {
        act: o.act ?? device.member,
        dev: o.dev ?? device.id,
        gid: o.gid ?? id22(`g${counter.gid++}`),
        space: o.space,
        familySpaceId: o.familySpaceId ?? FSP,
        mint: () => fmt(ms, ctr, (o.devShort ?? device.short)),
        newOpId: () => o.id ?? id22(`o${counter.op++}_${device.short.slice(0, 4)}${++n}`),
      };
      return makeOp(ctx, k, e, f, { born: o.born });
    },
  };
}

export function newWorld() {
  const counter = { gid: 1000, op: 1000 };
  const A = Object.fromEntries(Object.entries(D).map(([k, d]) => [k, actor(d, counter)]));
  return { A, counter };
}

/**
 * The honest preamble every attack starts from: four attested members, PAPA as genesis admin of
 * `FSP`, ME owning a note that is published Geteilt with co-editing ON.
 *
 * ME's note uuid is fixed so a finding can name it.
 */
export const U1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const U2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const U_PAPA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

export const T = {
  attest: BASE_MS,
  genesis: BASE_MS + 10_000,
  board: BASE_MS + 20_000,
  publish: BASE_MS + 30_000,
  coedit: BASE_MS + 40_000,
  now: BASE_MS + 100_000,
};

export function preamble(w = newWorld()) {
  const { A } = w;
  const ops = [];
  let t = T.attest;
  const devsOf = [
    [ME, D.me], [ME, D.meLaptop], [MAMA, D.mama], [PAPA, D.papa], [ZORRO, D.zorro],
  ];
  for (const [m, d] of devsOf) {
    const who = Object.values(A).find((a) => a.device.id === d.id);
    ops.push(who.op('member.set', memberKey(m), { [`dev.${d.short}`]: attestationBlob(m, d) },
      { space: FSP, ms: t }));
    t += 1000;
  }
  for (const [m, d] of [[ME, D.me], [MAMA, D.mama], [PAPA, D.papa], [ZORRO, D.zorro]]) {
    const who = Object.values(A).find((a) => a.device.id === d.id);
    ops.push(who.op('member.set', memberKey(m),
      { displayName: m.slice(4, 8), colorRef: 'p1', _alive: true }, { space: FSP, ms: t }));
    t += 1000;
  }

  // PAPA is the honest genesis admin.
  const genesis = A.papa.op('space.set', spaceKey(FSP),
    { admin: PAPA, adminPrev: null, name: 'Familie' }, { space: FSP, ms: T.genesis, id: id22('GENESIS') });
  ops.push(genesis);

  // ME's board: one note, published Geteilt with co-editing on.
  ops.push(A.me.op('note.set', noteKey(U1), {
    date: '2026-09-10', text: 'Zahnarzt', categoryId: 'cat-1', repeatsYearly: false,
    visibility: 'geteilt', coEdit: true, _alive: true,
  }, { space: PSP, ms: T.board, born: true }));
  ops.push(A.me.op('pub.set', familyKey('fnote', ME, U1), {
    'pub.level': 'geteilt', 'pub.coEdit': true, 'pub.alive': true,
    'pub.date': '2026-09-10', 'pub.text': 'Zahnarzt', 'pub.repeatsYearly': false,
  }, { space: FSP, ms: T.publish, born: true }));

  // PAPA's board: one entry published Geteilt, co-editing OFF. The thing an attacker wants gone.
  ops.push(A.papa.op('pub.set', familyKey('fnote', PAPA, U_PAPA), {
    'pub.level': 'geteilt', 'pub.coEdit': false, 'pub.alive': true,
    'pub.date': '2026-10-01', 'pub.text': 'Papas Termin', 'pub.repeatsYearly': false,
  }, { space: FSP, ms: T.publish + 500, born: true }));

  return { ...w, ops, genesis };
}

/** The ctx `foldAuthorized` is called with on MY device. */
export const authzCtx = (over = {}) => ({
  me: ME, nowMs: T.now, attestVerify, ...over,
});

/** A MaterializeCtx that trusts the FOLD for membership — what WP-3 will naturally wire. */
export const mctxFromFold = (r, over = {}) => ({
  me: ME,
  familySpaceId: FSP,
  members: new Map(MEMBERS.map((m) => [m, { displayName: m.slice(4, 8), colorRef: 'p1', initial: m[4] }])),
  currentMembers: r.currentMembers,
  hiddenMembers: new Set(),
  prefs: {},
  lastSeenSeq: {},
  ...over,
});

/** Deterministic shuffles, so "arrival order" is a real variable and not a vibe. */
export function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
export function shuffle(rnd, xs) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const reasonOf = (r, op) => (r.rejectionOf(op.id) || { reason: null }).reason;
export const wasAdmitted = (r, op) => r.admitted.some((x) => x.id === op.id);
export const noteById = (state, uuid) => state.notes.find((n) => n.id === uuid) || null;

/** A valid 22-char base64url id from a counter — for hand-driven undo stacks. */
export const oid22 = (n) => (`u${n}` + 'x'.repeat(22)).slice(0, 22);

