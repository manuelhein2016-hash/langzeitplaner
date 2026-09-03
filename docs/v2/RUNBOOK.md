# LZP-1008 — the ops runbook

| | |
|---|---|
| **Ticket** | LZP-1008 (E10, 2 pts) — *"Vercel/Prisma runbook, key-loss support script, release checklist"* |
| **AC** | addendum §3 (the infrastructure decision record), not a numbered story |
| **Written** | 2026-09-03 |
| **Audience** | the one person who operates this: the PO |

---

## 0. What this is, and what it is not

There are three operational documents and they do not overlap:

| document | answers |
|---|---|
| **`docs/v2/RELEASE.md`** | *how does a version get built and published* — the pipeline, the updater key, the DMG budget, signing |
| **`docs/v2/RELEASE-CHECKLIST.md`** | *what do I tick, in order, on the day I ship* |
| **this file** | *the thing is running (or is not). Now what?* |

This is the file to open when something is wrong, when somebody has lost something, or when a
family reports a symptom that no test suite has a name for. It is written for one operator with
no on-call rotation, no dashboard and no second opinion, and it says plainly where the answer is
*"there is nothing you can do, and here is how to say that kindly"*.

**Two things this runbook cannot do**, and both are structural rather than missing work:

1. **You cannot read anything.** The relay stores ciphertext it has no key for. Every diagnosis
   below is made from row counts, timestamps and error codes — never from content. If a procedure
   here ever seems to require reading an entry, it is wrong.
2. **You cannot recover a lost key.** §4 is the whole of what exists, and most of it is language.

---

## 1. The shape of the deployment

```
   Mom's Mac ─┐
   PO's Mac  ─┼─► HTTPS ─► Vercel Function (fra1)  ─►  Prisma Postgres (eu-central-1)
   PO's Mac 2─┘             server/api/v1/[[...path]].js        server/prisma/schema.prisma
                                     │
                                     └─ one entry point, 23 handlers, no CORS, no cache

   every Mac ────► HTTPS GET ─► GitHub Releases (the update manifest — a SECOND remote, 22.3)
```

- **One sync endpoint and nothing else** (21.5). No analytics, no error reporting, no CDN, no
  third-party anything.
- **The release host is the second remote** and it is not optional to disclose. E1-VERIFICATION §5
  settles the wording: *the board makes zero network requests; the shell asks one static host,
  roughly daily, after a human has been told.*
- **Region is a promise, not a preference.** `server/vercel.json` pins `fra1`; Prisma Postgres
  must be `eu-central-1`. Both are Frankfurt; neither name is a typo for the other. The privacy
  copy names the region, so moving the region makes the copy false. `check-server-config.mjs`
  fails on any other value, correctly.

---

## 2. Standing it up — the one-time work

`docs/v2/RELEASE.md` §7.2 and §7.3 are the canonical steps and are not repeated here. What follows
is the operator's view: the order, the traps, and the two blockers that are still open.

### 2.1 Order

1. GitHub repository exists and has a remote. (Today it does not — the tree is local-only.)
2. Vercel → *Add New → Project* → import the repo → **Root Directory `server`** → framework
   *Other* → leave install/build commands alone.
3. Prisma Postgres database in **`eu-central-1`**.
4. `DATABASE_URL` in Vercel, **Production**, carrying `connection_limit=1`.
5. **`server/prisma/migrations/` — see §2.4. Nothing works before this.**
6. Deploy. Then §2.5's smoke test.
7. Only then is `docs/v2/MOM-TEST.md` §6 runnable past step 7.

### 2.2 `connection_limit=1` is not a tuning knob

Vercel functions are stateless. A cold start per request opens a connection per request, which
exhausts a Hobby-tier Postgres long before it exhausts anything else (risk R3). Two mitigations,
both already in `server/adapters/prisma.js`: the client is a module-level singleton on
`globalThis`, so a *warm* invocation reuses its connection; and the connection string is
**required** to carry `connection_limit=1`, so one function instance holds exactly one connection
and the pool lives in the platform's pooler rather than in eight copies of the process.

