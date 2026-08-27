# ADR 001 — The op-log

| | |
|---|---|
| **Status** | Accepted — normative for all downstream work |
| **Date** | 2026-08-25 |
| **Tickets** | LZP-401, 402, 403, 404, 405, 406 · supports 501/502/505, 701/704, 901–905 |
| **Stories** | 5.4, 9.3, 9.5, 11.3, 11.5, 11.6, 16.1, 16.2, 18.1, 18.2, 18.4, 18.5, 18.6, 19.1, 19.4, 19.6, 20.2, 20.6, A2, A3, A4, A5 |
| **Supersedes** | LZP-401's "ULIDs" premise (§1.2), the standalone `board.reset` primitive (§7.3) |
| **Path** | A (v1 exists as working code; LZP-402/403 in scope) |

> **Amended 2026-08-27**, after `judge:conformance` and `judge:adversary3` ran against the
> WP-1 core and the WP-3 retrofit. Ten statements in this document were **wrong**, not merely
> imprecise, and are corrected in place: §1.2 (cross-reference), §3.1 (`_born` on `fnote`/`fbar`),
> §3.2 rows 11/13/16, §4.0 (attestation is a **lookup**, not a hash), §5 step 2 (the withdrawal
> qualifier), §5 step 5 (the bar comparator), §7.2 (`bodies` cross-reference), §7.3 condition 3
> (write progress), §7.4 (two more parked classes), §8.1 property 2 ("byte-identical" overstated).
> Every correction carries a marginal **Amended** note naming the test or the finding id that
> caught it, so the next reader knows which sentences were *verified* and which are still merely
> *reasoned*. The register of findings behind them is `docs/v2/FINDINGS.md`.
>
> **How to read this.** §0 is the whole design in nine sentences. Everything after it is
> the detail an implementer needs so that no further design decision is required.
> Where this document and a ticket summary disagree, the **spec story wins**; where this
> document and the spec are silent, **this document wins**. Changing anything in §12
> requires a new ADR, not a pull request.

---

## 0. The nine decisions everything else follows from

1. **One op primitive: a stamped field assignment.** Every mutation in the product — note
   create, bar resize, category delete-with-reassign, scratchpad typing, visibility change,
   member rename, admin transfer — compiles to a set of `(entityKey, field, value, stamp, author)`
   writes. Merge is per-field `max-by-stamp`. There is no move op, no create op, no delete op
   at the merge layer.
2. **State is a pure function of the *set* of ops.** Not of any sequence. Reorder-, duplicate-
   and interleave-convergence are therefore true by construction (§6), not by argument, and
   are a one-line property test.
3. **Stamps are hybrid logical clocks rendered as fixed-width sortable strings.** The stamp is
   the LWW comparator and the sort key. It is **not** the op id and it **never appears in
   plaintext on the wire** (ADR 002 §5). No ULIDs anywhere (§1.2).
4. **Ownership is structural, not a register.** A family entity's key literally contains its
   owner's member id: `fnote:<memberId>/<uuid>`. Nothing can be backdated to steal an entry.
   This closes the flaw every judge found in the proposals it reviewed.
5. **Three spaces, and the family space is a *constructed projection*, never a filter.**
   `local` never leaves the Mac; `personal` carries the truth to my own devices; `family`
   carries only `pub.*` fields that ADR 004's projection built. A rendering bug cannot leak
   text that was never in an op.
6. **`seq` is a transport cursor and never a merge input.** A relay that reorders, re-delivers
   or delays ops causes latency, never divergence.
7. **An op is never discarded for being old.** There is no wall-clock staleness gate on merge.
   Ops from the future are *parked*, not dropped. (Closes the flaw that broke A4/17.1.)
8. **Undo emits inverse *ops* with fresh stamps, scoped to locally-emitted transactions.**
   `applyRemote()` touches neither the undo nor the redo stack. That is story 18.4, structurally.
9. **The local apply path is strictly synchronous through `emit()`.** Encryption, outbox and
   network happen in a `queueMicrotask` *after* `emit()` returns. `interact.js:317` queries the
   DOM for the freshly created bar immediately after the mutate returns; an `await` there
   silently breaks bar-label editing.

---

## 1. Identity

### 1.1 Vocabulary

| term | meaning |
|---|---|
| **stamp** | 37-char fixed-width string; the LWW comparator and sort key (§1.3) |
| **opId** | 22-char base64url, 128 bits CSPRNG, **no time component**; server idempotency key |
| **entityKey** | `note:<uuid>`, `bar:<uuid>`, `cat:<uuid>`, `pad:<YYYY-MM>`, `pref:app`, `fnote:<memberId>/<uuid>`, `fbar:<memberId>/<uuid>`, `member:<memberId>`, `space:<spaceId>` |
| **register** | `{ value, stamp, author }` — exactly one per `(entityKey, field)` |
| **txn / group** | the ops one user action produced; the unit of ⌘Z |
| **space** | `local` \| `personal` \| `<familySpaceId>` — replication scope and encryption key |

### 1.2 Identifier schemes — and why not ULID

LZP-401's premise says "ULIDs". **Rejected**, on four counts, and this ADR is the artifact
that decision belongs in:

1. **A ULID leaks a wall clock to the relay.** The op id is server-visible (it is the
   idempotency key). A ULID's first 48 bits are `Date.now()` at authoring time. That hands the
   relay the creation time of every op — including ops written three weeks offline on a train —
   for free. `receivedAt` already tells the server when an op *arrived*; authoring time is a
   strictly additional metadata leak we can decline at zero cost (story 21.3).
2. **Sortability buys nothing here.** Delivery order is the server's `seq`; merge order is the
   HLC stamp. A third ordering nobody consults is dead weight.
3. **ULID has no causality and no per-field granularity.** Making a ULID monotonic within a
   millisecond needs exactly the counter state an HLC needs anyway.
4. **It costs code.** A Crockford base32 encoder plus monotonic-counter handling is ~60 lines to
   write, test and audit against `crypto.randomUUID()`, which both engines already have and
   which v1 already uses (`store.js:14`).

**Decisions:**

```js
// src/js/core/ids.js — DOM-free
export const entityUuid = () => crypto.randomUUID();       // v1's scheme, unchanged
export const opId       = () => b64u(rand(16));            // 22 chars, no time component
export const groupId    = () => b64u(rand(16));            // never leaves the device
export const memberId   = () => 'mem_' + b64u(rand(16));
export const spaceId    = (kind) => (kind === 'family' ? 'fsp_' : 'psp_') + b64u(rand(16));
export const deviceId   = () => 'dev_' + b64u(rand(16));
```

**`deviceShort`** — the stamp tiebreak — is **not** random: it is
`crock32(SHA-256(rawSigPublicKey).slice(0, 10))` → **16 Crockford base32 characters = 80 bits**.

Three properties this buys, all load-bearing:
- **Deterministic** ⇒ a device cannot claim two identities, and the server can bind
  `deviceShort` to a public key at registration.
- **80 bits** ⇒ no server-side collision check is needed (a 16-device family has a collision
  probability around `10⁻²⁰`). Two of the reviewed proposals needed a server round trip here.
