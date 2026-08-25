# Definition of Done — LangzeitPlaner v2

The delivery plan states the Definition of Done as one sentence (§6):

> Referenced spec-story ACs verified against v1.0 + v2.1 wording · unit tests plus, where sync-touching, a scenario in the E2E fleet suite · fully functional offline · crypto-review check: no plaintext leaves the device outside the design (Belegt = redacted) · strings in DE and EN · ships through the real updater to an internal build · migration-safe against a real pre-change data file · introduces no network destination beyond the sync endpoint.

This document expands that sentence into eight gates an implementing agent can self-verify against **before** claiming a ticket is done. Every gate is a list of checkable facts, not intentions. A ticket is done when every applicable gate is checked and the close-out block at the end is filled in.

**Machine-readable companion:** `docs/v2/traceability.json` — story → ticket, ticket → story, amendments, deps, blocking decisions, constraints. Gate 1 is verified against that file.

**Applicability.** Gates 1, 3, 5, 7, 8 apply to **every** ticket without exception. Gates 2, 4, 6 apply conditionally; each names its own trigger. "Not applicable" is a legitimate answer only when the gate's trigger clause says so, and the close-out block must say which trigger was absent.

---

## Gate 1 — Story ACs verified against the spec wording

**Trigger: every ticket.**

- [ ] Every story id listed in `tickets[].stories` for this ticket in `docs/v2/traceability.json` has been re-read **in its source document** (v1 §6–§8 for F1–F14, addendum §4–§5 for F15–F22) — not from the ticket summary. The ticket text is a summary; the story number is the contract.
- [ ] Every amendment id in `tickets[].amendments` has been re-read in addendum §7, and the amended v1 story has been re-read too. An amendment changes a v1 story; both wordings must be reconciled in the implementation.
- [ ] For each story, one named, reproducible check exists that would fail if the story regressed. Name it in the close-out block (test id, script, or a numbered manual step).
- [ ] Nothing was implemented that no story asks for. New behavior without a story number is scope creep (Risk R6); it goes to the backlog, not into the sprint.
- [ ] If the implementation contradicts the spec wording, the contradiction is written up and raised with the PO **before** merging. Silent reinterpretation of a story is a hard fail.
- [ ] `[Could]` stories (17.7 is the only one in v2) are not started before every `[Must]` in the sprint is green.

**Self-verify**

```bash
node -e '
const t=JSON.parse(require("fs").readFileSync("docs/v2/traceability.json","utf8"));
const id=process.argv[1];
const k=t.tickets.find(x=>x.id===id);
console.log(k.id, k.title, "| sprint", k.sprint, "| pts", k.points);
console.log("stories:", (k.stories||[]).join(", ")||"(none — see note)");
console.log("amendments:", (k.amendments||[]).join(", ")||"(none)");
console.log("deps:", (k.deps||[]).join(", ")||"(none)");
console.log("blockedBy:", k.blockedBy||"(nothing)");
if(k.note) console.log("note:", k.note);
(k.stories||[]).forEach(s=>{const st=t.stories.find(y=>y.id===s);
  console.log("\n["+st.id+"] "+st.feature+" ("+st.source+", "+st.priority+")\n  "+st.text);
  if(st.amendedBy.length) console.log("  amended by: "+st.amendedBy.join(", "));
  if(st.note) console.log("  note: "+st.note);});
' LZP-701
```

---

## Gate 2 — Tests, including the E2E fleet suite where sync is touched

**Trigger: every ticket needs unit tests. The fleet-suite clause triggers when the ticket touches the op-log, the sync client, the server, crypto, or any entry metadata that crosses a device boundary.**

- [ ] Unit tests cover the ticket's own logic, including the failure paths — not only the happy path.
- [ ] Tests run with **zero runtime npm dependencies**. v1 has none, and that is a value to preserve, not an accident. A test-only devDependency needs an explicit decision recorded in `DESIGN-DECISIONS.md`; a new *runtime* dependency needs PO sign-off.
- [ ] Tests are deterministic: no wall-clock dependence (inject the date), no network, no ordering assumptions on object keys, no reliance on the developer's own `board.json`.
- [ ] **Sync-touching only:** a scripted scenario exists in the multi-device fleet suite (LZP-1005) covering this ticket's stories — 2 own devices + a 3-member family. LZP-1005 owes one scenario per F15–F18 story; a ticket that lands a story from that range must leave its scenario behind.
- [ ] **Sync-touching only:** the scenario asserts *convergence*, not just delivery — ops reordered, duplicated and interleaved end in the same materialized state (the LZP-406 property harness).
- [ ] **Sync-touching only:** an offline→online transition is part of the scenario, not a separate manual test.
- [ ] The full v1 regression suite is green. This is a standing gate for the whole of Path A, and the explicit AC of LZP-402 (Risk R5).
- [ ] CI is green on the merge commit — trunk-based development means a red trunk blocks the pair, not just the author.

