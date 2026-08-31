# E6 — Familienkreis. Verification of the client flows, and of a circle that actually shares.

**Date:** 2026-08-29, **re-run and extended 2026-08-31 by the integration pass** ·
**Tickets:** LZP-601…**608** · **Stories:** F15 15.1–15.6, F17 17.1–17.3, F20 20.1–20.6 ·
**PO decision:** D9

**Read `FINDINGS.md` §9 and §10 first, then §11.** §9 and §10 established that E6 had built the
*membership* half of the feature and that the *content* half did not exist: the shipped engine was a
personal engine that refused an `fsp_` space, and ADR 002 §7.1 steps 4–6 had no client
implementation at all. §11 is what happened when that gap was closed and three real Macs were put in
one circle.

---

## 0. The one-paragraph verdict

**A Familienkreis now shares.** Three browser contexts against `node server/dev-server.mjs` —
Papa, Mama and Oma, three origins, three storage partitions, three durable identities — were driven
through create → invite → join → **D9's waiting state clearing by itself** → a shared entry arriving
on two other boards → a joiner receiving three years of history → a name change propagating →
**LZP-608's removal with its epoch rotation** → and the removed member's board left byte-for-byte
intact. Every step is pasted in §3. **The relay's stored bytes contain no display name, no circle
name, no entry text and no date**, proved by an *armed* search that decodes all 553 base64url tokens
in the file and is shown to find a planted needle in the same bytes (§4).

**D9 part 4 — the acceptance test for this whole epic, and the one thing the flow pass could not
show — is demonstrated.** `familyKeysPending: true → false`, all epochs admitted, six parked
envelopes re-judged and applied in the same pass, and the only thing called on either Mac was
`cadence.wake()`, the scheduler's own entry point. No button, no notification, nothing in anybody's
UI (§3.4).

**Four defects were found by driving that a green suite could not see**, every one of which silenced
the entire circle while looking like normal operation — because each fails by *parking* or
*declining*, which is the shape this product is designed to have. They are §5, and each now has a
row that dies without its fix (`tests/tier1/sync-family.test.js` §7).

**Solo mode is untouched and measured, after the change**: 38 modules, **zero** from
`family/`/`crypto/`/`sync/`/`net.js`, **zero** network requests, no IndexedDB, DOMContentLoaded
170 ms, first run unchanged (§6).

---

## 1. Suites — measured at the close of the integration pass

```bash
npm test              # tier 1                    → 2008 pass / 0 fail
npm run test:attack   # adversarial corpus        →  769 pass / 0 fail
npm run test:property # property + domains        →  101 pass / 0 fail
npm run test:server   # relay                     →  868 pass / 0 fail
npm run test:fleet    # multi-device scenarios    →  193 pass / 0 fail
npm run test:dom      # tier 2, real WebKit       →   32 files, all pass
```

Zero dependencies, no `node_modules`, no stray root files. `no-reconstruction.test.js` and
`headless-shell.test.js` untouched.

Two rows that had been red at the head of this branch are **closed, not silenced**:

- `tests/property/sync-domains.test.js` **S5** reported `src/js/core/project.js` as an unreachable
  `defence` (`openFinding: P-4`). It is now reachable, and the door it came through is
  `sync/family.js#sealLine`, which passes `assertFamilyPatch` as `ctx.assertFamilyPatch` (ADR 004
  §2.2 barrier 2) alongside `store.familyLevelOf` as `ctx.levelOf` (barrier 4). The row keeps
  `role: 'defence'` and loses its `openFinding`: the two fields answer different questions, and
  "would deleting this file make the product worse while turning the row green?" is permanently yes
  for a choke point.
- `tests/attack/privacy-e5-silence.test.js` **§5** reported the same file as a new orphan, and its
  §3 row pinned `main.js`'s arming gate as one literal line. The gate grew a third field
  (`familySpaceId`) and the row is now asserted by **shape** — see §5.2.

## 2. Status by ticket

