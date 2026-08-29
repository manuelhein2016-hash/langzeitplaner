// ATTACK · THE PRIVACY ADVERSARY, 5 of 5 — 21.3 HONESTY.
//
// Story 21.3: "the app documents plainly what the server side can see." The document that
// promise rests on is `docs/v2/server-metadata.md` (LZP-207), which says of itself that it was
// "derived by reading the schema and all 23 handlers — not by reading ADR 003 §5.2", and which
// §9 uses to CORRECT the ADR. It is the input to the Datenschutz copy (LZP-1001), which does not
// exist yet.
//
// **An undocumented observable is a finding against story 21.3.** So this file does the one
// thing that document has never had done to it: it takes the observables from the RUNNING
// CLIENT — the headers it sets, the URLs it builds, the cadence it keeps, the events it wakes on
// — and asks whether each one appears in the document. Every row that does not is a sentence the
// Datenschutz page will be missing.
//
// A note on standing: `server-metadata.md` was written from the SERVER. Everything below is
// something only the client knows, which is exactly why nobody has checked it. Nothing here is a
// criticism of LZP-207's method; it is the half of the surface that method could not reach.
//
// SUCCEEDED / FAILED are from the adversary's point of view: SUCCEEDED means the operator learns
// something the document does not admit to.

import '../helpers/env.js';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import { createFleet } from '../helpers/fleet.js';
import { recordWire, repoFile, repoHas } from '../helpers/privacy-audit.js';
import { HDR, PROTOCOL } from '../../src/js/platform/net.js';
import { CADENCE } from '../../src/js/sync/personal.js';
import { CLIENT_VERSION } from '../../src/js/family/engine.js';

const DOC = 'docs/v2/server-metadata.md';

/** The document, lower-cased, so a match is about content and not about capitalisation. */
const doc = () => repoFile(DOC).toLowerCase();

/** Does the document mention this observable, in any of the spellings it might use? */
const documented = (...spellings) => spellings.some((s) => doc().includes(s.toLowerCase()));