**Self-verify**

```bash
npm test            # unit + regression
npm run test:e2e    # fleet suite, where it exists
```

---

## Gate 3 — Fully functional offline

**Trigger: every ticket.** Local-first is story 19.1, principle 7 (solo-first) and the reason the product is trusted.

- [ ] With the network disabled, the feature this ticket touches still works: create, edit, move, resize, delete, print, find, settings. Nothing waits on a response, nothing greys out, nothing shows a spinner on the board.
- [ ] Changes made offline are queued locally and pushed when connectivity returns — no data is lost, no user action is required to flush the queue.
- [ ] There is no sync button and no manual refresh anywhere (19.2). If the ticket added one, remove it.
- [ ] Sync status stays silent when healthy; only pending-offline or a real error surfaces, and calmly (19.3). No spinner on the board itself.
- [ ] **Solo mode is untouched.** A fresh install with no Familienkreis behaves exactly like v1: no account, no network activity, no prompts, unchanged first-run flow (15.1, principle 7, A10).
- [ ] No UX copy anywhere promises "live", "real-time", or "instant" sync. The pull cadence is ~30–60 s and honesty about that is specced (addendum §3).
- [ ] Timeouts and backoff are bounded; a dead server degrades to "pending", never to a hang or a modal.

**Self-verify**

```bash
# macOS: drop the network, exercise the feature, restore, confirm the queue drains
networksetup -setairportpower en0 off
# … exercise …
networksetup -setairportpower en0 on
```

---

## Gate 4 — No plaintext off-device outside the design

**Trigger: any ticket that writes an op, encrypts, decrypts, handles keys, publishes to the server, renders someone else's entry, or logs.**

The design permits exactly this much to leave a device, and nothing else:

| Leaves the device | Form |
|---|---|
| Geteilt entries | end-to-end encrypted to the space key |
| Belegt entries | **client-side redacted before encryption** — owner, dates, color only; the text never enters the op |
| Privat entries | end-to-end encrypted to **my own paired devices only**; no family key can ever apply (21.2) |
| Coordination data | pseudonymous ids, timestamps, sequence numbers, ciphertext sizes (inventoried by LZP-207) |

- [ ] Redaction for Belegt happens **on the owner's device before encryption** (LZP-701). The server never receives the text and therefore cannot leak it; a server-side redaction would be a hard fail.
- [ ] Private entries are never encrypted under a space/family key. Verified by a test that asserts a family key cannot decrypt a personal-space op.
- [ ] Categories, category names and month scratchpads never enter the family op stream (A3, A5). Scratchpads stay private in v2 by design.
- [ ] Keys live in the macOS Keychain (LZP-302), never in `board.json`, never in logs, never in an error message, never in a crash report.
- [ ] Logs — client and server — contain no entry content, no display names in clear, no key material. Server logs are structured and content-free (LZP-205).
- [ ] Membership changes rotate the space key, so a removed member cannot decrypt future ops (20.2, 20.5, LZP-303). If this ticket changes membership in any way, rotation is wired and tested.
- [ ] No new field was added to an op envelope without deciding, in writing, whether it is content (must be inside the ciphertext) or coordination data (may be metadata). Default: inside the ciphertext.
- [ ] The admin role gained no read access to anything. 20.5 is enforced by encryption, not policy — check that no code path grants an admin a key they would not otherwise hold.
- [ ] No surveillance mechanics were introduced in either direction: no presence, no read receipts, no "X made an entry private" notification, no per-member visibility (principle 9, addendum §9). Downgrading visibility notifies nobody.
- [ ] The export file contains my data and my identity keys only — never another member's entries (A2). Its header comment says plainly that it is the recovery artifact.
- [ ] If the ticket touched crypto at all, its diff is on the list for the LZP-1003 self-audit and the ticket says so.

**Self-verify**

```bash
# Nothing readable may sit in the transport. Dump what the client would push and grep it.
node scripts/dump-outbox.mjs --fixture family | grep -iE 'Zahnarzt|Urlaub|<known fixture text>' && echo "FAIL: plaintext in outbox"
```

---

## Gate 5 — Strings in DE and EN

**Trigger: every ticket that adds or changes any user-visible string.** German is the default; English is a toggle (13.7), and both ship in the same build.

