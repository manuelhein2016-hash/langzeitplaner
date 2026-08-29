// TIER 1 · ADR 003 §7 gate 1 · ADR 005 §5 rule 4 · story 21.5 / 13.4 · LZP-1002 · finding F-9.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROMISE THIS FILE IS
// ─────────────────────────────────────────────────────────────────────────────
//
//   "In solo mode the app makes zero network requests; with a Familienkreis it talks to exactly
//    one sync endpoint and nothing else."                                          — story 21.5
//
// ADR 003 §7 says a promise this central does not rest on one `if`, and lists four independent
// gates. Gates 2, 3 and 4 were real and asserted from the day they were written. **Gate 1 was
// not**, and ADR 003 §7 records the amendment in so many words:
//
//   > Amended 2026-08-27 — gate 1 is OWED, not held. Owner: WP-8 / LZP-1002. Neither
//   > `src/js/platform/net.js` nor `tests/tier1/network-scope.test.js` exists, and
//   > `tests/helpers/purity.js`'s `PURE_DIRS` … never scans `src/js/` as a whole. At HEAD the
//   > property is **vacuously** true … it is the one that would have caught
//   > `src/js/platform/updater.js` arriving unscanned — see finding **F-9**.
//
// This is that file. It is deliberately about the SOURCE TREE rather than about a running app:
// a runtime spy (LZP-1002's other half) proves the session you scripted made no request; a grep
// over every shipped module proves no session CAN.
//
// FOUR THINGS ARE ASSERTED HERE, AND THE FOURTH IS THE ONE THAT KEEPS THE OTHER THREE HONEST:
//   §1  no network identifier appears anywhere under `src/js/` outside `platform/net.js`
//   §2  `net.js` is unreachable from the boot / first-run / main import graph (gate 2)
//   §3  the shipped CSP still forbids off-origin traffic in SOLO mode (gate 4), the one origin
//       is reached over TLS or is this Mac (finding **P-7**), and a bridge reply that came from
//       somewhere else is refused (finding **P-5**)
//   §4  the scanner can actually find a call site — planted ones, in every spelling
//
// §3's last two rows arrived in WP-9 and are here rather than only in `tests/attack/` for the
// reason the round-5 and round-7 FINDINGS updates both had to correct: "the row lived only in
// tests/attack/" is how a rule gets removed by a one-line convenience patch nobody reviews.
//
// §4 exists because every gate of this shape has the same failure mode: it goes green the day
// its regex stops matching anything, and nobody notices, because green is what it looked like
// when it worked. F-9 is exactly that failure, one directory over.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  networkCallSites, allowedCallSites, shippedFiles, scanSource, shippedCsp,
  ALLOWED, NETWORK_IDENTIFIERS, SCAN_ROOT,
} from '../helpers/netscope.js';
import {
  pathToPrefix, staticPathToPrefix, dynamicDoorsFrom, reachableFrom,
} from '../helpers/importgraph.js';
import {
  PATH_RE, PATH_PREFIX, normalizeOrigin, isLoopbackHost, createBridgeTransport, NetError,
} from '../../src/js/platform/net.js';

// ═════════════════════════════════════════════════════════════════════════════
// §1. GATE 1 — one call site, in the whole shipped tree
// ═════════════════════════════════════════════════════════════════════════════

