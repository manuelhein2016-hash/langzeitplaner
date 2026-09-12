# v2 — where the work stands

**Last session:** 2026-09-12 (**the UX-audit fix cycle** — 196 catalogue items graded, 45 open,
39 closed) · **Stopped at:** `v2.0.0-rc.4` tagged. Full record: `docs/v2/UX-AUDIT.md` (every item
with its verdict and evidence), `docs/v2/UX-AUDIT-CATALOGUE.md` (the promises, with this cycle's
errata), findings in `FINDINGS.md` §25.

> **What that cycle found that no test tier could.** Tier 2 runs `shell-macos/main.swift`; the DMG
> ships `src-tauri/`; nothing compared them. The Ablage menu was broken in the shipped shell,
> CmdOrCtrl+P had no command at all and then shipped a selector that would have aborted the app,
> the key backup had no reachable UI, and the CmdOrCtrl+Q flush was hung off an event that quit
> path never emits. `tests/tier1/shell-parity.test.js` is the gate that now names that class;
> `FINDINGS.md` §25.3 is the one it still cannot see.

**Previous session:** 2026-09-05 (**the ship day** — repo, relay, database, origin, signing) ·
**Stopped at:** **everything a person could do by hand is done and measured; the pipeline has
never once done any of it.** Previous entries: LZP-1009's second pass (same day), and 2026-09-04's
audit fix cycle. Full record: `docs/v2/AUDIT.md` (the audit, with each finding marked and its
evidence) and `docs/v2/V2-FINAL.md` §−3; findings in `FINDINGS.md` §23.

---

## ██ THE SHIP DAY (2026-09-05) — WHAT IS DEPLOYED, AND WHAT IS STILL UNPROVEN ██

**DONE, with the evidence and not the assertion:**

```
repo      github.com/manuelhein2016-hash/langzeitplaner · PUBLIC · main pushed · CI green
          (incl. shell-rust on macos-14 — the only proof src-tauri compiles)
origin    https://langzeitplaner.vercel.app — six files, one commit, PURE ASCII
          main.swift:845 · lib.rs:749 · all four invitation mails · release-gate.test.js green
database  Prisma Postgres, eu-central-1 · both migrations applied by vercel-build.sh
          20260903092140_init · 20260905101500_report
relay     GET /api/v1/meta -> HTTP/2 200 · x-vercel-id fra1::fra1 · {"region":"fra1",...}
          no-store · HSTS · nosniff · no-referrer · and NO Access-Control-* even when asked
          with an explicit Origin: header
report    a real report POSTed to production -> 202, with the honest provesNot on the wire
          (the PO's own measurement)
signing   Developer ID ZZ77R3LWS4 · /Applications/LangzeitPlaner.app:
          spctl -> accepted / source=Notarized Developer ID · stapler validate -> worked
          codesign -> flags=0x10000(runtime) · TeamIdentifier=ZZ77R3LWS4      — BY HAND
probe     mom-test-probe.mjs -> exit 0 · 41 rows · 39 pass · 2 note · 0 FAIL   (M2s is a pass)
readiness check-server-config.mjs -> 40 passed · 0 failed · 0 warnings · 2 not checked here
suites    npm test 2323/2323 · attack 986/986 · server 1094/1094 +1 stated skip
          fleet 482/482 · property 101/101 · test:dom 930 pass / 3 fail (the named residuals)
          all re-run 2026-09-05. tier 1 was 2283 before this pass; the release wiring added 40.
```

**NOT PROVEN, and each one stays named:**

1. ~~**`cargo tauri build` has never run anywhere.** No universal binary — the x86_64 half has
   never been compiled by anybody — no bundler, no DMG from the real path. `git tag` is empty and
   `release.yml` has never executed.~~

   **Closed 2026-09-12 by `v2.0.0-rc.4`, and measured off the runner.** The published DMG was
   downloaded to a real Mac and checked there, not trusted from the workflow log:

   ```
   shasum -a 256          matches the published SHA256SUMS.txt, both artifacts
   lipo -archs            x86_64 arm64                  ← the Intel half now exists
   codesign               Developer ID Application: Manuel Hein (ZZ77R3LWS4)
                          flags=0x10000(runtime) · Mach-O universal (x86_64 arm64)
   stapler validate       worked — on the .app AND on the .dmg
   spctl --assess         accepted · source=Notarized Developer ID — on both
   latest.json            all three platform keys point at the universal tarball,
                          and every signature equals the published .sig byte for byte
   DMG contents           LangzeitPlaner.app · Applications symlink · „Bitte zuerst
                          lesen.html" · .background · .VolumeIcon.icns
   ```

   So the pipeline has now done, unaided, what a person did by hand on the ship day: step 9b's
   `notarytool submit --wait` → `stapler staple` → `stapler validate` on both images, behind a hard
   `spctl` gate demanding `accepted` **and** `source=Notarized Developer ID`. The DMG re-sign
   branch that was dead under D1 ran too.

   **What is still genuinely unproven, stated narrowly:** no DMG from this pipeline has been
   **installed and driven by a person**. Ten checks need a keypress inside a signed bundle and no
   automation on a runner or on this machine can reach them — Apple Events are refused `-1743` in
   both places. Four fixes in rc.4 compiled, read correctly and never executed (FINDINGS §25.3,
   §25.4), which is exactly why that list is not a formality. Known cosmetic gap: the runner has
   no Finder session, so the image carries no `.DS_Store` and the DMG window opens as a plain
   folder listing rather than the styled one. Functionally complete and notarized; to ship the
   styled window, build the image on a Mac with a desktop session (`scripts/make-dmg.sh`).
2. **The Prisma adapter's `U-REPORTONCE` and `U-REPORTTTL` have no database witness**
   (`server/adapters/prisma.js:938-939`). If `U-REPORTTTL` is wrong the 90-day retention is off by
   Frankfurt's summer hour and **nothing visibly fails** — reports live an hour longer or vanish an
   hour early, and the number in the Datenschutz copy is quietly false.
3. **L1 and L2 remain stated skips** until `--deep` runs against the deployed database; and
   `RUNBOOK.md` §2.5.1 has never met Frankfurt's **pooler** (R-8b), where every atomicity guarantee
   rests on getting an interactive `$transaction`.
4. **`U-RAWBODY` is not settled by that 202.** An unsigned report never reaches `verifySignature`,
   so a platform body parser would produce a byte-identical `JSON.parse` and the same answer. The
   claim needs one **signed** request, and its failure mode is a total outage.
5. **LZP-1006, the Mom test.** A person, a clean Mac, unassisted. Nothing here moves it.

---

## THE HEADLINE: a solo Mac can send a report, and „Berichte" can read it

```
npm test 2283/2283 · test:property 101/101 · test:attack 986/986
test:server 1094/1094 + 1 stated skip · test:fleet 482/482
test:dom 930 pass / 3 fail (59 files, per-file `# pass`)
```

**5 876 green rows, 3 red** — the same three named residuals and nothing else (§A4, §E1, §E3,
below). **Zero npm dependencies, `node_modules/` absent.**

### LZP-1009's second pass — what the PO ruled, and what it cost

Two things made the channel useless in practice, and the PO ruled on both (2026-09-04/05):

- **A solo Mac could not send.** The port was bound only behind the family door, and the report
  that matters most — „ich komme nicht mehr rein" — can only be written by somebody who is solo.
  **Ruled: a solo Mac may send.** D10's amendment stops being vacuous
  (`DESIGN-DECISIONS.md` → *D10 EXTENDED*).
- **The deployed relay bound no sink**, so even a family Mac got an honest 501. **Ruled: the report
  is kept for 90 days, plus manual delete, and the admin view is a screen inside the app on his
  Mac only, signalled by a quiet 5 px dot on ⚙** (D12).

Measured end to end against `node server/dev-server.mjs` (the LIVE relay has no
`LZP_REPORTS_ADMIN_PUB` set and still runs the previous deploy — see below): a solo, unsigned
report → **202 `proves: unsigned`**; it appears in the admin view with the **prose verbatim** and
the image **byte-identical**; `expiresAt − receivedAt = 7 776 000 000 ms = exactly 90 days`; a
91-day-old report is swept and answers **404** to both list and get; „Löschen" removes one; an
ordinary family device credential gets **401 `bad_signature`** on all three admin routes, a
well-formed `LZP1` header gets **401 `bad_auth`**, and a replay of the operator's own credential
gets **200 then 401 `replay`**. On a relay with **no operator configured** all three answer **404**
— the same answer `/api/v1/nope` gets.

**The ⚙ dot costs zero network requests**, measured as a difference rather than as a number:
opening ⚙ makes exactly **one** request (`GET /api/v1/feedback`, on a human press) and makes the
**same one** with the dot lit and with it dark.

> ### ██ SUPERSEDED LATER THE SAME DAY — THE RELAY CAUGHT UP ██
>
> **What stood here, verbatim:**
>
> > "⚠ **THE LIVE RELAY IS BEHIND THIS TREE.** `https://langzeitplaner.vercel.app` answers `GET
> > /api/v1/feedback` with **405** (the old route table) and `POST` with **501
> > `not_implemented`**. The three admin routes are not deployed and no operator key is enrolled.
> > Nothing in this pass has met Postgres."
>
> **Re-measured against production, 2026-09-05:** `POST /api/v1/feedback` with a malformed body →
> **400 `{"error":"bad_request","unexpectedField":"v"}"`** — the closed-shape validator in
> `handlers/feedback.js:187` is what runs, so the route table is deployed — and a **real** report
> POSTed by the PO → **202** with `provesNot` on the wire. `/api/v1/nope` → 404. The tree has met
> Postgres: `20260905101500_report` is applied in Frankfurt.
>
> **`GET /api/v1/feedback` now answers 404**, and that is the *designed* answer of a relay with no
> `LZP_REPORTS_ADMIN_PUB` — byte-identical to `/api/v1/nope`, because the operator surface must not
> advertise that it exists. **So 404 is evidence of nothing either way** about whether the operator
> key is enrolled, and this document will not read it as either. The sentence *"nothing in this
> pass has met Postgres"* is the only one here that is now simply false.

The three reds, named: `e8-density-legibility` §A4 (the 9 px ink floor, a PO ruling on
`palette.js`), `e8-density-perf` §E1 (`findWorst` straddling the 60 fps frame) and §E3 (the
saturated poster, a spec threshold error where 48 % is the mathematical ceiling and the row asks
75 %). None is new and none is this pass's.