- [ ] Every new string exists in both DE and EN in `src/js/i18n.js`. No hardcoded literal in a component, no fallback to the key, no untranslated English leaking into the German UI.
- [ ] German is written first and reads like German, not like translated English. The addendum's glossary (§13) is binding for the shared vocabulary: Familienkreis · Mitglieder / Verwalter · Einladungscode · Privat / Belegt / Geteilt · Sichtbarkeit · „Familie darf bearbeiten" · Gerät koppeln · von Mama · geändert So. · Kreis verlassen / Kreis löschen · Update verfügbar — Neustart zum Aktualisieren · Auf Updates prüfen …
- [ ] Destructive confirmations state the consequence in one plain sentence, in both languages (20.2, 20.3, 20.4, deliverable 22). "Are you sure?" is not a consequence.
- [ ] The Datenschutz copy is human German, not legalese, and names the processors and region (21.3, LZP-1001).
- [ ] Both languages were checked at the real row height. German is roughly 30 % longer than English; a label that fits at 22 px in EN and clips in DE is not done.
- [ ] Category names remain per-language: renaming in the German UI does not overwrite the English label (existing v1 decision).
- [ ] No string asserts something the product does not do — no "live", no "sofort", no promise of notification.

**Self-verify**

```bash
node -e '
const s=require("fs").readFileSync("src/js/i18n.js","utf8");
const de=[...s.matchAll(/^\s*([a-zA-Z0-9_.]+)\s*:/gm)].map(m=>m[1]);
console.log("keys:",new Set(de).size);
' && grep -rnE '>[^<>{]*[A-Za-zÄÖÜäöüß]{4,}[^<>{]*<' src/js/*.js | grep -v i18n | head
```

---

## Gate 6 — Ships through the real updater to an internal build

**Trigger: every ticket, from S1 onward.** Pipeline-first is a deliberate strategy call: everything after S1 ships through the real updater so distribution is dogfooded for 18 weeks rather than bolted on at the end.

- [ ] The change is on a tagged internal build that an existing installed build **updated itself into** — not a local `npm run dev`, not a hand-copied `.app`.
- [ ] The update was signed with the updater key and verified before installing (22.6). An update that installs unverified is a hard fail regardless of what it contains.
- [ ] The single stable channel was used. Internal testing uses local builds and Vercel preview deployments — **never** the family's channel (plan §2). No beta channel exists.
- [ ] The update applied without touching user data (22.7): the board after the update is the board from before it.
- [ ] The DMG stays within budget: ~15 MB target, ≤ ~20 MB hard (22.1, LZP-107).
- [ ] Bundled Schulferien data rode along with the build; no separate data download exists or was added (A11, 7.4).
- [ ] If the ticket changed the client↔server protocol: the server supports the current **and** previous protocol version, the compat harness covers both (LZP-206), and a min-version bump was considered and either applied or explicitly declined in the close-out block (22.7).

**Environment caveat for this machine.** There is no Rust toolchain here, so `src-tauri/` cannot be compiled locally and the Tauri updater path cannot be exercised on this box. Two consequences, both mandatory:

- [ ] The updater gate is verified in CI (GitHub Actions, LZP-101/102), not locally, and the close-out block links the run.
- [ ] Locally, the change is at minimum verified inside the Swift WKWebView shell, which builds here and emulates the `window.__TAURI__` surface:

```bash
./shell-macos/build.sh
/Applications/LangzeitPlaner.app/Contents/MacOS/LangzeitPlaner --smoke
```

`--smoke` loads the board headlessly, prints what it rendered and round-trips the bridge; its writes go to a scratch directory and can never touch the real board. A green `--smoke` is necessary, not sufficient — it does not stand in for the CI updater run.

---

## Gate 7 — Migration-safe against a real pre-change data file

**Trigger: every ticket that changes the shape of anything persisted** — `board.json`, snapshots, settings, the op log, the Keychain payload, or the server schema.

- [ ] The migration was run against a **real** pre-change `board.json` — a populated board with notes, multi-day bars crossing month boundaries, yearly repeats (including a Feb-29 series), scratchpads, hidden categories, and a chosen Bundesland — not against a freshly created empty file.
- [ ] The migration is **lossless**: entry count, category assignments, bar ranges, repeat anchors, scratchpad text and settings all survive. Compare before/after programmatically, not by eye.
- [ ] The last 7 daily snapshots migrate too (11.5, LZP-403). A migration that strips the safety net defeats its purpose.
- [ ] `schemaVersion` is bumped and the migration is idempotent — running it twice changes nothing the second time (11.6).
- [ ] Writes stay atomic (temp file + rename, 11.4). A crash mid-migration leaves the old file intact and readable.
- [ ] Downgrade behavior is defined: an older build meeting a newer file says so in one plain sentence rather than failing quietly or corrupting it (22.7).
- [ ] Dangling references are repaired rather than dropped, as v1 already does for category references.
- [ ] Server-side: the Prisma migration is part of the deploy step (LZP-109) and was run against a database that already contains ops.
- [ ] A copy of the pre-change file is retained in the test fixtures so this migration stays regression-tested after the next one lands.

