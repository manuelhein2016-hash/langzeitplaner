// tests/helpers/sync-domains.js — THE INPUT DOMAIN OF THE OP LIFECYCLE, WRITTEN DOWN AS DATA.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
//
// `tests/helpers/domains.js` enumerated the inputs of the HISTORY layer — the bytes of
// `board.json`, the stamps, the checkpoint, the bar-edge alphabet — and closed 51 findings in one
// pass because it enumerated INPUTS rather than BRANCHES. FINDINGS §7d made that the required
// method for anything in ADR 006 §5/§7/§9.
//
// E5 shipped WP-8 and M1 („Zwei Macs") was demonstrated over a real relay. Two adversaries then
// attacked it and found NO confidentiality break — 21.1 and 21.2 both held. What they found is
// that **the engine loses ops silently and reports `healthy` while doing it**, and the
// convergence adversary named the property that ought to hold and does not:
//
//   > for every op set and every interleaving of partition, reorder, duplication, compaction,
//   > restart and quarantine, the two Macs' register digests agree
//
// and it named the reason the fixes keep getting relocated:
//
//   > the domain here is the OP LIFECYCLE, not the op kinds.
//
// `domains.js` enumerates what an op IS. This file enumerates what happens TO it: the outcome of
// `openOp`, what the engine then does with that outcome, what survives a relaunch, what a
// compaction does to it, and what anybody — the user, `sync.status()`, `store.diagnostics()` —
// is able to SEE. Five domains, and the sixth thing they have in common is that today the answer
// to the last question is `healthy` in every single cell.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CONTRACT OF AN ENTRY — identical to `domains.js`, deliberately
//
//   { id, value, label, expect, openFinding, note? }
//
//   id            stable, unique across the whole file. Quote it in a fix, in a commit, in a row.
//   value         THE INPUT. Data, never a closure.
//   label         one line a human can read in a failure report.
//   expect        THE REQUIRED BEHAVIOUR. Its shape is fixed per domain and documented at the
//                 head of that domain. **Never the current behaviour.**
//   openFinding   the finding id that predicts this entry FAILS today, or null when the entry is
//                 expected to hold. A null here that fails is NEWS: a regression, or a domain
//                 member nobody had looked at. `tests/property/sync-domains.test.js` splits the
//                 two, loudly.
//
// S1 carries one extra field, `predicted`, and it is not a second `expect`. `expect` is the
// required triple; `predicted` is THIS BUILD'S MEASURED TRIPLE, recorded as data so that the
// 160-cell grid below can be generated rather than hand-marked. Recording it makes the finding a
// falsifiable claim — if the build stops behaving that way, the grid reports it — and it is the
// only field in this file that describes the code that exists.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ZERO DEPENDENCIES. NO WALL CLOCK IN A VALUE. NO IMPORTS AT ALL — this file is a leaf, exactly
// as `domains.js` and `crypto-domains.js` are, so that a probe cannot quietly become the oracle
// for the thing it is probing.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Freeze a literal all the way down without rewriting it. Shared expectations stay shared. */
const deep = (x) => {
  if (Array.isArray(x)) return Object.freeze(x.map(deep));
  if (!x || typeof x !== 'object' || Object.isFrozen(x)) return x;
  for (const k of Object.getOwnPropertyNames(x)) {
    const d = Object.getOwnPropertyDescriptor(x, k);
    if (d && 'value' in d && d.writable) x[k] = deep(d.value);
  }
  return Object.freeze(x);
};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE FINDINGS THIS DOMAIN REFERS TO
//
// Four are already in `docs/v2/FINDINGS.md` or in the adversary suites. Three are NEW and are
// opened BY this enumeration; they are listed here rather than only in a test comment, because
// "the row lived only in tests/attack/" is the failure mode FINDINGS.md's round-5 and round-7
// updates both had to correct.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const OPEN_FINDINGS = deep({
  // ───────────────────────────────────────────────────────────────────────────────────────────
  // ALL SEVEN ARE CLOSED as of the round-8 integration pass (2026-08-29), and every entry in this
  // file now carries `openFinding: null`. The descriptions are kept in the PAST TENSE rather than
  // deleted, for two reasons:
  //
  //   1. This map is the referent for the `openFinding` field. A future round that re-opens one
  //      writes the id back on the entry, and the property asserts the id resolves HERE. An empty
  //      map would make the next round invent a second vocabulary.
  //   2. A domain file whose only record is of what currently passes cannot be read against the
  //      build that failed it. What each row said is what the entries were written to catch.
  //
  // The register is `docs/v2/FINDINGS.md` §3c, and it is the authority. Two findings below were
  // opened by THIS enumeration and had no `tests/attack/` row before it — L-1, L-2, L-3.
  // ───────────────────────────────────────────────────────────────────────────────────────────
  'P-8': 'CLOSED · was CRITICAL · `sync/personal.js` `pullNow` read `out.parked`, which `openOp` '
    + 'never sets — the whole park branch was dead code, so EVERY park fell through to '
    + '`terminal()`: quarantined, cursor released, op destroyed. A second mistake sat inside the '
    + 'dead branch and would have defeated it even if it had run: `CURABLE_PARKS` held enum values '
    + 'and `out.reason` is a human sentence. Fixed in three parts — the branch as a DOMAIN '
    + '(`PARK_HANDLING`, keyed off `ENVELOPE_PARK`, `parkHandlingOf()` TOTAL), then durable '
    + 'retention (`sync/outbox.js`\'s `createParkingLot` behind a `parkStore` port), then the '
    + 'cursor release ADR 003 §8.2 requires for the two `curedBy: \'update\'` reasons. '
    + '→ tests/attack/privacy-e5-scope.test.js §6, now inverted.',
  'E5-2': 'CLOSED · was CRITICAL · re-opened after being recorded fixed. '
    + '`store._outboxHorizonCap()` stood the cap down when `cap === null`, which is the state of '
    + 'EVERY log immediately after ANY compaction — so `compact ▸ author offline ▸ compact` folded '
    + 'the unacknowledged line away for real and `outbox()` returned 0. The stand-down belongs to '
    + '`held >= floor` alone. → tests/fleet/attack-converge-outbox.test.js §1, now inverted. '
    + '**And see L-4**, which was hiding behind it and is why fixing this alone was not enough.',
  'L-4': 'CLOSED · was CRITICAL · NEW, and found only because E5-2\'s own arm was fixed first. '
    + '`core/oplog.js` `load()` fed each tail line the `seq` its BYTES carry, and a tail line is '
    + 'written before any ack exists, so it always reads `null`; the durable ack rides in '
    + '`checkpoint().seqs`. An acknowledged op came back looking UNACKNOWLEDGED, so `lines()` and '
    + '`seqOfOp()` disagreed and the outbox FLOOR sank below the persisted horizon — which pushed '
    + '`_outboxHorizonCap()` into E5-2\'s one genuinely unrecoverable arm, on any Mac that quits '
    + 'after a compaction. Two of twenty-four seeds of the convergence sweep still lost an op here.',
  'P-4': 'CLOSED · was HIGH · seven shipped modules were reachable from no entry point, and three '
    + 'of them were DEFENCES. Four `sync/` modules were WIRED (`chain.js` from `pullNow`, '
    + '`outbox.js`\'s parking lot, `cursor.js`\'s durable chain anchor, `protocol.js` through '
    + 'chain.js) and exactly one was DELETED — `client.js`, LZP-501\'s superseded engine, which '
    + 'was the only importer of the other four and the whole reason they looked dead. '
    + '→ tests/attack/privacy-e5-silence.test.js §5, now inverted.',
  'E10-1009-A': 'OPEN · LOW · **the feedback sender has no binder.** `src/js/feedback/port.js` '
    + 'holds `setFeedbackPort(...)`, and nothing calls it, so `canSend()` is false on every Mac '
    + 'and „Senden" is disabled. The one line that closes it belongs to `family/mount.js` — the '
    + 'only module that holds a transport and the only one behind ADR 003 §7 gate 2\'s single '
    + 'dynamic door — which LZP-1009 does not own (ONE OWNER PER FILE; a parallel workflow has '
    + 'it). The binding is written out verbatim in `port.js`\'s header so it cannot land wrong, '
    + 'and `tests/tier1/feedback.test.js` §6 pins the contract it must satisfy. '
    + 'WHY THIS IS LOW AND NOT HIGH: the screen degrades HONESTLY rather than failing. The '
    + 'preview still renders, the payload is still built, and the two fallbacks LZP-1009 requires '
    + 'anyway — „In die Zwischenablage kopieren" and „Als Datei sichern" — are on the screen '
    + 'BEFORE any send is attempted, because "the relay being unreachable is itself worth '
    + 'reporting". A solo tester with no Familienkreis has no relay to send to in any case, so '
    + 'for her the fallbacks are not a degraded path, they are the path.',
  'F-8': 'CLOSED · was MEDIUM · `store.warnings` had no consumer. `family/syncstatus.js` now '
    + 'subscribes and `sync/status.js` enumerates the channel. See L-5 for the half of this that '
    + 'the closure itself got wrong.',
  'L-1': 'CLOSED · was HIGH · NEW, opened by this enumeration with no `tests/attack/` row before '
    + 'it. THE ENGINE\'S QUARANTINE WAS A PER-SESSION `Map`. A terminal refusal — a bad signature, '
    + 'a failed AEAD, a malformed envelope — lit `error`, and then DIED WITH THE SESSION. The '
    + 'cursor is already past the op, so the relay will never serve it again: one relaunch and a '
    + 'permanent divergence was reported as `healthy` with nothing on disk that remembered it. It '
    + 'now rides in `checkpoint().lzp.refusals`, and is WITHDRAWN if the op later lands.',
  'L-2': 'CLOSED · was HIGH · NEW, opened by this enumeration. NOTHING COULD SEE A HELD OP. '
    + '`sync.status()` derived its three states from `store.outboxSize()` and the engine\'s two '
    + 'in-memory Maps; `diagnostics().sync` reported `outbox`, `cursor` and three booleans. '
    + 'NEITHER reported `_log.parkedOps()`, so a line parked under `attestation`, `epoch`, '
    + '`version` or `unknownKind` was DURABLE and INVISIBLE. `diagnostics().sync` gained the four '
    + 'fields S4 names; `sync/status.js` folds over them, and a MISSING field is `unknown` rather '
    + 'than `0` — because folding "I cannot see a parked op" into "there are no parked ops" IS '
    + 'this finding, in one line of arithmetic.',
  'L-3': 'CLOSED · was HIGH · NEW, opened by this enumeration. THE PARK HAD NO REAPER. '
    + '`store.unparkAttested()` re-judges a held line and was called from exactly one place in the '
    + 'product — `family/mount.js`, on the adoption of a NEW peer. `init()` did not call it and '
    + 'neither did `useIdentity()`, so every launch after the first left the line parked for ever, '
    + 'with the cursor long since released past it. Two call sites now: `store.init()` and '
    + '`pullNow`. → tests/fleet/attack-converge-attestation.test.js §3, now inverted.',
  'L-5': 'CLOSED · was MEDIUM · NEW, and this pass walked into it while closing F-8. '
    + '`sync/status.js` enumerated `warnings` as an `error` observable, and `store.warnings` is a '
    + 'MIXED PROSE CHANNEL: `_warn` fires for a refusal and a quarantine, and equally for a '
    + 'reconciliation after a crash ("expected", in its own text), a §9.3 re-join, a settings '
    + 'repair, and `unparkAttested`\'s "held ops are now authorised and have been applied" — the '
    + 'sound of a fix WORKING. Measured, that lit a fault on every launch that had anything to '
    + 'say, which is what S4-quiet and S4-pending are the controls against. The row is `healthy` '
    + 'and still COUNTS, so `silent` is false and the sentences reach the settings sheet; only '
    + 'sharp evidence raises the indicator. '
    + 'A SECOND HALF OF THIS FINDING IS IN THIS FILE: `S4-refused` and `S4-warnings` are measured '
    + 'on ONE device at ONE moment and required two different answers from a first-match-wins '
    + 'helper, which no build can satisfy. Corrected in the PROBE, with both `expect`s untouched.',
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S1 — AN OP'S FATE, END TO END
//
// THE THREE AXES. They are not the code's branches; they are the three questions a user's edit
// can be answered with.
//
//   A · THE OUTCOME OF `openOp`   what the crypto seam said about the envelope
//   B · WHAT THE ENGINE THEN DOES what `pullNow` did with that answer, inside one pull
//   C · WHAT SURVIVES A RELAUNCH  the STRONGEST thing a fresh process can still find
//
// THE REQUIRED RULE, IN ONE SENTENCE, WITH NO EXCEPTIONS:
//
//     A PARK IS A DEFERRAL AND A TERMINAL IS FINAL. A park may never become a drop: whatever the
//     park reason, the envelope must be RETAINED — durably, with its reason — so that a later
//     pull, a later pairing, a later key fetch or a later app update can re-judge it. A terminal
//     may throw the envelope away, but it may NEVER throw away the RECORD that it did.
//
// and the second half of it, which is what the rule is FOR:
//
//     The cursor is the only thing that decides whether the relay will ever offer the op again.
//     It may be released past an op ONLY when the op is retained locally (a park) or when the
//     refusal is recorded durably (a terminal). Released past an op that is neither is silent,
//     permanent divergence — which is the entire finding.
//
// `expect` and `predicted` share one shape:
//
//   { engine:  one of S1_ENGINE.id     what `pullNow` must do inside the pull
//     cursor:  'held' | 'released'     may the relay's `since` filter ever skip this op?
//     survives:one of S1_SURVIVES.id   the strongest thing a fresh process can still find }
//
// WHY `cursor: 'released'` IS CORRECT FOR TWO OF THE FOUR PARKS. `attestation` and `epoch` are
// curable WITHIN a session — a later page, a pairing, a key fetch — so the cursor is held below
// them and the op is re-offered. `version` and `unknownKind` are curable only by an APP UPDATE,
// and a cursor pinned behind one of those would block every later op for ever, which ADR 003 §8.2
// forbids by name. So they release the cursor — and that is precisely why their retention has to
// be DURABLE rather than a `Map` in the engine: after the release, the parked line is the only
// copy in the world that this Mac can reach.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Axis A. Eight distinguishable answers `openOp` can give, and how each one is reached. */
export const S1_OUTCOMES = deep([
  { id: 'ok', label: '`openOp` returns `{status:"opened", op}`', reach: 'the ordinary pull' },
  { id: 'park:attestation', label: 'park · ATTESTATION — no attestation resolves `env.dv` yet',
    reach: 'the peer\'s attestation is withheld from `attestationOf` (F-6\'s own scenario)' },
  { id: 'park:epoch', label: 'park · EPOCH — the key ring holds no key for `env.sp`/`env.ep`',
    reach: 'the receiver\'s KeyRing misses the epoch (ADR 002 §4.4, offline across a rotation)' },
  { id: 'park:version', label: 'park · VERSION — `env.v` is a version this build does not know',
    reach: 'the relay serves an envelope with `v: 99` (ADR 002 §1 "versioning, not negotiation")' },
  { id: 'park:unknownKind', label: 'park · UNKNOWN_KIND — the plaintext carries an op kind this build has never heard of',
    reach: 'a genuinely re-sealed envelope whose `op.k` is unknown, signed by the real author\'s key' },
  { id: 'terminal:signature', label: 'throw · P3 — the signature does not verify under the key named by `env.dv`',
    reach: 'one flipped byte in `env.sig`' },
  { id: 'terminal:aead', label: 'throw · AEAD — AES-GCM decrypt failed (wrong key, tampered tag, mismatched AAD)',
    reach: 'the receiver\'s KeyRing answers with a different AES key for the same epoch' },
  { id: 'terminal:malformed', label: 'throw · shape — the envelope is not a well-formed envelope',
    reach: '`env.iv` is 5 bytes rather than 12' },
]);

