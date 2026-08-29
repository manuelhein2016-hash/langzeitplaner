# E6 — Familienkreis. Verification of the client flows.

**Date:** 2026-08-29 · **Tickets:** LZP-601…607 (**608 out of scope**) · **Stories:** F15 15.1–15.6,
F20 20.1–20.6 · **PO decision:** D9

**Read `FINDINGS.md` §9 first.** That section already established that the shipped sync engine is a
*personal* engine that refuses an `fsp_` space. This document is what happened when E6's flows were
built on top of that fact and then driven, and its §5 is the part a reader should not skip.

---

## 0. The one-paragraph verdict

**The membership lifecycle is real and was driven end to end against `node server/dev-server.mjs`
with two independent Macs: create → invite → join → both members listed → rename → leave → delete,
every step a real signed HTTP round trip, pasted in §3.** The relay holds no display name and no
circle name, and the invite row carries no key material — D9 is structural, not conventional.
**D9's waiting state is demonstrated in full for its first three required behaviours and its fourth
cannot be demonstrated at all**, because ADR 002 §7.1 steps 4–6 have no implementation anywhere in
the client: nothing fetches a key wrap, nothing produces one for a peer, and the relay has no route
to push one. Mom joins, is immediately a member, and is told calmly that the entries arrive by
themselves — and in this build they never do. That is stated plainly in §5 rather than described as
working. **Solo mode is untouched and measured**: 36 modules, zero family/crypto/sync modules, zero
network requests, DOMContentLoaded 127 ms.

**What integration cost:** three defects found by driving rather than by reading — one of them mine,
introduced during this pass and caught in the browser — plus one control switched **off** because
end-to-end driving showed it destroys the thing it manages.

---

## 1. Suites — measured at the close of the pass

```bash
npm test              # tier 1                    → 1932 pass / 0 fail  (155 suites)
npm run test:attack   # adversarial corpus        →  720 pass / 0 fail  (121 suites)
npm run test:property # property + domains        →   88 pass / 0 fail  ( 18 suites)
npm run test:server   # relay                     →  868 pass / 0 fail
npm run test:fleet    # multi-device scenarios    →  169 pass / 0 fail  ( 60 suites)
npm run test:dom      # tier 2, real WebKit       →   29 files, all pass
```

Zero dependencies, no `node_modules`, no stray root files.

The property suite moved 87 → 88 and the module domain 58 → 62: `createjoin.js`, `membersui.js`,
`adminpanel.js` and `leavedelete.js` became **reachable** the moment `familysettings.js` called
their sections. They sat on disk for a round before that and the walk could not see them — the
import graph is the measurement, and an unmounted module is correctly invisible to it.

The fleet suite moved 155 → 169 during this pass. That is the parallel workflow's, not this one's;
a `sync/status.js` durability row was red mid-session and is green again.

---

## 2. Status by ticket

| ticket | story | verdict | where the evidence is |
|---|---|---|---|
| **LZP-601** create a circle | 15.2, 20.6 | **VERIFIED-HERE** | §3.1 — real `POST /spaces`, epoch-1 wrap to own device only |
| **LZP-602** join a circle | 15.3, D9 | **VERIFIED-HERE** | §3.2, §4 — real redemption; whole-invitation paste; colour collision |
| **LZP-603** member list | 15.4, 15.6, 17.3 | **PARTLY VERIFIED** | §3.3, §6 — the list, the legend and the toggle are real; **names are not**, see E6-1 |
| **LZP-604** invite management | 15.5, 20.1 | **VERIFIED-HERE** | §3.1, §3.6 — mint, open-invite list with expiry, revoke |
| **LZP-605** admin panel | 20.1, 20.5 | **VERIFIED-HERE** | §3.4, §7 — rename real; **transfer switched OFF**, see E6-2 |
| **LZP-606** leave | 20.3 | **VERIFIED-HERE** | §3.5 — real `POST /members/leave`, relay marks `removedAt`, device revoked |
| **LZP-607** delete space | 20.4 | **VERIFIED-HERE** | §3.6 — real delete, space purged from the relay, board intact |
| **LZP-608** removal + rotation | 20.2 | **OUT OF SCOPE** | §8 — the seam is live and named |

"VERIFIED-HERE" means: driven in a real browser against the real relay in this pass, with the
request and the relay's stored bytes both inspected. It does **not** mean the feature is complete
in the product — §5 governs all of it.

---

## 3. The lifecycle, driven

