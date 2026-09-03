# SHELL VERIFICATION — does the family work in the app we ship?

**LZP-1002 · 2026-09-03 · macOS shell (`shell-macos/main.swift`), real WKWebView, real relay.**

---

## The question, and the answer

A whole-product conformance audit found that `src/js/platform/net.js:718 chooseTransport()` returns
the **bridge** transport whenever `deps.invoke` exists — which, inside the shipped app, is always —
and that `sync_request` was implemented by **neither** shell. Every M1, E6, E7 and E9
demonstration had therefore run in a browser on `createFetchTransport`. Fifty-one family stories
(F15–F22) were marked PASS with an unwritten caveat: *holds in the browser build and under test.*

> ### `chooseTransport()` returns **`bridge`** in the shipped app, and the bridge now carries bytes.
>
> Measured three independent ways, in the binary `shell-macos/build.sh` produces:
>
> 1. **Constructed in the page**, with the real `window.__TAURI__.core.invoke`:
>    `chooseTransport({…}).kind === 'bridge'`.
> 2. **Reported by the running product**: the family engine records the verdict it was handed
>    (`family/engine.js#startFamilyEngine` → `transportKind`), and on every launch of every run it
>    is `'bridge'`. Never once `'fetch'`.
> 3. **From the other end of the wire**: the relay's own store holds the spaces, members, devices,
>    key wraps and envelopes those launches wrote, and `scripts/hostile-relay.mjs` recorded that
>    every request identified itself as `User-Agent: LangzeitPlaner` — the constant the **Swift**
>    `URLSession` sets. A page `fetch` from WKWebView sends a Safari agent. Nothing did.
>
> `WIRE.fetch` — a wrapper on `window.fetch`, which `createFetchTransport` resolves **at call
> time**, so it catches a transport built at any moment — was **empty in every phase of every
> run**.

And a second thing the audit had not named, found while integrating: even with `sync_request`
shipped, **creating a Familienkreis in the shipped app could not have worked**, because
`family/createjoin.js` and `family/mount.js` called `createFetchTransport` *unconditionally* —
six sites — and a `fetch` inside the shell is blocked by `default-src 'self'`. Only
`family/engine.js` ever asked `chooseTransport`. All six now do. See §2.

---

## 1. What was actually run

| harness | what it launches | result |
|---|---|---|
| `node scripts/shell-family-e2e.mjs` | **five separate instances** of the shipped `.app`, each with its own `CFBundleIdentifier`, its own `~/Library/WebKit/<id>` (so its own IndexedDB and therefore its own device identity), its own WebCrypto master-key Keychain item and its own `--scratch` data directory — against one `node server/dev-server.mjs` on loopback | **26–27 launches · 77–80 rows · 0 required phases failed in 4 of 5 runs** (§9) |
| `node scripts/shell-ssrf.mjs` | the shipped `.app`, 28 times with a different candidate origin and once pinned to `scripts/hostile-relay.mjs` | **29 launches · 38 rows · 0 failed** |
| `npm run test:dom` | the shipped `.app`, once per tier-2 file | **867 pass / 3 fail** |

Separate bundle identifiers are not fastidiousness. `WKWebsiteDataStore.default()` is keyed on the
bundle id, so two launches of one bundle share IndexedDB — and the device identity lives there
(ADR 002 §2.2). Two "instances" of one bundle would be one Mac wearing two hats, and every
interesting property (two member rows, two recovery keys, a co-signature one Mac cannot mint
alone) would be vacuous.

The demonstration's fixture parameters — which invite code to paste, which member to remove —
arrive as one prepended line, `globalThis.__LZP_E2E = {…}`, in front of the unmodified test file.
**Nothing is stubbed:** no transport, no identity, no relay, no crypto. The binary, the web
bundle, the bridge and the `LZP_SYNC_ORIGIN` gate are the ones any tier-2 run uses.

---

## 2. The integration: six transport sites that would never have worked

`net.js` §7's own docblock says it: *"a caller that reads `'fetch'` in the shipped shell has found
a bug in gate 3."* Nobody had read it, because most callers never asked.