| ticket | story | verdict | where the evidence is |
|---|---|---|---|
| **LZP-601** create a circle | 15.2, 20.6 | **VERIFIED-HERE** | §3.1 — real `POST /spaces`, and the three ops the create path now authors into the log |
| **LZP-602** join a circle | 15.3, D9 | **VERIFIED-HERE** | §3.3, §3.5 — two real redemptions, colour collision, whole-invitation paste |
| **LZP-603** member list | 15.4, 15.6, 17.2, 17.3 | **VERIFIED-HERE** | §3.4, §3.6 — names, colours, initial chips, and hiding a member removes his entries from the **board** |
| **LZP-604** invite management | 15.5, 20.1 | **VERIFIED-HERE** | §3.1, §3.5 — mint, open-invite list with expiry, revoke; plus finding E6-8 |
| **LZP-605** admin panel | 20.1, 20.5 | **VERIFIED-HERE** | §3.6 — rename **propagates**; transfer is **ON** (E6-2 closed) |
| **LZP-606** leave | 20.3 | **VERIFIED-HERE (2026-08-29)** | §3.5 of the previous pass — unchanged by this one |
| **LZP-607** delete space | 20.4 | **VERIFIED-HERE (2026-08-29)** | §3.6 of the previous pass — unchanged by this one |
| **LZP-608** removal + rotation | 20.2 | **VERIFIED-HERE** | §3.7 — three Macs; epoch 5 → 6; her entries leave every board; **her own board is byte-identical** |

"VERIFIED-HERE" means: driven in a real browser against the real relay, with the request and the
relay's stored bytes both inspected. Two rows carry the earlier pass's date because this pass did
not re-drive them and nothing it changed touches them.

**What is NOT claimed.** The board *renderer* for a foreign entry is E7's (`board.js`, `layout.js`,
`popover.js`); it works and is shown in §3.6, but it is not this pass's to verify. And the
`geteilt` gesture itself is driven through `family/sharing.js#planVisibilityChange` + `store.txn`,
which is the exact pair `popover.js#applyLevel` calls — not through a synthetic write.

## 3. THE DEMONSTRATION — a real circle, three members, three browser contexts

**The rig.** `node server/dev-server.mjs --port 8787` (file adapter, 23 of 23 routes wired) and one
`dev-server.mjs --relay http://127.0.0.1:8787` per Mac, on ports 4201/4202/4203. The `--relay` proxy
is the repository's own M1 lane: it puts the API on the app's own origin so `connect-src 'self'` is
satisfied and the page under test is byte-for-byte the page that ships. **Three ports are three
origins are three `localStorage` partitions**, so these are three genuinely separate Macs with
separate durable identities and separate key stores. Every origin was virgin.

Everything below is pasted from the live pages.

### 3.1 Papa creates the circle — and the create path now writes to the LOG, not only the relay

Papa first gives his board history, including the entry risk R11 is about: **a yearly repeat
anchored 2023-11-14**, entered three years before the circle exists.

```
notes: [ {date: 2023-11-14, text: "Omas Geburtstag",     rep: true},
         {date: 2026-10-03, text: "Papas Zahnarzt",      rep: false},
         {date: 2026-10-09, text: "Bewerbungsgespraech", rep: false} ]   ← stays PRIVAT throughout
```

Then „Familienkreis erstellen", through the real screen:

```
spaceId : fsp_9rlVQSl2o_-qz1-c7WK8Sg
code    : GKDA-GVNV-WE08
role    : admin
```

**And this is the part that did not exist before.** `createjoin.js#adoptCircleIntoLog` now runs
after the relay accepts, and the family outbox reads:

```
space.set   space:fsp_9rlVQSl2o_-qz1-c7WK8Sg   admin, adminPrev   ← ADR 001 §4.1 GENESIS LINK
member.set  member:mem_AxY0fulJRg51xLFbJjSgTA  dev.X7STW1QNHTCB62B7  ← ADR 001 §4.0 attestation
member.set  member:mem_AxY0fulJRg51xLFbJjSgTA  displayName, colorRef ← story 15.6
```

```
store.familyAdmin() → { admin: mem_AxY0fulJRg51xLFbJjSgTA,
                        headOpId: ue3HWk_nmAuoVz6707WvuQ, isMe: true }
```

Without the genesis link `adminAtIn` answers `null` for every stamp, so on a circle created by the
previous build **20.1's rename and 20.2's removal were inadmissible from everybody, the creator
included.** That is now a real chain root with a real head opId, which is what `transferAdmin`'s
`adminPrev` names and what `removal.js` stopped reporting as `NO_ADMIN_CHAIN`.

### 3.2 Papa shares two entries, renames the circle, and pushes

`family/sharing.js#planVisibilityChange` through `store.txn` — the same pair `popover.js#applyLevel`
calls. The projection `core/project.js#projectForFamily` produces:

```
pub.set  fnote:mem_AxY0fulJRg51xLFbJjSgTA/71ec9213-…
         pub.level=geteilt  pub.alive=true  pub.date=2026-10-03
         pub.repeatsYearly=false  pub.coEdit=false  pub.text=Papas Zahnarzt  _born=…
```