If the database starts refusing connections under a load two Macs cannot plausibly generate, this
is the first thing to check and `U-COLD` in `server/adapters/vercel.js#UNVERIFIED_CLAIMS` is the
claim that just failed.

### 2.3 The preview-database trap

`server/vercel.json`'s build command runs `prisma migrate deploy` **only** when
`VERCEL_ENV=production`, or when `LZP_PREVIEW_DB_IS_ISOLATED=true`.

**Do not set that flag until Preview genuinely has its own database.** A preview build pointed at
the production `DATABASE_URL` migrates production from a feature branch. The default behaviour —
previews skip migrations and say so in the build log — is the safe, slightly annoying one, and it
is the correct default.

### 2.4 ⛔ BLOCKER — `server/prisma/migrations/` does not exist

```
$ ls server/prisma/
schema.prisma
```

`prisma migrate deploy` **applies** migrations; it does not create them. The first deploy against
an empty database therefore applies nothing, creates no tables, and every query fails on a missing
relation. `check-server-config.mjs` reports `ok every check passed` and is nonetheless letting a
deploy through that cannot work — E2-VERIFICATION §8 filed that gap against E1 and it is still
open.

**What to run once, on a machine with a scratch Postgres, and commit:**

```
cd server
DATABASE_URL="postgres://…/scratch" npx prisma migrate dev --name init
git add server/prisma/migrations && git commit
```

`migrate dev` is safe **only** against a throwaway database. `check-server-config.mjs` fails the
build if `migrate dev` ever appears in `vercel.json`, and that check is right.

After the first deploy, `server/prisma/migrations/` is **append-only**: `server.yml` diffs it and
refuses a change that modifies, deletes or renames an existing migration, because Vercel serves
the new deployment with the old one already torn down.

### 2.5 The smoke test that settles four unverified claims at once

`server/adapters/prisma.js` and `server/adapters/vercel.js` have **never executed** — there is no
Postgres and no Vercel account on the authoring machine, and both files carry an explicit
`UNVERIFIED_CLAIMS` export saying so. The first deploy is where they are settled.

```
curl -si https://<deployment>/api/v1/meta
```

Check, in this order:

| look for | if it is wrong |
|---|---|
| `{"region":"fra1","minProto":1,"maxProto":1,"serverTime":…}` | the region promise in the privacy copy is false — stop and fix the project region |
| `Cache-Control: no-store` | `U-HEADERS` failed: encrypted op batches may sit in an intermediary cache |
| `X-LZP-Protocol: 1` | `U-HEADERS` failed: a 426 becomes a wall instead of a signpost |
| `Strict-Transport-Security` present | `U-HEADERS` failed |
| **no** `Access-Control-Allow-Origin` | a browser page could talk to this relay; nothing should |

Then **one authenticated request** — any `POST /api/v1/spaces` from a real client. It fails with
`401 bad_signature` if `U-RAWBODY` is false and succeeds if it holds. That single request settles
the one claim whose failure is total: if the platform parsed the body before the handler saw it,
`rawBody` is empty, every signature check fails, and the relay is a brick. The failure is loud and
immediate, which is the fail-closed direction and the reason this is safe to find out in
production.

Finally, once there is a database at all:

```
DATABASE_URL="postgres://…?connection_limit=1" node --test tests/server/store-contract.test.js
```

That is the 60-case contract both other adapters already pass. Until it runs, treat every
`UNVERIFIED_CLAIMS` row as an open question rather than as documentation. Two of them (`U-SEQ`,
`U-TX`) need concurrency, not just a database: run the suite twice simultaneously against the same
`DATABASE_URL`.

### 2.6 What is still owed before a family can be told the relay exists

