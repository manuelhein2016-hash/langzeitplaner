# LangzeitPlaner v2 — Implementation Plan

| | |
|---|---|
| **Status** | The plan the team executes. Supersedes nothing in the sprint plan; it *orders* it. |
| **Date** | 2026-08-25 |
| **Path** | **A** — v1 exists as ~3 900 lines of dependency-free vanilla ES modules plus a buildable Swift WKWebView shell. LZP-402 and LZP-403 are in scope; E4 is 29 pts. |
| **Contracts** | `docs/v2/adr/001…005` · `docs/v2/contracts/*.contract.js` · `docs/v2/traceability.json` · `docs/v2/definition-of-done.md` |

> **Read the ADRs before the tickets.** The ticket text is a summary; the story number is the
> contract; the ADRs are the design. If an ADR and a ticket summary disagree, the **spec story**
> wins, then the ADR, then the ticket.

---

## 1. The build order, in one paragraph

Nothing crypto, nothing networked and nothing new on disk lands until stamps, registers, the
authorization fold, materialization, migration and undo are green under `node --test` on this
machine. Then the v1 regression suite is written **against unmodified v1** and gates the retrofit.
Then the retrofit. Then property tests. Only then crypto, then the server, then the sync client,
then the fleet harness — and only then features. Work packages **WP-1 … WP-5 introduce no
encryption, no network and no new file on disk, and are fully testable here today.** That is the
point of the ordering.

---

## 2. Work packages

Each package names its tickets, its exit criterion, and whether it is verifiable **here** (this
Mac, today) or needs a PO-owned account.

### WP-0 — Decisions and procurement · *blocks everything downstream* · needs PO

| | |
|---|---|
| Tickets | (none — inputs to LZP-105/106, 201, 109, 801, 701, 901) |
| Exit | **DONE (2026-08-25)** — D1–D9 answered in `DESIGN-DECISIONS.md` § "v2 decisions fixed by the PO" |
| Here? | **No.** §5 lists every item. |

**D1 was answered: unsigned.** There is no certificate to procure, so the long pole is gone —
and with it the safety net. **LZP-105 is out of scope; LZP-106 (the guided Systemeinstellungen
unlock screen) is now mandatory rather than conditional**, and it is the first thing Mom meets.
Treat deliverables 27 and 28 as release-blocking, and LZP-1006 (the Mom test) as the highest-
information test in the plan — it measures exactly what this decision made harder.

### WP-1 — The pure core · **verifiable here**

| | |
|---|---|
| Tickets | **LZP-401** (this ADR set is its deliverable), part of **LZP-404** |
| Files | `src/js/core/{dev,b64,canon,ids,stamp,ops,entities,registers,authz,materialize,undo,oplog}.js` |
| Tests | `tests/tier1/{stamp,registers,authz,materialize,undo,oplog}.test.js` · `tests/tier1/core-purity.test.js` |
| Exit | every module DOM-free and importable under bare Node with `window`/`document` deleted; **P1, P2, P4, P5 green** |
| Blocks | everything |

**No other file changes in this package.** The v1 app is untouched and still runs.

### WP-2 — The v1 characterization suite · **verifiable here** · *the R5 gate*

| | |
|---|---|
| Tickets | prerequisite of **LZP-402** (Risk R5) |
| Files | `tests/regression/v1/*.test.js`, `tests/helpers/{clock,rng,gen}.js`, extend `tests/helpers/fixtures.js` |
| Exit | every v1 story that touches state is scripted **against unmodified v1** through a thin `txn → mutate` shim, and green |
| Blocks | WP-3 |

`tests/README.md`'s characterization rule applies verbatim: *these tests lock in what v1 does
today; they are not a specification.* A red test after the retrofit means the change is wrong.

### WP-3 — The retrofit · **verifiable here**