**`categoryId` is absent** — A3, and it is absent because the projection is an allowlist, not
because anyone remembered to strip it. Then:

```
syncNow() → { pushed: 3, applied: 3 }   opsPushed 6   quarantined 0   outbox 0
space register `name` → "Familie Weber-Schmidt"
levels → Omas Geburtstag: geteilt · Papas Zahnarzt: geteilt · Bewerbungsgespraech: PRIVAT
```

`applied: 3` is Papa's own ops coming **back** from the relay and being admitted through
`applyRemote → foldAuthorized` — including his own attestation op. Nothing is quarantined, nothing
deferred: the fold can verify him, which is finding E6-7 (§5.1) closed.

### 3.3 Mama joins — the colour collision, then D9's waiting state

She picks `blau`, which Papa holds. The relay refuses **inside the transaction** and rolls the whole
redemption back, so the code still works:

```
.circle-notice (never .circle-problem):
  „Diese Farbe hat schon jemand im Kreis. Grün ist frei — nimmst du die?"
```

One more click, and she is in:

> „Du bist dabei." / „Du gehörst jetzt zum Familienkreis." / „2 Mitglieder. Die Namen erscheinen
> zusammen mit den Einträgen." / **„Die gemeinsamen Einträge erscheinen von selbst, sobald ein
> anderer Mac im Kreis das nächste Mal abgleicht."** / „Bis dahin bleibt dein Board genau so, wie es
> ist. Du musst nichts tun und niemanden fragen."

```
familyKeysPending : TRUE            ← the waiting state, entered
D9 machine-checks on the live panel:
  animated nodes 0 · progress/.spinner/[aria-busy] 0 · .circle-problem 0 · [role=alert] 0
  buttons: exactly one — „Fertig"
```

### 3.4 **D9 PART 4 — the waiting state clears BY ITSELF.** The acceptance test for the epic.

Mama's Mac, after her own first sync and **before** Papa has delivered anything:

```
keysPending      : true
epochs held      : []          ← she can open nothing
heldEnvelopes    : 6           ← Papa's six ops are ON HER DISK, parked on `epoch`
quarantined      : []          ← and NOT destroyed (finding E6-9, §5.3)
opsHeldForKey    : 2           ← her own two ops wait in the outbox rather than being lost
familyOutbox     : member.set dev.5B6R1N5QA732HZFE · member.set displayName,colorRef
```

Papa's Mac. **The only thing called is `cadence.wake()` — the scheduler's own entry point, the one
the `pullVisibleMs` timer and the `visibilitychange` listener call. Nothing in any UI, nothing a
person can press:**

```
PAPA — cadence.wake()
  before : epochs [1,2]     rotations 1  deliveries 1
  after  : epochs [1,2,3]   rotations 2  deliveries 2  lastDelivery "delivered"
  coverage proof @ epoch 3 : [ dev_QYN_G4I1_gnZIs4PKF9wkQ, dev_l7PngJfc0RHBZYZdJ0G4vA ]
                             ↑ Papa's own device        ↑ Mama's, which did not exist at his launch
```

Mama's Mac. **Again only `cadence.wake()`, and she was told nothing by anyone:**

```
MAMA — cadence.wake(), nothing else
  keysPending      true  →  FALSE          ← D9 part 4
  epochs held      []    →  [1, 2, 3]      ← ALL epochs, so history from genesis is readable
  heldEnvelopes    6     →  0              ← re-judged and applied IN THE SAME PASS
  opsApplied       6 · quarantined 0 · deferred 0
  board            Omas Geburtstag (2023-11-14, yearly, foreign)
                   Papas Zahnarzt  (2026-10-03, foreign)
                   Mamas Yoga      (2026-09-21, her own)
  circle name from the LOG : "Familie Weber-Schmidt"      ← 20.1 propagated
  names she knows          : Mama, Papa                   ← 15.6, E6-1 closed
  admin seat               : mem_AxY0fulJ… , isMe: false  ← E6-2's precondition
```

**„Bewerbungsgespraech" is not on her board and never was.** Papa's Privat entry produced no family
op at all — not a redacted one, none (16.1, §7).

That is the whole of D9: she was immediately a member, her board stayed calm, the sentence she was
shown was true, and it came true without her, without Papa, and without anybody being told to do
anything.

### 3.5 Oma joins a circle that ALREADY has history — risk R11 / A4 / 17.1