| owed | why it blocks |
|---|---|
| `server/prisma/migrations/` | §2.4 — nothing works |
| the relay address in the invitation e-mail | `MOM-TEST.md` §2.3 E-2 — the join screen asks for an address nobody sent |
| the 21.3 Datenschutz section in the app | LZP-1001. The words *Frankfurt*, *Vercel* and *Prisma* appear **nowhere** in `src/` — verified by grep. §7 below is the source text; it is not yet on a screen |
| a `RateBucket` cleanup job, or honest wording without one | §7.2 |

---

## 3. Day to day

### 3.1 What healthy looks like

A two-to-eight person family generates almost nothing. Expect, per Mac: a pull roughly every 45
seconds while the window is focused, every ten minutes in the background, plus one when the app
is brought forward, one when the network returns and one on quit. Pushes only when somebody types.

**Nothing to watch.** There is no dashboard to build and no alert worth wiring. The families
themselves are the monitoring: the sync status pane in Settings is honest, and the failure the
relay cannot report is precisely the one the relay cannot see.

### 3.2 The four things never to do

1. **Never restore the database from a backup taken before a rotation.** `Space.nextSeq` is a
   gapless per-space counter and clients hold cursors against it. Rewinding it makes the relay
   hand out sequence numbers that some device has already folded, and there is no route that
   repairs that. If the database must be restored, treat every space as needing a fresh epoch and
   expect parked ops.
2. **Never edit a `KeyWrap` row.** The table is INSERT-once, DELETE-only, by design (finding
   T5-K3): a rotation legitimately names wraps for every epoch `1..e+1`, and while this was an
   upsert one member could replace every wrap of every recipient with bytes of her choosing while
   the relay counted it as coverage. Postgres has no write-once column, so this rule lives in the
   two adapters and in your hands.
3. **Never delete the founder's `Member` row directly.** `Space.founderMemberId` anchors ADR 001
   §4.0's attestation and §4.1's admin genesis link. Removing it makes `adminAtIn` answer null for
   every stamp in the space, and no future joiner can admit anything the founder ever wrote. It
   is the one removal that destroys the space for everybody, which is why the route requires a
   second member's recovery signature — and why doing it by hand in SQL bypasses the only thing
   standing in front of it.
4. **Never add a column that could hold readable text.** Every ciphertext-bearing column is
   `Bytes`, `server/core/store-interface.js` refuses a String at the adapter boundary, and
   `tests/server/store-contract.test.js` compares the column set field-by-field against
   `MODEL_COLUMNS`. That is the mechanism by which "a future handler cannot store a readable
   note" stays true after the schema comments stop being read.

### 3.3 Reading the error codes a family reports

The client never shows a status number. When somebody reads you a sentence, this is the
translation:

| the German sentence they read out | code | what it means |
|---|---|---|
| „Dieser Code passt nicht … oder er ist älter als sieben Tage" | `invite_invalid` | wrong, revoked, expired, or the circle was deleted |
| „Dieser Code ist schon eingelöst" | `invite_used` | single use, working as designed |
| „Das waren zu viele Versuche in kurzer Zeit" | `rate_limited` / 429 | see §3.4 |
| „Dieser Mac ist auf diesem Server schon eingetragen" | `device_registered` | this Mac has a device row from an earlier circle or its own personal space |
| „Keine Verbindung zum Server" | `transport` / `timeout` / `blocked` | genuinely offline **or** a misspelled origin (`MOM-TEST.md` §2.3 E-3) |
| „Dieser Mac hat die Schlüssel des Kreises noch nicht vollständig" | `noRing` | §5.2 — read that section before answering |
| „Diese Version ist zu alt" | 426 / `protocol_too_old` | the 22.7 minimum-version bar |

### 3.4 The rate limits, so a 429 can be explained rather than guessed

Per member per hour unless stated: space creation 5/IP · invites 20 open per space, redemptions
per IP/hour · device registration 10/IP/hour · device adoption 10/IP/hour · member removal
10/member/hour · **epoch rotations 20/member/hour** · pairing 5 attempts per session, 180 s TTL ·
auth window 120 s, nonce TTL 300 s.