/**
 * Axis B. What `pullNow` did inside the pull. TOTAL and mutually exclusive, in this priority:
 * a disposition that keeps the op beats one that keeps only a record, and that beats keeping
 * nothing at all.
 */
export const S1_ENGINE = deep([
  { id: 'applied', label: 'folded into the registers and projected onto the board' },
  { id: 'deferred', label: 'RETAINED for re-judgement — the op itself is still somewhere this Mac can reach' },
  { id: 'quarantined', label: 'the op is gone and a RECORD of the refusal, with a reason, is kept' },
  { id: 'dropped', label: 'nothing is kept — but the cursor is still below it, so the relay may offer it again' },
  { id: 'cursor-released', label: 'nothing is kept AND the cursor is past it: the op cannot be re-fetched, ever' },
]);

/** Axis C. The strongest thing a fresh process can still find. */
export const S1_SURVIVES = deep([
  { id: 'op', label: 'the op itself — in a register, on the board' },
  { id: 'park-reason', label: 'the line AND its park reason — still held, and still known why' },
  { id: 'quarantine', label: 'a durable record that an op was refused, and why' },
  { id: 'nothing', label: 'no trace at all' },
]);

const FATE = (engine, cursor, survives) => deep({ engine, cursor, survives });

/**
 * THE EIGHT FATES. `expect` is the requirement; `predicted` is what this build was measured
 * doing on 2026-08-29 by `tests/property/sync-domains.test.js`'s own probe.
 */