⚠ **ON CI, TIER 2 SHOWS FOUR, AND THE FOURTH IS NOT REPRODUCIBLE ON THIS MAC.**
`e8-density-truncation` §C2 (*"at the 92 px minimum column the badges are a tax, and the line is
still a line"*) fails on the GitHub runner and passes locally, and it **already failed on the
runner at `21de06a`, before this pass touched anything** — it is a font-metric difference between
the runner's WebKit and this machine's, not a defect this pass introduced. §E1 is the flakiest of
the three named residuals and is a frame-budget row: it went green on one runner pass and red on
the next two, with no code between them. Measured on two consecutive runs of the same commit.
**The tier-2 job is therefore red on CI and has been since before this pass**; the three local
residuals plus §C2 are the whole of it, and each is named.

### The acceptance run — FIVE consecutive runs, 35 launches of the shipped binary each

| Run | Phases failed | Founder got a joiner's entry | Refusal ledger | Relaunch battery |
|---|---|---|---|---|
| 1–5 (ports 8801–8805) | **0 of 35**, every run | **YES**, every run | **0**, every run | **8 of 8**, every run |

The driver grew from 27 launches to 35: six new phases close the coverage hole the audit
identified. **Co-editing works on the second launch and the fifth** — Oma folds a peer's co-edit on
her *fifth* launch, Mama writes one on her seventh, and Papa — the entry's owner, who granted the
permission and then quit twice — folds it on his eighth. The exposure badge reads `geteilt` after a
relaunch, the „neu" dot lights (`isNew=true`, `.neu-dot=1` in the DOM), and a removed Mac gets
`pushed=0 rosterOk=false` with the remaining Mac reporting `onBoard=false inRegisters=false`.

### What the audit found, and where it stands

The audit's verdict was *"ship solo, hold the Familienkreis for one fix cycle."* That cycle ran:

- **F1, F13 — the release gate.** ~~The shipped constant is still `""`, which is *correct* for a
  solo release.~~ **Amended 2026-09-05: it is no longer `""`.** The gate did its job and the act
  it was gating was performed — `tests/tier1/release-gate.test.js` (20 rows) fails on a half-done
  substitution in **either** direction, demonstrated in four tree states, and it is green over
  `https://langzeitplaner.vercel.app` in all six files. The undelegatable placeholder
  `https://serveradresse-fehlt.invalid` — RFC 2606 §2, so unlike the abandoned
  `lzp-sync-po.vercel.app` (HTTP 404, claimable by anyone) no stranger could stand it up and
  harvest a joiner's invite token — has done its work and is gone from the mails.
- **F2, F3, F4, F9 — the compaction class.** Closed by one general statement: a question about the
  PRESENT is answered by the register (`_absorbedGovernanceOps`, a 2-row table), a question about
  HISTORY belongs outside compaction (`_persistOps` retains the admin-chain lines). All seven
  red-on-arrival rows in `tests/audit/compaction-sweep.test.js` turned green.
- **F5 — the Datenschutz screen.** Four false sentences replaced, five disclosures added, both
  languages, 19 rows at the glass and 7 new `tests/server/` rows binding the numbers on the screen
  to the live server enums.
- **F6, F7, F8, F11 — the glass.** The „neu" dot lights and fades, a peer's op no longer discards
  uncommitted typing, a year page turn no longer leaves a stale `data-date` (and a no-op drag no
  longer publishes a phantom `pub.date`), and a peer's new *bar* dropped by the lane cap is now
  counted into the „+n" badge's „neu" tell.

**Still open:** F14 — **amended 2026-09-05**, its *remotes* half is closed (`origin`, public, `main`
pushed, CI green) and its sharp half is untouched: **0 tags, `release.yml` has never run,
`cargo tauri build` has never run anywhere** — every F15 item, F12's remaining doc drift outside the
release documents (`MOM-TEST.md`, `RUNBOOK.md`, `SHELL-VERIFICATION.md`, `traceability.json`), and
F10 — 18.5's inconsistent interval — which is a **PO decision (D-G)**, not a defect, and was
deliberately not decided by engineering.

### ✅ THE TWO THINGS ONLY THE PO COULD DO — BOTH DONE 2026-09-05

> **What stood here:**
>
> > "### ⚠ TWO THINGS ONLY THE PO CAN DO
> >
> > 1. **Claim a relay host** and substitute it in one act: the four invitations *and*
> >    `SYNC_ORIGIN_BUILTIN` in both shells. `RELEASE-CHECKLIST.md` §A forces both halves.
> > 2. **Decide D10 / story 21.5.** The amendment was justified as *"the second refuses the report
> >    from the only tester who has no Familienkreis"* — and as shipped, the code refuses her
> >    anyway, because the feedback port is bound only inside the family door. Either the gate is
> >    wrong (the button should work solo) or the amendment bought nothing. The screen now says
> >    what the code does, so it is honest either way. See `AUDIT.md` §D10."

1. **Host claimed, substitution whole.** `https://langzeitplaner.vercel.app` in all six files, one
   commit, pure ASCII. `release-gate.test.js` green; `mom-test-probe.mjs` exit 0, 0 FAIL.
2. **D10 ruled: a solo Mac may send.** `feedback/relay.js#bindSoloSender`, the second dynamic door,
   onto `platform/net.js` and nothing else. The amendment stops being vacuous.

**And a third the PO also did, which was not on this list because nobody expected it this week:
D1 is reversed.** The app is signed, notarized and stapled under Developer ID `ZZ77R3LWS4`.

**What is left that only the PO can do, and it is now one item plus a person:**

- **Run `workflow_dispatch` and get it green** — the pipeline has never built anything, and
  `cargo tauri build` has never run anywhere.
- **Tag `v2.0.0-rc.1` — `git push origin v2.0.0-rc.1`, never `git push --tags`** (which would start
  a release run for every tag in the local repository), install it yourself, then tag `v2.0.0`.
- **Run the deep database checks** — `--deep` for L1/L2, `RUNBOOK.md` §2.5.1 for the pooler.
- **Rule on D-G / F10**, the backwards-folded interval. Untouched, still yours.
- **LZP-1006.** A real person, a clean Mac, unassisted, you not touching the keyboard.

### The re-pricing worth knowing before F2/F3/F4 are described to anyone

The audit predicted a real relaunch would lose *more* than the rig. Measured, it loses **less** —
on the shipped `.app` the fold never reaches the absorbed state at all, because the app re-pulls
from the relay and the lines come back *as lines*. The fleet rig, which quits and reopens with **no
relay in between**, is the *stricter* environment. So F2/F3/F4 were real for a Mac that quits and
opens with nothing to re-pull — offline, a pruned relay, a peer whose `since` cursor has moved past
the op — and were never reachable in the acceptance topology. **F6 is the exception**: it was wrong
with *and* without a relaunch, and it reproduced on the shipped binary every time.

---

# ═══ THE PREVIOUS SESSION (2026-09-03), KEPT AS THE RECORD ═══

Everything from here on is the closing pass that preceded the independent audit. Its numbers were
correct when written and are superseded by the block above; it is kept because the *reasoning* in
it — R-1's three defects, the refusal ledger's history, the shell verification — is still the
account of how the acceptance run got to zero.

## THE HEADLINE OF 2026-09-03: the refusal ledger is **0**, and it had never once been flat

```
npm test 2229/2229 · test:property 101/101 · test:attack 970/970
test:server 1002/1002 (1069 with a live Postgres) · test:fleet 435/435
test:dom 875 pass / 3 fail (55 files)
```

**5 612 green rows, 3 red** — and the three reds are the three named residuals:
`e8-density-legibility` §A4 (the 9 px ink floor, a PO ruling on `palette.js`), `e8-density-perf`
§E1 (`findWorst` straddling the 60 fps frame) and §E3 (the saturated poster, a spec threshold
error where 48 % is the mathematical ceiling and the row asks 75 %). None is new.

### The acceptance run — TEN consecutive runs, 27 launches of the shipped binary each

| Run | Phases failed | Founder received a joiner's entry | `unshare-owner (B)` | Refusal ledger |
|---|---|---|---|---|
| 1–10 | **0 of 27**, every run | **YES**, every run | **completed**, every run | **0**, every run |

Before this pass: `unshare-owner (B)` **BLOCKED 10 of 10** and the ledger **2 · 2 · 2 · 34 · 2**.
Before that (`SHELL-VERIFICATION.md` §9): the founder received a joiner's entry in **0 of 5** and
the ledger climbed 0 → 6 → 13 → 25 as the founder relaunched.

**The bar was 5 of 5 with the ledger flat at zero. Both halves are met, twice over.**

### R-1 was three defects, and the „DATA LOSS" headline on it was wrong

Nothing was ever deleted: `pub.alive` is nulled and never set false, the patch is `pub.*` only,
and the admin cannot address the owner's personal space at all. What was lost was the
**reversion**. The three:

1. **`store.js#_absorbedChainOps`** — `core/authz.js` stage 1 builds the admin chain from
   `space.set` **ops** and never from registers, so after the owner's first relaunch the chain is
   empty, `adminAtKey` answers `null`, and stage 3a refuses the retraction `notOwner` — terminally.
   This is `F-SHELL-1(b)` one register over. **That single refusal was the whole residual ledger.**
2. **`store.js#withoutForeignEntries`** — ADR 006 re-migrates `board.json` every launch, and
   `migrateV1` turned another member's entry into one of the viewer's OWN Privat notes, once per
   launch. Measured on the shipped binary: **seven copies after seven launches.**
3. **`shell-macos/main.swift#runTestFile`** — `exit()` never ran `applicationShouldTerminate`, so
   the 700 ms save debounce was abandoned at the end of every phase. That was the „she lost her
   entry" message, and it was the harness.

### And one that is NOT closed, and is new

`_absorbedChainOps` rebuilds only a **genesis-shaped** link. `transferAdmin` **is** shipped
(`adminpanel.js:654`, reached from `leavedelete.js:1433`), so a circle whose admin seat has moved
is still exposed. The previous residual list said no circle transfers the seat; it was wrong.
`tests/fleet/e12-unshare.test.js` §8 pins the refusal to guess. **R-1b, owner `store.js#_persistOps`.**

### LZP-1009 is wired, end to end, on the real relay

`family/mount.js#bindFeedback` binds the sender the ticket could not bind itself. The shell e2e's
new `feedback` phase asserts the app — not the test — bound it, builds a report off the live
board, searches the wire body for the Privat entry that is on that board, and gets a **202** with
a verified device signature. 10 of 10. **What is still owed is a destination:**
`server/adapters/vercel.js` binds no `feedbackSink`, so the deployed relay answers 501, honestly.

### The Mom test is green

`node scripts/mom-test-probe.mjs` — **35 rows · 33 pass · 2 note · 0 FAIL**, exit 0. It was
29 · 2 · 4, and all four FAILs were the missing relay address.

### The v1 oracle did not move — checked PER FILE against `78016e8`

Every row of the 11 characterization files added at `328c683`, run at **`78016e8`** in a clean
`git archive` tree and in this tree, compared file by file including nested rows:

| File | Rows | Red | Verdict |
|---|--:|--:|---|
| `tier1/dates-holidays.test.js` | 103 | 0 | **identical** |
| `tier1/layout.test.js` | 108 | 0 | **identical** |
| `tier1/palette.test.js` | 6 | 0 | **identical** |
| `tier1/repeats-find-i18n.test.js` | 137 | 0 | **identical** |
| `tier1/storage.test.js` | 11 | 0 | **identical** |
| `tier1/store-persistence.test.js` | 139 | 0 | **identical** |
| `tier1/suite-integrity.test.js` | 11 | 0 | **identical** |
| `tier2/board-render.dom.js` | 19 | 0 | **identical** |
| `tier2/dom-rendering.dom.js` | 44 | 0 | **identical** |
| `tier2/interaction.dom.js` | 32 | 0 | **identical** |
| `tier2/shell-bridge.dom.js` | 16 | 0 | **identical** |

**626 rows (515 tier-1 + 111 tier-2). Not one changed.** `store-persistence.test.js` — the oracle
file that exercises the code this pass edited — is in that list: `_absorbedChainOps` and
`withoutForeignEntries` both return before looking at anything when there is no family space,
which is what keeps a v1 board out of them entirely.

### The standing bar held an eighth time

Zero bytes of a Privat entry — including on the one payload that now leaves a Mac that is not
syncing, the feedback report, which is searched for the needle before it is sent.

---

## ⛔ WHAT A PERSON WOULD BE SHIPPING

The full list with owners is `docs/v2/V2-FINAL.md` §8, re-issued. The three that matter:

1. **R-8b · the adapter has met a local cluster, not Frankfurt's pooler.** `prisma.js` passes 66
   of 66 contract cases against PostgreSQL 17.10, and four defects were found by running it — one
   of which no single-process test could ever find. But a transaction-mode pooler can refuse an
   interactive `$transaction` or silently downgrade `Serializable`, and every atomicity guarantee
   rests on getting one. Run `RUNBOOK.md` §2.5.1 against the deployed database first.
2. **R-1b · a transferred admin seat.** Above.
3. ~~**R-9b · two deployment lines nobody can write from here** — a production `feedbackSink`, and
   the real relay origin substituted into the four invitation files (which today carry the
   literal `https://lzp-sync-po.vercel.app`, a name nobody has claimed). Both are now checkboxes
   in `RELEASE-CHECKLIST.md` §A.~~ **✅ CLOSED 2026-09-05 — both lines were written.** The sink is
   bound in `vercel.js#buildCtx` and production answered **202** to a real report; the origin is
   `https://langzeitplaner.vercel.app` in all six files. **What replaces it as the third item is
   worse and is above:** the pipeline has never built, signed, notarized or published anything,
   and the `Report` table has no witness for `U-REPORTONCE`/`U-REPORTTTL`.

---

# ── THE PREVIOUS SESSION (LZP-1001 + LZP-1002, 2026-09-03) ──

*Kept verbatim below. Its suite counts are that session's and are superseded by the block above;
nothing else in it has been contradicted.*

## THE HEADLINE: 21.5 now bounds an ORIGINATOR, not a count — and it is 1, human

```
npm test 2185/2185 · test:property 101/101 · test:attack 970/970
test:server 944/944 · test:fleet 398/398 · test:dom 850 pass / 3 fail (52 files, 35 visible SKIPs)
```

The three tier-2 reds are **the same three, in the same two files** — `e8-density-legibility`
§A4 (the 9 px ink floor, PO ruling on `palette.js`), `e8-density-perf` §E1 (the 60 fps frame,
needs an incremental `renderBoard`) and §E3 (the saturated poster, a spec decision). All three are
`layout.js` / `app.css` / `palette.js`, a **parallel workflow's**. None moved, none is this pass's.

*(The 35 SKIPs and the `test:dom` total differ from the previous block's 867/49 because the two
`shell-*` tier-2 files skip visibly unless `node scripts/shell-family-e2e.mjs` /
`shell-ssrf.mjs` have configured them. Same tree, different driver.)*

### ██ THE AMENDMENT, AND WHY IT IS THE ENTRY THAT MATTERS ██

LZP-1009 made „Rückmeldung senden" **the first network request a solo copy of this app can ever
make**, so story 21.5's *"zero"* was false from the commit that landed it.

> **OLD:** "in solo mode the app makes zero network requests; with a Familienkreis it talks to
> exactly one sync endpoint and nothing else."
>
> **NEW:** "in solo mode the app makes zero **unrequested** network requests — the only request a
> solo copy can originate is the one a human asks for, by pressing „Senden" on the Rückmeldung
> screen (LZP-1009); with a Familienkreis it talks to exactly one sync endpoint and nothing else."
>
> **DECIDED BY: the PO, 2026-09-03.** The alternative was family-only feedback, which refuses the
> report from the only tester who has no Familienkreis.

**Amending a measured property is exactly the quiet erosion a conformance sweep hunts for** —
B-14 caught ADR 003 §7 gate 1 being *vacuously* true the same way — so it is written down three
times with the decider named. **And it is a narrower promise, not a softer one:** the old wording
bounded a **count** (measurable only over sessions somebody scripted); the new one bounds an
**originator**, which is a property of the source tree.

### The measured 21.5, both sides

| | measured |
|---|---|
| shipped `.js` under `src/js/` scanned | **78** |
| network identifiers outside `platform/net.js` | **0** (inside: **1**, `fetch`) |
| static paths from the boot graph to `net.js`/`sync/`/`crypto/`/`family/` | **0** · dynamic doors: **1** |
| **originators of a feedback report, whole tree** | **1**, `human`, `feedback/ui.js:245`, `addEventListener('click', …)` |
| solo launch in the real browser + two settings sessions | **48** resources · **0** off-origin · **0** `/api/` · **0** fetch/XHR · **0** family modules |
| the price of the exception on a solo launch | **8** `feedback/` modules, 93 193 B, none of which can open a socket |
| composing a report to the preview (5 socket spies) | **0 calls, 0 dispatches** |
| pressing „Senden" once | **1 dispatch, 0 socket calls**, no `to:` |
| family: the client's whole request surface | **6 requests, 6 inside one origin + `/api/v1/`** · 6 second-origin shapes refused · 6 methods refused · 0 reached the socket |

**The exception may not widen.** `tests/tier1/network-scope.test.js` **§5** is the gate: only
`feedback/ui.js` may import `feedbackPort()` (everyone else gets the **setter** and can bind but
not fire); `feedback/events.js` — the module that already listens to `error` and
`unhandledrejection` — cannot reach the sender at all; and §5d is armed by four planted automatic
callers plus two controls.

### Also landed

- **LZP-1001 — the Datenschutz section is in the product.** 24 blocks · 5 234 characters of German
  · 4 546 of English · screenshotted in the real browser in both languages. Names Vercel, Prisma
  Postgres and **EU/Frankfurt** (D2), enumerates ADR 003 §5.2's inventory including the deliberate
  plaintext colour, states retention as **„unbefristet"** per RUNBOOK §7.2, names the **second
  remote** (the GitHub manifest — operator named, host not, because §1g says there is not yet a
  real one), and says in both languages that a report is **not** end-to-end encrypted the way an
  entry is.
- **R1's copy half is closed.** The Datenschutz section says the entries in an exported backup are
  readable without the password, and D8's key-loss consequence sits beside it naming the three
  parties who cannot recover the data. **R1-b** is opened in the same breath: E10-B7's row scans
  `crypto/backup.js`, which this ticket does not own, so it is still green over a narrower object
  than the product.
- **ADR 003 §7 gate 1's *"OWED, not held"* note from 2026-08-27 is CLOSED.**
- **Three defects found in rows this pass wrote**, all by mutants rather than review: a caller
  regex that missed reference-dispatch (`setTimeout(fn, 0)`), an inversion that was green for an
  unrelated reason, and a classifier reading blanked strings. `FINDINGS.md` §20b.

### ⚠ Bookkeeping note: this pass's code landed inside somebody else's commit

The shell-transport workflow committed the whole working tree as **`101073b`** while this pass was
mid-flight, so `src/js/settings.js` (+309), `tests/tier1/network-scope.test.js` (+265),
`tests/tier2/datenschutz.dom.js` (+534) and the ADR / DESIGN-DECISIONS / FINDINGS /
E10-VERIFICATION edits are all inside a commit whose message is about `sync_request`. Nothing was
lost or altered — every count above was re-measured at HEAD after that commit — but a reader
looking for LZP-1001/1002 in the log will not find them under their own subject. **This block is
the pointer.** No history was rewritten and nothing was stashed.

### Owed after this pass

**R1-b** (`crypto/backup.js`'s own strings + E10-B7 inverted in place) · **E10-1009-A**
(`family/mount.js`'s one `setFeedbackPort(…)` line) · a production `feedbackSink` · and **three
stale documents** that still say the Datenschutz section is not in the product —
`RELEASE-CHECKLIST.md`:173, `MOM-TEST.md`:523, `RUNBOOK.md`:171 and §7. No test asserts their
claim, so nothing is red; details and owners in `FINDINGS.md` §20e/§20f.

---

# Previous session — 2026-09-03

**Stopped at:** **THE SHELL TRANSPORT INTEGRATION (LZP-1002)** —
the family was demonstrated in the app we actually ship, not in a browser. Full record:
`docs/v2/SHELL-VERIFICATION.md`; findings in `FINDINGS.md` §19.

---

## THE HEADLINE: `chooseTransport()` returns **`bridge`** in the shipped app, and the bridge carries bytes

```
npm test 2180/2180 · test:property 101/101 · test:attack 970/970
test:server 944/944 · test:fleet 398/398 · test:dom 867 pass / 3 fail (49 files)

node scripts/shell-family-e2e.mjs   26 launches of the shipped .app · 77 rows · 0 required failed
node scripts/shell-ssrf.mjs         29 launches of the shipped .app · 38 rows · 0 failed
```

The three tier-2 reds are **the same three the previous pass left** — §A4's 9 px ink floor (PO
ruling), §E1's 60 fps frame (needs an incremental `renderBoard`), §E3's saturated poster (spec
decision). None of them is this pass's and none of them moved.

**Five separate instances of the shipped `.app`** — each with its own bundle identifier, its own
WebKit store and therefore its own device identity, its own Keychain items and its own data
directory — formed one Familienkreis against a real relay: create → invite → join → key delivery →
**a Geteilt entry crossing** → the founder leaving → **a co-signed removal in a founder-less
circle, rotating the keys epoch 6 → 7** → the removed Mac refused → solo's zero requests. Every
byte through `invoke('sync_request')`. `WIRE.fetch` empty in every phase of every run.

### The second half of the conformance finding, which nobody had named

`net.js:718` returning `bridge` while neither shell implemented `sync_request` was the reported
gap. The unreported one: **only `family/engine.js` ever asked `chooseTransport`.**
`createjoin.js` and `mount.js` built six transports with `createFetchTransport` unconditionally,
and a `fetch` inside the shell is CSP-blocked — so **creating a Familienkreis in the shipped app
could not have worked**, co-signature screen and all. All six now ask. And `sync_request` refuses
everything until `set_shell_pref: "sync_enabled"` is pushed, which **nothing pushed**;
`familysettings.js#armShellSync` pushes it now.

### The SSRF surface, attacked from the page that would do it

38 rows, 29 launches. Every address the page can name is refused **by the shell**, with no HTTP
answer: a different host, `http://`, six non-http schemes, localhost in six spellings, five
private ranges, four link-local addresses (`169.254.169.254` included), three LAN name shapes.
Redirects off-origin, same-origin and 307 are all `redirect_refused`. A 12 MiB flood is cut in
~12 ms. A stall times out at 15.99 s. No cookie is kept. **There is no `origin` argument.** The
origin validator was swept with 28 launches, one per value, four accepted as the control.

A real leak closed on the way: an unpinned `URLSession` was handing the relay this Mac's macOS
build and the user's language preferences on every sync. Now `LangzeitPlaner` and `*`, confirmed
by a hostile relay reading it back off the wire.

### ⚠ TWO FINDINGS, AND THE FIRST IS WORSE THAN THE PROBLEM THIS PASS SOLVED

- **F-SHELL-1 · CRITICAL — the family layer terminally refuses peer attestations, and every launch
  makes it worse.** A Mac's refusal ledger grew **0 → 6 → 13 → 25** across four launches; once a
  peer's `member.set{dev.*}` op is refused the cursor is released past it and that peer's entries
  can never be admitted again. `selfAttest` re-signs on every launch and ECDSA is randomised, so
  the blob is a different string; `buildAttestOpen` keys on the exact string; `authz.js` answers
  `BAD_ATTESTATION`, **terminally**. Reproduced on demand: running the settle loop twice instead
  of once took the demonstration from "the entry crosses to both peers" to "to neither".
  **Not a transport defect** — the same bytes reach the other peers through the same bridge.
  Cheapest fix is a severity change: park it, do not refuse it. **Measured over five consecutive
  runs: the Geteilt entry crossed in 4 of 5; the founder received a joiner's entry in 0 of 5.**
  Everything else in the demonstration was green 5 of 5.
- **F-SHELL-2 · MEDIUM — a leave leaves no in-log trace**, so `eligibleCosigners` returns 2 in a
  founder-less two-member circle and T5-M3's stranded sentence never fires in the state it was
  written for. The person meets the 403 instead of the paragraph.

### The 51 conditional stories

F15–F22. **31 are now unconditional** — 15.1–15.6, 16.1/16.2/16.3/16.5, 18.1, 19.1–19.4, 20.2,
20.3, 20.5, 20.6, 21.1/21.2/21.4/21.5, and the eight F22 updater stories which were never
conditional in this way. **20 remain**: co-editing (18.2/18.5/18.6), the admin unshare (18.3 —
blocked by F-SHELL-1), pairing (19.5), rename/revoke/transfer (20.1), delete the circle (20.4),
Belegt crossing (16.7), and the board-rendering stories that involve no relay at all. The
per-story table is `SHELL-VERIFICATION.md` §10.

### Owed after this pass

F-SHELL-1 · F-SHELL-2 · the 20 still-conditional stories · `SYNC_ORIGIN_BUILTIN` is still `""` so
no TLS round trip has ever been made · the Rust half has never been compiled · CI must decide
whether 56 app launches belong in `test:dom`. Details in `FINDINGS.md` §19g.

---

# Previous session — 2026-09-03

**Stopped at:** **THE DENSITY / CO-EDITOR INTEGRATION PASS** — four
parallel fixers merged, the one collision between two of them resolved, two regressions this round
introduced closed, and everything re-measured. Full record: `FINDINGS.md` §17.

---

## THE HEADLINE: `test:dom` 714 pass / 17 fail → **836 pass / 3 fail**, and the oracle did not move

```
npm test  2121/2121 · test:property 101/101 · test:attack 960/960
test:server 903/903 · test:fleet 397/397 · test:dom 836 pass / 3 fail (46 files)
```

**The v1 oracle was checked per file, not per total** — the headline count moving from 2 105 to
2 121 is not evidence either way. Against a pristine `git archive 28f2a35`: 40 of 41 tier-1 files
report a byte-identical row count and pass; the one that differs is
`tests/tier1/headless-shell.test.js` (2 → 18), the shell workflow's LZP-1002 rows. **Not one v1
characterization row changed.**

### The seven stories the tier-2 sweep failed

| story | verdict | evidence |
|---|---|---|
| **2.4** the „+n" badge | **PASS** | 15.1 px of a 61 px line covered → **0 px**; on A4 the badge is out of the line and 0 px over the note box |
| **2.5** truncation you can read | **PASS** | under the badge at 92 px: 0 → **6 characters**; a peer's note on A4: 1 → **5** |
| **3.7** labels land on empty space | **PASS** *(screen)* | 98 of 142 labels overprinted → **0 of 142**. On PAPER the retreat is unavailable — a 24 px A4 gutter cannot hold a badge and a label chip. Named in §17c |
| **17.2** my board stays mine | **PASS** | own notes drawn: solo 185 · with the family 185 · **lost 0**, and identical under all three creation orders |
| **17.3** the member toggle is reachable | **PASS** | reachable at 900/1000/1100/1280/1440; the 80-cell sweep breaks 0 |
| **17.5** every change is noticeable | **PASS** | dots 106 → **187 of 219**, the 32 residue all accounted; **and the „+n" now says so on the glass** — 25 badges carry the tell, 0 missing, 0 of 329 spurious |
| **LZP-1007** the 60 fps frame | **FAIL** | `renderBoard` **60.9 ms** = 3.6 frames. Not a regression; not closeable by optimisation. §17e |

### The three rows still red, and what each needs

1. **§E1 · LZP-1007** — 60.9 ms for a full twelve-month rebuild of 4 195 boxes: 3 ms model,
   ~23 ms DOM construction, ~34 ms style + layout. Seven CSS levers measured, **none moves it**
   (`contain` makes it worse). Closing it needs an **incremental `renderBoard`**, not a tuning
   pass. One cell was genuinely improved on the way: `find.js` was doing a full-document
   `querySelectorAll` per hit, on every keystroke — `findWorst` 25.4 → 20.1 ms.
2. **§A4 · the 9 px ink floor** — five v1 tones miss `palette.js`'s own 4.5:1 on white.
   **Left red on purpose:** closing it edits `palette.js`, and `tests/tier1/palette.test.js:38`
   pins those hex values. **PO ruling first** — the proposed set compresses eight tones onto
   ~5.9:1, which is the channel story 4.5 relies on. The E8 half (`UNKNOWN_MEMBER_COLOR`, the
   „Belegt" word) is landable and does not touch the oracle.
3. **§E3 · the saturated poster** — 365 rows × capacity 2 = 730 slots against 1 527 entries.
   **48 % is the ceiling for any ordering**; the model draws 715 of the 730. The row asks 75 %.
   A spec decision, not a layout change, and the threshold was not re-cut to fit.

### Also closed by this pass

- **The E9 co-editor red team: 33 rows, all green.** 8 closed and inverted, 3 open and honestly
  labelled (§2f, §2g, §4c-b), 17 working defences, 5 controls. **No defence regressed.**
- **The redaction boundary held a fifth time.** 114 rows. This was the round where it was most
  exposed — finding 1's §2c puts a `geteiltOnly` value into `registers()` and onto disk. Zero
  bytes of a Privat entry.
- **A print regression this round introduced** — the „+n" badge was taking 20 px of a 39.5 px A4
  line and buying nothing. A peer's printed note went 1 → 5 characters. §17c.
- **17.5's glass half** — `overflowNew` shipped as a model field with nothing reading it. §17d.

### Owed after this pass

`core/materialize.js`'s bar-interval invariant · `PARK_REASONS.WITHDRAWN` · 18.5's withdrawal
report · the palette PO ruling · an incremental `renderBoard` · the saturated-poster spec decision
· `adr/001-op-log.md` §5 step 5's stale bullet. Details in `FINDINGS.md` §17i.

---

# Previous session — 2026-09-03

**Stopped at:** **E10 — privacy, migration and hardening,
INTEGRATED**. Full record: `docs/v2/E10-VERIFICATION.md`; findings in `FINDINGS.md` §16. The E9
record below it is unchanged and still current.

---

## THE E10 HEADLINE: the guarantees are tested facts; Mom's install day is not boring

**Story 21.5 is no longer asserted, it is counted.** A fresh solo install, launched twice and left
alone for a week of daily timers, makes **zero** requests. Disclosed but switched off: zero.
Switch on but never disclosed — a restored Mac, a copied prefs file: zero. Six launches in two
hours with both gates open: **one**. A person pressing „Jetzt suchen": **exactly one**, and no
download. In a real WKWebView, a whole session — create, edit, undo, redo, settings, layers,
persist, search, „Heute", `visibilitychange`, `online`, `focus` — with spies on all five ways a
page can open a socket: **zero calls**, spies proved armed.

**The exception is one in solo mode and two in family mode, and the second one is the honest
answer.** Every primitive in either shell that can put a byte on a wire was enumerated — thirteen
sites — and **every one is in one of exactly two jobs, `update` or `sync`**. The whole product
names **exactly one hard-coded remote URL**, the update manifest, and it is still
`OWNER-PLACEHOLDER`. Both gates sit upstream of their socket, proved by relative order inside the
enclosing function rather than by a line number, because both shells were being edited as this ran.

**„Solo mode makes zero network requests" is therefore false as literally written.** The *board*
makes zero. The *shell* makes one, at most daily, only after the user has been told and left the
switch on. `updater.js`'s header resolves 21.5 ↔ 22.3 that way deliberately and says the
Datenschutz copy must name the release host as a second remote. **Nobody has written that
sentence** — LZP-1001 is not in the product at all: „Frankfurt", „Vercel" and „Prisma" appear
nowhere in `src/`.

**The redaction boundary held a fifth time, through the carrier E10 itself adds.** All four
earlier rounds end at `transport.request`; `createBridgeTransport` starts there. A real German
fixture board — „Scheidungsanwältin Dr. Kübler 14:30", „Kur in Bad Wörishofen", „Zweitfamilie
Süd", „Diagnose F32.1", „Passwort fürs Schließfach" — sealed with real keys and pushed across the
bridge: **zero of five needles, in zero of three spellings** (raw UTF-8, b64url, `\uXXXX`), over
url + method + every header name and value + body. The shared label is absent too — „versiegelt"
on the wire means unreadable, not merely intact. The same search over the same payload is required
to **find** the space id, the device id, the client version, `LZP1`, the path, the origin and every
sealed `ct` and `sig`.

**One ticket of the eight was never built.** LZP-1009 — the PO's feedback button, asked for today
— did not land, and tasks 4 and 5 of this integration were attacks on its payload. There was
nothing to attack. Its absence is now **eight rows that go red the day it lands**: no sender, no
bridge command, no relay route, no reachable path, no remote host in the page, no native sender —
and, for the screenshot half, **no image primitive anywhere in the product and no screenshot
capability in either shell**. "The redacted PNG was produced by not drawing" cannot be verified,
because the product cannot draw. That is the strongest true form of the claim and it is not the
claim that was asked for.

**Mom's install day is not boring.** `scripts/mom-test-probe.mjs` ran the shipped parser over the
shipped e-mail: „Mail-Anbieter" normalises to twelve Crockford characters and **wins** the code
field, so she is told she mistyped a character she never typed; the e-mail carries **no relay
address** and the parser takes the download host, filling *Server* with `https://github.com`;
trailing punctuation becomes part of the hostname. Underneath all three: `gatekeeper_status` is
unimplemented in both shells and `Bitte zuerst lesen.html` is not on the disk image, so **step 3 of
the e-mail is the only surface that reaches her before macOS refuses to open the app**.

### Suites — all six, at the close of E10

```
npm test  2121/2121 · test:property 101/101 · test:attack 960/960
test:server 903/903 · test:fleet 397/397 · test:dom 811 pass / 3 fail (48 files)
```

The three are in two files — `e8-density-legibility`, `e8-density-perf` — **owned by the parallel
density workflow and mid-edit.** The brief said 17; three runs over this pass measured 9, 9 and 3,
and the fall is their work landing, not ours. Not counted, not fixed, not touched.
`network-audit.dom.js`, the file this epic cares about, is 10 pass / 0 fail / 1 skip in all three.

### Tickets

| ticket | verdict |
|---|---|
| LZP-1001 Datenschutz section | **OWED** — not in the product |
| LZP-1002 Network scope audit | **VERIFIED-HERE** — +25 rows covering the native side neither existing gate could see |
| LZP-1003 Crypto self-audit | **VERIFIED-HERE** — 60 rows, 4 defects closed, 5 residuals priced |
| LZP-1004 Backup/restore | **VERIFIED-HERE** — 21 rows, D8 asserted on the bytes |
| LZP-1005 Multi-device E2E | **VERIFIED-HERE** — 47 rows, 26 stories, one OPEN (17.5) |
| LZP-1006 "Mom test" beta | **OUTSTANDING BY NATURE — do not count the 3 points** |
| LZP-1007 Perf pass | *parallel workflow's* |
| LZP-1008 Ops runbook | **WRITTEN-UNVERIFIED** — every gate command executed; the deploy cannot be |
| LZP-1009 Feedback button *(new)* | **OWED** — nothing built |

**Points: 231/239.** LZP-1001 (2) and LZP-1006 (3) remain, and 1006's three must not be taken
until a stranger has actually sat down.

### Release-blocking, after E10

1. **`server/prisma/migrations/` does not exist** — first deploy creates no tables and
   `check-server-config.mjs` passes anyway.
2. **LZP-1001**, now with a second remote to name.
3. **LZP-1006**, blocked on a person and on the three e-mail defects above.
4. **LZP-106's unlock screen** and the missing `Bitte zuerst lesen.html`.

---

## THE E9 HEADLINE: two people edit one bar, and it stays boring

Mama drags Papa's „Familie darf bearbeiten" bar in a real browser. **One** `pub.set` leaves her
Mac, addressed to Papa's entity key, authored by her, carrying `pub.startDate` and `pub.endDate`
and nothing else. Papa writes the same field a moment later. **The later write takes that field,
her untouched end date survives it, attribution moves to Papa, and she — the loser — gets one
289 × 19 px line that names him, presses nothing, and fades. He gets nothing.** Every
`#board .col` rect is byte-identical with the line on screen.

Then: Papa deletes the bar and it leaves her board; his ⌘Z restores it as a new shared op; her ⌘Z
never touches it; and the admin unshares one of *her* entries, which reverts to owner-private on
her machine, is **not** deleted, and does not notify anybody. Grepped on a real relay's disk over
real HTTP: **zero plaintext bytes** — not the Privat entry, not even the shared one, not an op
kind or a field name. The relay holds `envelope/$b` and key wraps.

### Suites — all six, at the close

```
npm test  2105/2105 · test:property 101/101 · test:attack 860/860
test:server 903/903 · test:fleet 317/317 · test:dom 716 pass / 17 fail (45 files)
```

The 17 are the round-2 `e8-density-*` adversary findings, **landed red by design** and verified
byte-identical on a pristine `git archive HEAD` tree before this pass began. The v1 suite is the
oracle and **not one characterization row moved**.

### The epic arrived as five modules that did not touch each other

**LZP-902 shipped „Familie darf bearbeiten" as a grant nobody could exercise.** The flag was
written, folded, rendered and enforced — and every path a co-editor's write could take ended in a
`RedactionError` that halts *all* family sync from that Mac. Three of the four build workflows
closed with the same item owed. Integrating E9 meant building the write: a fold-authenticated
level reader, a branded-op door, a retraction/co-edit split at barrier 4, and **three modules that
had shipped with no caller at all** (`family/conflict.js`, `adminUnshareFollowUp`,
`store.applyCoEdit`). `conflict.js`'s absence was caught by the suite, not by a reader —
`sync-domains.test.js` S5b, because an unmounted module is correctly invisible to the import walk.

### LZP-808 — **ship it**

Komfort is **+16.7 % type and +12.6 % of the user's own sentence for +240 px width, +124 px height
and one month at 1280 px** — and **capacity is 2 at both presets**, so it costs no entries. The
number that decides it is `minRowHeight: 26`: `LINE_H = 10.5` is a fact about 9 px type, and a
naive Komfort would promise two lines to a row that can draw one, making the crowded board worse.
Cut it only if the 124 px are needed elsewhere, not because it is a `[Could]`.

### Owed after E9 (details in FINDINGS §15f)

1. **A co-editor cannot ⌘Z their own co-edit** — rule U6 excludes family entities from undo, and
   widening it would let an undo beat the owner's newer write at a fresh stamp. PO call.
2. **There is no admin-unshare button.** `family/unshare.js` is complete, tested, and uncalled.
3. **`NOT_MEMBER` is not in `CURABLE_REFUSALS`** — dropped, not parked. PO/store call.
4. **`A3b`/`A3c`** — one mirror line closes them; WP-9 owns it.
5. **⚠ Attack rows C2/C2b/C3 changed priority.** The co-editor × undo trio was reachable only by a
   hand-built op until this pass; it is now reachable **through the product's own UI**.
   Recommend promoting C2 out of WP-9.
6. **`DESIGN-DECISIONS.md` D7 is stale in one number** — it says twelve open attack rows; the admin
   file now has 10, all three have 20. The PO's file; not edited here.

---

# Previous session — 2026-09-02

**Stopped at:** **ROUND 3 — the member adversary's SECOND pass,
answered and integrated.** Three parallel fixes merged, one fix landed by the integration pass
itself (the presenter binding), every fix mutation-tested, both red teams re-run, the honest
circle re-driven, the redaction boundary re-attacked from the refusals this round invented.
Findings in `FINDINGS.md` §14.

---

## THE ROUND-3 HEADLINE: the boundary held a third time, and the ship answer is NOT YET — for three named reasons, none of them confidentiality

A second member-adversary attacked the gate that answered the first, and returned
**„No. E6/E7 cannot ship on this engine."** Its framing was that both fixes rested on premises the
T5 threat model does not grant: *that a `Member` row is a person, and that an epoch number is
scarce.* Both are now addressed in the only two ways a blind relay can — the epoch premise is
**made true** by a budget; the person premise is **not** made true, it is demoted on the wire and
bounded, because no relay can make it true.

**ZERO BYTES OF A PRIVAT ENTRY, for the third round running — and this pass did not merely re-run
the old rows.** Every fix in the round invented new refusal bodies, and a refusal is a response
body assembled by a handler holding the roster. So the boundary was re-measured across the four
refusals that did not exist before this round — the presenter-mismatch `401`, the already-removed
`400`, the `space_full` `400`, and the founder-less `403` with its two new prose fields — and it is
clean across all of them, with a **positive control** proving the search would have found a leak
(`e6-gate-privat.test.js` §2a, new).

### The ship question, item by item

| question | answer |
|---|---|
| epoch freeze closed? | **Priced, not closed — and the record says so.** The budget bounds the ratchet; it does **not** reach §2a, because that is not a volume attack — **one** poisoned rung freezes the space. `limits.js` pins `/DOES NOT CLOSE/`. |
| two-key rule real or demoted? | **Honestly demoted, and bounded.** A two-*row* rule, said so on every 200 and every 403; `MAX_LIVE_MEMBERS = 8` bounds the sybil fleet. Not closed — T5-M2 is a PO ruling. |
| founder anchor live-checked? | **Yes, CLOSED.** Cost stated: a founder-less two-member circle cannot remove, only leave. |
| proof bound to presenter and target? | **Yes, both — CLOSED this pass.** `lzp/admin/2` puts the caller in the signed bytes; an act already done authorizes nothing. |
| parking slot per space? | **Yes, CLOSED.** Plus R8-5 restored in production, where `writeJSON` had been swallowing a failed park on every full disk. |

**Can E6/E7 ship? NOT YET — three items, all decisions or screens, none of them unknowns:**

1. **A co-signature UI is now a shipping PREREQUISITE, not an owed screen.** The founder-liveness
   rule means a founder-less circle needs a second key for *every* removal, and `adminpanel.js` /
   `leavedelete.js` mint no proof. The relay is ready; the client cannot drive it. **Blocking.**
2. **T5-M2 is a PO/D7 ruling.** A `Member` row is not a person and no blind relay can make it one.
3. **Two priced-not-closed residuals** — the epoch poisoning (needs ADR 002 §8.5a's report path)
   and the unbounded shelf (`sync/outbox.js`).

**Suites: `test` 2086 · `test:server` 903 · `test:attack` 860 · `test:fleet` 317 ·
`test:property` 101 — all green.** `test:dom` has **17 failures that are not this round's**: the
tier-2 density sweep (§A, §B, §C, §D, §E), committed at `c797993` by the *other* round-2
adversary and owned by the parallel workflow. Verified identical, row for row, to the session
baseline. Zero dependencies, no `node_modules`.

**One new defect, found by the mutation harness rather than by a test** (FINDINGS §14d): a
redaction row scanned ciphertext for the two-character needle `'n0'` and went red ≈0.5% of runs by
pure chance — and a needle that short could never have distinguished a leak from luck either. Both
needles are now long enough that a hit is a leak. 20 consecutive green runs.

---

## THE T5 HEADLINE (round 2, superseded above but kept): nothing it found was a confidentiality break, and the denial half is closed

A red team attacked a **real three-member Familienkreis** as an invited, attested, non-admin member
(ADR 002 §0's T5). Its verdict was *„E7 can be built on this engine. It must not ship on it."* —
and what it could do was never **read**, it was **deny, destroy and redirect**.

**The redaction boundary did not move and is still green.** Five routes at the boundary produce
**zero bytes** of a Privat entry: barriers 2/3/4, the two branded recipient scopes, the branded
sender set, the per-space `KeyRing`, both mirror-image constructor refusals
(`e6-attack-privat.test.js` §1a–§1g), and story 20.5's read half
(`e6-attack-removed.test.js` §2a–§2d).

**Six of seven findings are closed; the seventh is open by design.**

| finding | was | now |
|---|---|---|
| T5-M1a | a member removes the founder in one request | **CLOSED** — `Space.founderMemberId`, a fact the relay writes itself |
| T5-M1b | a member deletes the whole circle in one request | **CLOSED** — a second member's `RK_sig` |
| T5-M1c | remove everybody, then leave, and the cascade deletes it | **CLOSED** — by M1a, not by gating the cascade |
| T5-K1 | an epoch bump read as proof a **key** arrived | **CLOSED** — coverage is now three statements about keys |
| T5-K2 | D9's waiting state cleared on the relay's row count | **CLOSED** — answered from the ring |
| T5-K3 | `putKeyWraps` was an upsert: one member could overwrite the family's whole key history | **CLOSED** — write-once, depositor in the cell |
| T5-K4 | a member attests an outsider's Mac | **OPEN BY DESIGN** — §8.5's mitigation is now built *and* fed |

**The one head-on conflict, and the decision that resolved it.** T5-K3's write-once rule on
`(spaceId, epoch, recipientId)` closed its own finding and **opened T5-K1's mirror image**: a
joiner's cells are all empty when she arrives, so a hostile member who rotates first owns them for
ever and every honest re-delivery is refused *by the relay*. Measured — she ended with one epoch,
no history, and her ops in an `error` screen. Putting the **depositor in the cell**
(`@@id([spaceId, epoch, recipientId, senderDeviceId])`) holds both at once, and gives C61's
healing path back. FINDINGS §13c.

**The authorization ruling, because it is a decision.** The relay **cannot** identify the admin —
the admin chain is an in-log `transferAdmin` op inside the ciphertext. Requiring a co-signature for
*every* removal was rejected on measurement, not on taste: mutant **M-M5** reddened **13 fleet and
31 server rows**, and in a two-member circle the rule is **unsatisfiable**, because the only
possible co-signer is the target. The gate is therefore on **the founder** — the one removal that
destroys the space for everybody rather than for one person. The residual (a non-founder is still
one request away; two colluding members can still remove the founder) is **asserted in rows**, not
implied. FINDINGS §13b.

**E6 was re-driven end to end** against the changed authorization: create → invite → join → D9's
waiting state observed *and* clearing itself on ordinary ticks → the shared entry appears → the
name propagates from the log while the relay holds none → **removal with rotation** (epoch 4 → 5,
`authorizedBy: membership_only`, one request, honest admin path intact) → the removed member's own
board byte-for-byte unchanged → and the founder removal refused `403
founder_removal_needs_second_key`.

**Suites: `test` 2008 · `test:attack` 860 · `test:server` 892 · `test:fleet` 259 ·
`test:property` 101 — all green.** `test:dom` has **two failures that are not T5's**:
`belegt-render.dom.js` §7 and `dom-rendering.dom.js` 7.2, both reproduced identically in a pristine
`git archive HEAD` copy of `81b793d` and both in E8-owned files.

**Owed:** ~~a co-signature UI~~ — **CLOSED 2026-09-03 by LZP-1002**: the screen exists
(`leavedelete.js#openCosignRequest` / `#openCosignSign`) and has been driven end to end in the
shipped `.app` in a founder-less circle, `authorizedBy=admin_proof`, epoch 6 → 7
(`SHELL-VERIFICATION.md` §4). Still owed: the transfer-certificate chain that would upgrade the
founder anchor to a real admin rule. FINDINGS §13f.

---

## THE E8 HEADLINE: the family is on the board and the board did not move

Seven other people, **3 059 notes and 416 bars across two years**, produce a board whose row height,
row block, board height, column width, note-body width, toolbar height and board top are
**`deepEqual` to the solo board built from the same fixture** (`tests/tier2/family-density.dom.js`
§4, in the shipping WebKit, with non-vacuity asserted in the same row: 192 → 715 notes and
40 → 135 bar segments in the DOM). E8 is bought **entirely out of horizontal space**:

```
                          prefix     text left   line box
v1 · plain own note         0 px       62 px       10 px
E8 · own WORST           16.8 px     45.2 px       10 px    (published ownWorst 17)
E8 · foreign WORST       22.8 px     39.2 px       10 px    (published foreignWorst 23)
```

**The line box is 10 px in all seven marker combinations** — a marker that grew it by one pixel would
grow it on all 372 rows of all 12 columns. Toolbar **40 px** at 0, 2 and 8 members. A4 print strip
**15.5 px** with 0, 7 and 8 members, one page in every case.

**Deliverable 17 holds at 22 px and does NOT hold at 18 px, and that is stated rather than smoothed
over.** One row carrying the visibility badge, the Belegt block, the initial chip, the „neu" dot and
the ↻ **at once**, plus `+n` and three lanes: **7 painted marks, 0 collisions, smallest 3 × 3 px,
every gap ≥ 1 px** — mutation-tested, a −4 px chip margin reddens it and names the overlap. At 18 px
the capacity rule gives the row one line, so three of the five marks go into `+5`. Nothing
overprints; the loss is v1's own rule, not an E8 collision. **FINDINGS §12b, owner: design.**

**LZP-1007 is met with an order of magnitude in hand.** Worst main-thread drag frame **8.7 ms of the
16.7 ms 60 fps budget** in Chromium, **≤ 6 ms** in WebKit, 600 measured frames over three gesture
kinds, **zero frames over budget**. A member toggle costs exactly one redraw (39–42 ms at eight
members; 13 ms once all seven are hidden, which is the solo board's own cost). **What is not claimed:
a wall-clock frame rate** — neither available engine renders to a visible window here, so rAF is
suspended in both and raster/composite is unmeasured.

**Two v1 characterization rows were red at HEAD and both are now green** — `dom-rendering.dom.js` 7.2
and `belegt-render.dom.js` §7, both calendar drift (today inside Sommerferien; 3 October in the
second column), both reproduced in a pristine `git archive HEAD` copy with every E8 change absent,
both fixed in the fixture and mutation-tested. FINDINGS §12a.

**Owed, and named:** 17.5 renders nothing in the shipped app (`_project()` supplies none of
`isNewOf`'s three inputs — §12d, and `isNewOf` **fails open**, so wire all three or none); 17.6's
hover half is missing and every member name in the product is still an initial because
`family/mount.js` never installs `useMemberNames` (§12e). `test:fleet` is red on the **parallel
workflow's** uncommitted founder-removal guard and is 244/244 at HEAD (§12c).

---

## The headline: D9 part 4 is demonstrated, and it was the acceptance test for the epic

All six suites green: **2008 · 769 · 101 · 868 · 193 · 32 files.** Full record:
`docs/v2/E6-VERIFICATION.md`; findings in `FINDINGS.md` §11.

The two previous passes (`FINDINGS.md` §9 and §10) reached the same wall from opposite sides: ADR 002
§7.1 steps 4–6 had **no client implementation**, so a Familienkreis armed no engine, nothing wrapped
a key for a peer, and Mom joined, was told calmly that the entries would arrive by themselves, and in
that build they never did. **That wall is down.**

Three browser contexts against `node server/dev-server.mjs` — three origins, three storage
partitions, three durable identities — driven through: create → invite → join → **the waiting state
clearing by itself** → a shared entry appearing on two other boards → a joiner receiving three years
of history → a name change propagating → **LZP-608's removal with its epoch rotation** → and the
removed member's board left byte-for-byte intact. Every step is pasted in `E6-VERIFICATION.md` §3.

**The one measurement to read.** On Mama's Mac, with `cadence.wake()` — the scheduler's own entry
point — the only thing called anywhere, and no notification of any kind:

```
keysPending      true  →  FALSE
epochs held      []    →  [1, 2, 3]     ← ALL epochs: history from genesis is readable
heldEnvelopes    6     →  0             ← re-judged and applied IN THE SAME PASS
board            Omas Geburtstag (entered 2023-11-14, yearly)  ← risk R11
                 Papas Zahnarzt                                 ← 18.1
                 Mamas Yoga (her own, untouched)
circle name from the LOG : "Familie Weber-Schmidt"              ← 20.1 propagates
names she knows          : Mama, Papa                           ← 15.6, E6-1 closed
```

**The relay holds nothing readable.** Armed search (a planted needle *is* found in the same bytes)
over the raw 31 554 bytes and the 16 199 decoded from all 553 base64url tokens: no display name, no
circle name, no entry text, no date. The only member fact in the clear is a palette reference.

**Solo mode is untouched and re-measured after the change** — which had to be re-taken, because
`main.js`'s arming gate grew a third field: 38 modules, **0** from `family/`/`crypto/`/`sync/`/
`net.js`, **0** network requests, **no IndexedDB** (no identity minted), DOMContentLoaded 170 ms,
first run unchanged. Opening ⚙ loads 30 more modules and still requests nothing and mints nothing.

**Story 21.2 re-proved now that two engines exist:** both constructors refuse the other's space with
no flag and no default; `ring.get(psp_…, 6)` is `false` against a live six-epoch family ring; and
Papa's Privat entry produced **zero** `pub.set` ops — not a redacted one, none.

## Four findings, every one of which silenced the whole circle

They are `FINDINGS.md` §11b, and the reason none was visible to a green suite is structural: **each
fails by parking or by declining**, which is the shape this product is designed to have. The ops
arrive, they are held, the board is empty, nothing is in an error state.

- **E6-7 (HIGH)** — *nothing in `src/js/` ever supplied `ctx.attestOpen`*, so every peer's own
  attestation op was rejected `badAttestation` and every op behind it parked `unattestedDevice`
  for ever. **A circle could not admit a single op from anybody.**
- **E6-7b (HIGH)** — the attestation tables were seeded once at launch, so a member who joins while
  your app is open stays unattested until you restart. And a Mac in a Familienkreis *and nothing
  else* never adopted a durable identity at all, so the family engine refused to construct.
- **E6-9 (HIGH)** — **D9's own window destroyed the ops a joiner authors inside it**: they were
  quarantined for lacking a key, and a quarantine has no cure.
- **E6-8 (MEDIUM)** — a clipboard refusal destroyed the invite it was copying, while the invite
  existed on the relay and its code was unrecoverable.

All four are closed, each with a row in `tests/tier1/sync-family.test.js` §7 that a named mutant
kills. **E6-1, E6-2, E6-5 and E6-6 are closed too.** The one row from the previous pass that is
untouched is **E6-3** — global device uniqueness — and it is `server/`'s.

---

## E6 — the client flows, 2026-08-29. **SUPERSEDED by the section above — kept as the record.**

> ⚠ **Everything below this line is the 2026-08-29 pass and is no longer the state of the tree.**
> Its central claim — that D9's fourth requirement "cannot be demonstrated at all" — was true then
> and is false now; `E6-VERIFICATION.md` §3.4 is the demonstration. It is kept unedited because the
> *argument* in it is why the fix has the shape it has, and because the wall it describes is the
> thing the next section had to knock down. Read it as history.

### E6 — the client flows. LZP-601…607 wired, and the lifecycle driven. (2026-08-29)

All six suites green: **1932 · 720 · 88 · 868 · 169 · 29 files.** Full record:
`docs/v2/E6-VERIFICATION.md`; findings in `FINDINGS.md` §10.

The whole membership lifecycle was driven against `node server/dev-server.mjs` with two independent
Macs (two origins = two storage partitions = two durable identities): **create → invite → join →
both members listed → rename → leave → delete**, every step a real signed round trip, with the
relay's stored bytes inspected at each one. The relay holds **no display name and no circle name**,
and the invite row carries **no key material** — D9 is a property of the stored bytes, not a comment.
Solo mode is unchanged and measured: **36 modules, 0 from `family/`/`crypto/`/`sync/`, 0 requests**,
DOMContentLoaded 127 ms; opening ⚙ adds 26 modules and still makes **no** request.

**The one thing to read before anything else: `E6-VERIFICATION.md` §5.** D9's waiting state is
demonstrated and machine-checked for its first three required behaviours — immediately a member, one
calm line, no spinner, no error, and never an instruction to go wake anyone — and **its fourth cannot
be demonstrated at all.** ADR 002 §7.1 steps 4–6 have **no implementation in the client**: nothing
calls `GET /spaces/:id/keys`, nothing wraps the ring for a peer, and no route exists to push a wrap.
Mom joins, is immediately a member, is told calmly that the entries arrive by themselves — and in
this build they never do. **E6 built the membership half of the feature; the content half does not
exist.** The same gap blocks **LZP-608**, whose rotation needs the same producer.

**Five findings (`FINDINGS.md` §10).** The sharpest is **E6-2**: handing over the admin role was a
**one-way demotion** — the relay records nothing by design, the `space.set{admin}` op has no client
mutation, so the outgoing admin demoted himself, the successor was never promoted, and the circle
ended with **no admin anywhere and no route back**. The control is now disabled behind one named
constant with its reason in both languages. Also **E6-3**: leaving a circle bricks that Mac's family
mode on that relay (`device.deviceId/registered`), which is server finding E2-203-1 met from a second
direction. And **E6-4**: the huge paste field defeated its own parser, because an `<input>` strips
newlines — the pure function passed either way, which is the seam a tier-2 row cannot see.

---

## Round 10 — the E6 gate, from the engine's side

**Stopped at:** **round 10 — the E6 gate. The verdict is NO-GO,
and it is not about the fork detector.**

Round 10's adversary set a shortest path of nine items as the condition of a GO. All nine are
landed and mutation-tested, three more defects were found by landing them, and **all six suites are
green**. The verdict is still **NO-GO**, for a reason none of the nine touches:

> **E6 needs a family space, and nothing in this product can sync one.** `createPersonalSync`
> throws on an `fsp_…` id — correctly, because that is story 21.2 enforced at construction — and
> there is no other engine: six modules under `src/js/sync/`, exactly one of them an engine, and
> `src/js/family/engine.js` (the file whose *name* says family) builds the personal one and gates
> itself on `startsWith('psp_')`. „Familie" in this product means *"my own Macs, over a relay"*,
> which is M1, which is what E5 shipped.

**This is a scope statement, not a quality one.** The personal engine is sound: 168 green fleet
rows, both directions driven over the real handlers, every honest-direction row carrying a control
that proves the detector was live. What those rows cannot be is evidence about an engine that does
not exist — and `tests/fleet/round10-e6-gate.test.js` §4 asserts the gate over the shipped source
so no future reader mistakes the first for the second.

**Start at FINDINGS §9** — the whole round is there: what landed (§9a), the mutation table (§9b),
both directions (§9c), E6's shape driven with four devices and three members (§9d), and the gate
(§9e). Then `tests/fleet/round10-e6-gate.test.js`, which is 11 rows and reads as the argument.

**The three new findings, all opened by doing the work rather than by reading it:**
**R10-9d** (a shelf row survived the op being applied — a permanent false `error` the moment
anything read the shelf; fixed), **R10-11** (a member joining a circle that already has a removal
in its history wears a red light until somebody next writes; OPEN, and ADR 003 §4.1's `baselineSeq`
is the specified fix), and **R10-10** (the relay admits a second member to a *personal* space —
latent, not a break, and defence in depth that is simply absent).

---

**The previous session** was **round 9 — the adversary's verdict, closed.** A
fresh adversary read round 8's work and returned *"E6 cannot safely be built on this sync engine as
it stands."* It is closed: `pullNow` uses `createChainWitness` rather than the raw `verifyChain`
leaf, the cursor hold moved behind the witness's re-anchor where ADR 002 §5.4 put it, a park is
never a drop, and every door that persists a device row runs one closed-set rule.
See FINDINGS §3d, §7a-round9 and §4.8. The two headline checks that verdict set as the bar are
`tests/fleet/round9-headline.test.js`.

**The previous session** was **round 8 — the OP LIFECYCLE, enumerated, and E5's
two adversaries answered.** M1 „Zwei Macs" was demonstrated; two adversaries then attacked it and
found **no confidentiality break** — 21.1 and 21.2 both held — but found that **the engine lost ops
silently and reported `healthy` while doing it**. Four fixers worked in parallel against
`tests/helpers/sync-domains.js` (253 entries, five domains, zero imports) and one integration pass
landed the cross-file work.

**All six suites are green**, the property that walks the domain is **85/85 with 0 UNEXPECTED and
0 STALE**, and the headline the convergence adversary asked for holds at **128 seeds**:

> for every op set and every interleaving of partition, reorder, duplication, **compaction**,
> restart and quarantine, the two Macs' register digests agree — or the Mac that lost something
> SAYS SO.

**Resume by reading:** this file (start at the **round-8 addendum** at the bottom), then
`docs/v2/FINDINGS.md` **§3c** (the six new rows), **§7a-round8** (the fourteen mutants) and
**§7d-2** (the second domain, and the two cautions it earned), then `docs/v2/E5-VERIFICATION.md`
§7, then `PLAN.md`.

**The one thing to carry forward before E6:** *a module is not dead because nothing imports it; it
is dead because nothing NEEDS it.* Four modules this register had filed as dead code turned out to
contain three defences the product was designed to have and did not — the chain witness, a durable
park for sealed envelopes, and a durable chain anchor. One file was genuinely dead and was deleted;
it was the only importer of the other four, which is the whole reason they looked dead.
---

## 1. One-paragraph state

The v2 **design** is complete and decided (5 ADRs, 5 contracts, 9 PO decisions). The **v1
regression gate** exists and is green. **WP-1 — the DOM-free op-log core — is built, attacked
three times and hardened twice. WP-3 — the retrofit — has landed: the shipping v1 app now derives
its state from an append-only op log**, all 22 mutate sites converted, and it behaves identically.
`board.json` is still `schemaVersion: 1` with v1's exact field set and zero v2 leakage.
**Both owed judges have now run** (§4), the twelve ADR amendments they produced are **applied to
the ADR text** (§6), and the **`deviceShort` contradiction is resolved** — ADR 002 §5.2 is
rewritten and is the single normative answer. Every finding from every audit now lives in one
register, `docs/v2/FINDINGS.md`. **A fix pass on 2026-08-27 closed seven of those rows** —
A3-C1 (CRITICAL), A3-H1, A3-H2, A3-H3, F-1, F-3, F-10 — each of them mutation-tested. **E3 — identity and crypto — is now built and proved in the real WKWebView** (LZP-302…306): seven
modules under `src/js/crypto/`, one stateful key store under `src/js/platform/`, both shells'
Keychain bridge, and **383 new test rows across the two tiers**. **A3-H4 is closed** — a
non-extractable `CryptoKey` in IndexedDB *does* survive an app relaunch, proved across two separate
launches of the real shell — **but it closed with a condition that is now the only row in the
register blocking a family-mode release: finding E3-1**, and it is an input to **D1**. Read
`docs/v2/E3-VERIFICATION.md` before starting WP-8.

## 2. Suites — run these first tomorrow to confirm nothing rotted

```bash
# CURRENT — re-measured 2026-09-01 at the close of the E8 INTEGRATION pass.
npm test              # tier 1, pure logic          → 2008 pass / 0 fail
npm run test:property # property harness + domains  →  101 pass / 0 fail
npm run test:attack   # adversarial corpus          →  860 pass / 0 fail
npm run test:server   # the sync server             →  892 pass / 0 fail
npm run test:fleet    # two, three and FOUR Macs    →  252 pass / 6 FAIL  ← NOT E8's; 244/244 at
                      #                               HEAD. The parallel `server/*` workflow's new
                      #                               founder-removal guard vs its own red team,
                      #                               `tests/fleet/e6-attack-removed.test.js`.
                      #                               FINDINGS §12c.
npm run test:dom      # real headless WKWebView     → 36 files, 642 pass / 0 fail, tier 2 PASS

# ⚠ A suite result taken while another workflow is writing this tree is not a result: test:server
#   reported 888/4 during one such overlap and 892/0 on four consecutive clean runs afterwards.

# 2026-08-29, the ROUND-10 integration pass — superseded
npm test              # tier 1, pure logic          → 1932 pass / 0 fail
npm run test:attack   # adversarial corpus          →  720 pass / 0 fail
npm run test:property # property harness + domains  →   88 pass / 0 fail   ← sync-domains: 0 UNEXPECTED, 0 STALE
npm run test:server   # the sync server             →  868 pass / 0 fail
npm run test:fleet    # two, three and FOUR Macs, real handlers → 168 pass / 0 fail
npm run test:dom      # real headless WKWebView     → 29 files, tier 2 PASS

# 2026-08-29, the ROUND-9 integration pass — superseded
npm test → 1932 · test:attack → 714 · test:property → 85 · test:server → 846 · test:fleet → 131

# 2026-08-29, the ROUND-8 integration pass — superseded
npm test → 1929 · test:attack → 706 · test:property → 85 · test:server → 815 · test:fleet → 103
```

**tier 1 went 1956 → 1929 and that is a DELETION, not a regression.**
`tests/tier1/sync-client.test.js` (46 rows) went with `src/js/sync/client.js`, LZP-501's
superseded engine; three rows were added in its place (`core-oplog.test.js` ×2 for L-4,
`sync-personal.test.js` ×1 for P-8's cursor release). Every other suite grew.

**`test:dom` tier 2 now PASSES**, including the E3-10 Saturday row that had been red on every
weekend run — closed by the E2↔E3 seam pass, not by this one.

```bash
# 2026-08-29, the E5 integration pass — superseded
npm test → 1956 · test:attack → 648 · test:property → 70 · test:server → 799 · test:fleet → 60
```

```bash
# 2026-08-29, the E3 verification pass — superseded
npm test → 1690 · test:attack → 648 · test:property → 70 · test:server → 569 · test:dom 22 files
```

**`test:dom` is red, and it is not crypto.** The single failure is
`tests/tier2/dom-rendering.dom.js` row 38, which reads the **real wall clock** and asserts that
today is a plain weekday: it fails every Saturday, Sunday and Ferien day, because `print.css:69`
correctly keeps the weekend shade under print CSS. Every crypto tier-2 file is green — **104
pass / 0 fail**. Filed as **E3-10**; owner is whoever owns that file, not E3.

**Two red-team rows were also deciding their verdict on a random ciphertext byte**, which made
`npm run test:attack` fail about one run in thirteen and is why an earlier record of "648 / 0" was
a lucky run rather than a measurement. Filed and **fixed** as **E3-9**. Historic block follows.

```bash
# 2026-08-27, the E3 integration pass — superseded
npm test              → 1665 pass / 0 fail   ·  npm run test:attack   →  566 pass / 0 fail
npm run test:property →   62 pass / 0 fail   ·  npm run test:dom      →  22 files, 375 pass
```

**Re-measured 2026-08-27 at the close of the E3 integration pass — all four fully green.**
The tier-1 count now includes **E3's 286 rows** (`crypto-identity` 62 · `-spacekeys` 38 ·
`-envelope` 52 · `-pairing` 57 · `-backup` 69 · `-guarantees` 8); tier 2 includes **E3's 97**.
E3 owns `src/js/crypto/`, `src/js/platform/keystore.js` and the shells' Keychain bridge, and
nothing in the round-6/7 fix pass touched any of them — nor did E3 touch `store.js`,
`storage.js`, `core/oplog.js`, `core/migrate1to2.js` or `core/replace.js`.

**`npm run test:property` now includes `tests/property/domains.test.js`** — 11 properties that walk
all **310 enumerated inputs**. If you change anything in `src/js/store.js`'s boot path,
`src/js/storage.js`, `core/oplog.js`'s indexes or `core/migrate1to2.js`'s coercion, **run that file
first**: it is the artifact that says what the *required* behaviour is, and it reports a
regression as `UNEXPECTED` and a stale work order as `STALE`.

**Re-measured 2026-08-27 after the round-5 integration pass** — these are the current numbers.
(The 1360 / 340 / 51 / 278 figures below are the *first fix pass*'s and are kept because the
paragraphs explaining the movement were written against them.)

Re-measured **after the fix pass of 2026-08-27** (A3-C1 / A3-H1 / A3-H2 / A3-H3 / F-1 / F-10
closed), all four green. The counts move for three independent reasons and none of them is a
regression: `judge:adversary3` added **43 rows in three files** under `tests/attack/`; the
**E1 pipeline agent** added `platform-updater.test.js`, `shell-updater.dom.js`,
`firstrun-unlock.dom.js` and `update-ui.dom.js` in parallel; and the fix pass **inverted** the rows
that were green because a defect existed and added the rows that pin the fixes. Rows in
`tests/attack/round3-*.test.js` tagged `SUCCEEDED (defect)` are green **because the defect is
there**; if one goes red, invert it, do not repair it. Rows tagged `FAILED (held)` or `INVERTED`
are the ones that have already been through that.

**Green is not the gate; falsifiability is.** Every fix in that pass was mutation-tested: reverted
in a scratch copy of the tree and required to redden a named row. The table is in
`docs/v2/FINDINGS.md` §7. One "fix" survived its own mutant and was rewritten as a reachability
characterization rather than left as a claim.

The shadow-undo assertion (risk R5's mechanical guard) is **armed** in all three `node --test`
scripts via `tests/helpers/dev-flag.mjs`, pinned by `suite-integrity.test.js` so an `--import` of
a no-op cannot satisfy it.

`test:dom` compiles the Swift shell with `swiftc` and drives the real board in WKWebView. It is
macOS-only, which is why `npm test` is tier 1 alone.

## 3. What is done

| | status |
|---|---|
| **Design** — ADR 001 op-log · 002 crypto · 003 sync protocol · 004 visibility/redaction · 005 module layout | complete, normative |
| **Contracts** — `docs/v2/contracts/*.contract.js` | complete, `node --check` clean |
| **Traceability** — `docs/v2/traceability.json` | 71 stories · 68 tickets · 12 amendments · 13 constraints |
| **Decisions D1–D9** | answered in `DESIGN-DECISIONS.md`, propagated into ADRs + contracts |
| **WP-2 v1 regression gate** (`tests/tier1/`, `tests/tier2/`) | the R5 gate the plan required; did not exist before |
| **WP-1 core** (`src/js/core/`, 14 modules) | LZP-401, 403, 404, 405, 406 |

**Commits** (nothing pushed; no remote exists):

```
3ab00c3  WP-1 round 2 — close the two-doors class, widen the corpus, prove the gates
99781fc  WP-1 fix pass — integrate six parallel fixes, close five more defects
496fa0d  WP-1 — the pure core, integrated and proven (LZP-401, LZP-406)
b230847  Propagate PO decisions D1/D7/D8/D9 through the ADRs and contracts
9c39775  Record the nine v2 blocking decisions (WP-0 exit criterion)
328c683  Add the v1 characterization suite (gate for LZP-402)
66126e9  v1 baseline — LangzeitPlaner 1.0 as handed over
```

## 4. The two owed judges — **DONE**, 2026-08-27

Both ran as a standalone read-only pass (not via workflow resume), against `c0306ac`. Neither
touched `src/`.

1. **`judge:adversary3` — DONE.** 43 new adversarial rows in three files under `tests/attack/`
   (`round3-seam`, `round3-doors`, `round3-persistence`). Produced **1 CRITICAL, 4 HIGH, 5 MEDIUM
   and 3 LOW** findings, and a list of 19 attacks that **failed** — the code held — which is
   recorded in `FINDINGS.md` §5 so the next round does not re-run them.
2. **`judge:conformance` — DONE.** A story-by-story audit of all 79 v1 stories and the v2 addendum
   against `src/js/core/` and the seven retrofitted v1 files, plus **the full ADR amendment list**
   and **the `deviceShort` resolution**. Produced 6 further findings (F-5…F-10) and confirmed
   11.6 lossless on the PO's real `board.json`.

**Everything both judges found is triaged in `docs/v2/FINDINGS.md`** — one register, with owner and
status per row, and a clearly marked "needs a decision" section for the three items that are a PO
call rather than an engineering fix. **The documentation half is landed (this session); the code
half is a separate later pass** — no `src/` file was changed.

## 5. Open findings → **`docs/v2/FINDINGS.md`**

**That file is now the single register.** 24 rows: 1 CRITICAL, 4 HIGH, 8 MEDIUM, 7 LOW, 4
INFO/gap — 18 open, 2 accepted, 3 needing a PO decision, 1 fixed. It carries the three items that
used to live in this section, plus F-1…F-4 from the WP-3 adversaries, plus everything both judges
found. **Do not add findings here; add them there.**

Read `FINDINGS.md` §3 before starting WP-8: **eight of the eighteen open rows go from latent to
live the moment a second device exists.** The three PO decisions are §4 of that file: F-1
(`board.json`'s byte stability), A3-H2 (coerce / quarantine / refuse when v2's type table is
stricter than v1's), and A3-M1a (a permissive door vs a throwing one).

The three items that were listed here, with what changed:

- **KNOWN GAP → WP-9 · security-relevant · still open (`G-1`).** A bare `dev.*` attestation makes its author a
  `currentMember`: an outsider can appear in the Kreis unassisted, and `currentMembers` is what
  gates foreign-entry visibility (story 20.2). Cannot be closed in WP-1 — membership has to be
  *conferred* by the invite/redeem flow before `authz.js` can refuse to infer it.
  → `tests/attack/convergence-authz.test.js:201`, `tests/attack/ownership-authz-admin.test.js`

- **~~STILL OPEN → WP-3~~ → FIXED, and verified (`G-2`).** The obligation was that the retrofitted
  store must call `planReplaceAll` — never the short entry point — for every import and snapshot
  restore, and hand `plan.retractions` to the publisher. `judge:conformance` A.3 (story 16.5) read
  `store.js:805` and confirmed it does exactly that; the publisher is still `nullPublisher`, which
  is correct until WP-10. `tests/attack/recheck-att40-replace.test.js:220` stays as the pin.

- **ACCEPTED, not a defect (`A-1`).** An import resurrects a tombstone at a fresh stamp. That is what
  restore *means* (story 11.5), and the fresh stamp is load-bearing for paired-device
  convergence (ADR 001 §8.5). Documented so nobody "fixes" it later.

## 6. ADR amendments — **applied 2026-08-27**

`judge:conformance` produced the exact list; **all sixteen are now in the ADR text.** Every
correction carries a marginal **Amended 2026-08-27** note naming the test, probe or finding id that
caught it, so the next reader can tell a *verified* sentence from a *reasoned* one.

### Applied

| # | where | what was wrong | evidence that corrected it |
|---|---|---|---|
| B-1 | **ADR 001 §7.3 cond. 3** | read progress alone was unsafe; write progress (`min(lastPushedSeq)`) is required or an unpushed write of any age resurrects a deleted entry | `src/js/core/oplog.js:150-199`, which implements both halves and fails closed |
| B-2 | **ADR 001 §5 step 5** | the **bar comparator** — `(startDate, endDate desc, id)` throws away the v1 array index. Corrected to `(_born, id)`. **§8.3's AC was correct as written; this section is where the error lived** — the old §6 mis-located it | `src/js/core/entities.js:694-704 cmpBars`, property P8 |
| B-3 | **ADR 001 §3.2 row 13** | `toggle-repeat` OFF must not re-write the anchor date | `git show 66126e9:src/js/popover.js:205-208`; `core-ops.test.js:1087`, `layout.test.js:1048` |
| B-4 | **ADR 001 §3.2 rows 11, 16** | two `[L]` marks the v1 source does not support, and a `{categoryId}` on a row with no category picker | `src/js/core/ops.js:845-848, 903-905` |
| B-5 | **ADR 001 §3.1** | `_born` was missing from the `fnote`/`fbar` field tables while §4.3 and ADR 004 §5 both already treat it as governing | `src/js/core/ops.js:154-160, 168` |
| B-6 | **ADR 001 §8.1 property 2** | "two migrations are **byte-identical**" overstates what holds *and* what is needed — the **registers** are identical; opIds and `dev` are not, and must not be | conformance probe `p2` test 2 against the PO's real `board.json` |
| B-7 | **ADR 001 §4.0** | attestation is a **LOOKUP**, not `deviceShort(op.dev)`; plus the self-authorizing bootstrap, write-once as *admissibility*, and park-don't-reject | `src/js/core/authz.js:159-173, 591-663`; findings F-6, H-4 |
| B-8 | **ADR 001 §7.4** | two parked classes missing: unarrived attestation, and an unreadable admin unshare | `src/js/core/ops.js:310-325`, `authz.js:782-793` |
| B-9 | **ADR 001 §5 step 2** | the promotion formula and 18.3 could not both hold — an admin unshare's `pub.text: null` blanked **my own note on my own board** | `src/js/core/registers.js:493-542 withdrawnByOther` |
| B-10 | **ADR 001 §7.2** | nothing wrong; re-read and marked **reviewed, no change**, with the `checkpoint().bodies` cross-reference, so it is not re-opened | `src/js/core/oplog.js:323, 492` |
| B-11 | **ADR 005 §1.1** | no home for `src/js/core/replace.js` (now added, with why it is its own level-1 module); `project.js` marked **NOT YET BUILT** — it is the only entry with no file on disk, and all of ADR 004 §2 depends on it | `src/js/core/replace.js:67-77`; `ls src/js/core/` |
| B-12 | **ADR 005 §2.1** | `boot()` **cannot** be called from `index.html` — the page's own CSP refuses an inline module. The call lives in `src/js/boot.js`; and `main.js`'s top-level `blur` listener was an unlisted **third** import blocker | `index.html:17, 82`; `src/js/boot.js` |
| B-13 | **ADR 005 §2.2** | `mutate()` was **not** removed; it survives re-implemented as a diff transaction, and is a supported door — which is why findings A3-M3/M4 against it are contract defects, not dead branches | `src/js/store.js:19-31, 642-653` |
| B-14 | **ADR 003 §7 gate 1** + **ADR 005 §5 rule 4** | the gate **does not exist**: no `platform/net.js`, no `tests/tier1/network-scope.test.js`, and `PURE_DIRS` never scans `src/js/` as a whole. Marked **OWED (WP-8 / LZP-1002)** rather than left implying it holds | `tests/helpers/purity.js:28`; finding F-9 |
| B-14 ✅ | *(correction, 2026-09-03)* | **CLOSED, and this row is stale as written.** Both files exist and are committed; `tests/helpers/netscope.js` scans all of `src/js/` (not `PURE_DIRS`) and both gates are green. What was genuinely still missing is a *different* gap and E10 closes it: **neither gate could see the native side**, because a bridge `invoke` is not a `fetch`. See `FINDINGS.md` §16d and `tests/attack/e10-network-scope.test.js` §1 | E10-VERIFICATION §3 |
| B-16 | **ADR 002 §2.3 + §5.2** | the `deviceShort` resolution — see below | `src/js/core/ids.js:138`, `authz.js:591-663` |
| — | **contracts** | `ops.contract.js` (`attestedDevices` mistyped; `attestationOf` owed), `crypto.contract.js` (`openOp`'s signature and check list), `server.contract.js` (`setLastPushedSeq`/`minLastPushedSeq`) | all three still `node --check` clean |

**B-15 · ADR 002 §7.1** was already rewritten for decision D9 — confirmed, no action.

### The `deviceShort` contradiction — **RESOLVED**

**ADR 002 §5.2 is rewritten and is the single normative answer; ADR 001 §1.2 is the single
definition and every other document defers to it.** `deviceShort = crock32(SHA-256(rawSigPubKey)[0..10])`,
a function of the **signing key**; `op.dev` is an unrelated random id; the two are joined by a
**lookup** over the member's `dev.*` attestation registers. ADR 001 §4.0 and ADR 002 §5.2 both now
say lookup. `envelope.js` can be written against §5.2 without a further decision.

**Two corrections were made to the resolution as the reviewer filed it**, stated in ADR 002 §5.2.1
rather than papered over:

1. **`att === null` cannot be a post-decrypt check.** The attestation is the only source of
   `authorSigPub`, so resolving it is a **pre-decrypt gate**, and what gets parked is a **sealed
   envelope, unopened**.
2. **`attestationOf` is keyed by `deviceShort` alone** — `op.act` is not knowable before decrypt, so
   a two-key lookup could not run where it is needed. That is sound **only** because ADR 002 §2.3's
   four acceptance conditions make `deviceShort → DeviceAttestation` a function across the space;
   those conditions are now written down, with a warning that relaxing them breaks §5.2.

~~**One thing is still owed in code:** `foldAuthorized` discards the decoded payload
(`authz.js:661`), so `openOp` has nothing to check against. That is finding **F-10**, ~10 lines,
and it is **the** WP-6 blocker.~~
**CLOSED 2026-08-27.** `parseAttestationBlob` now returns the full ADR 002 §2.3 `DeviceAttestation`
(all six fields, required — a blob missing one is rejected `badAttestation` rather than admitted as
a credential `openOp` could only throw on), the register walk keeps the payload, and `AuthzResult`
gains `attestationOf(deviceShort)` and `shortCollisions`. `ctx.attestOpen(memberId, blob)` is
accepted per ADR 001 §4.0 / ADR 002 §5.2.3, and the payload **always** comes from the register
bytes: an `attestOpen` whose answer disagrees counts as a failed verification, because otherwise
the injected function is a second, unlogged source of device identity.

**What §2.3 still does not close, and WP-6 must read:** §2.3 claims `deviceShort →
DeviceAttestation` is a function because two members would need the same signing *private* key.
Nothing pure and synchronous can check `crock32(SHA-256(sigPubRaw)[0..10]) === att.deviceShort` —
that is §5.2.2's **P2**, and it lives in `openOp`. A member can mint a well-formed attestation
under a peer's short and, **backdated**, take the lookup, because the contest resolves
minimal-under-`≺`. Stage 0b is unaffected (the device gate is per-member) and P2 refuses the
envelope, but the fold must not pretend the collision did not happen — hence `shortCollisions`.
**WP-6's `attestOpen` should enforce the P2 binding at fold time.** Register row I-3.

### Owed, and not amendments

- `ops.contract.js` now names `attestOpen(memberId, blob) => DeviceAttestation|null` as the
  replacement for `attestVerify`. **Owner: WP-6.**
- `server.contract.js` now names `setLastPushedSeq` / `minLastPushedSeq`. **Owner: WP-7.**
- ADR 003 §7 gate 1 and ADR 005 §5 rule 4 are marked **owed**. **Owner: WP-8 / LZP-1002.**
  *(2026-09-03: both are closed — see the B-14 correction row above and `FINDINGS.md` §16d.)*

## 7. What to build next, in order

Per `docs/v2/PLAN.md` §2. WP-1 and WP-2 are done.

1. **WP-3 — the retrofit** *(LZP-402, 403, 404, 405)*. The first package that touches shipping v1
   code: `store.js` `mutate()` → `txn()`, all 22 mutate sites in `interact.js` / `popover.js` /
   `legend.js`, `storage.js` gains the op-log file, plus the two one-line unblockers
   (`interact.js:199`'s top-level `window.__lzpContextMenu`, `main.js:30`'s boot IIFE).
   **Gate: the v1 characterization suite stays green, with the shadow-undo assertion armed
   (`globalThis.__LZP_DEV = true`).** Honour the WP-3 obligation in §5.
2. **WP-4** property harness extension · **WP-5** render seams behind a null family.
3. **WP-6 crypto core** — resolve the `deviceShort` contradiction first.
4. ~~**WP-7 server**~~ → ~~**WP-8 sync + fleet → M1 "Zwei Macs"**~~. **BOTH DONE.** M1 is
   demonstrated: `docs/v2/E5-VERIFICATION.md` §3.
5. **WP-9 Familienkreis** — closes the KNOWN GAP in §5, **and now also owns E5-6**, which is M1's
   last real gap: a paired Mac receives none of the pre-space board, categories included, so
   pairing a Mac that does not already hold the `board.json` is not delivered · **WP-10
   visibility** · **WP-11 rendering** · **WP-12 pipeline + hardening**.

Note that **E1 (the release pipeline) touches none of the same files** and can run in parallel
with WP-3–WP-5 whenever you want distribution dogfooded early, as the sprint plan intends.

## 8. What still needs you (not buildable here)

- **Vercel account + Prisma Postgres**, Frankfurt (D2) — for `server/adapters/prisma.js` and the
  real deploy. Every handler is testable here against the memory adapter without them.
- **A GitHub remote** (D3) — for Actions, Releases, and the updater channel.
- **No Rust toolchain on this Mac**, so `src-tauri/` cannot be compiled or smoke-tested. The
  Swift/WKWebView shell is the reference implementation and is fully buildable here. Risk R8:
  the Tauri commands must be built and smoke-tested on a machine with cargo before any Tauri
  build ships.
- **D1 = unsigned**, so **LZP-106 (the guided Systemeinstellungen unlock screen) is mandatory**
  and is the first thing Mom meets. Deliverables 27 and 28 are release-blocking. Reversible: a
  cert plus two CI secrets, no code change.

---

# Session 2 addendum — 2026-08-26

## WP-3 landed (LZP-402 / 403 / 404 / 405)

The v1 app is on the op log. Commits `125ba17` (retrofit) and the adversarial suites after it.

**What changed in v1 code** — 7 files, everything else byte-identical to the baseline:

| file | change |
|---|---|
| `store.js` | 284 → 888 lines. `mutate()` → `txn()`/`apply()` over the log; `applyRemote()` seam for WP-8; register-backed state materialised into the exact v1 shape |
| `storage.js` | +159. `ops.jsonl` + `checkpoint.json` beside `board.json`, same atomic-write and localStorage-fallback shape |
| `interact.js` | 10 sites converted; `__lzpContextMenu` moved out of top level |
| `popover.js` | 6 sites; local day-selector replaced by `core/entities.js`'s shared one (**net −4 lines**) |
| `legend.js` | 6 sites |
| `main.js` | boot IIFE → `export function boot()` |
| `boot.js` / `entry.js` | **new** — see the CSP note below |

`layout.js`, `board.js`, `dates.js`, `find.js`, `print.js`, `settings.js`, `backup.js`, `ui.js`,
`holidays.js`, `ferien.js`, `palette.js`, `i18n.js` are **untouched**. Rendering never learned about
the op log.

**Independently verified** (not just by the agents): the live app renders 12 columns / 372 rows /
12 pads with zero console errors; create → undo → redo → undo round-trips on the log; the persisted
note carries exactly v1's five keys at `schemaVersion: 1`.

## New findings from the WP-3 adversaries — all open, none blocking

- **F-1 · LOW · a decision, not a repair.** `board.json` stops being a fixed point across a restart
  once two scratchpads exist: `store.js:reconcileMap` does `Object.assign` and never *reorders* an
  existing live object, so `sortScratchpads` only takes effect on a freshly projected board. Content
  is identical and nothing on screen moves — but the file is atomically rewritten with different
  bytes on the first save of each session, and v1 *was* a fixed point. The fix is a one-liner
  (rebuild the map in projection key order, as `reconcileList` already does for arrays) **but it
  changes `board.json` bytes for existing users on their next save**, so decide it deliberately.
  Pinned green in `retrofit-probe5/6.dom.js`.
- **F-2 · not reachable by a human today, wrong failure mode.** An over-length value through the
  `apply()` door throws an **uncaught** `OpError` — the note is lost, no undo step, no warning —
  while the same value through the diff door truncates-and-warns. Measured in both WKWebView and
  Blink: `maxLength` holds for every human input route (typing, paste, `execCommand`, drop); only
  scripted `setRangeText` / direct `.value` bypass it, and no shipping site does. **It becomes live
  the moment WP-8's remote path puts an over-length string in front of `apply()`** — fix it before
  sync lands, as a truncate-and-warn or a visible decline.
- **F-3 · cosmetic.** `store.undoStack.length = 0` also clears redo, and `.push()` is a silent
  no-op. No shipping caller; belongs in `store.contract.js` §2.2 as an explicit divergence.
- **F-4 · already decided, now measured through the real keyboard.** ATT-5: deleting an already-
  deleted entry records 1 undo step where v1 recorded 2. Strictly better.

**Everything else held.** The real-app adversary ran 92 gesture-level rows in WKWebView — undo
grouping across month boundaries, the 50-step limit, autosave timing and `pagehide`, ⌘Z near a
focused field, delete-with-reassign over 80 entries as one undo step, pinned-mode paging, find,
print, the first-run coach, and a 200-gesture soak across a restart — with zero uncaught errors and
no divergence from v1 beyond F-1.

## New ADR amendment owed (adds to §6) — **APPLIED, see §6 row B-12**

> **Correction, 2026-08-27:** this section named the file `src/js/entry.js`. **The file on disk is
> `src/js/boot.js`** and no `entry.js` exists; ADR 005 §1.1 and §2.1 were amended to say `boot.js`.

**ADR 005 §1.1 / §2.1 owe `src/js/boot.js`.** §2.1 says `boot()` is called from `index.html`. It
cannot be: `index.html` ships `default-src 'self'` with no `script-src` override (story 13.4), so an
inline `<script type="module">` is refused by the page's own CSP and the app would silently never
start. A CSP hash is brittle and `'unsafe-inline'` would destroy the zero-network property tier 2
asserts — so the call lives in a two-statement same-origin module loaded by `src`, and the purity
gate pins it to exactly those two statements.

Also: the seams work found a **second, unlisted top-level blocker** the ADR does not name —
`main.js`'s top-level `window.addEventListener('blur', …)`, which was the *synchronous* throw on
import (the boot IIFE only produced a rejected promise).

## Still owed from session 1 — **CLEARED 2026-08-27**

> **Both judges ran** as a standalone read-only pass, exactly as this section asked. See §4 and
> `docs/v2/FINDINGS.md`. The paragraph below is kept for the history of *why* the resume attempt
> was abandoned.

The two WP-1 judges (§4) had **not** run. A resume attempt re-executed the Repair phase instead of
replaying it from cache, and it was writing to core files whose fixes were already committed while
WP-3 was building against them — so it was stopped and its uncommitted work reverted to the
proven-green commit. **Run the two judges as a standalone read-only workflow**, not via resume.

Its one genuinely new artifact — a shared `src/js/core/v1import.js` extracting the duplicated
v1→ops logic out of `migrate1to2.js` and `replace.js` — is saved as a patch at
`<scratchpad>/round2-rerun/rerun.patch`. It is an internal refactor, not a correctness fix: the
two-doors parity it would tidy is already proven by property **P13** over 500 seeds. Redo it cleanly
when convenient, or drop it.

---

# Session 3 addendum — 2026-08-27 · the documentation half

Read-only session. **No file under `src/` was changed**, and no code fix was applied — the code half
of both audits is a separate, later pass, and three of the findings are PO decisions rather than
repairs.

**What landed**

- **`docs/v2/FINDINGS.md` — new, and the single register.** 24 rows with id, severity, one-line
  description, `file:line`, owning work package and status; a "fix before WP-8, in order" list; a
  clearly marked "needs a decision" section with the trade-off in two sentences each; a record of
  the 19 attacks that **failed**, so the next round does not re-run them; and a record of the six
  things neither audit could execute.
- **Sixteen ADR amendments applied** to ADR 001, 002, 003 and 005 plus three contracts — §6 above
  has the table. Each carries a marginal note naming its evidence.
- **The `deviceShort` contradiction is resolved** in ADR 002 §5.2, with two corrections to the
  filed resolution stated loudly in §5.2.1 rather than smoothed over.

**Suites re-measured, all four green** (§2). Unchanged code, so this was a check that nothing rotted
under the E1 agent's parallel work, not a claim about this session.

**Watch out for:** the E1 pipeline agent was editing the working tree throughout this session
(`shell-macos/`, `src-tauri/`, `.github/`, `scripts/`, `server/`, `src/js/platform/`, `src/js/i18n.js`).
Those changes are **not** part of this session's commit. One tier-2 run failed mid-session with a
shell syntax error because `shell-macos/build.sh` was being written at that moment; the re-run was
clean. **Finding F-9 is about that work and belongs to E1: `src/js/platform/` is scanned by
nothing.**


---

# Session 4 addendum — 2026-08-27 · rounds 4 and 5, fixed and integrated

**Read this first.** Two more adversary rounds ran against the retrofit, three fixers worked in
parallel, and one integration pass landed the cross-file work, verified it, and caught the register
up. All four suites green: **`npm test` 1374 · `test:attack` 512 · `test:property` 51 ·
`test:dom` 15 files, tier 2 PASS.**

## The headline: the rule held, the implementation did not

ADR 006 — *`board.json` is the truth, the op log is history* — **survived round 5 without
amendment to §1**. Three attempts at this question have now been made and the third is the first
one an adversary could not break at the level of the rule. Every round-5 finding was an
implementation defect underneath it, which is the outcome you want from an ADR.

**Four things were wrong under it, and two of them were serious:**

| what | severity | why it mattered |
|---|---|---|
| **R5-3** — A3-C1 reachable again through R7 | CRITICAL | R7 (the absent-`board.json` recovery) was entered on `kind !== 'ok'`, so a board that merely failed to **parse** took the branch that performs **no lineage check at all**. One truncated byte + the attacker's own legitimate log pair = the stranger's board on screen and committed. **CLOSED.** |
| **A3-M5 / R5-4** — the log stops recording on the second launch | HIGH (was filed MEDIUM/latent) | `_persistOps` never called `appendOps`, and `checkpoint()` folds only to the horizon it was loaded with — so from launch 2 onward **nothing the user did was ever written to the log again**, every ordinary launch reconciled a growing diff, and `_born` (which decides array order) was re-minted on every launch. **CLOSED.** |
| **R5-11** — an unreadable bar edge | MEDIUM | The edge was dropped, a one-ended bar is anchored to the other end, and a bar v1 drew **nowhere** was drawn across every column with chevrons, taking a lane from real bars. `endDate: ""` is the commonest hand-edit there is. **CLOSED**, narrowed residual in FINDINGS §4.6. |
| **R5-2e** — two ADRs that could not both be obeyed | MEDIUM | A wrong wall clock made ADR 006 §12.6 and ADR 001 §1.3 jointly unsatisfiable, and the loser was the user's whole history — quarantined *and renamed*. **CLOSED** as a deferral, in code and in both ADRs. |

## What the integration pass itself found

**Two of the three fixers' "left for another agent" items were unproven fixes.** `_projectSafe`
clobbering `bootFailure`, and `persistNow`'s read-only sentence claiming a board "could not be
**drawn**" on three reasons where nothing had even read it. Both were landed here — and reverting
either killed **nothing** in any of the four suites, which is the same thing as not having a fix.
Rows **R5-3e** and **R5-3f** were written to close them before they were recorded as fixed.

**One attack row was still asserting a closed defect.** R3-39 claimed `_persistOps()` never
appends. Inverted, and its file header's "`store.js` never writes `ops.jsonl`" corrected to the
narrower claim R3-38 actually pins.

**The headline check for R5-4 — boot · edit · restart · edit · restart — is now a permanent row**
(R5-4f), because the defect was only ever visible as a *sequence*: each launch looked fine and the
damage was that the number grew.

## What you actually have to decide

**`docs/v2/FINDINGS.md` §4 has two new open decisions, and one of them blocks WP-6:**

- **§4.5 — I-3 / R5-7: a remote denial of service on any family member's device.** One op from
  anybody permanently mutes a named Mac, and **WP-6's owed P2 check does not close it.** If the
  plan of record for WP-6 is "we'll fix I-3 with the attestation binding", that plan is wrong. Read
  §4.5 before any attestation code is written.
- **§4.6 — R5-11g:** a bar edge with no faithful v2 value at all. Blocks nothing; it is a fidelity
  ceiling and should be an explicit one.

**§4.7 records that ADR 006 §12.6 vs ADR 001 §7.4 is NOT a decision** — R5-2e resolved it in code
and in both ADRs. Nothing is owed to you there.

## Register and ADRs

**`docs/v2/FINDINGS.md` was three rounds behind and is now caught up.** 31 rows → **39**, counts
recomputed from the rows rather than carried forward, with a table of what moved between severities
and why. New: **§7c**, the accepted-defect list — all 23 `tests/attack/` rows that are green
*because a defect exists*, each mapped to its register row. Nine of the twenty-three trace to just
three rows (F-2/F-7, A3-H4, I-3), which is the useful reading of it. §6b's corpus table is
regenerated, not hand-edited: round 5's new generator block consumes the rng stream, so several
existing rows moved without anything about them changing.

**ADR 006** gains a rewritten **§5.5** (R7's precondition is `absent`, and only `absent`), a new
**§5.6** (the read-only boot over `snapshots.json`), and `board-unreadable` in §7's reason enum.
**`store.contract.js`** documents `diagnostics().recoveredFrom`, the widened `bootFailure.reason`,
and the two new quarantine reasons.

## Two things to fix about the process, not the code

1. **`src/js/store.js` and `tests/attack/round5-authority.test.js` were assigned to two fixers at
   once.** Both used anchored edits and both survived, but that was luck. One owner per file.
2. **A fixer reporting "left for another agent" is reporting an unproven fix.** Two of three did,
   and neither item had a test. Treat that list as work, not as a note.

## Still owed (full list in FINDINGS §8)

- **ADR 001 §7.2's own text** still describes a 30-day debuggability tail and a 2 MB-at-launch
  trigger. Neither is implemented — compaction is total. The deviation is recorded in ADR 006 §8.5
  and at the `TAIL_COMPACT_AT` docblock; **§7.2's text itself is unamended.**
- **The first-run tour still shows over a disaster boot with no snapshot** (`seenFirstRun` left at
  v1's value; a tier-1 row characterizes it by name). Tier-1 owner's call.
- **I-6** — `quarantineLogAside` on the native path still cannot move anything. Much less pressing:
  a failed boot never sequesters at all now.
- **F-5 / R5-5b** — folding an adopted checkpoint through `applyRemote`'s gate. WP-8.

---

# Session 5 addendum — 2026-08-27 · round 6, and the method that finally closed it

**Read this first, and read it before you read the fixes.** Round 6 ran against the op-log core and
the retrofit. Its findings were closed by three parallel fixers and one integration pass, and all
four suites are green: **`npm test` 1665/0 · `test:attack` 566/0 · `test:property` 62/0 ·
`test:dom` 22 files, tier 2 PASS.**

**Per-domain, every enumerated input gets its required behaviour:** D1 94 + D1_RECOVERY 8 · D2 44 ·
D3 5 · D4 14 · D5 4 · D6 141 = **310 entries, 0 UNEXPECTED, 0 STALE, 0 `openFinding` remaining.**

## THE PROCESS CHANGE — this is the part that matters, and it is now a rule

**`tests/helpers/domains.js` is the required method for ADR 006 §5/§7/§9.** Not a suggestion, not
a nice-to-have: **the required method.** It is recorded in FINDINGS **§7d** and in ADR 006 **§10**.

Five consecutive rounds each **relocated** the same failure rather than closing it, and round 6's
closing verdict named why:

> The fixes are still being chosen a branch at a time, and the branch is chosen before the input
> domain is written down. R6-5a is the sharpest instance: round 5 replaced "is raw null?" with a
> careful five-way classifier and wrote out four of the five kinds in a docblock — and `''` still
> went to the wrong one, because the enumeration was of **branches** (ok/absent/unparseable/
> not-a-board/read-failed) rather than of **bytes**.

**So: enumerate the INPUT DOMAIN first, exhaustively, as data. Then choose behaviour per input.
Then property-test over the domain.** `tests/helpers/domains.js` holds **310 entries** across six
domains (D1 bytes × sources, D2 stamps × authorship, D3 provenance, D4 checkpoint growth, D5 array
order, D6 date strings by sort position), each `{id, value, label, expect, openFinding}` where
`expect` is the **required** behaviour. `tests/property/domains.test.js` walks every entry and
never stops at the first failure: it splits deviations into **UNEXPECTED** (a regression),
**STALE** (a finding is named but the entry now holds — *the work order is lying*), and the work
order itself.

**It worked, measurably.** The enumeration opened with a **51-entry work order** and 0 unexpected,
0 stale. All 51 are closed; `openFinding` is `null` on all 310 entries; every property is green.

**And it found two things six adversary rounds did not:**

1. **Round 6's closing "content is safe" is wrong.** `D1-b18` — `{"_v2":{lineageId:<the victim's>,
   gen:N}}`, an object that is nothing but ADR 006's envelope — classified `ok`, matched
   `same-lineage`, **adopted the log**, and made `_reconcileOntoBoard` mint **nine well-formed
   `{_alive:false}` retractions**, both committed. Every other row in the register costs *history*.
   That one costs **the calendar** — and at WP-8 what propagates is not a corrupt file but deletes
   this app minted itself. **`Array.isArray` was the entire guard.** → FINDINGS **R6-5**, CRITICAL.
2. **A premise correction in the *permissive* direction**, which is the one that proves the method
   is not just a ratchet. FINDINGS §4.6's open decision — *a bar edge with no faithful v2 value* —
   turned out to be **misstated**: the collision with finding 6 is a question about *which field*,
   not about which fidelity. **§4.6 is closed and no PO ruling is owed.**

## What was closed

| row | severity | one line |
|---|---|---|
| **R6-5** | CRITICAL | ADR 006's precondition had a hole on **both** sides: a **zero-byte** `board.json` was `absent` (so a truncated write took the one branch that may adopt a log), and **any** JSON object was a board (so the envelope-only object emptied the calendar and minted the deletes) |
| **R6-4** | HIGH | One op parked for a bad clock quarantined **the entire history**, on every launch until the stamp passed — with `_opsPersisted = false`, so the device recorded nothing meanwhile. And the park was decided **before** authorisation, so a stranger could trigger it with a date |
| **R6-3** | HIGH | The bound on `ops.jsonl` was purchased with an **unbounded `checkpoint.json`**: `bodies` was the one index `pruneSeqIndex` stepped over, and it is serialized into the file rewritten on every debounced save |
| **R6-10 / R6-11** | HIGH / MEDIUM | A bar edge sorting **inside** the rendered range was dropped; **2 414 of 9 104** measured cases painted the wrong columns. Closed by one rule over the whole alphabet instead of a three-way split |
| **R6-7** | MEDIUM | The reconciler could not mint a **position**, so restoring an older `board.json` put a deleted entry back at the **end** of the list instead of where the user had it |
| **R6-6** | MEDIUM | The inverse of R5-3's caution: a recovery that **failed** fell out as an empty, **writable** board — while `snapshots.json` sat loaded and unread |
| **R6-2** | LOW | ADR 001 §7.2's 2 MB-at-launch compaction trigger was never implemented (≈3 MB in ≈260 lines, nowhere near the line cap) |
| **R6-7e** | LOW | ADR 006 §9.3's W2 contradicted §7's own table. §7 is right; W2 conflated the local binding with the stamps on a re-derivation. **Amended** |

## The headline checks, measured at integration

- **(a)** A **foreign** op stamped +48 h becomes **0 lines**, reaches `checkpoint().parked` **0**
  times, and the next launch has `quarantine === null` with the history adopted and `reconciled 0`.
  The refusal is reported **by name** (`notMyAct`), and no warning names this Mac's clock. The
  user's **own** device at +48 h is still **parked** — the park survives the re-read, the future
  value never reaches the screen, and it still costs that op and nothing else.
- **(b)** `checkpoint.json` over **10 sessions × 400 edits** on a one-note board: 5 996 B → **75 000
  B at the first compaction that fills `bodies`, then flat to within 1 byte** while ops-ever goes
  2 000 → 4 000. The control — the same 4 000 ops on 1/5/25/100/400-note boards — holds `bodies` at
  the cap in every row, so all the variation is the register, i.e. the board. **Honest statement of
  the bound: `O(board) + O(min(ops-ever-compacted, 1500))`** — bounded and flat, *not* proportional
  to board size, with a ≈75 KB constant a small board pays once it has been edited 1 500 times.
  That constant is pinned by D4 and by a tier-1 row on `BODY_FINGERPRINT_CAP`, so drift is red.
- **(c)** A **zero-byte** `board.json` beside a stranger's *legitimate* log: `bootFailure` is
  `board-unparseable`, `_adopted` is **null**, the stranger's note is **not** on screen, the
  snapshot stands in, the log is quarantined `board-unreadable` and **not** renamed, and a persist
  **moves not one byte**.
- **(d)** Delete the middle of three notes, then restore the older `board.json`: `quarantine` null,
  **exactly 1 op** reconciles the difference, the note is **back** and the order is `a, b, c` — and
  the **second** launch reconciles **0**, so it converged rather than re-minting every launch.

## Mutation testing

**Twelve mutants**, applied to a fresh scratch copy at the round-7 head, reset between rows, all
three node suites re-run each time. **Every one is lethal and every one names the row it kills** —
the table is FINDINGS **§7a-round7**. The seven the brief names by letter (F1 bodies-pruning, F2
`_clockSkew` liveOnly, F3 `''` unparseable, F4 object shape gate, F5 empty-projection fallback,
F6 order clause, F7 bar-edge floor) are all included, along with five near-misses that distinguish
a real fix from one that merely passes.

**Three mutants initially killed nothing**, which is the part worth remembering: the rows had to be
rewritten against the input that *distinguishes* — a **superseded** op, and a spliced id that still
holds a line at eviction time. And a fourth (`_standIn`'s snapshot set to `null`) reddens **eleven**
attack rows, so story 11.5 is now genuinely load-bearing on the disaster path rather than merely
claimed to be.

## What this pass found itself

**R7-1, open, LOW.** R6-6's fix added a **fourth** boot outcome to a **three**-valued
`diagnostics().source`, and it reports `'board.json'` — documented as *"solo mode, or the log was
quarantined"* — about a boot where there is **no `board.json` at all**. Its twin (§5.6's read-only
boot over a zero-byte board) reports `'recovery'` for the same picture. Two rules are implemented
at once, and the comment justifying the second is verbatim the argument that condemns the first.
**Diagnostics only** — `bootFailure.reason` and `recoveredFrom` carry the whole truth. **Filed, not
patched**: widening a documented contract field belongs to `store.contract.js`'s owner, and jamming
a fourth outcome into whichever of three values fits least badly is the exact move §7d exists to
stop.

## Process, again — and it is the same item as last session

**`src/js/store.js` had three concurrent editors this round.** All three used surgical
unique-anchor edits, all three landed cleanly, and each proved its own changes green in isolation —
but that is care, not process, and it is the second round running. `store.js` is 2 400 lines and is
the file every round's fixes land in. **It needs splitting, or one owner per round with the other
fixers handing it patches.** → FINDINGS §8 item 11.

The other standing lesson held: **a fixer reporting "left for another agent" is reporting unowned
work**, and this pass landed all of it — ADR 006 §5.5's outcome enumeration, §5.6's table,
§9.3's W2, INV-20, §10's method note, ADR 001 §7.2's two halves, and the register itself, which had
**no `R6-*` rows at all** before this pass.

## Still owed (full list in FINDINGS §8)

- **R7-1** — the fourth `source` value (item 12).
- **A `clock-skew` residual with no escape hatch**: a local clock set a *year* forward and then
  corrected leaves live register stamps a year ahead, so the log is deferred-quarantined **for a
  year** with no user action that helps. Content is whole throughout. **It needs a domain of its
  own before it needs a fix** (item 13).
- **`seen` is unbounded in-session** — ≈150 KB RAM at 6 400 ops, bounded across restarts by
  `bodies`' cap (item 14).
- **A settings pane for `recovery-unusable`'s copy**, which is written and unrendered — the same
  owed surface as F-8's consumer (items 1 and 15).
- **A WP-8 cross-device invariant on the interpolated `_born`** (item 16).
- **I-6** — `quarantineLogAside` on the native path still cannot move anything. Less pressing
  again: neither a failed boot nor a failed recovery sequesters.

---

# Session 6 addendum — 2026-08-27 · **E3, identity and crypto** (LZP-302…306)

**Full evidence: `docs/v2/E3-VERIFICATION.md`. New findings: `docs/v2/FINDINGS.md` §2e.**

## What landed

Seven DOM-free, I/O-free modules under `src/js/crypto/` — `suite`, `probe`, `identity`,
`spacekeys`, `envelope`, `pairing`, `backup` — plus the one stateful module,
`src/js/platform/keystore.js`, and the Keychain bridge in both shells. **Zero npm dependencies**;
WebCrypto is built into both engines. `core-purity` is green over all of it, and the gate
**discovers files by reading the directory**, so the next module is covered the day it lands.

**All four suites green: 1665 · 62 · 566 · 22 files / 375.**

## The one thing to read if you read nothing else — **E3-1**

**A rebuilt or re-signed bundle makes every persisted device key read back as `null`.** WebKit
encrypts persisted `CryptoKey`s under a per-application "WebCrypto master key" it keeps as a
Keychain generic password **whose ACL is bound to the code signature of the binary that created
it**. `shell-macos/build.sh` ad-hoc signs, **D1 says ship unsigned**, and LZP-102's updater
replaces the bundle — so on that path a user would have to **re-pair after every update**, and the
symptom is built to be missed: the error goes to the process's *stderr* where the page cannot see
it, and plain values in the same database survive untouched.

A stable Developer-ID signature makes the ACL survive. **That turns code signing from a packaging
preference into a hard requirement of the custody design**, and it is the first argument that puts
a cost on *not* reversing D1 (which is explicitly reversible: a cert and two GitHub secrets, no
code change).

It also produced a real fix to `tests/run-dom-tests.sh`: the tier-2 build is re-identified as
`org.langzeitplaner.domtest` before launch, so WebKit's website data store — localStorage **and**
IndexedDB — is genuinely isolated from the installed app. **It was shared before**, and clearing
the production master-key item would have orphaned a real installation's device keys.

## The guarantee suite

`tests/tier1/crypto-guarantees.test.js` — **one test per numbered product promise** (21.1 ·
21.2/20.5 · 20.2 · 16.7 · 19.4 · 19.5 · A2/D8 · 15.1), each end to end through the real public API,
because a guarantee is a claim about a **composition** and a composition can be false while every
module in it is green. All eight pass and **each was mutation-tested**.

Two of them are worth knowing about by name:

- **20.2 asserts the honest limit in the same test as the guarantee.** Removal is forward-only: the
  removed member keeps `FSK_1` and every envelope she already synced. **UI copy that says „sieht
  deine Einträge nicht mehr" without „ab jetzt" is false**, and that row is what keeps the sentence
  honest.
- **15.1 is asserted in the two forms it can actually be false**, because breaking it produces no
  error, no delay and no wrong answer: nothing under `src/js/crypto/` is *reachable* from
  `boot.js`/`firstrun.js`/`main.js` (an `import` is evaluated whether or not anyone calls the
  function), **and** importing the whole crypto layer draws **zero** CSPRNG bytes and makes **zero**
  `generateKey`/`deriveBits` calls. Both halves are proved non-vacuous.

## What to build next, and what blocks it

1. **WP-8 (the outbox/inbox)** is unblocked for crypto, with three obligations it must not skip:
   add **`PARK_REASONS.ATTESTATION`** to `core/ops.js` (finding **E3-3** / F-6 — `authz.js:671`
   rejects and `store.js:699-703` drops without appending, so a parked op is never re-evaluated);
   pass **`ctx.attestation`** to `sealOp`; and be able to hold a **sealed, never-decrypted
   envelope** for both park reasons.
2. **WP-10 (`core/project.js`)** — `PROJECT_CONTRACT` in `envelope.js` is the spec, executable, and
   `crypto-envelope.test.js` runs a conforming miniature projection against it. **Until it lands,
   no family `pub.set` can be sealed at all** — deliberately.
3. **WP-7** owes an attested **`RK_kex`** (E3-2), the four `/api/v1/pair/*` endpoints, one
   reconciled rate-limit policy (E3-5), and **invites** — noting that `sealInviteKeys` /
   `openInviteKeys` are **retired by D9 and must not be built**, enforced in code by
   `RETIRED_INFO` and by `buildRotation` refusing an invite that carries key material.
4. **WP-9** owes the `dev.*` register writes and **unpairing** — which does not exist, because
   `dev.*` is write-once and there is **no revocation anywhere**. A „Gerät entfernen" button can
   only stop future key distribution, and the UI string must say the smaller true thing.

## Two things E3 did not close, on purpose

- ~~**I-3 / R5-7 is still open**~~ — **CLOSED 2026-08-28 in `src/js/core/authz.js`; verified
  2026-08-29.** Everything below is still true and is *why* the answer had to come from the fold
  rather than from P2. Option (a) was built as a **possession proof**: a `dev.<S>` register is a
  credential only if the op that wrote it was itself stamped by the device it attests
  (`devOf(cell.stamp) === att.deviceShort`), which is sound because `openOp`'s P2, P3 and check 4
  together mean an op stamped with `S` was signed by `S`'s key. Reverting that one line kills
  **M-I3b**, **M-I3c**, **M-I3d** and **M-I4** and 3 cells of domain C3. The price is a door:
  `openOp` is now the sole enforcer of a credential, so **check 4 may not be weakened or moved
  after the decrypt**, and **nothing may append an op that has not passed `openOp`** (row M-I5b,
  owner WP-8). Original text follows.
  FINDINGS §4.5 predicted exactly this: E3 shipped **P2** as a
  MUST, and **P2 buys self-consistency, not identity**. `sigPubRaw` is a public key travelling in
  the victim's own register; the squatter copies it, tells the truth about it, and passes. Option
  (a) — first-claim on `(sigPubRaw, deviceShort)` in `core/authz.js` — is still the only answer.
  `openOp` is built to survive the gap: it treats `attestationOf` as a **partial function** and
  **parks**. Characterization rows named *"I-3 / R5-7 IS STILL OPEN"* exist in **both tiers**.
- **The Tauri shell is WRITTEN-UNVERIFIED and cannot be otherwise here** — there is no Rust
  toolchain on this machine, so `src-tauri/` cannot be compiled at all. `E3-VERIFICATION.md` §6 is
  the checklist for the first machine with `cargo`; the first item on it is a **security**
  difference, not a style one (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`).

## One decision owed from the PO — **ANSWERED 2026-08-28, verified 2026-08-29**

~~**E3-6 — should the backup's board block be authenticated?** It is not, today.~~ **It is now.**
The AAD carries `board: { digest, hash }` — a SHA-256 over `boardDigestInput(file.board)`,
recomputed on both sides, not a field of the file, so there is nothing to strip and no wire format
to version. `sealAad` **throws** if a caller omits the digest.

The objection that made this a decision was the good one and it was **answered, not overruled**:
the board-only path still has no key, so instead of one guarantee that would have been true on one
path and false on the other, there are **two stated guarantees** — `LIMITS.board.withIdentity`
(„es kommt entweder dein Board zurück oder gar keins") and `LIMITS.board.boardOnly` („wer die Datei
verändert, verändert das Board, das beim Import zurückkommt"). The second objection is answered
too: `boardDigestInput` deliberately does **not** use `canonicalJSON`, so a float that wandered
into `settings` cannot make the export fail. `LIMITS.boardNotAuthenticated` remains as a
deprecated alias, because three audit documents quote it by name.

Proof: row **M-B4** inverted in place, 7 cells of domain C2, and `crypto-backup.dom.js` #17/#18 in
the shipping engine. Removing the one AAD line kills exactly those and nothing else.

---

# Session 7 addendum — 2026-08-29 · **verification of the E3 red-team fixes (`f5add24`)**

Two workflows ran in parallel and both were cut before their final phase; their code landed
committed and green. This session was the missing verification of the E3 half. It changed **no file
under `src/js/`** and did not touch `server/` or `tests/server/`.

**Full evidence: `docs/v2/E3-VERIFICATION.md` §0 (pass 2).** The four lines that matter:

1. **The four named fixes are real, and a fifth nobody named is too.** Each dies on its named row
   under mutation — S1's `admitWraps` sender check in **both** the personal and the family space,
   the `(sigPubRaw, deviceShort)` first-claim binding, the backup AAD, ADR 004 barrier 4 — and so
   does `authz.js` **stage 3c**, the receiver-side mirror of INV-R1, which is the half that matters
   most because every other redaction barrier is author-side and the attacker owns the Mac that
   runs `sealOp`. Table: `FINDINGS.md` §7a-e3.
2. **The 86-entry work order is closed, and was measured rather than read.** The domain file was
   born inside the fix commit, so there is nothing to diff; applying all five mutants at once
   reconstructs the pre-fix build, and the property then fails exactly **30 + 7 + 3 + 35 + 11 = 86**
   inputs — including exactly the "35 of 324 cells" ADR 004 §2.2 priced by hand. The shipped build:
   **0 known-open, 0 UNEXPECTED, 0 STALE**, one input (`C2c-2`) **carried** to `server/`, not
   closed. The enumeration is **587 inputs across five domains**; the figure 524 is stale.
3. **Two suites were not actually green** — findings **E3-9** (fixed here) and **E3-10** (another
   owner's file). See §2 above.
4. **The verdict: 20.5 and 21.2 are now true of the code as built; 21.1 has not regressed.** The
   residual on 20.5/21.2 is §8.5's phantom **member**, which receives `FSK_e` and never a `PSK` —
   so it does not touch either story — and it is now UI-surfaceable rather than invisible. What a
   removed member, an admin and the relay can still do is enumerated in `E3-VERIFICATION.md` §0.6,
   every row green and characterized.

**Still the one thing that stops a release: E3-1**, unchanged and re-confirmed. WebKit binds the
Keychain ACL of the WebCrypto master key to the **binary's code signature**, LZP-102's updater
replaces the bundle, and on **D1**'s unsigned path the family re-pairs after every update. It is a
live argument for revisiting D1, which is reversible with a certificate and two GitHub secrets and
no code change.


---

# Session 6 addendum — 2026-08-29 · E5, and M1 demonstrated

**Read `docs/v2/E5-VERIFICATION.md` in full before touching sync.** This is the summary.

## What landed

`src/js/sync/` (protocol, chain, cursor, outbox, client, personal), `src/js/family/`
(engine, pairflow, mount, familysettings, pairingui, syncstatus), `src/js/platform/net.js` and
`device-identity.js`, the durable-identity seam in `store.js`, and the fleet harness. Six suites,
all green apart from E3-10.

## The headline: M1 is shown, not argued

Two browser contexts on two different origins — two separate `localStorage` partitions and two
separate IndexedDB key stores, which is the browser's own enforcement rather than a test
convention — became two devices of **one member** on the relay:

```
24GK2RJ4TGC59XM2  mem__4kcZiXAdOiFt_9D7_TapA  live      ← Mac A
8K8JXA7A3G2VAQ07  mem__4kcZiXAdOiFt_9D7_TapA  live      ← Mac B
```

They paired with a real code read off one screen and typed into the other, and **both screens
showed `564 760`**. A note created on A appeared on B; an edit on B landed on A; a bar dragged on
A landed on B; B went offline, both sides were edited, and on B's return the two boards
**converged** and survived a relaunch of both. The indicator drew nothing at any checkpoint.

The relay stored seven ops. A plaintext search over every byte it holds for them found **none** of
`Blutdruck`, `Sonnenberg`, `Zahnarzt`, `Elternabend`, `Werkstatt`, `Steuerberater`, `Herbstferien`
— nor `note.set`, nor `2026-11-03`. It knows a space id, a seq, an opId, an epoch, a device short
and a chain hash.

## The three things that were wrong, and one that still is

- **E5-2 · CRITICAL, closed.** The outbox did not survive a quit: unacknowledged ops were folded
  into `checkpoint().regs` and their LINES dropped, so five entries made on an offline laptop
  never reached the desktop, ever, while the engine said `healthy`. **This was inside A3-M5's own
  fix**, which is the second time a defect in this area has hidden behind a closure. One clamp;
  its accepted-defect row is inverted.
- **F-6 · closed**, and it took four coordinated edits rather than one — the park reason had to
  exist (E3-3), and then it had to survive a relaunch, because `oplog.load()` re-classifies parked
  lines and would have promoted an unattested device's op to live.
- **Four network gates amended** from "no import edge" to "no **STATIC** import edge". The
  stronger form forbade the design ADR 003 §7 gate 2 and ADR 002 §2.4 describe, and the way it
  gets worked around is by hiding the specifier from the walker. The gate now counts doors:
  exactly one, `main.js -> family/mount.js`, named.
- **E5-6 · HIGH, OPEN, and it is what M1 does not yet deliver.** A paired Mac receives none of the
  pre-space board — including the **categories**, so every synced note is silently remapped onto
  the receiving Mac's own default. Owner: WP-9 / the pairing flow.

## Still owed, and by whom

| owner | what |
|---|---|
| **E1** | `sync_request` in `shell-macos/main.swift` and `src-tauri/src/lib.rs`. **Without it family mode has no transport inside the shipped app at all** — the demonstration ran on `fetch` in a browser. |
| **WP-9** | E5-6 — the `board.json` hand-over at pairing (ADR 002 §7.2's backup file, or a payload field). |
| **`server/`** | E5-5 (the `pairGet` budget cannot fit a polling rendezvous — two Macs in one household are one IP) and E5-7 (`device.attestation` has two spellings on two endpoints). |
| **`src/js/crypto/`** | re-point `ENVELOPE_PARK.ATTESTATION` at `PARK_REASONS.ATTESTATION` and empty `PARK_REASONS_NEEDED`. Values already agree; it is a duplicate constant. |
| **`src/js/storage.js`** | named slots for the key ring, the peer attestations and the sealed outbox. `family/engine.js` uses `localStorage`, which is right in a browser and wrong in a Tauri build. |
| **`store.js`** | **F-5 / R5-5b** (the checkpoint does not pass `applyRemote`'s gate) and **F-2** — the three FINDINGS §3 rows E5 did not close. |
| **docs** | eight ADR / contract amendments, listed in `E5-VERIFICATION.md` §7. |

**E3-1 is unchanged and is still the row that stops a family-mode release.** E5 was told not to
edit `src/js/crypto/` and did not.

---

# Round-8 addendum — 2026-08-29 · THE OP LIFECYCLE, ENUMERATED

M1 was demonstrated; two adversaries then attacked it. **Nothing they found was a confidentiality
break — 21.1 and 21.2 both held.** What they found was worse in a different way: **the engine lost
ops silently and reported `healthy` while doing it.** Four fixers worked in parallel against an
enumerated input domain and one integration pass landed the cross-file work.

## What was closed

| id | severity | what it was |
|---|---|---|
| **E5-2** | CRITICAL | **RE-OPENED and closed twice.** Its own clamp stood down on `cap === null`, which is the state EVERY compaction leaves behind — so `compact ▸ author offline ▸ compact` folded the unacknowledged line for real, with no adversary and no old file. |
| **L-4** | CRITICAL | **NEW.** `oplog.load()` fed each tail line the `seq` its BYTES carry, and a tail line is written before any ack exists. The durable ack rides in `checkpoint().seqs`. An acknowledged op came back looking unacknowledged, the outbox floor sank below the persisted horizon, and E5-2's one unrecoverable arm was reached on any Mac that quits after a compaction. **This is why the 24-seed sweep still lost an op on 2 seeds after E5-2's own fix.** |
| **P-8** | CRITICAL | Every park was a DROP: `pullNow` read `out.parked`, a field `openOp` never sets, so the whole branch was dead code and every held op was quarantined with the cursor released. Fixed as a domain (`PARK_HANDLING`, TOTAL), then given durable retention, then allowed to release the cursor for the two reasons ADR 003 §8.2 requires it. |
| **L-1** | HIGH | **NEW.** A terminal refusal lived in a per-session `Map`: `error` for minutes, `healthy` for ever, with the cursor already past the op. Now rides in `checkpoint().lzp.refusals` — and is WITHDRAWN when the world later falsifies it. |
| **L-2** | HIGH | **NEW.** Nothing could see a held op. `diagnostics().sync` gained `parked`/`refused`/`lost`/`chain`; `sync/status.js` folds over the enumeration; a MISSING field is `unknown` and never `0`. |
| **L-3** | HIGH | **NEW.** The park had no reaper — `unparkAttested()` was called from one place, on the adoption of a NEW peer. Two call sites now: `init()` and `pullNow`. |
| **L-5** | MEDIUM | **NEW, and found by this pass walking into it.** Folding `store.warnings` into `error` lit a fault on every launch that had anything to say — the channel carries repairs, re-joins and successful cures. It reports without raising. |
| **P-4** | HIGH | Seven modules reachable from nothing, three of them defences. Five `sync/` rows closed: four WIRED, one DELETED. |
| **F-8** | MEDIUM | The warnings channel has a consumer. |
| **P-2** (doc half) | — | `server-metadata.md` names the second remote. |

## The headline, at 128 seeds

`tests/fleet/attack-converge-disorder.test.js` §2, alphabet unchanged and un-narrowed:

- **128/128 converge** with `compact` in the alphabet — content, register digests cell by cell,
  stable, nothing lost, nothing extra. `_e52Warned` fires on **no seed**.
- **128/128 with a QUARANTINE event** (a flipped ciphertext byte, so AES-GCM refuses the op and
  the cursor is released past it): **no run ended divergent and `silent`.** Convergence is not the
  right property there — a forged envelope must not be applied — so the property is the one that
  makes the bar meaningful: *either they converge, or the Mac that lost something says so.*

## Is M1 "proved" rather than "demonstrated"?

**For loss: yes, and that is a change of kind.** The demonstration was one scripted run on two
machines. The property is 128 generated interleavings of partition, reorder, duplication,
compaction, restart and quarantine, run against the real store, the real op log, the real
`openOp`, the shipped engine and all 23 server handlers — plus a 253-entry enumeration of the op
lifecycle whose every cell is decided, and fourteen mutants each naming the row that dies.

**For the product: no, and the gaps are named.** They are not about losing ops:

- **E5-6** is unchanged and is still what M1 does not deliver — a paired Mac receives none of the
  pre-space board, categories included.
- **E1 owes `sync_request`** in both shells. The demonstration ran on `fetch` in a browser; the
  shipped app has no family transport at all until that lands.
- **The two-Mac evidence is still fleet-level.** The 128-seed sweep is two real store modules with
  two real disks over the real handlers — it is not two real machines. §7d-2's method makes that a
  much smaller gap than it was, but it is not zero.


---

# Round-9 addendum — 2026-08-29 · **THE ADVERSARY'S VERDICT, CLOSED**

A fresh adversary read round 8's own work and returned one sentence:

> **E6 cannot safely be built on this sync engine as it stands.**

This round closes that. Three fixers worked in parallel; one integration pass landed the
cross-file work, built the two headline checks the verdict set as the bar, and ran the mutation
table. **All six suites are green.**

## The root cause, in one line — and it was already diagnosed, not re-derived

> `pullNow` uses `verifyChain` where it must use `createChainWitness`, and it turned a diagnostic
> into a cursor hold.

Round 8's own closing lesson — *a module is not dead because nothing imports it; it is dead because
nothing NEEDS it* — was applied to the FILE and not to the FUNCTION inside it. Round 8 imported the
leaf, left the mechanism behind, and then compensated for the missing mechanism by giving the leaf
a power ADR 002 §5.4 forbids in one sentence: *"it NEVER BLOCKS SYNC in v2 (a false positive that
broke a family's board would be far worse than the attack)."*

**`createChainWitness` now has a real importer** — `src/js/sync/personal.js:168`, one instance per
engine at `:669`, on the product's only pull path. **The only `verifyChain` CALL anywhere in `src/`
is `chain.js:370`, the witness's own use of its own leaf.** No raw `verifyChain` decides sync
behaviour.

## What was closed

| id | severity | what it was |
|---|---|---|
| **R8-2** | CRITICAL | One legitimate member removal WEDGED THE SPACE, for ever. `POST /members/remove` purges the removed member's op rows (ADR 003 §6.3), which makes every later `chain` unrecomputable by anyone; round 8 held the cursor below that hole on every pull, unconditionally, so every op above it was unreachable across relaunches on an honest relay. The hold now lasts for the pull that DISCOVERS a break and not after — moved behind the witness's re-anchor, **not deleted**. |
| **R8-4** | CRITICAL | The ladder DESTROYED the only copy. `release()` shelves what the caller has just said it cannot open, the shelf is on disk, out of the replay set, and revived by the next launch (bounded, `PARK_REVIVALS = 3`). `terminal()` now calls `refuse()`, which says the transition out loud. **And the refusal is retracted when the revival lands** — a durable ledger that cannot retract is a permanently red indicator. |
| **R8-1** | HIGH | An HONEST relay accused, twice over: the re-serve of a held page read as `seq jumped from 1 to 1`, and a persisted anchor that paired one row's seq with another row's chain. Both were missing pieces of the wrapper. |
| **R8-5** | HIGH | `park()` reported success after a failed write. `pullNow`'s `if (!kept) holds.set(…)` was correct, documented and unreachable. |
| **R8-7** | MEDIUM | The attestation's CLOSED FIELD SET ran on two doors of four, so `POST /devices` and `/devices/adopt` stored a smuggled seventh field and `GET /spaces/:id/members` published it. One rule, four doors — and round 9 also deleted the private twin `spaces.js` had kept, which had **already drifted in one word within a single round**. |
| **R8-7b** | MEDIUM→HIGH (availability) | A `deviceId` could name a key-wrap recipient. Register `rec_mem_MAMA` as a device, then revoke it, and `deleteKeyWrapsForDevices` deletes that member's recovery wraps for every epoch — ADR 002 §7.3's last resort. Two ordinary requests, one current member, no forgery. |
| **R8-6(a)** | MEDIUM | A durably held op was invisible for the whole launch. `attach()` now reads the park and re-emits; the toolbar is push-fed (`family/mount.js:78`), so it lands with no pull, no network and no timer. |
| **R8-8** | MEDIUM | A log quarantine is an enumerated observable now, and `fieldValue()` no longer hard-codes one field — that hard-coded branch WAS the finding. Half closed; the loud half needs `store.js`. |
| **R9-1** | LOW, durable | **NEW, found landing a cross-file item.** `cursor.js advance()` could raise `fromGenesis` and never lower it. It is not a reward for a past pull; it is the RIGHT TO CALL AN UNKNOWN `wit` A FORK, and `chain.js` gives that right up when a break makes it unprovable. A ratchet hands it back at the next launch. |

## The two headline checks — `tests/fleet/round9-headline.test.js`

The adversary set the bar itself: *the detector must not cry wolf on the happy path, and a
legitimate member removal must not wedge anyone.*

**(a) FIRST CONTACT — §1.** A peer's op overtakes its attestation, the relay honestly re-serves the
held page on every poll for the whole of `MAX_DEFERRALS`, and then the ladder ends the hold. Across
all six pulls: no chain finding, nothing written to `store.syncChain`, **not one word to the user**,
and `pending` throughout — never `error`, never `healthy`. Then the attestation lands, the shelf is
revived, the entry arrives and the refusal is withdrawn. Round 8 said the server's record did not
add up from the SECOND pull onwards. A **CONTROL** row drives one rewritten chain value through the
same held state and requires it still to be caught, so "quiet on the happy path" cannot be
satisfied by deleting the detector.

**(b) A MEMBER REMOVAL — §2a and §2b, and it is two rows for a reason worth reading.**
`createPersonalSync` refuses a non-`psp_` space in its first line (story 21.2), and in a personal
space ADR 001 §4 rejects another member's op as `notMyAct` before the witness sees it — measured,
by writing the row the naive way first. **There is no family sync client yet; that is E6.** So the
halves are driven separately and joined **by measurement, not assumption**:

- **§2a — the server half, fully real.** A second member joins through `POST /invites` and
  `POST /invites/redeem`, authors ops interleaved with a survivor's, and is removed through
  `POST /members/remove` — all over `router.js` and `adapters/memory.js`. The row **captures the
  store call `purgeMember` actually makes** by wrapping the transaction handle (a spy on the bare
  store method is never called — the purge and the membership write are one transaction), and
  asserts it is `deleteOpsByDevices(spaceId, [herShorts])`, once.
- **§2b — the client half, fully real.** Three Macs, a two-row page so the log is many pages long,
  and §2a's captured call on the same shipped adapter. **B is OFFLINE throughout, so its cursor is
  below the hole when the purge lands** — the Mac that was shut while the family removed somebody,
  which is the only position where the wedge exists. Both remaining Macs keep the cursor moving,
  reach every entry that still exists, quarantine nothing, and read `healthy` — over several pages
  and across a relaunch. Nobody is told that deleted rows are "still owed".

One thing §2b measures that the naive version would have missed: A and B do **not** end identical,
and that is ADR 002 §7.4 rather than a defect — A had already been served the purged entries and
still holds them (`alreadyDeliveredIsIrrevocable: true`, asserted in §2a). The row asserts the true
property instead: **B is missing nothing, and the only difference is exactly the four purged
entries.**

## Suites

```bash
# CURRENT — re-measured 2026-08-29 at the close of the ROUND-9 integration pass. ALL SIX GREEN.
npm test              # tier 1, pure logic          → 1932 pass / 0 fail
npm run test:attack   # adversarial corpus          →  714 pass / 0 fail
npm run test:property # property harness + domains  →   85 pass / 0 fail   ← 0 UNEXPECTED, 0 STALE
npm run test:server   # the sync server             →  846 pass / 0 fail
npm run test:fleet    # two and three Macs, real handlers → 131 pass / 0 fail
npm run test:dom      # real headless WKWebView     → 26 files, tier 2 PASS
```

`test:server` moved 815 → 846: +32 for `blindness.test.js` §7a/§7b's door enumeration, −1 for the
characterization row that named its own inversion and got it. `test:fleet` moved 103 → 131:
round 8's two adversary files, round 9's headline file, and the rows added around them.

## Mutation testing — eighteen mutants, and one survivor stated rather than hidden

The full table is `FINDINGS.md` **§7a-round9**. The two the brief named by hand:

- **the `fresh` filter is load-bearing, and it lives IN THE WITNESS.** Removing it from `chain.js`
  kills five row groups; adding a duplicate at the `pullNow` call site kills nothing. R8-1 is
  closed by the wrapper, not by a compensating guard.
- **the hold MOVED, and both directions are pinned.** Deleting it reddens the withhold defence;
  making it permanent again reddens the removal rows. A fix that survived only one of those two
  mutants would be the other failure.

**One mutant survived** — `terminal()` calling `release()` instead of `refuse()` — because under
today's flush order the two coincide. It is recorded in §7b-round9 with what was done about it: the
DIFFERENCE was given a row of its own (`round8-park` §6.2b), so the choice is a tested property of
`outbox.js` rather than a preference at the call site.

**Process:** the scratch tree was copied with `tar`, never with `git stash`. Several agents shared
this working tree and two files were observed reverting to `HEAD` mid-session when one of them
stashed. Anyone doing a scratch-tree mutation pass here should copy, not stash.

## One measurement that corrected an earlier row

Over the 128-seed tamper sweep, before and after R8-4's retraction with nothing else changed:

```
before:  quarantined-at-end 14 · durable ledger 17 · DIVERGED 0 · lost 0
after:   quarantined-at-end  0 · durable ledger  0 · DIVERGED 0 · lost 0
```

Every one of those 17 durable refusals was about an op that had in fact ARRIVED. So
`attack-converge-disorder.test.js` §2's second row was overstated — *"a QUARANTINE in the alphabet
costs data"* — and its non-vacuity control was being satisfied by a stale record rather than by a
real loss. It is renamed **CLOSED (R8-4)**, re-based on refusals the run REACHED, and given a new
assertion forbidding the retraction from following anything but the op actually landing.

## What E6 starts on top of, and what it still owes

**Answered:** the witness is a diagnostic again, the hold is where ADR 002 §5.4 put it, a member
removal costs one pull and a sentence, a park is never a drop, and every door that persists a
device row runs one closed-set rule.

**Owed, and all four of the first group are `src/js/store.js`** (FINDINGS §8, *Owed by round 9*):
`syncChain` must ride in the checkpoint (R8-3 — a fork detected before a quit is still forgotten
after it); `sync.parked` must count the engine's held envelopes (R8-6b); `diagnostics().quarantine`
must say what it discarded (R8-8's loud half). Plus **FINDINGS §4.8, which is a DECISION and not an
implementation**: a client cannot re-ask for one seq, so a relay that withholds a row in the middle
of a page and keeps withholding it consumes it on the second poll — loudly, one-sidedly, and
permanently. Closing it needs a bounded re-ask or a seq-range request, and the retry count is a
privacy trade as much as a cadence. `attack-converge-relay.test.js` §6b asserts that loss and must
be inverted the day somebody closes it.

**And E6's own first obligation is written into `round9-headline.test.js` §2b's closing
assertion:** the day the fleet mints a family space, §2a and §2b collapse into one row, and the
seam between them is exactly what E6 closes.

---

# Round-10 addendum — the E6 gate

*2026-08-29. Three fixers, one integration pass. All six suites green (numbers in §2 above).*

## What the round was asked for, and what it returned

Round 10's adversary returned NO-GO for E6 and enumerated a shortest path of nine items, each with a
named mutant. **That path was the whole scope.** All nine are landed, every one is mutation-tested
with the row that dies named (FINDINGS §9b), and the answer is still **NO-GO** — for the reason in
the header, which none of the nine items touches.

The useful part of the round is not the nine items. It is the **three defects that only appeared
when the items were driven end-to-end over the real handlers**, and one correction to the brief:

### The brief's central claim was half right, and the measurement is better than the claim

The brief required proof that wiring the witness value (`wit`) without the durable `fromGenesis`
write is "the false positive the ADR forbids". Building each mutant separately shows there are
**three** parts, not two, and either guard alone is sufficient:

| build | measured |
|---|---|
| the durable write reverted alone | the durable lie IS restored — **but no accusation follows** |
| `spanFromGenesis` reverted alone | no accusation: the disk honestly says `false` |
| **both reverted** | `unknownWitness`, `error`, a verdict written — **against an honest relay** |
| all three (`wit: ''` too) | nothing: no value to misjudge |

`wit` is the *arming* condition for all of it, which is the exact sense in which round 9's build was
"safe" — its detector was dead. This is now a row (`round9-witness.test.js` §3c), not an argument.

### Two defects found by wiring the shelf, not by reading it

- **`lotLoaded`**: handing the shelf in unconditionally made a fresh process report an *empty
  shelf* with `unoffered: []` to prove it had looked — a confident, wrong answer about a Mac with a
  retained envelope on the disk beside it. Worse than not wiring the row at all.
- **R10-9d**: `lot.release()` shelves any oid "parked or touched since its last release", and that
  set is cleared only inside `release()` — so F-6's ordinary story (park, ladder burns, pairing
  completes, op applies) left a **permanent** shelf row saying nothing would ever open bytes whose
  op was on the board. Invisible while nothing read the shelf; a permanent user-visible `error` the
  moment `status()` offered it. Fixed in two places, each with its own row.

## What E6 must do first

1. **Build the family engine.** This is the gate and everything else is behind it. The three rows
   of `round10-e6-gate.test.js` §4 will invert the day it exists.
2. **R10-11** — ADR 003 §4.1's `baselineSeq`/`baselineChain`. It is fully specified and
   unimplemented, and without it every member joining a circle with any removal in its history
   opens on a red light. E6 creates that population by definition.
3. **A PO ruling on R10-2 / §4.8.** Both are blocked on the same thing and neither is an engineer's
   call. Round 10 added the measurement that makes the trade concrete: mutant M-I4 shows what an
   un-clearable verdict costs — three rows in three files go red on a *legitimate* removal.
4. **R10-10** — the relay's membership doors should refuse a non-`fsp_` space. Latent today because
   two other barriers hold; it is the missing third.

## The instrument, and its one blind spot

`tests/helpers/fleet.js` now drives four devices and three members over all 23 real handlers, and
`joinNewMember` performs a genuine invite/redeem. **It can only mint a personal space**, so every
multi-member row measures the CURSOR and the VERDICT and never the BOARD: no content crosses
between members, because a personal space correctly refuses another member's ops (`notMyAct`). That
limitation is the gate itself, and it is asserted rather than assumed — but a reader who wants
family-mode convergence evidence will not find it in this suite, and should not read 168 green rows
as though it were there.