describe('gate 1 — src/js/ has exactly one network call site', () => {
  test('no module under src/js/ names fetch, XHR, WebSocket, EventSource or sendBeacon', () => {
    const hits = networkCallSites();
    assert.deepEqual(
      hits.map((h) => `${h.file}:${h.line} ${h.ident} — ${h.text}`),
      [],
      'ADR 005 §5 rule 4: platform/net.js is the ONLY fetch call site. '
      + 'If one of these is legitimate, it needs an ADR, not an entry in ALLOWED.'
    );
  });

  test('the scan really did read the whole tree, platform/ and the DOM layer included', () => {
    // F-9 in one assertion. `purity.js`'s PURE_DIRS is core / crypto / sync / server-core, so a
    // gate written on top of it would scan neither `src/js/platform/` (where the updater and this
    // module live) nor `src/js/*.js` (the DOM layer, where a convenience `fetch` would actually
    // be written). This asserts the scope is the whole of src/js/, by naming files from each.
    const rels = shippedFiles().map((f) => f.rel);
    assert.equal(SCAN_ROOT, 'src/js');
    assert.ok(rels.length > 30, `only ${rels.length} files scanned — the walker stopped working`);
    for (const must of [
      'src/js/main.js',                 // the DOM layer
      'src/js/store.js',                // the seam
      'src/js/platform/updater.js',     // THE file F-9 is about
      'src/js/platform/net.js',
      'src/js/core/oplog.js',
      'src/js/crypto/envelope.js',
    ]) {
      assert.ok(rels.includes(must), `${must} was not scanned`);
    }
  });

  test('the allowlist is exactly one file, and that file really is a call site', () => {
    // A gate whose allowlist grows is a gate that has stopped meaning anything, and a gate whose
    // one allowed file contains no call site is a gate that would pass over an empty tree.
    assert.deepEqual([...ALLOWED], ['src/js/platform/net.js']);
    const inNet = allowedCallSites();
    assert.ok(inNet.length >= 1, 'net.js contains no network call at all — the gate is vacuous');
    assert.deepEqual([...new Set(inNet.map((h) => h.file))], ['src/js/platform/net.js']);
    assert.ok(inNet.some((h) => h.ident === 'fetch'), 'net.js must be where the fetch is');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §2. GATE 2 — never loaded in solo mode
// ═════════════════════════════════════════════════════════════════════════════

describe('gate 2 — solo mode cannot even evaluate the module', () => {
  /** The three modules a solo launch may not evaluate, and the one door that reaches them. */
  const FORBIDDEN = ['src/js/platform/net.js', 'src/js/sync/', 'src/js/crypto/', 'src/js/family/'];
  const ENTRIES = ['src/js/boot.js', 'src/js/firstrun.js', 'src/js/main.js'];
  const THE_DOOR = 'src/js/family/mount.js';

  test('no STATIC import reaches net.js, sync/, crypto/ or family/ from the boot graph', () => {
    // ADR 003 §7 gate 2: "`net.js` and the whole of `src/js/sync/` are reached only through a
    // dynamic `await import()` gated on … spaces.personal || spaces.family. In solo mode the
    // modules are never evaluated, so there is no code path to a request even under a bug
    // elsewhere." ADR 002 §2.4 says the same about `crypto/`.
    //
    // THAT IS A CLAIM ABOUT **STATIC** REACHABILITY, and this row is the version of it that can
    // actually hold. A static import is evaluated the moment the boot graph loads, whether or not
    // anybody calls the function; a dynamic one is evaluated when, and only when, the line runs.
    // An earlier form of this test asserted "no path of EITHER kind", which made the ADRs' own
    // design unimplementable — and the way that gets resolved in practice is by hiding the
    // specifier from the walker (a computed string, a variable), which turns a real gate into a
    // vacuous one. So the walker sees the door; the next row counts it.
    for (const entry of ENTRIES) {
      for (const prefix of FORBIDDEN) {
        const chain = staticPathToPrefix(entry, prefix);
        assert.equal(chain, null, chain ? `solo mode statically reaches ${prefix}: ${chain.join(' -> ')}` : '');
      }
    }
  });

  test('there is EXACTLY ONE dynamic door out of the boot graph, and it is family/mount.js', () => {
    // The failure mode this row exists for is not a missing `if`. It is a SECOND DOOR: one
    // convenience `await import()` in settings.js "just to draw the section", one in main.js
    // "just for the glyph", and solo mode is loading crypto/ again with nobody noticing, because
    // each door on its own looked lazy. One door can be read; three cannot.
    for (const entry of ENTRIES) {
      const doors = dynamicDoorsFrom(entry);
      assert.deepEqual(
        doors.map((d) => `${d.from} -> ${d.to}`),
        entry === 'src/js/firstrun.js' ? [] : [`src/js/main.js -> ${THE_DOOR}`],
        `${entry}: the dynamic doors out of the eagerly-evaluated graph`,
      );
    }
  });

  test('and the door really does lead somewhere — the gate is not passing over an empty tree', () => {
    // Without this, the two rows above are satisfiable by deleting family mode. The door must
    // reach every module the gate above forbids, or it is not the door.
    for (const prefix of ['src/js/platform/net.js', 'src/js/sync/', 'src/js/crypto/']) {
      const chain = pathToPrefix(THE_DOOR, prefix);
      assert.notEqual(chain, null, `${THE_DOOR} does not reach ${prefix} at all`);
    }
    const reached = reachableFrom(THE_DOOR).reached;
    assert.ok(reached.includes('src/js/sync/personal.js'), 'the engine is behind the door');
    assert.ok(reached.includes('src/js/family/pairingui.js'), 'the pairing screens are behind the door');
  });

  test('the gate is armed: a static import planted in main.js WOULD be reported', () => {
    // The mutation, reasoned rather than run, because the walker reads the real tree: the only
    // way `staticPathToPrefix` returns null for every entry and every prefix is if no static edge
    // exists. Proved by pointing it at a module that DOES import them statically.
    const chain = staticPathToPrefix(THE_DOOR, 'src/js/crypto/');
    assert.notEqual(chain, null, 'the static walker cannot find a static edge that exists');
    assert.equal(chain[0], THE_DOOR);
  });

  test('net.js drags no crypto module in behind it — the sign port is injected', () => {
    // `tests/tier1/crypto-identity.test.js`'s PRINCIPLE 7 gate fails if anything under
    // `src/js/crypto/` is reachable from the boot graph. net.js is now inside that graph's ONE
    // dynamic door, so net.js must not be a second path into crypto: the ECDSA operation is a
    // `sign(bytes)` port, bound in one line at the family opt-in moment.
    const chain = pathToPrefix('src/js/platform/net.js', 'src/js/crypto/');
    assert.equal(chain, null, chain ? `net.js reaches crypto: ${chain.join(' -> ')}` : '');
    const reached = reachableFrom('src/js/platform/net.js').reached;
    assert.ok(reached.includes('src/js/core/b64.js'), 'the import walker found nothing at all');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §3. GATE 4 — the CSP, and what family mode did NOT change
// ═════════════════════════════════════════════════════════════════════════════

describe('gate 4 — the shipped CSP', () => {
  test("solo mode's policy is untouched: connect-src is 'self' and names no remote host", () => {
    // THE FINDING, PINNED. ADR 003 §7 gate 4 sketches
    // `connect-src 'self' ipc: http://ipc.localhost https://<sync-host>`. Implementing that
    // literally would relax the policy of every SOLO install for a request solo mode must never
    // make — a `<meta>` CSP is one static string and cannot be conditional on a space existing.
    // The shipping answer is instead the SHELL (ADR 003 §7 gate 3, and E1's own conclusion for
    // the updater), so the CSP diff for family mode is empty. See `platform/net.js`'s header for
    // the two-line change and its price, should the PO ever choose the other way.
    const { meta, tauri } = shippedCsp();
    assert.ok(meta, 'index.html ships no CSP meta tag at all');
    assert.match(meta, /default-src 'self'/);
    assert.match(meta, /connect-src 'self'(;|$)/, "connect-src must be exactly 'self' in the document");
    assert.equal(/https?:\/\/(?!ipc\.localhost)/.test(meta), false,
      `the document CSP names a remote host: ${meta}`);
    assert.ok(tauri, 'src-tauri/tauri.conf.json ships no CSP');
    assert.match(tauri, /connect-src 'self' ipc: http:\/\/ipc\.localhost(;|$)/,
      "the Tauri CSP may name only 'self' and Tauri's own IPC origin");
    assert.equal(/https:\/\//.test(tauri), false, `the Tauri CSP names an https host: ${tauri}`);
  });

  test('the one origin a transport may address is one origin, and every path is /api/v1/…', () => {
    // The other half of "exactly one sync endpoint": even inside the allowed origin, a path is
    // not free-form. Anything that could carry a scheme, a host, a `..`, a query or a fragment
    // is refused before a request is built.
    assert.equal(PATH_PREFIX, '/api/v1/');
    for (const good of ['/api/v1/ops', '/api/v1/meta', '/api/v1/spaces/fsp_9xQ2mR7bL0aZ4tV8wK/keys']) {
      assert.equal(PATH_RE.test(good), true, `${good} should be reachable`);
    }
    for (const bad of [
      '/api/v2/ops', '/ops', 'api/v1/ops', '/api/v1', '/api/v1/', '/api/v1/../../etc',
      '/api/v1/ops?x=1', '/api/v1/ops#frag', '//evil.example/api/v1/ops',
      'https://evil.example/api/v1/ops', '/api/v1/ops/../../..',
    ]) {
      assert.equal(PATH_RE.test(bad), false, `${bad} must NOT be reachable`);
    }
  });

  test('and the one origin is reached over TLS, or it is this Mac — finding P-7', () => {
    // GATE 4's OTHER HALF, and it is not the CSP's.
    //
    // The CSP row above is about what the DOCUMENT may connect to, and for family mode the
    // answer is "nothing new" — the shell transports (gate 3), so there is no host to allowlist.
    // That leaves the question the CSP was never going to answer: the origin is a FREE-TEXT
    // FIELD, saved on every keystroke, and it alone decides where the whole personal board goes.
    // `normalizeOrigin` used to accept `http://` for every host, which made
    // `server-metadata.md` §8's "TLS in transit" false for one mistyped scheme — and false about
    // everything §2 and §5 enumerate: the space id, the deviceShort, the read cursor, the op and
    // byte counts, the timing of every edit, the `Authorization` header. The content survives
    // (it is sealed before it reaches a transport); the metadata does not.
    //
    // `platform/updater.js`'s `checkUrl` has refused anything but `https:` by name since E1 for
    // a single signed manifest. This is that rule at the larger exposure, with the one carve-out
    // the updater does not need: a loopback host is this Mac talking to itself and is where
    // `node dev-server.mjs` lives.
    //
    // It is in TIER 1 and not only in the adversary suite because it is the kind of rule a
    // future "just let me point it at my LAN box" patch removes in one line.
    for (const remote of [
      'http://relay.example', 'http://192.0.2.7:8787', 'http://127.0.0.1.evil.example',
      'http://localhost.evil.example', 'http://[2001:db8::1]', 'http://128.0.0.1',
    ]) {
      assert.throws(() => normalizeOrigin(remote), (e) => e instanceof NetError && e.kind === 'config',
        `normalizeOrigin accepted ${remote} — the board's metadata would cross the wire in the clear`);
    }
    for (const mine of [
      'http://127.0.0.1:8788', 'http://127.9.9.9', 'http://localhost:5173',
      'http://relay.localhost:8787', 'http://[::1]:8788',
    ]) {
      assert.equal(normalizeOrigin(mine), mine, `${mine} is this Mac and must stay reachable`);
    }
    assert.equal(normalizeOrigin('https://relay.example'), 'https://relay.example');
    assert.equal(normalizeOrigin('app://localhost'), 'app://localhost');

    // The predicate is over `URL.hostname` and not over the raw string, which is the difference
    // between a rule and a substring match. Both directions, so a loosened regex is caught.
    for (const yes of ['localhost', 'a.localhost', '127.0.0.1', '127.0.0.255', '[::1]']) {
      assert.equal(isLoopbackHost(yes), true, yes);
    }
    for (const no of ['127.0.0.1.evil.example', 'localhost.evil.example', '127.0.0.256', '::1', '']) {
      assert.equal(isLoopbackHost(no), false, no);
    }
  });

  test('the bridge reply says where it came from, and a stranger is refused — finding P-5', async () => {
    // GATE 3 IS THE SHELL'S, AND THIS IS THE PAGE'S HALF OF IT.
    //
    // On the `fetch` path `redirect: 'error'` makes the platform refuse a 302, so the signed
    // request cannot be replayed at a destination the relay chose. On the SHIPPING path — the
    // bridge — that was a sentence in a comment: the reply carried a status and a body and not
    // the URL they came from, so a shell that followed a redirect (`URLSession` follows them by
    // default) was undetectable from JS. The reply now carries the final url and a mismatch is
    // `blocked` before the body is parsed.
    const mk = (reply) => createBridgeTransport({
      origin: 'https://relay.example', deviceShort: 'CHFBZPVRBG6M14TJ',
      sign: async () => new Uint8Array(64), clientVersion: '2.0.3',
      subtle: globalThis.crypto.subtle, now: () => 1787836800000, random: (n) => new Uint8Array(n),
      invoke: async () => reply,
    });
    const OK = { status: 200, headers: {}, body: '{}' };
    await assert.rejects(
      () => mk({ ...OK, url: 'https://evil.example/api/v1/meta' }).request('GET', '/api/v1/meta'),
      (e) => e instanceof NetError && e.kind === 'blocked');
    await assert.rejects(
      () => mk({ ...OK, redirected: true }).request('GET', '/api/v1/meta'),
      (e) => e instanceof NetError && e.kind === 'blocked');
    assert.deepEqual(
      await mk({ ...OK, url: 'https://relay.example/api/v1/meta' }).request('GET', '/api/v1/meta'),
      { status: 200, headers: {}, json: {} });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §4. THE SCANNER ITSELF — the assertion that keeps §1 from going quietly vacuous
// ═════════════════════════════════════════════════════════════════════════════

describe('the scanner finds what it claims to find', () => {
  test('every network identifier is caught, in the spellings a real call site takes', () => {
    const planted = [
      "await fetch('/x');",
      'const f = globalThis.fetch; await f(u);',
      'const r = new XMLHttpRequest();',
      "const s = new WebSocket('wss://x');",
      "new EventSource('/y');",
      "navigator.sendBeacon('/z', b);",
      "importScripts('/w.js');",
    ];
    planted.forEach((line, i) => {
      const hits = scanSource('scratch.js', line);
      assert.ok(hits.length > 0, `line ${i} slipped past the scanner: ${line}`);
    });
    assert.equal(NETWORK_IDENTIFIERS.length, 6, 'an identifier was removed from the list');
  });

  test('prose and string literals do not trip it, and near-misses are not caught', () => {
    // The other way this gate dies: it goes red on a comment, someone loosens the regex, and the
    // loosened regex stops matching the real thing. Both halves are pinned.
    const benign = [
      '// this module performs no fetch of any kind',
      "const label = 'fetch';",
      '/* WebSocket is deliberately not used here */',
      'const staged = await port.fetchManifest();',   // updater.js — a PORT method, not a call
      'const fetchImpl = deps.fetchImpl || null;',    // net.js — an injected double
      'function prefetchLayout() {}',
    ];
    for (const line of benign) {
      assert.deepEqual(scanSource('scratch.js', line), [], `false positive on: ${line}`);
    }
  });

  test('a call site planted in a real shipped file WOULD be reported', () => {
    // The mutation, run rather than imagined: take a file the gate covers, add one line, and
    // require the gate to name it. Without this the whole file could be passing because the walk
    // returns nothing.
    const store = shippedFiles().find((f) => f.rel === 'src/js/store.js');
    assert.ok(store, 'store.js was not scanned');
    const mutated = store.src + "\nasync function phoneHome() { await fetch('https://x/'); }\n";
    const hits = scanSource(store.rel, mutated);
    assert.equal(hits.length, 1, 'the planted call site was not reported');
    assert.equal(hits[0].ident, 'fetch');
    assert.equal(hits[0].file, 'src/js/store.js');
  });
});