**The rig.** `server/dev-server.mjs --port 8787` (file adapter, 23 of 23 routes wired) and one
`dev-server.mjs --relay http://127.0.0.1:8787` per Mac. The `--relay` proxy is the repository's own
M1 lane: it puts the API on the app's own origin so `connect-src 'self'` is satisfied and the page
under test is byte-for-byte the page that ships. **Two ports are two origins are two
`localStorage` partitions**, so :4181 and :4182 are two genuinely separate Macs with separate
durable identities. Every origin used below was virgin.

### 3.1 Create — Papa, :4181

```
POST /api/v1/spaces   50 ms      POST /api/v1/invites   14 ms
```

Relay state afterwards:

```
spaces  : fsp_nhfN9dwRvOireWklQbKERw   kind=FAMILY   currentEpoch=1
members : mem_qhYHqy0OcfbhLKGI77cn0A   colorRef=blau   removedAt=None
devices : dev_Mzm2OmbyfFRakIVTT2c-3Q   deviceShort=3FXX0D85VCMCN35V
keyWraps: [fsp_…,"1",dev_Mzm2OmbyfFRakIVTT2c-3Q]     ← the creator's OWN device, and only it
invites : {id:47ssOFFOhJjOjEZnJ7vPeQ, verifier:…, wrapSalt:…, epoch:1, expiresAt:…, usedAt:null}
```

Invite code shown: `J17Z-XSXN-7CSQ`.

**Two things the relay does not have.** Grepping the whole store for the human strings:

```
"Papa"          : absent
"Familie Weber" : absent
```

Display names and the circle's name never leave the Mac. And the invite row carries `verifier`,
`wrapSalt`, `epoch` and two timestamps — **no wrapped key of any kind**. That is D9 as a property
of the stored bytes rather than a claim in a comment.

### 3.2 Join — Mama, :4182, with Papa's Mac closed

This is the D9 scenario on purpose: no other member device was running.

```
POST /api/v1/invites/redeem       ← attempt 1, colour collision, rolled back (§4)
POST /api/v1/invites/redeem       ← attempt 2, accepted
```

Mama's `board.json` afterwards:

```
familySpaceId    fsp_nhfN9dwRvOireWklQbKERw
familyRole       member
familyMemberId   mem_7TS5xrb0KDsWouMHWjzHRw
familyDisplayName Mama          familyColorRef gruen
familyKeysPending TRUE                                  ← the waiting state
```

### 3.3 Both members listed

Mama's ⚙ → „Familie" shows **two rows** and the D9 line. Papa's shows the same two, his own marked
`· du · Verwaltung`, the other carrying „Entfernen" — and never his own row, which is „Kreis
verlassen" and which the relay agrees with (`use_leave`).

The rows read `· · —`, not names. See **E6-1**.

### 3.4 Rename — 20.1

```
POST /api/v1/spaces/fsp_…/rename   → 200
board.json familyName: "Familie Weber" → "Familie Weber-Schmidt"
relay store grep "Weber" → 0 matches
```

The panel says „Der Name gehört dem Kreis. Auf dem Server steht er nirgends." The handler stores
nothing, by design. The sentence is literally true. The rename does **not** reach Mama — see E6-1.

### 3.5 Leave — 20.3

```
POST /api/v1/members/leave → 200
```

Relay:

```
mem_qhYHqy0OcfbhLKGI77cn0A  removedAt=None                 ← Papa stays
mem_7TS5xrb0KDsWouMHWjzHRw  removedAt=1788021091053        ← Mama gone
dev_DsZ4OfdDPmuoJoKfLVhl2g  revokedAt=1788021091053        ← her device revoked
```

On her Mac the circle prefs cleared, the legend's family section disappeared, her own entries stayed.
**`syncOrigin` / `syncEnabled` / `personalSpaceId` were deliberately NOT cleared** — that triple is
the *personal* space's (19.4), and clearing it would unpair somebody's second Mac as a side effect
of leaving a family circle. Finding P-1 stays open on purpose and a test asserts it.

### 3.6 Delete — 20.4, on a fresh circle

Created `Testkreis` / `fsp_0YdRa2IsohRGy866cZimvA` on a third virgin Mac (:4183), then deleted it.
The confirmation is gated on typing the circle's **name** and the wire carries the **id**; pressing
„Endgültig löschen" with the gate empty made **no** request and left the sheet open.

After confirming, the relay's space list contains only the Weber circle — the space, its member,
its device and its wrap are gone. The Mac reverted to a fully intact solo board (4 categories, board
renders, family prefs cleared).