| | |
|---|---|
| Tickets | **LZP-402**, **LZP-403**, **LZP-404**, **LZP-405** |
| Files | `store.js` (~120 lines), all 22 `mutate` sites in `interact.js` / `popover.js` / `legend.js`, `storage.js` (+60), `core/migrate1to2.js`, the `interact.js:199` and `main.js:30` one-liners, the shell's five new bridge commands |
| Tests | WP-2 stays green **with the shadow-undo assertion on**; `tests/tier1/migrate1to2.test.js`; `tests/tier2/*` stay green |
| Exit | v1 behaves identically, on the op-log, with `board.json` still human-readable and a real pre-change file migrating losslessly |
| Blocks | WP-4, WP-6 |

### WP-4 — Property harness · **verifiable here**

| | |
|---|---|
| Tickets | **LZP-406** |
| Files | `tests/property/*`, `tests/helpers/gen.js` |
| Exit | **P1–P4, P6, P8, P9, P10 green over ≥500 seeds**; every failing seed pinned |
| Blocks | any sync feature |

P6 (op-log undo vs a reference v1 snapshot-undo implementation, compared after every step) and P9
(no op sequence can change an entity's owner, including stamps backdated to `ms = 0`) are the two
that must not be deferred.

### WP-5 — Render seams behind a null family · **verifiable here**

| | |
|---|---|
| Tickets | part of **LZP-404**, groundwork for **LZP-801/803** |
| Files | `layout.js` (~10 lines), `board.js` (~25), the shared day-selector extracted into `core/entities.js` and consumed by both `layout.js` and `popover.js` |
| Exit | zero visible change with `familySpaceId === null`; tier-1 `layout.test.js` and tier-2 `board-render.dom.js` green |

### WP-6 — Crypto core · **verifiable here** (Node + real WKWebView)

| | |
|---|---|
| Tickets | **LZP-301** (this ADR 002 *is* its deliverable — the timebox is spent), **LZP-302**, **LZP-303**, **LZP-304** |
| Files | `src/js/crypto/*`, `src/js/platform/keystore.js`, the three Keychain bridge commands |
| Tests | `tests/tier1/{envelope,spacekeys}.test.js` · **`tests/tier2/crypto-persist.dom.js`** |
| Exit | **P11 green**; envelope round-trips in Node **and** in WKWebView; the ADR 002 §2.2 IndexedDB-persistence verification item is answered in writing |
| Blocks | WP-7, WP-8 |

### WP-7 — Server core, no cloud · **verifiable here**

| | |
|---|---|
| Tickets | **LZP-201** (models), **LZP-202**, **LZP-205**, **LZP-206**, **LZP-207** |
| Files | `server/core/*`, `server/adapters/{memory,file}.js`, `server/dev-server.mjs`, `server/prisma/schema.prisma` |
| Tests | `tests/server/*` incl. `store-contract.test.js` and `log-redaction.test.js` |
| Exit | every handler green against the memory adapter; two real app windows sync over `node server/dev-server.mjs`; the metadata inventory (LZP-207) written |
| Needs PO | **only** the Vercel + Prisma deploy (`server/adapters/prisma.js`, LZP-109) |

### WP-8 — Sync client + pairing + the fleet · **verifiable here**

| | |
|---|---|
| Tickets | **LZP-306**, **LZP-501**, **LZP-502**, **LZP-503**, **LZP-504**, **LZP-505**, **LZP-1005** (harness), **LZP-1002** |
| Files | `src/js/sync/*`, `src/js/platform/net.js`, `src/js/family/{pairingui,syncstatus}.js`, `tests/helpers/{fleet,loopback,mitm}.js` |
| Exit | **M1 — "Zwei Macs"**: two real windows in daily E2E sync of the full private board; the MITM pairing scenario fails closed; the three-weeks-offline scenario converges |

### WP-9 — Familienkreis and lifecycle

| | |
|---|---|
| Tickets | **LZP-203**, **LZP-204**, **LZP-305**, **LZP-601**…**608**, **LZP-1004** |
| Exit | create → invite → join (**with the admin's Mac asleep**) → member list → remove with rotation → leave → delete space, all in the fleet suite; export→wipe→import→re-join green |

### WP-10 — Visibility and redaction

| | |
|---|---|
| Tickets | **LZP-701**…**706**, **LZP-901**, **LZP-902**, **LZP-903**, **LZP-904**, **LZP-905** |
| Exit | **P7a–P7i green**; `assertNeverTransmitted` runs in every Belegt scenario; **M2** then **M3** |

### WP-11 — Family rendering, find, print

| | |
|---|---|
| Tickets | **LZP-801**…**807** (+808 stretch) |
| Exit | foreign entries obey lanes/`+n`/truncation on the 8×2y fixture; print and find parity |

### WP-12 — Pipeline, hardening, GA · **partly needs PO**

| | |
|---|---|
| Tickets | **LZP-101**…**109**, **LZP-1001**, **LZP-1003**, **LZP-1006**, **LZP-1007**, **LZP-1008** |
| Exit | GA — signed DMG + invitation email on a clean Mac |

> **Sprint-plan note.** The sprint plan puts the pipeline (E1) in S1 so distribution is dogfooded
> for eighteen weeks. That remains right, and E1 runs **in parallel** with WP-1…WP-5 — it touches
> none of the same files. WP-12 above lists E1 only for completeness of the "needs PO" column.

---

## 3. Dependency graph

```
WP-0 (decisions, procurement)
  │
  ├──────────────► E1 pipeline (101,102,103,109)   ── parallel, PO accounts needed
  │
WP-1 core ──► WP-2 v1 suite ──► WP-3 retrofit ──► WP-4 properties ──► WP-5 seams
                                      │                  │
                                      └──────────────────┴──► WP-6 crypto ──► WP-7 server
                                                                      │            │
                                                                      └──► WP-8 sync + fleet  → M1
                                                                                  │
                                                                        WP-9 Familienkreis    → M2
                                                                                  │
                                                                        WP-10 visibility      → M3
                                                                                  │
                                                                        WP-11 rendering
                                                                                  │
                                                                        WP-12 hardening       → GA
```

---

## 4. What is verifiable on this machine vs what needs the PO

**Toolchain present and verified:** node v22.23.1 (WebCrypto: ECDSA/ECDH P-256, HKDF, PBKDF2,
AES-GCM all present), npm 10.9.8, git, gh, swiftc (Swift 6.2), a real WKWebView.
**Absent:** Rust/cargo (so `src-tauri/` cannot be compiled), Vercel, Postgres, an Apple
Developer ID. Not yet a git repo.

| capability | here? | evidence / substitute |
|---|---|---|
| op-log, registers, authz, materialization, undo, migration | **yes** | `node --test tests/tier1 tests/property` |
| all crypto primitives, envelopes, wrapping, pairing state machine | **yes** | Node + `tests/tier2` in real WebKit |
| IndexedDB `CryptoKey` persistence across relaunch | **yes** | `tests/tier2/crypto-persist.dom.js` — **an open verification item** |
| every server handler, every rate limit, every error path | **yes** | `tests/server/*` against `adapters/memory.js` |
| two real app windows syncing over real HTTP | **yes** | `node server/dev-server.mjs` + `adapters/file.js` |
| the whole multi-device fleet incl. MITM pairing and 3-weeks-offline | **yes** | `tests/fleet/*` |
| solo zero-network, gates 1, 2 and 4 | **yes** | grep, `fetch` spy, shipped config |
| solo zero-network, gate 3 (the shell's origin gate) | **yes** | `tests/tier2/shell-bridge.dom.js` |
| `server/adapters/prisma.js` correctness | **no** | specified by `store-contract.test.js`; run it on a machine with Postgres |
| Vercel deploy, region, cold-start budget, pooling | **no** | **PO: Vercel account + Prisma Postgres, Frankfurt (D2)** |
| GitHub Actions release pipeline, Releases hosting | **no** | **PO: GitHub repo (D3)** — the project is **not yet a git repo**; `git init` is task zero |
| Tauri build, `src-tauri/` commands | **no** | **no Rust here.** The Swift shell is the reference implementation; see R8 |
| signing, notarization, quarantine-clean first launch | **n/a** | **D1 = unsigned.** Not built. LZP-106's unlock screen replaces it; the CI signing step ships as a flag that is off. |
| the Mom test on a clean Mac | **no** | **PO: a second Mac + a real email** |

---

## 5. Blocking decisions (PO)

| # | decision | answer (PO, 2026-08-25) | consequence |
|---|---|---|---|
| **D1** | Apple Developer ID (99 €/yr) | **NO — ship unsigned** | LZP-105 dropped. **LZP-106 mandatory.** Deliverables 27 + 28 release-blocking. Reversible later: cert + two CI secrets, no code change. |
| **D2** | EU/Frankfurt for Vercel and Prisma | **Yes** | LZP-201 pins the region; LZP-1001 names it. |
| **D3** | "GitHub sync" = deploy-on-push | **Confirmed as written** | LZP-109 proceeds on the Vercel↔GitHub integration reading. |
| **D4** | Person-colour rule (17.2) | **Accept as specced** | LZP-801 unblocked. |
| **D5** | Belegt in v2.0 | **Keep** | LZP-701/706 full scope. |
| **D6** | Path A or B | **A** | Forced by reality — v1 exists as working code. LZP-402/403 in scope. |
| **D7** | LZP-901's impossible server-side ownership check | **Client-side + structural ownership** | Ticket reworded. Ownership is the entity key (unforgeable, un-backdatable, property P9); the server validates membership + device signatures only. Story 21.1 preserved. |
| **D8** | Identity keys in the backup | **Passphrase-encrypt** (PBKDF2-600k → AES-GCM) | Export sheet gains one field and a two-button choice. Never plaintext. LZP-305/1004 scoped accordingly. |
| **D9** | Invite carries wrapped family keys | **NO — no key material in invites** | **ADR 002 §7.1 rewritten.** Admission ≠ key delivery. Any member device wraps the ring (all epochs) on its next sync. The join flow gains a designed **waiting state** — see `DESIGN-DECISIONS.md` § D9 for the four required behaviours. Affects LZP-203, 602, 608, 1001 and deliverables 15 + 25. |

> **D9 is the decision with the largest downstream footprint.** It trades a one-step join for the
> guarantee that a leaked invitation email can never, by itself, reveal family content. Story
> 15.3's "within a minute" is kept for *membership*; *content arrival* now waits on another
> member's Mac. The waiting state must read as calm and self-resolving — never as an error, never
> as an instruction to go wake someone up.

## 6. Risk register — updated with what the design review found

| # | risk | mitigation | early warning |
|---|---|---|---|
| **R1** | E2EE key management harder than estimated | **The spike is done**: ADR 002 is LZP-301's output, with call shapes verified in Node *and* WKWebView and seven engine-difference rules written down. Self-audit LZP-1003 still applies. | S2: WP-6 overruns |
| **R2** | Multi-device convergence bugs | Property harness **before** features (WP-4); staged authz fold so admissibility cannot depend on order; CI fleet (LZP-1005) | S4: a flaky M1 demo |
| **R3** | Vercel limits — cold starts, function duration, Postgres pooling | Pull-based cadence with per-device jitter; Prisma pooling from day one; row-locked per-space `seq` instead of a global SERIAL; budget asserted in LZP-202 | S3: pull latency > 2 s |
| **R4** | Signing/notarization friction | D1 decided in S1, cert procured immediately, updater dogfooded from S1 | S1: the self-update demo fails |
| **R5** | v1 regressions during the retrofit | WP-2 gates WP-3; the shadow-undo assertion turns "did we cover every mutation?" into a test failure; property P6 runs a reference v1-snapshot-undo beside the op-log undo | S2: suite gaps discovered |
| **R6** | Scope creep once the family sees it | Addendum §11 is the contract; PO triages into the backlog | any sprint: unplanned tickets |
| **R7 (new)** | **LZP-901's server-side ownership validation is impossible under E2EE.** Content ownership lives inside the ciphertext. | Structural ownership (the family entity key carries the owner) + the deterministic authz fold every honest client applies identically + server-side membership/device validation. **Escalated as D7.** | before LZP-901 |
| **R8 (new)** | **`src-tauri/` cannot be compiled here** and gains five new bridge commands. | The Swift shell is the reference implementation and lands first; the Rust commands are written to match it and must be built and smoke-tested on a machine with cargo **before any Tauri build ships**. Inherited from the v1 baseline; accepted. | first Tauri build attempt |
| **R9 (new)** | **A downgrade that omits a field instead of nulling it leaves the text rendered on every peer while the owner's board looks correct.** No owner-side smoke test catches it. | ADR 004 §5.1's explicit-null rule + property **P7d** + `assertNeverTransmitted` + the branded-patch precondition on `sealOp` | LZP-704 review |
| **R10 (new)** | **Ownership theft by backdating.** Every reviewed proposal resolved ownership as "author of the smallest-stamp write"; stamps have no lower bound. | Ownership is structural, not a register (ADR 001 §4.4). Property **P9** asserts no op sequence, including `ms = 0` stamps, can change an owner. | LZP-901 review |
| **R11 (new)** | **A joiner sees an empty family board** if any wall-clock staleness gate or missing epoch backfill drops history — breaking A4/17.1, the killer feature. | No staleness gate on merge; ops are **parked, never dropped**; the invite blob carries **all** epochs 1..e and is refreshed on every rotation. Fleet scenario: join at epoch 5, assert an epoch-1 entry renders. | LZP-602 review |
| **R12 (new)** | **Two migrations of the same board.json silently overwrite each other.** Wall-clock migration stamps make Mac B's migration beat Mac A's real edit. | `GENESIS(i)` — a constant carrying only the v1 array index, so two migrations are byte-identical **and** v1 insertion order survives the deterministic sort. Property **P8** + a fleet scenario that pairs two independently-migrated Macs. | LZP-403 review |
| **R13 (new)** | **`RedactionError` thrown in a `queueMicrotask` is swallowed**, so a family op silently never publishes. | ADR 004 §2.3: the error stops the sync loop and sets the `error` state; `tests/tier1/redaction-failpath.test.js` asserts that path exists. | LZP-701 review |
| **R14 (new)** | **The legend does not fit 8 members.** `.legend` is a single flex row inside a 40 px toolbar with `overflow: hidden` — it clips, it does not wrap. | Deliverable 16 must answer it: disclosure popover, a second row (~22 px of the vertical budget), or swatch-only categories. **A design decision, not an engineering one.** | deliverable 16 review |
| **R15 (new)** | **Tombstone GC is the one rule whose violation is incorrect.** Skipping the per-device cursor condition lets a very-long-offline Mac resurrect deleted entries. | ADR 001 §7.3's three conditions, an assertion in `tombstoneCollectable`, and a fleet scenario | any "GC optimization" PR |

---

## 7. Definition of Done — the additions this design forces

On top of `docs/v2/definition-of-done.md`'s eight gates:

- **Gate 2+** — a ticket that touches `core/`, `crypto/`, `sync/` or `server/core/` leaves
  `tests/tier1/core-purity.test.js` green, i.e. its files import under bare Node with `window`
  and `document` deleted.
- **Gate 2+** — a ticket that touches the op vocabulary, the authz fold or the publisher adds or
  extends a property test from ADR 005 §4.2's table.
- **Gate 2+** — a ticket in E7 (visibility) does not close without its row in ADR 004 §10 green
  **and** `assertNeverTransmitted` running in its fleet scenario.
- **Gate 5+** — no new runtime npm dependency, no new devDependency. A test-only devDependency
  needs an explicit `DESIGN-DECISIONS.md` entry; a runtime one needs PO sign-off.
- **Gate 7+** — every string added in DE **and** EN, and no string may claim a guarantee ADR 002
  §8 says we cannot keep (LZP-1003 audits strings, not only code).

## 8. Task zero

1. `git init`, first commit of the v1 baseline **before** anything in WP-1 lands, so the retrofit
   is reviewable as a diff. (D3's GitHub repo is a separate, PO-owned step.)
2. Land the two one-line unblockers from ADR 005 §2.1 (`interact.js:199`, `main.js:30`) as their
   own commit, with `tests/tier1/core-purity.test.js`, so every later package can import freely.
3. Add the new `package.json` scripts from ADR 005 §1.7 — **no dependency changes**.
