// server/adapters/file.js — the SyncStore as JSON on disk.  ADR 003 §9, ADR 005 §1.6.
//
// WHAT THIS IS FOR. `server/dev-server.mjs` runs a zero-dependency `node:http` host over this
// adapter, so **two real app windows can sync on this machine over real HTTP** — no Vercel, no
// Postgres, no account. That is the only way the client work packages get to exercise the real
// wire (headers, signatures, cursors, 409s) before a database exists anywhere.
//
// It is also the contract suite's SECOND witness. memory.js and file.js share the engine that
// encodes the ADR (server/adapters/memory.js: createStoreEngine) and differ in exactly the layer
// that could plausibly break the rules on its own — serialisation and durability. So when the
// same ~60 cases pass here, what has been proved is that the rules survive a round trip through
// a wire format: that a bigint seq comes back a bigint, a Date comes back a Date, and a
// ciphertext column comes back as BYTES and not as a string. That last one is not a formality —
// a JSON store is precisely where an opaque column quietly becomes text.
//
// CONCURRENCY. Single writer. One process owns the file; the engine's mutex serialises inside it
// and every commit is a temp-file write plus an atomic rename, so a crash mid-write leaves the
// previous good state rather than half a file. Two dev-servers on one directory would race, and
// that is out of scope on purpose — production is Postgres.

import fs from 'node:fs';
import path from 'node:path';
import { createStoreEngine, emptyState } from './memory.js';

const FORMAT = 'lzp-sync-store';
const VERSION = 1;
const FILENAME = 'sync-store.json';

// ─────────────────────────────────────────────────────────────────────────────
// The wire format. Tagged so that a type can never be lost across a round trip.
//
// This is the whole reason file.js is a useful second witness: `{"$b": "…"}` is bytes and
// nothing else, so an opaque column cannot come back as a String and silently satisfy a handler
// that then stores something readable in it. RULE 1 is enforced by store-interface.js on the way
// IN and by these tags on the way OUT.
// ─────────────────────────────────────────────────────────────────────────────

function encode(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return { $b: Buffer.from(v).toString('base64') };
  if (v instanceof Date) return { $d: v.getTime() };
  if (typeof v === 'bigint') return { $n: v.toString() };
  if (v instanceof Map) return { $m: [...v].map(([k, val]) => [encode(k), encode(val)]) };
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = encode(v[k]);
    return { $o: out };
  }
  return v;
}

function decode(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(decode);
  if (typeof v !== 'object') return v;
  if ('$b' in v) return new Uint8Array(Buffer.from(v.$b, 'base64'));
  if ('$d' in v) return new Date(v.$d);
  if ('$n' in v) return BigInt(v.$n);
  if ('$m' in v) return new Map(v.$m.map(([k, val]) => [decode(k), decode(val)]));
  if ('$o' in v) {
    const out = {};
    for (const k of Object.keys(v.$o)) out[k] = decode(v.$o[k]);
    return out;
  }
  return v;
}

function hydrate(raw, file) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) {
    throw new Error(`${file} is not valid JSON. Refusing to start on a blank store: this file is the relay for real family boards, and silently starting empty would look to every client like "the server forgot everything". Move it aside deliberately if that is what you want. (${err.message})`);
  }
  if (!parsed || parsed.format !== FORMAT) {
    throw new Error(`${file} is not a ${FORMAT} file`);
  }
  if (parsed.v !== VERSION) {
    throw new Error(`${file} was written by store format v${parsed.v}; this build speaks v${VERSION}`);
  }
  const state = emptyState();
  const loaded = decode(parsed.state);
  for (const k of Object.keys(state)) {
    if (loaded && loaded[k] instanceof Map) state[k] = loaded[k];
  }
  return state;
}

function serialize(state) {
  return JSON.stringify({ format: FORMAT, v: VERSION, state: encode(state) });
}

/**
 * @param {string} dir           directory the store file lives in; created if absent
 * @param {{now?: () => number}} [opts]
 * @returns {Object} SyncStore
 */
export function fileStore(dir, opts) {
  const file = path.join(dir, FILENAME);
  fs.mkdirSync(dir, { recursive: true });

  const state = fs.existsSync(file) ? hydrate(fs.readFileSync(file, 'utf8'), file) : emptyState();

  let queued = null;
  /**
   * Write-through, atomically. A commit is not acknowledged to the handler until the bytes are
   * renamed into place, so a `200` from the dev-server means the same thing it will mean in
   * production: the relay has it.
   */
  async function persist(current) {
    const body = serialize(current);
    if (queued === body) return;                       // a no-op tx need not rewrite the file
    queued = body;
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, body, 'utf8');
    await fs.promises.rename(tmp, file);               // atomic on every POSIX filesystem
  }

  return createStoreEngine({ now: opts && opts.now, persist, state });
}

/** Exported for the dev-server's startup banner and for tests that assert the on-disk shape. */
export const STORE_FILENAME = FILENAME;
export const STORE_FORMAT = Object.freeze({ format: FORMAT, v: VERSION });