---

## 4. The join flow's two designed details, both exercised

**The whole-invitation paste.** A multi-line invitation — prose, a code, a `Server:` line — pasted
into the field yields `J17Z-XSXN-7CSQ` and lifts the origin out, saying so: „Server aus der
Einladung übernommen: http://localhost:4182". **This did not work when the pass began**; see E6-4.

**The colour collision.** Mama kept the preselected `blau`, which Papa holds. A joiner cannot read
the roster before redeeming — `GET /members` requires membership, correctly — so the knowledge comes
from the redemption itself:

```
attempt 1 → the relay refuses on colorRef and ROLLS THE WHOLE REDEMPTION BACK
            invites[0].usedAt = None      ← the code still works
            members on relay = 1          ← nothing half-created
UI          .circle-notice (never .circle-problem):
            „Diese Farbe hat schon jemand im Kreis. Grün ist frei — nimmst du die?"
            blau is now disabled, aria-label „Blau — schon vergeben"
attempt 2 → accepted
```

One round trip, a calm notice naming a free colour, one click to retry.

---

## 5. D9 — the acceptance test for this epic

### 5.1 What is demonstrated

Joined while **no other member device was online**. Machine-checked on the live panel:

| D9 requires | measured |
|---|---|
| **1.** she is immediately a member | `familyMemberId = mem_7TS5xrb0KDsWouMHWjzHRw`, roster shows 2 |
| **2.** one calm line, no spinner on the board | every node's computed `animationName` walked → **none**; `progress`/`.spinner`/`[aria-busy]` → **0**, on the panel and on the board |
| **3.** never an error, never "go wake someone" | `.circle-problem` → 0, `[role=alert]` → 0, no `Fehler\|failed\|erneut versuchen`; no `aufklappen\|frag \|bitte jemand\|ask \|open their\|warte`; the line names **another Mac**, and a person-name regex over it returns false; exactly one button, „Fertig" |
| **4.** it resolves itself | **NOT DEMONSTRABLE — see 5.2** |

The copy, verbatim:

> „Du bist dabei." / „Du gehörst jetzt zum Familienkreis." / **„Die gemeinsamen Einträge erscheinen
> von selbst, sobald ein anderer Mac im Kreis das nächste Mal abgleicht."** / „Bis dahin bleibt dein
> Board genau so, wie es ist. Du musst nichts tun und niemanden fragen."

### 5.2 What is not, and why — **the headline of this document**

**ADR 002 §7.1 steps 4, 5 and 6 have no implementation in the client.** Not "incomplete": absent.

```
client callers of GET  /api/v1/spaces/:id/keys    → NONE
client callers of POST /api/v1/spaces/:id/epoch   → NONE
client code that wraps the ring for a PEER device → NONE
a relay route that pushes a wrap outside space
  creation or epoch rotation                      → DOES NOT EXIST (router.js, 23 routes)
sync/personal.js imports from crypto/spacekeys.js → { spaceKindOf, isSpaceId }   ← no wraps at all
```

And underneath that, the engine is not a family engine:

```js
// src/js/family/engine.js — readFamilyConfig
if (!s[enabled] || !origin || !space.startsWith('psp_')) return null;
```

```js
// src/js/sync/personal.js:435 — assertPersonalSpace
// "A psp_… id is required and an fsp_… id is a THROW, not a fallback: a personal sync engine
//  pointed at a family space would push the user's private board into the family stream, which
//  is the single worst thing this product could do."
```

That refusal is correct and must stay. Its consequence is that **a Familienkreis arms no engine at
all**. Measured: Mama's Mac, a full member, made **zero** `/ops` requests in 8 s of idling after
joining, and makes none on any subsequent launch.

**So the waiting state can be entered and cannot be left.** Mom is a member, her board is calm, the
sentence she is shown is true about what is *supposed* to happen, and in this build no member Mac
will ever wrap the keys because nothing anywhere is written to do it. This is not a bug in the E6
flows — every one of them does what it was asked to do — and it is not the D9 copy's fault. It is
that E6 built the membership half of the feature and the content half does not exist yet.