Papa's app stays **open** while she joins, which is the case the previous build got wrong (§5.2).

```
OMA — joined third; cadence.wake() and nothing else
  keysPending   true  →  FALSE
  epochs held   []    →  [1, 2, 3, 4]        ← every epoch, including three she was not alive for
  held 0 · quarantined 0 · deferred 0 · opsApplied 8
  board:
     Omas Geburtstag   2023-11-14  yearly  foreign   ← ENTERED THREE YEARS AGO. It renders.
     Papas Zahnarzt    2026-10-03          foreign
     Omas Chor         2026-12-06          her own
  circle name   : "Familie Weber-Schmidt"
  names she knows: Oma, Papa, Mama
  admin         : mem_AxY0fulJ…
```

On her board, pinned to Oktober 2026, the renderer draws „Papas Za…" on 03 Okt and **„● Omas G…" on
14 November 2026** — the 2023 anchor, projected forward as a yearly repeat, in Papa's member colour.
The legend reads `M P · 2`, with `title="Mama ausblenden"` and `title="Papa ausblenden"`.

### 3.6 15.6 propagates both ways, and 17.3 hides on the BOARD

Papa's Mac, after one `syncNow()`:

```
names Papa knows : [ {name: Papa, colour: blau}, {name: Mama, colour: gruen} ]
deferred         : []                    ← nothing parked on P1 (§5.2 closed)
admin panel      : „P Papa · Verwalter · du" / „M Mama · Mitglied · Entfernen"
                                             / „O Oma · Mitglied · Entfernen"
```

17.3, on Mama's Mac, through `membersui.js#setMemberHidden`:

```
board before hiding Papa : [ Papas Zahnarzt, Mamas Yoga ]
board while Papa hidden  : [ Mamas Yoga ]              ← the BOARD, not just the legend
hidden map after hiding a SECOND member:
   { mem_d8Som4yB…: true, mem_ZZZZ…: true }            ← BOTH survive — finding E6-6 closed
board after un-hiding    : [ Papas Zahnarzt, Mamas Yoga ]
```

The second line is the whole of E6-6: `setSettings` is v1's wholesale object replacement, so the
one-key literal this used to pass **un-hid the first member every time a second was hidden**.

### 3.7 LZP-608 — removal, end to end, on three Macs

Papa presses „Entfernen" on Oma's row. The confirmation, verbatim:

> „Die geteilten und die Belegt-Einträge von Oma verschwinden von allen Familien-Boards und der
> Zugang zum Kreis endet sofort — die privaten Einträge auf dem eigenen Mac bleiben unberührt, denn
> sie waren nie bei uns."
> „Was ihr Mac schon geladen hat, bleibt auf ihrem Mac. **Geteiltes lässt sich zurücknehmen,
> Gesehenes nicht.**"

**Papa's Mac:**

```
epochs   [1,2,3,4,5]  →  [1,2,3,4,5,6]        ← ADR 002 §4.1's rotation, performed BEFORE the op
board    Omas Chor  →  GONE
member:mem_xePEnVMI…  _alive: false, displayName still "Oma"
         ↑ nothing was deleted. It stopped being PROJECTED.
quarantined 0 · deferred 0
```

**Mama's Mac — `cadence.wake()` only; she was told nothing:**

```
epochs   [1,2,3,4,5]  →  [1,2,3,4,5,6]        ← she admitted e+1 before the pull
board    Omas Chor  →  GONE ;  Papas Zahnarzt and Mamas Yoga untouched
legend   chips: [ "Papa ausblenden" ]          ← Oma's chip is gone
member:mem_xePEnVMI…  still present, _alive false, name still "Oma"
```

**Oma's Mac — the promise that matters most, after her own tick against a relay that now refuses
her:**

```
board before : [ Omas Chor, Omas Geburtstag, Papas Zahnarzt ]
board after  : [ Omas Chor, Omas Geburtstag, Papas Zahnarzt ]
boardIdentical         : true
WHOLE store.state deep-equal to the pre-removal snapshot : TRUE
  (and the snapshot was non-empty: 3 notes, 4 categories, 22 settings keys)
epochs before [1,2,3,4] · after [1,2,3,4] · keptEveryEpochKey TRUE
   ↑ she keeps every key she HELD and gains neither 5 nor 6 — she can read what she was given
     and nothing sealed after she left
relay now answers : 403 device_revoked
nothing deleted   : 3 notes, 4 categories
```

