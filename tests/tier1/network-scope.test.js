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
// §5's scanner blanks comments and string literals with the SAME function `netscope.js` uses, so
// the two gates cannot disagree about what counts as code — `netscope.js`'s own header gives the
// reason, and it applies twice over to a rule about who may call something.
import { stripCommentsAndStrings } from '../helpers/purity.js';
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

  test('there are EXACTLY TWO dynamic doors out of the boot graph, and each is named', () => {
    // ─────────────────────────────────────────────────────────────────────────────────────────
    // ██ REVERSED 2026-09-05 · LZP-1009 SECOND PASS · PO decision 1 ██
    // ─────────────────────────────────────────────────────────────────────────────────────────
    //
    // WHAT THIS ROW SAID, VERBATIM, AND WHY IT SAID IT:
    //
    //   > 'there is EXACTLY ONE dynamic door out of the boot graph, and it is family/mount.js'
    //   > The failure mode this row exists for is not a missing `if`. It is a SECOND DOOR: one
    //   > convenience `await import()` in settings.js "just to draw the section", one in main.js
    //   > "just for the glyph", and solo mode is loading crypto/ again with nobody noticing,
    //   > because each door on its own looked lazy. One door can be read; three cannot.
    //
    // THAT REASONING IS STILL CORRECT AND IS NOT BEING SOFTENED. What changed is the product:
    // the PO ruled on 2026-09-04/05 that **a solo Mac may send a report**, because the report
    // that matters most — „ich komme nicht mehr rein" — can only be written by somebody who has
    // no Familienkreis. A screen that collects that sentence and then greys out „Senden" is a
    // screen that fails in exactly the case it exists for.
    //
    // A solo sender needs a transport. There are only two places to put one:
    //   (a) behind `family/mount.js` — which would put `crypto/`, `sync/` and the whole of family
    //       mode on a solo Mac's evaluation path. That is the thing gate 2 forbids, and it would
    //       have been the ONE-DOOR answer;
    //   (b) behind a second, NARROWER door that opens onto `platform/net.js` and nothing else.
    //
    // (b) is strictly better for the property this gate protects, and the count is the wrong
    // metric for saying so — which is why the row is now a NAMED SET rather than a number. Two
    // doors that are each read and each bounded beat one door that leads everywhere. The
    // convenience-import failure mode the old comment names is caught by the deepEqual below
    // exactly as it was before: an `await import()` in settings.js "just to draw the section"
    // adds a third entry and turns this red.
    //
    // The next row is what makes this a reversal and not a relaxation: the new door must NOT
    // reach `crypto/`, `sync/` or `family/`. The old door may; the new one may not.
    const doors = ['src/js/feedback/relay.js -> src/js/platform/net.js',
      `src/js/main.js -> ${THE_DOOR}`];
    for (const entry of ENTRIES) {
      assert.deepEqual(
        dynamicDoorsFrom(entry).map((d) => `${d.from} -> ${d.to}`),
        entry === 'src/js/firstrun.js' ? [] : doors,
        `${entry}: the dynamic doors out of the eagerly-evaluated graph`,
      );
    }
  });

  test('the SECOND door is the narrow one: relay.js reaches net.js and nothing else forbidden', () => {
    // THE NON-VACUITY HALF OF THE REVERSAL, and the row that makes the count above safe to raise.
    //
    // `family/mount.js` is allowed to reach crypto/, sync/ and family/ — that is what family mode
    // IS, and the row below it asserts the door really leads there. `feedback/relay.js` is not.
    // Its whole justification is that `net.js#buildRequest` with `anonymous: true` skips
    // `signRequest` AND the `cfg.subtle` check, so a sender that signs nothing needs
    // `platform/net.js` plus `core/b64.js` and no more. If that ever stops being true — one
    // static edge into `src/js/crypto/` added "so the report has a thread handle" — this row goes
    // red and the second door has quietly become the first door again.
    const NEW_DOOR = 'src/js/feedback/relay.js';
    for (const prefix of ['src/js/crypto/', 'src/js/sync/', 'src/js/family/']) {
      const chain = pathToPrefix(NEW_DOOR, prefix);
      assert.equal(chain, null,
        chain ? `the solo sender's door now reaches ${prefix}: ${chain.join(' -> ')}` : '');
    }
    // …and it is genuinely a door: net.js is reached DYNAMICALLY from it, never statically, so a
    // Mac with no origin pinned does not evaluate the network stack even once.
    assert.equal(staticPathToPrefix(NEW_DOOR, 'src/js/platform/net.js'), null,
      'relay.js now imports net.js statically — the door is propped open');
    assert.notEqual(pathToPrefix(NEW_DOOR, 'src/js/platform/net.js'), null,
      'relay.js does not reach net.js at all — the walker has stopped seeing the door');
    // The whole module graph behind the new door, enumerated rather than bounded, because a set
    // of five is small enough to read and an assertion about a set cannot rot into a nonempty
    // check that passes over anything.
    assert.deepEqual(reachableFrom(NEW_DOOR).reached.slice().sort(), [
      'src/js/core/b64.js',
      'src/js/core/ids.js',
      'src/js/feedback/port.js',
      'src/js/feedback/relay.js',
      'src/js/platform/net.js',
    ]);
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

// ═════════════════════════════════════════════════════════════════════════════
// §5. THE AMENDMENT — 21.5's ONE exception, and the only thing that can trigger it
// ═════════════════════════════════════════════════════════════════════════════
//
// ─────────────────────────────────────────────────────────────────────────────
// ██ WHAT CHANGED, WHO CHANGED IT, AND WHY THIS SECTION IS NOT A RELAXATION ██
// ─────────────────────────────────────────────────────────────────────────────
//
// OLD (story 21.5, and the sentence at the top of this file):
//
//   > "in solo mode the app makes zero network requests; with a Familienkreis it talks to
//    exactly one sync endpoint and nothing else."
//
// NEW (story 21.5 as amended, decided by the PO on 2026-09-03 · ADR 003 §7.5 · D10):
//
//   > "in solo mode the app makes zero UNREQUESTED network requests — the only request a solo
//    copy can originate is the one a human asks for, by pressing „Senden" on the Rückmeldung
//    screen; with a Familienkreis it talks to exactly one sync endpoint and nothing else."
//
// LZP-1009 made „Rückmeldung senden" the first network request a solo copy of this app can ever
// make. The measured property therefore had to move, and **amending a measured property is
// exactly the quiet erosion a conformance sweep hunts for** — B-14 caught gate 1 being vacuous
// the same way. So the amendment is not a softer sentence; it is a NARROWER one, and this
// section is what makes it narrower:
//
//   the old wording bounded a COUNT (zero).
//   the new wording bounds an ORIGINATOR (a human press, and nothing else).
//
// A count is checked by looking; an originator is checked by construction, and that is the whole
// design of §5. **The failure mode this section exists for is not a second endpoint — §2c of
// `tests/attack/e10-network-scope.test.js` counts those. It is a SECOND CALLER**: one
// `setInterval` "so a stuck report retries", one `window.addEventListener('online', …)` "so it
// goes out when the wifi comes back", one `unhandledrejection` handler that files a report by
// itself — and a solo Mac is sending unattended, with every endpoint gate still green, because
// each of those on its own looked like a courtesy.
//
// THAT IS A REGRESSION AND §5d IS THE ROW THAT DETECTS IT. It is run, not reasoned: four
// automatic callers are planted in the real module's real source and each must be named.
//
// The two structural facts that make this checkable at all, both owned by `feedback/port.js`:
//   · the sender is a PORT — nothing under `src/js/feedback/` can open a socket (§1 covers that),
//     so the only way to send is to hold the port;
//   · the only way to hold it is `feedbackPort()`, and §5a bounds who may import that.

const FEEDBACK_PORT = 'src/js/feedback/port.js';
const THE_SCREEN = 'src/js/feedback/ui.js';

/** Resolve a relative specifier against a repo-relative module path. Pure string work. */
function resolveRel(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  const parts = fromRel.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Every shipped module that imports `feedback/port.js`, with the names it takes from it.
 * Comments are stripped first, so the binding written out verbatim in `port.js`'s own header
 * (it is a docblock, not an edge) is not counted as an importer.
 */
function portImporters() {
  const out = [];
  for (const f of shippedFiles()) {
    const code = f.src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const m of code.matchAll(/import\s*(\{[^}]*\})?\s*from?\s*(['"])([^'"]+)\2/g)) {
      if (resolveRel(f.rel, m[3]) !== FEEDBACK_PORT) continue;
      const names = (m[1] || '').replace(/[{}]/g, '').split(',')
        .map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      out.push({ file: f.rel, names });
    }
  }
  return out;
}

/** The enclosing named function of a line, found by walking backwards. */
function enclosingFn(lines, i) {
  for (let j = i; j >= 0; j--) {
    const m = lines[j].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/)
      || lines[j].match(/^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/);
    if (m) return m[1];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ██ GENERALISED 2026-09-05 · LZP-1009 SECOND PASS · the third of §4.5's three blind rows ██
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// WHAT THE SCANNER USED TO MATCH, VERBATIM: `/\.\s*send\s*\(/` — and nothing else.
//
// That was correct for exactly as long as `port.send` was the only way this product could put
// bytes on a wire. LZP-1009's second pass adds a second one: the operator's reports reader in
// `src/js/feedback/relay.js` calls **`transport.request(`**, three times, for three routes. A row
// that scans for `.send(` cannot see any of them. It would have stayed GREEN over a whole new
// transport — which is the E10-1009-B failure shape this project has now hit twice, and the
// reason this comment exists rather than a quiet regex edit.
//
// TWO THINGS CHANGE, AND THE SECOND IS WHAT KEEPS THE FIRST HONEST:
//
//  1. DISPATCH matches every dispatcher spelling this product has — `.send(` and `.request(`.
//
//  2. The SCOPE becomes the SOLO-REACHABLE TREE: every shipped module except `src/js/sync/`,
//     `src/js/crypto/` and `src/js/family/`. Those three are precisely the directories gate 2
//     proves a solo launch cannot evaluate, and they are full of legitimately automatic
//     `.request(` callers — a sync engine that only pushed when someone clicked would not be a
//     sync engine. They are governed by the OTHER half of story 21.5 ("with a Familienkreis it
//     talks to exactly one sync endpoint"), which `tests/attack/e10-network-scope.test.js`
//     bounds. Scoping here is therefore not an exemption: it is naming which promise each module
//     is under. A module that moves OUT of those three directories moves into this scan.
//
// A THIRD CLASSIFICATION arrives with the reader, because the reader has a shape the sender did
// not: a dispatcher HANDED ON under a property name (`send: async (body) => …`,
// `list: () => dispatch(…)`). That line is an installation, not a trigger — the trigger is
// whoever calls the property later. Classifying it `automatic` would make the gate cry wolf,
// which is how a gate gets deleted; classifying it `human` would be a lie. It is `handed-on`,
// it is enumerated by name in §5b, and a FOURTH one appearing is a red row.

/** The three directories gate 2 proves solo mode cannot evaluate. Out of scope for §5b — see above. */
const BEHIND_THE_DOORS = /^src\/js\/(?:sync|crypto|family)\//;

/** Every dispatcher spelling in this product: the feedback port's, and the transport's. */
const DISPATCH = /\.\s*(?:send|request)\s*\(/;

/** `name: (…) => …` / `name: async (…) => …` — a dispatcher installed under a property name. */
const HANDED_ON = /^\s*(\w+)\s*:\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>/;

/** Anything that would fire a call without a person. Read on the call site's own few lines. */
const AUTO_TRIGGER =
  /\b(?:setInterval|setTimeout|requestIdleCallback|requestAnimationFrame|queueMicrotask)\s*\(|addEventListener\s*\(\s*['"](?:online|offline|visibilitychange|load|DOMContentLoaded|beforeunload|unload|pagehide|error|unhandledrejection|message)['"]/;

/** Does any of the few lines ending at `i` match `re`? The window a wrapper can hide in. */
function windowHas(lines, i, re) {
  for (let j = i; j >= 0 && j > i - 4; j--) if (re.test(lines[j])) return true;
  return false;
}

/**
 * ██ THE SCANNER THE AMENDMENT RESTS ON ██
 *
 * Every way a dispatcher can be reached in one module, and what pulls the trigger.
 * Returns one row per CALL SITE of the function that invokes a dispatcher, classified `human`
 * when a click/keyboard listener is what calls it, `handed-on` when the dispatcher is being
 * installed under a property name rather than triggered, and `automatic` otherwise — a timer, a
 * network or lifecycle event, an error handler, or a bare top-level call.
 *
 * Deliberately classifies "anything I do not recognise as a human gesture" as AUTOMATIC, so a
 * novel trigger fails loudly rather than passing quietly. That is the direction this gate has to
 * fail in: `netscope.js`'s own header records what happens when a matcher stops matching.
 */
function sendOriginators(src) {
  // TWO VIEWS OF THE SAME LINE NUMBERS, and the split is the whole subtlety of this function.
  //
  // DETECTION runs on the blanked source, for `netscope.js`'s reason: a `.send(` named in a
  // comment or inside a string is not a call, and a gate that goes red on prose gets loosened
  // until it matches nothing. CLASSIFICATION runs on the RAW line, because the thing that says
  // whether a caller is a person IS a string literal — `addEventListener('click', …)` — and the
  // blanker had already eaten it. The first draft of this scanner classified the product's one
  // real human press as AUTOMATIC for exactly that reason.
  //
  // `stripCommentsAndStrings` replaces characters in place and preserves newlines, so the two
  // arrays are index-aligned; `netscope.js:scanSource` depends on the same property.
  const raw = src.split('\n');
  const lines = stripCommentsAndStrings(src).split('\n');
  const senders = new Set();
  const rows = [];
  const HUMAN = /addEventListener\s*\(\s*['"](?:click|keydown|keypress|keyup|submit|change)['"]|\bonclick\b/;
  lines.forEach((l, i) => {
    if (!DISPATCH.test(l)) return;
    // A TRIGGER WRAPPED AROUND THE CALL IS STILL A TRIGGER, whatever it is bound to. This clause
    // is here because the mutant `tick: () => setInterval(() => dispatch(…), 1000)` in §5d was
    // classified `handed-on` by the first draft of this function — the property binding was read
    // and the timer between it and the call was not. Run, not reasoned: the mutant found it.
    if (windowHas(lines, i, AUTO_TRIGGER)) {
      rows.push({ fn: enclosingFn(lines, i) || '<top level>', line: i + 1, kind: 'automatic', text: raw[i].trim() });
      return;
    }
    // Walk back to whichever comes FIRST: a property binding (the dispatcher is being handed on)
    // or a named function (the dispatcher is being called, and the callers are the originators).
    const handed = handedOnBinding(lines, i);
    if (handed) { rows.push({ fn: handed, line: i + 1, kind: 'handed-on', text: raw[i].trim() }); return; }
    const fn = enclosingFn(lines, i);
    if (fn) senders.add(fn);
  });
  for (const fn of senders) {
    const def = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:function\\s+${fn}\\b|const\\s+${fn}\\s*=)`);
    lines.forEach((l, i) => {
      if (def.test(l)) return;
      // A REFERENCE IS A CALLER. `\\b${fn}\\s*\\(` was the first form of this line and M-crash
      // (§5d) killed it: `setTimeout(autoReport, 0)` and `addEventListener('online', autoReport)`
      // dispatch the function without ever writing a `(` after its name, which is precisely the
      // shape an "…and retry it in the background" patch takes. The mutant found that, not a
      // review.
      if (!new RegExp(`\\b${fn}\\b`).test(l)) return;
      // ORDER MATTERS, and the order is the mutant's doing. `handed-on` is checked SECOND, after
      // the trigger, because `tick: () => setInterval(() => dispatch(…), 1000)` is a property
      // binding AND a timer, and the first draft of this function reported it as the harmless one.
      const handed = HANDED_ON.test(lines[i]) ? lines[i].match(HANDED_ON)[1] : null;
      const kind = AUTO_TRIGGER.test(lines[i]) ? 'automatic'
        : handed ? 'handed-on'
          : HUMAN.test(raw[i]) ? 'human' : 'automatic';
      rows.push({ fn: (kind === 'handed-on' && handed) || fn, line: i + 1, kind, text: raw[i].trim() });
    });
  }
  return rows;
}

/**
 * The property name a dispatcher call is being installed under, or `null` when the call is inside
 * an ordinary named function. Walks back at most a handful of lines: a property binding whose
 * arrow body contains the call is written immediately above it, whereas a named function may be
 * many lines up. Stopping at the first `function`/`const` definition is what keeps the two apart.
 */
function handedOnBinding(lines, i) {
  for (let j = i; j >= 0 && j > i - 6; j--) {
    const m = lines[j].match(HANDED_ON);
    if (m) return m[1];
    if (/^\s*(?:export\s+)?(?:async\s+)?function\s+\w+/.test(lines[j])) return null;
    if (/^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s*)?\(/.test(lines[j])) return null;
  }
  return null;
}

describe('the amendment — the one exception is a human press, and it stays one', () => {
  test('§5a · only the Rückmeldung SCREEN can obtain the sender; everyone else may only bind it', () => {
    // The structural half. `port.js` exports a setter (`setFeedbackPort`), a boolean (`canSend`),
    // a constant (`FEEDBACK_PATH`) and ONE getter — `feedbackPort()`, which is the only way to
    // reach `send` at all. A module that imports the setter is a BINDER (`family/mount.js` owes
    // exactly that line — E10-1009-A) and can originate nothing. A module that imports the
    // GETTER can send, and there may be exactly one of those.
    const importers = portImporters();
    assert.ok(importers.length > 0, 'nothing imports the port at all — the feature is gone');
    const holders = importers.filter((i) => i.names.includes('feedbackPort')).map((i) => i.file);
    assert.deepEqual(holders, [THE_SCREEN],
      'a second module can now obtain the feedback sender. 21.5 as amended permits ONE originator, '
      + 'and it is the screen with the „Senden" button on it.');
    for (const i of importers) {
      for (const n of i.names) {
        assert.ok(['setFeedbackPort', 'feedbackPort', 'canSend', 'FEEDBACK_PATH'].includes(n),
          `${i.file} imports ${n} from the port — the port grew an export nothing here knows about`);
      }
    }
  });

  test('§5b · every dispatcher in the solo-reachable tree, and what pulls each trigger', () => {
    // THE AMENDED PROPERTY, MEASURED, over `.send(` AND `.request(` — see the block above the
    // scanner for what this row used to match and why matching only `.send(` would now be green
    // over a whole new transport.
    //
    // Not "the button works" — that is tier 2's. This is: across every module a solo Mac can
    // evaluate, no dispatcher can be triggered by anything but a person.
    const solo = shippedFiles().filter((f) => !BEHIND_THE_DOORS.test(f.rel));
    assert.ok(solo.length > 25, `only ${solo.length} solo-reachable files — the walker stopped working`);

    // (i) THE CALL SITES, ENUMERATED. This half is new, and it is the half that would have caught
    // `relay.js#dispatch` arriving unseen: a dispatcher call anywhere in the solo tree that is not
    // one of these three turns the row red before anybody has to reason about who calls it.
    const sites = [];
    for (const f of solo) {
      stripCommentsAndStrings(f.src).split('\n').forEach((l, i) => {
        if (DISPATCH.test(l)) sites.push(`${f.rel}:${i + 1}`);
      });
    }
    assert.deepEqual(sites, [
      'src/js/feedback/relay.js:198',   // the SOLO sender — POST /api/v1/feedback, anonymous
      'src/js/feedback/relay.js:312',   // the OPERATOR reader — the one dispatcher for all 3 routes
      'src/js/feedback/ui.js:295',      // the screen, through the port it was handed
    ], 'the set of places in this product that can put bytes on a wire has changed. Each of these '
      + 'is one line and each is argued in its own file; a fourth needs the same, not an edit here.');

    // (ii) THE ORIGINATORS. Zero automatic, in the whole solo tree.
    const found = [];
    for (const f of solo) {
      for (const r of sendOriginators(f.src)) found.push({ file: f.rel, ...r });
    }
    const automatic = found.filter((r) => r.kind === 'automatic');
    assert.deepEqual(
      automatic.map((r) => `${r.file}:${r.line} ${r.fn}() — ${r.text}`), [],
      'SOMETHING OTHER THAN A HUMAN CAN NOW ORIGINATE A REQUEST. That is the regression story '
      + '21.5 was amended to forbid, not the thing the amendment permits.');

    // (iii) THE HUMAN PRESS is still exactly one, and it is still „Senden".
    const human = found.filter((r) => r.kind === 'human');
    assert.equal(human.length, 1, `${human.length} human originators, expected 1:\n`
      + human.map((r) => `  ${r.file}:${r.line} ${r.fn}() [${r.kind}]`).join('\n'));
    assert.equal(human[0].file, THE_SCREEN);
    assert.match(human[0].text, /addEventListener\(\s*'click'/);

    // (iv) THE HANDED-ON SET, by name. A dispatcher installed under a property name is not an
    // originator — but a FOURTH one is a fourth thing that can be triggered from somewhere this
    // scanner does not read, so it is enumerated rather than counted away.
    assert.deepEqual(found.filter((r) => r.kind === 'handed-on')
      .map((r) => `${r.file}:${r.line} ${r.fn}`), [
      'src/js/feedback/relay.js:198 send',    // installed on the feedback PORT; §5a bounds who holds it
      'src/js/feedback/relay.js:281 list',    // GET /api/v1/feedback
      'src/js/feedback/relay.js:283 one',     // GET /api/v1/feedback/:id
      'src/js/feedback/relay.js:285 remove',  // POST /api/v1/feedback/:id/delete
    ]);
  });

  test('§5c · the module that DOES listen to the machine cannot reach the sender', () => {
    // `feedback/events.js` is the one module in this subsystem that attaches listeners nobody
    // pressed — `error` and `unhandledrejection`, so that the breadcrumb list in a report is
    // real. That is the single most plausible place a future "…and file it automatically" lands,
    // and it is one import away from being able to. It must not have that import.
    const events = shippedFiles().find((f) => f.rel === 'src/js/feedback/events.js');
    assert.ok(events, 'feedback/events.js was not scanned');
    assert.match(events.src, /addEventListener\('(?:error|unhandledrejection)'/,
      'events.js no longer listens for anything — this row is now watching nothing');
    assert.deepEqual(
      portImporters().filter((i) => i.file === 'src/js/feedback/events.js'), [],
      'the automatic-event collector can now reach the sender');
    // And the general form, over the whole tree: no timer and no lifecycle event names the
    // dispatcher. This is belt-and-braces against a caller §5b's enclosing-function walk misses.
    const bad = [];
    for (const f of shippedFiles()) {
      stripCommentsAndStrings(f.src).split('\n').forEach((l, i) => {
        if (/\b(?:setInterval|setTimeout|requestIdleCallback|queueMicrotask)\s*\([^)]*\bdoSend\b/.test(l)
          || /addEventListener\s*\(\s*['"](?:online|offline|visibilitychange|load|DOMContentLoaded|beforeunload|unload|pagehide|error|unhandledrejection)['"][^)]*\bdoSend\b/.test(l)) {
          bad.push(`${f.rel}:${i + 1} ${l.trim()}`);
        }
      });
    }
    assert.deepEqual(bad, [], 'a timer or a lifecycle event dispatches a report:\n' + bad.join('\n'));
  });

  test('§5d · ARMED — four automatic callers, planted in the real module, and each is named', () => {
    // THE MUTANTS, RUN RATHER THAN REASONED. Without this row §5b is green the day `.send(`
    // stops matching, or the day `enclosingFn` returns null for the real shape of the file — and
    // green is what it looked like when it worked.
    const screen = shippedFiles().find((f) => f.rel === THE_SCREEN);
    assert.ok(screen, 'the Rückmeldung screen was not scanned');

    // The honest-path control FIRST: the real file, unmutated, yields exactly the one human row.
    const honest = sendOriginators(screen.src);
    assert.equal(honest.length, 1, 'the control moved — §5b is measuring something else now');
    assert.equal(honest[0].kind, 'human');

    const MUTANTS = [
      ['M-retry     ', '  setInterval(() => doSend(btn, st), 60000);'],
      ['M-online    ', "  window.addEventListener('online', () => doSend(btn, st));"],
      ['M-onload    ', "  document.addEventListener('DOMContentLoaded', () => doSend(btn, st));"],
      ['M-crash     ', '  function autoReport() { const p = feedbackPort(); return p.send({ v: 1 }); }\n'
                       + '  setTimeout(autoReport, 0);'],
    ];
    for (const [name, line] of MUTANTS) {
      const rows = sendOriginators(`${screen.src}\n${line}\n`);
      const auto = rows.filter((r) => r.kind === 'automatic');
      assert.ok(auto.length >= 1, `${name}: the scanner did not report an automatic caller`);
      assert.equal(rows.filter((r) => r.kind === 'human').length, 1,
        `${name}: the human row disappeared — the mutant broke the scanner instead of tripping it`);
    }

    // And the other direction, so the classifier is not simply calling everything automatic: a
    // SECOND human press is still a human row. (It would fail §5b's count-of-one, which is the
    // right row to fail — one screen, one button.)
    const second = sendOriginators(`${screen.src}\n  extra.addEventListener('click', () => doSend(btn, st));\n`);
    assert.equal(second.filter((r) => r.kind === 'automatic').length, 0,
      'a click listener is being classified as automatic — the gate would cry wolf and be deleted');
    assert.equal(second.length, 2);

    // ─── LZP-1009 SECOND PASS · the SAME battery against the OTHER dispatcher ────────────────
    // §5b now reads `.request(` as well as `.send(`, and a matcher that is never fired at is a
    // matcher nobody has checked. These mutants are planted in `relay.js`'s real source: the
    // reader's `dispatch` is one function and it must not become reachable from a timer either.
    const relay = shippedFiles().find((f) => f.rel === 'src/js/feedback/relay.js');
    assert.ok(relay, 'the relay module was not scanned');

    // The honest-path control, again first: four handed-on rows and NOTHING automatic.
    const relayHonest = sendOriginators(relay.src);
    assert.deepEqual(relayHonest.map((r) => `${r.kind} ${r.fn}`),
      ['handed-on send', 'handed-on list', 'handed-on one', 'handed-on remove'],
      'the control moved — §5b(iv) is measuring something else now');

    for (const [name, line] of [
      ['R-poll     ', '  setInterval(() => dispatch(t, c, \'GET\', \'/api/v1/feedback\'), 30000);'],
      ['R-online   ', "  window.addEventListener('online', () => dispatch(t, c, 'GET', '/x'));"],
      ['R-boot     ', '  const warm = () => dispatch(t, c, \'GET\', \'/x\');\n  warm();'],
    ]) {
      const rows = sendOriginators(`${relay.src}\n${line}\n`);
      assert.ok(rows.some((r) => r.kind === 'automatic'),
        `${name}: an automatic caller of the READER was not reported`);
    }

    // And the OTHER direction for the third classification: `handed-on` must not be a hole a
    // trigger can hide in. A dispatcher call written directly under a property binding is an
    // installation; a TIMER written under one is still a timer, because the timer line itself is
    // what the classifier reads.
    const hole = sendOriginators(`${relay.src}\n  const obj = {\n    tick: () => setInterval(() => dispatch(t, c, 'GET', '/x'), 1000),\n  };\n`);
    assert.ok(hole.some((r) => r.kind === 'automatic'),
      'a setInterval hidden inside a property binding is being read as handed-on');
  });

  test('§5e · the amendment is on the SCREEN, not only in the ADR, and in both languages', () => {
    // A property amended in a document and not in the product is the erosion with an extra step.
    // The Datenschutz section (21.3, LZP-1001) is where a person reads what this app does on a
    // network, so the exception has to be stated there — as a CONDITION on a press, in both
    // languages — or the amended promise is one this product does not actually make.
    const settings = shippedFiles().find((f) => f.rel === 'src/js/settings.js');
    assert.ok(settings, 'settings.js was not scanned');
    // F5(b), 2026-09-04. The two matchers that used to sit here required the sentence
    // "the app originates nothing by itself" in both languages. `boot()` arms `startDailyTimer()`
    // on every launch of every install, so that sentence was FALSE and this row was holding it in
    // place — a gate defending the erosion it exists to catch. What 21.5 actually asks is that the
    // screen ACCOUNT for every originator, so the row now demands the harder thing: the screen
    // must name the automatic one AND state the consent it is gated on, in both languages. A
    // future edit that deletes the update-check disclosure to make the old flat sentence true
    // again turns this row red, which is the direction that matters.
    assert.match(settings.src, /nur, wenn du vorher zugestimmt hast: die[\s\S]{0,80}Update-Prüfung/,
      'the German Datenschutz copy no longer names the automatic update check as the one thing that '
        + 'happens by itself, conditioned on prior consent');
    assert.match(settings.src, /only if you agreed to it beforehand: the update check/,
      'the English Datenschutz copy no longer names it');
    assert.match(settings.src, /nur, wenn du sie auslöst/, 'the German no longer states the condition');
    assert.match(settings.src, /only when you trigger it/, 'the English no longer states the condition');
    // A1: v1's wording survives as the SCOPED guarantee, so the solo paragraph must still be
    // about solo mode and must not have quietly become a paragraph about family mode.
    assert.match(settings.src, /Solange du keinen Familienkreis nutzt, verlässt kein Eintrag diesen Mac/);
  });
});
