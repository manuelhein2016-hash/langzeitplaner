// src/js/platform/keystore.js — key custody.  LZP-302 · ADR 002 §2.2.
//
// THE ONLY STATEFUL PIECE OF E3, AND THE ONLY FILE IN THE CRYPTO WORK THAT IS ALLOWED TO DO I/O.
// `src/js/crypto/` is DOM-free and I/O-free (ADR 005 §2) and takes a `KeyStore` PORT; this file
// is where that port meets a real machine. It lives under `platform/` for exactly that reason and
// is deliberately outside `tests/tier1/core-purity.test.js`'s scope.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DESIGN, AND THE VERIFICATION ITEM ADR 002 §2.2 LEFT OPEN — NOW ANSWERED
// ─────────────────────────────────────────────────────────────────────────────
//
// §2.2 amends LZP-302's original "macOS Keychain via Tauri" to:
//
//   PRIMARY   a NON-EXTRACTABLE `CryptoKey`, structured-cloned into IndexedDB. The private bytes
//             never enter the JS heap at all — strictly stronger than exporting PKCS#8 to hand
//             to a native Keychain API, which necessarily materialises the secret in JS.
//   BACKSTOP  the macOS Keychain, for the RECOVERY identity only: a 32-byte `DEK`, plus
//             `RK_sig`/`RK_kex` as AES-GCM-wrapped PKCS#8 under that `DEK`. `IK_*` never leave
//             IndexedDB. If IndexedDB is evicted the device must re-pair, but the MEMBER
//             identity survives, so the user is never locked out of their own membership.
//
// and it left one thing explicitly unverified:
//
//   > VERIFICATION ITEM for LZP-302 — do not assume. Confirm with a real `--test` run that a
//   > non-extractable `CryptoKey` in IndexedDB persists across an app relaunch under the
//   > `app://localhost` scheme.
//
// **ANSWERED: YES.** Measured on macOS 26.3, WKWebView, `app://localhost`, by two separate
// launches of the real shell — `tests/tier2/crypto-keystore-phase1.dom.js` writes the pair and
// exits the process; `tests/tier2/crypto-keystore-phase2.dom.js` is a fresh process that reads it
// back. The restored `privateKey` reports `extractable === false`, `exportKey('pkcs8', …)`
// REJECTS, and a signature made with the restored key verifies under the restored public key.
// The primary custody design stands and no downgrade is recorded in `DESIGN-DECISIONS.md`.
//
// ─────────────────────────────────────────────────────────────────────────────
// AN EIGHTH ENGINE DIFFERENCE — NOT IN ADR 002 §1's TABLE OF SEVEN, AND IT BITES HERE
// ─────────────────────────────────────────────────────────────────────────────
//
//   **WebKit cannot structured-clone a `CryptoKey` without the macOS Keychain.**
//
// WebKit wraps a serialised `CryptoKey` under a per-application "WebCrypto master key" that it
// stores in, and fetches from, the login Keychain. When that fetch fails the symptom is NOT a
// crypto error and names nothing about keychains: the IndexedDB `put()` rejects with
//
//     DataCloneError: The object can not be cloned.
//
// with one line on the process's stderr — `Cannot store WebCrypto master key, error -60006`
// (`errSecUserCanceled`) — which the page cannot see at all. Reproduced deliberately during
// LZP-302 by launching the shell with `HOME` pointed at a directory holding no login keychain.
//
// Two consequences, both design-level:
//
//   1. **The Keychain is not merely a backstop, it is a PREREQUISITE of the primary store.**
//      §2.2 presents IndexedDB custody as the option that avoids depending on the Keychain. On
//      WebKit it does not: no reachable Keychain ⇒ no CryptoKey persistence at all. This does not
//      change the decision — non-extractability is still strictly stronger, and a Mac whose login
//      keychain is unreachable has larger problems — but it must be written down, because "we
//      chose IndexedDB so the Keychain can be a backstop" is now only half true.
//   2. **A pairing flow must not read a `DataCloneError` as "bad key material".** It means
//      custody is unavailable on this machine right now. `putKeyPair` below turns it into a
//      typed `KeyStoreUnavailableError` carrying that explanation, so the family entry point can
//      say something a human can act on instead of surfacing a serialisation message.
//
// (RULE 3 still holds: this file does not branch on `DataCloneError` by NAME. It branches on the
// try/catch boundary around a `put` of a value that CONTAINS a CryptoKey, which is the only
// operation that can fail this way, and reports that fact.)
//
// ─────────────────────────────────────────────────────────────────────────────
// RULE 7 — THE NODE ASYMMETRY, STATED RATHER THAN SHIMMED
// ─────────────────────────────────────────────────────────────────────────────
//
// Node has no `indexedDB`, and `isSecureContext` there is `undefined` — not `false`. Both engines
// report `isSecureContext === true` under the shell's `app://localhost` scheme. So tier 1 uses
// `memKeyStore()` and cannot say anything about persistence; tier 2 uses `idbKeyStore()` and is
// the only place the persistence claim can be made at all. That asymmetry is explicit in the
// LZP-1005 harness contract and is NOT papered over with a fake IndexedDB — a shimmed store would
// have converted an unverified design into one that merely LOOKED verified.