The copy is literally true in both directions, which is the point of the sentence.

## 4. The relay's stored bytes — 21.1 / 20.5, grepped, with the search ARMED

The whole file after the run above: `/tmp/lzp-e6-relay/sync-store.json`, **31 554 bytes**, one
space, three members, three devices, twelve ops, six epochs.

```
                     raw file      after decoding ALL 553 base64url tokens
"Papa"                    0                        0
"Mama"                    0                        0
"Oma"                     0                        0
"Familie Weber"           0                        0
"Weber-Schmidt"           0                        0
"Zahnarzt"                0                        0
"Geburtstag"              0                        0
"Chor"  "Yoga"  "Bewerbung"   0  0  0              0  0  0
"2023-11-14"  "2026-10-03"  "2026-12-06"  "2026-09-21"   0 0 0 0
```

**The search is armed**: the same method, run over the same bytes with one needle planted, finds it
(`SEARCH_IS_ARMED: true`). 16 199 bytes of decoded payload were searched as well as the 31 554 raw
ones, so nothing is hiding inside the base64url device-attestation blob either.

What the relay **does** hold is exactly what ADR 003 §5.1 permits and nothing more:

```
space   : id, kind FAMILY, currentEpoch 6, nextSeq, headChain, createdAt          ← NO NAME
member  : id, spaceId, colorRef ("blau"/"gruen"/"orange"), recoveryPubSig,
          recoveryPubKex, joinedAt, removedAt                                     ← NO DISPLAY NAME
device  : id, deviceShort, sigPubRaw, kexPubRaw, attestation blob, seqs,
          addedAt, revokedAt
op      : spaceId, seq, opId, epoch, deviceShort, witness, chain, envelope,
          receivedAt                                                              ← NINE FIELDS
```

The only member fact in the clear is a **palette reference**. Oma's row carries `removedAt` and her
device row carries `revokedAt`; neither says who she is.

---

## 5. The four defects this pass found — every one of them silenced the whole circle

None was visible to a green suite, and the reason is structural: **each fails by parking or by
declining, which is the shape this product is designed to have.** The ops arrive, they are held, the
board is empty, and nothing anywhere is in an error state. That is the correct failure mode and
exactly why it needs a test that names the cure. All four now have one —
`tests/tier1/sync-family.test.js` §7 — and each row was killed by a mutant (§5.5).

### 5.1 E6-7 — **nothing in the product could verify anybody's attestation.** (HIGH)

`core/authz.js` stage 0a checks a peer's `member.set{dev.<short>}` with
`ctx.attestOpen(memberId, blob)`. Without one, `attestationVerifies` returns **`false` for every
blob** — fail-closed, correctly. `store.useIdentity({attestOpen})` accepts one and **no caller
anywhere in `src/js/` ever passed one.**

So every peer's attestation op was rejected `badAttestation`, and — because that op is the only
thing that could ever attest that device — every *subsequent* op from that peer parked
`unattestedDevice`, permanently, curable by nothing. **A circle could not admit a single op from
anybody.** It is finding E6-1 read from its far side, and it survived a whole round because both
halves are silent.

**Fix, in two parts.** `store.setAttestOpen(fn)` (`store.js`) is a **separate seam from
`useIdentity`**, deliberately: an identity is adopted once, before `init()`, and re-pointing it is
refused; *who I can verify* changes every time the roster does. `family/engine.js#refreshAttestations`
builds it with `platform/device-identity.js#buildAttestOpen` over the roster's own rows, and
installs a stable closure over a mutable slot so a failed roster read leaves the previous answer
standing rather than blanking it.

### 5.2 E6-7b — the attestation tables were seeded **once**, at launch. (HIGH)

Papa's engine started when he was alone. Mama joined afterwards, and her ops parked on `openOp`'s P1
(`attestation`) on his Mac **for the rest of the launch** — he had no attestation for a device that
did not exist when he last looked. A member who joins while somebody's app is open is the *normal*
case.

**Fix:** `sync/keys.js#roster()` takes an `onRoster(members)` port and calls it on every read. It
hangs off `roster()` and not off `admit()` so `deliver()` and `rotate()` refresh it too, and so
there is no second GET. `sync/family.js` forwards it; `family/engine.js` wires it to
`refreshAttestations`, which rebuilds **both** tables — P1's and stage 0a's.