const BOARD = () => ({
  schemaVersion: 1,
  notes: [{ id: 'n0', date: '2027-03-04', text: 'Zahnarzt', categoryId: 'c1', repeatsYearly: false }],
  bars: [], categories: [{ id: 'c1', name: 'Familie', paletteRef: 'gruen', visible: true }],
  scratchpads: {}, settings: { locale: 'de' },
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE HEADERS
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§1 · every request header, against the document', () => {
  test('SUCCEEDED (P-12 CLOSED in the document) — the client stamps its EXACT VERSION on every request, and the document now says so', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-12 · MEDIUM · story 21.3 · `server-metadata.md` has no request-header section.
    //
    // `X-LZP-Client: 2.0.0` rides on every single request. `server-metadata.md` enumerates
    // database COLUMNS (§2), sizes (§4), request PATTERNS (§5), rotations (§6) and transport
    // headers the SERVER sets (§8) — and never once mentions a header the CLIENT sends. There is
    // no §for it.
    //
    // What it gives an operator that §2 does not:
    //
    //   · the exact build running on each `deviceShort`, at every request;
    //   · **the minute each Mac was updated**, as the value changes — which, cross-referenced
    //     with a release date, is a machine-level upgrade timeline for the household;
    //   · a fingerprint that distinguishes two devices even before `Device` rows are joined, and
    //     that survives a device revocation and re-adoption;
    //   · with `X-LZP-Protocol`, the N−1 window this client is inside — i.e. how far behind it is
    //     allowed to be, which is a proxy for how long it has been neglected.
    //
    // It is not a defect in the protocol: ADR 003 §4 needs the version for the N−1 rule, and it
    // is the honest way to run one. It IS an undocumented observable, and the Datenschutz page
    // owes one sentence: „Jede Anfrage nennt die Version der App." Owner: LZP-207 / LZP-1001.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const fleet = await createFleet({ board: BOARD() });
    const rec = recordWire(fleet.wire);
    try {
      await fleet.A.apply('createNotePopover', { id: 'p1', date: '2027-05-06', text: 'x', categoryId: 'c1' });
      await fleet.settle(1);
    } finally {
      rec.restore();
    }

    // What is really sent, on every request without exception.
    const names = new Set(rec.calls.flatMap((c) => Object.keys(c.headers)));
    assert.deepEqual([...names].sort(), ['authorization', 'content-type', 'x-lzp-client', 'x-lzp-protocol']);
    for (const c of rec.calls) {
      assert.equal(c.headers['x-lzp-client'], '2.0.0', 'a request went out without a version');
      assert.equal(c.headers['x-lzp-protocol'], String(PROTOCOL));
    }
    assert.equal(CLIENT_VERSION, '2.0.0');

    // ── INVERTED · P-12 CLOSED ────────────────────────────────────────────────────────────
    // The CAPABILITY above is unchanged and always will be — ADR 003 §4 needs the version for the
    // N−1 rule. What closed is the SILENCE. `server-metadata.md` §5 gained "the headers every
    // request carries", a table with a row per header, and §9 gained a line for each. The row
    // stays here and is now asserted the other way round, so deleting the section reddens it.
    assert.equal(documented('x-lzp-client'), true, 'the client header left the document — re-open P-12');
    assert.equal(documented('x-lzp-protocol'), true);
    assert.equal(documented('client version', 'app version', 'versionsnummer'), true);
    assert.equal(documented('request header', 'anfrage-header'), true);
    // The two inferences that make it more than a version string, named in the document's words.
    assert.ok(documented('the minute each Mac was updated'), 'the upgrade timeline is not named');
    assert.ok(documented('survives a device revocation and re-adoption'), 'the fingerprint is not named');
  });

  test('SUCCEEDED (P-13 CLOSED in the document) — the Authorization header carries the CLIENT CLOCK, and the document now says so', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-13 · LOW · story 21.3.
    //
    // ADR 003 §2's `Authorization` is `LZP1 device=…, ts=…, nonce=…, sig=…`. `ts` is the
    // CLIENT's wall clock in milliseconds, and the server compares it against its own within a
    // 120 s window. The relay therefore reads, on every request, the exact offset between each
    // Mac's clock and its own — a stable per-machine fingerprint that survives everything else,
    // because clock drift is a property of the hardware and of whether the machine syncs NTP.
    //
    // `server-metadata.md` §2 documents the `Nonce` table (the `nonce` half). It never mentions
    // `ts`, and it never mentions that a request declares a client-side time at all. One
    // sentence: „Jede Anfrage nennt die Uhrzeit des Macs, damit alte Anfragen nicht
    // wiederverwendet werden können."
    //
    // LOW because the mitigation and the leak are the same mechanism, and there is no version of
    // this protocol without it.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const fleet = await createFleet({ board: BOARD() });
    const rec = recordWire(fleet.wire);
    try { await fleet.settle(1); } finally { rec.restore(); }

    const auth = rec.calls[0].headers.authorization;
    const ts = /ts=(\d+)/.exec(auth);
    assert.ok(ts, 'the auth header carries no timestamp');
    assert.equal(Number(ts[1]), fleet.clock.now(), 'the value is the client clock, to the millisecond');
    assert.match(auth, /device=[0-9A-Z]{16}/);
    assert.match(auth, /nonce=[\w-]{22}/);

    // ── INVERTED · P-13 CLOSED ────────────────────────────────────────────────────────────
    // Same shape as P-12: the mitigation and the leak are one mechanism and there is no version of
    // this protocol without it, so the fix was always a sentence. §5's header table now carries
    // the `Authorization` row, and §10 carries the German sentence for it.
    assert.equal(documented('ts='), true, 'the timestamp left the document — re-open P-13');
    assert.ok(documented('client\'s own wall clock', 'client clock'));
    assert.ok(documented('uhrzeit des'), 'the Datenschutz sentence is gone');
    assert.ok(documented('per-machine drift fingerprint', 'stable per-machine fingerprint'),
      'the document names the timestamp but not what it discloses');
    assert.equal(documented('nonce'), true, 'the nonce half IS documented — §2, the Nonce table');
  });

  test('FAILED — and there is genuinely no cookie, no session and no user agent of ours', async () => {
    // The positive control that keeps §1 from reading as a complaint about everything: the three
    // headers really are the whole client-supplied surface, and ADR 003 §1's "no cookies, no
    // sessions, no bearer tokens" holds on real traffic.
    const fleet = await createFleet({ board: BOARD() });
    const rec = recordWire(fleet.wire);
    try { await fleet.settle(1); } finally { rec.restore(); }
    for (const c of rec.calls) {
      for (const forbidden of ['cookie', 'set-cookie', 'user-agent', 'referer', 'origin', 'x-forwarded-for']) {
        assert.equal(c.headers[forbidden], undefined, `${forbidden} was sent`);
      }
    }
    assert.deepEqual(Object.values(HDR).sort(),
      ['Authorization', 'X-LZP-Client', 'X-LZP-Min-Protocol', 'X-LZP-Protocol']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE URL
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§2 · what goes in a URL, and therefore into a platform request log', () => {
  test('SUCCEEDED (P-14 CLOSED in the document) — the space id and the read cursor are in the QUERY STRING of every pull', async () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-14 · MEDIUM · story 21.3 · `server-metadata.md` §8.
    //
    // §8 is careful and correct about one URL: "`/api/v1/pair/<rid>` puts the pairing rendezvous
    // id … **into a URL path**, and a platform request log is exactly where a URL path goes."
    // It then says the application's own log never writes a path. Both true.
    //
    // It names only that one. Every pull this product makes is
    //
    //     GET /api/v1/ops?limit=500&since=<cursor>&space=psp_<22 chars>
    //
    // so **the personal space id and the device's read position are in a URL, on every request,
    // at the 45-second cadence** — and by §8's own argument they are therefore in Vercel's
    // request log, whose retention and access are Vercel's terms and not ours. The space id is
    // the join key for everything in §2; the cursor is `lastSeenSeq` restated. An operator with
    // ONLY the platform log — no database at all — can reconstruct §5's entire activity timeline
    // per space from it.
    //
    // Two more paths carry a space id in the PATH, not the query: `/api/v1/spaces/:id/members`
    // and `/api/v1/spaces/:id/keys`.
    //
    // The fix is documentation, not code: §8's paragraph should say "the pairing rendezvous id,
    // the space id and the read cursor", and §2's `Op` table should note that `seq` is legible
    // outside the database. Owner: LZP-207.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const fleet = await createFleet({ board: BOARD() });
    const rec = recordWire(fleet.wire);
    try {
      await fleet.A.apply('createNotePopover', { id: 'p1', date: '2027-05-06', text: 'x', categoryId: 'c1' });
      await fleet.settle(2);
    } finally {
      rec.restore();
    }
    const pulls = rec.calls.filter((c) => c.method === 'GET');
    assert.ok(pulls.length >= 2, 'no pull was recorded');
    for (const p of pulls) {
      assert.equal(p.query.space, fleet.spaceId, 'the space id is not in the query');
      assert.match(p.query.since, /^[0-9]+$/);
    }
    // At least one pull carried a NON-ZERO cursor, so the leak is of progress and not of a constant.
    assert.ok(pulls.some((p) => p.query.since !== '0'), 'no pull carried real progress');

    // ── INVERTED · P-14 CLOSED ────────────────────────────────────────────────────────────
    // §8 named one URL leak and it was the other one. §5 now names this one, quotes the request
    // line verbatim, and draws the conclusion §8's own argument forces: an operator with ONLY the
    // platform log can reconstruct the activity timeline per space.
    assert.equal(documented('pair/<rid>', 'rendezvous id'), true, '§8 must still name the pairing rid');
    assert.equal(
      documented('query string', 'querystring', 'in der url', '?space=', 'since='), true,
      'the query-string leak left the document — re-open P-14',
    );
    assert.ok(documented('/api/v1/ops?limit=500&since=<cursor>&space='), 'the request line itself is gone');
    assert.ok(documented('no\ndatabase at all', 'no database at all'), 'the platform-log-only inference is gone');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE CADENCE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§3 · the rhythm §5 describes, against the rhythm the code keeps', () => {
  test('SUCCEEDED (P-15 CLOSED in the document) — §5 said the cadence STOPS when the window is hidden. It is 10 minutes, and §5 now says so', () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-15 · MEDIUM · story 21.3 · `server-metadata.md` §5 is factually wrong.
    //
    // §5, verbatim: "The client pulls **every 45 s ± 15 s jitter while a window is visible**"
    // and, in the list of what an operator can derive, "**when that Mac is awake and has the app
    // open** — the pull cadence stops when it is not".
    //
    // ADR 003 §8.2's own table says otherwise and the code implements the table:
    //
    //     timer, window visible   → every 45 s ± 15 s
    //     timer, window HIDDEN    → every 10 min; push continues
    //
    // So a Mac with the app running behind other windows — the ordinary state of a calendar —
    // emits a heartbeat every ten minutes, and §5's reader concludes it emits nothing. That is
    // the difference between "the relay knows when you were looking at your calendar" and "the
    // relay knows your Mac was on", and the second is the true and larger statement.
    //
    // §5 also cites the wrong section: it says "(ADR 003 §10)" and §10 is "Known weaknesses";
    // the cadence table is §8.2.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    assert.equal(CADENCE.pullVisibleMs, 45000);
    assert.equal(CADENCE.pullJitterMs, 15000);
    assert.equal(CADENCE.pullHiddenMs, 600000, 'the hidden cadence moved — re-read P-15');

    // The code that keeps it, so the finding is about the shipped behaviour and not a constant.
    const engine = repoFile('src/js/family/engine.js');
    assert.match(engine, /const nextDelay = \(\) => \(hidden\(\)\s*\?\s*CADENCE\.pullHiddenMs/);

    // ── INVERTED · P-15 CLOSED ────────────────────────────────────────────────────────────
    // This one was not an omission, it was a FACTUAL ERROR: §5 said the cadence stops when the
    // window is hidden. It is ten minutes. The sentence is gone, the table is in, and §5 says in
    // its own voice which of the two statements is the larger one.
    const md = repoFile(DOC);
    assert.equal(/the pull cadence stops when it is not/.test(md), false,
      'the false sentence is back in §5 — re-open P-15');
    assert.equal(documented('10 min', '10 minutes', 'zehn minuten', 'pullhiddenms', 'hidden'), true,
      'the hidden cadence left the document — re-open P-15');
    assert.ok(documented('the relay knows your Mac was on'),
      '§5 no longer says which of the two readings is the true and larger one');
    // The citation was wrong too: the cadence table is ADR 003 §8.2, and §10 is "Known weaknesses".
    assert.equal(/cadence[^.]*\(ADR 003 §10\)/.test(md), false, 'the wrong citation is back');
    assert.ok(documented('ADR 003 §8.2'), '§5 must cite the section the table is actually in');
    assert.match(repoFile('docs/v2/adr/003-sync-protocol.md'), /^## 10\. Known weaknesses$/m);
  });

  test('SUCCEEDED (P-16 CLOSED in the document) — three EVENT-DRIVEN requests, now named and explained in §5', () => {
    // ═══════════════════════════════════════════════════════════════════════════════════════
    // FINDING P-16 · MEDIUM · story 21.3 · the most identifying observable in the product.
    //
    // §5 describes a POLL. A poll at 45 s tells an operator that a machine is on. The client also
    // makes three requests that are not a poll, and each one timestamps a human action to the
    // second:
    //
    //   `visibilitychange → visible`  an IMMEDIATE pull. **The moment the person brought the
    //                                 calendar to the front.** Not "the Mac is on" — "she looked
    //                                 at it, now".
    //   `online`                      an IMMEDIATE pull. The moment this Mac's network came
    //                                 back: the lid opened, the train left the tunnel, the café
    //                                 wifi connected.
    //   `pagehide`                    a force-flushed PUSH. The moment the app was quit or the
    //                                 window closed.
    //
    // Together they bracket a session: opened at 08:12, looked at 08:12, 09:40, 14:03, quit at
    // 18:31. None of it needs the ciphertext, none of it is in §5, and it is strictly more
    // identifying than the poll §5 does describe. The Datenschutz page should say plainly that
    // the app talks to the server when you look at it and when you close it, not only "every 45
    // seconds".
    //
    // The cadence itself is right — ADR 003 §8.2 lists all three deliberately, and a stale board
    // when a person has just looked at it is a real cost. This is a documentation finding.
    // ═══════════════════════════════════════════════════════════════════════════════════════
    const engine = repoFile('src/js/family/engine.js');
    assert.match(engine, /doc\.addEventListener\('visibilitychange', onVisible\)/);
    assert.match(engine, /globalThis\.addEventListener\('online', wake\)/);
    assert.match(engine, /globalThis\.addEventListener\('pagehide', \(\) => \{ sync\.flush\(\)/);
    // `wake()` is a pull RIGHT NOW, not a re-arm — that is what makes it a timestamp.
    assert.match(engine, /const wake = \(\) => \{[\s\S]*?tick\(\);\s*\};/);

    // ADR 003 documents them. The privacy document does not.
    assert.match(repoFile('docs/v2/adr/003-sync-protocol.md'),
      /`focus`, `visibilitychange → visible`, `online` \| pull all configured spaces immediately/);
    // ── INVERTED · P-16 CLOSED ────────────────────────────────────────────────────────────
    // The cadence is right and deliberate — a stale board when somebody has just looked at it is a
    // real cost — so this was always a documentation finding. §5 now has "the three requests that
    // are not a poll", one table row per trigger, and says what each one timestamps.
    assert.equal(documented('visibilitychange', 'pagehide', 'brings the window', 'looked at'), true,
      'the wake triggers left the document — re-open P-16');
    assert.ok(documented('visibilitychange') && documented('pagehide') && documented('`online`'),
      'all three triggers must be named, not one of them');
    assert.ok(documented('they bracket a session'), 'the joint inference is what makes the three sharp');
    assert.ok(documented('when you look at it and when you close it'),
      'the Datenschutz sentence P-16 asked for is missing');
  });

  test('FAILED — the parts of §5 that ARE right are right, and they are the majority', () => {
    // The control. §5's claims about pushes being event-driven, about `lastSeenSeq` and
    // `lastPushedSeq`, and §4's padding formula all hold against the code — so P-15 and P-16 are
    // corrections to a good document rather than a verdict on it.
    assert.equal(CADENCE.pushDebounceMs, 2000, 'pushes are event-driven with a 2 s debounce');
    assert.match(repoFile('src/js/sync/personal.js'), /pushTimer = d\.schedule\(pushDebounceMs/);
    assert.ok(documented('lastseenseq'));
    assert.ok(documented('lastpushedseq'));
    assert.ok(documented('92 + 256'), '§4 formula');
    assert.ok(documented('colorref'), "§2's one deliberate plaintext");
    assert.ok(documented('receivedat'));
    assert.ok(documented('devicesshort') || documented('deviceshort'));
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// §4 — WHAT §5 SAYS ABOUT SOLO MODE
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('§4 · "solo mode makes zero requests" — the document\'s own strongest claim', () => {
  test('SUCCEEDED (P-2\'s documentation half CLOSED; P-1 open) — the claim is true of the RELAY and now says so', () => {
    // The two findings from file 1 of this suite, restated where they land in the documentation:
    //
    //   P-2 — a solo install contacts a SECOND host, the release manifest, on every launch. The
    //         request is the shell's and is disclosure-gated, and it is real. §5's sentence "a
    //         person who never joins a circle has no rows at all — not an empty account, no
    //         account" is true of this relay's database and reads as "no traffic".
    //   P-1 — and a person who DID join has no way back to no-traffic, because nothing in the
    //         product ever clears the three settings that arm sync.
    //
    // Both belong in the Datenschutz copy, and §5's paragraph is where they would go.
    const md = repoFile(DOC);
    assert.match(md, /solo mode makes \*\*zero requests\*\*/);
    assert.match(md, /not an empty account, no\s+account/);
    // ── INVERTED · P-2's DOCUMENTATION HALF CLOSED ────────────────────────────────────────
    // §8 now has "the second remote: the release host". It names `latest.json`, says the request
    // is disclosure-gated and real rather than hidden, says what the release host's own log
    // necessarily sees (IP, time, "this Mac runs this app") FOR SOLO INSTALLS TOO, and puts the
    // qualifier on §5's sentence — "zero requests **to this relay**". P-2's remaining half is not
    // this document's: `docs/v2/datenschutz.md` still does not exist, and when it is written it
    // must name two remotes. That half is asserted below and stays open.
    assert.equal(documented('release host', 'latest.json'), true,
      'the second remote left the document — re-open P-2');
    assert.ok(documented('zweiten server'), 'the German sentence for the second remote is gone');
    assert.ok(documented('read as "no traffic"', 'read as “no traffic”'),
      '§5\'s "no rows at all" no longer carries its qualifier');
    assert.equal(repoHas('docs/v2/datenschutz.md'), false,
      'a Datenschutz document appeared — P-2\'s second half is now audited against IT, not this file');
    // §6 names `POST /members/remove` as the purge route and never names leaving at all — so the
    // document has no place where "and this is how you stop" would go, which is the shape of the
    // gap rather than an omission from a list.
    assert.ok(documented('/members/remove'), '§6 must still name the removal route');
    assert.equal(documented('members/leave', 'turn sync off', 'stop syncing', 'abschalten'), false,
      'a way back is documented now — close P-1');
  });

  test('FAILED — and the one deliberate plaintext really is the only one the client chooses', async () => {
    // §2 says `colorRef` is "THE ONE DELIBERATE PLAINTEXT LEAK … the only String in the whole
    // schema that carries a user's choice". That is a claim about the SCHEMA; this is the client
    // half of it, which nobody has checked: what does the client actually put there for a
    // PERSONAL space, where colour uniqueness means nothing because there is one member?
    //
    // It sends the constant `'gruen'`. So at M1 the one deliberate leak leaks nothing at all —
    // the user's real palette choice never leaves the machine. Worth an assertion, because the
    // obvious "improvement" is to send the user's actual colour, and that would silently turn a
    // constant into a preference.
    const engine = repoFile('src/js/family/engine.js');
    assert.match(engine, /colorRef: 'gruen',/, 'the client now sends a chosen colour for a PERSONAL space');
    assert.ok(documented('the one deliberate plaintext leak'));
  });
});