export const S1 = deep([
  {
    id: 'S1-ok',
    value: 'ok',
    label: 'an ordinary op from the other Mac',
    expect: FATE('applied', 'released', 'op'),
    predicted: FATE('applied', 'released', 'op'),
    openFinding: null,
    note: 'The control. Without it every row below is equally satisfied by an engine that syncs nothing.',
  },
  {
    id: 'S1-park-attestation',
    value: 'park:attestation',
    label: 'an op from my other Mac, arriving before that Mac\'s attestation',
    expect: FATE('deferred', 'held', 'park-reason'),
    predicted: FATE('deferred', 'held', 'park-reason'),
    openFinding: null,   // CLOSED — P-8: `sync/outbox.js`'s parking lot is wired behind `parkStore`
    note: 'M1\'s FIRST CONTACT. `family/mount.js` even warns "its ops will park" when the roster '
      + 'has no `kexPubRaw` yet. They do not park. They are destroyed, and the cursor is released '
      + 'past them, so the cure — which does arrive — cures nothing.',
  },
  {
    id: 'S1-park-epoch',
    value: 'park:epoch',
    label: 'an op sealed under a key epoch this device has not fetched',
    expect: FATE('deferred', 'held', 'park-reason'),
    predicted: FATE('deferred', 'held', 'park-reason'),
    openFinding: null,   // CLOSED — P-8: `sync/outbox.js`'s parking lot is wired behind `parkStore`
    note: 'ADR 002 §4.4\'s whole design for a device offline across a rotation is "hold the cursor, '
      + 'fetch the key, re-read". Instead every op of the new epoch is lost on the first pull.',
  },
  {
    id: 'S1-park-version',
    value: 'park:version',
    label: 'an op from a newer build — an envelope version this one does not know',
    expect: FATE('deferred', 'released', 'park-reason'),
    predicted: FATE('deferred', 'released', 'park-reason'),
    openFinding: null,   // CLOSED — P-8: `sync/outbox.js`'s parking lot is wired behind `parkStore`
    note: 'The cure is an app update, so the cursor MUST be released (ADR 003 §8.2 forbids a cursor '
      + 'pinned for ever) and the retention MUST therefore be durable. Today it is neither.',
  },
  {
    id: 'S1-park-unknownKind',
    value: 'park:unknownKind',
    label: 'an op whose KIND this build has never heard of',
    expect: FATE('deferred', 'released', 'park-reason'),
    predicted: FATE('deferred', 'released', 'park-reason'),
    openFinding: null,   // CLOSED — P-8: `sync/outbox.js`'s parking lot is wired behind `parkStore`
    note: 'ADR 002 §5.2.5\'s last paragraph: "an unknown KIND or an unknown FIELD NAME is parked". '
      + '`sealOp` refuses to seal one, so the only producer is a newer build — i.e. exactly the '
      + 'case ADR 002 §1\'s "versioning, not negotiation" is written for.',
  },
  {
    id: 'S1-terminal-signature',
    value: 'terminal:signature',
    label: 'a re-attributed, epoch-relabelled or spliced envelope — P3 fails',
    expect: FATE('quarantined', 'released', 'quarantine'),
    predicted: FATE('quarantined', 'released', 'quarantine'),
    openFinding: null,
    note: 'The refusal is RIGHT and final. What is wrong is that the record of it is a `Map` in the '
      + 'engine: one relaunch and a Mac that refused a forged op reports `healthy` and remembers nothing.',
  },
  {
    id: 'S1-terminal-aead',
    value: 'terminal:aead',
    label: 'a personal envelope replayed into the family stream — AES-GCM refuses it',
    expect: FATE('quarantined', 'released', 'quarantine'),
    predicted: FATE('quarantined', 'released', 'quarantine'),
    openFinding: null,
    note: 'ADR 002 §3 barrier 3. Same shape as the row above: the barrier holds, the memory of it does not.',
  },
  {
    id: 'S1-terminal-malformed',
    value: 'terminal:malformed',
    label: 'an envelope that is not an envelope — a 5-byte IV',
    expect: FATE('quarantined', 'released', 'quarantine'),
    predicted: FATE('quarantined', 'released', 'quarantine'),
    openFinding: null,
    note: 'And a sharper sibling this axis does not reach, recorded so it is not rediscovered: an '
      + 'envelope with NO `oid` at all cannot even be quarantined — `terminal()` is guarded on '
      + '`typeof oid === "string"` — so it lands in `cursor-released` with no record IN THE SESSION '
      + 'EITHER. That is the only cell of the grid nothing in the product can currently report.',
  },
]);

/**
 * S1_CELLS — THE FULL CROSS, 8 × 5 × 4 = 160, GENERATED FROM S1 AND NOT HAND-MARKED.
 *
 * The eight rows above say what must happen. This grid says what must NOT, which is the half that
 * stops a fix from relocating the failure: "a park must never become a drop" is not a sentence in
 * a docblock here, it is 32 cells whose `required` is `false` and which the property re-measures.
 *
 * `expect.required` — is THIS cell the one the build must be in for this outcome?
 * `openFinding`     — set on exactly the two cells per broken outcome that must move: the
 *                     required cell (which the build is not in) and the predicted cell (which it
 *                     is, and must not be). Everything else holds today and must keep holding.
 */
const cellId = (o, e, s) => `S1c-${o}-${e}-${s}`;
export const S1_CELLS = deep(S1.flatMap((fate) => S1_ENGINE.flatMap((eng) => S1_SURVIVES.map((sur) => {
  const isRequired = fate.expect.engine === eng.id && fate.expect.survives === sur.id;
  const isPredicted = fate.predicted.engine === eng.id && fate.predicted.survives === sur.id;
  // The CURSOR is deliberately not part of this test. The grid is over two axes; a fate whose
  // only error is the cursor moves no cell, and marking a cell open for it would report a STALE
  // row for ever. S1 owns the cursor and checks the whole triple.
  const broken = fate.expect.engine !== fate.predicted.engine
    || fate.expect.survives !== fate.predicted.survives;
  return {
    id: cellId(fate.value, eng.id, sur.id),
    value: { outcome: fate.value, engine: eng.id, survives: sur.id },
    label: `${fate.value} → ${eng.id} · a relaunch finds ${sur.id}`,
    expect: { required: isRequired },
    openFinding: broken && (isRequired || isPredicted) ? fate.openFinding : null,
  };
}))));

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S2 — AN OP'S DURABILITY ACROSS A RESTART
//
// FOUR FACTS ABOUT ONE OP THIS MAC AUTHORED IN ITS OWN PERSONAL SPACE, ALL MEASURED AFTER A
// REAL QUIT-AND-RELAUNCH ON THE SAME DISK:
//
//   R  the op's VALUE is on the board — `store.state` carries it (register or checkpoint fold)
//   L  the LOG holds a line for it — `_log.lines()` has its opId (from `ops.jsonl` or from
//      `checkpoint().parked`)
//   A  the RELAY holds it — the opId is in the relay's own op stream. Measured from the relay,
//      NOT from `line.seq`: once a compaction folds the line away, `line.seq` cannot be read at
//      all, and that unreadability IS the defect. An axis that cannot see the defect is not an axis.
//   O  `store.outbox()` offers it — ADR 003 §8.1's definition of "the relay has not confirmed it"
//
// All sixteen combinations, with a decided answer for each.
//
//   expect.admissible      may the engine legitimately be in this state at all?
//   expect.mustBeReachable is some scenario in `S2_SCENARIOS` REQUIRED to end here? This is the
//                          non-vacuity control — without it, "admissible: false everywhere" is
//                          satisfied by an app that syncs nothing. It is deliberately FALSE on
//                          the inadmissible cells, including E5-2's: a cell the build must never
//                          be in is caught by `admissible`, and asking a fix to keep reaching it
//                          would make the fix impossible to land.
//
// THE REQUIRED RULE, IN ONE SENTENCE:
//
//     An op whose value is on the board and which the relay has never seen MUST still have a line
//     and MUST still be in the outbox. There is no fourth possibility. `R ∧ ¬A ⟹ L ∧ O`.
//
// **E5-2 LIVES HERE, and it is not the offline path.** The 700 ms autosave (`SAVE_DEBOUNCE`,
// `store.js:131`) beats the 2 s push debounce (`CADENCE.pushDebounceMs`, `sync/personal.js:138`)
// by 1 300 ms, so on a perfectly online Mac EVERY edit is persisted while it is still
// unacknowledged. The cell `R1 L0 A0 O0` is therefore reachable on a laptop that never left the
// house — and once it is reached, nothing on either Mac can tell.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const S2_CASE = (R, L, A, O, admissible, mustBeReachable, why, openFinding = null) => ({
  id: `S2-R${+R}L${+L}A${+A}O${+O}`,
  value: { R, L, A, O },
  label: `board=${R ? 'yes' : 'no'} · line=${L ? 'yes' : 'no'} · relay=${A ? 'yes' : 'no'} · outbox=${O ? 'yes' : 'no'}`,
  expect: { admissible, mustBeReachable },
  openFinding,
  note: why,
});

