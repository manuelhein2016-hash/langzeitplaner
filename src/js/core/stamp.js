// src/js/core/stamp.js — the hybrid logical clock.  ADR 001 §1.3, ops.contract.js §1.
//
// DOM-free, I/O-free, dependency-free (ADR 005 §2).
//
//   stamp := pad13(wallMillis) '.' pad6(counter) '.' deviceShort16
//            |--- 13 chars ---|     |- 6 chars -|   |-- 16 chars --|      total 37
//   example: 1787836800123.000003.7QAR2MZ9XKPNC0GV
//
// The stamp is the LWW comparator and the sort key for the whole product. It is NOT the op id,
// and it never appears in plaintext on the wire (ADR 002 §5).
//
// FIXED WIDTH IS THE WHOLE TRICK. Because every field is zero-padded to a constant width and
// every character of the Crockford alphabet sorts at or above '0', a plain string `<` on two
// stamps is exactly the tuple order (wallMillis, counter, deviceShort). That is why `cmp` is
// three characters of logic and why the register store is a join-semilattice for free
// (ADR 001 §6).
//
// THE CONFLICT-RESOLUTION RULE, STATED ONCE, FOR THE WHOLE PRODUCT:
//   For every (entityKey, field) the surviving value is the one written by the op with the
//   GREATEST stamp, compared as a plain string. `deviceShort` is the final tiebreak and it is
//   total, because device shorts are 80-bit hashes of distinct public keys and the counter
//   strictly increments per local event. There is no "concurrent" case the rule declines to
//   resolve.
//
// THE CLOCK IS INJECTED. `createClock` takes `now` as a REQUIRED argument. ADR 001 §1.3 sketches
// it with `now = Date.now` as a default; ADR 005 §2 forbids `Date.now` inside core/ outright and
// ops.contract.js declares the parameter without a default. The contract and the hard rule win:
// there is no default here, and a caller that forgets the clock gets a loud error instead of a
// module that quietly reads the wall clock in a test.

import { isDeviceShort } from './ids.js';

/** Ops stamped further ahead than this are PARKED, never dropped (ADR 001 §1.3, §7.4). */
export const MAX_FUTURE_DRIFT_MS = 24 * 60 * 60 * 1000;

export const STAMP_LENGTH = 37;
/** 13 digits of milliseconds ends in the year 10 000; the format is fixed-width by construction. */
export const MAX_STAMP_MS = 9999999999999;
/** Counter overflow rolls into the next millisecond (ADR 001 §1.3). */
export const MAX_STAMP_CTR = 999999;

const STAMP_RE = /^\d{13}\.\d{6}\.[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/;

/**
 * Fixed width => a plain string `<` is a strict total order.
 * @param {number} ms @param {number} ctr @param {string} dev @returns {string}
 */
export function fmt(ms, ctr, dev) {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_STAMP_MS) {
    throw new RangeError(`fmt: wallMillis ${ms} is not an integer in [0, ${MAX_STAMP_MS}]`);
  }
  if (!Number.isInteger(ctr) || ctr < 0 || ctr > MAX_STAMP_CTR) {
    throw new RangeError(`fmt: counter ${ctr} is not an integer in [0, ${MAX_STAMP_CTR}]`);
  }
  if (!isDeviceShort(dev)) {
    throw new TypeError(`fmt: deviceShort must be 16 Crockford characters, got ${JSON.stringify(dev)}`);
  }
  return String(ms).padStart(13, '0') + '.' + String(ctr).padStart(6, '0') + '.' + dev;
}

/** Strict total order on stamps. @param {string} a @param {string} b @returns {-1|0|1} */
export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** @param {string} s @returns {number} */ export const msOf = (s) => Number(s.slice(0, 13));
/** @param {string} s @returns {number} */ export const ctrOf = (s) => Number(s.slice(14, 20));
/** @param {string} s @returns {string} */ export const devOf = (s) => s.slice(21);

/** @param {unknown} s @returns {boolean} */
export function isStamp(s) {
  return typeof s === 'string' && s.length === STAMP_LENGTH && STAMP_RE.test(s);
}

/** @param {string} s @returns {{ms:number, ctr:number, dev:string}} */
export function parse(s) {
  if (!isStamp(s)) throw new TypeError(`parse: not a stamp: ${JSON.stringify(s)}`);
  return { ms: msOf(s), ctr: ctrOf(s), dev: devOf(s) };
}

