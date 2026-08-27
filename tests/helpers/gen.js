// tests/helpers/gen.js — the deterministic op-stream generator every property test draws from.
// LZP-406 · ADR 005 §1.7, §4.2 · ADR 001 §6.
//
// ZERO DEPENDENCIES. Two small PRNGs are written out below; there is no npm anything, and there
// is no wall clock — every millisecond in every stamp this file produces is computed from the
// seed (ADR 005 §5.5, "no test reads the wall clock").
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS THE IMPORTANT ONE
//
// ADR 005 §4.2: "**The generator matters more than the assertions.**" A property suite over
// uniformly random field writes proves that a map is a map. The convergence bugs this project
// can actually ship are all SHAPED — a delete racing an edit, a downgrade racing a co-edit, a
// category delete fanning out to fifteen notes while half the fan-out is still in flight. So
// this generator emits *scenarios*, not noise, and §4.2's list is a checklist it satisfies
// explicitly and asserts it satisfies (see `SCENARIOS` and `coverageOf`).
//
// Every op it produces is built through the REAL `makeOp`, so an op that `validateOp` would
// refuse cannot enter a property test and quietly pass it. A generator that emits junk the fold
// ignores is a generator that proves nothing.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { b64u, ub64, CROCKFORD_ALPHABET } from '../../src/js/core/b64.js';
import { canonicalBytes } from '../../src/js/core/canon.js';
import { fmt } from '../../src/js/core/stamp.js';
import {
  makeOp, validateOp, familyKey, memberKey, spaceKey, noteKey, barKey, catKey, padKey,
} from '../../src/js/core/ops.js';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. Randomness — seeded, portable, and reproducible from the printed seed alone
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * PCG-XSH-RR 32-bit, the generator this harness defaults to.
 *
 * Chosen over the mulberry32 already in the tier-1 files for one reason that matters at 500+
 * seeds: PCG's output function decorrelates *streams from nearby seeds*. Property seeds are
 * consecutive integers (0, 1, 2, …), and a weak generator hands consecutive seeds visibly
 * correlated first outputs — so seed 0 and seed 1 explore nearly the same op stream and the
 * suite's real coverage is a fraction of its seed count. `distinctFirstDraws` in the property
 * suite asserts this is not happening.
 *
 * 64-bit LCG state via BigInt: correctness over speed, and the cost is invisible next to folding
 * the op sets it generates.
 *
 * @param {number} seed @returns {() => number} uniform in [0, 1)
 */
export function pcg32(seed) {
  const MUL = 6364136223846793005n;
  const INC = 1442695040888963407n;
  const MASK = (1n << 64n) - 1n;
  let state = (BigInt(seed >>> 0) + INC) & MASK;
  const step = () => { state = (state * MUL + INC) & MASK; };
  step();
  return function next() {
    const old = state;
    step();
    const xorshifted = Number(((old >> 18n) ^ old) >> 27n & 0xffffffffn) >>> 0;
    const rot = Number(old >> 59n);
    const out = ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
    return out / 4294967296;
  };
}

/**
 * xorshift32 — kept because it is the cheapest possible second opinion. A property that holds
 * under PCG and fails under xorshift is a property that depends on the generator, which means
 * the property is wrong. `P1` runs a slice of its seeds through this one for exactly that reason.
 * @param {number} seed @returns {() => number}
 */