The same class of bug, one layer down: **a Mac in a Familienkreis and nothing else never adopted a
durable identity at all.** `main.js#armFamilyMode` gated on `syncEnabled && personalSpaceId` —
story 19.4's *own-device* sync — and `useIdentity()` may only be called before `store.init()`. Mama's
Mac ran the whole session on the ephemeral per-process identity, so `store._short` was random,
`store._me` was not her MemberId, and `createFamilySync` **refused to construct**. That is the Mac
§5.2 of the previous pass measured making zero `/ops` requests, one layer further down. The gate now
has a third field and `mount.js#armCircle` adopts the identity *without* a personal space —
`armStore` would have adopted one this Mac never created.

### 5.3 E6-9 — **D9's own window destroyed the ops a joiner authors inside it.** (HIGH)

`createjoin.js#adoptCircleIntoLog` authors Mama's attestation and her name the moment she is
admitted — and at that moment she holds no epoch key, which *is* the state D9 designs for.
`sealLine` threw, and `pushNow`'s catch **quarantined** both ops. A quarantine has no cure.

So the two ops that say who a new member *is* were destroyed by the very window the product exists
to make survivable, and every op she ever authored afterwards would have parked on every peer as
`unattestedDevice`. Permanently. On the honest path.

**Fix:** the distinction is whether the failure can be cured by something that has not happened yet.
A `FamilySyncError` of kind `'key'` leaves the line **in the outbox, untouched**, breaks the batch to
keep log order, and counts it as `opsHeldForKey` — "waiting for a key" is a state, not an absence.
An op this build would refuse on its *shape* is still quarantined, which is what the catch was
written for.

### 5.4 E6-8 — a clipboard refusal destroyed the invite it was copying. (MEDIUM)

Measured: `navigator.clipboard.writeText` threw `NotAllowedError: Document is not focused`, the
rejection escaped `createInvite`'s try, the panel reported „…fehlgeschlagen" and then drew „Keine
offene Einladung" — **while the invite had been minted on the relay.** `POST /invites` stores a
verifier, never the code (ADR 002 §7.1), so a code not read out of that response is gone for ever and
the row must be revoked and re-minted. Two orphaned invites in the relay's list are what showed it.

**Fix:** the mint is committed and the list drawn first; the copy is wrapped on its own; and the
toast shows the code either way, so the one place it appears is never conditional on a permissioned
API succeeding.

### 5.5 The mutants — each named row dies

Measured in an isolated copy of the tree, one run each.

| mutant | row that dies |
|---|---|
| M-A `keys.js#roster` stops calling `onRoster` | `§7c` |
| M-B a key-less seal is quarantined again | `§7d` |
| M-C `store.setAttestOpen` becomes a no-op | `§7b` |
| M-D the fold ignores `ctx.attestOpen` | `§7a` |

---

## 6. Principle 7 and 15.1 — solo mode, re-measured AFTER the change

A **virgin origin**, `dev-server.mjs` with no `--relay` at all, on the tree as committed:

| | first run | after clicking ⚙ |
|---|---|---|
| DOMContentLoaded | **170 ms** | — |
| JS modules | **38** | 68 (+30) |
| modules from `family/`, `crypto/`, `sync/`, `platform/net.js` | **0** | 28 |
| network requests (`fetch`/XHR) | **0** | **0** |
| off-origin requests | **0** | **0** |
| `localStorage` | `langzeitplaner.unlock` | *unchanged* |
| IndexedDB databases | **none** | **none** — no identity minted |
| family UI on the board | none — no `#legend-family`, no chips, no „Familienkreis" text | — |
| ⚙ section titles | — | Ebenen · Darstellung · Fenster · Updates · **Familienkreis** · **Server & eigene Geräte** · Meine Geräte · Abgleich · Daten · Sicherungen |

First run is unchanged: the „Willkommen" card, and the four v1 categories „Arbeit · Familie · Reisen
· Deadlines".

**This is the measurement that had to be re-taken**, because `main.js#armFamilyMode`'s gate grew a
third field this pass (§5.2). It grew in the direction that arms *more* Macs, so the question "does a
Mac that has opted into nothing still reach nothing?" had to be asked again rather than assumed. It
does: the gate is `syncEnabled && personalSpaceId` **or** `familySpaceId`, and a solo Mac has none of
the three. Opening the door loads the modules and **still makes no request and mints no key** — the
empty IndexedDB list is the sharper half of that, because a minted identity would be visible there
whether or not anything went on the wire.

Two section titles, not one: „Familienkreis" is F15's entry point and „Server & eigene Geräte" is
19.4's own-device sync. The collision the previous pass closed has stayed closed.