- **Crockford alphabet** (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`) ⇒ every character sorts at or
  above `'0'`, so the all-zeros device short is a true minimum. Migration depends on this (§8).

> **This paragraph is the ONLY definition of `deviceShort` in the system, and every other document
> defers to it.** `deviceShort` is a function of the device's **signing key** and of nothing else.
> `op.dev` (`'dev_' + 22 b64url`, above) is an independent random identifier with **no derivational
> relationship** to that key: `deviceShort(op.dev)` is not a computation that exists. The two are
> joined by exactly one artifact — the `DeviceAttestation` (ADR 002 §2.3), which names `memberId`,
> `deviceId` **and** `deviceShort` together and is signed by the member's recovery key — so
> resolving one from the other is a **lookup**, never a hash. Earlier drafts of §4.0 and of ADR 002
> §5.2 wrote it as a hash; both are corrected, and ADR 002 §5.2 now carries the full resolution.
>
> **Amended 2026-08-27** — the contradiction was raised from the implementation
> (`docs/v2/contracts/ops.contract.js:279-290`, written while `authz.js` was built) and resolved by
> `judge:conformance` Part C. `src/js/core/ids.js:138 deviceShortOf` implements this paragraph
> verbatim and needs no change; its one non-conforming caller, `src/js/store.js:415-425`, mints an
> **ephemeral solo identity** from `getRandomValues` and is documented as such — it becomes the real
> thing when the keystore lands in WP-6.

**Entity uuids are never re-keyed.** Migration keeps v1's `crypto.randomUUID()` values verbatim.
Re-keying gains no ordering (the stamp provides it), destroys any external reference, and would
break the byte-identical-double-migration property in §8.

### 1.3 The stamp

```
stamp := pad13(wallMillis) '.' pad6(counter) '.' deviceShort16
         └── 13 chars ──┘     └── 6 chars ──┘   └─ 16 chars ─┘        total 37 chars
example: 1787836800123.000003.7QAR2MZ9XKPNC0GV
```

`src/js/core/stamp.js`:

```js
export const MAX_FUTURE_DRIFT_MS = 24 * 60 * 60 * 1000;

/** Fixed width ⇒ plain string `<` is a strict total order. */
export const fmt = (ms, ctr, dev) =>
  String(ms).padStart(13, '0') + '.' + String(ctr).padStart(6, '0') + '.' + dev;

export function createClock(deviceShort, now = Date.now) { /* → { tick, observe, peek, skew } */ }
// clock.tick()          -> stamp, for a locally authored write. Mutates the clock.
// clock.observe(stamp)  -> void,  absorb a received stamp (standard HLC receive rule)
// clock.skew()          -> number, ms difference against the last server time seen

export const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const msOf  = (s) => Number(s.slice(0, 13));
export const ctrOf = (s) => Number(s.slice(14, 20));
export const devOf = (s) => s.slice(21);
```

- **Generate rule:** `now > last.ms ? {ms: now, ctr: 0} : {ms: last.ms, ctr: last.ctr + 1}`.
  Counter overflow at `999999` rolls `ms += 1, ctr = 0`.
- **Receive rule (`observe`):** standard HLC — `ms = max(local.ms, remote.ms, physicalNow)`,
  then the three-way counter case split. **The received op's stamp is never rewritten**, so
  absorbing can only change *future* local stamps and therefore cannot change any merge outcome
  on any device.
- **Future clamp:** if `remote.ms > physicalNow + MAX_FUTURE_DRIFT_MS`, do **not** adopt the
  remote wall clock, and **park** the op (§7.4). A peer with a broken clock cannot drag ours
  forward, and its ops are not silently lost.
- **There is no lower bound and no staleness gate.** An op is never discarded for being old.
  This is the fix for the flaw that would otherwise have made a joining member's board empty of
  everything older than the horizon — i.e. would have broken A4/17.1, the addendum's headline
  family feature.

**The conflict-resolution rule, stated once, for the whole product:**

> For every `(entityKey, field)` the surviving value is the one written by the op with the
> **greatest stamp**, compared as a plain string — equivalently `(wallMillis, counter,
> deviceShort)` in that order. `deviceShort` is the final tiebreak and it is total, because
> device shorts are 80-bit hashes of distinct public keys and the counter strictly increments
> per local event. **There is no "concurrent" case the rule declines to resolve.**

### 1.4 Derived timestamps — no stored `createdAt` / `updatedAt`

```
createdAt(entity) = min(stamps of all its registers)      // = the `_born` register's stamp
updatedAt(entity) = max(stamps of all its registers)
updatedBy(entity) = author of the register holding updatedAt
```

Both are pure functions of the op set, therefore convergent for free, and they deliver 17.6
("von Mama · geteilt · geändert So.") without a syncable field two devices could disagree about.

---

## 2. The op envelope (plaintext, pre-encryption)

```jsonc
{
  "v":     1,
  "id":    "8Kx2Qm7bR0aZ4tV9wLpNcg",                 // opId — random, no time
  "ts":    "1787836800123.000003.7QAR2MZ9XKPNC0GV",  // HLC stamp
  "space": "psp_9xQ2mR7bL0aZ4tV8wK",                 // 'local' | psp_… | fsp_…
  "act":   "mem_2bK7xQ9pLmR0aZ4tV9",                 // acting MEMBER (attribution, authz)
  "dev":   "dev_7QaR2mZ9xLpNc0gVtB",                 // authoring DEVICE
  "gid":   "3Ff9pQ2mLx7bR0aZ4tV9wL",                 // transaction group (undo unit)
  "k":     "note.set",                               // op kind, §3
  "e":     "note:5e1a-…-9c",                         // entityKey
  "f":     { "date": "2026-09-10", "text": "Zahnarzt" }
}
```

```js
/**
 * @typedef {Object} Op
 * @property {1}       v
 * @property {string}  id     22-char b64url opId; unique; the server idempotency key
 * @property {string}  ts     37-char stamp (§1.3)
 * @property {string}  space  'local' | '<personalSpaceId>' | '<familySpaceId>'
 * @property {string}  act    memberId of the acting human
 * @property {string}  dev    deviceId that authored it
 * @property {string}  gid    transaction group id
 * @property {OpKind}  k
 * @property {string}  e      entityKey
 * @property {Object<string, string|number|boolean|null>} f  field patch, JSON SCALARS ONLY
 */
```

**Rules that are part of the contract:**

- **`f` values are JSON scalars or `null`.** No nested objects, no arrays. `null` means *the
  register is cleared* and is a first-class value (§9.3 of ADR 004 depends on this).
- **One op = one stamp.** `ts` is the LWW stamp for every field in `f`.
- Ops are **immutable and append-only**. There is no update-op and no delete-op.
- **No `deps`, no vector clock, no causal metadata.** Because every op is an independent field
  assignment, causal delivery is not required for correctness. An op patching `text` on an
  entity we have never seen creates a partial register set that becomes renderable when the rest
  arrives. This removes dependency stalls, buffering and deadlock as a bug class; the price is
  transient partial visibility, handled by the `renderable()` predicate (§5, step 3).
- **No pre-image and no inverse payload.** Undo pre-images are local-only (§7) and never
  transmitted.
- **`gid` has no effect on merge.** Groups are atomic for undo, never across devices. Partial
  delivery of a group leaves a consistent board that converges when the rest arrives.

### 2.1 Reserved field names

Fields beginning with `_` are v2 machinery. Fields beginning with `pub.` are the family
publication namespace (ADR 004). Everything else is a v1 product field, carried verbatim.

| field | on | meaning |
|---|---|---|
| `_alive` | every entity | `false` = tombstone. Absent or `true` = live. **Its own register** — a later text edit does not resurrect. |
| `_born` | every entity | write-once; the create stamp. Canonical sort key. |

---

## 3. Op kinds — eight, and every v1 mutation mapped

| kind | space | entityKey | who may write (see §4) |
|---|---|---|---|
| `note.set` | personal | `note:<uuid>` | my attested devices |
| `bar.set` | personal | `bar:<uuid>` | my attested devices |
| `cat.set` | personal | `cat:<uuid>` | my attested devices |
| `pad.set` | personal | `pad:<YYYY-MM>` | my attested devices |
| `pref.set` | **local** | `pref:app` | this device; never synced, never undoable |
| `pub.set` | family | `fnote:<mem>/<uuid>` · `fbar:<mem>/<uuid>` | the owner `<mem>`; the admin (unshare only); a co-editor (§4.3) |
| `member.set` | family | `member:<memberId>` | the member themselves; the admin (`_alive:false` only) |
| `space.set` | family | `space:<spaceId>` | the admin at that stamp (chain-resolved, §4.1) |

### 3.1 Field tables

`src/js/core/ops.js` exports one `FIELDS` table. Every downstream agent reads it; nobody
invents a field.

```js
export const FIELDS = {
  note: {                                    // personal space — THE TRUTH
    date:          { t: 'date',  coEdit: true  },
    text:          { t: 'str80', coEdit: true  },
    categoryId:    { t: 'id',    coEdit: false },   // A3: never published, at any level
    repeatsYearly: { t: 'bool',  coEdit: true  },
    visibility:    { t: 'enum',  values: ['privat','belegt','geteilt'], gov: true },
    coEdit:        { t: 'bool',  gov: true },
    _alive:        { t: 'bool',  gov: true },
    _born:         { t: 'stamp', writeOnce: true },
  },
  bar: {
    startDate:  { t: 'date',  coEdit: true },
    endDate:    { t: 'date',  coEdit: true },
    label:      { t: 'str40', coEdit: true },
    categoryId: { t: 'id',    coEdit: false },
    visibility: { t: 'enum',  values: ['privat','belegt','geteilt'], gov: true },
    coEdit:     { t: 'bool',  gov: true },
    _alive:     { t: 'bool',  gov: true },
    _born:      { t: 'stamp', writeOnce: true },
  },
  cat: {                                     // personal only — A3
    name: { t: 'str' }, nameEn: { t: 'str' }, paletteRef: { t: 'str' },
    visible: { t: 'bool' },
    defaultVisibility: { t: 'enum', values: ['privat','belegt','geteilt'] },  // 16.4
    _alive: { t: 'bool' }, _born: { t: 'stamp', writeOnce: true },
  },
  pad: { text: { t: 'str' }, _alive: { t: 'bool' }, _born: { t: 'stamp', writeOnce: true } },
  pref: { '*': { t: 'any', local: true } },  // free-form, local, never undoable, never synced

  fnote: {                                   // family space — THE PUBLICATION
    'pub.level':         { t: 'enum', values: ['privat','belegt','geteilt'], gov: true },
    'pub.coEdit':        { t: 'bool', gov: true },
    'pub.alive':         { t: 'bool', gov: true },
    'pub.date':          { t: 'date', coEdit: true },
    'pub.text':          { t: 'str80', coEdit: true, geteiltOnly: true },
    'pub.repeatsYearly': { t: 'bool', coEdit: true },
    _born:               { t: 'stamp', writeOnce: true, gov: true },
  },
  fbar: {
    'pub.level':     { t: 'enum', values: ['privat','belegt','geteilt'], gov: true },
    'pub.coEdit':    { t: 'bool', gov: true },
    'pub.alive':     { t: 'bool', gov: true },
    'pub.startDate': { t: 'date', coEdit: true },
    'pub.endDate':   { t: 'date', coEdit: true },
    'pub.label':     { t: 'str40', coEdit: true, geteiltOnly: true },
    _born:           { t: 'stamp', writeOnce: true, gov: true },
  },
  member: {
    displayName: { t: 'str' }, colorRef: { t: 'str' },
    _alive: { t: 'bool' }, _born: { t: 'stamp', writeOnce: true },
    // one register per device: key `dev.<deviceShort>`, value = b64url device attestation
    'dev.*': { t: 'str', writeOnce: true },
  },
  space: {
    name: { t: 'str' },
    admin: { t: 'id' },          // memberId — the admin chain, §4.1
    adminPrev: { t: 'opId' },    // the opId this transfer supersedes; null at genesis
    epoch: { t: 'int' },         // informational mirror of the key epoch (ADR 002 §4)
  },
};
```

>  **Amended 2026-08-27 — `_born` was missing from `fnote` and `fbar`.** §4.3 stage 3a already
>  names it a governing family field ("`pub.level`, `pub.coEdit`, `pub.alive`, **`_born`**"), and
>  ADR 004 §5's transition table writes `'_born'` in the Privat→Belegt and Privat→Geteilt rows —
>  so the register was normative everywhere except in the table that declares it. Without it the
>  first publication cannot carry its create stamp and `createdAt` (§1.4) is undefined for every
>  foreign entry, which 17.6 renders. Corrected by `judge:conformance` B-5 against
>  `src/js/core/ops.js:154-160, 168`, which has carried the field since WP-1.

**There is no `owner` field anywhere.** Owner is the `<memberId>` segment of the family entity
key, and in the personal space it is trivially me (single-writer space). See §4.

**There is no `seriesId` field.** v1 already satisfies 9.3 with one object: a repeating note *is*
its series (`store.js`, `layout.js:71-76`). `seriesId` is **defined as an alias of the entity
uuid** so that LZP-404, A4 and any downstream API can use the word — and because the family key
`fnote:<mem>/<uuid>` is uuid-addressed, moving a repeat's anchor (`interact.js:330-334`) cannot
change what the family record points at. **Downstream agents must not invent occurrence
entities.** A4 ("series-level visibility, no per-year exceptions") is then free: there is exactly
one `visibility` register per series.

### 3.2 Every v1 `store.mutate()` site → ops

All 22 sites (recon §2.1). `[L]` = also produces a `pref.set` in the `local` space, outside the
transaction and therefore not undone — deliberately reproducing v1's behaviour that
`settings.lastCategoryId` survives ⌘Z (recon B5).

| # | v1 site | v1 label | v2 ops (one `gid` unless noted) |
|---|---|---|---|
| 1 | `interact.js:72` | `delete` | `note.set{_alive:false}` **or** `bar.set{_alive:false}` (branch on `selection.type`; the v1 label lied, the op does not) |
| 2 | `interact.js:307` | `create-bar` | `bar.set{_born,startDate,endDate,label:'',categoryId,visibility,coEdit:false,_alive:true}` + `cat.set{visible:true}` if `ensureVisible` fired |
| 3 | `interact.js:324` | `move-note` | `note.set{date}` — repeat branch keeps the anchor year (v1 semantics verbatim) |
| 4 | `interact.js:341` | `move-bar` | `bar.set{startDate,endDate}` — **absolute values, never a delta** |
| 5 | `interact.js:352` | `resize-bar` | `bar.set{startDate?}` and/or `{endDate?}` |
| 6 | `interact.js:543` | `create-note` | `note.set{_born,date,text,categoryId,repeatsYearly:false,visibility,coEdit:false,_alive:true}` + optional `cat.set{visible:true}` `[L]` |
| 7 | `interact.js:565` | `edit-note` | `note.set{text}` (+`{categoryId}`) **or** `note.set{_alive:false}` when the text empties `[L]` |
| 8 | `interact.js:592` | `edit-bar` | `bar.set{label}` (+`{categoryId}`) `[L]` |
| 9,10 | `interact.js:618, 631` | `pad` | `pad.set{text}` on `pad:YYYY-MM`, or `{_alive:false}` when empty. **The 600 ms debounce is the op boundary** (recon B9) so ⌘Z is not per keystroke. |
| 11 | `popover.js:159` | `create-note` | as #6, **but NOT `[L]`** — this site only *reads* `lastCategoryId` (`popover.js:158`); it never writes it |
| 12 | `popover.js:183` | `recategorise` | `note.set{categoryId}` `[L]` |
| 13 | `popover.js:202` | `toggle-repeat` | **ON:** `note.set{repeatsYearly:true, date}` — one op, two fields, one stamp (9.5: the series is anchored to the occurrence the user was looking at). **OFF:** `note.set{repeatsYearly:false}` **only** |
| 14 | `popover.js:217` | `delete-note` | `note.set{_alive:false}` |
| 15 | `popover.js:236` | `recategorise-bar` | `bar.set{categoryId}` `[L]` |
| 16 | `popover.js:266` | `edit-note` | `note.set{text}` **or** `note.set{_alive:false}` when the text empties. **NOT `[L]`, and no `{categoryId}`** — there is no category picker in this row, so #7's `(+{categoryId})` and its `[L]` do not carry over |
| 17 | `legend.js:35` | `toggle-category` | `cat.set{visible}` |
| 18 | `legend.js:76` | `add-category` | `cat.set{_born,name,nameEn,paletteRef,visible:true,defaultVisibility:'privat',_alive:true}` |
| 19 | `legend.js:114` | `rename-category` | `cat.set{name}` or `{nameEn}`; the DE-rename path emits `{nameEn: null}` explicitly, reproducing `legend.js:116` — **`null` is a value, `undefined` is not representable** |
| 20 | `legend.js:129` | `recolor-category` | `cat.set{paletteRef}` |
| 21 | `legend.js:152` | `delete-category` | `cat.set{_alive:false}` `[L]` |
| 22 | `legend.js:197` | `delete-category` (reassign) | **fan-out:** N×`note.set{categoryId}` + M×`bar.set{categoryId}` + `cat.set{_alive:false}`, **one `gid`** so ⌘Z stays one step (recon B1/B6) `[L]` |

>  **Amended 2026-08-27 — three rows of this table were wrong about the v1 source.**
>  · **Row 13:** v1 assigns `date` on the ON branch **alone**
>  (`git show 66126e9:src/js/popover.js:205-208` — `if (x.repeatsYearly) x.date = date`).
>  Re-writing an unchanged date at a fresh stamp would let a toggle beat a concurrent remote move
>  for no reason. `src/js/core/ops.js:875-884` implements the corrected reading and **throws** if
>  ON carries no anchor date (9.5); pinned by `tests/tier1/core-ops.test.js:1087` and
>  `tests/tier1/layout.test.js:1048`.
>  · **Rows 11 and 16:** neither site writes `lastCategoryId`, so neither is `[L]`, and row 16 has
>  no category picker at all. `src/js/core/ops.js:845-848, 903-905` both carry the correction as a
>  source comment. Caught by `judge:conformance` B-3/B-4.

Every entry op addresses its target **by id and by an absolute target value**. A single
"reassign everything pointing at X" op would be non-commutative — its effect would depend on
which entities the folding device had already seen — and would break §6. There is not one
relative op in the system.

**New v2 sites** add: `note.set/bar.set {visibility}` (LZP-702), `{coEdit}` (LZP-902),
`cat.set {defaultVisibility}` (LZP-703), `member.set {displayName,colorRef}` (LZP-603),
`space.set {name,admin,adminPrev}` (LZP-605), and the `pub.set` ops that ADR 004's projection
derives.

### 3.3 Settings emit no synced ops. Ever.

All 15 `setSettings` and 7 `setLayer` call sites keep v1 semantics exactly: they become
`pref.set` ops in the `local` space — persisted, not undoable, **never synced**.

Reasons, decided once: every field is device-local presentation state (`mode`, `startMonth`,
`pageYears`, `rowHeight`, `colWidth`, `paper`, `language`, `bundesland`, layer toggles,
`launchAtLogin`, `menuBarIcon`, `seenFirstRun`); 17.7 explicitly establishes per-device density
as correct; and `settings.js:143,147` fire on every `input` event of a range slider, so a synced
settings op would be a per-pixel op storm.

**Consequence for 19.4** ("my *entire* board syncs between my devices"): **board means content** —
notes, bars, categories, scratchpads. Settings are presentation and stay per device. This is the
reading 17.7 endorses and it is stated here so nobody re-litigates it in a ticket.

v2 adds three device-local prefs: `settings.deviceId`, `settings.lastSeenSeq` (a map
`spaceId → seq`, for 17.5's "neu" markers), `settings.hiddenMembers` (an array of memberIds, for
17.3), and `settings.density` (17.7).

>  **Not yet enforced at the seam — finding F-7, owner WP-8.** "Never synced" is true of every
>  *local* door and false of the *remote* one: `store.applyRemote()` has **no space filter**, and
>  `authz.js:672-675` takes the `else` branch for `spaceClassOf('local')`, which only checks
>  `op.act === me`. A `pref.set` arriving over the wire under my own member id is folded, moving the
>  `rowHeight` and `layers.feiertage` registers while `state.settings` — which `_project()`
>  deliberately does not re-derive — keeps the old values. In solo mode `board.json` wins at the
>  next launch and the change is silently **discarded**; once a checkpoint exists the checkpoint
>  wins and **the drawn Feiertage layer changes under the user with no gesture behind it**. The fix
>  is one line at the `applyRemote` seam: drop `space === 'local'` ops. Measured by
>  `judge:conformance` probe p6 test 1 and `tests/attack/round3-seam.test.js` R3-3/R3-4.

---

## 4. Authorization — a pure function of the op set

Authorization must not depend on fold order, or convergence dies: whether Mama may write
`pub.text` depends on `pub.coEdit`, which is itself a register that may change. So it is
evaluated in **stages**, each a fold over the same immutable set, each reading only the *final*
values of earlier stages.

`src/js/core/authz.js` — `foldAuthorized(ops) → RegisterMap`.

### 4.0 Stage 0 — device attestation

An op is admitted at all only if `op.dev` is an attested device of `op.act`. **`deviceShort` is a
function of the signing key (§1.2) and cannot be computed from `op.dev`, so this is a LOOKUP, not a
hash** (the full resolution is ADR 002 §5.2): the registers `member:<act>` → `dev.<short>` are
decoded to their `DeviceAttestation` payloads, and `op.dev` is admitted iff some decoded attestation
on `member:<act>` satisfies **all four** of

- `attestation.deviceId === op.dev`,
- `attestation.memberId === act`,
- the register name equals `attestation.deviceShort`, and
- the signature verifies under **that member's** recovery key.

The fold therefore needs the **payload**, not a boolean: the injected verifier is
`attestOpen(memberId, blob) => DeviceAttestation|null`, not `attestVerify(memberId, blob) => bool`.
Personal- and local-space ops are checked against the local device set instead; where the caller
does not supply it, the check degrades to `op.act === me`, which is all §4.4 claims for the personal
space — **and see the amendment note below, because that degradation is a WP-8 blocker.**

`dev.*` registers are **write-once** and admissible only from `op.act === memberId` — a member
can add devices to their own record and to nobody else's. **Write-once here is an ADMISSIBILITY
rule, not the LWW join:** only the minimal claim under `≺` is admitted and every later claim is
rejected outright, because an attestation that could be *replaced* at a greater stamp is exactly the
key-injection hole ADR 002 §2.3 exists to close.

**Stage 0 does not regress infinitely.** The ops that *create* attestations are themselves ops. A
`member.set` patch consisting **solely** of `dev.*` registers is therefore **self-authorizing** on
`op.act === memberId` — requiring an already-attested device to author an attestation has no base
case. A patch that **mixes** `dev.*` with ordinary member fields has two predicates and no single
answer and is **refused whole**.

**An op whose attestation has not yet arrived is PARKED, not rejected** (§7.4). There is no causal
delivery in this system (§2), so a member's first content op arriving before their attestation op is
ordinary, not hostile — and a rejection is *final*, which makes it silent data loss on first contact
and on every partial pull.

>  **Amended 2026-08-27, four ways, and one of them is a live defect.**
>  · **The lookup.** `dev.<deviceShort(op.dev)>` was unimplementable — see §1.2. Corrected by
>  `judge:conformance` Part C against `src/js/core/authz.js:159-173, 591-663`, which has
>  implemented the lookup since WP-1. **This is the item that was blocking WP-6; it is now closed.**
>  · **Self-authorizing bootstrap** and **write-once as admissibility** were both discovered while
>  building `authz.js` (`:612`, `:626-644`) and recorded in `docs/v2/contracts/ops.contract.js`;
>  §4.0 never said either.
>  · **Park, don't reject.** Finding **F-6**: `authz.js:671` rejects an unattested-device op and
>  `store.js:699-703` then drops it without appending it to the log, so it is never re-evaluated.
>  Reproduced by probe `p4` — the *same op set* admits the op once the attestation is present.
>  Owner: **WP-8**.
>  · **The `act === me` degradation is not benign.** Finding **H-4** (`tests/attack/round3-seam.test.js`
>  R3-40/41) measured two store instances over one board: stamps and opIds agree exactly as §8.1
>  promises, but `_me` is ephemeral per process, so each refuses the other's ops with `notMyAct` and
>  **nothing merges**. Any fleet test that mints its ops with the receiving store's own `_me` is a
>  false green. ADR 002 §2.2's durable identity must land before `applyRemote` can admit a real peer.

### 4.1 Stage 1 — the admin chain (governance)

The admin is resolved **entirely from the op set** — never from a server column. This closes the
flaw where a compromised relay could rewrite a `roleHistory` table and thereby flip the validity
of an admin unshare, making previously-hidden content reappear on family boards.

`space.set` ops carrying `{admin, adminPrev}` form a chain:

- **Genesis link:** the space-create op has `adminPrev: null` and `admin: <creator>`; it is
  admissible only if `op.act === op.f.admin`.
- **Transfer link:** admissible only if `op.act === admin(link named by adminPrev)` and
  `adminPrev` names an already-accepted link.
- The accepted chain is the **longest valid chain from genesis**; ties broken by the greater
  `ts` of the disputed link. `admin@stamp` is then a deterministic point-in-time query over that
  chain — an input to later stages, and itself part of the op set.
- `space.set{name}` is admissible only from `op.act === admin@op.ts` (20.1).

### 4.2 Stage 2 — membership

- `member.set{displayName, colorRef}` — admissible **only** if `op.act === memberId` (15.6:
  self-edit, no admin involvement).
- `member.set{_alive:false}` — admissible if `op.act === memberId` (leave, 20.3) **or**
  `op.act === admin@op.ts` (remove, 20.2). **From nobody else.** There is no op in this system
  by which one member can purge another member's content.
- `currentMembers = { m : member:m exists ∧ _alive !== false }`.

### 4.3 Stage 3 — content

**Personal space** (`note/bar/cat/pad.set`): admissible iff `op.dev` is in my attested device
set. The personal space has exactly one writing human, so there is nothing else to check.

**Family space** (`pub.set` on `fnote:<M>/<uuid>` or `fbar:<M>/<uuid>`), evaluated in two
sub-stages:

- **3a — governing fields** `pub.level`, `pub.coEdit`, `pub.alive`, `_born`.
  Admissible iff `op.act === M` (the owner, read straight out of the entity key)
  **or** the op is an **admin unshare**: `op.act === admin@op.ts` and the patch is exactly
  `{ 'pub.level': 'privat', ...all other pub fields → null }` (18.3). No other admin write to
  another member's entity exists.
- **3b — content fields.** Admissible iff `op.act === M`, **or** all of:
  `pubCoEdit(e) === true` ∧ `pubLevel(e) === 'geteilt'` ∧ `op.act ∈ currentMembers`
  ∧ every field in `f` has `FIELDS[kind][field].coEdit === true`.

**Both predicates read only *family* registers** (`pub.coEdit`, `pub.level`) — never the owner's
truth `visibility`/`coEdit`, which a peer does not have and could never evaluate. This is the
correction to a design that would otherwise have been unevaluable on exactly the machines that
must evaluate it.

**Co-editing requires Geteilt.** A Belegt entry has no readable text; co-editing dates you can
see while the text stays hidden is incoherent. The three-state control disables the co-edit flag
unless the level is Geteilt (LZP-702/902).

### 4.4 Why ownership cannot be stolen

Every reviewed proposal resolved ownership as "the author of the write with the smallest stamp".
Stamps have no lower bound, so a member running a modified client could emit an owner write
backdated to `ms = 0` and take over any entity — defeating 18.1 with one line.

**This design has no `owner` register at all.** The owner is a literal segment of the entity key
that the ciphertext is bound to, and admissibility compares it to `op.act`, which is bound to a
device attestation, which is bound to the member's recovery key. There is nothing to backdate.

The corresponding personal-space property is trivial: only my own attested devices hold `PSK`.

### 4.5 The one server-side gap, escalated rather than reinterpreted

**LZP-901 asks for "client UX + server-side validation" that non-owners cannot mutate. The
server-side half is impossible without breaking 21.1**, because ownership lives inside the
ciphertext and the relay holds no keys. What the server *can* validate: that the pushing device
belongs to a non-removed member of that space, and that the device signature is valid.

Content-level ownership is enforced by the deterministic fold above, which every honest client
applies identically — a malicious member's ops are rejected by every peer, not by the relay.
**This is a spec contradiction and must be raised with the PO before LZP-901 starts (Gate 1),
not silently reinterpreted.** It is item R7 in `docs/v2/PLAN.md`.

---

## 5. Materialization — registers → the exact v1 state shape

`src/js/core/materialize.js`. **The contract: for a solo board the output is deep-equal to what
`store.state` holds in v1.** `layout.js` and `board.js` are unchanged for solo mode.

```js
/**
 * @param {RegisterMap} regs
 * @param {{ me: string, members: Map<string, Member>, familySpaceId: ?string,
 *           hiddenMembers: Set<string>, prefs: Object, lastSeenSeq: Object }} ctx
 * @returns {V1State}  { schemaVersion, notes[], bars[], categories[], scratchpads{}, settings{} }
 */
export function materialize(regs, ctx) { … }
```

**Algorithm, in order:**

1. **Project each entity.** `entity[field] = register.value`, **skipping registers whose value
   is `null`**. `null` means cleared/redacted and is never a value.
2. **Choose the scope.**
   - **Own entity** (`note:`/`bar:` in the personal space) → read *truth* fields, then apply
     **promotion**: for each co-editable field,
     `effective[f] = maxByStamp( truth[f], pub[f] where pub[f].author !== me )`,
     **and never any `pub[f]` at all while my publication stands withdrawn by a third party.**
     **Never promote my own `pub.*` writes.** They are projections *of* the truth, not edits
     *to* it — which is exactly why publishing `pub.text: null` for a Belegt downgrade does not
     blank my own note. *This single asymmetry is the correctness heart of ADR 004; it carries a
     comment in the source and property test P7.*

     > **Amended 2026-08-27 — the formula as written contradicted 18.3.** An admin unshare is one
     > op, so its `pub.text: null` carries `author === admin ≠ me` at a stamp newer than my truth;
     > the unqualified formula promotes it, step 1 skips `null`, and **my own note goes blank on my
     > own board from a register I did not write** — while 18.3 says the entry "reverts to
     > owner-private and is **never deleted**". The discriminator is local and exact:
     > `pub.level === 'privat'` (or `pub.alive === false`) authored by someone other than me can
     > only be an admin unshare, because `pub.level` is `gov: true` and §4.3 stage 3a admits it
     > from the owner or the admin alone. The tempting alternative — *never promote a `null`* — is
     > **wrong**: 18.2/R9 needs a co-editor's explicit `pub.text: null` to reach my truth, `null`
     > being a first-class value (ADR 004 §5.1) and not a synonym for absent. Corrected by
     > `judge:conformance` B-9 against `src/js/core/registers.js:493-542` (`withdrawnByOther`),
     > which implements the qualifier and flags the contradiction in place.
   - **Foreign entity** (`fnote:<M>/…`, `M ≠ me`) → read `pub.*` only. Truth fields for foreign
     entities cannot exist, because they were never transmitted.
3. **Filter.** Drop if `_alive === false` / `pub.alive === false`; if foreign and
   `pub.level` is absent or `'privat'`; if `M ∉ currentMembers` (this is what makes 20.2
   instantaneous and needs no crypto and no purge op); if `M ∈ ctx.hiddenMembers` (17.3);
   if not **renderable**:
   ```
   renderable(note) = own ? has text                                          ← v1's array
                          : has date && (pub.level === 'belegt' || has pub.text)
   renderable(bar)  = own ? true                                              ← v1's array
                          : has startDate && has endDate
   ```
   > **AMENDED 2026-08-27 (A3-H2).** The predicate now splits own from foreign, and the two
   > halves answer two different questions.
   >
   > **The FOREIGN half is unchanged and its rule is unchanged:** renderability is checked
   > against explicit fields and never inferred from absence. A Geteilt note whose `pub.text` op
   > has not arrived yet is *invisible*, not "Belegt". Meaning is never inferred from a missing
   > field — that is the bug class ADR 004 exists to prevent, and every word of it is about the
   > redaction path.
   >
   > **The OWN half is not a visibility question at all.** For my own entries there is no
   > redaction, no partial arrival and nothing to infer: the register set is the file. The
   > predicate's only job there is to reproduce **v1's array membership**, because `layout.js` is
   > the same file in both builds — an entry that is in the array is drawn exactly the way it
   > always was, and an entry that is not is one the user had before the upgrade and does not
   > have after it. v1 keeps a note with no date (it simply lands on no day row) and paints a bar
   > with no `endDate` to the far edge of the visible window, so requiring a date here was
   > dropping entries v1 kept — and one autosave later dropping them out of `board.json`. That
   > was A3-H2's five-shape loss, and it is the reason `migrate1to2.js` §4b coerces rather than
   > drops: the door keeps the entry, and this step must not throw it away again one layer down.
   >
   > **The one own-side exception**, and it is a crash and not a policy: a note with
   > `repeatsYearly` true and no anchor date. `layout.js:72` expands it with
   > `Number(n.date.slice(0, 4))` and takes the whole board down. There is no v1 rendering of
   > that shape to preserve, only a v1 crash, so it stays out of the array. Both doors also
   > refuse to mint it (the flag follows the anchor), which makes this the braces to their belt.
   >
   > Implemented in `src/js/core/entities.js` (`renderableNote` / `renderableBar`), pinned by
   > `tests/tier1/core-materialize.test.js` and by the H-2 rows in
   > `tests/attack/upgrade-day-migration.test.js`.
4. **Decorate** with the v2-additive, v1-ignored fields:
   `{ ownerId, isForeign, visibility, level, coEdit, memberColorRef, initial, redacted,
      createdAt, updatedAt, updatedBy, isNew, exposure }`.
   `layout.js:142/196` branch on `isForeign` — **never** fall through to `colorOf(undefined)`,
   which silently returns `PALETTE[0]` (blue, `palette.js:28`) and would render a foreign entry
   as one of mine.
5. **Sort deterministically.** Mandatory, not cosmetic: v1's capacity slice (`layout.js:209`)
   and per-column lane rescue (`layout.js:162-177`) are order-sensitive, so array order is
   user-visible (stories 2.4, 2.5, 3.8).
   - `notes` — `(_born asc, id asc)`
   - `bars` — `(_born asc, id asc)`, the **same** comparator as notes and categories, and for the
     same reason: `_born` carries the v1 array index (§8.1), and only a `_born` sort satisfies
     §8.3's "deep-equals … including array order" for bars. A date sort throws that index away. It
     costs nothing at render time — `assignLanes` re-sorts its own input by
     `(startDate, endDate desc, id)` internally (`layout.js:38-44`), so lane assignment is
     order-independent either way; what array order still decides is `seg.labelRow`, and on upgrade
     day the user's own file order is the answer that moves nothing.
   - `categories` — `(_born asc, id asc)`, so `categories[0]` (the dangling-reference fallback)
     is deterministic
   - `scratchpads` — object built with **sorted keys**, so `JSON.stringify` comparisons in tests
     are stable. **This property is true at this layer and is discarded one layer up** — see
     finding **F-1**: `store.js:368 reconcileMap` `Object.assign`s into the live state object and
     never reorders it, so the shipped `board.json` carries insertion order in the session that
     created the pads and sorted order after a relaunch. The sort is unit-tested where it holds
     (`tests/tier1/core-ops.test.js:1302`) and violated where it ships. Open, and a **PO decision**
     rather than a repair, because the one-line fix rewrites `board.json`'s bytes for existing
     users on their next save.

   > **Amended 2026-08-27 — the bar comparator above was the wrong sort.** STATUS §6 mis-located
   > this amendment in §8.3; §8.3's acceptance criterion is **correct as written** and it is this
   > bullet that was false. Corrected by `judge:conformance` B-2 against
   > `src/js/core/entities.js:694-704 cmpBars`, which carries the same correction as a source
   > comment and is pinned by the §8.3 deep-equal AC (property P8).

   For a single device `_born` order **is** v1 insertion order, and migration (§8) preserves the
   v1 array index inside the stamp — so a migrated solo board renders byte-identically to v1.
6. **Settings** come from the `local` space's `pref:app` registers merged over
   `defaultState().settings`, with the same defensive nested spread as `store.js:76-80`.
7. **Reference repair is a projection invariant, not a mutation.** A note whose `categoryId`
   names a dead or unknown category projects with `categoryId = categories[0].id` — v1's
   `store.js:82-88` rule, lifted into the projection so it is idempotent and never rewrites the
   log. This matters because "create note in category X" concurrent with "delete category X" is
   a real race at family scale.

### 5.1 One materializer, no incremental path

`materialize()` is a full rebuild and there is **no second incremental implementation** in the
foundation. Two code paths guarded by an equivalence test are two code paths, and the fast one
is the one that gets a clever optimization at 2 a.m.

Budget, asserted in LZP-1007 against `tests/fixtures/family-8x2y.json` (8 members × 2 years,
≈6 000 entries): **full materialize < 40 ms**. The mutation rate is low by construction — the
scratchpad is debounced 600 ms, drags emit on commit only, and v1 already rebuilds the whole DOM
on every `emit()` (`board.js:26`). If the budget fails, an incremental applier becomes its own
ticket with its own equivalence property test; it does not enter the foundation on speculation.

---

## 6. Convergence — the argument

**Claim.** For any finite multiset `S` of admissible ops and any two enumerations `π₁, π₂` of `S`
(arbitrary permutation, arbitrary duplication), `materialize(fold(π₁)) ≡ materialize(fold(π₂))`,
structurally equal including array order.

**Proof.**

1. *The register store is a join-semilattice.* It is a finite product of independent cells keyed
   by `(entityKey, field)`. Each op contributes a finite set of writes `(key, value, stamp,
   author)`. The update rule is `cell ← max_≺(cell, write)` where `≺` orders writes by their
   stamp string, with the write's `opId` as an unreachable final tiebreak.
2. *`≺` is a strict total order on all writes ever generated.* `deviceShort` is unique per
   device (80-bit hash of a distinct public key); the counter strictly increments per local
   event within a device; therefore two distinct writes from the same device differ in
   `(ms, ctr)` and two writes from different devices differ in `deviceShort`. Two *copies of the
   same op* tie, which idempotence handles.
3. `max` over a totally ordered set is **associative, commutative and idempotent**. A finite
   product of ACI operations is ACI. Therefore `fold` is order-independent and
   duplicate-insensitive. ∎ *(registers)*
4. *Admissibility does not depend on fold order.* §4 evaluates it in stages, each a fold over the
   same immutable `S`, each reading only the **final** values of earlier stages. Stage 1's chain
   resolution sorts `space.set` links by `≺` before applying them, so it is deterministic.
   Ownership is not resolved at all — it is read out of the entity key. Therefore admissibility
   is a function of `S`, not of the enumeration. ∎ *(authorization)*
5. *Materialization is a pure deterministic function of the registers.* Every sort in §5 step 5
   is by a totally-ordered key. Equal registers ⇒ identical output. ∎

**Corollaries, each a required guarantee:**

- **Reorder-, duplicate- and interleave-invariance.** Immediate from 3. Duplicate delivery needs
  no dedupe *for correctness* (a `seen` set is a performance optimization only).
- **Monotone reads.** Every register only moves *up* the stamp order, so a late-arriving older op
  can never undo an applied newer one. A three-weeks-late op either genuinely wins or is silently
  absorbed. **This is why 19.6 needs no special handling.**
- **Delete/edit races converge.** `_alive` is its own register. Delete at `A`, edit at `B > A`
  ⇒ dead, with an unread new text. A resurrect requires an explicit `_alive:true` at a stamp
  `> A` — which is exactly what undo emits (18.6), and it brings back the *newest* content
  because the content registers were never cleared.
- **Fan-out converges.** `legend.js:197` is N+M+1 independent register writes in one `gid`.
  The group has no cross-device atomicity requirement; partial delivery leaves a consistent
  half-reassigned board that converges when the rest arrives.
- **Concurrent move + edit of the same note converge to "both applied"** — different fields,
  different registers. That is the correct family behaviour and it is what 18.5 describes.
- **Checkpoint transparency.** See §7.2.

**The two ways this is normally broken, and how we avoid them:**

1. **Relative ops** (`move-bar` by delta). Applied twice, it moves twice. We emit **absolute**
   values everywhere (§3.2).
2. **Order-dependent authorization.** Handled by the staged fold (§4). The faster alternative —
   evaluating admissibility during a single streaming fold — is wrong.

---

## 7. Undo, tombstones, checkpoints, parking

### 7.1 Undo — inverse ops, own actions only (LZP-405 · stories 5.4, 18.4, 18.6)

`store.mutate(label, fn)` is **replaced** by `store.txn(label, fn)`. `fn` receives an op builder,
not the state. The rewrite at each of the 22 sites is mechanical: branching, `return false`
declines and reads of current values all stay; only the *assignment* lines become builder calls.

```js
// before — interact.js:324
store.mutate('move-note', (s) => {
  const n = s.notes.find(x => x.id === id);
  if (!n) return false;
  n.date = n.repeatsYearly ? reanchored : target;
});

// after — same shape, same declines, same synchronous return
store.txn('move-note', (tx) => {
  const n = tx.get('note', id);
  if (!n) return false;                       // ← the v1 decline protocol, verbatim
  tx.note(id).set({ date: n.repeatsYearly ? reanchored : target });
});
```

```js
tx(label, fn) {
  const t = makeTx(this);
  const r = fn(t);
  if (r === false || t.ops.length === 0) return r;   // store.js:150, verbatim
  const pre = t.preImages();                         // from registers, PRE-state, synchronous
  for (const op of t.ops) this._apply(op);
  this._materialize();
  this.undoStacks.push(t.gid, label, pre, t.postImages());
  this.redoStack.length = 0;
  this.schedulePersist();
  this.emit(label);                                  // ← STILL SYNCHRONOUS (§0.9)
  queueMicrotask(() => this._publishAndEnqueue(t));   // seal + outbox, never before emit
  return r;
}
```

Rules, each mapping to a hazard the recon found:

| # | rule | closes |
|---|---|---|
| U1 | One user action = one `gid`; `undo()` inverts the whole group atomically. `legend.js:197`'s N+1 ops are one ⌘Z. | B1 |
| U2 | Only `txn()` writes the stacks. `applyRemote()` writes neither, and **never clears redo**. | B2, B4, 18.4 |
| U3 | Pre-images are captured from the registers at emit time and stored **locally only** — never in an op, never on a wire, never on a server. | privacy |
| U4 | `undo()` **emits fresh ops with new opIds and new stamps** through the same path a user action takes. It therefore competes for LWW like any other write and can legitimately lose to a newer remote change. Never `_applyContent(snapshot)`. | B3, 18.6 |
| U5 | The 50-step limit counts **groups**, not ops (v1's user-visible "~50 steps", 5.4). | B6 |
| U6 | `pref.set` carries no `gid` and is never undone — v1 parity for `lastCategoryId`, now by design. | B5 |
| U7 | The stacks are in-memory and per device, exactly as v1 (`store.js:104`). "My laptop undid what I did on my desktop" is a worse surprise than "undo knows this Mac". | 18.4 |
| U8 | `txn → apply → materialize → emit` is **strictly synchronous**. Sealing and outbox enqueue happen in a `queueMicrotask` after `emit()`. Any downstream agent who makes this path async breaks bar-label editing at `interact.js:316-318`. **There is a test for this.** | B8 |
| U9 | The scratchpad's 600 ms debounce is the op boundary. | B9 |
| U10 | Import and snapshot restore clear both stacks (5.4 excludes import). | B7 |

**Inverse computation.** For each op in the group, produce a patch of the same fields with their
pre-values (`null` where the register did not exist). The inverse of a create (`_born` present)
is `{_alive: false}` with `_born` removed. Undo of a delete is `{_alive: true}` on the **original
entity id** — the convergence-friendly reading of 18.6's "restores the entry as a *new* shared
operation": a *new op*, the *same entity*, so a peer that already tombstoned sees a resurrect on
the same key rather than a duplicate.

**Two mechanical guards on "does undo still behave like v1?" (Risk R5):**

- **Shadow-undo assertion.** When `DEV` is on, `store.txn()` additionally captures a v1-style
  `_contentClone()` pre-image; `store.undo()` applies the inverse ops and then deep-compares
  against the shadow, throwing on mismatch. The whole tier-1 + regression suite runs with it on.
  ~25 lines. *There is no build step in this project — the app is served as raw ES modules by
  both `dev-server.mjs` and the Swift `WKURLSchemeHandler` — so `DEV` is a module constant
  (`src/js/core/dev.js`: `export const DEV = !!globalThis.__LZP_DEV;`) set by tests and by
  `dev-server.mjs`, never by the shell.*
- **Property test P6.** A reference implementation of v1's snapshot undo runs *beside* the
  op-log undo over randomly generated action sequences, comparing materialized state after every
  step. This is strictly more general than the shadow assertion, because it does not only cover
  what the regression suite happens to exercise.

**Solo-equivalence theorem (LZP-402's acceptance criterion).** With one device and no remote ops,
for any sequence of user actions `A₁…Aₙ`, `undo()` restores exactly the fields written by `Aₙ` to
the values they held immediately before `Aₙ`. *Proof:* `pre` is captured immediately before
applying `Aₙ`'s ops and covers exactly the `(entity, field)` pairs `Aₙ` writes; with no concurrent
writer no register in that set changed between capture and undo; the restoring ops carry the
newest stamps and therefore win. v1's snapshot undo restored *all* content, but only the fields
`Aₙ` touched had changed — so the two agree, except on `settings`, which v1 also did not
restore. ∎

### 7.2 Checkpoints and compaction — always safe, no coordination

```js
// src/js/core/oplog.js
export class OpLog {
  append(op)                      // O(1); one JSONL line
  ops({ space, sinceStamp })      // iterate
  checkpoint()                    // → { horizon, regs: SerializedRegisterMap, cursors, at }
  compact()                       // fold ops ≤ horizon into the checkpoint, drop those lines
  load({ checkpoint, tail })      // regs = fold(checkpoint, tail)
}
```

A checkpoint is the fold of a prefix. Because the fold is ACI with per-field stamps **retained**,
`fold(checkpoint ∪ tail) === fold(all ops)` for **any** partition — including a late-arriving op
older than the horizon, which is compared against the checkpoint's retained stamp and wins or
loses by the identical rule. There is **no coordination requirement, no peer acknowledgement and
no risk**. Property test P10 asserts exactly this, including out-of-order late ops.

This alone bounds local storage to `O(entities × fields) + recent ops + O(retained fingerprints)`.
Policy: **compact when the tail exceeds `TAIL_COMPACT_AT` lines, or on launch when it exceeds
2 MB — whichever is crossed first — and the compaction is TOTAL.**

> **Amended 2026-08-27 (round 7) — the policy sentence named three things and the code implemented
> one; both halves of the gap are closed here, in opposite directions.**
>
> **"or on launch when it exceeds 2 MB" — THE ADR WAS RIGHT AND THE CODE WAS MISSING IT. Now
> implemented.** `store.js` bounded the tail in LINES only (`TAIL_COMPACT_AT`, `min(5000,
> floor(LS_OPS_CAP × 0.75))` = 1 500), and a line is not a fixed size: one `pad.set` carrying a
> pasted page is kilobytes, and ≈260 of them are ≈3 MB while nowhere near the line cap. On the
> browser path `ops.jsonl` shares localStorage's whole-origin quota with `board.json`,
> `checkpoint.json` and `snapshots.json`. `init()` now measures the tail it has just read and
> parsed — the one moment the bytes are free — and arms `TAIL_COMPACT_BYTES`; the first
> `_persistOps` of the session consumes it. The two triggers are independent and the first one
> crossed wins. Pinned by R6-2b.
>
> **"keeping a 30-day tail for debuggability" — THE ADR WAS WRONG AND THE CLAUSE IS DROPPED.**
> `storage.truncateOps(keepFromLine)` can only drop a PREFIX of the file, and the store tracks a
> line COUNT rather than which line of the file each op is on, so a partial compaction has nothing
> to trim against; implementing it means a per-line file-position index on the hot write path. What
> it would buy is debuggability alone — this very section's losslessness result
> (`fold(checkpoint ∪ tail) === fold(all ops)` for ANY partition) is exactly the statement that a
> retained tail is worth nothing to STATE. Compaction is total, and `src/js/store.js`'s
> `TAIL_COMPACT_AT` docblock says so at the code.

> **The third term, added after the WP-1 round-2 hardening, and it is a real cost.** The bound used
> to read `O(entities × fields) + recent ops`, and that was true only while a compaction was allowed
> to decide state. It is not: once a body is folded into the checkpoint the value it displaced is
> gone, so a device that compacted between two envelopes could not reproduce a device that had
> not — the same op set converging to two different boards depending on when each side happened to
> compact. Answering a *second, different* body at a re-used opId with "duplicate" is what caused
> it, and telling the two cases apart after the line is gone needs something kept.
>
> So `checkpoint().bodies` retains a 96-bit fingerprint per opId whose line has been dropped:
> ~40 bytes each. Stated here rather than left to be rediscovered: it is the price of "a compaction
> may not decide state", and it is the right price, but the bound in this section was wrong without
> it.
>
> **Amended 2026-08-27 (round 7) — the third term was UNBOUNDED, and the prose above said so
> without noticing.** "≈400 KB/year … pruned only for entities collected by the §7.3 tombstone GC"
> is a growth rate with no ceiling attached to a file `saveCheckpoint` rewrites atomically and
> whole on every debounced save. `compact()` called `rememberBody` for every line it dropped;
> `pruneSeqIndex()` pruned `seqById`, `tsById` and `legacySeqByStamp` on the same call and stepped
> over `bodies`; nothing else ever forgot one. Measured (`tests/attack/round6-record.test.js`
> R6-3a/b): ~46 bytes per op EVER WRITTEN, 6 000 fingerprints and 282 KB for a board of ONE note,
> durable across restarts, past localStorage's quota inside five years of ordinary use. It was the
> `ops.jsonl` bound purchased with an unbounded `checkpoint.json`.
>
> `pruneSeqIndex()` now ends in `boundBodies()`: an **oldest-first eviction down to
> `BODY_FINGERPRINT_CAP`** (`src/js/core/oplog.js`), which is `TAIL_COMPACT_AT` — the most lines
> this log ever holds at once — and never evicts an opId that still holds a line. The third term is
> therefore `O(TAIL_COMPACT_AT)`, ≈60 KB, flat in ops-ever and flat in board size.
>
> **What an evicted fingerprint costs, stated so the trade is not re-litigated from scratch.** It
> is not state: `append()` answers an opId with no fingerprint by RE-FOLDING rather than by
> guessing `duplicate`, and a re-fold is idempotent, so a device that evicted converges with one
> that did not. It costs one re-folded line back in the tail (which the next compaction drops
> again) and one missing entry in the `spliced` tamper report (§5.1 / REG-28). The eviction is
> oldest-first for that second reason: a spliced envelope arrives near in time to the body whose
> opId it re-uses. The full table, per state an opId can be in, is the docblock on
> `BODY_FINGERPRINT_CAP`.
>
> **This is NOT the same trade as "prune `bodies` by `pruneSeqIndex`'s `keepIds`" (round 6's own
> proposed one-liner), and the difference is measured, not asserted.** `keepIds` is "ids a
> surviving register attributes, plus retained lines", so that prune keeps the WINNER of each
> field and drops every absorbed op no register points at — which after a day's editing is nearly
> all of them, chosen by what the board looks like now rather than by what arrived recently. A
> second body under a SUPERSEDED opId then comes back `appended` with `splicedIds()` empty. Both
> `tests/tier1/core-oplog.test.js` and R6-3c pin that case specifically; written against the
> winner instead, they are green under that prune and prove nothing.
>
> **Reviewed 2026-08-27 — no change owed** (superseded by the amendment above).
> `judge:conformance` B-10 re-read this block against the implementation and found it current.
> `checkpoint().bodies` is `src/js/core/oplog.js`, `bodies` / `bodiesObject()` / `boundBodies()`.

**Sizing, so nobody has to guess.** A heavy family — 8 members × 300 entries/year × ~4 ops each
≈ 10 000 ops/year. Plaintext ≈180 B, padded to 256 B (ADR 002 §5.3), envelope ≈380 B on the wire
⇒ **≈3.8 MB/year server-side**, ≈400 KB/year of surviving registers client-side after compaction.
Comfortable on the free tier for the life of v2.

### 7.3 Tombstones — and the one rule whose violation is incorrect

A tombstone is a `_alive:false` register plus the entity's retained content registers. It must
survive as long as an op that could resurrect it might still arrive.

An entity may be dropped from the checkpoint **entirely** only when **all three** hold:

1. `_alive === false` (or `pub.alive === false`), **and**
2. `max(all its stamps)` is more than **400 days** old, **and**
3. **every registered, non-revoked device in that space has both READ and WRITTEN past that
   stamp's op** — `min(lastSeenSeq) >= seq` **and** `min(lastPushedSeq) >= seq`, where
   `lastPushedSeq` is the space's global seq high-water at the moment that device last confirmed a
   drained outbox (the relay knows both and reports them opportunistically on push). A device may
   be fully caught up on **reads** and still hold a three-week-old *unpushed* local edit to that
   entity; §12.5 guarantees that edit will never be discarded for being old, so collecting the
   tombstone around it **resurrects the entry**. An **unknown** seq — a device that has never
   reported, or an op whose seq was compacted away — makes the entity NOT collectable.
   **Unknown never permits a collection.**

> **Amended 2026-08-27 — read progress alone was unsafe, and this is the one rule whose violation
> is incorrect.** Corrected by `judge:conformance` B-1 against `src/js/core/oplog.js:150-199`,
> which implements both halves, fails closed on a missing `minPushedSeq`/`seqOf`, and says in as
> many words that the ADR stated only the `lastSeenSeq` half. **This amendment implies a second
> edit outside this ADR:** `docs/v2/contracts/server.contract.js:194` exposes only
> `setLastSeenSeq(deviceShort, seq)` and needs `setLastPushedSeq` / `minLastPushedSeq` beside it
> (owner: **WP-7**).

A device that never returns blocks GC forever — which is safe. **This is the single rule in the
system whose violation causes incorrect behaviour** (a very-long-offline Mac resurrecting deleted
entries). Guard it with an assertion and a fleet scenario; do not "optimize" condition 3 away.

**Server-side retention.** v2 does **not** prune ops on a timer. The only server-side deletions
are (a) `deleteOpsByMember` on removal (20.2) and (b) `deleteSpace` cascade (20.4). There is
deliberately **no per-entity redaction endpoint** — an endpoint that lets any member delete
another member's ops from the relay is a censorship primitive, and one of the reviewed designs
shipped exactly that. `LZP-1008`'s runbook gets a monitoring line and a documented "cold rejoin"
escape hatch instead.

### 7.4 Parking, not dropping

Three things are **parked** — retained in the log, not applied, re-evaluated later — rather than
dropped:

| parked | why | re-evaluated when |
|---|---|---|
| an op whose stamp is more than 24 h in the future | a peer with a broken clock must not poison every register, and must not silently lose work either | local wall time advances past it |
| an op sealed under an epoch key we do not hold yet | catching up across rotations | the next key fetch succeeds |
| an op whose **kind** or whose **fields** this client does not know | forward compatibility (§10) | after an app update |
| an op from a **device whose attestation has not yet arrived** | there is no causal delivery (§2); first contact and partial pulls are ordinary, not hostile | the attesting `member.set{dev.*}` arrives |
| an admin's stage-3a patch that sets `pub.level: 'privat'` but carries something **this build cannot read as a withdrawal** | version skew must never leave previously-hidden content visible on the newer client | after an app update |

> **Amended 2026-08-27 — two parked classes were missing.** The second row already exists in code
> as the `UNSHARE_SHAPE` park reason (`src/js/core/ops.js:310-325`, `src/js/core/authz.js:782-793`)
> and was simply never written down; `classifyUnsharePatch` (`authz.js:386`) is version-independent
> and parks a near-miss rather than rejecting it, which is **better than this ADR asked for**. The
> first row is finding **F-6** and is **not yet implemented** — `authz.js:671` still *rejects*, and
> `store.js:699-703` drops the rejected op without appending it, so it is never re-evaluated.
> Owner: **WP-8**. Until it lands, §7.4's promise ("an old client degrades to *does not show*
> instead of *loses*") is false for exactly this case.

Parking is what makes an old client in a family with a newer sibling degrade to *"does not show
the new thing"* instead of *"loses the new thing"*. Because merge is set-based, unparking late is
harmless.

---

## 8. v1 → v2 migration (LZP-403 · story 11.6)

`SCHEMA_VERSION` 1 → 2. Runs once, inside the existing `migrate()` at `store.js:67` — after the
v0→v1 branch and **preserving the reference-repair block at `:82-88` verbatim** (which is also
lifted into the projection, §5 step 7).

```js
// src/js/core/migrate1to2.js — DOM-free, pure, unit-testable against a real v1 file
/**
 * @param {Object} v1board  parsed board.json, schemaVersion 1 (post-v1-migrate)
 * @param {{ memberId: string, deviceShort: string }} ctx
 * @returns {{ ops: Op[], warnings: string[] }}
 */
export function migrateV1(v1board, ctx) { … }
```

### 8.1 GENESIS stamps — the single most important detail in LZP-403

Every migrated field is stamped with a **constant that encodes only the v1 array index**:

```js
const GENESIS = (i) => '0000000000000.' + String(i).padStart(6, '0') + '.' + '0'.repeat(16);
```

with `i` drawn from **one global counter** running in the order
`categories → notes → bars → scratchpads`.

Two properties, both required:

1. **Everything pre-existing loses to every future edit on every device.** `ms = 0`.
2. **Two independent migrations of the same `board.json` produce identical REGISTERS.** For every
   `(entityKey, field)` the value and the **stamp** are identical, because `GENESIS(i)` is a pure
   function of the file — so pairing two already-migrated Macs converges immediately with **no
   spurious conflicts and no silent overwrite**. The **ops are not** byte-identical and must not
   be: `id` is 128 CSPRNG bits per op (§1.2) and `dev` names the migrating device. Identical
   *stamps* are what the convergence argument needs; identical *opIds* would additionally make the
   two migrations mutually **deduplicable**, which is neither required nor true.

   > **Amended 2026-08-27 — "byte-identical" overstated what holds and what is needed.** Measured
   > by `judge:conformance` probe `p2` test 2 against the PO's real `board.json`: identical after
   > stripping `{id, dev, gid}`, different with them. `src/js/core/migrate1to2.js`'s `MigrateCtx`
   > documents `deviceId` as "the ONLY part of the output that legitimately differs between two
   > Macs", which is itself incomplete — the opIds and the gid differ too. Stamping with local wall time — which two of the
   three reviewed designs did — creates a real data-loss path: Mac A migrates at `T0` and edits a
   note at `T1`; Mac B migrates the same export at `T2 > T1`; B's migration op writes the *old*
   text at a greater stamp and LWW silently discards A's edit.

The **index inside the stamp** is what preserves v1's array order through §5's `_born` sort. A
constant GENESIS for every entity would make every comparison fall through to
UUID-lexicographic order, which is unrelated to v1's insertion order — and would visibly change
which note hides behind "+n" (`layout.js:209`) and how bars are rescued into lanes
(`layout.js:162-177`) on the user's existing board. That is a v1 regression and LZP-402's gate
would catch it; this is how we avoid causing it.

### 8.2 What migration emits

One `gid` labelled `'migrate:v1'`, **not pushed onto the undo stack**:

- one `cat.set` per category — all v1 fields plus `defaultVisibility: 'privat'`, `_alive: true`,
  `_born: GENESIS(i)`
- one `note.set` per note — all v1 fields plus `visibility: 'privat'` (16.1: joining a family
  later changes nothing about existing entries), `coEdit: false`, `_alive: true`, `_born`
- one `bar.set` per bar — same additions
- one `pad.set` per non-empty scratchpad key
- one `pref.set` (space `local`) carrying the whole `settings` object

All content ops carry `space: '<personalSpaceId>'`, minted lazily: **in solo mode there is no
personal space and no key** (see §11), so the ops are written to `ops.jsonl` with
`space: 'personal'` as a placeholder and rewritten to the real id the first time a personal
space is created. `pref` ops carry `space: 'local'`.

### 8.3 Acceptance criterion — mechanical, not argued

```
materialize(foldAuthorized(migrateV1(b).ops))  deep-equals  stripV2Fields(v1migrate(b))
```

for every field **including array order after the deterministic sort**, over a corpus of
synthesized boards plus any real `board.json` the PO supplies. This is property test P8 and it is
LZP-403's whole AC.

### 8.4 Other migration decisions

- **`snapshots.json` stays byte-identical in the v1 shape**, and 11.5's restore UI
  (`settings.js:224-254`) is untouched. Restore goes through §8.5.
- **`board.json` keeps the v1 top-level shape and is maintained as the materialized state on
  every persist.** v2 additions are additive on the entry objects and inside one `_v2` key, so a
  v1 build still loads a v2 board and simply ignores the extra fields. No story requires this; it
  is cheap insurance against a bad background update (22.3/22.7).
- **Idempotent.** Migration keys off `schemaVersion === 1 && !opsLogExists()`. Running it twice
  is refused, loudly.
- **`board.json` remains human-readable JSON (11.4).** The register stamps live in the checkpoint
  file, not in `board.json` — one of the reviewed designs put ~340 KB of stamps into the board
  file for every solo user; this one does not.

### 8.5 Import and snapshot restore — no `board.reset` primitive

One reviewed design introduced a `board.reset{state}` op carrying a whole board. **Rejected:** a
non-register primitive in a pure-register log has no fold rule, no defined behaviour under
reordering and no defined behaviour for two concurrent resets — a convergence hole across my own
two devices, i.e. on stories 19.4 and 11.5.

`store.replaceAll(next)` (import 11.3, snapshot restore 11.5) is instead a **diff transaction**:

1. Migrate the incoming board to v2 field shape (values only — the GENESIS stamps are discarded).
2. For every entity present in the import: emit `X.set` with **all** its fields at a **fresh**
   stamp (`clock.tick()`), which is greater than every existing stamp.
3. For every live local entity **absent** from the import: emit `{_alive: false}` at a fresh
   stamp.
4. Clear `undoStack` and `redoStack` (5.4: import is excluded from undo).
5. **Scope: `personal` + `local` only.** Family registers are never written by an import. After
   the diff txn commits, the publisher (ADR 004 §3) re-derives family ops from the new truth, so
   an entry that no longer exists is correctly retracted.
6. The confirm sheet must say so in one line:
   „Wiederherstellen ändert auch, was deine Familie von dir sieht."

Bounded by `(entities in import + live entities locally)`, and convergent by §6.

---

## 9. What is stored where

```
~/Library/Application Support/LangzeitPlaner/
  board.json        materialized v1-shape state (+ additive entry fields, + one `_v2` key)
  snapshots.json    v1 shape, unchanged — local safety net, never synced, never encrypted
  ops.jsonl         append-only op log: outbox (unacked) + recent inbox. PLAINTEXT at rest.
  checkpoint.json   serialized RegisterMap (value + stamp + author) + per-space cursors
  keys/             only when a space exists (ADR 002 §2)
```

`ops.jsonl` and `checkpoint.json` **do not exist in solo mode until a space is created** — until
then the materialized `board.json` *is* the checkpoint and the log is empty. Solo adds no second
file write, no key generation, no network module.

Storage plumbing (`storage.js` + both shells) is specified in ADR 005 §4. The one non-obvious
requirement: **`appendOps` must use `FileHandle.seekToEnd` / `OpenOptions::append`, never the
existing whole-file `writeAtomic`** (`shell-macos/main.swift:39-43`, `src-tauri/src/lib.rs:30-38`).
Appending a log by rewriting it is O(n²).

**Ops are plaintext at rest on the Mac.** Deliberate: it preserves v1's human-readable-JSON
value, Time Machine restorability, and the "no key, no data" failure mode we already accept.
FileVault is the answer. Anyone with your unlocked Mac reads your board — which was already true
in v1.

---

## 10. Forward compatibility

- `Op.v` changes only when the op format changes; it is **separate** from the HTTP protocol
  version (ADR 003 §4).
- An op whose `k` this client does not know is **parked**, not dropped (§7.4).
- A field in `f` that is not in `FIELDS[kind]` is **parked with its op**, not dropped and not
  applied. (`openOp` rejects a field whose *value* fails its declared type check — that is a
  protocol violation, not a version skew.)
- Unknown `space` values are parked.

This is the N+1 half of the compatibility story; ADR 003 §4 owns the N−1 half.

---

## 11. Solo mode is structurally untouched

| claim | mechanism |
|---|---|
| No network | `src/js/platform/net.js` is the only `fetch` call site, dynamically imported and gated on a configured space; plus the shell/CSP gate (ADR 003 §7). **Neither `net.js` nor its grep gate exists yet — see ADR 003 §7 gate 1, amended 2026-08-27.** The property is true at HEAD only because nothing in `src/` calls `fetch` at all |
| No crypto | key generation and `probeCrypto()` run at the moment the user first touches "Familienkreis erstellen / beitreten" or "Gerät koppeln" — never on first run |
| No extra file | `ops.jsonl` / `checkpoint.json` are created when a space is created |
| No render change | `materialize()` with `ctx.familySpaceId === null` produces exactly the v1 arrays; `layout.js`'s foreign branches collapse to the v1 expressions |
| First run unchanged (15.1) | migration is additive; `seenFirstRun` untouched; no prompt, no banner |

---

## 12. What downstream agents must not change without a new ADR

1. `store.txn()` is **synchronous** through `emit()` (recon B8). Bar-label editing depends on it.
2. Merge is per-field LWW by HLC stamp, tiebroken by `deviceShort`. No exceptions, no per-kind
   special cases.
3. **Ownership is the `<memberId>` segment of the family entity key.** It is never a register and
   never resolved by stamp.
4. The admin is resolved from the in-log `space.set{admin, adminPrev}` chain, **never** from a
   server column.
5. An op is never discarded for being old. Ops from the future, from unknown epochs and of
   unknown kinds are **parked**.
6. There is no `owner` field, no `seriesId` field, no `board.reset` op, and no per-entity
   server-side redaction endpoint.
7. `categoryId` never appears in a family-space payload, at any visibility level (A3).
8. Dates are `YYYY-MM-DD` everywhere, including on the wire. No times, ever.
9. `src/js/core/` is DOM-free and I/O-free (ADR 005 §2).
10. Migration stamps are `GENESIS(i)`, never the wall clock.

---

## 13. Known weaknesses of this design

Ranked by how much they should worry the PO.

1. **LWW loses concurrent text edits, silently for the winner.** Two people retyping the same
   co-edited label within the same second: one text vanishes, with no merge and no diff. 18.5
   accepts this and gives the loser one inline notice — but the notice only fires if the loser's
   client is running when the winning op arrives; an offline loser learns nothing. A per-character
   CRDT is wildly disproportionate for ≤80-character labels on a wall calendar. **This is a
   deliberate, spec-sanctioned data-loss window.**
2. **HLC is wall-clock-anchored for genuinely concurrent edits.** For two writes where neither
   device has seen the other, the later clock wins. The HLC receive rule fixes only *causally
   related* events; the 24 h future clamp fixes only the runaway case. Mitigation shipped: a
   settings warning when the device clock differs from the server's `serverTime` by more than
   5 minutes, and a specific `error` sync-state message for it rather than a generic one.
3. **Tombstone GC is the one unsafe-if-violated rule** (§7.3). An implementation that skips
   condition 3 to "unblock" GC lets a very-long-offline Mac resurrect deleted entries.
4. **Undo is per device.** Doing something on the desktop and pressing ⌘Z on the laptop does
   nothing. Defensible, and it will still surprise someone.
5. **Snapshot restore propagates.** Restoring yesterday's board re-publishes your shared entries
   with today's stamps, so the family sees your shared entries revert. The confirm sheet says so
   (§8.5). The alternative — restoring private fields only — would make the feature lie about
   what it restored.
6. **No causal delivery means "eventually consistent" includes "temporarily absent".** A Geteilt
   note whose `pub.text` arrives in the next batch is invisible, not partially rendered. Chosen
   over partial rendering because inferring meaning from a missing field is exactly the bug class
   ADR 004 exists to prevent — but a viewer can briefly see an entry-shaped hole.
7. **Full re-render per mutation is unchanged.** `emit()` → `redraw()` rebuilds all 12 columns
   (`board.js:26`). At 8 members × 2 years this is the perf wall (LZP-1007). This ADR keeps the
   *model* cheap; the *DOM* rebuild is untouched and will need its own ticket.
8. **The projection sort order changes v1's "+n" truncation choice in one edge case.** A user who
   imports a hand-edited `board.json` with a shuffled `notes` array sees a different note win the
   capacity slice. Lossless in data, not in pixels. Pinned in `DESIGN-DECISIONS.md` and asserted
   in the LZP-402 regression suite so it cannot drift further.
9. **The staged authorization fold roughly doubles fold cost** and makes `foldAuthorized` the
   hardest function in the codebase to hold in your head. It is the price of order-independent
   permissions; the faster alternative is wrong.
10. **`ops.jsonl` is plaintext at rest** (§9). Deliberate, and it was already true of
    `board.json` in v1.