/**
 * The parking predicate (ADR 001 §7.4). An op whose stamp is further ahead than
 * MAX_FUTURE_DRIFT_MS is retained and re-evaluated when local wall time advances past it —
 * never dropped, and never allowed to drag this device's clock forward.
 * @param {string} stamp @param {number} nowMs @returns {boolean}
 */
export function isTooFarFuture(stamp, nowMs) {
  return msOf(stamp) > nowMs + MAX_FUTURE_DRIFT_MS;
}

/**
 * @typedef {Object} Clock
 * @property {() => string} tick                  mint a stamp for a locally authored write
 * @property {(s:string) => void} observe         absorb a received stamp; NEVER rewrites `s`
 * @property {() => string} peek                  the current state as a stamp; does not mutate
 * @property {() => number} skew                  ms our clock is ahead of the last server time
 * @property {() => {ms:number, ctr:number}} save persistable state
 * @property {(serverMs:number) => void} observeServerTime
 */

/**
 * @param {string} deviceShort 16 Crockford characters — the final tiebreak
 * @param {() => number} now   INJECTED wall clock, milliseconds
 * @param {{ state?: {ms:number, ctr:number} }} [opts] restore a persisted clock
 * @returns {Clock}
 */
export function createClock(deviceShort, now, opts = {}) {
  if (!isDeviceShort(deviceShort)) {
    throw new TypeError(`createClock: deviceShort must be 16 Crockford characters, got ${JSON.stringify(deviceShort)}`);
  }
  if (typeof now !== 'function') {
    throw new TypeError('createClock: `now` is required — core/ may not read the wall clock itself (ADR 005 §2)');
  }

  let ms = 0;
  let ctr = 0;
  if (opts.state) {
    ms = opts.state.ms;
    ctr = opts.state.ctr;
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_STAMP_MS) throw new RangeError('createClock: bad saved ms');
    if (!Number.isInteger(ctr) || ctr < 0 || ctr > MAX_STAMP_CTR) throw new RangeError('createClock: bad saved ctr');
  }

  /** ms our clock reads ahead of the server's; 0 until a server time has been seen. */
  let skewMs = 0;

  function physical() {
    const t = Math.floor(now());
    if (!Number.isFinite(t) || t < 0 || t > MAX_STAMP_MS) {
      throw new RangeError(`createClock: the injected clock returned ${String(t)}`);
    }
    return t;
  }

  /** Counter overflow rolls into the next millisecond rather than widening the field. */
  function rollIfNeeded() {
    if (ctr > MAX_STAMP_CTR) {
      ms += 1;
      ctr = 0;
      if (ms > MAX_STAMP_MS) throw new RangeError('createClock: wallMillis overflowed the 13-digit field');
    }
  }

  return {
    tick() {
      const phys = physical();
      if (phys > ms) {
        ms = phys;
        ctr = 0;
      } else {
        ctr += 1;
        rollIfNeeded();
      }
      return fmt(ms, ctr, deviceShort);
    },

    /**
     * The standard HLC receive rule. The received op's stamp is NEVER rewritten, so absorbing
     * can only change FUTURE local stamps and therefore cannot change any merge outcome on any
     * device. A stamp beyond MAX_FUTURE_DRIFT_MS is not adopted at all: a peer with a broken
     * clock must not be able to drag ours forward. Its op is parked, not lost — see
     * `isTooFarFuture` and ADR 001 §7.4.
     */
    observe(s) {
      if (!isStamp(s)) throw new TypeError(`observe: not a stamp: ${JSON.stringify(s)}`);
      const phys = physical();
      const rms = msOf(s);
      const rctr = ctrOf(s);
      if (rms > phys + MAX_FUTURE_DRIFT_MS) return;

      const next = Math.max(ms, rms, phys);
      if (next === ms && next === rms) ctr = Math.max(ctr, rctr) + 1;
      else if (next === ms) ctr = ctr + 1;
      else if (next === rms) ctr = rctr + 1;
      else ctr = 0;
      ms = next;
      rollIfNeeded();
    },

    peek() {
      return fmt(ms, ctr, deviceShort);
    },

    /**
     * ADR 001 §13.2's mitigation: the settings panel warns when this exceeds five minutes, and
     * the sync indicator uses a specific error rather than a generic one. Positive = this Mac
     * reads ahead of the server.
     */
    skew() {
      return skewMs;
    },

    observeServerTime(serverMs) {
      if (!Number.isFinite(serverMs)) throw new TypeError('observeServerTime: expected a number');
      skewMs = physical() - Math.floor(serverMs);
    },

    save() {
      return { ms, ctr };
    },
  };
}