Guards, run by name: `tests/attack/privacy-e5-silence.test.js` 13/13,
`tests/property/sync-domains.test.js` + `tests/tier1/network-scope.test.js` all green.

---

## 6b. Story 21.2 — two engines now exist, so the separation was re-proved rather than assumed

Run live in Papa's page, with a real family ring holding six epochs:

```
personal engine handed the family space :
   PersonalSyncError: spaceId must be a psp_… id; got "fsp_9rlVQSl2o_-qz1-c7WK8Sg"
family engine handed a personal space   :
   FamilySyncError:   spaceId must be an fsp_… id; got "psp_AAAAAAAAAAAAAAAAAAAAAA"

ring.epochs(fsp_9rlVQSl2o…)  →  [1,2,3,4,5,6]
ring.epochs(psp_AAAA…)       →  []
ring.get(psp_AAAA…, 6)       →  false      ← no family key is REACHABLE under a personal id
```

Both refusals are at construction and neither has an option, a flag or a default — a parameter has a
default, and a default is how the worst thing this product could do becomes reachable by forgetting
an argument.

And the second half, on the same page:

```
Papa's PRIVAT entry „Bewerbungsgespraech"
   pub.set ops addressed at it, anywhere in the family outbox : 0
   store.familyLevelOf('fnote:<papa>/<its uuid>')             : "privat"
```

**Zero, not a redacted one** — 16.1 is structural. And it never appeared on Mama's or Oma's board at
any point in §3, which is the same fact observed from the other two Macs.

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

## 8. The earlier pass's findings — where each one stands now

