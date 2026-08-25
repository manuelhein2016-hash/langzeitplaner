// tests/attack/_kit.js — shared minting helpers for the convergence attack suite.
// Zero dependencies. No wall clock. Every stamp is computed.

import { fmt } from '../../src/js/core/stamp.js';
import { makeOp } from '../../src/js/core/ops.js';
import { serializeRegisters } from '../../src/js/core/registers.js';

export const BASE_MS = 1787836800000;
export const HOUR = 3600000;
export const DAY = 24 * HOUR;

const CROCK = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const short16 = (s) => {
  let out = '';
  for (const ch of String(s).toUpperCase()) out += CROCK.includes(ch) ? ch : CROCK[ch.charCodeAt(0) % 32];
  return (out + '0'.repeat(16)).slice(0, 16);
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** 22-char base64url — the OpId / GroupId / MemberId-suffix shape. */
export const pad22 = (s) => {
  let out = '';
  for (const ch of String(s)) out += B64.includes(ch) ? ch : B64[ch.charCodeAt(0) % 64];
  return (out + 'A'.repeat(22)).slice(0, 22);
};

export const ME = `mem_${pad22('ME')}`;
export const MAMA = `mem_${pad22('MAMA')}`;
export const PAPA = `mem_${pad22('PAPA')}`;
export const PSP = `psp_${pad22('PERSONAL')}`;
export const FSP = `fsp_${pad22('FAMILIE')}`;

export const DEV = {
  meDesk: { id: `dev_${pad22('medesk')}`, short: short16('me-desktop'), member: ME },
  meLap: { id: `dev_${pad22('melap')}`, short: short16('me-laptop'), member: ME },
  mama: { id: `dev_${pad22('mamamac')}`, short: short16('mama-mac'), member: MAMA },
  papa: { id: `dev_${pad22('papamac')}`, short: short16('papa-mac'), member: PAPA },
};

/**
 * An op minter with a fully explicit stamp. `ms`/`ctr` are given, never read from a clock,
 * so an attack can place two writes at exactly the same millisecond on purpose.
 */
export function minter(dev, { act = dev.member, fsp = FSP } = {}) {
  let n = 0;
  return function op(k, e, f, { ms = BASE_MS, ctr = 0, space, gid = pad22('g1'), id, actAs, familySpaceId } = {}) {
    const ts = fmt(ms, ctr, dev.short);
    return makeOp({
      act: actAs ?? act,
      dev: dev.id,
      gid,
      space,
      familySpaceId: familySpaceId ?? fsp,
      mint: () => ts,
      newOpId: () => id ?? pad22(`${dev.short.slice(0, 4)}${++n}`),
    }, k, e, f);
  };
}

/** A cheap deterministic shuffle so a permutation attack is reproducible from its seed. */
export function shuffled(xs, seed) {
  let x = (seed >>> 0) || 0x9e3779b9;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Canonical, order-independent rendering of a RegisterMap — the "did two devices converge?" test. */
export const regsJSON = (regs) => JSON.stringify(serializeRegisters(regs));