export const S2 = deep([
  // ── the op is on the board ──────────────────────────────────────────────────────────────────
  S2_CASE(true, true, true, true, false, false,
    'ACKED AND STILL OFFERED. `outbox()` is defined as `seq === null`; a line the relay confirmed '
    + 'cannot be in it. This cell means `ackPushed` did not persist, and every push would repeat for ever.'),
  S2_CASE(true, true, true, false, true, false,
    'THE HAPPY PATH after a push and an ack, before the tail is folded away. Admissible, and NOT '
    + 'required after a relaunch: `_persistOps` step ④ truncates exactly the lines the checkpoint '
    + 'already folds, so an acked op has normally left the tail by the time a fresh process reads '
    + 'it. Reaching this cell means a crash between the ack and the truncate, which costs nothing.'),
  S2_CASE(true, true, false, true, true, true,
    'THE OFFLINE PATH — story 19.1\'s laptop closed on a train. This is the cell E5-2\'s first fix '
    + '(`_outboxHorizonCap`) restored, and it holds today: measured surviving a real relaunch.'),
  S2_CASE(true, true, false, false, false, false,
    'A LINE THIS MAC AUTHORED, UNACKNOWLEDGED, AND NOT OFFERED. For an own personal-space op that '
    + 'is a wedged outbox — the op can never leave and nothing says so. (The `outbox()` filters '
    + 'that legitimately produce this cell — a peer\'s op, a `local`-space op, a GENESIS stamp — '
    + 'are excluded by construction: S2 is scoped to an op THIS Mac authored in its OWN space.)'),
  S2_CASE(true, false, true, true, false, false,
    'NO LINE AND STILL OFFERED. `outbox()` is derived from lines; this cell cannot be reached and '
    + 'must not become reachable by caching the outbox as a queue. ADR 003 §8.1: "derived, never a queue".'),
  S2_CASE(true, false, true, false, true, true,
    'ACKED, THEN COMPACTED. The line is gone and nothing depends on it any more — this is what '
    + 'ADR 001 §7.2\'s compaction is FOR, and it is the control that stops "never compact" passing '
    + 'as a fix for E5-2.'),
  S2_CASE(true, false, false, true, false, false,
    'NO LINE AND STILL OFFERED, unacknowledged. Same impossibility as above, one column over.'),
  S2_CASE(true, false, false, false, false, false,
    '**E5-2. THE CELL THIS WHOLE DOMAIN EXISTS FOR.** The edit is on the board, the relay has never '
    + 'seen it, there is no line left to push and `outbox()` returns 0. The other Mac will never '
    + 'receive it — not on this launch, not on any later one — and both Macs report `healthy`. '
    + 'Reached by `compact ▸ author ▸ compact`, which is ordinary: `TAIL_COMPACT_AT` is 1500 lines '
    + 'and `TAIL_COMPACT_BYTES` is a 2 MB `ops.jsonl` at launch. The scenario that lands here today '
    + '(`S2s-compact-sandwich`) used to land here and now lands in `S2-R1L1A0O1`, which is where '
    + 'it is required to land. CLOSED by E5-2 (`_outboxHorizonCap`\'s stand-down asked about the '
    + 'CAP when the unrecoverable condition is about the FLOOR) and by L-4 (`oplog.load()` fed the '
    + 'tail line the `seq: null` its bytes carry and dropped `checkpoint().seqs`, so an '
    + 'acknowledged op came back looking unacknowledged and dragged the outbox floor below the '
    + 'persisted horizon — which is how this cell was still reached after the first fix). The '
    + 'cell stays INADMISSIBLE, which is the requirement; nothing may land here again.',
    null),
  // ── the op is NOT on the board ──────────────────────────────────────────────────────────────
  S2_CASE(false, true, true, true, false, false,
    'PARKED AND OFFERED. A parked line is a promise not to fold; pushing one would publish an op '
    + 'this build has already decided it cannot apply. `outbox()` filters `park !== null` and must.'),
  S2_CASE(false, true, true, false, true, true,
    'THE LOG HOLDS A LINE THE BOARD DOES NOT REFLECT, and the relay has it. Two ways in, both '
    + 'legitimate: the value lost the register join to a later write (history is kept — ADR 006: '
    + '`board.json` is truth, the log is history), or the line is PARKED. The parked case is the '
    + 'one this domain cares about and the one thing here that already works: measured surviving '
    + 'BOTH a compaction and a relaunch with `park: "attestation"` intact, and '
    + '`store.unparkAttested()` then promotes it in ONE call — which is why L-3 is a missing call '
    + 'and not a lost op.'),
  S2_CASE(false, true, false, true, false, false,
    'PARKED AND OFFERED, unacknowledged. Same refusal as two rows up.'),
  S2_CASE(false, true, false, false, true, false,
    'AN OWN OP PARKED BEFORE IT WAS EVER PUSHED — `_log.append` parking a future-stamped mint '
    + '(ADR 001 §7.4). Legitimate; not exercised by the scenarios below, and recorded rather than '
    + 'dropped, because a domain that drops its unexercised cells stops being a domain.'),
  S2_CASE(false, false, true, true, false, false,
    'Nothing local, and still offered. Impossible for the same reason as every other `L0 O1` cell.'),
  S2_CASE(false, false, true, false, true, false,
    'THE RELAY HAS IT AND THIS MAC HAS FORGOTTEN IT — an op absorbed by a compaction whose value '
    + 'a later op overwrote. Legitimate, and the reason `bodies` fingerprints exist (R6-3).'),
  S2_CASE(false, false, false, true, false, false,
    'Offered out of nothing. The last of the four `L0 O1` impossibilities.'),
  S2_CASE(false, false, false, false, true, true,
    'THE OP NEVER EXISTED. The control at the bottom of the grid: an id nobody ever authored must '
    + 'land here, and if it does not, every measurement above is measuring the wrong thing.'),
]);

/**
 * The scenarios `sync-domains.test.js` drives to put a REAL op in a REAL cell, one launch and one
 * relaunch at a time. `expect.cell` is the cell the scenario MUST end in — the requirement, not
 * the measurement — and every one of those cells carries `mustBeReachable: true` above, which is
 * the check that keeps the two halves of this domain in step.
 */