import {
  AEAD,
  SYMMETRIC_KEY_BYTES,
  USAGES,
  SIG,
  KEX,
  PKCS8_P256_BYTES,
} from '../crypto/suite.js';
import { b64u, ub64 } from '../core/b64.js';

/** Custody is unavailable on this machine right now — distinct from "the key material is bad". */
export class KeyStoreUnavailableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'KeyStoreUnavailableError';
    this.cause = cause;
  }
}

/** The IndexedDB database and object store the shipping app uses. */
export const IDB_DB_NAME = 'langzeitplaner-keys';
export const IDB_STORE_NAME = 'keys';
export const IDB_VERSION = 1;

/** Keychain service and the three accounts the backstop uses (ADR 002 §2.2). */
export const KEYCHAIN_SERVICE = 'org.langzeitplaner.keys';
export const KEYCHAIN_ACCOUNTS = Object.freeze({
  dek: 'device-dek',
  recovery: 'recovery-identity',
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. memKeyStore — Node / CI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In memory, and honest about it: nothing here survives anything.
 *
 * It is the tier-1 store, and its existence is why the whole crypto layer is developable and
 * CI-testable without a shell build. It is NOT evidence about persistence — see the header.
 *
 * @returns {import('../crypto/identity.js').KeyStore & {size:() => number}}
 */
export function memKeyStore() {
  const map = new Map();
  return {
    async get(id) {
      assertId(id, 'memKeyStore.get');
      return map.has(id) ? map.get(id) : null;
    },
    async put(id, value) {
      assertId(id, 'memKeyStore.put');
      if (value === null || value === undefined) throw new Error('memKeyStore.put: refusing to store nothing');
      map.set(id, value);
    },
    async del(id) {
      assertId(id, 'memKeyStore.del');
      map.delete(id);
    },
    async list() {
      return [...map.keys()].sort();
    },
    size: () => map.size,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. idbKeyStore — WebKit, the primary store
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Non-extractable `CryptoKey`s and `CryptoKeyPair`s, structured-cloned into IndexedDB.
 *
 * WHY IndexedDB AND NOT `localStorage` OR A FILE: a `CryptoKey` is only ever obtainable as an
 * object. `localStorage` stores strings, so putting a key there would mean exporting it —
 * i.e. making it extractable, i.e. giving up the one property this design is built on. IndexedDB
 * is the only browser store that takes a structured clone, and a structured clone is the only way
 * a non-extractable key can be persisted by a web page at all.
 *
 * The database is opened per operation and closed again. A long-lived handle would block the
 * `versionchange` a future migration needs, and key access is rare enough (a handful of reads at
 * family opt-in, one write at pairing) that the open cost is irrelevant next to that.
 *
 * @param {{factory?:IDBFactory, dbName?:string, storeName?:string, version?:number}} [opts]
 *        `factory` is injected so tests can use a scoped database — the tier-2 suite shares one
 *        WebKit data store with the real app, so the shipping database name must never be the one
 *        a test writes into.
 * @returns {import('../crypto/identity.js').KeyStore & {destroy:() => Promise<void>}}
 */
export function idbKeyStore(opts = {}) {
  const factory = opts.factory || globalThis.indexedDB;
  const dbName = opts.dbName || IDB_DB_NAME;
  const storeName = opts.storeName || IDB_STORE_NAME;
  const version = opts.version || IDB_VERSION;

  if (!factory) {
    throw new KeyStoreUnavailableError(
      'idbKeyStore: this engine has no indexedDB. Node is the expected case (ADR 002 §1 rule 7) ' +
      'and must use memKeyStore(); a browser without it is an insecure or partitioned context.'
    );
  }

  const open = () =>
    new Promise((resolve, reject) => {
      const req = factory.open(dbName, version);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new KeyStoreUnavailableError('idbKeyStore: open blocked by another connection'));
    });

  const run = async (mode, fn) => {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        let result;
        // The REQUEST resolving is not the write landing. Only `tx.oncomplete` means the bytes
        // are durable; resolving on `onsuccess` would let a caller believe a key was stored and
        // then lose it to an abort. This is the difference between "the device is paired" and
        // "the device thinks it is paired".
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('idbKeyStore: transaction aborted'));
        // `fn` issues the request and reports its value through `set` from the request's own
        // `onsuccess`, which fires before `oncomplete`. It is never read from `fn`'s return
        // value: a write has none, and a read's is an IDBRequest, not a result.
        fn(tx.objectStore(storeName), (v) => {
          result = v;
        });
      });
    } finally {
      db.close();
    }
  };

  return {
    async get(id) {
      assertId(id, 'idbKeyStore.get');
      const v = await run('readonly', (store, set) => {
        const req = store.get(id);
        req.onsuccess = () => set(req.result);
      });
      return v === undefined ? null : v;
    },

    async put(id, value) {
      assertId(id, 'idbKeyStore.put');
      if (value === null || value === undefined) throw new Error('idbKeyStore.put: refusing to store nothing');
      try {
        await run('readwrite', (store) => {
          store.put(value, id);
        });
      } catch (err) {
        // See the header, "AN EIGHTH ENGINE DIFFERENCE". A structured clone of a CryptoKey needs
        // WebKit's WebCrypto master key, which lives in the login Keychain; when that is
        // unreachable the clone fails and says nothing about keychains. We do not read the error
        // NAME (rule 3) — we know from the SHAPE OF THE VALUE that this is the only operation
        // that can fail this way, and we say so.
        if (containsCryptoKey(value)) {
          throw new KeyStoreUnavailableError(
            'idbKeyStore.put: this engine could not persist a CryptoKey. On WebKit that means ' +
            'the WebCrypto master key in the login Keychain was unreachable (locked, denied, or ' +
            'absent) — it is a CUSTODY failure, not bad key material. Nothing was stored.',
            err
          );
        }
        throw err;
      }
    },

    async del(id) {
      assertId(id, 'idbKeyStore.del');
      await run('readwrite', (store) => {
        store.delete(id);
      });
    },

    async list() {
      const keys = await run('readonly', (store, set) => {
        const req = store.getAllKeys();
        req.onsuccess = () => set(req.result);
      });
      return [...(keys || [])].map(String).sort();
    },

    /** Test hygiene: the tier-2 suite shares a WebKit data store with the real app. */
    async destroy() {
      await new Promise((resolve, reject) => {
        const req = factory.deleteDatabase(dbName);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => resolve(); // a blocked delete still lands once handles close
      });
    },
  };
}

