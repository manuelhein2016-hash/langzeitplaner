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

> **⚠ SUPERSEDED 2026-09-03 by LZP-1002 — read §10b before reading the rest of §3.** The wording
> quoted above is the OLD one. Story 21.5 now says *"zero **unrequested** network requests"*, with
> LZP-1009's Rückmeldung as the single named exception; the PO decided that on 2026-09-03 and it
> is recorded in ADR 003 §7.5 and **D10**. Every measurement in §3b–§3d below still stands and none
> of them moved — what changed is what the numbers are being held to.

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
2. ~~**LZP-1001 — the Datenschutz section is not in the product.**~~ **CLOSED 2026-09-03 — see
   §11.** It is a top-level section of ⚙ on every launch, in both languages: 24 blocks, 5 234
   characters of German. It names Vercel, Prisma Postgres and **EU/Frankfurt** (D2), enumerates
   ADR 003 §5.2's inventory, names the **second remote** (the GitHub manifest, no identifier,
   switchable off, not in the EU), states the retention honestly per RUNBOOK §7.2, and states in
   both languages that a feedback report is **not** end-to-end encrypted the way an entry is. A1's
   permission is used in its **scoped** form — „Von allein sendet dieses Programm nichts" — and
   held by `network-scope.test.js` §5e.
3. **LZP-1006 — the Mom test itself.** Blocked on a person, and on E-1/E-2/E-3 above being fixed
   first so her afternoon is not spent on known defects. D1 (signing) determines its quality.
4. **LZP-106's unlock screen** — `gatekeeper_status` is unimplemented in both shells (§6).
5. **`Bitte zuerst lesen.html` is not on the disk image** (§6).

**Owed, not blocking.**

6. ~~**LZP-1009 — the feedback button.** Not built.~~ **BUILT 2026-09-03, and two of the four
   predictions in this bullet were WRONG — see §10a.** It is **not** a third network job and
   **not** a second remote host: it is a POST to the sync relay's own origin over the existing
   transport, so the native-socket exception count is still **two** and §1a/§1g stay green for the
   reasons they were written. Only §2c and §2d inverted; §2a and §3a were still green *after the
   whole feature shipped* and neither was green because its claim held (E10-1009-B). And there is
   **no third processor** — the sentence the copy actually owed was that a report is **not**
   end-to-end encrypted, which is larger than the one predicted (§11, §10b).
7. **E10-1 · story 17.5's „neu" dot never lights.** `core/materialize.js:isNewOf` is correct and
   tested; `store.js:_project` supplies none of `seqOf` / `isNew` / `lastSeenSeq` /
   `levelDecreased`. Both halves exist and are not joined. `store.js` is a parallel workflow's, so
   the fleet row is green while the defect exists and says: *if it goes red, invert it, do not
   repair it.*
8. **LZP-1003's five residuals**, all priced, **one now half-closed**: **R1** a stolen backup
   yields the whole board in the clear (the *board* block is plaintext on both export paths; the
   copy read as though the passphrase protected it) — **the COPY half is closed in the Datenschutz
   section, §12; the `crypto/backup.js` strings are unchanged and E10-B7 is still green over a
   narrower object than the product, filed as R1-b**; **R2** the backup file + passphrase is an unbounded,
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

- **"Solo mode makes zero network requests" is false as literally written — and the story has
  been amended rather than left that way.** The *board* makes zero. The *shell* makes one, once a
  day at most, only after the user has been told and left the switch on; and since LZP-1009 a
  *human press* can make one more. 21.5 now reads "zero **unrequested** network requests" (PO,
  2026-09-03 · ADR 003 §7.5 · **D10** · §10b of this document), and LZP-1001 has written the
  qualified sentence: „Von allein sendet dieses Programm nichts." The marketing and About copy may
  quote **that**, and not v1's unqualified one.
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

---

# ADDENDUM — LZP-1001 + LZP-1002, 2026-09-03 (after LZP-1009)