export function xorshift32(seed) {
  let x = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

/** @param {() => number} rnd @param {number} n @returns {number} 0 ≤ i < n */
export const int = (rnd, n) => Math.floor(rnd() * n) % (n || 1);
/** @param {() => number} rnd @param {any[]} xs */
export const pick = (rnd, xs) => xs[int(rnd, xs.length)];
/** @param {() => number} rnd @param {number} p */
export const chance = (rnd, p) => rnd() < p;

/** Fisher–Yates on a COPY. The input array is never mutated — property tests fold it again. */
export function shuffle(rnd, xs) {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = int(rnd, i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * Re-deliver a random sub-multiset. This is what a real pull does after a cursor reset, and it is
 * the whole of property P2.
 * @param {() => number} rnd @param {any[]} xs @param {number} rate fraction re-delivered
 */
export function duplicateSome(rnd, xs, rate = 0.15) {
  const out = xs.slice();
  for (const x of xs) {
    if (chance(rnd, rate)) out.splice(int(rnd, out.length + 1), 0, x);
  }
  return out;
}

/** Split into `n` disjoint batches — a partition, for P3 and P10. */
export function partition(rnd, xs, n = 3) {
  const buckets = Array.from({ length: n }, () => []);
  for (const x of xs) buckets[int(rnd, n)].push(x);
  return buckets;
}

/** Riffle two ordered streams, preserving each one's internal order — two peers gossiping. */
export function interleave(rnd, a, b) {
  const out = [];
  let i = 0; let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && chance(rnd, 0.5))) out.push(a[i++]);
    else out.push(b[j++]);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. The cast — members, devices, and the clock skew ADR 005 §4.2 demands
// ═════════════════════════════════════════════════════════════════════════════════════════════

const pad22 = (s) => (s + 'x'.repeat(22)).slice(0, 22);

/**
 * A DeviceShort is 16 CROCKFORD base32 characters, and Crockford deliberately omits I, L, O and U
 * (they are the digits 1, 1, 0 and V on a bad photocopy). A short built by upper-casing a device
 * name therefore fails `fmt` on the very first stamp — which is how this helper found out.
 * Non-alphabet characters are mapped rather than stripped, so two device names cannot collapse
 * onto one short and silently share a stamp namespace.
 */
const CROCK = CROCKFORD_ALPHABET;
export const short16 = (s) => {
  let out = '';
  for (const ch of s.toUpperCase()) out += CROCK.includes(ch) ? ch : CROCK[ch.charCodeAt(0) % 32];
  return (out + '0'.repeat(16)).slice(0, 16);
};

export const ME = `mem_${pad22('ME')}`;
export const MAMA = `mem_${pad22('MAMA')}`;
export const PAPA = `mem_${pad22('PAPA')}`;
export const MEMBERS = Object.freeze([ME, MAMA, PAPA]);

export const PSP = `psp_${pad22('PERSONAL')}`;
export const FSP = `fsp_${pad22('FAMILIE')}`;

/** A fixed wall-clock millisecond. NEVER `Date.now()`. 2026-08-25T00:00:00Z-ish. */
export const BASE_MS = 1787836800000;
export const HOUR = 3600000;

/**
 * The device roster, and the skews are the point.
 *
 * ADR 005 §4.2 requires "stamps from devices with ±10-minute clock skew plus one at +23 h
 * (parked-adjacent) and one at +25 h (parked)". The two extremes are not decoration:
 *
 *   +23 h  is INSIDE `MAX_FUTURE_DRIFT_MS`, so its ops are ADMITTED and dominate every register
 *          they touch for the next day. If convergence depended on stamps being roughly ordered
 *          by real time — it must not — this is the device that finds out.
 *   +25 h  is OUTSIDE it, so `classifyOp` PARKS its ops. A parked op is retained, never dropped,
 *          and must be able to enter the fold later (when the clock catches up) and produce the
 *          same state as if it had arrived on time. That is what makes parking safe, and it is
 *          only testable if something generates parked ops.
 */
export const DEVICES = Object.freeze([
  { name: 'me-desktop', member: ME, skew: 0 },
  { name: 'me-laptop', member: ME, skew: -600000 },        // −10 min
  { name: 'mama-mac', member: MAMA, skew: +600000 },       // +10 min
  { name: 'papa-mac', member: PAPA, skew: +23 * HOUR },    // parked-adjacent: ADMITTED
  { name: 'papa-old', member: PAPA, skew: +25 * HOUR },    // beyond the drift clamp: PARKED
].map((d) => Object.freeze({ ...d, id: `dev_${pad22(d.name.replace(/-/g, ''))}`, short: short16(d.name) })));

const utf8 = (s) => new TextEncoder().encode(s);
const utf8Decode = (b) => new TextDecoder().decode(b);

/**
 * The `dev.*` register value ADR 002 §2.3 fixes: `b64u(canonicalJSON(att)) + '.' + b64u(sig)`.
 * The signature is a byte string the paired `attestVerify` below can check without WebCrypto —
 * property tests are about the BINDING (does the payload name this member and this device?), not
 * about the primitive, which is WP-6's and has its own P11.
 */
export function attestationBlob(member, dev) {
  const att = {
    memberId: member,
    deviceId: dev.id,
    deviceShort: dev.short,
    sigPubRaw: b64u(utf8(`sigpub:${dev.id}`)),
    kexPubRaw: b64u(utf8(`kexpub:${dev.id}`)),
    createdAt: '2026-08-25',
  };
  return `${b64u(canonicalBytes(att))}.${b64u(utf8(`sig:${member}:${dev.id}`))}`;
}

/** Stands in for `crypto/identity.js:verifyAttestation`. Fails closed on anything malformed. */
export function attestVerify(memberId, blob) {
  if (typeof blob !== 'string') return false;
  const dot = blob.indexOf('.');
  if (dot < 0) return false;
  try {
    const att = JSON.parse(utf8Decode(ub64(blob.slice(0, dot))));
    const sig = utf8Decode(ub64(blob.slice(dot + 1)));
    return att.memberId === memberId && sig === `sig:${att.memberId}:${att.deviceId}`;
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. Op minting — deterministic ids, deterministic stamps, real validation
// ═════════════════════════════════════════════════════════════════════════════════════════════

const UUIDS = Object.freeze(Array.from({ length: 12 }, (_, i) => {
  const h = i.toString(16);
  return `${h.repeat(8)}-${h.repeat(4)}-4${h.repeat(3)}-8${h.repeat(3)}-${h.repeat(12)}`;
}));

const CAT_UUIDS = UUIDS.slice(0, 4);
const NOTE_UUIDS = UUIDS.slice(4, 9);
const BAR_UUIDS = UUIDS.slice(9, 12);

/** Dates chosen so the two calendar edge cases ADR 005 §4.2 names are always in range. */
const DATES = Object.freeze([
  '2024-02-29',   // the leap day — with repeatsYearly this is the Feb-29 series
  '2026-02-28',   // …and where it re-anchors in a non-leap year
  '2026-01-31',   // month-roll boundary
  '2026-02-01',
  '2026-03-31',
  '2026-04-01',
  '2026-12-24',
  '2027-01-01',   // year roll
]);

const TEXTS = Object.freeze(['Zahnarzt', 'Elternabend', 'Yoga', 'Steuer', 'Bescherung', 'Impfung']);
const LABELS = Object.freeze(['Projekt Nord', 'Sprint', 'Urlaub', 'Messe']);
const NAMES = Object.freeze(['Familie', 'Arbeit', 'Sport', 'Schule', 'Termine']);
const LEVELS = Object.freeze(['privat', 'belegt', 'geteilt']);

/**
 * One authoring context per device. `mint()` walks a per-device counter so every stamp is a pure
 * function of (device, call index, the wall ms the scenario asked for) — no clock, no randomness
 * that is not the seed.
 */
function author(dev, ctx) {
  let n = 0;
  let ms = BASE_MS;
  const st = { ctr: 0, lastMs: -1 };
  return {
    dev,
    member: dev.member,
    /** Move this device's notion of "now" to `t` (before skew). */
    at(t) { ms = t; return this; },
    advance(d) { ms += d; return this; },
    stamp() {
      const at = ms + dev.skew;
      if (at === st.lastMs) st.ctr += 1; else { st.ctr = 0; st.lastMs = at; }
      return fmt(at, st.ctr, dev.short);
    },
    op(kind, entity, f, opts = {}) {
      const c = {
        act: opts.act ?? dev.member,
        dev: dev.id,
        gid: opts.gid ?? pad22(`g${ctx.gid++}`),
        space: opts.space,
        familySpaceId: FSP,
        mint: () => this.stamp(),
        newOpId: () => pad22(`${dev.short.slice(0, 3)}${++n}_${ctx.opn++}`),
      };
      return makeOp(c, kind, entity, f, opts);
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. The scenarios — ADR 005 §4.2's checklist, one emitter each
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every scenario name §4.2 requires. `generate()` records which ones it actually emitted, and
 * `tests/property/generator.test.js` asserts the union over a seed range is the WHOLE list — so
 * "the generator quietly stopped producing deletes" is a test failure and not a silent loss of
 * coverage six months from now.
 */
export const SCENARIOS = Object.freeze([
  'concurrentSameField',
  'deleteRacesEdit',
  'resurrectAfterDelete',
  'visibilityRacesCoEdit',
  'categoryDeleteFanOut',
  'concurrentCategoryRename',
  'feb29Repeat',
  'monthRoll',
  'clockSkew',
  'parkedFuture',
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. generate() — one seed → one realistic multi-device session
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} GeneratedWorld
 * @property {Object[]} ops        the whole op SET, in one arbitrary but deterministic order
 * @property {Object[]} setupOps   attestations, member records, genesis — the authz preamble
 * @property {Object} authzCtx     ready for `foldAuthorized`
 * @property {Object} mctx         ready for `materialize`
 * @property {Set<string>} scenarios which of SCENARIOS this seed actually produced
 * @property {number} seed
 */

/**
 * Build one world.
 *
 * The op stream is deliberately NOT emitted in stamp order: devices author against their own
 * skewed clocks and the caller receives them grouped by scenario. Property tests then shuffle,
 * duplicate and partition it. If this function emitted a tidy chronological list, every shuffle
 * would be testing the same easy case.
 *
 * @param {number} seed
 * @param {{ rng?: (s:number) => (() => number), ops?: number, members?: string[] }} [opts]
 * @returns {GeneratedWorld}
 */
export function generate(seed, opts = {}) {
  const rnd = (opts.rng ?? pcg32)(seed);
  const ctx = { gid: 0, opn: 0 };
  const A = Object.fromEntries(DEVICES.map((d) => [d.name, author(d, ctx)]));
  const devs = DEVICES.map((d) => A[d.name]);
  const scenarios = new Set();
  const setupOps = [];
  const ops = [];

  // ── the authz preamble ─────────────────────────────────────────────────────────────────────
  // Without attestations and a genesis, `foldAuthorized` rejects every family op and the family
  // half of the stream would be silently inert — a property suite that proves nothing about the
  // thing it was written for.
  let t = BASE_MS;
  for (const m of MEMBERS) {
    for (const d of DEVICES.filter((x) => x.member === m)) {
      setupOps.push(A[d.name].at(t).op('member.set', memberKey(m),
        { [`dev.${d.short}`]: attestationBlob(m, d) }, { space: FSP }));
      t += 1000;
    }
    const own = DEVICES.find((x) => x.member === m);
    setupOps.push(A[own.name].at(t).op('member.set', memberKey(m),
      { displayName: m.slice(4, 8), colorRef: 'p1', _alive: true }, { space: FSP }));
    t += 1000;
  }
  // ME is the genesis admin (`adminPrev: null`, `act === admin`, ADR 001 §4.1).
  setupOps.push(A['me-desktop'].at(t).op('space.set', spaceKey(FSP),
    { admin: ME, adminPrev: null, name: 'Familie' }, { space: FSP }));
  t += 1000;

  // ── the board ME starts from ───────────────────────────────────────────────────────────────
  let clock = t;
  const tick = (d = 250) => { clock += d; for (const a of devs) a.at(clock); return clock; };

  const desktop = A['me-desktop'];
  const laptop = A['me-laptop'];
  const mama = A['mama-mac'];
  const papa = A['papa-mac'];
  const papaOld = A['papa-old'];

  const liveCats = CAT_UUIDS.slice();
  for (const c of CAT_UUIDS) {
    tick();
    ops.push(desktop.op('cat.set', catKey(c), {
      name: NAMES[CAT_UUIDS.indexOf(c) % NAMES.length], paletteRef: `p${CAT_UUIDS.indexOf(c)}`,
      visible: true, _alive: true,
    }, { space: PSP, born: true }));
  }

  const noteState = new Map();
  for (const u of NOTE_UUIDS) {
    tick();
    const date = pick(rnd, DATES);
    const f = {
      date,
      text: pick(rnd, TEXTS),
      categoryId: pick(rnd, liveCats),
      repeatsYearly: date === '2024-02-29' ? true : chance(rnd, 0.3),
      visibility: 'privat',
      coEdit: false,
      _alive: true,
    };
    if (date === '2024-02-29' && f.repeatsYearly) scenarios.add('feb29Repeat');
    if (/-(01|03|05|07|08|10|12)-31$|-0[1-9]-01$/.test(date)) scenarios.add('monthRoll');
    noteState.set(u, f);
    ops.push(desktop.op('note.set', noteKey(u), f, { space: PSP, born: true }));
  }

  for (const u of BAR_UUIDS) {
    tick();
    ops.push(desktop.op('bar.set', barKey(u), {
      startDate: '2026-02-10', endDate: '2026-04-20', label: pick(rnd, LABELS),
      categoryId: pick(rnd, liveCats), visibility: 'privat', coEdit: false, _alive: true,
    }, { space: PSP, born: true }));
  }

  tick();
  ops.push(desktop.op('pad.set', padKey('2026-03'), { text: 'Milch\nBrot', _alive: true },
    { space: PSP, born: true }));
  tick();
  ops.push(desktop.op('pref.set', 'pref:app', { mode: 'pinned', startMonth: '2026-01', pageYears: 0 },
    { space: 'local' }));

  // ── scenario 1: two of MY devices edit the SAME field at the same wall millisecond ──────────
  // The stamps differ only in `deviceShort`, so the winner is decided by the last third of the
  // stamp — the exact place a comparator bug hides.
  {
    const u = pick(rnd, NOTE_UUIDS);
    const at = tick(1000);
    desktop.at(at); laptop.at(at);
    ops.push(desktop.op('note.set', noteKey(u), { text: 'vom Desktop' }, { space: PSP }));
    ops.push(laptop.op('note.set', noteKey(u), { text: 'vom Laptop' }, { space: PSP }));
    scenarios.add('concurrentSameField');
    scenarios.add('clockSkew');
  }

  // ── scenario 2: a delete racing an edit, then scenario 3: the resurrect ────────────────────
  // ADR 001 §6: a tombstone RETAINS its content registers, so the resurrect must bring back the
  // NEWEST text — including one written after the delete. That is story 18.6 and it only works
  // because there is no delete op at the merge layer.
  {
    const u = pick(rnd, NOTE_UUIDS);
    const at = tick(1000);
    desktop.at(at); laptop.at(at + 1);
    ops.push(desktop.op('note.set', noteKey(u), { _alive: false }, { space: PSP }));
    ops.push(laptop.op('note.set', noteKey(u), { text: 'nach dem Löschen' }, { space: PSP }));
    scenarios.add('deleteRacesEdit');
    if (chance(rnd, 0.7)) {
      const back = tick(1000);
      ops.push(desktop.at(back).op('note.set', noteKey(u), { _alive: true }, { space: PSP }));
      scenarios.add('resurrectAfterDelete');
    }
  }

  // ── scenario 4: a category delete with its fan-out, and half of it in flight ───────────────
  // `legend.js:197` reassigns every entry of a deleted category in ONE group. A property test
  // that delivers the tombstone but not the reassignments is the realistic partial-delivery
  // case, and materialization step 7's reference repair is what has to catch the orphans.
  if (liveCats.length > 1 && chance(rnd, 0.8)) {
    const dead = liveCats.pop();
    const into = liveCats[0];
    const at = tick(1000);
    const gid = pad22(`gfan${ctx.gid++}`);
    ops.push(desktop.at(at).op('cat.set', catKey(dead), { _alive: false }, { space: PSP, gid }));
    for (const [u, f] of noteState) {
      if (f.categoryId !== dead) continue;
      ops.push(desktop.op('note.set', noteKey(u), { categoryId: into }, { space: PSP, gid }));
      f.categoryId = into;
    }
    scenarios.add('categoryDeleteFanOut');
  }

  // ── scenario 5: two of my devices rename the same category concurrently ────────────────────
  {
    const c = pick(rnd, liveCats);
    const at = tick(1000);
    desktop.at(at); laptop.at(at);
    ops.push(desktop.op('cat.set', catKey(c), { name: 'Umbenannt A' }, { space: PSP }));
    ops.push(laptop.op('cat.set', catKey(c), { name: 'Umbenannt B' }, { space: PSP }));
    scenarios.add('concurrentCategoryRename');
  }

  // ── scenario 6: publish, co-edit, and a visibility flip racing the co-edit ─────────────────
  // The one that produces the interesting register maps: `pub.level` and `pub.text` written by
  // DIFFERENT members at nearly the same stamp, with the promotion asymmetry in the middle.
  {
    const u = pick(rnd, NOTE_UUIDS);
    const fk = familyKey('fnote', ME, u);
    const truth = noteState.get(u);
    let at = tick(1000);
    const gid = pad22(`gsh${ctx.gid++}`);
    ops.push(desktop.at(at).op('note.set', noteKey(u),
      { visibility: 'geteilt', coEdit: true }, { space: PSP, gid }));
    ops.push(desktop.op('pub.set', fk, {
      'pub.level': 'geteilt', 'pub.alive': true, 'pub.coEdit': true,
      'pub.date': truth.date, 'pub.text': truth.text, 'pub.repeatsYearly': !!truth.repeatsYearly,
    }, { space: FSP, gid, born: true }));

    at = tick(1000);
    // Mama co-edits (admissible: `pub.coEdit === true`), sometimes clearing the field outright —
    // `null` is a first-class value and R9 says the clear must land.
    mama.at(at);
    ops.push(mama.op('pub.set', fk,
      chance(rnd, 0.25) ? { 'pub.text': null } : { 'pub.text': 'von Mama' }, { space: FSP }));
    // …while I downgrade to Belegt at very nearly the same moment. ADR 004 §5: the downgrade
    // writes an EXPLICIT null, and the promotion asymmetry must keep MY note readable to ME.
    desktop.at(at + (chance(rnd, 0.5) ? -1 : 1));
    const gid2 = pad22(`gdn${ctx.gid++}`);
    ops.push(desktop.op('note.set', noteKey(u), { visibility: 'belegt' }, { space: PSP, gid: gid2 }));
    ops.push(desktop.op('pub.set', fk,
      { 'pub.level': 'belegt', 'pub.text': null, 'pub.coEdit': null }, { space: FSP, gid: gid2 }));
    scenarios.add('visibilityRacesCoEdit');
  }

  // ── scenario 7: the peers' OWN entries, including one from the +23 h device ────────────────
  for (const [who, dev] of [[MAMA, mama], [PAPA, papa]]) {
    const u = UUIDS[(int(rnd, 3) + 1) % UUIDS.length];
    const fk = familyKey('fnote', who, u);
    tick(1000);
    ops.push(dev.op('pub.set', fk, {
      'pub.level': pick(rnd, LEVELS.slice(1)),   // belegt | geteilt — privat would not be sent
      'pub.alive': true,
      'pub.date': pick(rnd, DATES),
      'pub.text': pick(rnd, TEXTS),
      'pub.coEdit': chance(rnd, 0.4),
    }, { space: FSP, born: true }));
  }
  scenarios.add('clockSkew');

  // ── scenario 8: the +25 h device — its ops MUST park, never be dropped ─────────────────────
  {
    const u = UUIDS[5];
    tick(1000);
    ops.push(papaOld.op('pub.set', familyKey('fnote', PAPA, u), {
      'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2027-01-01', 'pub.text': 'aus der Zukunft',
    }, { space: FSP, born: true }));
    scenarios.add('parkedFuture');
  }

  // ── a tail of ordinary edits, so the shaped scenarios are not the whole set ────────────────
  const n = opts.ops ?? (12 + int(rnd, 18));
  for (let i = 0; i < n; i++) {
    tick(200 + int(rnd, 800));
    const who = pick(rnd, [desktop, laptop, desktop]);   // my own devices dominate, as in life
    const roll = rnd();
    if (roll < 0.45) {
      const u = pick(rnd, NOTE_UUIDS);
      const patch = pick(rnd, [
        { text: pick(rnd, TEXTS) },
        { date: pick(rnd, DATES) },
        { categoryId: pick(rnd, liveCats) },
        { repeatsYearly: chance(rnd, 0.5) },
      ]);
      ops.push(who.op('note.set', noteKey(u), patch, { space: PSP }));
    } else if (roll < 0.7) {
      const u = pick(rnd, BAR_UUIDS);
      const patch = pick(rnd, [
        { label: pick(rnd, LABELS) },
        { startDate: '2026-02-10', endDate: pick(rnd, ['2026-03-01', '2026-04-20', '2026-02-28']) },
        { categoryId: pick(rnd, liveCats) },
      ]);
      ops.push(who.op('bar.set', barKey(u), patch, { space: PSP }));
    } else if (roll < 0.82) {
      ops.push(who.op('cat.set', catKey(pick(rnd, liveCats)),
        pick(rnd, [{ visible: chance(rnd, 0.5) }, { name: pick(rnd, NAMES) }]), { space: PSP }));
    } else if (roll < 0.9) {
      ops.push(who.op('pad.set', padKey(pick(rnd, ['2026-01', '2026-03', '2026-12'])),
        { text: `Notiz ${i}`, _alive: true }, { space: PSP, born: true }));
    } else {
      ops.push(who.op('pref.set', 'pref:app',
        pick(rnd, [{ 'layers.feiertage': chance(rnd, 0.5) }, { pageYears: int(rnd, 3) }]),
        { space: 'local' }));
    }
  }

  const all = setupOps.concat(ops);
  for (const op of all) {
    const v = validateOp(op);
    if (!v.ok) throw new Error(`gen.js emitted an invalid op (${op.k} ${op.e}): ${v.reason}`);
  }

  return {
    seed,
    ops: all,
    setupOps,
    contentOps: ops,
    scenarios,
    authzCtx: { me: ME, nowMs: clock, attestVerify },
    mctx: {
      me: ME,
      familySpaceId: FSP,
      members: new Map(MEMBERS.map((m) => [m, { displayName: m.slice(4, 8), colorRef: 'p1', initial: m[4] }])),
      currentMembers: new Set(MEMBERS),
      hiddenMembers: new Set(),
      prefs: {},
      lastSeenSeq: {},
    },
  };
}

/** The union of scenarios a seed range produces — the generator's own coverage report. */
export function coverageOf(seeds, opts) {
  const seen = new Set();
  for (const s of seeds) for (const x of generate(s, opts).scenarios) seen.add(x);
  return seen;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6. Shrinking — delta debugging over the op array (ADR 005 §4.2, "about 30 lines, no library")
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Given a failing op set and a predicate that is TRUE when the bug still reproduces, remove ops
 * one at a time until nothing more can go. Greedy and O(n²) in the worst case, which is fine:
 * it runs only on a failure, and a 40-op counterexample nobody can read is a failure that gets
 * ignored.
 *
 * The setup preamble is pinned: dropping an attestation makes every family op inadmissible and
 * would "reproduce" the failure for entirely the wrong reason. Shrinking that lies is worse than
 * not shrinking.
 *
 * @param {Object[]} ops @param {(ops:Object[]) => boolean} stillFails
 * @param {{ keep?: (op:Object) => boolean }} [o]
 * @returns {Object[]} a locally minimal failing set
 */
export function shrink(ops, stillFails, o = {}) {
  const keep = o.keep ?? (() => false);
  let best = ops.slice();
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < best.length; i++) {
      if (keep(best[i])) continue;
      const candidate = best.slice(0, i).concat(best.slice(i + 1));
      if (candidate.length && stillFails(candidate)) { best = candidate; progress = true; break; }
    }
  }
  return best;
}

/** A one-line, replayable description of a counterexample — printed on every property failure. */
export function describe(ops) {
  return ops.map((op) => `${op.ts} ${op.act.slice(4, 8)} ${op.k} ${op.e} ${JSON.stringify(op.f)}`)
    .join('\n');
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7. v1 board generation — the corpus P8 (migration losslessness, risk R12) draws from
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A deterministic v1 `board.json`, shaped like one a real user would have.
 *
 * Ids are chosen so that **uuid order is not insertion order** — `n-9`, `n-8`, `n-7`… — because
 * that difference is the entire justification for putting the array index inside the GENESIS
 * stamp (ADR 001 §8.1). A corpus whose ids happen to sort the way the array does would pass P8
 * with a constant genesis and prove nothing about R12.
 *
 * @param {number} seed @param {{ defaults: Object }} o v1's `defaultState()`, injected so this
 *        helper stays free of a `store.js` import and the caller keeps one source of truth
 */
export function generateBoard(seed, o) {
  const rnd = pcg32(seed ^ 0x5eed);
  const d = o.defaults;
  const cats = d.categories.map((c, i) => ({ ...c, id: `cat-${i + 1}` }));
  const live = cats.map((c) => c.id);

  const nNotes = 3 + int(rnd, 8);
  const notes = [];
  for (let i = 0; i < nNotes; i++) {
    const date = pick(rnd, DATES);
    notes.push({
      id: `n-${20 - i}`,                                  // descending: uuid order ≠ array order
      date,
      text: `${pick(rnd, TEXTS)} ${i}`,
      categoryId: pick(rnd, live),
      repeatsYearly: date === '2024-02-29' ? true : chance(rnd, 0.25),
    });
  }

  const nBars = 1 + int(rnd, 5);
  const bars = [];
  for (let i = 0; i < nBars; i++) {
    const start = pick(rnd, ['2026-02-10', '2026-01-31', '2026-03-31', '2026-06-01']);
    bars.push({
      id: `b-${20 - i}`,
      startDate: start,
      endDate: pick(rnd, ['2026-02-28', '2026-04-20', '2026-06-14', '2027-01-01']),
      label: `${pick(rnd, LABELS)} ${i}`,
      categoryId: pick(rnd, live),
    });
  }

  const scratchpads = {};
  for (const m of ['2026-01', '2026-03', '2026-12']) {
    if (chance(rnd, 0.6)) scratchpads[m] = `Zettel ${m}\n${pick(rnd, TEXTS)}`;
  }

  return {
    schemaVersion: 1,
    notes,
    bars,
    categories: cats,
    scratchpads,
    settings: {
      ...d.settings,
      mode: 'pinned',
      startMonth: '2026-01',
      pageYears: int(rnd, 3),
      lastCategoryId: live[0],
      layers: { ...d.settings.layers, feiertage: chance(rnd, 0.5) },
    },
  };
}

/**
 * The UGLY corpus — every v1 board shape the fix pass closed, generated on purpose.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AS A SECOND GENERATOR RATHER THAN A WIDER `generateBoard`
 *
 * REG-32 recorded the hole precisely: `generateBoard` is sanitised of exactly the inputs that
 * were being fixed — no duplicate id, no empty category list, no null setting, no non-string
 * text, nothing over 80 characters, no unknown key — so "losslessness over 500 seeds" (P8) was a
 * statement about a corpus that could not reach a single one of the repaired paths.
 *
 * The tempting fix is to make `generateBoard` uglier, and it is wrong. P8 asserts
 * `materialize(fold(migrateV1(b))) deepEqual b`, which is FALSE by construction for a board that
 * cannot be represented without loss: a truncated note is not the note that went in. Widening
 * that corpus turns P8 red instead of exercising the new code, and the reflex fix — relaxing
 * P8's assertion — would destroy the one property in the suite that says migration loses nothing.
 *
 * So: two corpora and two properties. `generateBoard` stays the REPRESENTABLE corpus and P8 keeps
 * asserting exact losslessness over it. This one is the NON-REPRESENTABLE corpus, and the
 * properties over it assert the things that must hold when a board CANNOT be carried intact:
 * every loss is reported, no entry disappears in silence, and both doors do the same thing.
 *
 * Every shape below is generated INDEPENDENTLY, at a rate that puts each one in a healthy
 * fraction of the seeds without any seed being nothing but damage — a corpus of all-broken boards
 * exercises the error paths and never the interaction between a broken field and a good one.
 * `uglyShapesIn` reports what a given board actually got, and the property suite asserts the
 * observed frequency of every shape is non-zero, so a future edit that quietly sanitises this
 * generator fails the suite instead of silently shrinking it back to `generateBoard`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * @param {number} seed @param {{ defaults: Object }} o v1's `defaultState()`
 * @returns {Object} a v1 board that a real hand-edited / third-party / pre-maxLength file could be
 */
export function generateUglyBoard(seed, o) {
  const b = generateBoard(seed, o);
  const rnd = pcg32((seed ^ 0x1eaf) >>> 0);

  // ── 1. OVER-LENGTH text and label ───────────────────────────────────────────────────────────
  // v1's 80 (note) and 40 (bar) are DOM `maxLength` attributes (`interact.js:466`,
  // `popover.js:146`) and never applied to a file. A board written before the attribute existed,
  // hand-edited, or produced by any other tool legitimately holds this — and it is the shape that
  // used to make an imported note VANISH (ATT-82 / RECHECK-82-1).
  for (const n of b.notes) {
    if (chance(rnd, 0.20)) n.text = `${n.text} ${'ß'.repeat(60 + int(rnd, 200))}`;
    // Emoji specifically: the cut must land on a character, never through a surrogate pair.
    else if (chance(rnd, 0.06)) n.text = '\u{1F600}'.repeat(45 + int(rnd, 30));
  }
  for (const x of b.bars) {
    if (chance(rnd, 0.20)) x.label = `${x.label} ${'y'.repeat(30 + int(rnd, 120))}`;
  }

  // ── 2. NON-STRING text ──────────────────────────────────────────────────────────────────────
  // A hand-edited file, or a tool that wrote a number. `null` matters most: it is what an
  // "empty" field looks like after a round-trip through several tools, and the presence rule
  // (`entities.js:renderable`) treats `null` as ABSENT while `''` is present and renders.
  const NOT_STRINGS = [null, 42, true, { text: 'nested' }, ['a']];
  for (const n of b.notes) {
    if (chance(rnd, 0.12)) n.text = pick(rnd, NOT_STRINGS);
  }
  for (const x of b.bars) {
    if (chance(rnd, 0.08)) x.label = pick(rnd, NOT_STRINGS);
  }

  // ── 3. DUPLICATE ids ────────────────────────────────────────────────────────────────────────
  // v1 tolerates two entries sharing an id and RENDERS BOTH; v2 cannot, because one entity key is
  // one register set. Both doors must re-key rather than drop (REG-22 / ATT-90).
  if (b.notes.length > 1 && chance(rnd, 0.25)) {
    b.notes[int(rnd, b.notes.length)].id = b.notes[0].id;
  }
  if (b.bars.length > 1 && chance(rnd, 0.18)) {
    b.bars[int(rnd, b.bars.length)].id = b.bars[0].id;
  }
  if (chance(rnd, 0.10)) b.categories[1 + int(rnd, b.categories.length - 1)].id = b.categories[0].id;

  // ── 4. EMPTY category list ──────────────────────────────────────────────────────────────────
  // v1's `migrate()` substitutes four defaults (`store.js:74`) and every other v1 site is written
  // as if that already happened — `store.category()` never returns undefined. A board that
  // reaches the UI with no categories is one v1 THROWS on (REG-21 / ATT-15 / ATT-41).
  if (chance(rnd, 0.10)) {
    b.categories = [];
    // …which leaves every categoryId dangling, which is the other half of the shape.
  } else if (chance(rnd, 0.08)) {
    for (const n of b.notes) if (chance(rnd, 0.5)) n.categoryId = 'cat-does-not-exist';
  }

  // ── 5. NULL settings ────────────────────────────────────────────────────────────────────────
  // The REG-8 shape. v1 reads a null pref as `!!null` at its consuming call site, i.e. OFF for a
  // boolean, and reverts to the default for everything else — so a cleared pref and a null pref
  // are DIFFERENT BOARDS for exactly the prefs whose default is `true`.
  const NULLABLE = ['rowHeight', 'colWidth', 'paper', 'pageYears', 'language', 'bundesland',
    'lastCategoryId', 'menuBarIcon'];
  for (const key of NULLABLE) {
    if (key in b.settings && chance(rnd, 0.09)) b.settings[key] = null;
  }
  if (chance(rnd, 0.09)) b.settings.layers = { ...b.settings.layers, feiertage: null };
  if (chance(rnd, 0.05)) b.settings.layers = null;
  // `startMonth` is generated null on purpose but rarely: it is the ONE pref whose absence makes
  // the board unrenderable rather than merely different (REG-9 — `layout.js` cannot compute a
  // visible year and `holidays.js:51` spins forever). A corpus that never produced it would not
  // exercise the hang guard at all; a corpus that produced it often would be a corpus of boards
  // that cannot be opened.
  if (chance(rnd, 0.04)) b.settings.startMonth = null;

  // ── 6. UNKNOWN keys ─────────────────────────────────────────────────────────────────────────
  // v1 copies the arrays wholesale (`store.js:69-76`) and the export writes back whatever the
  // state carries, so an unknown key really does survive a v1 round trip — which is why dropping
  // one is a LOSS and has to be reported on both doors (RECHECK-82-6).
  if (chance(rnd, 0.15)) b.holidays = { '2026-12-25': 'Weihnachten' };
  if (chance(rnd, 0.10)) b.customLayers = [{ name: 'Urlaub', color: '#abc' }];
  for (const n of b.notes) if (chance(rnd, 0.10)) n.priority = int(rnd, 5);
  for (const x of b.bars) if (chance(rnd, 0.08)) x.icon = 'star';

  // ── 6b. AN ENTRY THAT CANNOT BE DRAWN AT ALL ────────────────────────────────────────────────
  // A DATE that names no single day is the one incompleteness neither door may repair:
  // `truncateToFit` refuses dates on purpose, because the longest accepted prefix of a mistyped
  // date is a plausible date the user never wrote. So the entry keeps its date-less self, and it
  // is TOLD — on both doors, before the file that held it stops being the board.
  //
  // A3-H2 changed what happens next and this generator with it: the ENTRY is no longer dropped
  // (`entities.js:renderableNote` keeps an own note in the array the way v1's `state.notes` did),
  // and a date that DOES name one day is read rather than discarded — see `ODD_DATES` below.
  //
  // Generated because nothing else in this corpus reaches that path: after the REG-5/REG-6
  // coercion a note's `text` is always present, so `renderable()` only ever fails on a date.
  for (const n of b.notes) {
    if (chance(rnd, 0.05)) delete n.date;
    else if (chance(rnd, 0.04)) n.date = '2026-01-01T09:00';
  }
  for (const x of b.bars) {
    if (chance(rnd, 0.05)) delete x.endDate;
  }

  // ── 6c. A3-H2 — THE VALUE CLASSES BOTH DOORS NOW COERCE ─────────────────────────────────────
  //
  // Five entry shapes v1 opened, kept and wrote back were dropped by v2's type table, and in solo
  // mode `board.json` IS the checkpoint, so the drop was committed to the user's file on the
  // first autosave. Every class below is one of them, generated so that P13 (the two doors build
  // the same board) and P15 (nothing is lost in silence) are asserted over the COERCIONS and not
  // only over the drops they replaced. A coercion that exists on one door and not the other is
  // the two-doors defect class in its purest form, and this is what makes P13 able to see it.
  //
  // Each shape is independent and none is common: a corpus where most dates are German exercises
  // the parser and never the parser next to a good date.

  // A date v1 kept in the file and never drew. Half of these name exactly one day (so both doors
  // must READ them, identically) and half name none (so both doors must keep the ENTRY and drop
  // only the field).
  const ODD_DATES = ['4.3.2026', '2026-3-1', '2026/03/04', 20260304, '3/4/2026', '2026-13-45', ''];
  for (const n of b.notes) {
    if (typeof n.date === 'string' && n.date.length && chance(rnd, 0.10)) n.date = pick(rnd, ODD_DATES);
  }
  for (const x of b.bars) {
    if (chance(rnd, 0.06)) x.startDate = pick(rnd, ODD_DATES);
  }

  // R5-11 — A BAR EDGE THAT SORTS OUTSIDE THE DATE ALPHABET, ON BOTH SIDES OF THE BOUNDARY.
  //
  // `layout.js:133` never parses a bar edge, it COMPARES it — `if (b.endDate < mFirst ||
  // b.startDate > mLast) continue;` — so for a bar edge (and for nothing else) the STRING ORDER
  // of an unreadable value is the whole of its rendering. Three values, three different bars:
  //
  //   · absent      `undefined < '2026-03-01'` is false (NaN) ⇒ runs to the horizon
  //   · `''`        `'' < '2026-03-01'` is true              ⇒ skipped in EVERY column
  //   · `'zzz'`     above the range                          ⇒ as an endDate, the horizon again;
  //                                                            as a startDate, skipped everywhere
  //
  // The corpus was ONE-SIDED, and that is why the class survived four rounds: `ODD_DATES` puts
  // `''` on a `startDate` (below, where below is the harmless half) and nothing anywhere above.
  // Both sides of the boundary are generated here, on both edges, so P13 and P15 see the class
  // and `uglyShapesIn` can report each side separately. The boundary character is `'2'` for a
  // board in the 2000s; in general it is `entities.js`'s `EARLIEST_DATE` / `LATEST_DATE`, and the
  // values below straddle those and not the digit.
  const EDGE_BELOW = ['', ' ', '-', '(offen)', '0', ' 2026-03-04', '!', '1.3'];
  const EDGE_ABOVE = ['zzz', 'unbekannt', 'irgendwann', 'ab wann?', '~', 'offen?'];
  for (const x of b.bars) {
    if (chance(rnd, 0.09)) x.endDate = pick(rnd, EDGE_BELOW);
    else if (chance(rnd, 0.09)) x.endDate = pick(rnd, EDGE_ABOVE);
    if (chance(rnd, 0.08)) x.startDate = pick(rnd, EDGE_ABOVE);
    else if (chance(rnd, 0.06)) x.startDate = pick(rnd, EDGE_BELOW);
  }

  // The two carried BOOLEANS, which v1 does not read alike: `repeatsYearly` is plain truthiness
  // (`layout.js:71`) and `visible` is `!== false` (`layout.js:111`), so `0` is a category v1
  // SHOWS and a note v1 does not repeat. `Boolean(v)` gets one of them wrong, which is why the
  // corpus generates the disagreeing values and not only `'yes'`.
  const TRUTHY = ['yes', 'ja', 'nein', 'true', 1, {}, 0, ''];
  for (const n of b.notes) {
    if (chance(rnd, 0.12)) n.repeatsYearly = pick(rnd, TRUTHY);
  }
  for (const c of b.categories) {
    if (chance(rnd, 0.08)) c.visible = pick(rnd, TRUTHY);
  }

  // An id v2 cannot use. `7` NAMES an id and is carried as `'7'` — together with the
  // `categoryId`s pointing at it, which is what keeps the entries in their category; the rest are
  // minted a derived id. v1 keeps and paints all of them.
  // JSON-able only: a `board.json` is parsed JSON, and the property harness clones every board
  // with `structuredClone`, which refuses a function. An id carrying a `toString` belongs in a
  // hand-written attack row (`upgrade-day-migration.test.js`), not in this corpus.
  const BAD_IDS = [7, '', null, true, { nested: 'id' }, ['n1']];
  for (const n of b.notes) {
    if (chance(rnd, 0.06)) n.id = pick(rnd, BAD_IDS);
    else if (chance(rnd, 0.04)) delete n.id;
  }
  for (const x of b.bars) {
    if (chance(rnd, 0.05)) delete x.id;
  }
  if (b.categories.length && chance(rnd, 0.05)) {
    const c = b.categories[int(rnd, b.categories.length)];
    const numeric = 1 + int(rnd, 9);
    for (const e of [...b.notes, ...b.bars]) if (e.categoryId === c.id) e.categoryId = numeric;
    c.id = numeric;
  }

  // A bar with NO usable date at either end — the one entry no door can anchor, and therefore
  // the one that tests "quarantine the field, never the entry" with nothing to fall back on.
  // v1 keeps it and paints it as a stripe down every column.
  if (b.bars.length && chance(rnd, 0.05)) {
    const x = b.bars[int(rnd, b.bars.length)];
    delete x.startDate;
    delete x.endDate;
  }

  // A repeat with no anchor: the ONE shape v1 cannot draw at all (`layout.js:72` throws on
  // `n.date.slice`), so both doors must turn the flag off rather than mint a board the renderer
  // dies on. Rare, because a board of these is a board no oracle can be run against.
  if (b.notes.length && chance(rnd, 0.03)) {
    const n = b.notes[int(rnd, b.notes.length)];
    delete n.date;
    n.repeatsYearly = pick(rnd, ['yes', true, 1]);
  }

  // ── 7. A scratchpad shape neither door had a test for ───────────────────────────────────────
  if (chance(rnd, 0.12)) b.scratchpads['2026-06'] = '';          // the REG-23 shape
  if (chance(rnd, 0.06)) b.scratchpads['nicht-ein-monat'] = 'x'; // not YYYY-MM
  if (chance(rnd, 0.06)) b.scratchpads['2026-09'] = 12345;       // not a string
  if (chance(rnd, 0.05)) b.scratchpads['2026-11'] = null;        // v1 paints an empty textarea

  return b;
}

/**
 * Which ugly shapes a board actually carries. The property suite prints the observed frequency of
 * every one of these across the whole seed range and asserts NONE is zero — because a generator
 * that has been quietly sanitised back into `generateBoard` still passes every property it feeds,
 * and passes them vacuously. This is the check that makes the corpus falsifiable.
 *
 * @param {Object} b @returns {Object<string, boolean>}
 */
export function uglyShapesIn(b) {
  const entries = [...b.notes, ...b.bars, ...b.categories];
  const ids = entries.map((e) => e.id);
  const known = ['schemaVersion', 'notes', 'bars', 'categories', 'scratchpads', 'settings', '_v2'];
  const entryFields = {
    note: ['id', 'date', 'text', 'categoryId', 'repeatsYearly'],
    bar: ['id', 'startDate', 'endDate', 'label', 'categoryId'],
  };
  const flatSettings = (o, out = []) => {
    for (const v of Object.values(o || {})) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatSettings(v, out);
      else out.push(v);
    }
    return out;
  };
  return {
    'duplicate ids': new Set(ids).size !== ids.length,
    'empty categories': b.categories.length === 0,
    'null settings': flatSettings(b.settings).includes(null) || b.settings.layers === null,
    'non-string text': [...b.notes].some((n) => typeof n.text !== 'string')
      || [...b.bars].some((x) => typeof x.label !== 'string'),
    'over-length text/label': b.notes.some((n) => typeof n.text === 'string' && n.text.length > 80)
      || b.bars.some((x) => typeof x.label === 'string' && x.label.length > 40),
    'unknown keys': Object.keys(b).some((k) => !known.includes(k))
      || b.notes.some((n) => Object.keys(n).some((k) => !entryFields.note.includes(k)))
      || b.bars.some((x) => Object.keys(x).some((k) => !entryFields.bar.includes(k))),
    'dangling categoryId': b.notes.some((n) => !b.categories.some((c) => c.id === n.categoryId)),
    'empty scratchpad': Object.values(b.scratchpads).some((v) => v === ''),
    'unrenderable startMonth': b.settings.startMonth === null,
    'undrawable entry': b.notes.some((n) => typeof n.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(n.date))
      || b.bars.some((x) => typeof x.endDate !== 'string'),
    // ── A3-H2, the five classes both doors coerce ──────────────────────────────────────────────
    'a date that names one day but is not ISO': [...b.notes, ...b.bars].some(
      (e) => [e.date, e.startDate, e.endDate].some(
        (d) => (typeof d === 'string' && d !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(d)) || typeof d === 'number',
      ),
    ),
    'a truthy non-boolean flag': b.notes.some((n) => 'repeatsYearly' in n && typeof n.repeatsYearly !== 'boolean')
      || b.categories.some((c) => 'visible' in c && typeof c.visible !== 'boolean'),
    'an id v2 cannot use': [...b.notes, ...b.bars, ...b.categories].some(
      (e) => !(typeof e.id === 'string' && e.id.length > 0 && /^[A-Za-z0-9._-]{1,128}$/.test(e.id)),
    ),
    'a bar with one end': b.bars.some(
      (x) => [x.startDate, x.endDate].filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).length === 1,
    ),
    'a bar with no dates at all': b.bars.some((x) => x.startDate === undefined && x.endDate === undefined),
    // ── R5-11, ONE CLASS PER SIDE OF THE BOUNDARY ─────────────────────────────────────────────
    // Reported separately on purpose: they are opposite bars in `layout.js:133`, a generator that
    // reached only one side is exactly how the defect survived, and a single merged count would
    // hide that happening again. The bounds are `entities.js`'s `EARLIEST_DATE`/`LATEST_DATE`,
    // restated here rather than imported for the reason this whole function is: it is the gate on
    // the corpus, so it must not agree with the code under test by construction.
    'a bar edge sorting BELOW every date v2 can hold': b.bars.some(
      (x) => [x.startDate, x.endDate].some(
        (d) => typeof d === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(d) && d < '0000-01-01',
      ),
    ),
    'a bar edge sorting ABOVE every date v2 can hold': b.bars.some(
      (x) => [x.startDate, x.endDate].some(
        (d) => typeof d === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(d) && d > '9999-12-31',
      ),
    ),
    'a non-string scratchpad': Object.values(b.scratchpads).some((v) => typeof v !== 'string'),
  };
}


// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8. Adversarial ops — the input P9 (structural ownership, risk R10) has to survive
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** A fourth member who is NOT in the Kreis and is not attested. */
export const EVE = `mem_${pad22('EVE')}`;
const EVE_DEV = Object.freeze({
  name: 'eve-mac', member: EVE, id: `dev_${pad22('DEVEVE')}`, short: short16('DEVEVE'), skew: 0,
});

/**
 * Every ownership attack the register layer must be structurally immune to, as real ops.
 *
 * ADR 001 §0.4: "Ownership is structural, not a register. A family entity's key literally
 * contains its owner." So there is no `owner` field to overwrite — and the attacks below are
 * therefore not attempts to *change* a field but attempts to make the SYSTEM report a different
 * owner: by writing to my entity from another member, by backdating to `ms = 0` so the write
 * sorts below everything, by inventing an `owner` field, and by minting a key that names me as
 * owner from someone else's device.
 *
 * `ms = 0` matters specifically: a stamp of zero is the smallest possible, so if ownership were
 * ever decided by "the earliest write wins" rather than by the key, this is the op that would
 * take it. It is generated on purpose and P9 asserts it changes nothing.
 *
 * @param {number} seed @param {GeneratedWorld} world
 * @returns {{ ops: Object[], refused: Object[] }} `ops` are well-formed enough to reach the fold;
 *          `refused` are the ones `makeOp` itself rejects — recorded so P9 can assert the
 *          validator, not just the fold, is doing its share.
 */
export function ownershipAttacks(seed, world) {
  const rnd = pcg32(seed ^ 0x0eeeee);
  const ctx = { gid: 9000, opn: 900000 };
  const eve = author(EVE_DEV, ctx);
  const mamaDev = DEVICES.find((d) => d.member === MAMA);
  const mama = author(mamaDev, ctx);
  const ops = [];
  const refused = [];

  const victims = world.contentOps
    .filter((o) => o.k === 'note.set' || o.k === 'bar.set')
    .map((o) => o.e);
  const victim = victims.length ? pick(rnd, victims) : 'note:' + UUIDS[0];
  const uuid = victim.slice(victim.indexOf(':') + 1);

  // 1. EVE writes directly to MY personal entity, backdated to the beginning of time.
  eve.at(0);
  ops.push(eve.op('note.set', noteKey(uuid), { text: 'von Eve' }, { space: PSP }));

  // 2. …and at ms = 0 into the family space, on MY family key.
  eve.at(0);
  ops.push(eve.op('pub.set', familyKey('fnote', ME, uuid),
    { 'pub.text': 'von Eve', 'pub.level': 'geteilt' }, { space: FSP }));

  // 3. MAMA — a real, attested member — does the same. Attested is not the same as authorized.
  mama.at(0);
  ops.push(mama.op('pub.set', familyKey('fnote', ME, uuid),
    { 'pub.level': 'geteilt', 'pub.coEdit': true }, { space: FSP }));

  // 4. EVE self-attests and self-declares membership, then forges a genesis naming herself admin
  //    at ms = 0 — the full assembled attack, not a single probe.
  eve.at(0);
  ops.push(eve.op('member.set', memberKey(EVE),
    { [`dev.${EVE_DEV.short}`]: attestationBlob(EVE, EVE_DEV) }, { space: FSP }));
  ops.push(eve.op('member.set', memberKey(EVE), { displayName: 'Eve', _alive: true }, { space: FSP }));
  ops.push(eve.op('space.set', spaceKey(FSP), { admin: EVE, adminPrev: null }, { space: FSP }));

  // 5. EVE mints a family key that reuses one of MY uuids under HER OWN member id. Legal to
  //    build — the key names her, so it is her entity — and it must not collide with mine.
  eve.at(0);
  ops.push(eve.op('pub.set', familyKey('fnote', EVE, uuid),
    { 'pub.level': 'geteilt', 'pub.alive': true, 'pub.date': '2026-12-24', 'pub.text': 'Evas Eintrag' },
    { space: FSP, born: true }));

  // 6. The ops that must not even be constructible. `owner` and `seriesId` do not exist in
  //    `FIELDS` (ADR 001 §12.6), so `makeOp` refuses them — and P9 asserts that it does, because
  //    "the field does not exist" is only a defence while nobody adds it.
  for (const bad of [{ owner: EVE }, { ownerId: EVE }, { seriesId: uuid }]) {
    try {
      eve.at(0);
      refused.push(eve.op('note.set', noteKey(uuid), bad, { space: PSP }));
    } catch (e) {
      refused.push({ patch: bad, error: e.message });
    }
  }
  return { ops, refused };
}