| id | 2026-08-29 | 2026-08-31 |
|---|---|---|
| **E6-1** `member.set`/`space.set` have no mutation, so a circle has no shared vocabulary | OPEN | **CLOSED.** Six rows on `MUTATIONS` (23–28) and a publish path; names, colours, the rename and the admin chain all propagate — §3.4, §3.6. The far side of it (E6-7, §5.1) had to be closed too, or the ops would have arrived and been rejected. |
| **E6-2** handing over the admin role is a one-way demotion; control switched OFF | OPEN | **CLOSED.** `transferAdmin` (ADR 001 §4.1's transfer link) is authored **before** the advisory relay call, `adminPrev` comes from `store.familyAdmin().headOpId`, and `TRANSFER_PROPAGATES` is `true`. `tests/tier2/family-admin.dom.js` §7 is inverted and now asserts the op, its `adminPrev`, and the ordering. |
| **E6-3** leaving a circle bricks that Mac's family mode on that relay | OPEN | **STILL OPEN — `server/`.** Device uniqueness is global; it must be scoped to `(spaceId, deviceId)`. Not touched by this pass and not reachable from it. |
| **E6-4** the huge paste field defeated its own parser | CLOSED | still closed; re-exercised in §3.3. |
| **E6-5** „Familie" collides with itself in the legend | OPEN (PO call) | **CLOSED** by the seams pass: the section label is gone, the divider carries A3's two halves, and the `· n` count opens the popover. Verified in §3.5's legend (`M P · 2`). |
| **E6-6** hiding a second member un-hides the first | *(found later)* | **CLOSED.** `setMemberHidden` merges instead of replacing; both keys survive — §3.6. |

Three new findings are **E6-7**, **E6-7b**, **E6-8** and **E6-9**, all in §5.

The original text of the six rows follows, unedited, because the *argument* in each is still the
record of why the fix has the shape it has.

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
the board uses. **In the 2026-08-29 build the chips rendered `·` rather than initials — E6-1, not
R14. They render initials now** (`M`, `P`, `O`, each with its member's colour and a
„<Name> ausblenden" tooltip), which is what §3.5's legend shows.

---

## 10. LZP-608 — landed and driven (§3.7)

The four items this section listed on 2026-08-29 are settled:

1. **The caller existed** — `adminpanel.js#removeMember` → `ports.afterRemove`. It is now wired to
   `family/removal.js#afterRemove` and driven in a browser (§3.7).
2. **The producer now exists.** `sync/keys.js` has `GET`/`POST /spaces/:id/keys` and
   `POST /spaces/:id/epoch` clients; the rotation runs **before** the removal op, so the roster it
   reads no longer names the removed member — she is excluded by reading the truth, not by
   filtering a list, and the server's own `assertCoverage` refuses a rotation that leaves a
   *remaining* member out. Measured: 5 → 6, with the removal op sealed under 6.
3. **The copy was already written to be true**, and now the thing it describes happens. Both
   sentences are pasted in §3.7.
4. **E6-3 will still bite a re-invite.** A removed member who is later re-invited hits
   `device.deviceId/registered`. That is `server/`'s and it is unchanged.

The removal op is `member.set{_alive:false}` and **exactly** that: `authz.js` stage 2's `onlyAlive`
is `names.length === 1`, so one extra field turns it into "an admin writing to another member's
record", which every peer drops permanently and in silence. `core/ops.js`'s `removeMember` (row 28)
is the constructor, it refuses `memberId === ctx.act` by name (that is 20.3's `POST /members/leave`,
a different route that also releases the membership row, the device row and the wraps), and it goes
through `mustBeSittingAdmin`.

**What `removal.js` still refuses to do, and should:** it will not mint the admin chain. `resolveChain`
breaks rival roots by longest-chain-then-**stamp**, so a root minted at removal time would *beat* one
minted at creation and hand the seat to whoever reached the code path. Now that `createjoin.js`
emits `claimAdmin`, the blocker it reports (`NO_ADMIN_CHAIN`) no longer fires on a circle this build
created — but the refusal stays, because a circle created by an *older* build still has no root and
minting one there is the wrong cure.

## 11. Still owed, by owner

**`server/`** — scope device uniqueness to `(spaceId, deviceId)` (**E6-3**). Until then leaving a
circle is one-way on that relay, and a removed member cannot be re-invited. This is the only row
from the 2026-08-29 list that is untouched, and it is the one this pass could not reach.

**`family/removal.js` + `sync/family.js`** — the removal op is still sealed and posted by
`removal.js` itself rather than riding `pushNow`, so it does not get the sealed-envelope cache or
the quarantine. It **does** now get the chain witness (`sync.witness(space)` is exposed and is
`removal.js`'s default `witnessOf`), which closes the "commits to no chain value" half. The
remaining move is `publishOne(op)` on the engine, or the ORDER — rotate ▸ author ▸ publish —
migrating into the engine so `store.apply('removeMember')` + `syncNow()` is the whole call.

**`crypto/spacekeys.js`** — `rotateSpace()` puts the new key in the ring *before* the POST, so a
caller that loses a race holds a private `FSK_{e+1}` that `KeyRing.put`'s first-write-wins will never
replace: that device could never open an op sealed under the winner's real `e+1`, permanently and
silently. Every family caller can lose that race (D9 makes both devices deliver). `sync/keys.js`
therefore does **mint → build → POST → put** and does not call it. Either `rotateSpace` grows a
rollback, or it is documented as the solo-rotator helper it is.

**`platform/device-identity.js`** — `selfAttest` re-signs on every launch and ECDSA is randomised, so
the blob differs each time even though all six attested fields agree. `family/engine.js` now checks
the register first and publishes only a genuinely absent claim (otherwise `attestMyDevice` refuses,
loudly and correctly, on every ordinary relaunch). A deterministic or persisted blob would remove the
need for that guard.

**`i18n.js` + five modules** — the copy convention is decided (module-local frozen `{de, en}`,
Principle 7 as the tiebreak) and **not banked**. The migration of `sync*`/`family*`/`circle*`/`pair*`
out of `i18n.js` touches `i18n.js` + `createjoin.js` + `adminpanel.js` + `pairingui.js` +
`syncstatus.js` + `familysettings.js` at once, because four keys are read by more than one module.
One owner, one commit. Until then solo mode still pays for family copy.

**`syncstatus.js`** — two sentences are still owed to D9's neighbours: it speaks `syncErrGeneric` for
a held op and for a line that will not reach the other Mac, because `i18n.js` has no words of their
own for them. `opsHeldForKey` (§5.3) is now a real, counted state and is the natural thing for the
first of those to render.

**`membersui.js`** — `MEMBERS_COPY.legendHint` is dead (no call site) and passes the both-languages
walk, which is how it survived.

**`storage.js`** — `langzeitplaner.ring.<spaceId>` and `langzeitplaner.sealed.<spaceId>` want named
slots so a Tauri build writes them beside `board.json` rather than into the WebView's storage.

**Round 10's honest ceiling, unchanged and not overclaimed:** `fromGenesis` is still withheld on any
page that does not start at genesis, and the witness window is still unpersisted, so a relay that
forks across a relaunch is still undetectable. E6's population pulls from genesis — it is the page
every new member makes first — so the genesis-page defence (R10-2b) carries into the family engine
unchanged, and §3.5 is that page being made.