**Self-verify**

```bash
cp ~/Library/Application\ Support/LangzeitPlaner/board.json /tmp/board.pre.json
# … launch the new build once, let it migrate …
node scripts/compare-board.mjs /tmp/board.pre.json ~/Library/Application\ Support/LangzeitPlaner/board.json
```

---

## Gate 8 — No network destination beyond the sync endpoint

**Trigger: every ticket.** This is 21.5, the scoped successor to v1's 13.4 (A1), and the property the whole privacy story rests on.

- [ ] **Solo mode makes zero network requests.** Not "few", not "only telemetry" — zero. Automated, not asserted by reading the code (LZP-1002).
- [ ] **Family mode talks to exactly one endpoint.** The sync endpoint, in the EU/Frankfurt region, and nothing else. The allowlist has one entry.
- [ ] No analytics, no tracking, no crash reporter, no third-party service (21.4).
- [ ] No CDN, no webfont request, no remote image, no external stylesheet, no `import` from a URL. Fonts ship in `assets/fonts/` or fall back to the system face — the existing v1 rule.
- [ ] The Tauri CSP still allows `self` and the IPC channel only, and no new networking capability was granted.
- [ ] The update check is the one permitted exception and it goes to the release channel defined by F22 — it is not a second general-purpose destination and must not carry user data.
- [ ] Server side: no outbound call to a third party from the sync functions. The relay is blind and stays blind.
- [ ] If this ticket added *any* host, port, or URL anywhere in the tree, it is named explicitly in the close-out block with the story number that authorizes it. Silence here is a hard fail.

**Self-verify**

```bash
grep -rnE 'https?://|fetch\(|XMLHttpRequest|WebSocket|EventSource' src/ src-tauri/src/ shell-macos/ \
  | grep -vE 'localhost:4173|dev-server|^\s*//|kmk\.org|schulferien' 
# every surviving hit must be the sync endpoint or the update manifest
npm run test:network-scope   # LZP-1002: solo = 0 requests, family = 1 allowlisted host
```

---

## Standing project rules (violate none of these to pass any gate)

1. **Zero runtime npm dependencies.** v1 has none. A new one requires PO sign-off and a `DESIGN-DECISIONS.md` entry.
2. **The board stays a whiteboard.** No reminders, no times of day, no chat/comments/reactions on entries, no read receipts, no push (addendum §1, §11). `YYYY-MM-DD` survives the network intact.
3. **Density is the feature.** Family entries obey the v1 lane cap (3.8), "+n" overflow (2.4) and truncation (2.5). Nothing this ticket adds may cost row height.
4. **Quiet signals only.** The update hint, the "neu" dot and the sync indicator are one family: a dot, never a modal, never a badge count (17.5, 19.3, 22.4).
5. **Print parity.** What is visible prints, including family entries and honoring member toggles (12.3, A8). Today's highlight is excluded from print.
6. **One Familienkreis per user, one admin at a time, 2–8 members, member colors collision-free** (addendum §9).
7. **`src/js/ferien.js` holds placeholder dates.** `FERIEN_META.verified` stays `false` until real KMK data lands; the settings horizon warning must not be removed to make a screenshot look tidy.
8. **Blocked tickets stay blocked.** If `traceability.json` gives the ticket a `blockedBy` decision, it is not done — it is not even started — until the PO resolves that decision. Check `decisions[]`.

---

## Ticket close-out block

Paste into the ticket before requesting review. An unchecked box with no reason is an open ticket.

```
DoD — LZP-___

G1 story ACs        [ ]  stories verified: ______  checks that would catch a regression: ______
G2 tests            [ ]  unit: ______   fleet scenario: ______ / n-a because ______
G3 offline          [ ]  verified offline: ______   solo mode unchanged: [ ]
G4 no plaintext     [ ]  ops touched: ______  redaction/keys: ______ / n-a because ______
G5 DE + EN          [ ]  new keys: ______   glossary respected: [ ]   DE length checked at row height: [ ]
G6 real updater     [ ]  CI release run: ______   self-update verified: ______   shell --smoke: [ ]
G7 migration        [ ]  pre-change file used: ______   lossless diff: ______ / n-a because ______
G8 network scope    [ ]  hosts added: none / ______ authorized by story ______

Blocking decision:  none / D_ (unresolved → ticket cannot close)
Spec contradictions raised: none / ______
Out-of-scope items pushed to backlog: none / ______
```

---

*Derived from LangzeitPlaner_V2_Epics_Sprint_Plan.md §6, with the constraint set of addendum §9 and v1 §13. Story numbers are the contract — when this document and a story disagree, the story wins and this document is wrong.*