**Tickets:** LZP-1001 (Datenschutz section, 2 pts) · LZP-1002 (network scope audit, 3 pts) ·
**Stories:** 21.3, 21.4, 21.5 · **Amendments:** A1, A10 · **PO decisions:** D2, D8, **D10 (new)**,
**D11 (new)** · **Normative:** ADR 003 §5.2, §6.3, **§7 and the new §7.5**

## 10. The amendment — and why it is the section a conformance sweep should read first

§3 above tested story 21.5 as written and §7 item 6 predicted what LZP-1009 would cost it. **Both
were half right, and the half that was wrong is the one that matters.**

### 10a. What §7 item 6 predicted, and what actually landed

| §7 item 6 said | what shipped |
|---|---|
| "a **third** network job" | **No.** A POST to the sync relay's **own origin** over the **existing transport**. The native-socket exception count is still **two** (sync, update) — `e10-network-scope.test.js` §1a is green for the reason it was written |
| "a **second** remote host" | **No.** No new host, no new literal; §1g still finds exactly one remote URL in the whole product and it is still the `OWNER-PLACEHOLDER` update manifest |
| "§1a, §1g, §2a–§2e … **inverted**" | Only §2c and §2d inverted. §2a and §3a were **still green after the whole feature shipped, and neither was green because its claim held** — finding E10-1009-B |
| "a Datenschutz sentence naming a **third processor**" | **No third processor.** One paragraph about a report that is *not end-to-end encrypted*, which is a bigger sentence than the one predicted and a smaller change to the processor list |

**§7 item 2's remaining half is now closed too**: „Frankfurt", „Vercel" and „Prisma" appear in
`src/js/settings.js`, on a screen, in both languages. `docs/v2/RUNBOOK.md` §7's *"until LZP-1001
puts that on a screen, **you are the Datenschutz page**"* no longer applies.

### 10b. ██ THE AMENDMENT, VERBATIM ██

Story 21.5's "zero" was **false from the commit that landed LZP-1009**, because „Rückmeldung
senden" lives in Einstellungen and Einstellungen is in the boot graph of every launch. The story
is amended. It is written into `docs/v2/adr/003-sync-protocol.md` §7.5 and into
`DESIGN-DECISIONS.md` **D10**, with both wordings quoted and the decider named, because **amending
a measured property is exactly the quiet erosion a conformance sweep hunts for** — `judge:
conformance` B-14 caught gate 1 of the same section being *vacuously* true by the same mechanism.

> **OLD** — story 21.5, and §7's own heading in ADR 003, until 2026-09-03:
> "Network scope, replacing 13.4: **in solo mode the app makes zero network requests**; with a
> Familienkreis it talks to exactly one sync endpoint and nothing else. The v1 property survives
> as a scoped guarantee."

> **NEW** — story 21.5 as amended:
> "Network scope, replacing 13.4: **in solo mode the app makes zero *unrequested* network requests
> — the only request a solo copy can originate is the one a human asks for, by pressing „Senden"
> on the Rückmeldung screen (LZP-1009)**; with a Familienkreis it talks to exactly one sync
> endpoint and nothing else. The v1 property survives as a scoped guarantee."

> **DECIDED BY:** the **PO**, on **2026-09-03**, presented with the fact and the alternative. The
> alternative was to make the feature family-only, which refuses the report from the only tester
> who has no Familienkreis — the person the feature exists for, and the person whose report will
> say „ich komme nicht mehr rein". The PO chose to amend.

**It is a narrower promise, not a softer one, and this is the whole argument.** The old wording
bounded a **count** (zero); a count can only ever be measured over sessions somebody thought to
script, and it goes green over the session nobody ran. The new wording bounds an **originator** —
a human press, and nothing else — which is a property of the source tree, checkable by
construction, and the property that actually fails when the exception widens.

### 10c. The measured numbers, on both sides of the amendment

**SOLO — zero, and the exception costs zero until it is pressed.** Measured in the real browser
(`node dev-server.mjs`, Chrome, both languages, ⚙ opened twice, the whole Datenschutz section
read):