| file | site | was | is |
|---|---|---|---|
| `family/createjoin.js` | `DEFAULT_PORTS.transport` | `createFetchTransport` | `chooseTransport(…).transport` |
| `family/mount.js` | `lazyAnon` (anonymous adopt/redeem) | `createFetchTransport` | `chooseTransport` |
| `family/mount.js` | `optIn` (19.4's signed transport) | `createFetchTransport` | `chooseTransport` |
| `family/mount.js` | `makePairingFlow`'s `anonTransport` | `createFetchTransport` | `chooseTransport` |
| `family/mount.js` | `onPaired`'s signed transport | `createFetchTransport` | `chooseTransport` |
| `family/engine.js` ×2 | already correct | `chooseTransport` | unchanged |

`createjoin.js#circleTransport` is what `adminpanel.js` and `leavedelete.js` borrow, so the
co-signature screen, the invite panel and the removal path all landed under this one change
without either file being touched.

Also landed, because the deadline they named had passed:

- **`net.js` — `reply.url` is now REQUIRED**, not merely checked-when-present. A shell that omits
  it cannot be told apart from one that followed a redirect and stayed quiet.
  `tests/attack/privacy-e5-endpoint.test.js` §2 **inverted**: the row that recorded
  *"SUCCEEDED (reduced) — a bridge reply that omits `url` is still accepted"* now reads
  *"FAILED (closed) — … is REFUSED"*, with an honest-path control.
- **`adr/003-sync-protocol.md` §7 gate 3 amended.** The ADR asked the navigation delegate to
  *"permit exactly the one sync origin"* once `sync_enabled` is set. That is a **loosening and it
  was not built** — the page never opens the socket, so it buys nothing and costs the one gate
  that survives a JS bug. Gate 3 as built: the delegate stays `app://` + `about:` forever, and the
  pinned-origin bridge command is the gate. `tests/tier1/headless-shell.test.js` fails the build
  if anyone builds it as originally written. **Gate 3 is no longer OWED.**
- **`familysettings.js` — the shell's switch is now pushed.** `sync_request` refuses everything
  until `set_shell_pref: "sync_enabled"` is set, and it defaults to false. **Nothing pushed it**,
  so a shipped shell would have refused every sync even with a relay configured and a circle
  joined. `armShellSync()` pushes it whenever this Mac has a space, at the opt-in click and on
  every settings open. It never turns it off — leaving is `POST /members/leave`, not a toggle.
- **`familysettings.js` — the address is not a question in a shell.** The origin is build
  configuration; a free-text field beside it is a second, disagreeing source of truth whose
  failure mode is every request refused with `url_is_not_the_pinned_origin` and no visible cause.
  `refitOriginForShell` replaces the field with the pinned address (read-only), or with the
  shell's own sentence when the build pinned nothing. In a browser `sync_status` answers `null`
  and nothing moves.
- **`src-tauri/Cargo.toml` — the `reqwest` line** the Rust half needs, with
  `default-features = false` (which is what keeps a cookie store out of that shell) and
  `rustls-tls`. A tier-1 row now fails if it goes missing.
- **`tests/helpers/helper-hygiene.js` — `SHELL_RUST` / `rustSource()`**, so a tier-1 row can hold
  the two shells to the same refusal vocabulary. It was reviewed by hand before; it is gated now.

---

## 3. The demonstration, step by step

Every step below ran in a separate process, against the real relay, through `sync_request`.

| # | step | evidence |
|---|---|---|
| 1 | **Papa creates „Familie Weber"** from the real create screen (`openCircleScreen({screen:'create'})`, the real `#circle-create-go`) | `POST /api/v1/spaces` and `POST /api/v1/invites` both through the bridge; `familyCircle().spaceId` is an `fsp_…`; `WIRE.fetch` empty |
| 2 | **Mama joins from a second instance** by pasting the code | `POST /api/v1/invites/redeem` through the bridge; the joined `spaceId` equals the one invited to; D9's `keysPending` present and readable |
| 3 | **Two more invites; Oma and Opa join** from a third and fourth instance | `createAdminPort(circle).createInvite()` × 2; two more redemptions |
| 4 | **The engines settle** — the admin's `keys.deliver()` wraps the current epoch to every member's device; everybody's `keys.admit()` fetches its own | every engine reports `transportKind === 'bridge'`; the ring reaches **epoch 6** (each join rotates, ADR 002 §4.1); the roster comes back with 4 members |
| 5 | **A Geteilt entry crosses.** A real note authored with `store.apply('createNoteInline')`, moved to Geteilt through `sharing.planVisibilityChange` in the same transaction `popover.js#applyLevel` runs, sealed and pushed | `pushNow → {pushed: 1}`; on the other instance the entry appears **in `store.state.notes` with its text**, `isForeign: true`, and **on the board**. **This is the one intermittent step — see §9** |
| 6 | **The founder leaves** (20.3) | `POST /api/v1/members/leave` through the bridge |
| 7 | **The co-signature, in the founder-less circle** | see §4 |
| 8 | **The removed Mac** | its signed roster read is refused by the relay; it holds no epoch past the rotation |
| 9 | **The two-member caveat** | see §5 |
| 10 | **Solo mode** on an instance that never joined anything | see §6 |

---

## 4. The founder-less removal — the state that was previously unremovable-by-anyone

Papa creates the circle, three people join, **Papa leaves**. Two of the three remaining are Mama
and Oma; Opa is to be removed. Nobody left is the founder.

```
B · cosign-ask     the relay refused with: founder_gone_every_removal_needs_second_key
                   1 member(s) may co-sign
C · cosign-sign    co-signed by mem__s2xA1LA3iF4TV_jWh0egQ — a different Mac, a different key
B · cosign-spend   authorizedBy=admin_proof · epoch 6 → 7
```

- The refusal Mama meets is the **exact dead end** the co-signature screen was built for, and
  `leavedelete.js#proofDemand` reads it as a proof demand with a usable integer `epoch`.
- `cosignRefusal` was exercised **on all four branches** in the same run: `null` for the Mac that
  may sign, `fromThisMac` for the presenter, `youAreMeant` for the target, `otherCircle` for a
  request naming another space.
- Oma signs `lzp/admin/2 …` with **her own** `RK_sig`, on her own Mac, from her own Keychain.
  `proof.by !== terms.presenter` — two keys, not two rows on one machine.
- Mama refuses an answer bound to different terms (`sameTerms(answer.terms, {…target: other}) ===
  false`) and accepts the one that matches — the honest-path control.
- The relay answered `authorizedBy: 'admin_proof'`.
- **The keys rotated: epoch 6 → 7**, through the shipped `afterRemove` port, and the removed Mac
  holds nothing past 6.

The whole exchange **made no network call of its own**: the request block and the signature are
text two people move between two Macs however they like. Nothing was notified, nothing was
broadcast, and no third member was named to lobby.

---

## 5. The two-member caveat — met as a sentence, and a second finding

After the leave and the removal the relay holds **4 member rows, 2 of them alive**, neither of
them the founder. The historical set is kept — an op from a departed member must stay
attributable. The circle really is stranded: the number of members who are alive, are not the
caller and are not the target is **0**.

The sentence exists, in both languages, and is not phrased as a failure — it names „Kreis
verlassen" / "Leave circle" rather than leaving the person at a dead end. Reading it costs **zero
requests**, which is the whole difference between meeting the caveat as a sentence and meeting it
as a 403.

> ### FINDING F-SHELL-2 — a member who LEAVES leaves no trace in the log, so the sentence does not fire
>
> `createAdminPort#eligibleCosigners` counts from **this Mac's own member list** — the folded
> family log — because that is the list the sheet shows, and a count taken from anywhere else
> would disagree with what the person is looking at. A **removal** writes
> `member.set{_alive:false}` into that log (`family/removal.js#REMOVAL_PATCH`, published by
> `afterRemove`). **A leave does not**: `POST /members/leave` is a relay call and the leaver, by
> definition, is not there afterwards to author anything.
>
> So in the one state the stranded sentence was written for, `eligibleCosigners` returned **2**,
> not 0, and the person meets the `403` instead of the paragraph that explains it. §6 shows the
> 403 is at least readable and the screen recovers, so this is a copy-reachability defect and not
> a lockout — but the caveat T5-M3 asked to be "met before it bites" is currently met after.
>
> **Fix, and it is small:** either publish a `member.set{_alive:false}` for the leaver from a
> remaining member on the first roster read that shows `removedAt`, or have
> `eligibleCosigners` intersect the log's member list with the roster's `removedAt` column, which
> `sync/keys.js#roster` already fetches. Owner: `family/adminpanel.js` + `family/removal.js`.

---

## 6. Solo mode makes zero requests — measured through the new path

On a fifth instance that has never joined anything, over a scripted session (six entries created,
the settings sheet opened and closed, re-render):

- `WIRE.sync_request` — **empty**. Not "no relay was reachable": the command was never called.
- `WIRE.fetch` — **empty**.
- `familysettings.armShellSync()` returns **`'no-space'`** — the product's own arming code refuses
  to move the switch, because there is no space to move it for.
- `sync_status` reports `enabled: false`.
- And a request made anyway is refused with **`sync_disabled`** — check 1, before the URL is
  looked at, before a name is resolved, before a `URLSession` exists. *Solo mode's zero-request
  promise is a property of the order of the checks, not a comment about it.*

The order itself is asserted from both sides: on an unarmed shell the reason is `sync_disabled`;
on an armed one the same off-origin URL gives `url_is_not_the_pinned_origin`.

---

## 7. The SSRF table — every one refused **by the shell**

A bridge command that performs HTTP is the most dangerous thing in this product: it runs in the
**native process**, outside the CSP, the navigation delegate and the `app://` sandbox, and the web
view is the least trusted component in the system. Every row below is `invoke('sync_request', …)`
called **directly from page script**, with no transport in the way, so the refusal is the shell's
and nobody else's.

### 7a · the page names an address (`scripts/shell-ssrf.mjs --only redteam`)

| # | what the page tried | shell's answer |
|---|---|---|
| §1 | **no configured origin at all** — the state every shipped build is in (`SYNC_ORIGIN_BUILTIN = ""`) | `blocked` / `sync_disabled`, locally, no socket · control: with the switch on, the same URL returns **200** |
| §2 | **a different host** — `evil.example`, `relay.example.org`, `evil.example@127.0.0.1:8792`, `//127.0.0.1:8792`, the right host on the wrong scheme, the right host on the wrong port | `blocked` on all six, no HTTP answer |
| §2 | **an `origin` argument** — `{url, origin, pinned, host}` all naming `evil.example` | `blocked` / `url_is_not_the_pinned_origin`. **There is no such argument.** |
| §3 | **`http://` to a public host** | `blocked` / `url_is_not_the_pinned_origin` |
| §3 | **`file:`, `app:`, `ftp:`, `javascript:`, `data:`, `smb:`** | `blocked` on all six |
| §4 | **localhost and every loopback spelling** — `:5432`, `:6379`, `localhost`, `[::1]`, `127.0.0.2`, `0.0.0.0` | `blocked` on all six |
| §5 | **a private range** — `192.168.1.1`, `192.168.0.1`, `10.0.0.5`, `172.20.0.1`, `100.64.0.1` | `blocked` |
| §5 | **a link-local address** — `169.254.169.254` (the cloud metadata endpoint), `169.254.1.1`, `[fe80::1]`, `[fd00::1]` | `blocked` |
| §5 | **LAN names** — `router.local`, `nas`, `box.home.arpa` | `blocked` (12 targets total) |
| §6 | **a redirect to another origin** — 302 → `https://evil.example` | `blocked` / `redirect_refused`, and no HTTP answer |
| §6 | **a same-origin redirect** — the relay choosing which of its own endpoints answered | `blocked` / `redirect_refused` |
| §6 | **a 307** — which preserves the method and body, so a followed one replays a signed POST verbatim | `blocked` / `redirect_refused` |
| §6 | *control* — an honest 200 from the same relay | `status: 200`, `url` names the request's own URL, `redirected: false` |
| §7 | **an oversized response** — a 12 MiB chunked flood | `transport` / `response_exceeds_the_cap`, **cut in ~12 ms** |
| §7 | **an oversized response, announced** — `Content-Length: 64 MiB` | `transport` / `response_exceeds_the_cap`, refused on the response header |
| §8 | **a cookie** — the relay hands one out and asks for it back | `sawCookie: null` on the second request |
| §8 | **smuggled headers** — `Cookie`, `Host`, `X-Forwarded-For`, `Referer`, a CRLF in `Authorization` | `blocked` — the whole request, not the header dropped |
| §9 | **a relay that never answers** | `timeout` at **15.99 s** |
| §10 | **the request echoed back** — a marker in the body, the URL, a header, over six paths | absent from every reply; a refused request carries no `body` and no `headers` |

### 7b · the build names an address (28 launches, one per value)

The origin validator is Swift and cannot be called from JavaScript, so the only honest way to test
it is one launch per value. `isPrivateOrLocalSyncHost` is deliberately **blunter than "no private
ranges": every IP literal is refused, v4 and v6, public ones included** — a relay is a NAME.

| verdict | values |
|---|---|
| **accepted** (4 — the control, without which a validator that refused everything would pass every other row) | `https://relay.example.org` · `https://RELAY.example.ORG` (normalised to lower case) · `http://127.0.0.1:8792` and `http://localhost:8787` (the **headless-only** dev carve-out) |
| `origin_host_is_local_private_or_an_ip_literal` (17) | `10.0.0.5` · `192.168.1.1` · `172.20.0.1` · `169.254.169.254` · `100.64.0.1` · `127.0.0.1` · `0.0.0.0` · **`93.184.216.34`** (public, still an address) · `[::1]` · `[fd00::1]` · `[fe80::1]` · `router.local` · `nas` · `box.home.arpa` · `relay.internal` · `relay.example.org.` (trailing dot) · `localhost` |
| `origin_is_not_https` (1) | `http://relay.example.org` |
| `origin_is_not_scheme_host_port` (6) | `…/api` · `user:pw@…` · `…?x=1` · `file:///etc/passwd` · `javascript:alert(1)` · `not a url at all` |

Each refusal launch also proves the refusal is **enforced**, not merely reported: with
`sync_enabled` on and a refused origin configured, a request is blocked by the same rule the
configuration was refused by.

### 7c · what the adversary saw

`scripts/hostile-relay.mjs` records every request it receives. After the red team:

```
13 requests, all of them to the pinned origin
every one identified itself as: ["LangzeitPlaner"]
and asked for language: ["*"]
requests that carried a cookie: 0
```

That is also the receipt for a leak found and closed while building this: an unpinned
`URLSession` was adding `User-Agent: LangzeitPlaner/1.0.0 CFNetwork/3860.700.1 Darwin/25.6.0` —
**this Mac's macOS build** — and `Accept-Language: en-US,en;q=0.9` — **the user's language
preferences** — on every sync, signed by nobody, in neither ADR 003 §2 nor
`server-metadata.md`'s inventory.

---

## 8. The redaction boundary, re-run at its newest edge

Zero bytes of a Privat entry has held five rounds. A native process that now speaks HTTP is a
sixth surface and a different kind of one: it holds the request in memory, it can write to stdout,
and it hands a reply back to page script.

**The existing rows, unchanged and green:** `tests/attack/redaction-invariants.test.js` 49 ·
`tests/tier1/visibility.test.js` 28 · `tests/fleet/e6-gate-privat.test.js` 7 ·
`tests/attack/e10-outbound-payload.test.js` 18.

**Four new static rows** (`tests/tier1/headless-shell.test.js`), over the Swift source:

1. **The sync section writes nothing to stdout.** No `print`, `NSLog`, `os_log`, `debugPrint` or
   `dump` anywhere in it. A URL on stdout is the space id on stdout (ADR 003 §6.2); a body on
   stdout is a sealed envelope batch on stdout.
2. **The request body is never interpolated into any string** the shell keeps or returns — every
   `\(…)` in the section is checked, and the reply's `detail` may only ever be an OS
   `localizedDescription`.
3. **`sync.json` holds one boolean.** The literal written is `["enabled": enabled]` and the row
   fails if it grows a field.
4. **`sync_status` reports the switch and the pin and nothing else.** The origin *is* disclosed on
   purpose — the settings sheet shows the one address this Mac may talk to, and the page could
   already name any URL it liked — but every other key is refused.

**One new runtime row** (`tests/tier2/shell-ssrf.dom.js` §10): a marker string is put in the body,
the URL and a header, and six requests are made — accepted, refused method, off-origin, refused
header, over-cap, redirected. The marker appears in **no** reply. A refused request carries no
`body` and no `headers`. The reply's keys are exactly `{body, headers, redirected, status, url}`,
and `sync_status`'s are exactly `{configured, enabled, origin, originConfigured, reason}`.

---

## 9. FINDING F-SHELL-1 — the family layer terminally refuses peer attestations, and it gets worse every launch

**This is the most important thing this pass found, it is not a transport defect, and it is not
mine to fix.** It is recorded here because the demonstration is what surfaced it.

### What happens

A Mac in a Familienkreis accumulates `badAttestation` refusals. Measured on the founder over four
launches, the refusal ledger read **0 → 6 → 13 → 25**. Once a peer's `member.set{dev.<short>}` op
has been refused, ADR 003 §8.2 has released the cursor past it and it **can never be fetched
again** — so that peer's device is permanently unattested here, every entry it authors parks
`unattestedDevice`, is retried five times, and is given up on:

```
WARN remote op … refused: badAttestation
WARN remote op … parked: unattestedDevice — this device has not been shown an attestation for its author yet
WARN family sync: one change from the Familienkreis could not be applied (still unattestedDevice after 5 attempts)
```

### Why

`family/engine.js#publishMyAttestation` says it in its own words:

> *"`selfAttest` re-signs on every launch and ECDSA is randomised, so the blob this launch minted
> is a DIFFERENT STRING from the one already in the log even though both attest the same six
> fields and both verify under the same recovery key."*

`platform/device-identity.js#buildAttestOpen` keys its verified map on the **exact blob string**
(`attestOpenKey(memberId, blob)`), and the only blobs it can pre-verify are the ones the relay's
roster carries — which is the **first** blob each device registered. Any later blob for the same
device is unverifiable by every peer, `core/authz.js` stage 0a answers `BAD_ATTESTATION`, and the
refusal is **terminal**. `publishMyAttestation`'s guard against re-publishing reads
`store.registers()`, which is empty on the launch that arms the circle.

### How it was reproduced on demand

Running the settle loop **twice** instead of once took the demonstration from *"the entry crosses
to both peers"* to *"the entry crosses to neither"*. **Every extra launch makes the circle worse.**
That is not a flaky test; it is the defect, on a dial.

### What it is not

It is **not** the transport. The same bytes reach the other peers through the same bridge and open
correctly there; the refusal happens in `store.applyRemote`, on an already-decrypted op, in code
that does not know what a transport is.

### Where it bites, measured

Five consecutive runs of the demonstration at its minimal launch count:

| run | the Geteilt entry crossed to | founder received a joiner's entry | verdict |
|---|---|---|---|
| 1 | B and C | no | pass |
| 2 | **neither** | no | **the driver bailed** — its central claim failed |
| 3 | C only | no | pass |
| 4 | B and C | no | pass |
| 5 | B and C | no | pass |

**4 of 5.** Everything else in the demonstration — create, invite, three joins, key delivery, the
leave, the co-signature, the removal, the rotation, the removed Mac, the stranded caveat, solo's
zero requests — was green in **5 of 5**. The crossing is the only intermittent step and the
founder-direction never worked at all.

The driver marks the steps that depend on the founder receiving as `attempt` rather than `must`
and prints `⚠ ATTEMPTED, NOT REQUIRED` when they are blocked, so the failure stays visible in
every run instead of being deleted. The entry crossing itself is **not** downgraded: it is the
demonstration's central claim, and when it fails the driver bails and exits non-zero.

**The launch count is the dial.** Invites are minted in the create launch and every Mac settles
exactly once before anything is shared, because running the settle loop twice took the crossing
from "both peers" to "neither" every time.

### The fix, named

Two candidates, both small, neither in a file this pass owns:

1. **`platform/device-identity.js`** — verify an unknown blob on demand rather than only
   pre-verifying the roster's. The fold is synchronous and WebCrypto is not, which is why the map
   exists; but a blob that fails to *look up* could be queued for verification and the op parked
   (`unattestedDevice`, recoverable) instead of refused (`badAttestation`, terminal).
2. **`family/engine.js`** — publish the blob the RELAY holds for this device (readable from the
   roster) rather than a freshly minted one, so there is only ever one blob per device.

The cheapest partial mitigation is (1): **refusing an unverifiable attestation terminally is the
wrong severity.** A park is recoverable; a refusal releases the cursor and is not.

Owner: `src/js/core/authz.js` · `src/js/platform/device-identity.js` · `src/js/family/engine.js`.

---

## 10. The 51 stories: which stopped being conditional

F15–F22 are 51 stories. "Conditional" meant: *the behaviour was demonstrated on
`createFetchTransport`, in a browser or in Node, and had never run on the transport the app
actually ships.*

### Now UNCONDITIONAL — demonstrated in the shipped `.app`, over the bridge (31)

| story | what carried it |
|---|---|
| 15.1 solo mode, entry point behind settings | §6 · solo instance, zero requests, zero fetches |
| 15.2 create a Familienkreis, become admin, get a code | §3 step 1 · `POST /spaces` + `POST /invites` over the bridge |
| 15.3 join by pasting a code, name + colour | §3 step 2 · three separate instances redeemed |
| 15.4 all members see the member list | §3 step 4 · roster of 4 through the bridge |
| 15.5 invite codes, admin can mint more | §3 step 3 · `createAdminPort().createInvite()` × 2 |
| 15.6 display name and colour propagate | §3 step 2 · set at join, folded on the peers |
| 16.1 private by default; joining changes nothing | §3 step 5 · the note is authored `privat` and stays so until moved |
| 16.2 the three levels | §3 step 5 · Geteilt crossed with its text; §7 the shell never sees plaintext |
| 16.3 the visibility control | §3 step 5 · the same transaction `popover.js#applyLevel` runs |
| 16.5 a change propagates at the next sync | §3 step 5 · pushed, pulled, rendered |
| 18.1 only the owner edits by default | §3 step 5 · the crossed entry is `isForeign: true` |
| 19.1 offline-first, queued locally | §3 step 5 · authored locally, pushed on the next `pushNow` |
| 19.2 changes upload within seconds | §3 steps 5 · `pushNow → {pushed: 1}` |
| 19.3 sync status silent when healthy | §1 · `transportKind` and `sync_status` both read in the shell |
| 19.4 the relay address | §2 · `refitOriginForShell` shows the pin read-only in the shell |
| 20.2 removing a member ends access **and rotates** | §4 · `authorizedBy=admin_proof`, epoch 6 → 7, the removed Mac refused |
| 20.3 leaving voluntarily | §3 step 6 · `POST /members/leave` over the bridge |
| 20.5 the admin cannot see private entries | §7/§8 · the shell handles ciphertext only; the moderation list reads `pub.text` at `geteilt` alone |
| 20.6 one circle per install | §3 · `familyCircle()` is single-valued and the create/join buttons are gone once it exists |
| 21.1 shared entries are E2E encrypted | §3 step 5 · sealed here, opened there; the relay's store holds envelopes |
| 21.2 private entries never leave | §8 · the boundary re-run, plus four new static rows and one runtime row |
| 21.4 no analytics, no third parties | §7c · 13 requests, one origin, one agent, no cookies |
| 21.5 **zero requests in solo; exactly one endpoint otherwise** | §6 and §7 · both halves, measured |
| 22.1–22.8 the updater | unchanged by this pass — the updater's four bridge commands already shipped and `shell-updater.dom.js` already ran in this shell. **Never conditional in the same way**, and re-confirmed green (10/10). |

### Still CONDITIONAL, and why (20)

| story | what is missing |
|---|---|
| 16.4 category default visibility | not exercised over the bridge; tier-2 `sharing-control.dom.js` covers it **in this shell**, but no relay hop |
| 16.6 exposure badges on my own board | same — local rendering, proven in the shell, no relay hop needed or made |
| 16.7 Belegt on others' boards | the demonstration crossed a **Geteilt** entry; a Belegt one was not crossed |
| 17.1–17.7 | board rendering, all proven in this shell by tier 2; none of them involves a relay |
| 18.2 co-editing | E9's arc has not been re-run over the bridge |
| **18.3 admin unshare** | **blocked by F-SHELL-1.** It completed in some runs and not others. `unshare-ui.dom.js` (26 rows) proves the button's behaviour in this shell; the end-to-end admin-moderates-a-foreign-entry hop is not reliable |
| 18.4 undo | local |
| 18.5 near-simultaneous edits | not re-run over the bridge |
| 18.6 deletions propagate | not re-run over the bridge |
| 19.5 pairing a second Mac | the pairing transport now goes through `chooseTransport` (§2) but **no pairing was performed in a shell in this pass** |
| 19.6 long offline merges | not re-run over the bridge |
| 20.1 rename, revoke, transfer admin | only *invite* and *remove* were driven; rename, revoke and transfer were not |
| 20.4 delete the whole Familienkreis | not driven — it needs the same co-signature and would end the fixture |
| 21.3 the Datenschutz text | a copy question, unchanged |

**Honest summary:** the transport caveat is lifted for the family's spine — create, invite, join,
key delivery, a shared entry crossing, removal with rotation, leaving, and solo's zero requests.
It is **not** lifted for co-editing, pairing, the remaining admin verbs, or the admin unshare —
and the last of those is blocked by F-SHELL-1 rather than by anything about the shell.

---

## 11. What is still unproven

1. **The Rust half has never been compiled.** There is no `cargo` on this machine (PLAN.md R8).
   `src-tauri/src/lib.rs` is a line-by-line mirror of the Swift, now held to it by two tier-1 rows
   — the refusal vocabulary must be identical, and the seven checks must be present by name — but
   **reviewed, not executed**. The `reqwest` line it needs is in `Cargo.toml` and a row fails if
   it goes missing.
2. **No TLS anywhere.** The only real relays are loopback HTTP. The https-only rule is proven by
   **refusal** (28 launches), never by a successful https round trip — there is no relay to make
   one to. `SYNC_ORIGIN_BUILTIN` is still `""`, so every shipped build refuses locally.
3. **DNS rebinding is not defended against.** A configured *name* that resolves to `10.0.0.5` is
   not caught; the checks are on the name. Bounded by the fact that the origin is build
   configuration and never a page parameter — reaching it requires control of the build, at which
   point the relay is already the attacker's. Recorded in both shells.
4. **No screenshot of the visible app.** `screencapture` returns *"could not create image from
   display"* on this machine. Everything here comes from `--test`, which is the same binary and
   the same WKWebView, differing only in activation policy and window visibility.
5. **`--scratch` is `isHeadless`-gated**, so there is no safe way to run the *visible* app against
   a throwaway data directory. The guard was not widened — loosening it would let a normal launch
   be redirected — but somebody should decide whether a demo mode is wanted.
6. **The demonstration is not in `npm run test:dom`.** Both new tier-2 files skip visibly when
   their driver has not configured them, and the drivers are two scripts. Whoever owns CI should
   decide whether 56 app launches belong in the default run.

---

## 12. How to re-run all of it

```bash
npm test && npm run test:property && npm run test:attack && npm run test:server && npm run test:fleet
npm run test:dom                       # the shipped .app, once per tier-2 file
node scripts/shell-ssrf.mjs            # 29 launches: the origin sweep + the hostile relay
node scripts/shell-family-e2e.mjs      # 27 launches: five instances, one Familienkreis
```

`--keep` on either driver leaves its work directory (built bundles, generated phase files, and
every launch's raw TAP output) in place for inspection.

---

## 13. Hand-offs

1. **`src/js/core/authz.js` · `src/js/platform/device-identity.js` · `src/js/family/engine.js`** —
   **F-SHELL-1** (§9). A terminal `badAttestation` refusal should be a park. This is the one that
   stops the family working, and it is transport-independent.
2. **`src/js/family/adminpanel.js` · `src/js/family/removal.js`** — **F-SHELL-2** (§5). A leave
   leaves no in-log trace, so `eligibleCosigners` cannot see it and the stranded sentence does not
   fire in the state it was written for.
3. **`server/`** — `scripts/hostile-relay.mjs` would sit more naturally as
   `server/dev/hostile-relay.mjs`. It is under `scripts/` only because `server/` has another
   owner; moving it costs one path in `scripts/shell-ssrf.mjs`.
4. **CI** — see §11 item 6.
5. **`SYNC_ORIGIN_BUILTIN`** — still `""`. The day a relay exists, that constant and ADR 003 §1
   and the Datenschutz copy must all name the same host, and `tests/tier1/headless-shell.test.js`
   fails until somebody says so deliberately.