`FINDINGS.md` §9 reached the same wall from the other side ("E6's convergence question cannot be
asked of this build"). This is the client-side statement of it.

**What has to land before D9 part 4 can be shown:** a family sync path (or a family-aware
`readFamilyConfig`), a `GET /spaces/:id/keys` caller feeding `admitWraps`, a producer that wraps
epochs `1..e` for a new member's device, and a route to push it. None is a small change and none is
this ticket's.

---

## 6. Principle 7 and 15.1 — solo mode, measured

A **virgin origin**, `dev-server.mjs` with no `--relay` at all:

| | first run | after clicking ⚙ |
|---|---|---|
| DOMContentLoaded | **127 ms** | — |
| JS modules | **36** | 62 (+26) |
| modules from `family/`, `crypto/`, `sync/`, `platform/net.js` | **0** | 24 |
| network requests | **0** | **0** |
| family UI on the board | none — no `#legend-family`, no chips | — |
| family sections in ⚙ | — | „Familienkreis" (the entry point) + 19.4's own |

Opening the door loads the modules and **still makes no request and mints no identity**. The member
section, the admin section and the legend section draw nothing at all without a circle.

Guards, run by name: `tests/attack/privacy-e5-silence.test.js` 13/13,
`tests/property/sync-domains.test.js` + `tests/tier1/network-scope.test.js` 33/33.

**A bug this pass introduced and caught here.** Mounting the members port unconditionally made
„Familie" — a heading and a member row — render in the settings sheet of a Mac that had never heard
of a Familienkreis. `buildMembersSection`'s own guard could not catch it: it asks whether a *port*
exists, not whether a *circle* does. Fixed in `mount.js#syncCircleMounts`, which now mounts and
**unmounts** on every sheet open, because a Mac becomes a member mid-session (the join flow) and
stops being one mid-session (20.3). Verified in the browser after the fix: solo ⚙ shows the entry
point and nothing else.

---

## 7. 20.5 — swept, not eyeballed

Every leaf string of `ADMIN_COPY`, `LIFECYCLE_COPY`, `MEMBERS_COPY` and every `circle*` / `family*`
key of `i18n.js`, in **both** languages — **338 strings** — against patterns that would claim an
admin can see another member's private entries, discounting sentences carrying a negation:

```
✓ no shipped string claims an admin can see another member's private entries
  strings that positively STATE the guarantee: 4  (2 per language)
```

> „Auch als Verwalter siehst du die privaten Einträge der anderen nicht und liest die Inhalte ihrer
> Belegt-Einträge nicht. **Das verhindert die Verschlüsselung, keine Regel.**"
>
> "Even as admin you do not see other members' private entries and you do not read the contents of
> their Belegt entries. **Encryption prevents that, not a rule.**"

Both sit directly under the member list — the exact place the assumption would form. The structural
claim is backed by §3.1: the relay stores no display name, and the only member fact it holds in the
clear is a palette reference.

---

## 8. Findings this pass produced

### E6-1 — `member.set` and `space.set` have no client mutation, so a circle has no shared vocabulary

`core/ops.js` has the op **constructors** (`memberSet` at :651, `spaceSet` at :653) and the
`MUTATIONS` table is documented as "every v1 `store.mutate()` site, mapped — all 22 sites", with
`tests/tier1/core-ops.test.js` enumerating them independently. There is no `member.set` mutation and
no `space.set` mutation, and no family publish path.

Observed consequences, all of them user-visible:

- **15.4 degrades to colour-only.** Every member row on both Macs reads „Name noch nicht
  angekommen". Not just the peer's name — *my own* name is not in the log either, because writing it
  is the same missing mutation. Names live in `board.json` prefs and never enter the op stream.
- **15.6's write half does not exist.** `membersui.js` disables both fields and says so rather than
  pretending to save. That is the honest rendering and it is what ships.
- **The rename is per-Mac.** Papa's circle is „Familie Weber-Schmidt"; Mama's reads „—".
- **Copy reads badly as a result**: „Verwalter-Rolle an *Name noch nicht angekommen* übergeben?",
  and Mama's leave confirmation titles itself „*diesem Kreis*" because she never learned the name.

Owner: `core/ops.js` + a family publish path. Until then the flows are honest and thin.

### E6-2 — handing over the admin role is a ONE-WAY DEMOTION, and the control is now off

Driven across two real Macs. `POST /members/transfer` answers, by design:

```json
{ "authoritative": false, "stored": "nothing",
  "recordedIn": "the encrypted op log (ADR 001 §4.1)", "rotateRequired": false }
```

The relay has no role column and cannot have one. The authoritative record is a
`space.set{admin, adminPrev}` op — which is E6-1's missing mutation. Measured end state:

```
Papa  familyRole: admin → member      (he demoted himself, locally)
Mama  familyRole: member              (never promoted; her panel has no admin section)
⇒ the circle has NO ADMIN on any Mac, and no route back: promoting anyone needs the seat
  that just disappeared.
```

A button whose only possible effect is to destroy the seat it manages is worse than an absent one,
so it is **disabled with its reason** — `adminpanel.js#TRANSFER_PROPAGATES = false`, one named
constant, and `ADMIN_COPY.transferBlocked` in both languages:

> „Die Verwalter-Rolle lässt sich noch nicht übergeben: der Wechsel würde diesen Mac zum Mitglied
> machen, ohne beim anderen anzukommen — der Kreis bliebe ohne Verwaltung zurück."

`tests/tier2/family-admin.dom.js` §7 was **inverted** to assert the disabled surface, and a second
test now guards the confirmation sentence at the `consequencesOf()` level so the copy cannot rot
while the button is off. Re-enabling is that one constant plus that one test.

### E6-3 — leaving a circle bricks that Mac's family mode on that relay

After Mama left, creating **or** joining anything on that relay is refused:

```
POST /spaces → 400 {"error":"bad_request","field":"device.deviceId","reason":"registered"}
```

Her device row survives the leave — revoked, not deleted — and `deviceId` uniqueness is global. This
is server finding **E2-203-1** met from a second direction: the reported case was a `deviceShort`
collision with a *personal* space; this is a `deviceId` collision with the joiner's own *past*
membership. The fix is the server's — scope device uniqueness to `(spaceId, deviceId)` — and it is
in `server/`, another owner's this round.

Two client-side repairs made here, because a 400 nobody can act on is not an acceptable surface:
`relayError` now classifies **both** spellings (`/device(Id|Short)$/`), and
`circleErrDeviceRegistered` was rewritten to name both causes honestly rather than only the
personal-space one it used to assert.

### E6-4 — the huge paste field defeated its own parser (introduced before this pass, fixed here)

`parseInvitePaste` is correct as a pure function and its tier-2 rows pass. The field it sits behind
is an `<input type="text">`, and an `<input>` **strips** newlines rather than turning them into
spaces (HTML's value-sanitization algorithm). So the one gesture the join screen is designed
around — select the whole invitation mail, paste — arrived as
`…diesen Code ein:J17Z-XSXN-7CSQServer: http://…`, with the code welded to the next word:

```
A. with newlines      → {"code":"J17Z-XSXN-7CSQ","origin":"http://localhost:4182","found":"code"}
B. after <input>      → {"code":"",              "origin":"http://localhost:4182","found":"none"}
```

The function was right and the plumbing was wrong. Fixed at the `paste` event, where the original
string still exists on `clipboardData`; `input` is unchanged for typing, where there are no newlines
to lose. **The test exercised the pure function, which passes either way** — this is the seam a
tier-2 row cannot see and a browser can.

### E6-5 — „Familie" collides with itself in the legend

v1 ships a default **category** called „Familie", so the DE legend reads
`… Familie · | Familie ⬤⬤⬤`, and the settings sheet carries a „Familie" section beside it. Visible
in every screenshot of a circle. Not fixed here — it is a PO/design call: rename the default
category, or drop the section label and let the divider carry A3's two halves (which would also save
~48 px). Reported, not decided.

### Closed by this pass

- **The section-title collision.** `familysettings.js` titled the 19.4 personal-sync opt-in
  „Familienkreis", which is now the real F15 section's name. Renamed to „Server & eigene Geräte" /
  "Server & my own devices" — that section is the relay address plus this Mac's own `psp_` space, and
  two identical headings in one sheet is not a duplication but a wrong answer. The one remaining
  Sie-form in `i18n.js` („Ihr Board", against 42 du-form strings) was in that same block and is now
  „dein Board".
- **The duplicated transport.** `adminpanel.js`'s `arm` port was a marked three-line copy of
  `createjoin.js`'s private `armForRelay`. That file now exports `circleTransport(origin)` and the
  copy is deleted, along with four now-dead imports.
- **The legend never mounted at boot.** `armFamilyMode()` gates on `syncEnabled && personalSpaceId`
  — story 19.4's *personal* space — so a Mac in a Familienkreis with no own-device sync drew no
  member chips until somebody happened to open ⚙. `main.js#mountCircleIfMember` is the second gate,
  on `familySpaceId` alone; it arms no engine and its one request is a roster GET.

---

## 9. Finding R14 — the legend at 2 and 8 members

Measured in the shipping WebKit by `tests/tier2/family-members.dom.js` §5, re-run this pass:

```
R14: the family section is 186 px at 8 members
R14: the same eight as NAME chips would be 380 px      ← the rejected alternative
R14: the family section is  66 px at 2 members
toolbar height at 2 and at 8: 40 px, unchanged
```

**The vertical cost of the chosen layout is zero px.** R14 prices a second toolbar row at ~22 px;
initial chips buy the eight-member case inside the existing 40 px row for 186 px of horizontal
budget, less than half what name chips would take. Below the fit threshold the section collapses to
a disclosure — reached by **measurement** (`scrollWidth > clientWidth`), not a guessed breakpoint,
because what causes the overflow is the member count times the length of *user-authored* category
names in whichever language is on.

**What it costs:** the legend no longer names the members; the name is in the tooltip, in ⚙ →
„Familie", and one click away in the popover. That is defensible because 17.2 renders a foreign
entry as colour + **initial chip** and never as a name, so the legend teaches exactly the mapping
the board uses. In this build the chips render `·` rather than initials — E6-1, not R14.

---

## 10. What LZP-608 still needs

608 is removal end to end, i.e. the epoch rotation ADR 002 §4.1 requires once a member is gone. Its
seam is live and named and nothing in E6 changes when it lands:

1. **The caller exists.** `adminpanel.js#removeMember()` passes the relay's whole body —
   `rotateRequired: true` included — to `ports.afterRemove`, and warns to the console when nothing is
   wired. 608 implements `afterRemove`.
2. **The producer does not.** Rotation needs `crypto/spacekeys.js`'s rotation body builder to have a
   caller and `POST /spaces/:id/epoch` to have a client. Today neither exists (§5.2) — so 608 is
   blocked by the *same* missing wrap machinery D9 part 4 is blocked by, and whoever builds one
   should build both.
3. **The copy is already written to be true without it.** The removal consequence claims exactly
   what the server does — access ends, ops purged, wraps deleted, the member's invites revoked — and
   says nothing about future ciphertext, because without the rotation that claim would be false. It
   carries the addendum §6 line in both languages: „Geteiltes lässt sich zurücknehmen, Gesehenes
   nicht."
4. **E6-3 will bite it.** A removed member who is later re-invited hits the same
   `device.deviceId/registered` wall. 608 should not land before the uniqueness scope is fixed.

---

## 11. Still owed, by owner

**`core/ops.js` + a family publish path** (blocks 15.4's names, 15.6's write, 20.1's rename and
transfer): a `member.set` mutation and a `space.set` mutation. See E6-1 and E6-2.

**`sync/` + `family/engine.js`**: a family space arms no engine (§5.2). Until then no family content
moves and D9 cannot resolve.

**`server/`**: scope device uniqueness to the space (E6-3). Until then leaving is one-way and a Mac
with a personal space cannot join a circle.

**`syncstatus.js`**: render `familyWaitingState()` as the board's one calm line while `pending` — as
the **pending** state, never `error` (19.3). The function is exported and unused.

**`legend.js`**: a `setFamilyLegend(fn)` seam, the shape `settings.js` already has for
`setFamilySections`. `membersui.js` currently bridges `renderLegend()`'s `textContent = ''` with a
MutationObserver; the observer should be deleted the day the seam lands.

**`store.js`**: `hiddenMembers` is written and not read — `materialize()` accepts `ctx.hiddenMembers`
and `store._project()` does not pass one, so 17.3's toggle changes the legend and not yet the board.
`hiddenMemberIds()` is exported for whoever wires it.

**`storage.js`**: `langzeitplaner.ring.<spaceId>` wants a named slot so a Tauri build writes it
beside `board.json` rather than into the WebView's storage.

**PO / design**: E6-5 (the „Familie" collision), and open question 4 (invite transport — no
`langzeitplaner://` scheme was invented; the field reads plain text carrying an address and a code,
which is what deliverable 28's mail can carry today).

**Convention, unresolved deliberately**: LZP-601/602 put its strings in `i18n.js`; LZP-603/605 used
frozen `{de,en}` COPY objects in the module, citing `crypto/backup.js`'s precedent and Principle 7.
Both ship and both are complete in both languages. Churning 338 strings across three green test
files during an integration pass buys nothing a reader can see, so it is reported rather than done.
`i18n.js` is already `live` in the module domain and adding keys to it adds no module.