| measurement | result |
|---|---|
| subresources on a solo launch + two settings sessions | **48** |
| off-origin resources | **0** |
| `/api/` calls | **0** |
| resources with `initiatorType` `fetch` or `xmlhttprequest` | **0** |
| family-graph modules loaded (`crypto/`, `sync/`, `family/`, `platform/net.js`) | **0** |
| `src/js/feedback/` modules loaded (the price of the exception) | **8** · 93 193 B of pure DOM code that imports nothing which can open a socket |

And in the shipping engine, `tests/tier2/datenschutz.dom.js` **§7** — the measurement this
addendum adds, because `network-audit.dom.js` §2's solo session never opens ⚙ and therefore said
nothing about the screen the exception lives on:

| §7 row | result |
|---|---|
| §7a · open ⚙ (draws Datenschutz **and** Hilfe), open the Rückmeldung sheet, type, reach the preview with the redacted PNG rendered — spies on all five socket APIs | **0 calls, 0 dispatches** |
| §7b · press „Senden" once, with a port bound | **1 dispatch, 0 socket calls** (the tree holds a port; it cannot open a socket itself), body has `report`, body has **no `to:`** |
| §7c · the spy, shown a positive | fires on `fetch` and `WebSocket` |

**SOLO — the source claim.** `tests/tier1/network-scope.test.js`, over the tree it names:

| | measured |
|---|---|
| shipped `.js` files under `src/js/` scanned | **78** (`platform/` and the DOM layer included — finding F-9's blind spot) |
| network identifiers outside `platform/net.js` | **0** |
| network identifiers inside `platform/net.js` | **1** (`fetch`) |
| static paths from `boot.js` / `firstrun.js` / `main.js` to `net.js`, `sync/`, `crypto/`, `family/` | **0** |
| dynamic doors out of the eagerly-evaluated graph | **1** — `main.js → family/mount.js` |
| **originators of a feedback report, in the whole tree** | **1**, kind `human`, `src/js/feedback/ui.js:245`, trigger `addEventListener('click', …)` |

**FAMILY — one endpoint, and everything else refused by name.** `network-audit.dom.js` §3, in the
shipping engine, against a transport whose `fetchImpl` records instead of dialling:

| | measured |
|---|---|
| the client's whole request surface (ops ×2, spaces, members, pair/offer, devices/adopt) | **6 requests, 6 inside `<origin>/api/v1/`**, 0 outside |
| second-origin shapes attempted (`OTHER`, protocol-relative, suffix look-alike, traversal, `/api/v2/`, bare `/ops`) | **6 refused**, all `NetError`, **0 reached the socket** |
| methods other than GET/POST | **6 refused**, `kind: 'blocked'` |
| a GET carrying a body | refused |

### 10d. ██ THE EXCEPTION MAY NOT WIDEN — and the gate that detects it ██

**The failure mode this ticket is actually defending against is not a second endpoint.**
`e10-network-scope.test.js` §2c counts endpoints and would catch one. It is a **second CALLER**:
one `setInterval` "so a stuck report retries", one `addEventListener('online', …)` "so it goes out
when the wifi comes back", one `unhandledrejection` handler that files a report by itself. Each
reads as a courtesy on its own; together they are an unattended solo Mac sending, **with every
endpoint gate in ADR 003 still green**, because none of them adds an endpoint.

`tests/tier1/network-scope.test.js` §5 is the gate. Five rows:

| row | what it holds |
|---|---|
| **§5a** | only `src/js/feedback/ui.js` may import `feedbackPort()` — the one way to reach `send`. Everyone else, including `family/mount.js` when it lands E10-1009-A, may import the **setter** and can bind but never fire. Also pins the port's export set, so a new getter cannot arrive unnoticed |
| **§5b** | across all 78 shipped modules: **1** originator, `human`. Any `automatic` row fails, naming file, line and enclosing function |
| **§5c** | `feedback/events.js` — the one module that listens to the machine (`error`, `unhandledrejection`) — does not import the port at all; and no timer or lifecycle event anywhere in the tree names the dispatcher |
| **§5d** | **ARMED**, run rather than reasoned (below) |
| **§5e** | the amended promise is on the **screen**, in both languages — a property amended in an ADR and not in the product is the erosion with an extra step |

### 10e. Mutants — run, not reasoned

Every one was run against the real tree and reverted; the control was re-run after each. **No
`git stash`.**

| mutant | planted | row that dies |
|---|---|---|
| **M1** | `setInterval(() => doSend(btn, st), 60000)` | §5b, §5d |
| **M2** | `window.addEventListener('online', () => doSend(btn, st))` | §5b, §5d |
| **M3** | `document.addEventListener('DOMContentLoaded', () => doSend(btn, st))` | §5b, §5d |
| **M4** | `function autoReport(){ feedbackPort().send({v:1}) }` + `setTimeout(autoReport, 0)` | §5b, §5d |
| **M5** *(live, on `feedback/ui.js` itself, then reverted)* | `window.addEventListener("online", () => doSend(null,null))` | §5b **and only** §5b + §5d's control; 18 other rows green |
| **M6** | the German amendment sentence deleted from the Datenschutz copy | tier 1 §5e **and** tier 2 §3a; 15 other tier-2 rows green |
| **M7** | `data-ds` dropped from the section's blocks (it still draws) | **14 of 19** tier-2 rows, §4a's absence rows included — which is the point: the ban rows are not satisfiable by an empty screen |
| **M8** | R1's sentence softened to „auch ohne dein Passwort einsehbar" in both languages | §5a **and** §5b |
| **control** | the second *human* press | classified `human`, not `automatic` — the gate does not cry wolf |

**M4 and M8 each found a real defect in a row I had just written, and both are recorded rather
than quietly fixed:**

- **M4** killed the first form of §5b's caller regex, `\b<fn>\s*\(`. `setTimeout(autoReport, 0)`
  and `addEventListener('online', autoReport)` dispatch a function **without ever writing a `(`
  after its name** — which is precisely the shape the retry patch takes. A reference is a caller;
  the regex is now `\b<fn>\b`.
- **M8** killed the first form of §5b in tier 2. That row asserted only that E10-B7's regex
  matched the union of the product's copy, and it stayed **green** with R1's sentence removed —
  because the regex's `nicht verschlüsselt` alternative matches the **Privat** paragraph, a
  sentence about family ops with nothing to do with a backup file. Green for an unrelated reason
  is the exact rot §2a and §3a of the E10 sweep died of. The inversion is now **located**: it must
  match inside `DATENSCHUTZ[lang].backupBody`.

An earlier defect, found before the mutants: §5b's classifier read the **stripped** source, in
which `addEventListener('click', …)` has had its string literal blanked — so the product's one
real human press was classified **automatic**. Detection now runs on stripped source (a `.send(`
in prose is not a call) and classification on the raw line (the thing that says a caller is a
person *is* a string literal). The two arrays are index-aligned because
`stripCommentsAndStrings` preserves newlines, which `netscope.js:scanSource` already depends on.

## 11. LZP-1001 — the Datenschutz section

**Where it is:** `src/js/settings.js`, a top-level section of ⚙, drawn on **every** launch,
between Sicherungen and Hilfe. **24 tagged blocks · 5 234 characters of German · 4 546 of
English.** Screenshotted in the real browser in both languages.

**A10 says it belongs inside the *Familie* section, and it is not there — decision D11.** Built
A10's way it is drawn by `family/mount.js`, the one dynamically imported door, and is therefore
**invisible on a solo install** — to exactly the reader whose backup file it is about, who is also
the least likely to have been told what is in one. Each family-specific paragraph names its
condition in its first clause instead. Held by `datenschutz.dom.js` §1a against the **real**
settings sheet on a Mac with no space.

**What it says, and what document each sentence answers to:**

| block | source of truth |
|---|---|
| solo = nothing, with D10's exception named and conditional | story 21.5 as amended · ADR 003 §7.5 |
| „Privat" is structural, not stronger encryption | ADR 004 — zero family ops, not redacted ones; peers hold no entity key. Six adversary rounds, zero bytes |
| one relay · Vercel + Prisma Postgres · **EU, Region Frankfurt** | 21.3, decision **D2**, addendum §3/§9 |
| what the relay *does* see — ids, **the colour**, last-seen, change counts, **256-byte-rounded** sizes, arrival order, IP + app version + clock | ADR 003 **§5.2**'s inventory. §5.2 says the colour "appears verbatim in the Datenschutz copy"; this is that appearance |
| what it *never* sees, **and the honest limit** — the shape shows THAT, never what | ADR 003 §5.2 · `server-metadata.md` §5 |
| retention: **„unbefristet"**, IP rows kept until deleted by hand, Vercel's own log under Vercel's terms | RUNBOOK **§7.2** — which forbids „wird nach einer Stunde gelöscht" in so many words. `datenschutz.dom.js` §2d bans that phrasing and requires the true one |
| the **second remote**: the daily GitHub manifest, no identifier, switchable off, not in the EU | `updater.js`'s 21.5 ↔ 22.3 note · RUNBOOK §7.3 · E1-VERIFICATION §2 |
| **the report is NOT end-to-end encrypted** — TLS in transit, readable at the far end | `server/core/handlers/feedback.js` |
| **R1** — the backup's entries are readable without the password | LZP-1003 finding R1 |
| **D8** — no reset, no account, nobody can recover it | decision D8 |
| 21.4's closing list — no analytics, trackers, ads, foreign fonts, maps, error reporter | story 21.4 |

**The host is deliberately not printed.** §1g of the E10 sweep says the one remote URL in the
product is still `OWNER-PLACEHOLDER`; a Datenschutz page naming a host that does not exist is
worse than one naming the company. `datenschutz.dom.js` §2e fails if a URL ever appears in the
copy — which also keeps `e10-network-scope.test.js` §2e ("no shipped module names a resolvable
remote host") from acquiring its first exception in a privacy paragraph.

**It does not market.** §4a bans reassurance vocabulary („100 % sicher", „militärisch",
"bank-level", "we take your privacy seriously") and, per Principle 9, survey vocabulary
("bewerten", "survey", "recommend") — each ban paired with a length assertion over the same text,
so none of them is satisfiable by an empty section. M7 proves that pairing works.

## 12. R1 — the correction, and the row it inverts

**LZP-1003 R1:** a stolen backup yields the whole board in the clear, with no passphrase. `board`
is plaintext JSON on **both** export paths; D8 only ever covered the identity block. The defect is
in the **copy** — `README.withIdentity` says „Wer diese Datei und dein Passwort hat, ist du",
which a reader hears as *both are needed*, and `sealsEntriesToo` says „Auch die Einträge sind
versiegelt", where „versiegelt" does **integrity's** work in a sentence a non-technical reader
hears as **confidentiality's**.

The true sentence is now in the Datenschutz copy, in both languages:

> „In einer exportierten Sicherung stehen deine Einträge im Klartext … **ohne Passwort lesbar,
> auch bei einer Sicherung MIT Passwort. Das Passwort schützt die Schlüssel, nicht die Einträge.**
> … es macht die Datei fälschungssicher — **es macht sie nicht unlesbar.**"

**██ THE INVERSION, AND THE DEVIATION IN IT. ██** `tests/attack/e10-crypto-backup.test.js` E10-B7
carries the assertion this inverts — *"No string anywhere in the export sheet, the READMEs or
LIMITS tells the user that the entries are readable without the password. If one is ever added,
this assertion is what has to be inverted."* That row scans three exports of
`src/js/crypto/backup.js`, **a file this ticket does not own** (ONE OWNER PER FILE). So the
inversion is written in `tests/tier2/datenschutz.dom.js` §5b instead, against the same matcher,
and the consequence is stated rather than hidden: **E10-B7 is still green over a narrower object
than the product.** Filed as **R1-b**, FINDINGS §20c, owner: whoever next opens `crypto/backup.js`.

**D8's key-loss consequence** now sits where a person meets it before it matters rather than in a
support script after: „Es gibt kein Zurücksetzen des Passworts, weil es kein Konto gibt … kann
niemand deine Daten wiederherstellen — **wir nicht, Vercel nicht, Prisma nicht.**" Naming the
three parties is what makes it land; a reader who has heard „verschlüsselt" all week assumes a
company somewhere holds a spare.