A family of two hitting any of these is not a family; it is a bug or an adversary. The one worth
recognising on sight is the epoch budget — see §5.1.

---

## 4. Key loss — the support script

### 4.1 The situation

Somebody has lost their last Mac, or lost the passphrase to their backup, or has no backup at
all. They want their entries back.

**There is no recovery, and there is no back door.** Not "we do not offer one" — there is nothing
to offer. The relay holds ciphertext and no key. The keys existed in two places: on the devices,
and inside the passphrase-encrypted identity block of a backup file. If both are gone, the data is
mathematics that nobody can invert.

This is Option B, chosen on purpose (addendum §3, decision D8). It is the same trade that makes
21.1 true. **The job here is not to fix it. The job is to say it correctly, quickly, and kindly,
and then to salvage everything that is still salvageable — which is usually more than they think.**

### 4.2 Triage, in this order — because two of the four cases are not actually key loss

| ask | if yes |
|---|---|
| **Do you have any other Mac that still opens the calendar?** | **Not key loss.** Export a backup from that Mac *right now*, with a passphrase, before anything else is discussed. Then pair the new Mac (Settings → Meine Geräte). Nothing has been lost. |
| **Do you have the backup file, and do you know its password?** | **Not key loss.** Import it on the new Mac. It restores the board *and* the membership: fresh device keys are minted, the device self-attests with the restored recovery key, `POST /devices/adopt` attaches it to the existing member. No admin involvement, no new invite. This is the only path that survives losing every device — it is what the backup is for. |
| **Do you have a backup file but not its password?** | **Key loss.** §4.3. The board block of a passphrase backup is bound into the AEAD, so there is nothing to salvage from the file by editing it, and 600 000 PBKDF2 rounds is not a speed bump you can wait out. |
| **No device, no backup?** | **Key loss.** §4.3. |

Two salvage notes that are worth saying before the bad news, because they are usually true:

- **A board-only backup (`Nur Einträge sichern`) still restores the board.** It does not restore
  membership — they have to be invited again — but the entries come back and it needs no password.
  Ask whether one exists; people forget they made it.
- **The family's shared entries are not lost to the family.** Every other member's Mac holds a
  complete replica. What is lost is *this person's* access and *this person's* private entries.

### 4.3 The script — German first

Read it. Do not paraphrase it into something softer, because the softer version always implies a
back door and then has to be taken back.

> „Ich habe nachgesehen, und ich muss dir etwas Unangenehmes sagen: **die Einträge sind weg, und
> ich kann sie nicht zurückholen.** Nicht, weil ich nicht darf — ich kann es wirklich nicht.
>
> Der Kalender verschlüsselt alles auf deinem Mac, bevor irgendetwas den Rechner verlässt. Auf dem
> Server liegen nur verschlüsselte Daten, und der Schlüssel dazu war nur an zwei Stellen: auf
> deinen Macs, und in der Sicherungsdatei mit deinem Passwort. Ich habe den Schlüssel nie gehabt.
> Das ist der Grund, warum niemand sonst deine Einträge lesen konnte — und derselbe Grund ist
> jetzt der, warum auch ich sie nicht lesen kann.
>
> Das war eine Entscheidung, die wir am Anfang getroffen haben, und sie hat diese Kehrseite. Es
> tut mir leid.
>
> **Was noch da ist:** die gemeinsamen Termine der Familie sind nicht verloren — die liegen auf
> allen anderen Macs. Ich lade dich neu in den Familienkreis ein, dann sind sie sofort wieder da.
> Verloren sind deine eigenen, privaten Einträge.
>
> **Und was wir sofort anders machen:** wenn du wieder drin bist, machen wir zusammen einmal eine
> Sicherung mit Passwort und legen das Passwort irgendwo hin, wo du es wiederfindest. Dann kann
> genau das nicht noch einmal passieren."

*English, for the same conversation:*