/** Does this value carry a `CryptoKey` anywhere the structured clone will have to serialise? */
function containsCryptoKey(v) {
  if (!v || typeof v !== 'object') return false;
  const tag = Object.prototype.toString.call(v);
  if (tag === '[object CryptoKey]') return true;
  // A CryptoKeyPair is a plain object of two CryptoKeys — one level is enough for every value
  // this store holds, and a deep walk of arbitrary caller data is not this function's job.
  return Object.values(v).some((x) => Object.prototype.toString.call(x) === '[object CryptoKey]');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The Keychain backstop (ADR 002 §2.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three shell commands §2.2 adds to `shell-macos/main.swift` (and, unverified, to
 * `src-tauri/src/lib.rs`), behind one small port so nothing above this line knows about `invoke`.
 *
 * `keychain_set` uses `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`: the item never leaves this
 * Mac and is unreadable while the machine is locked. That is the right accessibility class for a
 * recovery key — iCloud Keychain sync would silently widen the blast radius of §8.12 ("the
 * recovery key has no revocation") to every device on the Apple ID.
 *
 * @param {(cmd:string, args?:object) => Promise<any>} invoke
 * @returns {{get:(k:string)=>Promise<string|null>, set:(k:string,v:string)=>Promise<void>, del:(k:string)=>Promise<void>}}
 */
export function keychainPort(invoke) {
  if (typeof invoke !== 'function') throw new Error('keychainPort: invoke must be a function');
  return {
    async get(key) {
      const v = await invoke('keychain_get', { key });
      return typeof v === 'string' ? v : null;
    },
    async set(key, value) {
      if (typeof value !== 'string') throw new Error('keychainPort.set: value must be a string');
      await invoke('keychain_set', { key, value });
    },
    async del(key) {
      await invoke('keychain_delete', { key });
    },
  };
}

/**
 * Read the 32-byte device encryption key from the Keychain, or mint and store it once.
 *
 * The `DEK` exists only from the first FAMILY use (§2.1) — solo mode has no key of any kind — and
 * it wraps exactly one thing: the recovery identity's PKCS#8, in the Keychain, beside it. It is
 * NOT a master key: `PSK` and `FSK_e` are independently generated and have no derivation path to
 * this or to each other (§3 barrier 1).
 *
 * @param {{get:Function,set:Function}} keychain from `keychainPort`
 * @param {{random?:(n:number)=>Uint8Array}} [ports]
 * @returns {Promise<Uint8Array>} 32 bytes
 */
export async function ensureDek(keychain, ports = {}) {
  const existing = await keychain.get(KEYCHAIN_ACCOUNTS.dek);
  if (typeof existing === 'string' && existing.length > 0) {
    const bytes = ub64(existing);
    if (bytes.length !== SYMMETRIC_KEY_BYTES) {
      throw new KeyStoreUnavailableError(
        `ensureDek: the stored DEK is ${bytes.length} bytes, not ${SYMMETRIC_KEY_BYTES}. ` +
        'Refusing to overwrite it — that would orphan the wrapped recovery identity beside it.'
      );
    }
    return bytes;
  }
  const random = ports.random || ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const dek = random(SYMMETRIC_KEY_BYTES);
  await keychain.set(KEYCHAIN_ACCOUNTS.dek, b64u(dek));
  return dek;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. fileKeyStore — the dev/browser fallback, for EXTRACTABLE keys only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AES-GCM-wrapped PKCS#8 behind an injected byte store (§2.2's `keys/recovery.enc` at mode 0600
 * in Application Support, or the Keychain item itself).
 *
 * **AES-GCM, NEVER AES-KW — this is rule 6, and it is the reason this function exists in this
 * shape at all.** A P-256 PKCS#8 is 138 bytes; 138 is not a multiple of 8; AES-KW therefore
 * raises `OperationError` in BOTH engines. The trap the rule warns about is that X25519/Ed25519
 * PKCS#8 is 48 bytes and DOES wrap, so a 25519 prototype of this file would have worked
 * perfectly and shipped a P-256 build that could not store a single key.
 *
 * **IT CANNOT HOLD A DEVICE KEY, AND THAT IS NOT A LIMITATION — IT IS THE POINT.** `wrapKey`
 * requires the key being wrapped to be extractable, and `IK_sig`/`IK_kex` are generated with
 * `extractable: false` precisely so that no code path — including this one — can turn them into
 * bytes. A device key reaching this store would mean the non-extractability guarantee had already
 * been given up somewhere upstream, so the refusal below is a tripwire, not an inconvenience.
 * Device keys live in IndexedDB or they do not live.
 *
 * @param {{read:(id:string)=>Promise<string|null>, write:(id:string,v:string)=>Promise<void>,
 *          remove:(id:string)=>Promise<void>, keys:()=>Promise<string[]>}} bytes
 * @param {{dek:Uint8Array, subtle?:SubtleCrypto, random?:(n:number)=>Uint8Array}} opts
 * @returns {import('../crypto/identity.js').KeyStore}
 */
export function fileKeyStore(bytes, opts) {
  for (const m of ['read', 'write', 'remove', 'keys']) {
    if (typeof bytes?.[m] !== 'function') throw new Error(`fileKeyStore: the byte port must implement ${m}`);
  }
  const dek = opts?.dek;
  if (!(dek instanceof Uint8Array) || dek.length !== SYMMETRIC_KEY_BYTES) {
    throw new Error(`fileKeyStore: a ${SYMMETRIC_KEY_BYTES}-byte DEK is required (see ensureDek)`);
  }
  const S = () => opts.subtle || globalThis.crypto.subtle;
  const random = opts.random || ((n) => globalThis.crypto.getRandomValues(new Uint8Array(n)));

  const kek = async () =>
    S().importKey('raw', dek, { name: AEAD.name }, false, [...USAGES.kek]);

  const wrapOne = async (key) => {
    if (key.extractable === false) {
      throw new KeyStoreUnavailableError(
        'fileKeyStore: refusing a NON-EXTRACTABLE key. A device key (IK_sig/IK_kex) must never ' +
        'reach a file store — it is generated extractable:false so that no code path can turn ' +
        'it into bytes. Use idbKeyStore(). See ADR 002 §2.2.'
      );
    }
    const iv = random(AEAD.ivBytes);
    // wrapKey('pkcs8', …, {name:'AES-GCM', iv}) — rule 6: never AES-KW.
    const wrapped = new Uint8Array(
      await S().wrapKey('pkcs8', key, await kek(), { name: AEAD.name, iv, tagLength: AEAD.tagLength })
    );
    return { iv: b64u(iv), k: b64u(wrapped) };
  };

  const unwrapOne = async (rec, algo, usages) =>
    S().unwrapKey(
      'pkcs8',
      ub64(rec.k),
      await kek(),
      { name: AEAD.name, iv: ub64(rec.iv), tagLength: AEAD.tagLength },
      algo,
      true,
      [...usages]
    );

  return {
    async get(id) {
      assertId(id, 'fileKeyStore.get');
      const raw = await bytes.read(id);
      if (raw === null || raw === undefined) return null;
      const rec = JSON.parse(raw);
      if (rec.t === 'bytes') return ub64(rec.b);
      const algo = rec.a === 'ECDSA' ? SIG : KEX;
      // PRIVATE usages, not the pair's. `importKey`/`unwrapKey` reject a private EC key carrying
      // `verify` with a SyntaxError — see `USAGES.sigPrivate` in suite.js.
      const usages = rec.a === 'ECDSA' ? USAGES.sigPrivate : USAGES.kexPrivate;
      const privateKey = await unwrapOne(rec.priv, algo, usages);
      const publicKey = await S().importKey(
        'raw',
        ub64(rec.pub),
        algo,
        true,
        rec.a === 'ECDSA' ? [...USAGES.peerSig] : [...USAGES.peerKex]
      );
      return { privateKey, publicKey };
    },

    async put(id, value) {
      assertId(id, 'fileKeyStore.put');
      if (value instanceof Uint8Array) {
        await bytes.write(id, JSON.stringify({ v: 1, t: 'bytes', b: b64u(value) }));
        return;
      }
      const pair = value;
      if (!pair?.privateKey || !pair?.publicKey) {
        throw new Error('fileKeyStore.put: expected a CryptoKeyPair or a Uint8Array');
      }
      const a = pair.privateKey.algorithm?.name === 'ECDSA' ? 'ECDSA' : 'ECDH';
      const pub = new Uint8Array(await S().exportKey('raw', pair.publicKey));
      const priv = await wrapOne(pair.privateKey);
      // A stored PKCS#8 that is not 138 + 16 bytes means the wrap algorithm changed under us.
      if (ub64(priv.k).length !== PKCS8_P256_BYTES + AEAD.tagLength / 8) {
        throw new Error(
          `fileKeyStore.put: wrapped private key is ${ub64(priv.k).length} bytes, expected ` +
          `${PKCS8_P256_BYTES + AEAD.tagLength / 8}. The wrapping algorithm is not AES-GCM over P-256 PKCS#8.`
        );
      }
      await bytes.write(id, JSON.stringify({ v: 1, t: 'pair', a, pub: b64u(pub), priv }));
    },

    async del(id) {
      assertId(id, 'fileKeyStore.del');
      await bytes.remove(id);
    },

    async list() {
      return (await bytes.keys()).slice().sort();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The fallback chain (ADR 002 §2.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick the store this runtime can actually offer, and SAY WHICH.
 *
 * The returned `kind` is not decoration: `'memory'` means nothing survives a quit, and a caller
 * that pairs a device against a memory store has produced an attestation for a key that will not
 * exist tomorrow. LZP-1003's self-audit reports this value, and the pairing flow must refuse to
 * run against `'memory'` outside a test.
 *
 * @param {{factory?:IDBFactory, dbName?:string, storeName?:string}} [opts]
 * @returns {{kind:'indexeddb'|'memory', store:import('../crypto/identity.js').KeyStore}}
 */
export function chooseKeyStore(opts = {}) {
  const factory = 'factory' in opts ? opts.factory : globalThis.indexedDB;
  if (factory) return { kind: 'indexeddb', store: idbKeyStore({ ...opts, factory }) };
  return { kind: 'memory', store: memKeyStore() };
}

function assertId(id, who) {
  if (typeof id !== 'string' || id.length === 0) throw new Error(`${who}: id must be a non-empty string`);
}
