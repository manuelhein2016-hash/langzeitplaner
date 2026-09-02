#!/usr/bin/env node
// scripts/e9-relay-bytes.mjs — E9's relay-byte proof, against a REAL running dev relay.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A SCRIPT AND NOT A ROW IN `tests/fleet/`
// ═════════════════════════════════════════════════════════════════════════════════════════════
//
// Every suite in this repo is deterministic and offline; `tests/fleet/` reaches the 23 real
// handlers through `tests/helpers/loopback.js`, with only the socket replaced. That is the right
// shape for a suite and it is exactly what makes it unable to answer ONE question E9's acceptance
// asks: *what bytes are actually sitting on the relay's disk?* A loopback relay has no disk.
//
// So this lane keeps the whole client — real identity, real device keys, real space key, real
// `sealOp`, real engine, the shipped `createFleet` harness — and replaces the loopback wire with
// a real HTTP socket onto `server/dev-server.mjs`'s file adapter. Then it reads the file.
//
//   node server/dev-server.mjs --port 8788 --dir /tmp/lzp-e9-relay
//   node scripts/e9-relay-bytes.mjs --relay http://127.0.0.1:8788 --dir /tmp/lzp-e9-relay
//
// ⚠ ONE THING HAD TO CHANGE AND IT IS WORTH RECORDING. `simClock()` starts at 2026-08-29, and
// ADR 003 §2 step 2 gives a signed request a 120 000 ms window against the RELAY's clock — so
// against a real host every POST is `401 stale_request`. A simulated clock is correct for a
// simulated relay and wrong for this one. The clock below is the only substitution.
//
// Exit code 0 = the standing result held. Non-zero = a leak, and the line says which probe.
// ═════════════════════════════════════════════════════════════════════════════════════════════

import '../tests/helpers/env.js';
import { readFile } from 'node:fs/promises';
import { createFleet, settle } from '../tests/helpers/fleet.js';

const arg = (n, d) => {
  const i = process.argv.indexOf(n);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const RELAY = arg('--relay', 'http://127.0.0.1:8788');
const DIR = arg('--dir', '/tmp/lzp-e9-relay');

const SHARED = 'Herbstferien Nordsee 05.10.';
const PRIVAT = 'Scheidungsanwalt 14:30';

/** The loopback wire's contract, over a real socket. */
function httpWire() {
  return {
    calls: [], seenBodies: [], hostile: { onResponse: null },
    honest() { return this; }, partition() { return this; }, heal() { return this; },
    isolated() { return false; },
    async deliver(deviceShort, req) {
      this.calls.push({ method: req.method, path: req.path, deviceShort });
      if (req.body !== null && req.body !== undefined) this.seenBodies.push(req.body);
      const qs = req.query && Object.keys(req.query).length ? `?${new URLSearchParams(req.query)}` : '';
      const res = await fetch(`${RELAY}${req.path}${qs}`, {
        method: req.method,
        headers: { 'content-type': 'application/json', ...(req.headers || {}) },
        body: req.body === null || req.body === undefined ? undefined : JSON.stringify(req.body),
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { status: res.status, headers, body };
    },
  };
}

const realClock = () => ({
  now: () => Date.now(),
  today: () => new Date().toISOString().slice(0, 10),
  advance() { return Date.now(); },
  set() { return Date.now(); },
});

const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`); };

try {
  await fetch(`${RELAY}/api/v1/meta`);
} catch {
  console.error(`e9-relay-bytes: no relay at ${RELAY}. Start it first:\n`
    + `  node server/dev-server.mjs --port 8788 --dir ${DIR}`);
  process.exit(2);
}

// TWO Macs, because `assertDistinctIdentities()` refuses a fleet of one — "a fleet of one device
// proves nothing about convergence", and a harness that would prove nothing refuses to exist.
const fleet = await createFleet({ devices: ['PapaMac', 'PapaLaptop'], wire: httpWire(), clock: realClock() });
await fleet.assertDistinctIdentities();
const papa = fleet.device('PapaMac');

await papa.run(async () => {
  papa.store.apply('createNoteInline', {
    id: 'aaaa1111-2222-4333-8444-555555555555', date: '2026-10-05', text: SHARED,
    categoryId: papa.store.state.categories[0].id,
  });
  papa.store.apply('createNoteInline', {
    id: 'bbbb1111-2222-4333-8444-555555555555', date: '2026-10-06', text: PRIVAT,
    categoryId: papa.store.state.categories[0].id,
  });
});
await settle(fleet, 2);

const raw = await readFile(`${DIR}/sync-store.json`, 'utf8');
console.log(`\nrelay store: ${DIR}/sync-store.json — ${raw.length} bytes\n`);

check(raw.length > 2000, `non-vacuity: the relay really is holding data (${raw.length} B)`);
check(!raw.includes(PRIVAT), 'the Privat entry\'s text is NOT on the relay');
check(!raw.includes(SHARED), 'not even the SHARED entry is plaintext — the envelope encrypts');
for (const probe of ['note.set', 'createNoteInline', 'visibility', 'geteilt', 'privat',
  'categoryId', '2026-10-05', 'repeatsYearly']) {
  check(!raw.includes(probe), `the relay cannot read "${probe}"`);
}

// …and what it DOES hold, so the absence above is not an absence of everything.
const store = JSON.parse(raw);
const walk = function* (o, p = '') {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) yield* walk(v, `${p}/${k}`);
  else yield [p, o];
};
const leaves = [...walk(store)];
const opaque = leaves.filter(([, v]) => typeof v === 'string' && v.length > 60);
check(opaque.length > 0, `it holds ${opaque.length} opaque blobs (envelopes, keys, wraps)`);
check(leaves.some(([p]) => p.includes('/ops/')), 'including op rows — the ops really were pushed');

console.log(fail.length ? `\n${fail.length} FAILED` : '\nthe standing result holds: zero plaintext bytes on the relay');
process.exit(fail.length ? 1 : 0);