> „I looked, and I have to tell you something unpleasant: **the entries are gone, and I cannot get
> them back.** Not that I am not allowed to — I genuinely cannot.
>
> The calendar encrypts everything on your Mac before anything leaves it. The server holds only
> encrypted data, and the key existed in exactly two places: on your Macs, and inside the backup
> file with your password. I never had it. That is the reason nobody else could read your entries —
> and the same reason is now why I cannot either.
>
> That was a decision we made at the start, and this is its other side. I am sorry.
>
> **What is still here:** the family's shared entries are not lost; every other Mac holds them. I
> will invite you back into the circle and they will be there again straight away. What is lost is
> your own private entries.
>
> **And what we do differently now:** once you are back in, we make one backup with a password
> together, and put the password somewhere you will find it again."

### 4.4 Three sentences never to say

| never | because |
|---|---|
| *„Ich schaue mal, ob ich noch drankomme."* | you cannot, and the hour they spend hoping is worse than the minute of bad news. It also plants the idea that the operator *can* read their calendar — which is the exact belief 21.1 exists to make false. |
| *„Der Server hat bestimmt noch eine Kopie."* | he has a copy, and it is ciphertext. Saying this converts a clean loss into a suspicion that something is being withheld. |
| *„Beim nächsten Mal machst du besser ein Backup."* | true and useless. Do §4.5 instead — the failure was the product's, not theirs. |

### 4.5 The follow-up, and it is the actual fix

Within the same conversation, not later:

1. Issue a fresh invite; walk the join.
2. Sit with them through **one** export *with* a passphrase. Not "when you get a chance".
3. The passphrase floor is **soft on purpose** (`PASSPHRASE_FLOOR`: 12 code points, 5 distinct
   characters). A weak one is accepted, with a warning, and the button reads *„Trotzdem so
   sichern"*. The reason is written up in DESIGN-DECISIONS D8/S7 and it is worth knowing when you
   are standing next to them: a hard refusal pushes people to *„Nur Einträge sichern"*, which
   leaves them with no recovery artefact at all — strictly worse than a bad lock on a real door.
4. Write the passphrase somewhere physical. A note in a drawer is a better threat model for this
   family than a forgotten passphrase, and pretending otherwise is how people end up with neither.
5. Tell them what the file is, in one sentence, because the file's own header says it: *„Wer diese
   Datei und dein Passwort hat, ist du."* Both halves. Neither alone is enough — that is D8's whole
   point, and it is why the file may travel by e-mail while the passphrase must not.

### 4.6 The one thing that *is* recoverable, and how

