# E10 — privacy, migration and hardening. Verification, and an honest answer to the epic's own question.

**Date:** 2026-09-03 · **Tickets:** LZP-1001…1006, 1008, 1009 (1007 is a parallel workflow's) ·
**Stories:** F21 21.1–21.5, 11.2, 11.3, 22.3, 22.5, F15–F18 (via LZP-1005) · **Amendments:** A1,
A2, A10 · **Normative:** ADR 002 §7, §8.5a · ADR 003 §1, §2, §7 gates 1–4 · ADR 004 §2.2, §10.1 ·
ADR 005 §5 rule 4 · **PO decisions D8, D9**

---

## 0. The verdict, in one paragraph

**The guarantees are tested facts. Mom's install day is not boring, and we now know exactly why
in three measured places rather than suspecting it in one.**

E10's stated goal splits cleanly and the two halves land differently. The *guarantees* half is
done and it is now measured rather than asserted: 21.5 is a **counted** property with exactly one
exception in solo mode, that exception is human-initiated at two independent gates, and it is
detectable if it ever widens — proved by eight mutants that each kill a named row. The redaction
boundary stood a fifth time, through the outbound path E10 itself adds. The crypto self-audit
closed four defects a checklist would have ticked as fine. **The *install day* half is not done,
and it is not done in a way no amount of testing will fix: LZP-1006's acceptance criterion is a
person who has never seen the app, and that person has not sat down yet.** What we have instead
is a kit, and a probe that ran the shipped parser over the shipped e-mail and found three defects
in the first screen she will ever see.

**And one ticket of the eight was never built at all.** LZP-1009 — the PO's feedback button, asked
for today — did not land. That matters more than a missing feature, because tasks 4 and 5 of this
integration were *attacks on its payload*. There was nothing to attack. What this pass did instead
was measure its absence in eight independent places and leave every one of those rows written so
that **the day 1009 lands, the suite goes red at the exact line where 21.5's exception count
widens** (§4).

---

## 1. Suites — measured at the close of the pass

```
npm test          2121 / 2121      (brief: 2105)
test:property      101 /  101
test:attack        960 /  960      (brief: 860 · +60 LZP-1003 · +40 this pass)
test:server        903 /  903
test:fleet         397 /  397      (brief: 346 · +47 LZP-1004/1005 · +4 parallel)
test:dom           811 pass / 3 fail   (brief: 714 / 17 fail)  ← a moving target, see below
```

**Five suites wholly green. The sixth carries three red rows and not one of them is E10's.**

`test:dom` was run three times over this pass and **the number moved every time**, because the
parallel density workflow is landing fixes while it runs. That is worth recording as a number
rather than as a single snapshot:

| run | result | failing files |
|---|---|---|
| first | 804 / 9 | `e8-density-legibility` (1), `e8-density-perf` (3), `family-density` (2), `family-legend` (2), `family-render` (1) |
| second | 804 / 9 | the same five |
| **final** | **811 / 3** | `e8-density-legibility` (1), `e8-density-perf` (2) |

The brief said 17. It is 3, and the fall is the parallel workflow's work landing, not ours. Every
one of the remaining three is in a file owned by that workflow (`layout.js`, `src/css/app.css`).
**Not counted, not fixed, not touched.** `tests/tier2/network-audit.dom.js` — the file this epic
cares about — is 10 pass / 0 fail / 1 skip in all three runs.

### 1a. Two reds that appeared and cleared during the pass, recorded because they are facts

- **`tests/tier1/suite-integrity.test.js`** went red mid-session on
  `headless-shell.test.js matches /from\s+['"]node:fs['"]/` — a tier-1 test that had grown a
  `node:fs` import. The file's mtime was two minutes old at the time. It is a parallel workflow's
  file, it was not touched here, and it was green again by the close (2121/2121). Recorded because
  "the suite was green at the end" and "the suite was green throughout" are different claims.
- **`tests/run-dom-tests.sh`'s isolation guard fired once**: `ISOLATION VIOLATED:
  ~/Library/Application Support/LangzeitPlaner changed during the test run`, with `board.json` and
  `snapshots.json` both moving. It did not reproduce on either later run. The guard is doing its
  job and the most likely cause is a concurrent workflow, but **a tier-2 run that can touch the
  user's real board is a release-blocking property**, so it is filed (FINDINGS **E10-4**) rather
  than dismissed as flaky.

---

## 2. Ticket by ticket

**Verdict vocabulary.** *VERIFIED-HERE* — the artefact exists and a row in a suite that ran in
this pass would fail if it regressed. *WRITTEN-UNVERIFIED* — the artefact exists and is correct as
far as reading can establish, but the thing it describes cannot be executed here (a person, a
deploy, a Rust toolchain). *OWED* — not delivered.

| ticket | title | pts | verdict | what actually exists |
|---|---|---|---|---|
| **LZP-1001** | Datenschutz section | 2 | **OWED** | Nothing. „Frankfurt", „Vercel" and „Prisma" appear **nowhere in `src/`** — measured by LZP-1006's probe. 21.3's text is not in the product. And it is now *bigger* than it was: `updater.js`'s own header says the Datenschutz copy "must name the release host as a second remote beside the sync endpoint", and §3 below adds that the count of remotes is two, not one. |
| **LZP-1002** | Network scope audit | 3 | **VERIFIED-HERE** | Delivered before E10 and extended here. `tests/tier1/network-scope.test.js` (19 rows, gates 1–4) + `tests/tier2/network-audit.dom.js` (10/0/1) + **`tests/attack/e10-network-scope.test.js`, 25 new rows** covering the half neither had: the native side. STATUS §629's "the gate does not exist" is **stale** and is corrected in this pass. |
| **LZP-1003** | Crypto self-audit | 5 | **VERIFIED-HERE** | 60 rows in three files; **four defects found and closed** (empty key ring restoring as success; rule-3 breaches on both pairing legs; `bundle.epoch` as an unbounded loop), each with a mutant that kills a named row. Five residuals priced and reported. Re-run here: green. |
| **LZP-1004** | Backup/restore tests | 3 | **VERIFIED-HERE** | 21 fleet rows: D8 asserted **on the bytes** (every private key's b64u spelling searched for in `JSON.stringify(file)`), the whole export→wipe→adopt→re-admit→write arc, restore over a live board including the retractions it owes the family, and a backup older than the current epoch. |
| **LZP-1005** | Multi-device E2E suite | 8 | **VERIFIED-HERE** | 26 F15–F18 stories, 47 fleet rows, each story's verdict recorded in `traceability.json`. Thirteen are `fleet`, seven `fleet-partial` (each naming the DOM file that owns the rendered half), one `browser-only` (17.4), **one OPEN (17.5)**. |
| **LZP-1006** | "Mom test" beta | 3 | **OUTSTANDING BY NATURE — do not count the points** | The kit is built (`MOM-TEST.md`, `mom-test-probe.mjs`). **The test itself belongs to the PO and cannot be run by anyone who knows how the app works.** §6 below. |
| **LZP-1007** | Perf pass | 3 | *(parallel workflow's — skipped)* | STATUS §213 records it met with an order of magnitude in hand. Not re-measured here. |
| **LZP-1008** | Ops runbook | 2 | **WRITTEN-UNVERIFIED** | `RUNBOOK.md`, `RELEASE-CHECKLIST.md`. Every *gate command* in the checklist was executed (four scripts, all exit 0). The Vercel/Prisma procedure itself cannot be executed without an account. Carries the release blocker: **`server/prisma/migrations/` does not exist**, so the first deploy creates no tables and `check-server-config.mjs` passes anyway. |
| **LZP-1009** | Feedback button *(new, PO, today)* | — | **OWED** | Not built. No module, no bridge command, no route, no copy, no processor named. §4 measures the absence in eight places. |

**Points.** 210/239 at the brief. E10 adds LZP-1002 (3), 1003 (5), 1004 (3), 1005 (8), 1008 (2)
= **21 points banked, 231/239**. LZP-1001 (2), 1006 (3) and 1009 (unpointed) remain, and 1006's
three points must not be taken until a stranger has actually sat down.

---

## 3. Story 21.5, the amended property — stated, then counted

### 3a. The old wording and the new

> **v1, story 13.4** *(superseded by amendment A1)*
> "Zero network by architecture."

> **v2, story 21.5**
> "Network scope, replacing 13.4: **in solo mode the app makes zero network requests; with a
> Familienkreis it talks to exactly one sync endpoint and nothing else.** The v1 property survives
> as a scoped guarantee."

A1 adds that v1's wording "may remain true for solo mode and should be quoted that way in
about/marketing copy." **That permission is the thing this section exists to test, because as
built it is not quite true, and the gap has a name.**

### 3b. Boot a solo copy and count requests

Three independent measurements, all green, none of them a rewrite of the others:

| what was measured | how | result |
|---|---|---|
| a real WKWebView launch + a whole session — create, edit, undo, redo, settings, layer toggles, persist, search, „Heute", `visibilitychange`, `online`, `focus` — with spies on **all five** ways a page can open a socket | `network-audit.dom.js` §2, in the shipping engine | **0 calls.** Spy proved armed in the same file by a planted `fetch`, `WebSocket` and `sendBeacon` |
| the document's own policy | `connect-src 'self'`, and an off-origin `fetch` attempted for real | **blocked by CSP**, not by politeness |
| the module graph on a solo launch | Resource Timing | **0 family modules.** ⚠ this row **SKIPs in WKWebView** — the engine records no Resource Timing entries for the `app:` scheme. The measurement that stands is E5-VERIFICATION §4's Chrome run: 38 resources, none under `crypto/`, `sync/`, `family/` or `platform/net.js` |
| the source | one `fetch` call site in all of `src/js/`; no static path to it from `boot.js`/`firstrun.js`/`main.js`; exactly one dynamic door | `network-scope.test.js` gates 1–2 | **1 allowed site, 0 others** |

**The page's zero is a fact.** It is worth saying plainly that the third row is a SKIP in the
engine we ship, so the "never even loaded" claim rests on a Chrome measurement plus a static
import-graph walk, not on the shipping engine. That is honest and it is enough; it is not the same
as measured in WKWebView.

### 3c. Then press the button, and count again

The commissioned measurement was *"press the feedback button and count again"*. **There is no
feedback button** (§4). So the button that was pressed is the one that exists — „Jetzt suchen" —
and the shape of the answer is the shape 21.5 needs either way. `tests/attack/e10-network-scope.test.js`
§5 drives the real `createUpdater` over a counting four-method port:

| scenario | requests |
|---|---|
| **§5a** a fresh install: two launches, seven daily timers, and the button pressed before disclosure | **0** |
| **§5b** disclosed, switch **off**: a launch and three daily timers | **0** |
| **§5f** switch **on** but never disclosed — a restored Mac, a copied prefs file | **0** |
| **§5d** six launches in two hours, both gates open | **1** (the launch debounce collapses the burst) |
| **§5c** **a person presses „Jetzt suchen"** | **exactly 1**, and no download |
| **§5e** three daily timers, both gates open — the counter's non-vacuity control | **3**, and the port methods called are exactly `status`, `noteCheck`, `fetchManifest` |

### 3d. Is the exception exactly one, human-initiated, and detectable if it widened?

**Exactly one — no. It is two, and the second one is the honest answer.** `e10-network-scope.test.js`
§1a is the census: every primitive in either shell that can put a byte on a wire, tagged with the
function enclosing it. **Thirteen sites, and every one of them is in one of two jobs — `update` or
`sync`.** In *solo* mode the sync job cannot fire (`SyncPrefs.enabled` defaults to `false`, §1f),
so **solo mode's exception count is one: the update manifest.** In family mode it is two, which is
exactly what 21.5 and 22.3 together promise — and which A1's "quote v1's wording for solo mode"
permission does **not** cover, because the update check happens in solo mode too. That sentence is
LZP-1001's to write, and §7 owes it.

**Human-initiated — yes, at two independent gates, both proved upstream of the socket.**
`updaterFetchManifest` refuses unless `prefs.disclosed && prefs.enabled`, and the guard is proved
to precede the `URLSession` *inside the same function* (§1e) — an ordering claim, not a line
number, because that file is being edited by another workflow as this runs. `syncPreflight`'s
first statement reads the pref, and the function whose whole job is refusal **cannot itself open a
socket** (§1f). The same two gates are enforced a second time in JavaScript, in `createUpdater`,
and §5a/§5b/§5f measure each of them separately — §5f exists **because a mutant survived**: with
`enabled:false` in play, deleting the `disclosed` gate left §5a and §5b green. The two gates are
redundant in the ordinary cases, which is good design and bad testing.

**Detectable if it widened — yes, and this is the part that did not exist before this pass.**

- A **third job** in either shell reddens §1a. Proved: a `sendFeedbackNow` with a `URLSession`
  planted in a scratch copy of `main.swift` kills §1a **and** §1g.
- A **second remote host** reddens §1g, which is the strongest single sentence available about
  21.5: **the entire product names exactly one hard-coded remote URL** — the update manifest, and
  it is still `OWNER-PLACEHOLDER`. That is also what closes the `Data(contentsOf:)` class, which
  fetches `https://` and reads `file://` with the same call: a primitive that can only go out if
  handed a remote URL is safe when there is no remote URL to hand it. Eleven such sites are
  enumerated rather than ignored (§1h).
- A **sync socket behind a door that is not there** — or a door with no socket — reddens §1c,
  which is an **if and only if** rather than "both shells sync". That shape was chosen because
  `sync_request` is landing in both shells as this commits and at `HEAD` neither has it: a row that
  is red for reasons that are nobody's defect gets deleted, and the biconditional is the stronger
  claim anyway. A shell that opens a sync socket without exposing the command has a socket no gate
  covers; one that exposes the command without a socket answers the page with a lie. Proved by
  M11, which renames the case label and leaves the socket.
- A **mechanism nobody thought of** reddens §1a too: the census lists `NWConnection`, `CFSocket`,
  `TcpStream`, `ureq` and `hyper` although the product uses none of them, and §4b shows each a
  positive. A gate that only looks for what is already there is a gate that rots.

**What the census does not claim,** asserted rather than assumed (§4a): it is a **name** test. A
function called `syncSendEverything` would pass it. It bounds the number of *jobs*, not the
behaviour of either — `network-audit.dom.js` §3 bounds the sync job's shape, and §5 below greps
what it actually carries.

---

## 4. The feedback payload leaks nothing — because there is no feedback payload

Tasks 4 and 5 of this integration were attacks on LZP-1009's outbound path. **It does not exist.**
Reporting that as a sentence would rot in a week, so it is eight rows across two files, each
written so that the day 1009 lands it goes red at the place where the promise changes:

| what is absent | measured by | reddens when |
|---|---|---|
| a sender in the page | §2a — the whole shipped tree, code only (comments and string literals blanked) | any module names feedback / telemetry / analytics / sendBeacon |
| a bridge command | §2b — every command name **both** shells answer to, 30 of them enumerated | a reporting command appears |
| a relay route | §2c — the 20-row route table | the relay grows one |
| a reachable path | §2d/§1i — `/feedback`, `/api/v1/../feedback`, `/api/feedback`, `/api/v2/ops` all refused **by name** | `PATH_RE` widens |
| a remote host in the page | §2e — every `http(s)://` literal in `src/js/`: all are bare schemes, the SVG XML namespace, documented placeholders (`https://<vercel-app>…`), or loopback | a real host appears |
| a native sender | §1a/§1d | a third job appears |
| **an image, of any kind** | §3a — no canvas, `getContext`, `toDataURL`, `toBlob`, `getImageData`, `OffscreenCanvas`, `createImageBitmap`, `getDisplayMedia`, `captureStream`, `html2canvas` anywhere in `src/js/` | the product learns to draw |
| **a screenshot, in either shell** | §3b — no `CGWindowListCreateImage`, `CGDisplayStream`, `SCScreenshotManager`, `ScreenCaptureKit`, `NSBitmapImageRep`, `WKSnapshotConfiguration`, `screencapture` | a shell learns to capture |

**On "check the redacted PNG really was produced by not drawing".** The answer is the strongest
possible form of the claim and it is also a refusal to pretend: **the claim cannot be verified,
because the product cannot draw.** A full-fidelity image does not exist anywhere on any path
because *no* image does — not in the page, not in either shell. §3a and §3b are the rows to invert
the day the screenshot half of 1009 arrives, at which point "produced by not drawing" becomes a
claim with something to be false about, and the row becomes "the only image-producing call site is
the redacted renderer".

**`diagnostics` is deliberately not in §2a's word list, and the omission is compensated.** It is a
local introspection method on nine shipped modules (`store.diagnostics()`, `lot.diagnostics()`, …)
read by the settings sheet, and including it would give the row thirty permanent hits — which is
the failure mode a gate like this actually dies of. §2e is the compensating claim: whatever any of
them returns, **there is no remote host in the shipped tree to send it to.**

---

## 5. The standing bar, a fifth time — through the path E10 actually adds

Four rounds stand already and none is repeated: `e7-leak-downgrade`, `e7-leak-observer`,
`e7-leak-routes` (ADR 004's adversary — pre-seal plaintext, sealed bytes, stored envelopes, and a
decryption of the whole family log under every epoch key the family has ever held), and
`e6-attack-privat` / `e6-gate-privat` (the same boundary from the fleet's positions and from
round 3's refusal bodies). **Zero bytes of a Privat entry, four times.**

The fifth round exists because **E10 adds a carrier none of the four has ever seen**: all four end
at `transport.request`, and `createBridgeTransport` — being implemented in both shells right now —
starts there, handing `{url, method, headers, body}` to a native process that opens the socket. A
new carrier is precisely where a boundary that has held four times breaks.

`tests/attack/e10-outbound-payload.test.js`, 15 rows. A real member, a real device, real keys,
real seals; a real German fixture board:

```
Scheidungsanwältin Dr. Kübler 14:30      (note text, Privat)
Kur in Bad Wörishofen                     (bar label, Privat)
Zweitfamilie Süd                          (category name — A3: never published, at any level)
Diagnose F32.1 — mittelgradige Episode    (scratchpad)
Passwort fürs Schließfach: Großmutter77   (scratchpad)
```

**The grep.** Not `body.includes(secret)`. **Three spellings of every needle** — raw UTF-8, the
**b64url** spelling (because a field that was base64-encoded without being encrypted is perfectly
readable to a relay and invisible to a plain substring search), and the `\uXXXX`-escaped spelling
(every needle carries an umlaut or a sharp s on purpose) — over **the whole payload**: url, method,
**every header name and value**, and the body.

| row | result |
|---|---|
| §1a the personal push across the bridge | **0 of 5 needles, in 0 of 3 spellings** |
| §1b the family push | 0 needles; names the family space, does **not** name the personal one |
| §1c the *shared* label — the string that is legitimately on this board's family side | **also absent.** „versiegelt" here means unreadable, not merely intact (21.1) |
| §1d the GET (pull) leg | body is the empty string; nothing to leak |
| §1e the bridge's argument object | **exactly four keys**, and exactly four headers: `Authorization`, `Content-Type`, `X-LZP-Client`, `X-LZP-Protocol` |
| §3a the `fetch` leg (dev-server) | same result, same control |
| §3c the **anonymous** transport (invite redeem, device adopt) — no `sign`, no `deviceShort`, so "the signature covers the body" does not apply | no `Authorization` at all, 0 needles, and the invite code IS found |

**The positive control, which is what makes every absence above worth anything.** The identical
function over the identical payload is required to **find** the space id, the device short id, the
client version, `LZP1`, `/api/v1/ops`, the origin, **and every sealed `ct` and `sig`** — so it is
demonstrably reading the body and not only the headers (§2a, §2b). Separately: every needle is
required to be **present in the pre-seal plaintext** (§2c), so §1 is not green because the board
was empty. And §2d plants a needle in a real request header and requires the search to catch it —
the last way §1 could be vacuous is `flatten` returning something unsearchable.

**§1f is the row this round did not plan to write.** Building the rig, `sealOp` refused a
hand-built family patch: *"refusing an UNBRANDED family patch (ADR 004 §2.2 barrier 3)"*. The rig
had to go through the product's own `projectForFamily` to get its family op. That refusal is now a
row, because it is what stops **this test and every future one** from smuggling a raw truth field
onto the family wire and then congratulating itself for not finding it.

**And one thing this round learned about its own limits.** Mutant M7 added a debug header echoing
the request body — and it killed §1e (the four-header allowlist) while leaving §1a's needle search
green. The reason is worth stating: **the plaintext never reaches the transport at all.** `net.js`
sees sealed envelopes and nothing else, so a needle search at the transport can never catch a leak
of already-sealed bytes. §1e is the row that catches that class, and the four earlier rounds are
what catch it upstream. A reader who takes §1a alone as "the transport cannot leak" has read it
wrong.

---

## 6. Mom's install day is not boring, and here is exactly why

**LZP-1006's acceptance criterion is a person who has never seen the app, on a Mac that has never
held it, unassisted. Nobody who knows how the app works can run it without destroying the
measurement.** `MOM-TEST.md` §0 and §9 say so in the document itself; §9 is an empty result form.
**The three points are not taken.**

What *was* done is the next most useful thing: `scripts/mom-test-probe.mjs` ran the **shipped
parser** over the **shipped e-mail**, 35 rows, and found three defects — measured, not suspected —
in the first screen a stranger meets. All three are in files this pass does not own
(`docs/v2/email/*`, `src/js/family/*`); all three are recorded with the fix stated.

- **E-1 · „Mail-Anbieter" is a valid invitation code, and it wins.** `crockNormalize('Mail-Anbieter')`
  → `MA11ANB1ETER`: twelve Crockford characters. It sits *above* the code block in the shipped
  German mail, so `parseInvitePaste`'s case-1a preference takes it. Pasting the whole invitation
  fills the field with `MA11-ANB1-ETER` — complete, plausible — and she is then told she mistyped
  a character she never typed.
- **E-2 · the e-mail carries no relay address, and the parser takes the download host.**
  `submitJoin` refuses without an origin and says *„In der Einladung stand auch eine
  Serveradresse"*, which is untrue of this mail. `parseInvitePaste` takes the **first** URL — the
  release link — so the *Server* field fills with `https://github.com` and the screen reassures
  her about it.
- **E-3 · punctuation becomes part of the host.** The URL match is `[^\s"'<>]+`, so `…vercel.app.`
  survives `normalizeOrigin` and `„https://…vercel.app“` becomes the punycode host
  `…vercel.xn--app-5o0a`. The failure surfaces one screen later as „Keine Verbindung zum Server",
  blaming the connection for a spelling mistake.

**And the structural finding that makes those three worse than they look.**
`grep -rn "gatekeeper_status" shell-macos/main.swift src-tauri/src/lib.rs` returns **nothing** —
LZP-106's unlock screen never fires. `scripts/make-dmg.sh` stages **two** items and
`Bitte zuerst lesen.html` is not among them. **So step 3 of the e-mail is the only surface that
reaches her before macOS refuses to open the app** — a single point of failure, because while
macOS is blocking, the app is not running and cannot help her.

The probe is falsifiable: the honest-path mutant (word fix + a bare relay line above every other
URL) exits 0 with 27 pass / 0 FAIL; moving the relay line *below* the Releases link keeps `M2-de`
and `M2-en` red, which is how we know ordering is load-bearing.

**Verdict: not boring.** Three parser defects, one missing relay address, one unlock screen that
does not exist, and a Datenschutz text (LZP-1001) that is not in the product at all.

---

## 7. What is still owed for a v2 ship

**Release-blocking.**

1. **`server/prisma/migrations/` does not exist.** The first deploy creates no tables and
   `check-server-config.mjs` passes anyway. (LZP-1008, RUNBOOK §2.)
2. **LZP-1001 — the Datenschutz section is not in the product.** „Frankfurt", „Vercel", „Prisma"
   appear nowhere in `src/`. It is now larger than the ticket says: §3d shows the product contacts
   **two** remotes, so the copy must name the release host beside the relay, and A1's permission to
   quote v1's "zero network" wording for solo mode is **not** clean — the update check happens in
   solo mode too.
3. **LZP-1006 — the Mom test itself.** Blocked on a person, and on E-1/E-2/E-3 above being fixed
   first so her afternoon is not spent on known defects. D1 (signing) determines its quality.
4. **LZP-106's unlock screen** — `gatekeeper_status` is unimplemented in both shells (§6).
5. **`Bitte zuerst lesen.html` is not on the disk image** (§6).

**Owed, not blocking.**

6. **LZP-1009 — the feedback button.** Not built. When it is: it is a **third** network job and a
   **second** remote host, so it needs §1a, §1g, §2a–§2e and (if it screenshots) §3a/§3b
   **inverted**, plus a Datenschutz sentence naming a third processor. The rig in
   `e10-outbound-payload.test.js` — the fixture board, the three spellings, the positive control —
   is written to be pointed at the new payload rather than replaced by a weaker one (§4a).
7. **E10-1 · story 17.5's „neu" dot never lights.** `core/materialize.js:isNewOf` is correct and
   tested; `store.js:_project` supplies none of `seqOf` / `isNew` / `lastSeenSeq` /
   `levelDecreased`. Both halves exist and are not joined. `store.js` is a parallel workflow's, so
   the fleet row is green while the defect exists and says: *if it goes red, invert it, do not
   repair it.*
8. **LZP-1003's five residuals**, all priced, none closed: **R1** a stolen backup yields the whole
   board in the clear (the *board* block is plaintext on both export paths; the copy reads as
   though the passphrase protects it); **R2** the backup file + passphrase is an unbounded,
   undetectable member-cloning primitive, and §8.5's only stated mitigation renders as nothing
   because `family/mount.js#refreshRoster` drops the device count; **R3** epoch poisoning is
   locally correct and unreportable — the honest and hostile cases produce the identical number;
   **R4** the 5-attempt pairing cap is a typist's budget (four fresh sessions absorb 20 wrong
   codes); **R5** A2 is enforced on two collections out of five, safe only until WP-10 ships a
   shared scratchpad.
9. **E10-4 · the tier-2 isolation guard fired once** against the user's real Application Support
   directory (§1a of this document). Not reproduced; not dismissed.
10. **`sync_request` in both shells** is mid-flight. Every fleet and payload row here asserts
    **properties** of the request and its answer — never a line number in `net.js` — so that file
    can move underneath them. One behaviour change already landed and was accommodated: the bridge
    now refuses a reply that does not name the URL the bytes came from (finding P-5).

---

## 8. Falsifiability — ten mutants, on a scratch copy, never in place

Control: an unmutated scratch copy of the working tree, `tests/attack/e10-*.test.js` → **100 pass /
0 fail**. Every mutant was reverted and the control re-run at the end: **100/100**. No `git stash`,
no mutation of the real tree.

**A second control, and the reason for it.** The two files this pass adds assert properties of
`shell-macos/main.swift`, `src-tauri/src/lib.rs` and `src/js/platform/net.js` — all three owned by
parallel workflows and all three uncommitted. So they were also run against a scratch tree carrying
**`HEAD`'s** version of those three files, where `sync_request` does not exist in either shell:
**40 pass / 0 fail.** Green on the integrated tree and green on the tree this commit actually
produces. That is what §1c's biconditional and §1e's guard-clause branch are for.

| # | mutation, in the copy only | row that died |
|---|---|---|
| M1 | `func sendFeedbackNow` with a `URLSession` appended to `main.swift` | §1a **and** §1g |
| M2 | `case "feedback_send":` added to the bridge switch | §2b |
| M3 | `POST /feedback` added to the relay's route table | §2c **and** §2d |
| M4 | `snapshotBoard()` using `canvas.toDataURL` added to `print.js` | §3a |
| M5 | `guard prefs.disclosed, prefs.enabled` removed from `updaterFetchManifest` | §1e |
| M6 | `SyncPrefs.enabled` defaulted to `true` | §1f |
| M7 | `net.js` grows an `X-LZP-Debug` header echoing the body | §1e *(and **not** §1a — see §5)* |
| M8 | `spellings()` returns only the plain string | §2e |
| M9 | the `disclosed` gate removed from `createUpdater` | §5f *(and **nothing**, before §5f was written)* |
| M10 | `LAUNCH_GAP_MS = 0` | §5d |
| M11 | `case "sync_request"` renamed, the sync socket left in place | §1c |

**M9 is the one worth reading.** On the first attempt it killed *nothing*: §5a has `enabled:false`
as well, and §5b is the enabled gate's own row, so the two gates covered for each other. §5f — a
Mac whose switch is on but which was never told what it does, which is what a restored machine or
a copied prefs file produces — was written **because that mutant survived**, and it kills it.

**M11 is the third**, and it is why §1c reads the door from the shell's own dispatch rather than
by grepping the file for `sync_request`: a text match counts the name in a comment and in a case
label that has been renamed out of service, and the row would then be green over a live socket
behind a dead door.

**M7 is the second.** It reddens the header allowlist and not the needle search, because the
plaintext never reaches the transport at all. That is a fact about the architecture, and it is why
§5's four earlier rounds are not superseded by this one.

---

## 9. What a reader should NOT conclude from a green E10

- **"Solo mode makes zero network requests" is false as literally written.** The *board* makes
  zero. The *shell* makes one, once a day at most, only after the user has been told and left the
  switch on. That is 21.5 ∧ 22.3 resolved the most conservative way available, and it is written
  out in full in `updater.js`'s header — but the marketing and About copy may not quote v1's
  sentence unqualified, and LZP-1001 has not written the qualified one.
- **The census is a name test.** `syncSendEverything` would pass §1a. It bounds jobs, not
  behaviour.
- **§3's "no image exists" is vacuous truth, not verified redaction.** It is the strongest true
  statement available and it is not the statement the PO asked for.
- **A completed pairing authenticates nobody** (LZP-1003, E10-P7): across a whole successful
  pairing the module makes zero `sign` and zero `verify` calls. The proof is possession of
  `RK_sig` plus a human comparing six digits. That is the design; a green pairing suite reads as
  "the device was verified", and it was *authorised*, by a person.
- **"Sealed" means integrity on the backup's board block and confidentiality nowhere else there**
  (R1). On the wire it means both, and §5's §1c measures that separately.
- **17.4 (density) is browser-only and its DOM rows are red.** The nine failures in §1 are the
  only honest verification of that story and they are somebody else's, in flight.
- **`test:fleet`'s 397 green rows contain no evidence about `sync_request`**, which is unimplemented
  in both shells; they run the `fetch` shape. The cost is one hop and it is named in three file
  headers and in `traceability.json`.