export const S2_SCENARIOS = deep([
  {
    id: 'S2s-online',
    value: 'author online ▸ push ▸ ack ▸ persist ▸ relaunch',
    label: 'the ordinary edit, acknowledged',
    expect: { cell: 'S2-R1L0A1O0' },
    openFinding: null,
  },
  {
    id: 'S2s-offline',
    value: 'author offline ▸ persist ▸ relaunch',
    label: 'story 19.1 — the laptop closed on a train',
    expect: { cell: 'S2-R1L1A0O1' },
    openFinding: null,
    note: 'E5-2\'s FIRST fix (`_outboxHorizonCap`) is what makes this hold, and it does hold.',
  },
  {
    id: 'S2s-compact-sandwich',
    value: 'compact ▸ author offline ▸ compact ▸ relaunch',
    label: 'the same edit, with an ordinary compaction on either side of it',
    expect: { cell: 'S2-R1L1A0O1' },
    openFinding: null,   // CLOSED — E5-2 (`_outboxHorizonCap` arm) + L-4 (`oplog.load` ack)
    note: 'Byte for byte the same requirement as `S2s-offline`: a compaction is not allowed to '
      + 'change where an unacknowledged edit ends up. Measured landing in `S2-R1L0A0O0` instead.',
  },
  {
    id: 'S2s-parked',
    value: 'a peer op parked for a missing attestation ▸ compact ▸ relaunch',
    label: 'the held line — the one durable hold in the product',
    expect: { cell: 'S2-R0L1A1O0' },
    openFinding: null,
  },
  {
    id: 'S2s-never',
    value: 'an opId nobody ever authored',
    label: 'the control at the bottom of the grid',
    expect: { cell: 'S2-R0L0A0O0' },
    openFinding: null,
  },
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S3 — COMPACTION × LIFECYCLE
//
// Compaction is not exotic and is not opt-in. `store.js` fires it on EITHER of ADR 001 §7.2's two
// triggers: `_tailLines >= TAIL_COMPACT_AT` (= `min(5000, floor(LS_OPS_CAP * 0.75))` = **1500**
// lines) or `_tailOverBytes`, set at launch from an `ops.jsonl` over `TAIL_COMPACT_BYTES`
// (**2 MB**). Story 19.6 is explicitly about a board a family has used for a year.
//
// So compaction crosses every other state an op can be in, and each crossing has a required
// answer. `expect`:
//
//   { survives:  what must still be true of the op AFTER the compaction
//     converges: must the two Macs still agree afterwards?
//     reports:   what must be able to say so if the answer is no }
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const S3 = deep([
  {
    id: 'S3-unacked',
    value: 'an op the relay has never acknowledged',
    label: 'compact ▸ author ▸ compact, with the edit still in the outbox',
    expect: { survives: 'line-and-outbox', converges: true, reports: 'nothing to report' },
    openFinding: null,   // CLOSED — E5-2 + L-4
    note: 'A persist may not fold past the oldest line the relay has not acknowledged — that is '
      + '`_outboxHorizonCap`\'s own stated rule, and its `cap === null` arm breaks it in exactly '
      + 'the state every compaction leaves behind. Same shape as ADR 001 §7.3\'s tombstone GC, '
      + 'which is already gated on `Device.lastSeenSeq` for the same reason: you may not compact '
      + 'away what a peer has not seen. Here the peer is the relay.',
  },
  {
    id: 'S3-parked',
    value: 'a parked line, held with its reason',
    label: 'a compaction while an op is parked under ATTESTATION, then the launch that cures it',
    expect: { survives: 'line-and-park-reason', converges: true, reports: 'nothing to report' },
    openFinding: null,   // CLOSED — L-3: `init()` and `pullNow` both run the reaper
    note: 'THE LINE ITSELF SURVIVES BOTH THE COMPACTION AND THE RELAUNCH, with `park: "attestation"` '
      + 'intact — measured, and it is the control that keeps the rest of this domain honest. So do '
      + 'rungs 1 and 2 of F-6\'s ladder: while the cursor is still held, an ordinary re-pull cures '
      + 'the hold by itself. What fails is the column after rung 3. Once `MAX_DEFERRALS` fruitless '
      + 'pulls have gone by, ADR 003 §8.2 requires the cursor to be RELEASED — a cursor pinned for '
      + 'ever behind one op would block every later one — and from that instant the parked line is '
      + 'the only copy of the op this Mac can reach. The relaunch then models what '
      + '`family/engine.js:141` does on '
      + 'EVERY launch: it fills `store._peerDevices` from the peers list, so by the time `init()` '
      + 'returns the device set is CORRECT and the held line is authorised. Nothing re-judges it. '
      + '`store.unparkAttested()` promotes it in one call and is reached from exactly one place in '
      + 'the product — `family/mount.js`, on the adoption of a NEW peer, which an ordinary launch '
      + 'is not. `init()` does not call it; `useIdentity()` does not call it. So the two Macs stay '
      + 'permanently different, both `healthy`, over an op that is sitting on disk waiting to be '
      + 'let in. `reports: "nothing to report"` is the REQUIRED value here precisely because a '
      + 'build with the reaper has nothing left to report: the op lands and silence is true again.',
  },
  {
    id: 'S3-quarantined',
    value: 'an op the engine quarantined',
    label: 'a compaction, and a relaunch, after a terminal refusal',
    expect: { survives: 'a durable refusal record', converges: false, reports: 'the refusal, by name and reason' },
    openFinding: null,   // CLOSED — L-1: the ledger rides in `checkpoint().lzp.refusals`
    note: 'The engine\'s `quarantined` Map is per-session and the log\'s own `store.quarantine` is '
      + 'a different thing entirely (it is about the LOG FILE, not about one op). So after a '
      + 'relaunch there is no record of any kind, on either side.',
  },
  {
    id: 'S3-cursor',
    value: 'a cursor mid-page',
    label: 'a compaction between two pages of one pull',
    expect: { survives: 'the cursor, exactly where it was', converges: true, reports: 'nothing to report' },
    openFinding: null,
    note: 'ADR 006 §9.1 W1: cursors ride in `checkpoint().cursors`, which `persistNow` writes '
      + 'AFTER `board.json`, so the persisted cursor can never be ahead of the board. A compaction '
      + 'moves the horizon, not the cursor, and this row is what says so out loud.',
  },
  {
    id: 'S3-peer-behind',
    value: 'a peer behind the horizon',
    label: 'Mac B is away for weeks; Mac A compacts twice; B comes back',
    expect: { survives: 'every op B has not seen', converges: true, reports: 'nothing to report' },
    openFinding: null,
    note: 'The one crossing where the RELAY is the safety net rather than the log: B resumes from '
      + 'its own cursor against the relay\'s stream, which A\'s compaction cannot touch. This row '
      + 'is the control that keeps S3-unacked honest — it proves the harness CAN converge a '
      + 'long-offline peer, so S3-unacked\'s divergence is the defect and not the setup.',
  },
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S4 — WHAT THE USER AND THE SYSTEM CAN OBSERVE
//
// Story 19.3: **„Stille bedeutet Gesundheit."** `sync.status()` returns `healthy` and the UI shows
// NOTHING for it — that is the design, and it is a good design. It is also a PROMISE, and the
// promise is not "the indicator is quiet", it is **"quiet means there is nothing to tell you"**.
//
// This domain enumerates the states the engine can actually be in and asks, of each: what does
// `sync.status()` say, what does `store.diagnostics()` say, and what survives a relaunch? Today
// the answer to the first is `healthy` in every row, because:
//
//   · `status()` reads `store.outboxSize()` and the engine's two in-memory `Map`s. It cannot see
//     `_log.parkedOps()`, so a durable hold is invisible to it.
//   · the engine's `quarantined` Map dies with the session, so a refusal is visible for minutes.
//   · `store.quarantine` is about the LOG FILE and is a different thing from a refused op.
//   · `store.warnings` is emptied by `init()` on every launch and READ BY NOBODY (F-8).
//
// `expect`:
//   { status:        the `sync.status().state` this situation must produce
//     storeReports:  a field of `store.diagnostics()` that must name it, or null when there is
//                    genuinely nothing to name
//     survives:      must the situation still be reportable after a quit-and-relaunch? }
//
// A row whose `status` is `'healthy'` and whose `storeReports` is `null` is a row where SILENCE IS
// TRUE. There are two of them, and they are the controls: without them every requirement below is
// equally satisfied by an app that shows a warning triangle for ever.
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const S4 = deep([
  {
    id: 'S4-quiet',
    value: 'everything applied, nothing held, nothing refused',
    label: 'the ordinary state of a healthy pair of Macs',
    expect: { status: 'healthy', storeReports: null, survives: true },
    openFinding: null,
    note: 'CONTROL. Silence is true here, and it must stay free.',
  },
  {
    id: 'S4-pending',
    value: 'an edit in the outbox, not yet acknowledged',
    label: 'the train — offline with work to send',
    expect: { status: 'pending', storeReports: 'sync.outbox', survives: true },
    openFinding: null,
    note: 'CONTROL, and the one observable that already survives a relaunch properly: the outbox '
      + 'is derived from the LINES, and the lines are on disk.',
  },
  {
    id: 'S4-held',
    value: 'an op parked under ATTESTATION, durably, with its reason',
    label: 'a held op — the state F-6\'s ladder is designed to produce',
    expect: { status: 'pending', storeReports: 'sync.parked', survives: true },
    openFinding: null,   // CLOSED — L-2: `diagnostics().sync.parked` + `judgeSyncStatus` in `status()`
    note: '`pending` and not `error`: a held op is not a fault, it is work outstanding — the same '
      + 'thing an unacknowledged outbox line is. But it must be VISIBLE, and there is no '
      + '`diagnostics().sync.parked` field to report it with. Measured: `healthy`, before and '
      + 'after a relaunch, with the line sitting in the log the whole time.',
  },
  {
    id: 'S4-shelved',
    value: 'a held op the ladder GAVE UP on — the bytes retained, nothing left that will open them',
    label: 'the end of F-6\'s ladder — a park that became a shelf (R8-4, R10-9c)',
    expect: { status: 'error', storeReports: 'sync.refused', survives: true },
    openFinding: null,   // CLOSED — R10-9c: `status.js shelvedDetail()` + the `shelved` observable
    note: 'THE STATE BETWEEN `S4-held` AND `S4-refused`, and it was in neither. A park is not a '
      + 'drop — past `PARK_REVIVALS` launches the lot stops replaying the envelope and KEEPS it '
      + '(R8-4) — so the bytes are on this disk, correctly, and no ladder will ever run against '
      + 'them again. `error` and not `pending`: nothing is outstanding, which is the difference '
      + 'from `S4-held`. '
      + 'AND THE `storeReports` COLUMN IS THE FINDING ITSELF: the shelf lives in the ENGINE\'s '
      + 'parking lot, and `store.diagnostics()` structurally cannot see it (R8-6b), so the only '
      + 'thing the STORE can answer with is the refusal ledger the same event wrote. That is why '
      + '`status.js` gives the `shelved` observable scope `at: \'held\'` and the engine hands the '
      + 'evidence in from `personal.js status()`. The `status` column above is the half that '
      + 'needs the wiring; the ENGINE-side non-vacuity — that the verdict names `shelved` by id '
      + 'rather than inheriting `error` from the refusal beside it — is `S4e`, because a triple '
      + 'that two mechanisms both satisfy cannot tell you which one is present.',
  },
  {
    id: 'S4-refused',
    value: 'an op terminally refused — a bad signature, a failed AEAD',
    label: 'a refusal that is correct, final, and forgotten',
    expect: { status: 'error', storeReports: 'sync.refused', survives: true },
    openFinding: null,   // CLOSED — L-1
    note: '`error` is right and IS produced — for this session. The requirement the build misses is '
      + '`survives`. ADR 003 §8.2 releases the cursor so the op is never offered again; the record '
      + 'of the refusal is therefore the only thing left, and it lives in a `Map`.',
  },
  {
    id: 'S4-lost',
    value: 'an unacknowledged line folded away by a compaction',
    label: 'E5-2 — the edit is on the board, in nobody\'s outbox, and on one Mac only',
    expect: { status: 'error', storeReports: 'sync.lost', survives: true },
    openFinding: null,   // CLOSED — E5-2 + L-4; the residual arm ① state is reported (`sync.lost`)
    note: 'The one state in this domain where the app cannot recover the DATA — the board keeps the '
      + 'value, so nothing is lost to the user on THIS Mac — but it can and must recover the FACT. '
      + '`_outboxHorizonCap` already writes a sentence for the one case it does detect '
      + '(`_e52Warned`), onto `store.warnings`, which `init()` empties and nobody reads (F-8). The '
      + 'channel exists; it is not durable and it has no consumer.',
  },
  {
    id: 'S4-diverged',
    value: 'the two Macs\' register digests disagree, and both are self-consistent',
    label: 'ADR 002 §5.4\'s fork — a relay that withholds from one Mac',
    expect: { status: 'error', storeReports: 'sync.chain', survives: true },
    openFinding: null,   // CLOSED — P-4: `pullNow` verifies the chain and the page claim
    note: 'The ONE mechanism the design names for detecting this is chain-witness verification, and '
      + '`sync/chain.js` implements it and is imported by NOTHING in `src/`. `verifyChain` is green '
      + 'in the fleet suite because that suite imports it directly — the module is tested and '
      + 'unreached, which is F-9\'s shape one directory over. Until `pullNow` calls it, a fork is '
      + 'undetectable by construction and this row cannot be closed by anything else.',
  },
  {
    id: 'S4-warnings',
    value: 'everything this layer wrote down about what it could not do',
    label: '`store.warnings` — the channel that already holds every sentence above',
    expect: { status: 'error', storeReports: 'warnings', survives: true },
    openFinding: null,   // CLOSED — F-8: `family/syncstatus.js` subscribes; the fold reports the channel
    note: 'Not a new mechanism: `_warn` already fires for every refusal, every park, every '
      + 'coercion and every quarantine, `subscribeWarnings()` is already the UI seam, and '
      + '`diagnostics().warnings` already copies the array. Two things are missing and they are '
      + 'the whole of F-8: nothing SUBSCRIBES, and `init()` empties the array before anything could.',
  },
]);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// S5 — MODULE REACHABILITY
//
// Every module under `src/js/`, and whether the app can reach it from `boot.js`, `main.js` or
// `firstrun.js` — following DYNAMIC doors as well as static imports, because ADR 003 §7 gate 2
// and ADR 002 §2.4 both REQUIRE the family-mode modules to sit behind exactly one dynamic
// `await import()`. A walk that ignored dynamic edges would report the design as a defect.
//
// THE REQUIRED RULE, IN ONE SENTENCE:
//
//     A module that ships is reachable, or it does not ship. There is no third state, and
//     "reachable from the test suite" is not one of them.
//
// `expect = { reachable: true }` on every row — that is the rule, and it does not vary. `role`
// is not a requirement, it is the DISPOSITION: what closing the row means.
//
//   'live'    reachable today. 57 of the 65.
//   'dead'    LZP-501's superseded engine. Closing the row means DELETING the file.
//   'defence' a mechanism the design names and the product does not have. Closing the row means
//             WIRING it, and deleting it instead would close the row while making the product worse.
//
// P-4 lives here, and the three `defence` rows are its sharp half. `sync/chain.js` is the reason
// S4-diverged cannot be closed by anything else.
// ═════════════════════════════════════════════════════════════════════════════════════════════

// `openFinding` defaults to P-4 for every non-`live` row, and is passed EXPLICITLY as null on a
// row whose wiring has landed — the role stays `defence`, because the role is the disposition
// ("closing this means wiring it"), not the state. WP-9 cleared two of them.
const MOD = (path, role, note = null, openFinding = role === 'live' ? null : 'P-4') => ({
  id: `S5-${path.replace(/^src\/js\//, '').replace(/\.js$/, '').replace(/\//g, '-')}`,
  value: path,
  label: path,
  expect: { reachable: true, role },
  openFinding,
  ...(note ? { note } : {}),
});

export const S5 = deep([
  MOD('src/js/backup.js', 'live'),
  MOD('src/js/board.js', 'live'),
  MOD('src/js/boot.js', 'live'),
  MOD('src/js/core/authz.js', 'live'),
  MOD('src/js/core/b64.js', 'live'),
  MOD('src/js/core/canon.js', 'live'),
  MOD('src/js/core/dev.js', 'live'),
  MOD('src/js/core/entities.js', 'live'),
  MOD('src/js/core/ids.js', 'live'),
  MOD('src/js/core/materialize.js', 'live'),
  MOD('src/js/core/migrate1to2.js', 'live'),
  MOD('src/js/core/oplog.js', 'live'),
  MOD('src/js/core/ops.js', 'live'),
  MOD('src/js/core/project.js', 'defence',
    'ADR 004 §2 — THE SINGLE CHOKE POINT THROUGH WHICH PLAINTEXT LEAVES A DEVICE. **CLOSED THIS '
    + 'ROUND — it is now reachable, and the door it came through is `sync/family.js`.** It was '
    + '`openFinding: P-4` for one round: built by WP-10 and imported by nothing, because its '
    + 'consumers are the seal seam and the outbox, which were another work package\'s files. '
    + 'While that held, `sealOp` refused every family `pub.set` at barrier 2 and NOTHING COULD BE '
    + 'SHARED AT ALL — the correct failure of an unwired boundary ("you cannot publish", never '
    + '"you publish unchecked"), which is why the row was `defence` and why closing it meant '
    + 'WIRING the file rather than deleting it. `sync/family.js#sealLine` now passes '
    + '`assertFamilyPatch` as `ctx.assertFamilyPatch` (barrier 2) alongside `store.familyLevelOf` '
    + 'as `ctx.levelOf` (barrier 4), so the boundary is both reachable and REQUIRED on the one '
    + 'path that seals a family op. `PUBLISH_FAILURE_CONTRACT` in the module states what the '
    + 'store owes it; `PROJECT_CONTRACT` in `crypto/envelope.js` states what the seal seam owes '
    + 'it.',
    null),
  MOD('src/js/core/registers.js', 'live'),
  MOD('src/js/core/replace.js', 'live'),
  MOD('src/js/core/stamp.js', 'live'),
  MOD('src/js/core/undo.js', 'live'),
  MOD('src/js/core/visibility.js', 'live',
    'ADR 004 §2.1/§3/§5/§7/§9 — the LEVEL and its policy (E7, LZP-701/703/704). `core/project.js` '
    + 'owns which BYTES may leave; this owns which level an entry has, what a level discloses, '
    + 'what a change of level withdraws, and that a change of level tells nobody anything. It is '
    + 'a LEAF (it imports nothing) and it is reachable because `core/entities.js` imports it: '
    + '`projectable()` and `renderableNote()` used to spell `\'privat\'` and `\'belegt\'` inline, '
    + 'which is a viewer-side privacy decision written as a string comparison. UNLIKE '
    + '`core/project.js` this row is `live` on the day it lands — the seam it serves is the '
    + 'RENDERING side, which ships today, rather than the PUBLISH side, which is still waiting '
    + 'on the store.'),
  MOD('src/js/crypto/backup.js', 'defence',
    'ADR 002 §7 — the recovery file. Implemented, tested in tier 1, and with NO ROUTE TO IT IN THE '
    + 'UI, so the answer to "my Mac died" was that there is no answer. **WIRED by WP-9**: '
    + '`family/familysettings.js`\'s „Schlüssel sichern" section renders `EXPORT_SHEET_COPY` and '
    + 'calls `exportBackup`. Still a `defence` — the role is the disposition, not the state.',
    null),
  MOD('src/js/crypto/envelope.js', 'live'),
  MOD('src/js/crypto/identity.js', 'live'),
  MOD('src/js/crypto/pairing.js', 'live'),
  MOD('src/js/crypto/probe.js', 'defence',
    '`platform/net.js` said in so many words "family features are gated on probeCrypto()" and '
    + 'nothing called it, so they were gated on nothing. **WIRED by WP-9**: '
    + '`family/familysettings.js`\'s `assertSuiteAvailable()` gates „Familienkreis erstellen" and '
    + 'the sealed export. The third moment probe.js names — „Gerät koppeln", `family/pairingui.js` '
    + '— is still ungated and is pinned in tests/attack/privacy-e5-silence.test.js §5.',
    null),
  MOD('src/js/crypto/spacekeys.js', 'live'),
  MOD('src/js/crypto/suite.js', 'live'),
  MOD('src/js/dates.js', 'live'),
  MOD('src/js/family/adminpanel.js', 'live'),
  MOD('src/js/family/conflict.js', 'live',
    'Story 18.5 / ADR 004 §8 — the LOST-EDIT NOTICE (E9, LZP-904), and the only conflict UI in '
    + 'the product. It resolves nothing: `core/registers.js#displacedBy` answers "was my write '
    + 'displaced?" using the SAME per-field LWW (`≺`: stamp → opId → value) and the same '
    + '`promoteEntity` that drew the board, so a UI module cannot grow a second resolution rule '
    + 'and then be right about a board state that does not exist. Its single input is this '
    + 'device\'s own outbox (`op.dev === store._device`), so a device that authored no write has '
    + 'no ledger row and there is no branch that decides NOT to show a line — "only the loser '
    + 'sees it" is structural. It refuses governing fields outright, which is what makes an admin '
    + 'unshare (18.3) and a remote delete (18.6) UNCONSTRUCTIBLE as notices — Principle 9 forbids '
    + '„X made an entry private" and this is where that is enforced rather than remembered. '
    + '`live` since the E9 integration: `family/mount.js#mountCircleSurfaces` calls '
    + '`installConflictNotice({store, nameOf: memberNameOf})` on the circle-only board path, so '
    + 'solo mode reaches none of it (Principle 7) and the notice names members through the same '
    + '17.6 roster port the attribution line uses.'),
  MOD('src/js/family/createjoin.js', 'live'),
  MOD('src/js/family/engine.js', 'live'),
  MOD('src/js/family/familysettings.js', 'live'),
  MOD('src/js/family/leavedelete.js', 'live'),
  MOD('src/js/family/membersui.js', 'live'),
  MOD('src/js/family/mount.js', 'live'),
  MOD('src/js/family/pairflow.js', 'live'),
  MOD('src/js/family/pairingui.js', 'live'),
  MOD('src/js/family/removal.js', 'live'),
  MOD('src/js/family/sharing.js', 'live',
    'A7 / ADR 004 §4.3, §7.3, §8 — the popover\'s SHARING CLUSTER (E7, LZP-702). DOM and copy '
    + 'only: it writes the `visibility` and `coEdit` TRUTH registers through `store.txn` and '
    + 'constructs no `pub.*` field anywhere, because what leaves the device is '
    + '`core/project.js`\'s job and there is no second path. It is `live` because '
    + '`family/mount.js#syncCircleMounts` installs it through `popover.js#useSharing(mod)` — a '
    + 'PORT rather than an import, and deliberately: `boot.js -> main.js -> popover.js` is the '
    + 'solo graph, so a static import here would make solo mode statically reach `src/js/family/` '
    + 'and `tests/tier1/network-scope.test.js` §2 gate 2 refuses exactly that. The port is `null` '
    + 'until a circle exists and is set back to `null` when one is left (20.3).'),
  MOD('src/js/family/syncstatus.js', 'live'),
  MOD('src/js/family/unshare.js', 'live',
    'Story 18.3 / ADR 004 §5 — THE ADMIN UNSHARE, and the third module in three rounds to ship '
    + 'complete, tested and with no caller. It was on disk for a whole round after E9 (§15f item '
    + '2: "`family/unshare.js` is complete and tested and no UI calls it; the demonstration drives '
    + '`adminUnshareOp` directly"), and this walk was correctly silent about it, because an '
    + 'unmounted module is not a shipped one — the same order dependency `family/conflict.js` and '
    + '`family/sharing.js` each had one round earlier. `live` since '
    + '`family/familysettings.js#buildModerationSection` — the moderation list in ⚙ → „Einträge im '
    + 'Familienkreis", drawn only on the Mac the folded admin chain names — calls '
    + '`createUnshare().run(entityKey)`. It mints no patch (the bytes are `core/project.js`\'s '
    + '`adminUnshareOp`), no admin chain (`createjoin.js` still owes the genesis link, which is '
    + 'why `UNSHARE_BLOCKERS.NO_ADMIN_CHAIN` exists) and no notification of any kind '
    + '(Principle 9). The still-better affordance — the same call from a foreign entry\'s popover '
    + '— is owed by `popover.js`/`board.js` and is a second caller, not a replacement.'),
  MOD('src/js/feedback/copy.js', 'live'),
  MOD('src/js/feedback/events.js', 'live'),
  MOD('src/js/feedback/geometry.js', 'live'),
  MOD('src/js/feedback/png.js', 'live'),
  MOD('src/js/feedback/port.js', 'defence',
    'LZP-1009 — THE SEAM THROUGH WHICH A REPORT LEAVES, AND NOTHING BINDS IT YET. The module is '
    + 'REACHABLE (`feedback/ui.js` reads `feedbackPort()` and `canSend()` on every press), so the '
    + 'row is not P-4\'s "reachable from nothing". What is missing is the one line that supplies '
    + 'a sender, and it belongs to a file this ticket does not own: `family/mount.js` — the only '
    + 'module in the product that holds a transport and is behind ADR 003 §7 gate 2\'s single '
    + 'dynamic door. The binding is written out verbatim in `port.js`\'s header. '
    + 'THE ROLE IS `defence` FOR THE USUAL REASON: closing this row means WIRING the file, and '
    + 'deleting it instead would close the row while making the product worse — `feedback/` would '
    + 'then have to import `platform/net.js` itself, which is a SECOND dynamic door out of the '
    + 'boot graph and the exact defect `tests/tier1/network-scope.test.js` §2 exists to catch. '
    + 'UNTIL IT LANDS THE FEATURE IS HONEST RATHER THAN BROKEN: `canSend()` is false, „Senden" is '
    + 'disabled, and the screen says so in German („Dieser Mac kennt keine Gegenstelle …") beside '
    + 'the two fallbacks — copy to clipboard and save to file — which LZP-1009 requires anyway '
    + 'because "the relay being unreachable is itself worth reporting". '
    + '⚠ `openFinding` IS NULL AND THE ROLE STAYS `defence`, which is the distinction these two '
    + 'fields exist to keep apart — the same call `core/project.js` records one screen down. S5 '
    + 'asks "is this module REACHABLE?" and the answer is yes: `feedback/ui.js` reads '
    + '`feedbackPort()` and `canSend()` on every press, so this is not P-4\'s "reachable from '
    + 'nothing". `role: defence` asks something else — "would deleting this file turn the row '
    + 'green while making the product worse?" — and for this seam the answer is permanently yes. '
    + 'The open work (E10-1009-A, documented above) is the BINDER, which is not a question S5 '
    + 'poses, and pinning it here would make this row read STALE the moment it is measured.',
    null),
  MOD('src/js/feedback/redact.js', 'live'),
  MOD('src/js/feedback/report.js', 'live'),
  MOD('src/js/feedback/ui.js', 'live'),
  MOD('src/js/ferien.js', 'live'),
  MOD('src/js/find.js', 'live'),
  MOD('src/js/firstrun.js', 'live'),
  MOD('src/js/holidays.js', 'live'),
  MOD('src/js/i18n.js', 'live'),
  MOD('src/js/interact.js', 'live'),
  MOD('src/js/layout.js', 'live'),
  MOD('src/js/legend.js', 'live'),
  MOD('src/js/main.js', 'live'),
  MOD('src/js/palette.js', 'live'),
  MOD('src/js/platform/device-identity.js', 'live'),
  MOD('src/js/platform/keystore.js', 'live'),
  MOD('src/js/platform/net.js', 'live'),
  MOD('src/js/platform/updater.js', 'live'),
  MOD('src/js/popover.js', 'live'),
  MOD('src/js/print.js', 'live'),
  MOD('src/js/settings.js', 'live'),
  MOD('src/js/storage.js', 'live'),
  MOD('src/js/store.js', 'live'),
  MOD('src/js/sync/chain.js', 'defence',
    'ADR 002 §5.4 chain-witness verification — THE ONE mechanism the design names for detecting a '
    + 'relay that withholds, reorders or renumbers ops. **WIRED**: `sync/personal.js` imports '
    + '`verifyChain` and `pullNow` runs it over every page, together with the PAGE CLAIM check '
    + '(`nextCursor` may not run past the last row the relay actually served). `S4-diverged` and '
    + '`attack-converge-relay.test.js` §2/§3 are closed by it. Still a `defence` — the role is the '
    + 'disposition, not the state.',
    null),
  MOD('src/js/sync/family.js', 'live',
    'LZP-608 — the FAMILY sync engine. `sync/personal.js` refuses an `fsp_` space at construction '
    + '(story 21.2, and the refusal is correct), so before this a Familienkreis armed NO ENGINE AT '
    + 'ALL: `docs/v2/E6-VERIFICATION.md` §5.2 measured a full member\'s Mac making ZERO /ops '
    + 'requests in 8 s. Reached from `family/engine.js`\'s `startFamilyEngine`, which '
    + '`family/mount.js` calls from BOTH arming paths — `start()` for a Mac that also syncs its own '
    + 'two Macs, and `mountCircleSurfaces()` for a Mac that only ever joined a circle.'),
  MOD('src/js/sync/keys.js', 'live',
    'ADR 002 §7.1 steps 4, 5 and 6 — the half PO decision D9 rests on. `admit()` is the receiving '
    + 'side of §4.2 step 6 (the branded sender set, finding S1); `deliver()` is step 4, ANY member '
    + 'device wrapping epochs 1..e+1 to a recipient that provably holds none; `rotate()` is §4.1. '
    + 'Reached from `sync/family.js`, which constructs one per engine rather than taking one — a '
    + 'key delivery bound to a different space than its engine is the mix-up 21.2 forbids.'),
  MOD('src/js/sync/cursor.js', 'defence',
    'RE-CLASSIFIED FROM `dead`, then WIRED. `createCursors` is the durable per-space sync '
    + 'POSITION, and its own header is the argument for what it now holds: the chain head '
    + '"answers the same question the cursor does — where was I in this space\'s log? — and two '
    + 'persisted answers to one question is how they drift apart". `sync/personal.js` kept its '
    + 'chain anchor PER SESSION, so a relay that forked the stream ACROSS a relaunch was adopted '
    + 'as the new truth on the first page after it.\n'
    + 'IT IS NOT A SECOND TRANSPORT CURSOR, and that was the reason not to reach for it: ADR 006 '
    + '§9.1 W1 makes "there is exactly one way to move a cursor and it writes into the LOG" a '
    + 'STRUCTURAL claim. `store.cursor()` is still the only value read as `since`; what is read '
    + 'back from here is `head()`. What the module contributes is its ONE WRITE PATH — `advance()` '
    + 'runs the commit first and persists only if it resolves — with `store.noteCursor` INSIDE '
    + 'that commit, so the seq kept beside the head can lag the authoritative cursor and can '
    + 'never lead it. Behind the `chainStore` port (`family/engine.js`\'s `chainHeadStore()`).',
    null),
  MOD('src/js/sync/outbox.js', 'defence',
    'RE-CLASSIFIED FROM `dead`, then WIRED — the sharp half of P-8. `createOutbox` IS superseded '
    + 'by `store.outbox()` (ADR 003 §8.1 requires the outbox to be DERIVED from the log). '
    + '`createParkingLot` was superseded by nothing: it is a durable, capped, storage-backed '
    + 'retention of SEALED ENVELOPES with their park reasons, which `core/oplog.js` cannot supply '
    + 'because P1, P4 and the version gate all refuse BEFORE the decrypt and there is no op to '
    + 'hand `oplog.park()`. `sync/personal.js` now builds one behind a `parkStore` port '
    + '(`family/engine.js`\'s `parkedEnvelopeStore()`), which is what closed all four of S1\'s '
    + 'park rows and let `PARK_HANDLING`\'s `curedBy: \'update\'` rows release the cursor as ADR '
    + '003 §8.2 requires. Still a `defence` — the role is the disposition, not the state.',
    null),
  MOD('src/js/sync/personal.js', 'live'),
  MOD('src/js/sync/protocol.js', 'live',
    'RE-CLASSIFIED FROM `dead`: `sync/chain.js` imports `cmpSeq`/`parseSeq`/`ZERO_SEQ` from it, and '
    + 'chain.js is now reachable from `sync/personal.js`, so this module is on the shipping path.'),
  MOD('src/js/sync/status.js', 'live'),
  MOD('src/js/ui.js', 'live'),
  MOD('src/js/update-ui.js', 'live'),
]);

/** The entry points the walk starts from. Any module reached from none of these is an orphan. */
export const S5_ENTRIES = deep(['src/js/boot.js', 'src/js/main.js', 'src/js/firstrun.js']);

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE REGISTRY
// ═════════════════════════════════════════════════════════════════════════════════════════════

export const DOMAINS = deep({
  S1: { title: 'an op\'s fate, end to end', subject: 'openOp × the engine × a relaunch', entries: S1 },
  S1_CELLS: { title: 'the full fate grid', subject: '8 outcomes × 5 dispositions × 4 survivals', entries: S1_CELLS },
  S2: { title: 'an op\'s durability across a restart', subject: 'board × line × relay × outbox', entries: S2 },
  S2_SCENARIOS: { title: 'the five journeys through S2', subject: 'one real op, one real relaunch, per cell', entries: S2_SCENARIOS },
  S3: { title: 'compaction × lifecycle', subject: 'ADR 001 §7.2 crossed with every other state', entries: S3 },
  S4: { title: 'what the user and the system can observe', subject: 'story 19.3 — silence must MEAN health', entries: S4 },
  S5: { title: 'module reachability', subject: 'every module under src/js/, from the three entry points', entries: S5 },
});

/** Counts, so a truncated file is a loud failure rather than a quiet one. */
export const DOMAIN_SIZES = deep({
  S1: 8, S1_CELLS: 160, S2: 16, S2_SCENARIOS: 5, S3: 5, S4: 8, S5: 78,   // S5 70 -> 78: LZP-1009's src/js/feedback/
});