**A member who still has one working Mac has lost nothing.** Export with a passphrase from the
working Mac, import on the new one, and §7.3's adopt path re-attaches the device to the existing
member with no admin involvement and no new invite. If the family epoch has moved on since the
backup, newer ops are **parked, not lost**, and the client says so („Schlüssel ausstehend"); the
next rotation covers the restored device. If the ring has a hole *below* the top, the import
result names the missing epoch numbers rather than restoring in silence.

---

## 5. Two residuals an operator will meet from the outside

Both are **priced, not closed**, and both are recorded as such in `docs/v2/FINDINGS.md` §14b and
in `server/core/limits.js` (which pins the string `DOES NOT CLOSE` so that a rate limit can never
be credited with a finding it does not close). They are here because an operator who meets one
should recognise it in a runbook rather than diagnose it from scratch — the symptoms are strange,
and the wrong first move makes both worse.

### 5.1 The epoch ladder — a space that can no longer rotate

**The mechanism.** Every rotation wraps epochs `1..next` to *every* recipient, not only the
uncovered ones, and `POST /spaces/:id/epoch` refuses a body carrying more than `MAX_WRAPS = 1024`
wrap rows. So the honest client's cost is `recipients × epochs` and grows linearly in the epoch
number, while an attacker's cost per rotation is flat. **No route prunes an epoch.** Past
`MAX_WRAPS / recipients` the honest rotation stops fitting in a request, the cap is per request
with no continuation, and there is no second request.

**The wall, in numbers.** Recipients are the space's live devices.

| family | recipients | rotation fails from about epoch |
|---|---|---|
| 2 people, 1 Mac each | 2 | 512 |
| 3 people, 1 Mac each | 3 | 341 |
| 4 people, 2 Macs each | 8 | 128 |
| 8 people, 2 Macs each | 16 | **64** |

An honest family rotates on membership and device events only — a family that adds and removes
nobody rotates zero times a week, and `keys.js#deliver` batches every uncovered recipient into one
rotation. Honest use does not approach these numbers. `epochRotationsPerMemberHour = 20` prices
the climb: reaching the wall becomes hours of continuous, authenticated, **attributable** rotation
by a named member, long enough for `removeMember` to end it, instead of one unattended burst.

**What it looks like from outside.**

- A family reports that removing somebody, or adding a Mac, *"does nothing"* — repeatedly.
- The relay answers `POST /api/v1/spaces/:id/epoch` with **`413 payload_too_large`**, `field:
  "wraps"`. That code on that route is this and nothing else.
- `Space.currentEpoch` is a number in the hundreds for a household of four.
- `SELECT epoch, count(*) FROM "KeyWrap" WHERE "spaceId" = $1 GROUP BY epoch ORDER BY epoch` shows
  a long ladder with a full rung at every level.

**What to do.**

1. **Do not raise `MAX_WRAPS`.** It is the request cap that keeps a blind relay from being free
   storage; raising it moves the wall, does not remove it, and the next rotation is bigger again.
2. **Reduce the recipient count, which moves the wall away instead of toward you.** Revoke devices
   that are genuinely gone (`POST /devices/revoke`); their wraps stop being minted. In the 8×2
   table above, dropping to one Mac each doubles the headroom.
3. **Find out who climbed it.** Rotations are authenticated and attributable: the ladder's rungs
   are `Epoch` rows with `createdAt`, and the depositor of each wrap is `KeyWrap.senderDeviceId`,
   stamped by the relay from the request it authenticated — never read off a body. If one member's
   devices deposited hundreds of rungs in an evening, that is the answer, and `removeMember` ends
   it.
4. **If the space is already past the wall**, say so plainly: rotation is unperformable, which
   means *a removal can no longer take effect cryptographically* and *no new member can be
   delivered keys*. The circle still works for everybody already in it, with every existing device
   holding a complete replica. The honest remedy is a **new circle**: every member exports a
   passphrase backup, the PO creates a fresh Familienkreis, everyone joins and imports. Shared
   history re-arrives from the replicas; nothing is lost but the space id.
5. **What would actually close it** is protocol work and is owed, not missing by oversight: a
   pruning/compaction route, or a `rotateTo` that sends only the rows that are absent (ADR 002
   §4.2, ADR 003 §3.7). `tests/fleet/e6-gate-keys.test.js` §1c keeps the wall itself on the record
   so it cannot be forgotten.

### 5.2 The poisoned rung — a space frozen by one bad rotation

**The mechanism.** A rotation is accepted by the relay if the row count covers the recipients. The
relay may not open a wrap, so it cannot check that the bytes inside are openable. **One** rotation
that deposits wraps nobody can open therefore leaves every honest device `noRing` at the current
epoch — and a device with no ring cannot mint the next one. The space is frozen at `e`.

**This is not a volume attack, and no rate limit reaches it.** One is enough, and no rate bounds
"one". `epochRotationsPerMemberHour` bounds *how many epochs may be poisoned in an hour* and
nothing more; `limits.js` says so in the rule's own text so that the limiter cannot be mistaken for
the fix. It is still an adversary success (`e6-gate-keys` §2a) and the control that reaches it is
ADR 002 §8.5a's owed *"I cannot open epoch e"* report path — protocol work in
`server/core/handlers/keys.js` and on the wire.

**What it looks like from outside — and the reason it is confusing is that nothing is failing.**

- **Every request returns 200.** No error code anywhere. Pushes are accepted, pulls are served.
- Every member reports the same thing, at the same time: *„Dieser Mac hat die Schlüssel des Kreises
  noch nicht vollständig."* Removals do not take. New joiners never see anything.
- New entries stop appearing on other boards, while each person's own board is perfectly fine.
- In the database: `Space.currentEpoch = e`, `KeyWrap` has a **full set of rows for epoch `e`**, and
  `SELECT max(epoch) FROM "Op" WHERE "spaceId" = $1` is stuck at `e-1` or below and does not move.
  That combination — a fully covered top rung that no op ever uses — is the signature.

**How to tell it apart from an ordinary joiner waiting (D9).** A joiner waiting is *one* member
saying `noRing` while everybody else is fine and entries flow normally. The poisoned rung is
*everybody* saying it at once, and no entry crossing between any two Macs.

**What to do.**

1. **Do not delete rows to "unstick" it.** There is no route that prunes an epoch, deleting the
   `Epoch` row does not lower `currentEpoch`, and deleting the wraps removes the coverage the next
   rotation is checked against — which makes the space worse, not better, and is a
   `KeyWrap`-editing move that §3.2 rule 2 forbids.
2. **Find the depositor.** `SELECT DISTINCT "senderDeviceId" FROM "KeyWrap" WHERE "spaceId" = $1
   AND epoch = $2`. That value is relay-stamped from an authenticated request. Join it to `Device`
   and `Member` to get the member. A poisoned rung has a named author.
3. **Ask one member to check whether it is malice or a bug.** If exactly one device's wraps open
   and the rest do not, this is a client defect at the wrap-building step; if none open for anyone,
   it is deliberate or a key-derivation mismatch after an upgrade. Either way, the *space* is stuck
   regardless.
4. **The remedy is the same as §5.1's step 4**: a new circle from local replicas. Every device
   holds a complete replica, so what is lost is the space id and nothing else. Say that plainly —
   the family's instinct will be that their data is trapped, and it is not.
5. **Then remove the depositing member** if the rung was deliberate. It does not unfreeze the old
   space; it stops the new one meeting the same evening again.

### 5.3 Two smaller residuals, for completeness

- **The unbounded shelf** (`src/js/sync/outbox.js`) — narrowed, not closed. Counting the shelf
  against the cap was deliberately *not* done, because the cap's contract is "the caller must not
  advance the cursor", and charging the shelf to it stalls a space for rows that are already dealt
  with. It is a client-side memory question, not an operator one.
- **`RateBucket` is never swept.** See §7.2 — it is a privacy obligation, not an availability one.

---

## 6. Incidents

### 6.1 The uncomfortable truth first

**A published release cannot be recalled.** Every Mac that already checked the manifest has
already staged it. What follows limits the blast radius; it does not reach back.

RELEASE.md §6 is the procedure. The operator's summary: the emergency stop is to publish a
manifest that no longer points at the bad version — seconds, and it stops *further* installs.
Deleting a GitHub release does not un-install anything.

### 6.2 A bad server deploy

Vercel's *Instant Rollback* promotes the previous deployment in seconds and is the right first
move. **But a rollback does not un-run a migration**, and migrations are append-only. If the bad
deploy carried a schema change, roll the *code* back and leave the schema forward — the previous
code must still work against the new schema, which is the discipline `server.yml`'s append-only
diff exists to protect. If it does not, you are writing a forward migration under pressure, and
RELEASE.md §6.4 is the section to read before you touch anything.

### 6.3 A family locked out after a client update

The 22.7 minimum-version bar exists for exactly this: the manifest's `minimum_version` makes
outdated clients say one plain German sentence instead of failing quietly. The bar is
`minimum_version` in the manifest — **not** `minClientVersion`, which was the spelling that made
the whole mechanism unreachable until E1 integration caught it. If you set the wrong key, the
field parses as `null` and no client is ever told anything.

### 6.4 Somebody's laptop was stolen

Honest order, and the first step is the only urgent one:

1. `POST /devices/revoke` for that device, from any of their remaining Macs.
2. An epoch rotation follows automatically and cuts the device off from **everything sealed under
   `e+1` and after**.
3. **It does not reach backwards.** Everything that device already pulled is on that disk, and no
   epoch bump reaches into another machine. The UI is required never to imply otherwise, and
   neither should you: *unsharing is not unremembering.*
4. There is no PIN and no re-auth on the app, by design (no passwords). The real defence for what
   is already on the disk is FileVault, which is outside this product.

---

## 7. The privacy obligations the operator personally carries

Story 21.3 says the app documents plainly what the server side can see. Until LZP-1001 puts that
on a screen, **you are the Datenschutz page**, and these are the sentences that are true.

### 7.1 What the relay can see, in full

Space ids and kinds; pseudonymous member ids; **member colour** (the one deliberate plaintext
value — `@@unique([spaceId, colorRef])` is what stops two people picking the same colour, and that
check cannot happen inside ciphertext); join and removal times; device ids, shorts and public
keys; per-device read and write progress; epoch numbers and rotation times; which device deposited
each wrap; per-space op counts; padded envelope sizes; op **arrival** times; chain hashes; invite
id hashes, epochs and expiry. Plus, in transit: IP addresses, the app version and each Mac's
clock.

Not present, and structurally so: no entry text, no bar caption, no category, no scratchpad, no
date, **no display name** (names travel as ops inside the encrypted stream) and **no authoring
time** (it lives inside the ciphertext; the relay keeps `receivedAt`, which it cannot avoid
knowing).

`docs/v2/server-metadata.md` is the full inventory including §5's traffic-shape analysis and §7's
"what a database dump reveals". Read it before answering any question that begins *"but could you
tell if…"* — several of those answers are yes.

### 7.2 The retention sentence that is currently uncomfortable

**`RateBucket` is never swept.** `rateAllow` replaces an expired bucket's count and window and
leaves the `key` in place — and the key contains an IP address for the per-IP limiters. So the
*count* resets after an hour and the *identity does not*: the row survives indefinitely once
written. `Nonce` is swept lazily on the next write, which means on an idle relay expired nonces
persist until somebody makes a request. Vercel Hobby has no cron, which is why neither has a
timer.

**Do not write "wird nach einer Stunde gelöscht" anywhere.** The honest wording is *"gespeichert,
bis sie manuell gelöscht wird"*. The cheapest real fix is a periodic

```sql
DELETE FROM "RateBucket" WHERE "windowStart" < now() - interval '1 day';
```

which needs a scheduler and therefore a paid plan or a deploy-time hook. On the day it exists, the
sentence becomes *„…und wird nach 24 Stunden gelöscht"* — **and the copy changes in the same
commit, not before it.**

Also true and worth saying once: **`Op` rows are never pruned** except by a member removal or a
space deletion. A family that uses this for ten years leaves ten years of arrival timestamps on
the relay.

### 7.3 The release host

The board makes zero network requests. The *shell* — the native process, outside the WebView —
makes exactly one: an unauthenticated HTTPS GET of one static manifest on one pinned host, roughly
daily, and only after a human has been told. It carries no identifier, no query string and no
board content.

Two consequences the operator must not let drift:

1. The "zero network" line in About and any marketing copy must be the **scoped** wording (A1
   permits it): *„das Board geht nie online; die App fragt einmal täglich, ob es eine neuere
   Version gibt."*
2. The Datenschutz text must name the **release host as a second remote**, beside the sync
   endpoint.

---

## 8. Release

See `docs/v2/RELEASE-CHECKLIST.md`. The one-sentence version: `git tag` builds and publishes the
desktop app to GitHub Releases; a push to `main` deploys the server to Vercel; those are two
different mechanisms that happen to be triggered by the same repository, and the checklist exists
because the second one has no tag to tell you it happened.
